#!/usr/bin/env node
/**
 * 一条命令打通 QQ 语音通话：
 *   1. 系统设备切到 BlackHole（--enable 语义）
 *   2. 起声卡桥（自适应 VAD，监听 BH16，回复写 BH2ch）
 *   3. 用坐标点击在 QQ 里找到联系人并拨语音
 *   4. 通话结束后（或 Ctrl+C）停桥、恢复系统设备
 *
 * 用法：
 *   node scripts/qq-call.mjs --contact 七海
 *   node scripts/qq-call.mjs --hangup
 *   node scripts/qq-call.mjs --stop
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { ensureBinaries } from '../connect/macui/index.mjs';
import { dial, hangup, waitCallEnd } from '../connect/macui/qq.mjs';

const base = resolve(import.meta.dirname, '..');
const contactsPath = resolve(base, 'runtime/sound/contacts.json');
const pidDir = resolve(base, 'runtime/macui');
const pidPath = resolve(pidDir, 'qq-call.pid');
const args = process.argv.slice(2);
const option = (name, fallback = '') => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
};
const has = (name) => args.includes(`--${name}`);

function loadContacts() {
  try {
    return JSON.parse(readFileSync(contactsPath, 'utf8'));
  } catch {
    return {};
  }
}

function runSound(flag) {
  execFileSync('node', [resolve(base, 'scripts/sound.mjs'), flag], { stdio: 'inherit' });
}

function stopBridge() {
  if (!existsSync(pidPath)) return false;
  const pid = Number(readFileSync(pidPath, 'utf8').trim());
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
  unlinkSync(pidPath);
  return true;
}

function startBridge() {
  stopBridge();
  mkdirSync(pidDir, { recursive: true, mode: 0o700 });
  const child = spawn('node', [resolve(base, 'scripts/sound.mjs'), '--bridge'], {
    cwd: base,
    env: { ...process.env, SOUND_VAD_ADAPTIVE: '1', SOUND_VAD_FLOOR: process.env.SOUND_VAD_FLOOR ?? '0.0012' },
    stdio: 'inherit',
    detached: true,
  });
  child.unref();
  writeFileSync(pidPath, String(child.pid), { mode: 0o600 });
  return child.pid;
}

async function main() {
  const bins = ensureBinaries(base);

  if (has('stop')) {
    const stopped = stopBridge();
    runSound('--restore');
    console.log(stopped ? '已停止声卡桥并恢复设备。' : '没有运行中的声卡桥，已恢复设备。');
    return;
  }

  if (has('hangup')) {
    const done = await hangup(bins);
    console.log(done ? '已挂断 QQ 语音通话。' : '没有找到进行中的通话窗口。');
    return;
  }

  const contact = option('contact', loadContacts().qq ?? '七海');

  runSound('--enable');
  const bridgePid = startBridge();
  console.log(`声卡桥已启动（pid ${bridgePid}），监听 BlackHole 16ch。`);

  try {
    const call = await dial(bins, contact);
    console.log(`☎ 正在呼叫「${contact}」（窗口 ${call.id}，${call.width}x${call.height}）。`);
    console.log('通话中：直接说话即可，大肥鱼会接话；挂断后自动收尾。Ctrl+C 也能结束。');

    const ended = await waitCallEnd(bins);
    console.log(ended ? '通话窗口已关闭。' : '等待通话结束超时。');
  } finally {
    stopBridge();
    if (!has('keep')) runSound('--restore');
  }
}

main().catch((error) => {
  console.error(`qq-call 失败：${error.message}`);
  process.exit(1);
});
