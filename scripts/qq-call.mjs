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
import { dial, findMainWindow, hangup, watchCall } from '../connect/macui/qq.mjs';
import { listWindows } from '../connect/macui/index.mjs';
import { QQ_LAYOUT } from '../connect/macui/qq.mjs';
import { DatabaseSync } from 'node:sqlite';
import { recordAgentEvent } from '../connect/agent-events.mjs';

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

/** 把「这通电话最后怎么了」落成文件 + 事件，接在任务回执后面能看见。 */
function describeOutcome(outcome) {
  return {
    ended: '接通后正常结束',
    rejected: '对方拒接',
    no_answer: '拨出去了但没人接',
    cancelled: '已取消',
    timeout_connected: '通话超时（还连着）',
    timeout_ringing: '一直没人接（超时）',
  }[outcome] ?? outcome;
}

function recordOutcome({ contact, call, result }) {
  const outcomePath = resolve(base, 'runtime/sound/call-outcome.json');
  const payload = {
    peer: contact,
    windowId: call?.id ?? null,
    outcome: result.outcome,
    connected: result.connected,
    durationMs: result.durationMs,
    at: new Date().toISOString(),
  };
  try {
    mkdirSync(resolve(base, 'runtime/sound'), { recursive: true });
    writeFileSync(outcomePath, JSON.stringify(payload, null, 2));
  } catch (error) {
    console.error(`写 call-outcome.json 失败：${error.message}`);
  }
  try {
    const db = new DatabaseSync(resolve(base, 'runtime/connect/connect.sqlite'));
    recordAgentEvent(db, {
      eventType: 'call_ended',
      channel: 'call',
      actor: 'qq-call',
      payload: { ...payload, summary: describeOutcome(result.outcome) },
      dedupeKey: `call_ended:${call?.id ?? contact}:${Math.floor(Date.now() / 1000)}`,
    });
    db.close();
  } catch (error) {
    console.error(`记 call_ended 事件失败：${error.message}`);
  }
}

async function main() {
  const bins = ensureBinaries(base);

  // --probe：只回答「能不能拨」——窗口在不在、联系人叫什么、按钮坐标在哪，绝不拨号
  if (has('probe')) {
    const contact = option('contact', loadContacts().qq ?? '七海');
    const windows = listWindows(bins, QQ_LAYOUT.owner);
    const main = findMainWindow(windows);
    console.log(JSON.stringify({
      ok: Boolean(main),
      contact,
      window: main ? { id: main.id, name: main.name, width: main.width, height: main.height } : null,
      windows: windows.map((w) => ({ name: w.name, width: w.width, height: w.height })),
      dial: QQ_LAYOUT.callIcon,
      note: '探针：不拨号、不动声卡',
    }, null, 1));
    return;
  }

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

    // 以前窗口一消失就只知道「结束了」：接通聊十分钟、对方拒接、没人接，三种结局一模一样。
    const result = await watchCall(bins);
    const seconds = Math.round(result.durationMs / 1000);
    console.log(`通话窗口已关闭：${describeOutcome(result.outcome)}（${seconds}s，接通=${result.connected ? '是' : '否'}）。`);
    recordOutcome({ contact, call, result });
  } finally {
    stopBridge();
    if (!has('keep')) runSound('--restore');
  }
}

main().catch((error) => {
  console.error(`qq-call 失败：${error.message}`);
  process.exit(1);
});
