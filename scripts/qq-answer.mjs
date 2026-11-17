#!/usr/bin/env node
/**
 * QQ 呼入自动接听：盯住 QQ 通话窗口，一出现就切声卡、起桥、点"接听"。
 *
 *   npm run connect:qq-answer            # 常驻，Ctrl+C 结束
 *   node scripts/qq-answer.mjs --keep    # 挂断后不恢复系统设备
 *   node scripts/qq-answer.mjs --once    # 只接一通
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { ensureBinaries, listWindows, sleep } from '../connect/macui/index.mjs';
import { acceptIncoming, findCallWindow, QQ_LAYOUT, waitCallEnd } from '../connect/macui/qq.mjs';

const base = resolve(import.meta.dirname, '..');
const pidDir = resolve(base, 'runtime/macui');
const pidPath = resolve(pidDir, 'qq-answer.pid'); // 语音桥的 pid，stopBridge 用
const watcherPidPath = resolve(pidDir, 'qq-answer.watch.pid'); // 本进程的 pid，单实例守卫用
const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const HEARTBEAT_MS = 10 * 60_000;

function alive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 单实例：已有 watcher 在跑就直接退出，避免两个进程抢接听。 */
function claimWatcher() {
  if (existsSync(watcherPidPath)) {
    const other = Number(readFileSync(watcherPidPath, 'utf8').trim());
    if (other !== process.pid && alive(other)) {
      console.log(`QQ 呼入自动接听已在运行（pid ${other}），本次退出。`);
      process.exit(0);
    }
  }
  mkdirSync(pidDir, { recursive: true, mode: 0o700 });
  writeFileSync(watcherPidPath, String(process.pid), { mode: 0o600 });
}

function releaseWatcher() {
  try {
    if (existsSync(watcherPidPath) && readFileSync(watcherPidPath, 'utf8').trim() === String(process.pid)) unlinkSync(watcherPidPath);
  } catch {
    // Best effort.
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

function ocrCaller(call) {
  try {
    const bins = ensureBinaries(base);
    const out = execFileSync(bins.ocr ?? `${base}/runtime/macui/bin/ocr`, [String(call.id)], { encoding: 'utf8' });
    const text = out.replace(/\s+/gu, ' ');
    if (/小朋友/u.test(text)) return { label: '妈妈', name: '小朋友' };
    if (/七海/u.test(text)) return { label: '爸爸', name: '七海' };
    return { label: '对方', name: '' };
  } catch { return { label: '对方', name: '' }; }
}

function writeCaller(info) {
  try {
    mkdirSync(`${base}/runtime/sound`, { recursive: true });
    writeFileSync(`${base}/runtime/sound/caller.json`, JSON.stringify({ ...info, at: new Date().toISOString() }, null, 2));
  } catch {}
}

async function main() {
  const bins = ensureBinaries(base);
  claimWatcher();
  let active = false;
  let warnedBlind = false;

  const enter = async (call) => {
    const caller = ocrCaller(call);
    writeCaller(caller);
    console.log(`☎ 收到来电（窗口 ${call.id}${call.name ? '' : '，无标题·按尺寸识别'}，来电话的是${caller.label}${caller.name ? `·${caller.name}` : ''}），切声卡 + 起桥 + 接听…`);
    runSound('--enable');
    startBridge();
    const accepted = await acceptIncoming(bins);
    if (!accepted) {
      const still = findCallWindow(listWindows(bins, QQ_LAYOUT.owner));
      console.log(still
        ? '⚠ 点了接听但来电窗还在响铃：CGEvent 被系统丢弃，多半是缺「辅助功能」权限（给 node 加一条）。继续等下一次点击。'
        : '通话窗口在接听前消失，回退等待。');
      stopBridge();
      if (!has('keep')) runSound('--restore');
      return false;
    }
    console.log('已接听，开始通话。');
    active = true;
    return true;
  };

  const leave = async () => {
    console.log('通话结束，停桥收尾。');
    stopBridge();
    if (!has('keep')) runSound('--restore');
    active = false;
  };

  const cleanup = () => {
    stopBridge();
    releaseWatcher();
    if (!has('keep')) {
      try {
        runSound('--restore');
      } catch {
        // Restore is best effort on Ctrl+C.
      }
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      cleanup();
      process.exit(0);
    });
  }
  process.on('exit', releaseWatcher);

  console.log(`QQ 呼入自动接听已启动（pid ${process.pid}，监控窗口：${QQ_LAYOUT.callWindow}）。Ctrl+C 结束。`);
  // 辅助功能自检：点「接听」靠 CGEvent，没有辅助功能权限会被系统静默丢弃。
  // 注意 `count processes` 只需要「自动化」权限，会误报通过；这里必须查一次 QQ 的 UI 树。
  try {
    execFileSync('osascript', ['-e', 'tell application "System Events" to tell process "QQ" to get {name of windows}'], { stdio: 'pipe', timeout: 8000 });
    console.log('辅助功能权限：正常（可以模拟点击）。');
  } catch (error) {
    const text = String(error.stderr ?? error.message ?? '').trim();
    const hint = /assistive|1719|-25211|不允许辅助访问/iu.test(text) ? '缺「辅助功能」权限，接听按钮点不动' : text;
    console.log(`⚠ 辅助功能自检失败：${hint}`);
  }
  // 启动 2 秒后打一行窗口快照：能读到标题 = 屏幕录制权限正常，读不到就只有「（空）」。
  setTimeout(() => {
    try {
      const snapshot = listWindows(bins, QQ_LAYOUT.owner);
      const titles = snapshot.map((window) => window.name || '（空）').join(' / ');
      console.log(snapshot.length
        ? `窗口快照：${snapshot.length} 个 —— ${titles}`
        : '窗口快照：QQ 当前没有可见窗口（来电时才会弹窗，属正常）。');
    } catch (error) {
      console.log(`窗口快照失败：${error.message}`);
    }
  }, 2000).unref();
  let lastBeat = Date.now();
  let lastSignature = null;
  for (;;) {
    const windows = listWindows(bins, QQ_LAYOUT.owner);
    // 窗口集合一变就打一行（来电/挂断最直观的证据，也方便事后对着日志校准标题正则）
    const signature = windows.map((window) => `${window.name || '（空）'}@${window.width}x${window.height}`).sort().join(' | ');
    if (signature !== lastSignature) {
      lastSignature = signature;
      console.log(windows.length
        ? `窗口变化：${windows.length} 个 —— ${windows.map((window) => `${window.name || '（空）'} ${window.width}x${window.height}`).join(' / ')}`
        : '窗口变化：QQ 没有可见窗口。');
    }
    const call = findCallWindow(windows);
    if (!call && windows.length && windows.every((window) => !window.name) && !warnedBlind) {
      warnedBlind = true;
      console.log('⚠ 读不到 QQ 窗口标题（大概率缺「屏幕录制」权限），来电窗口识别会失效：到 系统设置 › 隐私与安全性 › 屏幕录制 里把运行本脚本的终端/node 勾上。');
    }
    if (Date.now() - lastBeat > HEARTBEAT_MS) {
      lastBeat = Date.now();
      console.log(`监听中（QQ 窗口 ${windows.length} 个，${active ? '通话中' : '待机'}）。`);
    }
    if (call && !active) {
      const ok = await enter(call);
      if (!ok) {
        // 点不动就别每 800ms 再点一次：那会把鼠标一直往接听键上拽，看着像鼠标自己乱动。
        // 退避 15 秒再试，期间窗口若消失就正常收尾。
        await sleep(15_000);
        continue;
      }
    } else if (!call && active) {
      await leave();
      if (has('once')) return;
    }
    if (call && active) {
      // Wait for this call to end before watching again.
      const ended = await waitCallEnd(bins, 6 * 60 * 60_000);
      if (ended) {
        await leave();
        if (has('once')) return;
      }
    }
    await sleep(800);
  }
}

main().catch((error) => {
  console.error(`qq-answer 失败：${error.message}`);
  process.exit(1);
});
