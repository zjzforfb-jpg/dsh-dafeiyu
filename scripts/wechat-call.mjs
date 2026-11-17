#!/usr/bin/env node
/**
 * 用桌面微信给联系人打语音电话，并让声卡桥接入（大肥鱼能听能说）。
 *   node scripts/wechat-call.mjs [--contact 敢敢不憨了] [--keep]
 */
import { spawn, execFileSync } from 'node:child_process';
import { openChat, startVoiceCall, findCallWindow } from '../connect/macui/wechat.mjs';
import { ensureBinaries, listWindows } from '../connect/macui/index.mjs';

const root = process.cwd();
const args = process.argv.slice(2);
const option = (name, fallback = '') => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
};
const has = (name) => args.includes(`--${name}`);
const contact = option('contact', process.env.WECHAT_CONTACT ?? '敢敢不憨了');

function runSound(flag) {
  try { execFileSync('node', ['scripts/sound.mjs', flag], { cwd: root, stdio: 'ignore' }); } catch {}
}

function startBridge() {
  const child = spawn('node', ['scripts/sound.mjs', '--bridge'], {
    cwd: root,
    env: { ...process.env, SOUND_VAD_ADAPTIVE: '1', SOUND_VAD_FLOOR: process.env.SOUND_VAD_FLOOR ?? '0.0012' },
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  return child.pid;
}

// --probe：只回答「能不能拨」——微信窗口在不在、联系人叫什么，绝不拨号
if (has('probe')) {
  const bins = ensureBinaries(root);
  // 微信的 owner 名有两种拼法（中文「微信」/英文「WeChat」），两个都探
  const windows = [...listWindows(bins, '微信'), ...listWindows(bins, 'WeChat')];
  console.log(JSON.stringify({
    ok: windows.length > 0,
    contact,
    windows: windows.map((w) => ({ name: w.name, width: w.width, height: w.height })),
    note: '探针：不拨号、不动声卡',
  }, null, 1));
  process.exit(0);
}

runSound('--enable');
const bridgePid = startBridge();
console.log(`声卡桥已启动（pid ${bridgePid}）。`);
try {
  await openChat(root, contact);
  const call = await startVoiceCall(root);
  console.log(`☎ 正在呼叫「${contact}」（窗口 ${call.id}）。`);
  const started = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    if (!findCallWindow(root)) break;
    if (Date.now() - started > 30 * 60_000) break;
  }
  console.log('通话结束。');
} finally {
  try { process.kill(bridgePid); } catch {}
  if (!has('keep')) runSound('--restore');
}
