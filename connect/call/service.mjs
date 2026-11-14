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
  constructor({ voice, ask, log = () => {}, now = () => Date.now(), maxHistory = 16, busyTimeoutMs = 30000 }) {
    Object.assign(this, { voice, ask, log, now, maxHistory, busyTimeoutMs });
    this.sessions = new Map();
    this.pending = new Map();
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
    if (value?.type !== 'audio') return;
    const send = payload => { if (ws.readyState === 1) ws.send(JSON.stringify(payload)); };
    try {
      const result = await this.respond(id, value, {
        onTranscript: text => send({ type: 'transcript', text }),
        onReply: text => send({ type: 'reply_text', text }),
      });
      send({ type: 'reply', text: result.reply, audio: result.audio, mime: result.mime, duration_ms: result.duration_ms });
    } catch (error) {
      send({ type: 'error', error: error.message === 'call_busy' ? 'call_busy' : error.message });
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
    try {
      const audioId = createHash('sha256').update(`${id}:${this.now()}:${pcm.length}`).digest('hex');
      const transcript = await this.voice.transcribeBytes(audioId, pcmToWav(pcm, sampleRate));
      const text = String(transcript.text ?? '').trim();
      if (!text) throw new Error('voice_not_understood');
      hooks.onTranscript?.(text);
      const reply = String(await this.ask({ text, history: session.history.slice(-this.maxHistory) })).trim();
      if (!reply) throw new Error('empty_reply');
      hooks.onReply?.(reply);
      const audio = await this.voice.synthesize(audioId, reply, undefined, { silk: false });
      session.history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
      session.history = session.history.slice(-this.maxHistory);
      return { transcript: text, reply, audio: audio.file.toString('base64'), mime: 'audio/mp4', duration_ms: audio.duration_ms };
    } finally {
      session.busy = false;
    }
  }

  close() { this.sessions.clear(); this.pending.clear(); }
}
