import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
          { role: 'system', content: TONES },
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
