import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { LocalVoice } from '../connect/voice/local.mjs';
import { callBrain } from '../connect/call/brain.mjs';
import { SoundBridge } from '../connect/sound/bridge.mjs';

const base = resolve(import.meta.dirname, '..');
const python = process.env.DAFEIYU_PYTHON ?? resolve(base, 'runtime/voice/neural-venv/bin/python');
const script = resolve(base, 'connect/sound/audio.py');
const home = resolve(base, 'runtime/dsh-home');

function listDevices() {
  const text = execFileSync(python, [script, '--list'], { encoding: 'utf8' });
  const { devices } = JSON.parse(text);
  for (const device of devices) {
    console.log(`${String(device.index).padStart(2)}  ${device.name}  (in ${device.input} / out ${device.output} @ ${Math.round(device.rate)}Hz)`);
  }
}

function makeVoice() {
  return new LocalVoice({ root: resolve(base, 'runtime/voice') });
}

function makeBridge({ input, output }) {
  return new SoundBridge({
    voice: makeVoice(),
    ask: callBrain(home),
    python,
    script,
    input,
    output,
    log: (line) => console.log(line),
    onStatus: (status) => {
      if (status.state === 'thinking' || status.state === 'speaking' || status.state === 'interrupted' || status.state === 'error') {
        console.log(`[${status.state}]${status.text ? ` ${status.text}` : ''}${status.message ? ` ${status.message}` : ''}`);
      }
    },
  });
}

function usage() {
  console.log(`用法：
  node scripts/sound.mjs --list              列出可用的音频设备
  node scripts/sound.mjs --check             检查虚拟声卡链路是否就绪
  node scripts/sound.mjs --say "文本"        把合成语音注入 BlackHole 2ch（测试注入）
  node scripts/sound.mjs --bridge            开始监听 BlackHole 16ch 并自动应答

微信设置（语音通话时）：
  扬声器/输出 → BlackHole 16ch（大肥鱼听你说话）
  麦克风/输入 → BlackHole 2ch（大肥鱼说话，你也能听到自己的声音）
监听：在「音频 MIDI 设置」里建多输出设备（BlackHole 16ch + Mac mini 扬声器）作为系统输出。`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--list')) return listDevices();
  if (args.includes('--check')) {
    const devices = JSON.parse(execFileSync(python, [script, '--list'], { encoding: 'utf8' })).devices;
    for (const name of ['BlackHole 16ch', 'BlackHole 2ch']) {
      const device = devices.find((item) => item.name === name);
      console.log(`${device ? '✅' : '❌'} ${name}${device ? `  (in ${device.input} / out ${device.output})` : ' 未找到'}`);
    }
    const voice = makeVoice();
    console.log(`语音合成：${voice.status().tts}`);
    console.log(`转写模型：${voice.status().asr}`);
    return usage();
  }
  if (args.includes('--say')) {
    const text = args[args.indexOf('--say') + 1];
    if (!text) throw new Error('缺少测试文本');
    const bridge = makeBridge({ input: '', output: process.env.SOUND_OUTPUT ?? 'BlackHole 2ch' });
    bridge.start();
    try {
      await bridge.say(text);
      await new Promise((resolveWait) => setTimeout(resolveWait, 800));
    } finally {
      await bridge.stop();
    }
    return console.log('已注入 BlackHole 2ch。');
  }
  if (args.includes('--bridge')) {
    const bridge = makeBridge({
      input: process.env.SOUND_INPUT ?? 'BlackHole 16ch',
      output: process.env.SOUND_OUTPUT ?? 'BlackHole 2ch',
    });
    bridge.start();
    console.log('音频桥已启动。对着微信说话即可；Ctrl+C 结束。');
    const shutdown = async () => {
      await bridge.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return new Promise(() => {});
  }
  return usage();
}

main().catch((error) => {
  console.error(`失败：${error.message}`);
  process.exit(1);
});
