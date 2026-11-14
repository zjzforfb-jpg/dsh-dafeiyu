import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function callBrain(home) {
  return async ({ text, history = [], signal, speaker = '爸爸' }) => {
    const settings = JSON.parse(readFileSync(join(home, 'dsh-pet', 'standalone-ai.json'), 'utf8'));
    const response = await fetch('http://127.0.0.1:3110/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-flash', stream: false, max_tokens: 160, thinking: { type: 'disabled' },
        messages: [
          { role: 'system', content: `你正在和${speaker}打实时语音电话（半双工：对方说完你再说，你的回复会被合成成语音）。用口语，像家里人聊天，一两小句，最多 30 字；不要 Markdown、列表、颜文字堆叠，不要报时间戳或说“以上”。称呼对方为「${speaker}」。如果对方明确要结束通话（「不聊了」「先这样」「我要忙了」等），在回复末尾加 [HANGUP]，系统会挂断。` },
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

/** 流式版本：先吐出文字增量，调用方可以按句子提前合成。 */
export function callBrainStream(home) {
  return async function* ({ text, history = [], signal, speaker = '爸爸' }) {
    const settings = JSON.parse(readFileSync(join(home, 'dsh-pet', 'standalone-ai.json'), 'utf8'));
    const response = await fetch('http://127.0.0.1:3110/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-flash', stream: true, max_tokens: 160, thinking: { type: 'disabled' },
        messages: [
          { role: 'system', content: `你正在和${speaker}打实时语音电话（半双工）。用口语，一两小句，最多 30 字；不要 Markdown，称呼对方为「${speaker}」。如果对方明确要结束通话，在回复末尾加 [HANGUP]。` },
          ...history,
          { role: 'user', content: text },
        ],
      }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(65000)]) : AbortSignal.timeout(65000),
    });
    if (!response.ok) throw new Error('brain_unavailable');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const match = line.match(/^data: (.+)$/);
        if (!match || match[1] === '[DONE]') continue;
        try {
          const delta = JSON.parse(match[1]).choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch {}
      }
    }
  };
}
