import { createHash } from 'node:crypto';
import { CallSessions } from './call.mjs';
import { isVoiceAttachment, QqGateway } from './gateway.mjs';
import { conversationHistory, dayKey, initQq, logInbound, messageRow, peer, peers, recentMessages, reserve, savePeer, updateMessage, usage } from './store.mjs';

const MAX_DOWNLOAD = 10 * 1024 * 1024;
const DAILY_MODEL_CALLS = 50;
const DAILY_VOICE_REQUESTS = 50;

const CALL_HELP = '通话已开始，直接发语音或文字都行；静默 60 秒会自动挂断，发 /挂断 可手动结束。';
const HANGUP_HELP = '通话已挂断。';

export class QqService {
  constructor({ db, voice, api, ask, WebSocketImpl, gateway, log = () => {}, now = () => Date.now(), callTimeoutMs = 60000, downloadImpl = fetch }) {
    initQq(db);
    Object.assign(this, { db, voice, api, ask, log, now, downloadImpl });
    this.calls = new CallSessions({ timeoutMs: callTimeoutMs, now });
    this.gateway = gateway ?? new QqGateway({ api, WebSocketImpl, onEvent: event => this.handle(event), onStatus: status => log({ qq: status }) });
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    this.sweepTimer = setInterval(() => this.sweep(), 15000);
    this.sweepTimer.unref?.();
    return this.gateway.start();
  }

  async close() {
    this.stopped = true;
    clearInterval(this.sweepTimer);
    await this.gateway.close();
  }

  status() {
    return { peers: peers(this.db), calls: this.calls.list(), usage: usage(this.db, dayKey(this.now())) };
  }

  async download(url) {
    if (typeof url !== 'string' || !url.startsWith('https://')) throw new Error('invalid_qq_media');
    const response = await this.downloadImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('qq_media_download_failed');
    const declared = Number(response.headers?.get?.('content-length') ?? 0);
    if (declared > MAX_DOWNLOAD) throw new Error('qq_media_too_large');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_DOWNLOAD) throw new Error('qq_media_too_large');
    return bytes;
  }

  async sendTextSafe(kind, id, content, msgId) {
    try { await this.api.sendText({ kind, id, content, msgId }); return true; }
    catch (error) { this.log({ qq: 'text_failed', kind, id, error: error.message }); return false; }
  }

  sendVoiceSafe(kind, id, silk, msgId) {
    return this.api.sendVoice({ kind, id, silk, fileName: '大肥鱼语音回复.silk', msgId });
  }

  async handle(event) {
    const { kind, id, messageId, text = '', attachments = [] } = event;
    const messageKey = createHash('sha256').update(String(messageId ?? '')).digest('hex');
    const voiceAttachment = attachments.find(isVoiceAttachment) ?? null;
    const inputKind = voiceAttachment ? 'voice' : 'text';
    if (!logInbound(this.db, { id: messageKey, kind, convId: id, msgId: messageId ?? null, inputKind, text, createdMs: this.now() })) return { duplicate: true };

    const allowed = peer(this.db, kind, id);
    if (!allowed || !allowed.enabled || !allowed.autoReply) { updateMessage(this.db, messageKey, { status: 'held', error: 'peer_not_allowed' }); return { held: true }; }

    const command = text.trim();
    if (/^\/(通话|打电话)/.test(command)) {
      this.calls.start(kind, id);
      await this.sendTextSafe(kind, id, CALL_HELP, messageId);
      updateMessage(this.db, messageKey, { status: 'sent', delivery_kind: 'text' });
      return { command: 'call_start' };
    }
    if (/^\/(挂断|结束通话)/.test(command)) {
      const ended = this.calls.end(kind, id);
      await this.sendTextSafe(kind, id, ended ? HANGUP_HELP : '当前没有进行中的通话。', messageId);
      updateMessage(this.db, messageKey, { status: 'sent', delivery_kind: 'text' });
      return { command: 'call_end', ended };
    }
    if (/^\/语音\s*(开|关)$/.test(command)) {
      const enabled = command.endsWith('开');
      savePeer(this.db, { kind, id, enabled: true, autoReply: true, voiceReply: enabled });
      await this.sendTextSafe(kind, id, enabled ? '语音回复已开启。' : '语音回复已关闭，改为文字回复。', messageId);
      updateMessage(this.db, messageKey, { status: 'sent', delivery_kind: 'text' });
      return { command: 'voice_toggle', enabled };
    }

    let spoken = text;
    if (inputKind === 'voice') {
      updateMessage(this.db, messageKey, { status: 'transcribing' });
      try {
        const bytes = await this.download(voiceAttachment.url);
        const transcript = await this.voice.transcribeBytes(messageKey, bytes);
        spoken = transcript.text;
        updateMessage(this.db, messageKey, { text: spoken });
      } catch (error) {
        updateMessage(this.db, messageKey, { status: 'failed', error: 'voice_recognition_failed' });
        await this.sendTextSafe(kind, id, '这段语音我暂时没听清，请再说一次或改发文字。', messageId);
        return { error: 'voice_recognition_failed' };
      }
    }
    if (!spoken || !spoken.trim()) { updateMessage(this.db, messageKey, { status: 'held', error: 'empty_message' }); return { held: true }; }

    const day = dayKey(this.now());
    if (!reserve(this.db, day, 'model_calls', DAILY_MODEL_CALLS)) {
      updateMessage(this.db, messageKey, { status: 'held', error: 'daily_model_budget' });
      await this.sendTextSafe(kind, id, '今天已经说了好多话，明天再聊吧。', messageId);
      return { held: true, error: 'daily_model_budget' };
    }
    updateMessage(this.db, messageKey, { status: 'drafting' });
    let reply;
    try {
      reply = await this.ask({ kind, id, peer: allowed, text: spoken, history: conversationHistory(this.db, kind, id), inputKind, voiceCapabilities: this.voice?.status?.() });
      if (typeof reply !== 'string' || !reply.trim()) throw new Error('empty_reply');
      reply = reply.trim().slice(0, 1200);
    } catch (error) {
      updateMessage(this.db, messageKey, { status: 'failed', error: 'model_failed' });
      return { error: 'model_failed' };
    }
    updateMessage(this.db, messageKey, { status: 'ready', reply });

    const inCall = Boolean(this.calls.active(kind, id));
    const wantVoice = Boolean(this.voice) && (inCall || (inputKind === 'voice' && allowed.voiceReply));
    if (wantVoice) {
      updateMessage(this.db, messageKey, { status: 'synthesizing' });
      try {
        if (!reserve(this.db, day, 'voice_requests', DAILY_VOICE_REQUESTS)) throw new Error('daily_voice_budget');
        const audio = await this.voice.synthesize(messageKey, reply);
        updateMessage(this.db, messageKey, { status: 'sending' });
        await this.sendVoiceSafe(kind, id, audio.silk, messageId);
        updateMessage(this.db, messageKey, { status: 'sent', delivery_kind: 'voice', audio_duration_ms: audio.duration_ms });
        if (inCall) this.calls.touch(kind, id);
        return { replied: 'voice', duration_ms: audio.duration_ms };
      } catch (error) {
        updateMessage(this.db, messageKey, { error: `voice_reply_failed:${error.message}` });
      }
    }
    try {
      await this.api.sendText({ kind, id, content: reply, msgId: messageId });
      updateMessage(this.db, messageKey, { status: 'sent', delivery_kind: 'text' });
      if (inCall) this.calls.touch(kind, id);
      return { replied: 'text' };
    } catch (error) {
      updateMessage(this.db, messageKey, { status: 'unknown', error: 'delivery_not_confirmed' });
      return { error: 'delivery_not_confirmed' };
    }
  }

  sweep() {
    for (const expired of this.calls.sweep()) this.sendTextSafe(expired.kind, expired.id, '通话超时，已自动挂断。');
  }

  messages(limit = 20) { return recentMessages(this.db, limit); }

  row(id) { return messageRow(this.db, id); }
}
