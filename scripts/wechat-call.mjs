#!/usr/bin/env node
/**
 * 用桌面微信给联系人打语音电话，并让声卡桥接入（大肥鱼能听能说）。
 *   node scripts/wechat-call.mjs [--contact 敢敢不憨了] [--keep]
 */
import { spawn, execFileSync } from 'node:child_process';
import { openChat, startVoiceCall, findCallWindow } from '../connect/macui/wechat.mjs';

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
