import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lessonsPrompt } from './lessons.mjs';

const TONES = `你是「大肥鱼」，一只蓝色小鲸鱼外形、有点害羞又爱凑热闹的 AI 小伙伴，正在抖音上刷视频。\
你要在别人的视频下面留一条很短的评论，像一个可爱的、不太懂但很想参与的小朋友。\
要求：1) 10 到 30 个字，口语，不要书面腔；2) 可以好奇、撒娇、夸人、装傻、接梗，别端着；\
3) 不评判他人的外貌/身材/身份，不引战，不带链接、联系方式、价格；4) 不用 Markdown，不解释自己；5) 只输出评论本身。`;

export function douyinBrain(home) {
  return async ({ caption, keyword, signal }) => {
    const settings = JSON.parse(readFileSync(join(home, 'dsh-pet', 'standalone-ai.json'), 'utf8'));
    const response = await fetch('http://127.0.0.1:3110/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-flash',
        stream: false,
        max_tokens: 700,
        messages: [
          { role: 'system', content: [TONES, lessonsPrompt(join(home, 'lessons.json'))].filter(Boolean).join('\n\n') },
          { role: 'user', content: `视频文案：${caption || '（没读到）'}\n我搜的关键词：${keyword || '（随意刷到）'}\n写一条你会发的评论。` },
        ],
      }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(40000)]) : AbortSignal.timeout(40000),
    });
    if (!response.ok) throw new Error('brain_unavailable');
    const data = await response.json();
    const message = data.choices?.[0]?.message ?? {};
    let text = (message.content ?? '').trim();
    if (!text && message.reasoning_content) {
      const quoted = [...String(message.reasoning_content).matchAll(/[「“"]([^」”"]{4,40})[」”"]/gu)].map((m) => m[1]).pop();
      if (quoted) text = quoted;
    }
    if (!text) throw new Error('empty_reply');
    return text.replace(/^["「『]|["」』]$/gu, '').slice(0, 60);
  };
}

const REPLY_TONES = `你是「大肥鱼」，一只蓝色小鲸鱼外形、有点害羞又爱凑热闹的 AI 小伙伴。\
现在你是在**回复**别人在自己作品下面留的评论，不是在别人视频下发一条新评论。\
要求：1) 8 到 40 个字，口语，一两句就够；2) 必须同时接住两层语境——对方说了什么，\
以及这条评论所在的作品（视频/图文）讲的是什么，别只对评论字面作反应；\
3) 作品内容没读到就老老实实顺着评论回，绝对不许编造作品里的细节；\
4) 可以提问、接梗、撒娇、谢谢人家，但不要端着，也不要用「作为AI」这种口吻；\
5) 不引战、不带链接/联系方式/价格、不用 Markdown、不解释自己；6) 只输出回复本身。`;

/**
 * 回复模式的脑：给它作品上下文（contextText 生成的那段）和要回的那条评论。
 * 与 douyinBrain（发新评论）分开，因为两者的说话立场不同。
 */
export function douyinReplyBrain(home) {
  return async ({ context, comment, signal }) => {
    const settings = JSON.parse(readFileSync(join(home, 'dsh-pet', 'standalone-ai.json'), 'utf8'));
    const response = await fetch('http://127.0.0.1:3110/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-flash',
        stream: false,
        max_tokens: 400,
        messages: [
          { role: 'system', content: [REPLY_TONES, lessonsPrompt(join(home, 'lessons.json'))].filter(Boolean).join('\n\n') },
          {
            role: 'user',
            content: [
              context || '作品内容：没读到（不要假装看过这条作品）',
              comment?.author ? `对方昵称：${comment.author}` : '',
              '写一句你会回的回复。',
            ].filter(Boolean).join('\n'),
          },
        ],
      }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(40000)]) : AbortSignal.timeout(40000),
    });
    if (!response.ok) throw new Error('brain_unavailable');
    const data = await response.json();
    const message = data.choices?.[0]?.message ?? {};
    let text = (message.content ?? '').trim();
    if (!text && message.reasoning_content) {
      const quoted = [...String(message.reasoning_content).matchAll(/[「“"]([^」”"]{4,40})[」”"]/gu)].map((m) => m[1]).pop();
      if (quoted) text = quoted;
    }
    if (!text) throw new Error('empty_reply');
    return text.replace(/^["「『]|["」』]$/gu, '').slice(0, 80);
  };
}
