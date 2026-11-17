const INTENTS = 1 << 25; // GROUP_AND_C2C_EVENT

function cleanText(value) {
  return String(value ?? '').replace(/<@!?[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function normalize(dispatch) {
  const d = dispatch.d ?? {};
  if (dispatch.t === 'C2C_MESSAGE_CREATE') {
    return { kind: 'c2c', id: d.author?.user_openid, messageId: d.id, text: cleanText(d.content), attachments: Array.isArray(d.attachments) ? d.attachments : [], timestamp: d.timestamp ?? null, atMe: true };
  }
  if (dispatch.t === 'GROUP_AT_MESSAGE_CREATE' || dispatch.t === 'GROUP_MESSAGE_CREATE') {
    const mentions = Array.isArray(d.mentions) ? d.mentions : [];
    const raw = String(d.content ?? '');
    // @全体 不算「对你说」，除非内容里点名大肥鱼（由 service 判断）
    const mentionAll = /<@all>/iu.test(raw);
    const atMe = dispatch.t === 'GROUP_AT_MESSAGE_CREATE' || (!mentionAll && mentions.some(entry => entry && entry.bot === true));
    const others = mentions.filter(entry => entry && entry.bot !== true);
    return {
      kind: 'group', id: d.group_openid, memberId: d.author?.member_openid, messageId: d.id,
      text: cleanText(d.content), attachments: Array.isArray(d.attachments) ? d.attachments : [],
      timestamp: d.timestamp ?? null,
      atMe,
      // 这条消息 @ 的是别人，不是冲着大肥鱼来的
      mentionOthers: others.length > 0,
      mentionAll,
    };
  }
  return null;
}

export function normalizeDispatch(dispatch) { return normalize(dispatch); }

export function isVoiceAttachment(attachment) {
  const type = String(attachment?.content_type ?? '').toLowerCase();
  const name = String(attachment?.filename ?? '').toLowerCase();
  return type.startsWith('audio/') || /\.(silk|amr|mp3|wav|ogg|m4a)$/.test(name);
}

export class QqGateway {
  constructor({ api, WebSocketImpl = WebSocket, onEvent, onStatus = () => {}, intents = INTENTS, now = () => Date.now() }) {
    Object.assign(this, { api, WebSocketImpl, onEvent, onStatus, intents, now });
    this.seq = null; this.sessionId = null; this.ws = null; this.heartbeat = null; this.retry = 0; this.stopped = true;
  }

  async start() {
    this.stopped = false;
    await this.connect(false);
  }

  async connect(resume) {
    if (this.stopped) return;
    const url = await this.api.gatewayUrl();
    const token = await this.api.token();
    const ws = new this.WebSocketImpl(url);
    this.ws = ws;
    this.onStatus({ state: 'connecting', resumed: Boolean(resume && this.sessionId) });
    let identified = false;
    ws.onmessage = frame => {
      let packet;
      try { packet = JSON.parse(typeof frame.data === 'string' ? frame.data : String(frame.data)); } catch { return; }
      if (typeof packet.s === 'number') this.seq = packet.s;
      if (packet.op === 10) {
        this.retry = 0;
        this.startHeartbeat(packet.d?.heartbeat_interval ?? 30000);
        const canResume = Boolean(resume && this.sessionId);
        ws.send(JSON.stringify(canResume
          ? { op: 6, d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.seq ?? 0 } }
          : { op: 2, d: { token: `QQBot ${token}`, intents: this.intents, shard: [0, 1] } }));
        identified = true;
        return;
      }
      if (packet.op === 11) return;
      if (packet.op === 7) { this.reconnect(true); return; }
      if (packet.op === 9) { this.sessionId = null; this.seq = null; this.reconnect(false); return; }
      if (packet.op !== 0) return;
      if (packet.t === 'READY') {
        this.sessionId = packet.d?.session_id ?? null;
        this.onStatus({ state: 'online', session: Boolean(this.sessionId) });
        return;
      }
      if (packet.t === 'RESUMED') { this.onStatus({ state: 'online', resumed: true }); return; }
      const event = normalize(packet);
      if (event) Promise.resolve().then(() => this.onEvent(event)).catch((error) => {
        this.onStatus({ state: 'handler_error', error: String(error?.message ?? error).slice(0, 240) });
      });
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      this.clearHeartbeat();
      if (this.stopped) return;
      this.onStatus({ state: 'disconnected', identified });
      this.reconnect(Boolean(this.sessionId));
    };
  }

  startHeartbeat(interval) {
    this.clearHeartbeat();
    this.heartbeat = setInterval(() => {
      try { this.ws?.send(JSON.stringify({ op: 1, d: this.seq })); } catch { /* reconnect handles it */ }
    }, Math.max(5000, Number(interval) || 30000));
    this.heartbeat.unref?.();
  }

  clearHeartbeat() { if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; } }

  reconnect(resume) {
    if (this.stopped) return;
    this.clearHeartbeat();
    try { this.ws?.close(); } catch { /* already closed */ }
    const delay = Math.min(1000 * 2 ** this.retry++, 30000);
    this.timer = setTimeout(() => { this.connect(resume).catch(() => this.reconnect(resume)); }, delay);
    this.timer.unref?.();
  }

  async close() {
    this.stopped = true;
    this.clearHeartbeat();
    clearTimeout(this.timer);
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
  }
}
