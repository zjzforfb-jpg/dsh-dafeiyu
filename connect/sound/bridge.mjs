import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createVad } from './vad.mjs';

/** Normalize quiet network audio before ASR (WeChat downlink can sit near -60 dBFS). */
function normalizePcm(pcm, target = 0.7) {
  let peak = 0;
  for (let i = 0; i < pcm.length; i += 2) {
    const value = Math.abs(pcm.readInt16LE(i)) / 32768;
    if (value > peak) peak = value;
  }
  if (peak < 0.0005 || peak >= target) return pcm;
  const gain = Math.min(20, target / peak);
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i += 2) {
    const value = Math.max(-32768, Math.min(32767, Math.round(pcm.readInt16LE(i) * gain)));
    out.writeInt16LE(value, i);
  }
  return out;
}
import { pcmToWav } from '../call/service.mjs';

const SCRIPT = join(import.meta.dirname, 'audio.py');

/**
 * Sound-card bridge: captures a virtual input device (WeChat's speaker routed to
 * BlackHole 16ch), turns utterances into whisper text, asks the brain, and streams
 * MiniMax PCM back into a virtual output device (WeChat's microphone = BlackHole 2ch).
 * Half-duplex with barge-in: when爸爸 starts talking the current reply is cancelled.
 */
export class SoundBridge {
  constructor({
    voice,
    ask,
    python = 'python3',
    script = SCRIPT,
    input = 'BlackHole 16ch',
    output = 'BlackHole 2ch',
    monitor = '',
    log = () => {},
    onStatus = () => {},
  } = {}) {
    Object.assign(this, { voice, ask, python, script, input, output, monitor, log, onStatus });
    this.queue = [];
    this.busy = false;
    this.speaking = false;
    this.controller = null;
    this.child = null;
    this.history = [];
  }

  start() {
    const args = [this.script];
    if (this.input) args.push('--input', this.input);
    else args.push('--input', '');
    if (this.output) args.push('--output', this.output);
    if (this.monitor) args.push('--monitor', this.monitor);
    this.child = spawn(this.python, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.on('exit', (code) => {
      this.log(`音频桥退出（code ${code ?? 'null'}）`);
      this.onStatus({ state: 'stopped', code });
    });
    this.child.stderr.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        const value = line.trim();
        if (!value) continue;
        try {
          const status = JSON.parse(value);
          this.onStatus(status);
          if (status.event === 'error') this.log(`音频桥错误：${status.message}`);
        } catch {
          this.log(value);
        }
      }
    });
    this.vad = createVad({
      threshold: Number(process.env.SOUND_VAD_THRESHOLD ?? '') || undefined,
      adaptive: process.env.SOUND_VAD_ADAPTIVE !== '0',
      floorMin: Number(process.env.SOUND_VAD_FLOOR ?? '') || undefined,
      onUtterance: (pcm) => this.#enqueue(pcm),
      onSpeechStart: () => {
        if (this.speaking) this.#cancel();
      },
    });
    this.child.stdin.on('error', () => {});
    const threshold = Number(process.env.SOUND_VAD_THRESHOLD ?? '') || undefined;
    const levelLog = process.env.SOUND_LEVEL_LOG === '1';
    let levelSum = 0;
    let levelSamples = 0;
    let levelAt = Date.now();
    this.child.stdout.on('data', (chunk) => {
      if (levelLog) {
        let sum = 0;
        for (let i = 0; i < chunk.length; i += 2) {
          const value = chunk.readInt16LE(i) / 32768;
          sum += value * value;
        }
        levelSum += sum;
        levelSamples += chunk.length / 2;
        if (Date.now() - levelAt >= 1000) {
          const rms = Math.sqrt(levelSum / Math.max(1, levelSamples));
          this.log(`[level] ${rms.toFixed(4)}${rms > (threshold ?? 0.015) ? '  (above threshold)' : ''}`);
          levelSum = 0;
          levelSamples = 0;
          levelAt = Date.now();
        }
      }
      this.vad?.push(chunk);
    });
    this.onStatus({ state: 'running', input: this.input, output: this.output });
    return this;
  }

  #cancel() {
    const wasSpeaking = this.speaking;
    if (this.controller) this.controller.abort();
    this.speaking = false;
    if (wasSpeaking) this.onStatus({ state: 'interrupted' });
  }

  #enqueue(pcm) {
    this.queue.push(pcm);
    void this.#drain();
  }

  async #drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const pcm = this.queue.shift();
        await this.#respond(pcm);
      }
    } finally {
      this.busy = false;
    }
  }

  async #respond(pcm) {
    const controller = new AbortController();
    this.controller = controller;
    const id = createHash('sha256').update(pcm).digest('hex');
    try {
      const wav = pcmToWav(normalizePcm(pcm), 16000);
      const result = await this.voice.transcribeBytes(id, wav, controller.signal);
      if (!result.text) return;
      this.log(`爸爸说：${result.text}`);
      // 通话里说「挂了/挂断」：直接点 QQ/微信 通话窗口的挂断键，不再走模型。
      if (/(挂断|挂电话|挂了|结束通话|hang\s*up)/iu.test(result.text)) {
        try {
          const { ensureBinaries } = await import('../macui/index.mjs');
          const { hangup } = await import('../macui/qq.mjs');
          const bins = ensureBinaries(process.cwd());
          const done = await hangup(bins);
          this.log(done ? '已挂断 QQ 通话。' : '没找到 QQ 通话窗口。');
        } catch (error) { this.log(`挂断失败：${error.message}`); }
        return;
      }
      this.onStatus({ state: 'thinking', text: result.text });
      const reply = await this.ask({ text: result.text, history: this.history.slice(-8), signal: controller.signal });
      if (!reply) return;
      this.log(`大肥鱼：${reply}`);
      this.history.push({ role: 'user', content: result.text }, { role: 'assistant', content: reply });
      this.speaking = true;
      this.onStatus({ state: 'speaking', text: reply });
      await this.voice.streamSynthesize(id, reply, controller.signal, {
        onPcm: (chunk) => this.#play(chunk),
      });
    } catch (error) {
      if (!/voice_cancelled|aborted/i.test(error?.message ?? '')) {
        this.log(`这一轮出错：${error?.message ?? error}`);
        this.onStatus({ state: 'error', message: error?.message ?? String(error) });
      }
    } finally {
      this.speaking = false;
      this.controller = null;
    }
  }

  /** Directly speak text into the target device (used for testing the injection path). */
  async say(text) {
    const id = createHash('sha256').update(`say:${Date.now()}:${text}`).digest('hex');
    const controller = new AbortController();
    this.speaking = true;
    this.onStatus({ state: 'speaking', text });
    try {
      return await this.voice.streamSynthesize(id, text, controller.signal, {
        onPcm: (chunk) => this.#play(chunk),
      });
    } finally {
      this.speaking = false;
    }
  }

  #play(chunk) {
    if (this.stopping || !this.child?.stdin?.writable) return;
    try {
      this.child.stdin.write(chunk);
    } catch {
      /* device closed while streaming */
    }
  }

  async stop() {
    this.stopping = true;
    this.#cancel();
    const child = this.child;
    this.child = null;
    if (child) {
      const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
      try {
        child.stdin.end();
      } catch {
        /* already closed */
      }
      const timeout = new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5000));
      await Promise.race([exited, timeout]);
      if (child.exitCode === null) child.kill('SIGTERM');
    }
    this.onStatus({ state: 'stopped' });
  }
}
