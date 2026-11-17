import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { CallService, pcmToWav } from '../connect/call/service.mjs';
import { startConnect } from '../connect/server.mjs';

const SESSION = '11111111-2222-3333-4444-555555555555';
const pcm = (seconds = 1, sampleRate = 16000) => Buffer.alloc(sampleRate * 2 * seconds, 1);
const fakeVoice = overrides => ({
  transcribeBytes: async (_id, wav) => { assert.equal(wav.subarray(0, 4).toString(), 'RIFF'); return { text: '爸爸你好', source: 'local_whisper_cpp' }; },
  synthesize: async () => ({ duration_ms: 900, silk: Buffer.from('silk'), file: Buffer.from('m4a-bytes') }),
  status: () => ({ provider: 'test' }),
  ...overrides,
});

test('call audio is wrapped as a valid WAV with the declared sample rate', () => {
  const wav = pcmToWav(pcm(0.5, 16000), 16000);
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString(), 'WAVE');
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(40), 16000 * 2 * 0.5);
  assert.equal(wav.length, 44 + 16000 * 2 * 0.5);
});

test('call service transcribes, replies and returns base64 audio while keeping history', async () => {
  const asked = [];
  const calls = new CallService({ voice: fakeVoice(), ask: async ({ text, history }) => { asked.push({ text, history: [...history] }); return '我在呢'; } });
  const early = [];
  const first = await calls.respond(SESSION, { data: pcm(1).toString('base64'), sampleRate: 16000 }, { onTranscript: text => early.push(['transcript', text]), onReply: text => early.push(['reply', text]) });
  assert.deepEqual(early, [['transcript', '爸爸你好'], ['reply', '我在呢']]);
  assert.equal(first.transcript, '爸爸你好');
  assert.equal(first.reply, '我在呢');
  assert.equal(first.mime, 'audio/mp4');
  assert.equal(Buffer.from(first.audio, 'base64').toString(), 'm4a-bytes');
  assert.equal(asked[0].history.length, 0);
  const second = await calls.respond(SESSION, { data: pcm(1).toString('base64'), sampleRate: 16000 });
  assert.equal(second.reply, '我在呢');
  assert.deepEqual(asked[1].history, [{ role: 'user', content: '爸爸你好' }, { role: 'assistant', content: '我在呢' }]);
});

test('call turn emits message_received and message_replied into the event stream', async () => {
  const events = [];
  const calls = new CallService({ voice: fakeVoice(), ask: async () => '我在呢', onEvent: e => events.push(e) });
  await calls.respond(SESSION, { data: pcm(1).toString('base64'), sampleRate: 16000 });
  assert.equal(events[0].eventType, 'message_received');
  assert.equal(events[0].text, '爸爸你好');
  assert.equal(events[0].sessionId, SESSION);
  assert.equal(events[1].eventType, 'message_replied');
  assert.equal(events[1].reply, '我在呢');
  assert.equal(events[1].sessionId, SESSION);
  // 事件记录失败绝不影响通话：坏 onEvent 也不该抛。
  const safe = new CallService({ voice: fakeVoice(), ask: async () => '在', onEvent: () => { throw new Error('listener_boom'); } });
  const r = await safe.respond(SESSION, { data: pcm(1).toString('base64'), sampleRate: 16000 });
  assert.equal(r.reply, '在');
});

test('call service streams reply audio chunks when the voice supports it', async () => {
  const sent = [];
  const voice = fakeVoice({
    streamSynthesize: async (_id, text, signal, { onPcm }) => { onPcm(Buffer.from([1, 2])); onPcm(Buffer.from([3, 4])); return { duration_ms: 42, bytes: 4, sampleRate: 24000 }; },
  });
  const calls = new CallService({ voice, ask: async () => '好的' });
  const result = await calls.respond(SESSION, { data: pcm(1).toString('base64'), sampleRate: 16000 }, { onAudio: chunk => sent.push(chunk) });
  assert.equal(result.streamed, true);
  assert.equal(result.duration_ms, 42);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].toString('hex'), '0102');
});

test('call service can cancel an in-flight streaming reply', async () => {
  const voice = fakeVoice({ streamSynthesize: async (_id, text, signal) => { await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('voice_cancelled')))); } });
  const calls = new CallService({ voice, ask: async () => '好的' });
  const inFlight = calls.respond(SESSION, { data: pcm(1).toString('base64'), sampleRate: 16000 });
  await new Promise(resolve => setTimeout(resolve, 10));
  calls.controllers.get(SESSION)?.abort();
  assert.equal(await inFlight.catch(error => error.message), 'voice_cancelled');
});

test('call service rejects malformed audio and refuses a second turn while busy', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = new CallService({ voice: fakeVoice({ transcribeBytes: async () => { await gate; return { text: '嗯' }; } }), ask: async () => '好的' });
  assert.equal((await calls.respond(SESSION, { data: pcm(0.1).toString('base64'), sampleRate: 16000 }).catch(error => error.message)), 'invalid_call_audio');
  assert.equal((await calls.respond(SESSION, { data: pcm(1).toString('base64'), sampleRate: 100 }).catch(error => error.message)), 'invalid_call_sample_rate');
  assert.equal((await calls.respond(SESSION, { data: pcm(16).toString('base64'), sampleRate: 16000 }).catch(error => error.message)), 'invalid_call_audio');
  assert.equal((await calls.respond('bad-session', { data: pcm(1).toString('base64'), sampleRate: 16000 }).catch(error => error.message)), 'invalid_call_session');
  const inFlight = calls.respond(SESSION, { data: pcm(1).toString('base64'), sampleRate: 16000 });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await calls.respond(SESSION, { data: pcm(1).toString('base64'), sampleRate: 16000 }).catch(error => error.message)), 'call_busy');
  release();
  assert.equal((await inFlight).reply, '好的');
});

test('call page is served and the call socket requires the admin token', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dafeiyu-call-'));
  const config = { adminToken: 'admin', devices: {} };
  const service = await startConnect({ root, port: 0, config, qq: false });
  const base = `http://127.0.0.1:${service.port}`;
  let socket;
  try {
    const page = await fetch(`${base}/call`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /大肥鱼/);
    const denied = new WebSocket(base.replace('http', 'ws') + '/call/ws?token=wrong');
    await new Promise(resolve => denied.once('error', resolve));
    socket = new WebSocket(base.replace('http', 'ws') + '/call/ws?token=admin');
    const firstMessage = once(socket, 'message');
    await once(socket, 'open');
    const [raw] = await firstMessage;
    const ready = JSON.parse(raw.toString());
    assert.equal(ready.type, 'ready');
    assert.match(ready.session, /^[0-9a-f-]{36}$/);
  } finally { socket?.terminate(); await service.close(); rmSync(root, { recursive: true, force: true }); }
});
