import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { LocalVoice } from '../connect/voice/local.mjs';
import { callBrain } from '../connect/call/brain.mjs';
import { SoundBridge } from '../connect/sound/bridge.mjs';
import { watchCalls } from '../connect/sound/callmode.mjs';
import { sendWechatMessage } from '../device/wechat.mjs';

const base = resolve(import.meta.dirname, '..');
const python = process.env.DAFEIYU_PYTHON ?? resolve(base, 'runtime/voice/neural-venv/bin/python');
const script = resolve(base, 'connect/sound/audio.py');
const swift = resolve(base, 'connect/sound/audiodefault.swift');
const bin = resolve(base, 'runtime/sound/bin/audiodefault');
const callWatchSwift = resolve(base, 'connect/sound/callwatch.swift');
const callWatchBin = resolve(base, 'runtime/sound/bin/callwatch');
const statePath = resolve(base, 'runtime/sound/devices.json');
const contactPath = resolve(base, 'runtime/sound/contacts.json');
const home = resolve(base, 'runtime/dsh-home');

function ensureBinary() {
  if (existsSync(bin)) return bin;
  mkdirSync(resolve(base, 'runtime/sound/bin'), { recursive: true, mode: 0o700 });
  execFileSync('swiftc', ['-O', swift, '-o', bin], { stdio: 'inherit' });
  chmodSync(bin, 0o700);
  return bin;
}

function ensureCallWatch() {
  if (existsSync(callWatchBin)) return callWatchBin;
  mkdirSync(resolve(base, 'runtime/sound/bin'), { recursive: true, mode: 0o700 });
  execFileSync('swiftc', ['-O', callWatchSwift, '-o', callWatchBin], { stdio: 'inherit' });
  chmodSync(callWatchBin, 0o700);
  return callWatchBin;
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

function loadContacts() {
  try {
    return JSON.parse(readFileSync(contactPath, 'utf8'));
  } catch {
    return {};
  }
}

function saveContacts(contacts) {
  mkdirSync(resolve(base, 'runtime/sound'), { recursive: true, mode: 0o700 });
  writeFileSync(contactPath, `${JSON.stringify(contacts, null, 2)}\n`, { mode: 0o600 });
  chmodSync(contactPath, 0o600);
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
  const contacts = loadContacts();
  console.log(`默认输入：${input}`);
  console.log(`默认输出：${output}`);
  console.log(`${/BlackHole 2ch/i.test(input) ? '✅' : '❌'} 麦克风方向（系统输入需要 BlackHole 2ch）`);
  console.log(`${/^BlackHole 16ch$/i.test(output) ? '✅' : '⚠️'} 扬声器方向（需要 BlackHole 16ch；DAW 多声道采不到）`);
  if (saved) console.log(`已保存的原始设置：输入 ${saved.input}，输出 ${saved.output}`);
  console.log(`通话联系人：微信 ${contacts.wechat ?? '未指定'}，QQ ${contacts.qq ?? '未指定'}`);
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
  console.log('通话时微信里把「麦克风」选 BlackHole 2ch、「扬声器」选 BlackHole 16ch；改过系统设备后建议重启微信。');
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
  node scripts/sound.mjs --status            查看设备与通话联系人
  node scripts/sound.mjs --enable            切到声卡模式（输入→BlackHole 2ch；输出→BlackHole 16ch）
  node scripts/sound.mjs --restore           恢复切换前的默认设备
  node scripts/sound.mjs --list              列出音频设备
  node scripts/sound.mjs --say "文本"        把合成语音注入 BlackHole 2ch
  node scripts/sound.mjs --bridge            只起音频桥（手动开）
  node scripts/sound.mjs --call              一键通话模式：切设备 + 起桥，通话结束自动恢复
  node scripts/sound.mjs --watch             待机守护：检测到微信/QQ 通话窗口自动进入通话模式
  node scripts/sound.mjs --invite [联系人]  让大肥鱼发微信"给我打个电话"（走手机 ADB）
  node scripts/sound.mjs --contacts wechat=爸爸 qq=爸爸   记住以后呼叫谁

通话时微信里的设置（每通电话独立）：
  麦克风 = BlackHole 2ch
  扬声器 = BlackHole 16ch（不要选 DAW 多声道，2 路输出采不到）`);
}

async function callMode({ startNow = false, oneShot = false } = {}) {
  const callWatch = ensureCallWatch();
  let bridge = null;
  let enabled = false;

  const enter = () => {
    if (bridge) return;
    enable();
    enabled = true;
    const saved = loadState();
    const monitor = process.env.SOUND_MONITOR ?? saved?.monitor ?? '';
    bridge = makeBridge({
      input: process.env.SOUND_INPUT ?? 'BlackHole 16ch',
      output: process.env.SOUND_OUTPUT ?? 'BlackHole 2ch',
      monitor,
    });
    bridge.start();
    console.log(`▶ 通话模式已进入（监听 ${bridge.input}，回复写入 ${bridge.output}${monitor ? `，监听转放 ${monitor}` : ''}）`);
  };

  const leave = async () => {
    if (!bridge) return;
    await bridge.stop();
    bridge = null;
    if (enabled) restore();
    enabled = false;
  };

  const watcher = watchCalls({
    bin: callWatch,
    log: (line) => console.log(`[watch] ${line}`),
    onStart: enter,
    onEnd: async () => {
      await leave();
      if (oneShot) {
        watcher.stop();
        console.log('通话结束，已退出通话模式并恢复系统设备。');
        process.exit(0);
      }
    },
  });

  const shutdown = async () => {
    watcher.stop();
    await leave();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (startNow) {
    enter();
    console.log('通话窗口消失后会自动退出并恢复设备；Ctrl+C 也可随时结束。');
  } else {
    console.log('待机守护中：拨通微信/QQ 语音或视频通话时自动进入通话模式。Ctrl+C 结束。');
  }
  return new Promise(() => {});
}

async function invite(contactArg) {
  const contacts = loadContacts();
  const contact = contactArg ?? contacts.wechat;
  if (!contact) {
    console.error('还没有指定微信联系人：先运行 `node scripts/sound.mjs --contacts wechat=爸爸`，或 `--invite 爸爸`');
    process.exit(2);
  }
  const config = JSON.parse(readFileSync(resolve(base, 'config', 'wechat.json'), 'utf8'));
  const message = process.env.SOUND_INVITE
    ?? '爸爸，我在呢～方便的时候给我打个微信语音电话呀，我想听听你的声音 🐟';
  const result = await sendWechatMessage({
    contact,
    message,
    config,
    dryRun: process.env.SOUND_INVITE_DRY === '1',
    outputDir: resolve(base, 'runtime', 'device', 'wechat'),
  });
  console.log(`${result.sent ? '已发出通话邀请' : '演练（未发送）'} → ${contact}：${message}`);
}

function setContacts(pairs) {
  if (!pairs.length) {
    const contacts = loadContacts();
    console.log(`当前：微信 ${contacts.wechat ?? '未指定'}，QQ ${contacts.qq ?? '未指定'}`);
    return;
  }
  const contacts = { ...loadContacts() };
  for (const pair of pairs) {
    const [key, ...rest] = pair.split('=');
    if (!['wechat', 'qq'].includes(key) || !rest.join('=')) {
      console.error(`无法解析：${pair}（格式：wechat=爸爸）`);
      process.exit(2);
    }
    contacts[key] = rest.join('=');
  }
  saveContacts(contacts);
  console.log(`已记住：微信 ${contacts.wechat ?? '未指定'}，QQ ${contacts.qq ?? '未指定'}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--list')) return listDevices();
  if (args.includes('--status') || args.includes('--check')) return status();
  if (args.includes('--enable')) return enable();
  if (args.includes('--restore')) return restore();
  if (args.includes('--call')) return callMode({ startNow: true, oneShot: true });
  if (args.includes('--watch')) return callMode({ startNow: false });
  if (args.includes('--invite')) {
    const index = args.indexOf('--invite');
    const contact = args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : undefined;
    return invite(contact);
  }
  if (args.includes('--contacts')) {
    const start = args.indexOf('--contacts') + 1;
    return setContacts(args.slice(start).filter((value) => !value.startsWith('--')));
  }
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
