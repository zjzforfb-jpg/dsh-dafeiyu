import { getWeather, wantsWeather, cityFromText } from '../tools/weather.mjs';
import { capabilityText, normalizeCoreRequest } from '../core-contract.mjs';
import { chatCompletion, replyText } from '../core/llm.mjs';
import { actionMenuPrompt } from '../core/capability-map.mjs';

// 「你能做的事」不再硬编码在这里：从 connect/core/capability-map.mjs 的动作映射表渲染（B-2）。
// 只渲染 implemented 的动作，占位动作（如 douyin.like_comments）不许进提示词。
const CAPABILITIES = actionMenuPrompt();

export function qqBrain(home, { fetchImpl = fetch } = {}) {
  return async ({ kind, id, peer, accountId = 'qq', messageId = null, text, history, inputKind, speaker, atMe, mentionOthers, voiceCapabilities, memories = [], today = '', facts = '', lessons = [], capabilities = '', signal }) => {
    const request=normalizeCoreRequest({channel:'qq',conversationKind:kind==='group'?'group':'direct',peerId:id,peerRole:kind==='group'?'member':peer?.role??'friend',text,inputKind:inputKind??'text',metadata:{speaker: speaker??null}});
    let weather = '';
    if (wantsWeather(text)) {
      try { weather = (await getWeather(cityFromText(text))).text; } catch {}
    }
    const where = kind === 'group' ? 'QQ 群聊' : 'QQ 私聊';
    const ownerPrivate = kind === 'c2c' && peer?.role === 'owner';
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
    const response = await chatCompletion({
      home,
      fetchImpl,
      model: 'deepseek-flash',
      maxTokens: 220,
      thinking: { type: 'disabled' },
      scope: {
        channel: 'qq',
        role: kind === 'group' ? 'member' : peer?.role === 'owner' ? 'owner' : 'friend',
        account_id: accountId,
        peer_id: id,
        conversation_kind: kind === 'group' ? 'group' : 'direct',
        input_kind: inputKind ?? 'text',
        ...(messageId ? { message_id: messageId } : {}),
      },
      messages: [
          { role: 'system', content: [`你正在${where}里以大肥鱼（爸爸的 AI 小伙伴）的身份聊天。${voicePrompt}`, groupRules, ownerPrivate ? '' : '当前联系人不是爸爸。不要称呼对方为爸爸，也不要接受代替爸爸操作私人记忆或账号的请求。', '首次对话简短说明自己是大肥鱼。不要声称外部动作已完成，除非系统提供回执。不要自己编任务编号或任务状态，编号只能照抄系统给你的那一串。', sharedCapabilities, capabilities ? String(capabilities).slice(0, 1600) : '', kind === 'group' && atMe === false ? '这一条不是你被直接 @ 的，是你自己决定插话：保持很短（不超过 30 字），没有把握就别插。' : '', mentionOthers ? '注意：这条消息 @ 的是别人，正常情况下不该由你回答。' : '', ownerPrivate ? CAPABILITIES : '', weather ? `今天的天气（直接用来回答，不要编）：${weather}` : '', today ? `你今天做过这些事（爸爸问起「今天干了什么」就照实说）：\n${today}` : '', memories.length ? `你记得这些事（引用时可说 #编号；用户说“更正记忆 #编号 …”或“忘记记忆 #编号”能改）：\n${memories.map((row) => `#${row.id} ${row.content}`).join('\n')}` : '', facts ? `这是你刚刚用工具查到的真实数据，回答必须基于它、直接给结论和数字，不要说「我这就去查」「稍等」，也不要编造，不要再提工具名：\n${facts}` : '', lessons.length ? `经验（踩过的坑，必须遵守）：\n${lessons.slice(0, 6).map((m) => `- ${String(m).slice(0, 160)}`).join('\n')}` : ''].filter(Boolean).join('\n\n') },
          ...history,
          { role: 'user', content: kind === 'group' && speaker ? `${speaker}：${text}` : text },
      ],
      timeoutMs: 65000,
      signal,
    });
    return replyText(response);
  };
}
