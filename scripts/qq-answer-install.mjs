#!/usr/bin/env node
/**
 * 把 QQ 呼入自动接听装成常驻 LaunchAgent（登录即起、崩了自动拉起）。
 *
 *   node scripts/qq-answer-install.mjs            # 安装并启动（默认）
 *   node scripts/qq-answer-install.mjs status     # 看状态 / 最近日志
 *   node scripts/qq-answer-install.mjs uninstall  # 卸载
 *
 * 注意：脚本靠读 QQ 窗口标题识别来电窗口，需要「屏幕录制」权限；跑本命令的终端
 * 要先在 系统设置 › 隐私与安全性 › 屏幕录制 里勾上，否则装上也不会接听。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { nodeForService } from '../service/launchd.mjs';

const LABEL = 'com.dafeiyu.qq-answer';
const root = resolve(import.meta.dirname, '..');
const uid = process.getuid();
const domain = `gui/${uid}`;
const target = `${domain}/${LABEL}`;
const plistDir = join(homedir(), 'Library', 'LaunchAgents');
const plistPath = join(plistDir, `${LABEL}.plist`);
const logDir = join(homedir(), 'Library', 'Logs', 'DaFeiYu');
const watcherPidPath = join(root, 'runtime', 'macui', 'qq-answer.watch.pid');
const action = process.argv[2] ?? 'install';
const direct = process.argv.includes('--direct');

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function ctl(...args) {
  return spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
}
function loaded() {
  return ctl('print', target).status === 0;
}
function runCtl(...args) {
  const result = ctl(...args);
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `launchctl ${args[0]} 失败`).trim());
}
function watcherPid() {
  if (!existsSync(watcherPidPath)) return null;
  const pid = Number(readFileSync(watcherPidPath, 'utf8').trim());
  if (!Number.isFinite(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function plist({ nodePath, direct }) {
  const safePath = `${dirname(nodePath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
  const program = direct
    ? `<string>${xml(nodePath)}</string><string>${xml(join(root, 'scripts/qq-answer.mjs'))}</string>`
    : `<string>/usr/bin/open</string><string>-a</string><string>Terminal</string><string>${xml(join(root, 'scripts/qq-answer.command'))}</string>`;
  const keepAlive = direct ? '<dict><key>SuccessfulExit</key><false/></dict>' : '<false/>';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${program}</array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>${keepAlive}
  <key>ThrottleInterval</key><integer>10</integer>
  <key>EnvironmentVariables</key><dict>
    <key>USER</key><string>${xml(userInfo().username)}</string>
    <key>PATH</key><string>${xml(safePath)}</string>
  </dict>
  <key>StandardOutPath</key><string>${xml(join(logDir, 'qq-answer.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logDir, 'qq-answer-error.log'))}</string>
</dict></plist>
`;
}

async function waitForWatcher() {
  for (let i = 0; i < 40; i += 1) {
    const pid = watcherPid();
    if (pid) return pid;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  return null;
}

try {
  if (action === 'install') {
    const nodeFromPath = execFileSync('/usr/bin/which', ['node'], { encoding: 'utf8' }).trim();
    const nodePath = nodeForService(nodeFromPath, process.execPath);
    mkdirSync(plistDir, { recursive: true });
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    chmodSync(logDir, 0o700);
    for (const name of ['qq-answer.log', 'qq-answer-error.log']) {
      const path = join(logDir, name);
      closeSync(openSync(path, 'a', 0o600));
      chmodSync(path, 0o600);
    }
    if (loaded()) runCtl('bootout', target);
    writeFileSync(plistPath, plist({ nodePath, direct }), { mode: 0o644 });
    chmodSync(plistPath, 0o644);
    const lint = spawnSync('/usr/bin/plutil', ['-lint', plistPath], { encoding: 'utf8' });
    if (lint.status !== 0) throw new Error(`LaunchAgent 配置无效：${lint.stderr || lint.stdout}`);
    // 手动起的 watcher 先收掉，避免和新装的常驻实例互相让位（放在 plist 写好之后，失败还能手动重起）。
    const manual = watcherPid();
    if (manual) {
      try {
        process.kill(manual, 'SIGTERM');
      } catch {}
      for (let i = 0; i < 20 && watcherPid(); i += 1) await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    }
    runCtl('enable', target);
    try {
      runCtl('bootstrap', domain, plistPath);
    } catch (error) {
      console.error(`bootstrap 失败（${error.message}）；手动重起：nohup node scripts/qq-answer.mjs >> runtime/sound/qq-answer.log 2>&1 &`);
      throw error;
    }
    const pid = await waitForWatcher();
    if (!pid) throw new Error(`已注册 ${LABEL}，但 watcher 没起来；看 ${join(logDir, 'qq-answer-error.log')}`);
    console.log(`已安装并启动 ${LABEL}（watcher pid ${pid}）。`);
    if (direct) {
      console.log('直接模式：需要给 node 二进制授权，否则读不到窗口标题 / 点不动接听。');
      console.log('  系统设置 › 隐私与安全性 › 屏幕录制 和 › 辅助功能 里各加一条 node。');
    } else {
      console.log('终端模式：由 终端.app 托管（它通常已有屏幕录制/辅助功能权限）。登录后会开一个终端窗口，关掉就没有自动接听了。');
    }
    console.log(`日志：${join(logDir, 'qq-answer.log')}（终端窗口里也能直接看到输出）`);
    console.log(`重启：launchctl kickstart -k ${target}`);
  } else if (action === 'status') {
    const result = ctl('print', target);
    const pid = watcherPid();
    console.log(`${LABEL}：${loaded() ? '已注册' : '未注册'}；watcher ${pid ? `运行中（pid ${pid}）` : '未运行'}`);
    if (result.status !== 0) console.log('（launchctl print 显示未加载）');
    const log = join(logDir, 'qq-answer.log');
    if (existsSync(log)) {
      const lines = readFileSync(log, 'utf8').trimEnd().split('\n').slice(-5);
      console.log(`最近日志（${log}）：`);
      for (const line of lines) console.log(`  ${line}`);
    }
  } else if (action === 'probe') {
    const { ensureBinaries, listWindows } = await import('../connect/macui/index.mjs');
    const { QQ_LAYOUT } = await import('../connect/macui/qq.mjs');
    const bins = ensureBinaries(root);
    const windows = listWindows(bins, QQ_LAYOUT.owner);
    console.log(`QQ 窗口 ${windows.length} 个${existsSync(watcherPidPath) ? `；watcher ${watcherPid() ? '运行中' : '未运行'}` : ''}。`);
    for (const window of windows) {
      console.log(`  #${window.id} 标题「${window.name || '（空）'}」${window.width ? ` ${window.width}x${window.height}` : ''}`);
    }
    if (windows.length && windows.every((window) => !window.name)) {
      console.log('⚠ 标题全空 = 缺「屏幕录制」权限，来电窗口识别会失效。到 系统设置 › 隐私与安全性 › 屏幕录制 勾上运行本命令的终端/node。');
    }
  } else if (action === 'uninstall') {
    if (loaded()) runCtl('bootout', target);
    const pid = watcherPid();
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }
    if (existsSync(plistPath)) unlinkSync(plistPath);
    console.log(`已卸载 ${LABEL}${pid ? `（停掉 watcher pid ${pid}）` : ''}。`);
  } else {
    console.error(`未知动作：${action}（install / status / probe / uninstall）`);
    process.exit(2);
  }
} catch (error) {
  console.error(`qq-answer-install 失败：${error.message}`);
  process.exit(1);
}
