import test from 'node:test';
import assert from 'node:assert/strict';
import { createVad } from '../connect/sound/vad.mjs';

const RATE = 16000;
const FRAME = RATE / 50; // 20ms

function tone(frames, amps = 0.3) {
  const buffer = Buffer.alloc(frames * FRAME * 2);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let i = 0; i < FRAME; i += 1) {
      const value = Math.round(Math.sin((2 * Math.PI * 220 * (frame * FRAME + i)) / RATE) * amps * 32767);
      buffer.writeInt16LE(value, (frame * FRAME + i) * 2);
    }
  }
  return buffer;
}

function silence(frames) {
  return Buffer.alloc(frames * FRAME * 2);
}

test('silence never produces an utterance', () => {
  const heard = [];
  const vad = createVad({ onUtterance: (pcm) => heard.push(pcm) });
  vad.push(silence(100));
  assert.equal(heard.length, 0);
});

test('a short blip is ignored', () => {
  const heard = [];
  const vad = createVad({ onUtterance: (pcm) => heard.push(pcm) });
  vad.push(tone(5)); // 100ms < 350ms minimum
  vad.push(silence(60));
  assert.equal(heard.length, 0);
});

test('speech followed by silence emits one utterance', () => {
  const heard = [];
  const vad = createVad({ onUtterance: (pcm) => heard.push(pcm) });
  vad.push(tone(50)); // 1s speech
  vad.push(silence(40)); // 800ms > 700ms silence
  assert.equal(heard.length, 1);
  const durationSec = heard[0].length / 2 / RATE;
  assert.ok(durationSec >= 1 && durationSec <= 2.2, `duration ${durationSec}`);
});

test('speech start fires for barge-in', () => {
  let starts = 0;
  const vad = createVad({ onSpeechStart: () => (starts += 1) });
  vad.push(tone(10));
  vad.push(silence(60));
  vad.push(tone(10));
  vad.push(silence(60));
  assert.equal(starts, 2);
});

test('continuous speech is capped at the maximum utterance length', () => {
  const heard = [];
  const vad = createVad({ onUtterance: (pcm) => heard.push(pcm) });
  vad.push(tone(400)); // 8s
  vad.push(tone(400)); // 8s more → crosses 12s cap
  assert.ok(heard.length >= 1, 'max length should flush');
  const seconds = heard[0].length / 2 / RATE;
  assert.ok(seconds >= 11 && seconds <= 12.6, `duration ${seconds}`);
});

test('frames split across chunks are reassembled', () => {
  const heard = [];
  const vad = createVad({ onUtterance: (pcm) => heard.push(pcm) });
  const speech = tone(50);
  for (let offset = 0; offset < speech.length; offset += 333) {
    vad.push(speech.subarray(offset, Math.min(speech.length, offset + 333)));
  }
  vad.push(silence(40));
  assert.equal(heard.length, 1);
});
