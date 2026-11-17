import { catalogText, normalizeSteps } from './tools.mjs';
import { chatCompletion } from '../core/llm.mjs';

// 事实回灌的唯一实现放在 connect/core/facts.mjs，这里转发一份，
// 免得旧调用方（tests/planner.test.mjs 也从这里导入）断掉。
export { factsText } from '../core/facts.mjs';

const PERSONA = `你是「大肥鱼」，一只蓝色小鲸鱼外形的 AI 小伙伴，住在爸爸的电脑桌面上。\
爸爸（你叫他爸爸）在 QQ 私聊里跟你说话。说话要短、口语、有点黏人，不用 Markdown，不要解释自己是什么模型。\
你手里有下面这些「只读工具」，可以先查再答；查不到就老实说查不到，绝对不要编数字、时间、标题。\
发图文、回评论、打电话这类「写操作」你不直接执行，但**必须照常写进 steps**：系统会自动建任务、替你去问爸爸确认。\
所以：只要爸爸让你「发图文 / 回评论 / 回一下评论 / 把评论都回了」，steps 里就必须有 douyin.publish 或 douyin.reply_comments，不要只说打算做什么、也不要在 say 里问「要不要执行」，确认由系统来问。\
写操作之前可以先放只读步骤（比如先 comments.list 看看有哪些），顺序就是你打算的顺序。\
爸爸常驻石家庄。问天气但没说城市时，直接按石家庄查，不要反问城市。`;

const SCHEMA = `只输出一个 JSON 对象，不要代码块、不要多余文字：
{"say":"准备对爸爸说的那句话（不超过 80 字）","steps":[{"tool":"工具名","args":{}}]}
- 只是聊天、不需要查数据、也不涉及写操作时，steps 给空数组 []。
- 需要先查再答时，按顺序给 1~3 个 steps，系统会执行后把真实结果交给你再说最终答案。
- 爸爸要求的写操作（发图文、回评论）一定要出现在 steps 里，否则等于没答应。
- 不要臆造工具名；只从上面清单里挑。`;

export function qqPlanner(home, { fetchImpl = fetch } = {}) {
  return async ({ text, history = [], memories = [], today = '', kind = 'c2c', peerId = '', accountId = 'qq', messageId = null, catalog = null, lessons = [], capabilities = '', traces = [] }) => {
    const toolText = catalog ?? catalogText();
    const contextLines = [];
    if (today) contextLines.push(`今天的摘要：${String(today).slice(0, 400)}`);
    if (memories?.length) contextLines.push(`你记得的事：\n${memories.slice(0, 8).map((m) => `- ${String(m).slice(0, 120)}`).join('\n')}`);
    if (lessons?.length) contextLines.push(`经验（踩过的坑，必须遵守）：\n${lessons.slice(0, 8).map((m) => `- ${String(m).slice(0, 200)}`).join('\n')}`);
    // 情景记忆：同类任务最近几次成没成。失败过的就别再按老路子硬来。
    const traceLines = (Array.isArray(traces) ? traces : []).filter((row) => row?.summary).slice(0, 3);
    if (traceLines.length) contextLines.push(`以前同类任务的结果（参考，不要照抄失败的做法）：\n${traceLines.map((row) => `- ${String(row.summary).slice(0, 120)}`).join('\n')}`);
    if (capabilities) contextLines.push(String(capabilities).slice(0, 1600));
    const messages = [{ role: 'system', content: [PERSONA, `可用工具：\n${toolText}`, SCHEMA, ...contextLines].join('\n\n') }];
    for (const turn of history.slice(-8)) {
      if (turn?.role === 'user' || turn?.role === 'assistant') messages.push({ role: turn.role, content: String(turn.content ?? '').slice(0, 500) });
    }
    messages.push({ role: 'user', content: String(text ?? '').slice(0, 800) });

    let data;
    try {
      data = await chatCompletion({
        home,
        fetchImpl,
        messages,
        maxTokens: 400,
        temperature: 0.4,
        responseFormat: { type: 'json_object' },
        scope: {
          channel: 'qq',
          role: 'owner',
          account_id: accountId,
          peer_id: peerId,
          conversation_kind: kind === 'group' ? 'group' : 'direct',
          input_kind: 'text',
          ...(messageId ? { message_id: messageId } : {}),
        },
        timeoutMs: 20000,
      });
    } catch (error) {
      // 代理不可达仍然是 planner_unavailable（老调用方和测试都认这个码）。
      if (error?.message === 'brain_unavailable') throw new Error('planner_unavailable');
      throw error;
    }
    const raw = String(data?.choices?.[0]?.message?.content ?? '').trim();
    const parsed = parsePlan(raw);
    const { steps, rejected } = normalizeSteps(parsed.steps);
    return { say: String(parsed.say ?? '').slice(0, 300), steps, rejected, raw };
  };
}

/** 容错解析：允许模型偶尔套一层 ```json 或前后多说一句。 */
export function parsePlan(raw) {
  const text = String(raw ?? '').trim();
  const candidates = [text];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(text);
  if (fenced) candidates.push(fenced[1].trim());
  const braced = /\{[\s\S]*\}/u.exec(text);
  if (braced) candidates.push(braced[0]);
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object') {
        return { say: typeof value.say === 'string' ? value.say : '', steps: Array.isArray(value.steps) ? value.steps : [] };
      }
    } catch { /* 换下一个候选 */ }
  }
  return { say: text.slice(0, 300), steps: [] };
}
