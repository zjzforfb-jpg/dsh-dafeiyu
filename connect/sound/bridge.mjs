import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createVad } from './vad.mjs';
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
    log = () => {},
    onStatus = () => {},
  } = {}) {
    Object.assign(this, { voice, ask, python, script, input, output, log, onStatus });
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
      onUtterance: (pcm) => this.#enqueue(pcm),
      onSpeechStart: () => {
        if (this.speaking) this.#cancel();
      },
    });
    this.child.stdin.on('error', () => {});
    this.child.stdout.on('data', (chunk) => this.vad?.push(chunk));
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
      const wav = pcmToWav(pcm, 16000);
      const result = await this.voice.transcribeBytes(id, wav, controller.signal);
      if (!result.text) return;
      this.log(`爸爸说：${result.text}`);
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
      await this.voice.streamSynthesize(id, text, controller.signal, {
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
    if (this.child) {
      this.child.stdin.end();
      this.child.kill('SIGTERM');
      this.child = null;
    }
    this.onStatus({ state: 'stopped' });
  }
}
