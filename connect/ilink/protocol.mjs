import { randomBytes } from 'node:crypto';
export const BASE_URL = 'https://ilinkai.weixin.qq.com';
export const PROTOCOL_VERSION = '3.0.0-beta-0';
export const BASE_INFO = { channel_version: PROTOCOL_VERSION, bot_agent: 'DaFeiYuConnect/0.3.0' };
export function trustedBase(value) {
  const url = new URL(value || BASE_URL);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || (url.hostname !== 'ilinkai.weixin.qq.com' && !url.hostname.endsWith('.weixin.qq.com')) || url.pathname !== '/' || url.search || url.hash) throw new Error('untrusted_ilink_endpoint');
  return url.origin;
}
// Adapted from Tencent/openclaw-weixin, src/api/api.ts (MIT, copyright Tencent 2026).
// Preserve uint64 IDs before JavaScript JSON parsing. See THIRD_PARTY_LICENSES.md.
export function parseProtocolJson(rawText) {
  const fields = new Set(['message_id', 'msg_id', 'svr_id']);
  let output = '', index = 0;
  while (index < rawText.length) {
    if (rawText[index] !== '"') { output += rawText[index++]; continue; }
    const start = index++;
    let escaped = false;
    while (index < rawText.length) {
      const char = rawText[index++];
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') break;
    }
    const token = rawText.slice(start, index); output += token;
    let cursor = index;
    while (/\s/.test(rawText[cursor] ?? '')) cursor++;
    if (rawText[cursor] !== ':') continue;
    let key;
    try { key = JSON.parse(token); } catch { continue; }
    if (typeof key !== 'string' || !fields.has(key)) continue;
    output += rawText.slice(index, cursor + 1); cursor++;
    while (/\s/.test(rawText[cursor] ?? '')) output += rawText[cursor++];
    const numStart = cursor;
    if (rawText[cursor] === '-') cursor++;
    while (/\d/.test(rawText[cursor] ?? '')) cursor++;
    if (cursor > numStart && !(cursor === numStart + 1 && rawText[numStart] === '-')) {
      output += `"${rawText.slice(numStart, cursor)}"`; index = cursor;
    } else index = numStart;
  }
  return JSON.parse(output);
}
export class IlinkClient {
  constructor({ fetchImpl = fetch } = {}) { this.fetch = fetchImpl; }
  async request(endpoint, { base = BASE_URL, token, body, timeout = 35000, signal } = {}) {
    const url = `${trustedBase(base)}/${endpoint}`;
    const headers = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String(3 << 16) };
    if (body !== undefined) Object.assign(headers, { 'content-type': 'application/json', AuthorizationType: 'ilink_bot_token', 'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64') });
    if (token) headers.Authorization = `Bearer ${token}`;
    let response;
    try { response = await this.fetch(url, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) }); }
    catch (error) { if (signal?.aborted || error.name === 'AbortError' || error.name === 'TimeoutError') throw Object.assign(new Error('ilink_timeout'), { code: 'timeout' }); throw new Error('ilink_network_error'); }
    if (!response.ok) throw new Error(`ilink_http_${response.status}`);
    // Bound the full response; no upstream body is ever included in errors/logs.
    const reader = response.body.getReader(); let bytes = 0, chunks = [];
    for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 4 * 1024 * 1024) { await reader.cancel(); throw new Error('ilink_response_too_large'); } chunks.push(value); }
    let data;
    try { data = parseProtocolJson(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('ilink_invalid_json'); }
    if ((data.ret !== undefined && Number(data.ret) !== 0) || (data.errcode !== undefined && Number(data.errcode) !== 0)) throw new Error(`ilink_api_${Number(data.errcode || data.ret)}`);
    return data;
  }
  qr(tokens = []) { return this.request('ilink/bot/get_bot_qrcode?bot_type=3', { body: { local_token_list: tokens }, timeout: 15000 }); }
  qrStatus(qr, { base, pin, signal } = {}) {
    return this.request(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr)}${pin ? '&verify_code=' + encodeURIComponent(pin) : ''}`, { base, signal });
  }
  updates(account, cursor, signal) { return this.request('ilink/bot/getupdates', { base: account.baseUrl, token: account.token, body: { get_updates_buf: cursor ?? '', base_info: BASE_INFO }, signal }); }
  send(account, { peerId, text, contextToken, clientId }, signal) {
    return this.request('ilink/bot/sendmessage', { base: account.baseUrl, token: account.token, timeout: 15000, signal,
      body: { msg: { from_user_id: '', to_user_id: peerId, client_id: clientId, message_type: 2, message_state: 2, item_list: [{ type: 1, text_item: { text } }], context_token: contextToken }, base_info: BASE_INFO } });
  }
}
