import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CALL_PAGE = readFileSync(join(import.meta.dirname, 'page.html'), 'utf8');
const MIN_SECONDS = 0.3;
const MAX_SECONDS = 15;
const MAX_BYTES = 4 * 600 * 1024;

export function pcmToWav(pcm16, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm16.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm16.length, 40);
  return Buffer.concat([header, pcm16]);
}

export class CallService {
  constructor({ voice, ask, askStream = null, log = () => {}, now = () => Date.now(), maxHistory = 16, busyTimeoutMs = 30000, onHangup = null, onEvent = () => {} }) {
    Object.assign(this, { voice, ask, askStream, log, now, maxHistory, busyTimeoutMs, onHangup, onEvent });
    this.sessions = new Map();
    this.pending = new Map();
    this.controllers = new Map();
  }

  // D-3：通话接入完整事件流。一次通话轮次发 message_received / message_replied，
  // 由调用方（connect/server.mjs）落进 agent_events。事件记录绝不影响通话本身。
  emitEvent(event) {
    try { this.onEvent(event); } catch {}
  }

  session(id) {
    let session = this.sessions.get(id);
    if (!session) { session = { history: [], busy: false, busySince: 0 }; this.sessions.set(id, session); }
    return session;
  }

  attach(ws) {
    const id = randomUUID();
    this.sessions.set(id, { history: [], busy: false, busySince: 0 });
    ws.on('message', raw => this.receive(ws, id, raw));
    ws.on('close', () => this.sessions.delete(id));
    ws.on('error', () => {});
    ws.send(JSON.stringify({ type: 'ready', session: id }));
  }

  async receive(ws, id, raw) {
    let value;
    try { value = JSON.parse(raw.toString()); } catch { return ws.send(JSON.stringify({ type: 'error', error: 'invalid_message' })); }
    if (value?.type === 'cancel') { this.controllers.get(id)?.abort(); return; }
    if (value?.type !== 'audio') return;
    const send = payload => { if (ws.readyState === 1) ws.send(JSON.stringify(payload)); };
    try {
      const result = await this.respond(id, value, {
        onTranscript: text => send({ type: 'transcript', text }),
        onReply: text => send({ type: 'reply_text', text }),
        onAudio: chunk => send({ type: 'audio_chunk', sampleRate: 24000, data: chunk.toString('base64') }),
      });
      if (result.streamed) send({ type: 'reply_end', duration_ms: result.duration_ms });
      else send({ type: 'reply', text: result.reply, audio: result.audio, mime: result.mime, duration_ms: result.duration_ms });
    } catch (error) {
      const message = error.message === 'voice_cancelled' ? 'cancelled' : error.message;
      if (message === 'cancelled') send({ type: 'reply_end', duration_ms: 0, cancelled: true });
      else send({ type: 'error', error: message === 'call_busy' ? 'call_busy' : message });
    }
  }

  async respond(id, { data, sampleRate }, hooks = {}) {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new Error('invalid_call_session');
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 48000) throw new Error('invalid_call_sample_rate');
    if (typeof data !== 'string' || !data || data.length > MAX_BYTES) throw new Error('invalid_call_audio');
    const pcm = Buffer.from(data, 'base64');
    if (!pcm.length || pcm.length % 2 || pcm.length < sampleRate * 2 * MIN_SECONDS || pcm.length > sampleRate * 2 * MAX_SECONDS) throw new Error('invalid_call_audio');
    const session = this.session(id);
    if (session.busy && this.now() - session.busySince < this.busyTimeoutMs) throw new Error('call_busy');
    session.busy = true; session.busySince = this.now();
    const controller = new AbortController();
    this.controllers.set(id, controller);
    try {
      const audioId = createHash('sha256').update(`${id}:${this.now()}:${pcm.length}`).digest('hex');
      const transcript = await this.voice.transcribeBytes(audioId, pcmToWav(pcm, sampleRate), controller.signal);
      const text = String(transcript.text ?? '').trim();
      if (!text) throw new Error('voice_not_understood');
      hooks.onTranscript?.(text);
      this.emitEvent({ eventType: 'message_received', sessionId: id, text });
      const history = session.history.slice(-this.maxHistory);
      // 豆包式流水线：文字一出就按句合成，第一句话先出声，不等整段。
      if (this.askStream && typeof this.voice.streamSynthesize === 'function') {
        let spoken = '';
        let pending = '';
        let firstAudio = true;
        try {
          for await (const delta of this.askStream({ text, history, signal: controller.signal })) {
            if (controller.signal.aborted) throw new Error('call_cancelled');
            spoken += delta;
            pending += delta;
            const parts = pending.split(/(?<=[。！？!?～~\n])/u);
            pending = parts.pop() ?? '';
            for (const sentence of parts) {
              const clean = sentence.trim();
              if (!clean) continue;
              hooks.onReply?.(spoken.replace(/\[HANGUP\]/giu, '').trim());
              await this.voice.streamSynthesize(audioId + ':' + (firstAudio ? 'a' : Date.now()), clean.replace(/\[HANGUP\]/giu, ''), controller.signal, { onPcm: chunk => hooks.onAudio?.(chunk) });
              firstAudio = false;
            }
          }
          const tail = pending.trim();
          if (tail) await this.voice.streamSynthesize(audioId + ':z', tail.replace(/\[HANGUP\]/giu, ''), controller.signal, { onPcm: chunk => hooks.onAudio?.(chunk) });
        } catch (error) {
          if (controller.signal.aborted) throw error;
          throw error;
        }
        let reply = spoken.replace(/\[HANGUP\]/giu, '').trim();
        if (!reply) throw new Error('empty_reply');
        const wantsHangup = /\[HANGUP\]/i.test(spoken);
        hooks.onReply?.(reply);
        session.history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
        session.history = session.history.slice(-this.maxHistory);
        if (wantsHangup) setTimeout(() => { try { this.onHangup?.(); } catch {} }, 1800);
        this.emitEvent({ eventType: 'message_replied', sessionId: id, text, reply });
        return { transcript: text, reply, streamed: true, pipelined: true };
      }
      let reply = String(await this.ask({ text, history })).trim();
      if (!reply) throw new Error('empty_reply');
      const wantsHangup = /\[HANGUP\]/i.test(reply);
      if (wantsHangup) reply = reply.replace(/\[HANGUP\]/giu, '').trim();
      hooks.onReply?.(reply);
      let streamed = null;
      if (typeof this.voice.streamSynthesize === 'function') {
        try { streamed = await this.voice.streamSynthesize(audioId, reply, controller.signal, { onPcm: chunk => hooks.onAudio?.(chunk) }); }
        catch (error) { if (controller.signal.aborted) throw error; streamed = null; }
      }
      session.history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
      session.history = session.history.slice(-this.maxHistory);
      if (streamed) { this.emitEvent({ eventType: 'message_replied', sessionId: id, text, reply }); return { transcript: text, reply, streamed: true, duration_ms: streamed.duration_ms }; }
      const audio = await this.voice.synthesize(audioId, reply, undefined, { silk: false });
      this.emitEvent({ eventType: 'message_replied', sessionId: id, text, reply });
      return { transcript: text, reply, streamed: false, audio: audio.file.toString('base64'), mime: 'audio/mp4', duration_ms: audio.duration_ms };
    } finally {
      this.controllers.delete(id);
      session.busy = false;
    }
  }

  close() { for (const controller of this.controllers.values()) controller.abort(); this.controllers.clear(); this.sessions.clear(); this.pending.clear(); }
}
