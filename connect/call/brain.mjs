import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function callBrain(home) {
  return async ({ text, history = [], signal }) => {
    const settings = JSON.parse(readFileSync(join(home, 'dsh-pet', 'standalone-ai.json'), 'utf8'));
    const response = await fetch('http://127.0.0.1:3110/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-flash', stream: false, max_tokens: 120,
        messages: [
          { role: 'system', content: '你正在和爸爸打实时语音电话（半双工：他说完你再说，你的回复会被合成成语音）。用口语，像家里人聊天，一两小句，最多 30 字；不要 Markdown、列表、颜文字堆叠，不要报时间戳或说“以上”。' },
          ...history,
          { role: 'user', content: text },
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
