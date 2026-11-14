import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { LocalVoice } from '../connect/voice/local.mjs';
import { callBrain } from '../connect/call/brain.mjs';
import { SoundBridge } from '../connect/sound/bridge.mjs';

const base = resolve(import.meta.dirname, '..');
const python = process.env.DAFEIYU_PYTHON ?? resolve(base, 'runtime/voice/neural-venv/bin/python');
const script = resolve(base, 'connect/sound/audio.py');
const swift = resolve(base, 'connect/sound/audiodefault.swift');
const bin = resolve(base, 'runtime/sound/bin/audiodefault');
const statePath = resolve(base, 'runtime/sound/devices.json');
const home = resolve(base, 'runtime/dsh-home');

function ensureBinary() {
  if (existsSync(bin)) return bin;
  mkdirSync(resolve(base, 'runtime/sound/bin'), { recursive: true, mode: 0o700 });
  execFileSync('swiftc', ['-O', swift, '-o', bin], { stdio: 'inherit' });
  chmodSync(bin, 0o700);
  return bin;
}

function audioDefault(args) {
  return execFileSync(ensureBinary(), args, { encoding: 'utf8' }).trim();
}

function listDevices() {
  const text = execFileSync(python, [script, '--list'], { encoding: 'utf8' });
  const { devices } = JSON.parse(text);
  for (const device of devices) {
    console.log(`${String(device.index).padStart(2)}  ${device.name}  (in ${device.input} / out ${device.output} @ ${Math.round(device.rate)}Hz)`);
  }
}

function loadState() {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

function saveState(state) {
  mkdirSync(resolve(base, 'runtime/sound'), { recursive: true, mode: 0o700 });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(statePath, 0o600);
}

function outputCarriesBlackHole(name) {
  return /blackhole|daw/i.test(name);
}

function physicalOutput(fallback = 'STUDIO M PRO') {
  const devices = JSON.parse(execFileSync(python, [script, '--list'], { encoding: 'utf8' })).devices;
  const candidates = devices.filter((device) => device.output > 0 && !/blackhole|daw/i.test(device.name));
  return candidates.find((device) => /studio|mini|speaker/i.test(device.name))?.name ?? candidates[0]?.name ?? fallback;
}

function status() {
  const input = audioDefault(['get', 'input']);
  const output = audioDefault(['get', 'output']);
  const saved = loadState();
  console.log(`默认输入：${input}`);
  console.log(`默认输出：${output}`);
  console.log(`${/BlackHole 2ch/i.test(input) ? '✅' : '❌'} 微信麦克风来源（需要 BlackHole 2ch）`);
  console.log(`${outputCarriesBlackHole(output) ? '✅' : '❌'} 微信扬声器去向（需要含 BlackHole 16ch 的输出，如「DAW 多声道」）`);
  if (saved) console.log(`已保存的原始设置：输入 ${saved.input}，输出 ${saved.output}`);
}

function enable() {
  const previousInput = audioDefault(['get', 'input']);
  const previousOutput = audioDefault(['get', 'output']);
  const monitor = /blackhole|daw/i.test(previousOutput) ? physicalOutput() : previousOutput;
  if (!loadState()) saveState({ input: previousInput, output: previousOutput, savedAt: new Date().toISOString() });
  audioDefault(['set', 'input', 'BlackHole 2ch']);
  audioDefault(['set', 'output', 'BlackHole 16ch']);
  saveState({ ...loadState(), monitor });
  console.log('✅ 已切到声卡模式：');
  console.log('   系统输入 = BlackHole 2ch（微信麦克风 → 大肥鱼的声音）');
  console.log('   系统输出 = BlackHole 16ch（微信扬声器 → 大肥鱼听）');
  console.log(`   你自己听对方：--bridge 会把听到的声音同时放给「${monitor}」`);
  console.log('微信会跟随系统默认设备，不用改微信里的设置；建议重启一次微信让它重新取设备。');
  console.log('通话结束后运行：node scripts/sound.mjs --restore');
}

function restore() {
  const saved = loadState();
  if (!saved) {
    console.log('没有保存过原始设置，无法恢复。');
    return;
  }
  audioDefault(['set', 'input', saved.input]);
  audioDefault(['set', 'output', saved.output]);
  console.log(`✅ 已恢复：输入 ${saved.input}，输出 ${saved.output}`);
}

function makeBridge({ input, output, monitor }) {
  return new SoundBridge({
    voice: new LocalVoice({ root: resolve(base, 'runtime/voice') }),
    ask: callBrain(home),
    python,
    script,
    input,
    output,
    monitor,
    log: (line) => console.log(line),
    onStatus: (value) => {
      if (['thinking', 'speaking', 'interrupted', 'error'].includes(value.state)) {
        console.log(`[${value.state}]${value.text ? ` ${value.text}` : ''}${value.message ? ` ${value.message}` : ''}`);
      }
    },
  });
}

function usage() {
  console.log(`用法：
  node scripts/sound.mjs --status            查看系统默认输入/输出与就绪状态
  node scripts/sound.mjs --enable            切到声卡模式（输入→BlackHole 2ch；输出保持含 BlackHole 16ch）
  node scripts/sound.mjs --restore           恢复切换前的默认设备
  node scripts/sound.mjs --list              列出音频设备
  node scripts/sound.mjs --say "文本"        把合成语音注入 BlackHole 2ch
  node scripts/sound.mjs --bridge            开始监听并自动应答（Ctrl+C 结束）

微信 macOS 版不提供音频设备选择，所以走系统默认设备：
  麦克风 = 系统默认输入 → 切到 BlackHole 2ch
  扬声器 = 系统默认输出 → 保持「DAW 多声道」这类含 BlackHole 16ch 的设备`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--list')) return listDevices();
  if (args.includes('--status') || args.includes('--check')) return status();
  if (args.includes('--enable')) return enable();
  if (args.includes('--restore')) return restore();
  if (args.includes('--say')) {
    const text = args[args.indexOf('--say') + 1];
    if (!text) throw new Error('缺少测试文本');
    const bridge = makeBridge({ input: '', output: process.env.SOUND_OUTPUT ?? 'BlackHole 2ch', monitor: '' });
    bridge.start();
    try {
      const result = await bridge.say(text);
      const waitMs = (result?.duration_ms ?? 3000) + 900;
      await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
    } finally {
      await bridge.stop();
    }
    return console.log('已注入 BlackHole 2ch。');
  }
  if (args.includes('--bridge')) {
    const saved = loadState();
    const monitor = process.env.SOUND_MONITOR ?? saved?.monitor ?? '';
    const bridge = makeBridge({
      input: process.env.SOUND_INPUT ?? 'BlackHole 16ch',
      output: process.env.SOUND_OUTPUT ?? 'BlackHole 2ch',
      monitor,
    });
    bridge.start();
    console.log(`音频桥已启动（监听 ${bridge.input} → 回复写入 ${bridge.output}${monitor ? `，同时监听到 ${monitor}` : ''}）。Ctrl+C 结束。`);
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
