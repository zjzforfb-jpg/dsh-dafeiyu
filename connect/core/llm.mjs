// 计划 P0-B-4：模型调用收口。
//
// 以前调用 Brain 代理的 fetch 散在 11 个地方（qq/planner、qq/brain、ilink/brain、
// call/brain×2、douyin/brain、academy/study、academy/weekly、scripts×3 …），
// 每处自己拼 URL、自己读 apiKey、自己判 response.ok、自己取 choices[0]。
// 现在统一走 chatCompletion()：认证、超时、错误码、身份信封只有一份。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Brain 代理的默认地址（本机 OpenAI 兼容端点）。 */
export const BRAIN_BASE_URL = 'http://127.0.0.1:3110';

/** 代理不可达 / 返回非 2xx 时统一抛这个错误码。 */
export const BRAIN_UNAVAILABLE = 'brain_unavailable';
/** 代理返回了但正文是空的。 */
export const EMPTY_REPLY = 'empty_reply';

/**
 * 读模型配置。home 指向「里面有一层 dsh-pet/standalone-ai.json」的目录。
 * @returns {{apiKey:string, model:string}}
 */
export function readModelSettings(home) {
  const path = join(home, 'dsh-pet', 'standalone-ai.json');
  const settings = JSON.parse(readFileSync(path, 'utf8'));
  return {
    apiKey: String(settings.apiKey ?? ''),
    model: String(settings.model ?? 'deepseek-flash'),
  };
}

/**
 * 身份信封：只允许已知的渠道与角色，其它一律拒。
 * brain/server.mjs 那侧也会再校验一次，这里先挡一道，别把脏信封送出去。
 */
export function connectScope(scope) {
  if (scope === undefined || scope === null) return undefined;
  const value = typeof scope === 'object' ? scope : {};
  const channel = String(value.channel ?? '').trim();
  const role = String(value.role ?? 'friend').trim();
  const allowedChannels = ['desktop', 'qq', 'wechat', 'ilink', 'android', 'call', 'douyin'];
  const allowedRoles = ['owner', 'friend', 'member', 'self'];
  if (!allowedChannels.includes(channel)) throw new Error(`invalid_scope_channel:${channel}`);
  if (!allowedRoles.includes(role)) throw new Error(`invalid_scope_role:${role}`);
  const envelope = { channel, role };
  for (const key of ['account_id', 'peer_id', 'message_id', 'label']) {
    if (value[key] !== undefined && value[key] !== null) envelope[key] = String(value[key]);
  }
  if (value.conversation_kind !== undefined) envelope.conversation_kind = String(value.conversation_kind);
  if (value.input_kind !== undefined) envelope.input_kind = String(value.input_kind);
  return envelope;
}

/**
 * 统一调用 Brain 代理。
 *
 * @param {object} options
 *   home        模型配置所在目录（其下有 dsh-pet/standalone-ai.json）；不传则用 apiKey/model 显式给
 *   messages    对话消息数组
 *   model / max_tokens / temperature / response_format / thinking
 *   scope       身份信封（connect/core/scope.mjs 的形状）
 *   stream      是否流式
 *   timeoutMs / signal
 *   fetchImpl   注入用，测试用
 * @returns {Promise<any>} 代理返回的 JSON
 */
export async function chatCompletion({
  home = null,
  apiKey = null,
  model = null,
  messages = [],
  maxTokens = null,
  temperature = null,
  responseFormat = null,
  thinking = null,
  scope = undefined,
  stream = false,
  timeoutMs = 20000,
  signal = null,
  fetchImpl = fetch,
  url = null,
} = {}) {
  const settings = home ? readModelSettings(home) : null;
  const key = apiKey ?? settings?.apiKey ?? '';
  const name = model ?? settings?.model ?? 'deepseek-flash';
  if (!key) throw new Error('brain_api_key_missing');

  const body = {
    model: name,
    stream: Boolean(stream),
    messages,
  };
  if (maxTokens !== null && maxTokens !== undefined) body.max_tokens = maxTokens;
  if (temperature !== null && temperature !== undefined) body.temperature = temperature;
  if (responseFormat) body.response_format = responseFormat;
  if (thinking) body.thinking = thinking;

  const envelope = connectScope(scope);
  if (envelope) body.metadata = { connect: envelope };

  const target = url ?? `${BRAIN_BASE_URL}/v1/chat/completions`;
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(target, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error(BRAIN_UNAVAILABLE);
  return response.json();
}

/**
 * 取正文。空正文抛 empty_reply —— 调用方据此判断「模型没说话」，
 * 不要把它当成一句空字符串发出去。
 */
export function replyText(data, { allowEmpty = false } = {}) {
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || (!allowEmpty && !text.trim())) throw new Error(EMPTY_REPLY);
  return text;
}

/**
 * 取 JSON 正文（容错：模型偶尔套一层 ```json 或前后多说一句）。
 */
export function replyJson(data) {
  const raw = String(replyText(data, { allowEmpty: true }) ?? '').trim();
  const candidates = [raw];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(raw);
  if (fenced) candidates.push(fenced[1].trim());
  const braced = /\{[\s\S]*\}/u.exec(raw);
  if (braced) candidates.push(braced[0]);
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object') return value;
    } catch { /* 换下一个候选 */ }
  }
  return null;
}
