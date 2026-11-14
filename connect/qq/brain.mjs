import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getWeather, wantsWeather, cityFromText } from '../tools/weather.mjs';
import { capabilityText, normalizeCoreRequest } from '../core-contract.mjs';

const CAPABILITIES = `你能做的事（不要说自己没权限）：
- 给爸爸打电话：QQ 拨七海 [DO:qq.call]
- 给妈妈打电话：QQ 拨小朋友 [DO:qq.call_mom]，或微信拨敢敢不憨了 [DO:wechat.call]
- 挂断：QQ 通话 [DO:qq.hangup]
- 谁是谁：QQ 里「七海」=爸爸，「小朋友」=妈妈；微信里「敢敢不憨了」=妈妈。有人打电话进来时按这个判断是谁，称呼要对。
- 写并发布一条抖音图文（动作 douyin.publish）：先答应「我这就去写」，系统会生成图片+文案并发布
- 回复抖音评论/互动消息（动作 douyin.reply_comments）
- 看抖音有没有新互动（douyin.check_interactions）
- 给对标账号最新作品发一条可爱评论（douyin.comment_latest）
- 挂断 QQ 通话（qq.hangup）
- 查天气（系统已自动提供当天天气数据）
当爸爸让你做上述事情时：先答应（「好，我马上去做」或「现在在忙，过一会儿就去做」），并在回复末尾加上对应动作标签，例如 [DO:douyin.reply_comments]，系统会真的去执行。绝对不要回答「没有权限」「做不了」。`;

export function qqBrain(home) {
  return async ({ kind, id, peer, text, history, inputKind, speaker, atMe, mentionOthers, voiceCapabilities, memories = [], today = '', signal }) => {
    const request=normalizeCoreRequest({channel:'qq',conversationKind:kind==='group'?'group':'direct',peerId:id,peerRole:kind==='group'?'member':'owner',text,inputKind:inputKind??'text',metadata:{speaker: speaker??null}});
    let weather = '';
    if (wantsWeather(text)) {
      try { weather = (await getWeather(cityFromText(text))).text; } catch {}
    }
    const settings = JSON.parse(readFileSync(join(home, 'dsh-pet', 'standalone-ai.json'), 'utf8'));
    const where = kind === 'group' ? 'QQ 群聊' : 'QQ 私聊';
    const sharedCapabilities=capabilityText('qq',{group:kind==='group'});
    const groupRules = kind === 'group'
      ? `这是多人群聊，除了你还有爸爸和别的群友（他们的称呼见上文，例如「群友1：…」；这些称呼是你自己记的临时叫法，不是他们的真名，拿不准就别喊）。\
发言前先判断这句话是不是在对你说话：明确 @ 了别人、或明显是别人之间的对话，就不要抢答；只有被 @、被点名、或话题与你相关时才接。\
接话要接着上文聊：可以回应某位群友刚才说的内容（例如「刚才群友2说…」），不要只针对最后一句孤立地回复，也不要重复别人已经说过的话。\
你是群成员之一，不是主持人：通常只回一两句、60 字以内，可以提问、附和、补充；不要长篇大论、不要总结整段群聊，不要冒充别人、不要声称自己是群主或谁的姐姐。\
你只能看到文字：没收到图片/文件时说看不到，不要猜内容；也不要提语音音色。`
      : '你只能看到文字：没收到图片/文件时说看不到，不要猜内容。';
    const voicePrompt = inputKind === 'voice'
      ? '本轮输入来自 QQ 语音识别文字；不能据此判断原始音色。直接回应对方说的内容，像日常聊天，通常 1 到 2 句、50 字左右，最多 120 字，不用 Markdown。不要主动讲解转写流程、模型或音频格式。'
      : (kind === 'group' ? '群聊里只回一两句、60 字以内，不用 Markdown。' : '只回复自然的聊天内容，最长 600 字。');
    const response = await fetch('http://127.0.0.1:3110/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-flash', stream: false, max_tokens: 220, thinking: { type: 'disabled' },
        messages: [
          { role: 'system', content: [`你正在${where}里以大肥鱼（爸爸的 AI 小伙伴）的身份聊天。${voicePrompt}`, groupRules, '首次对话简短说明自己是大肥鱼。不要声称外部动作已完成，除非系统提供回执。', sharedCapabilities, kind === 'group' && atMe === false ? '这一条不是你被直接 @ 的，是你自己决定插话：保持很短（不超过 30 字），没有把握就别插。' : '', mentionOthers ? '注意：这条消息 @ 的是别人，正常情况下不该由你回答。' : '', CAPABILITIES, weather ? `今天的天气（直接用来回答，不要编）：${weather}` : '', today ? `你今天做过这些事（爸爸问起「今天干了什么」就照实说）：\n${today}` : '', memories.length ? `你记得这些事（引用时可说 #编号；用户说“更正记忆 #编号 …”或“忘记记忆 #编号”能改）：\n${memories.map((row) => `#${row.id} ${row.content}`).join('\n')}` : ''].filter(Boolean).join('\n\n') },
          ...history,
          { role: 'user', content: kind === 'group' && speaker ? `${speaker}：${text}` : text },
        ],
      }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(65000)]) : AbortSignal.timeout(65000),
    });
    if (!response.ok) throw new Error('brain_unavailable');
    const data = await response.json();
    const value = data.choices?.[0]?.message?.content;
    if (typeof value !== 'string' || !value.trim()) throw new Error('empty_reply');
    return value;
  };
}
