#!/usr/bin/env node
/**
 * 把「抖音新消息红点监测」装成常驻 LaunchAgent（登录即起、崩了自动拉起）。
 *
 *   node scripts/douyin-inbox-watch-install.mjs                 # 安装并启动（每 60 秒查一次）
 *   node scripts/douyin-inbox-watch-install.mjs --interval 120  # 换频率
 *   node scripts/douyin-inbox-watch-install.mjs status          # 看状态 / 最近日志
 *   node scripts/douyin-inbox-watch-install.mjs uninstall       # 卸载
 *
 * 它只走 adb（读控件树 + 点击），不需要屏幕录制/辅助功能权限。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { nodeForService } from '../service/launchd.mjs';

const LABEL = 'com.dafeiyu.douyin-inbox-watch';
const root = resolve(import.meta.dirname, '..');
const uid = process.getuid();
const domain = `gui/${uid}`;
const target = `${domain}/${LABEL}`;
const plistDir = join(homedir(), 'Library', 'LaunchAgents');
const plistPath = join(plistDir, `${LABEL}.plist`);
const logDir = join(homedir(), 'Library', 'Logs', 'DaFeiYu');
const stateFile = join(root, 'runtime', 'douyin', 'inbox-watch-state.json');
const action = process.argv[2] ?? 'install';
const flag = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--') ? process.argv[index + 1] : fallback;
};
const interval = Math.max(20, Number(flag('interval', 60)) || 60);
const limit = Math.max(1, Number(flag('limit', 6)) || 6);

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
const ctl = (...args) => spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
const loaded = () => ctl('print', target).status === 0;
function runCtl(...args) {
  const result = ctl(...args);
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `launchctl ${args[0]} 失败`).trim());
}

function plist({ nodePath }) {
  const safePath = `${dirname(nodePath)}:/opt/homebrew/bin:/opt/homebrew/opt/node@24/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(nodePath)}</string>
    <string>${xml(join(root, 'scripts/douyin-inbox-watch.mjs'))}</string>
    <string>--interval</string><string>${interval}</string>
    <string>--limit</string><string>${limit}</string>
    <string>--reply</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>EnvironmentVariables</key><dict>
    <key>USER</key><string>${xml(userInfo().username)}</string>
    <key>PATH</key><string>${xml(safePath)}</string>
  </dict>
  <key>StandardOutPath</key><string>${xml(join(logDir, 'douyin-inbox-watch.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logDir, 'douyin-inbox-watch-error.log'))}</string>
</dict></plist>
`;
}

try {
  if (action === 'install') {
    const nodeFromPath = execFileSync('/usr/bin/which', ['node'], { encoding: 'utf8' }).trim();
    const nodePath = nodeForService(nodeFromPath, process.execPath);
    mkdirSync(plistDir, { recursive: true });
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    chmodSync(logDir, 0o700);
    for (const name of ['douyin-inbox-watch.log', 'douyin-inbox-watch-error.log']) {
      const path = join(logDir, name);
      closeSync(openSync(path, 'a', 0o600));
      chmodSync(path, 0o600);
    }
    if (loaded()) runCtl('bootout', target);
    writeFileSync(plistPath, plist({ nodePath }), { mode: 0o644 });
    chmodSync(plistPath, 0o644);
    const lint = spawnSync('/usr/bin/plutil', ['-lint', plistPath], { encoding: 'utf8' });
    if (lint.status !== 0) throw new Error(`LaunchAgent 配置无效：${lint.stderr || lint.stdout}`);
    runCtl('enable', target);
    runCtl('bootstrap', domain, plistPath);
    console.log(`已安装并启动 ${LABEL}：每 ${interval} 秒看一次首页消息红点，有红点就回评论（最多 ${limit} 条）。`);
    console.log(`日志：${join(logDir, 'douyin-inbox-watch.log')}`);
    console.log(`重启：launchctl kickstart -k ${target}`);
  } else if (action === 'status') {
    let state = null;
    try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { /* 还没跑过 */ }
    console.log(`${LABEL}：${loaded() ? '已注册' : '未注册'}`);
    if (state) console.log(`最近一次检查：${state.lastCheck ?? '—'}；红点：${state.lastBadge ?? 0}；最近回复：${state.lastReplyAt ?? '—'}`);
    const log = join(logDir, 'douyin-inbox-watch.log');
    if (existsSync(log)) {
      const lines = readFileSync(log, 'utf8').trimEnd().split('\n').slice(-6);
      console.log(`最近日志（${log}）：`);
      for (const line of lines) console.log(`  ${line}`);
    }
  } else if (action === 'uninstall') {
    if (loaded()) runCtl('bootout', target);
    if (existsSync(plistPath)) unlinkSync(plistPath);
    console.log(`已卸载 ${LABEL}。`);
  } else {
    console.error(`未知动作：${action}（install / status / uninstall）`);
    process.exit(2);
  }
} catch (error) {
  console.error(`douyin-watch-install 失败：${error.message}`);
  process.exit(1);
}
