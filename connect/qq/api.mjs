import { readFileSync, existsSync } from 'node:fs';

export const QQ_API = 'https://api.sgroup.qq.com';
export const QQ_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const MAX_BODY = 1_500_000;
const TIMEOUT_MS = 20_000;

export function loadQqConfig(root, env = process.env) {
  const file = `${root}/qq.json`;
  if (existsSync(file)) {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    const secret = typeof value?.secret === 'string' ? value.secret : typeof value?.appSecret === 'string' ? value.appSecret : '';
    if (value && typeof value.appId === 'string' && secret) return { appId: value.appId, secret };
    throw new Error('invalid_qq_config');
  }
  if (typeof env.QQ_BOT_APP_ID === 'string' && typeof env.QQ_BOT_SECRET === 'string') return { appId: env.QQ_BOT_APP_ID, secret: env.QQ_BOT_SECRET };
  return null;
}

function conversationPath(kind, id) {
  if (!['c2c', 'group'].includes(kind)) throw new Error('invalid_qq_conversation');
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(id)) throw new Error('invalid_qq_conversation_id');
  return kind === 'c2c' ? `/v2/users/${id}` : `/v2/groups/${id}`;
}

export class QqApi {
  constructor({ appId, secret, fetchImpl = fetch, now = () => Date.now(), base = QQ_API, tokenUrl = QQ_TOKEN_URL, timeoutMs = TIMEOUT_MS }) {
    if (typeof appId !== 'string' || !appId || typeof secret !== 'string' || !secret) throw new Error('invalid_qq_credentials');
    Object.assign(this, { appId, secret, fetchImpl, now, base, tokenUrl, timeoutMs });
    this.tokenCache = null;
  }

  async token(force = false) {
    if (!force && this.tokenCache && this.tokenCache.expiresAt - 60_000 > this.now()) return this.tokenCache.value;
    const response = await this.fetchImpl(this.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: this.appId, clientSecret: this.secret }),
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const data = await this.read(response);
    if (!response.ok || typeof data.access_token !== 'string') throw new Error('qq_token_rejected');
    const seconds = Number(data.expires_in) || 7200;
    this.tokenCache = { value: data.access_token, expiresAt: this.now() + seconds * 1000 };
    return data.access_token;
  }

  async read(response) {
    const text = await response.text();
    if (text.length > MAX_BODY) throw new Error('qq_response_too_large');
    if (!text) return {};
    try { return JSON.parse(text); } catch { throw new Error('qq_invalid_response'); }
  }

  async call(method, path, payload, signal) {
    const token = await this.token();
    const response = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: { authorization: `QQBot ${token}`, 'content-type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
    });
    const data = await this.read(response);
    if (!response.ok) {
      if ((data.code === 11244 || data.code === 11241) && this.tokenCache) { this.tokenCache = null; }
      throw new Error(`qq_api_${data.code ?? response.status}`);
    }
    return data;
  }

  async gatewayUrl() {
    const data = await this.call('GET', '/gateway');
    if (typeof data.url !== 'string' || !data.url.startsWith('wss://')) throw new Error('qq_gateway_invalid');
    return data.url;
  }

  sendText({ kind, id, content, msgId }) {
    const text = String(content ?? '').trim().slice(0, 2000);
    if (!text) throw new Error('qq_empty_message');
    return this.call('POST', `${conversationPath(kind, id)}/messages`, { content: text, msg_type: 0, ...(msgId ? { msg_id: msgId } : {}) });
  }

  uploadMedia({ kind, id, fileType, file, fileName, srvSendMsg = false }) {
    if (![1, 2, 3, 4].includes(fileType)) throw new Error('invalid_qq_file_type');
    const body = { file_type: fileType, srv_send_msg: srvSendMsg, ...(fileName ? { file_name: fileName } : {}) };
    if (Buffer.isBuffer(file)) body.file_data = file.toString('base64');
    else if (typeof file === 'string') body.url = file;
    else throw new Error('invalid_qq_file');
    return this.call('POST', `${conversationPath(kind, id)}/files`, body);
  }

  /** 发一张图片（QQ 官方富媒体：file_type 1 上传后按 msg_type 7 引用）。 */
  async sendImage({ kind, id, file, fileName = 'image.jpg', msgId }) {
    const uploaded = await this.uploadMedia({ kind, id, fileType: 1, file, fileName, srvSendMsg: false });
    const fileInfo = uploaded.file_info ?? uploaded.file_uuid;
    if (typeof fileInfo !== 'string' || !fileInfo) throw new Error('qq_upload_rejected');
    return this.call('POST', `${conversationPath(kind, id)}/messages`, { content: '', msg_type: 7, media: { file_info: fileInfo }, ...(msgId ? { msg_id: msgId } : {}) });
  }

  async sendVoice({ kind, id, silk, fileName = 'voice.silk', msgId }) {
    const uploaded = await this.uploadMedia({ kind, id, fileType: 3, file: silk, fileName, srvSendMsg: false });
    const fileInfo = uploaded.file_info ?? uploaded.file_uuid;
    if (typeof fileInfo !== 'string' || !fileInfo) throw new Error('qq_upload_rejected');
    return this.call('POST', `${conversationPath(kind, id)}/messages`, { content: '', msg_type: 7, media: { file_info: fileInfo }, ...(msgId ? { msg_id: msgId } : {}) });
  }
}
