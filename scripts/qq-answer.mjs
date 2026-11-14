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
const pidPath = resolve(pidDir, 'qq-answer.pid');
const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);

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
  let active = false;

  const enter = async (call) => {
    console.log(`☎ 收到来电（窗口 ${call.id}），切声卡 + 起桥 + 接听…`);
    runSound('--enable');
    startBridge();
    const accepted = await acceptIncoming(bins);
    if (!accepted) {
      console.log('通话窗口在接听前消失，回退等待。');
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
    if (!has('keep')) {
      try {
        runSound('--restore');
      } catch {
        // Restore is best effort on Ctrl+C.
      }
    }
  };
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });

  console.log(`QQ 呼入自动接听已启动（监控窗口：${QQ_LAYOUT.callWindow}）。Ctrl+C 结束。`);
  for (;;) {
    const call = findCallWindow(listWindows(bins, QQ_LAYOUT.owner));
    if (call && !active) {
      const ok = await enter(call);
      if (!ok) continue;
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
