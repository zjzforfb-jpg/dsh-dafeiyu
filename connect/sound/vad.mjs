const DEFAULT_FRAME_MS = 20;

function frameRms(pcm) {
  let sum = 0;
  const samples = pcm.length / 2;
  for (let i = 0; i < pcm.length; i += 2) {
    const value = pcm.readInt16LE(i) / 32768;
    sum += value * value;
  }
  return Math.sqrt(sum / Math.max(1, samples));
}

/**
 * Energy VAD over mono PCM16 frames. Emits one PCM16 buffer per utterance.
 * onSpeechStart fires as soon as speech is detected (used for barge-in).
 */
export function createVad({
  sampleRate = 16000,
  frameMs = DEFAULT_FRAME_MS,
  threshold = 0.015,
  silenceMs = 700,
  minMs = 350,
  maxMs = 12000,
  onUtterance = () => {},
  onSpeechStart = () => {},
} = {}) {
  const frameSamples = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const frameBytes = frameSamples * 2;
  const silenceFrames = Math.max(1, Math.round(silenceMs / frameMs));
  const minFrames = Math.max(1, Math.round(minMs / frameMs));
  const maxFrames = Math.max(minFrames + 1, Math.round(maxMs / frameMs));
  let rest = Buffer.alloc(0);
  let frames = [];
  let voiced = 0;
  let silentRun = 0;
  let speaking = false;

  function flush() {
    if (!frames.length) {
      speaking = false;
      silentRun = 0;
      voiced = 0;
      return;
    }
    const pcm = Buffer.concat(frames);
    const longEnough = voiced >= minFrames;
    frames = [];
    speaking = false;
    silentRun = 0;
    voiced = 0;
    if (longEnough) onUtterance(pcm);
  }

  function pushFrame(frame) {
    const rms = frameRms(frame);
    if (rms > threshold) {
      if (!speaking) {
        speaking = true;
        frames = [];
        voiced = 0;
        onSpeechStart();
      }
      silentRun = 0;
      voiced += 1;
      frames.push(frame);
      if (frames.length >= maxFrames) flush();
      return;
    }
    if (!speaking) return;
    frames.push(frame);
    silentRun += 1;
    if (silentRun >= silenceFrames) flush();
  }

  return {
    push(chunk) {
      rest = rest.length ? Buffer.concat([rest, chunk]) : chunk;
      let offset = 0;
      while (rest.length - offset >= frameBytes) {
        pushFrame(rest.subarray(offset, offset + frameBytes));
        offset += frameBytes;
      }
      rest = offset ? rest.subarray(offset) : rest;
    },
    flush,
    get speaking() {
      return speaking;
    },
  };
}
