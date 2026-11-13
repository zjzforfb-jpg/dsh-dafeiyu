import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { LABEL, launchAgentPlist, nodeForService } from '../service/launchd.mjs';

if (process.platform !== 'darwin') {
  console.error('此命令仅用于 macOS。');
  process.exit(1);
}

const root = resolve(import.meta.dirname, '..');
const uid = process.getuid();
const domain = `gui/${uid}`;
const target = `${domain}/${LABEL}`;
const plistDir = join(homedir(), 'Library', 'LaunchAgents');
const plistPath = join(plistDir, `${LABEL}.plist`);
const logDir = join(homedir(), 'Library', 'Logs', 'DaFeiYu');
const action = process.argv[2] ?? 'status';

function ctl(...args) {
  return spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
}
function loaded() { return ctl('print', target).status === 0; }
function runCtl(...args) {
  const result = ctl(...args);
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `launchctl ${args[0]} 失败`).trim());
}
async function health() {
  try {
    const response = await fetch('http://127.0.0.1:3110/health', { signal: AbortSignal.timeout(1500) });
    return response.ok ? response.json() : null;
  } catch { return null; }
}
async function waitForHealth() {
  for (let i = 0; i < 30; i += 1) {
    const state = await health();
    if (state?.ok) return state;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  return null;
}
async function waitForOffline() {
  for (let i = 0; i < 30; i += 1) {
    if (!await health()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error('旧进程尚未退出；请检查是否另有手动启动的大肥鱼。');
}

try {
  if (action === 'install') {
    if (!loaded() && await health()) throw new Error('端口已被手动启动的大肥鱼占用；请先退出手动进程。');
    const nodeFromPath = execFileSync('/usr/bin/which', ['node'], { encoding: 'utf8' }).trim();
    const nodePath = nodeForService(nodeFromPath, process.execPath);
    mkdirSync(plistDir, { recursive: true });
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    chmodSync(logDir, 0o700);
    for (const name of ['pet.log', 'pet-error.log']) {
      const path = join(logDir, name);
      closeSync(openSync(path, 'a', 0o600));
      chmodSync(path, 0o600);
    }
    const content = launchAgentPlist({ root, nodePath, username: userInfo().username, logDir });
    if (loaded()) {
      runCtl('bootout', target);
      await waitForOffline();
    }
    writeFileSync(plistPath, content, { mode: 0o644 });
    chmodSync(plistPath, 0o644);
    const lint = spawnSync('/usr/bin/plutil', ['-lint', plistPath], { encoding: 'utf8' });
    if (lint.status !== 0) throw new Error(`LaunchAgent 配置无效：${lint.stderr || lint.stdout}`);
    runCtl('enable', target);
    runCtl('bootstrap', domain, plistPath);
    const state = await waitForHealth();
    if (!state) throw new Error(`服务已注册，但健康检查尚未通过；请运行 npm run service:status 并查看 ${join(logDir, 'pet-error.log')}。`);
    console.log(`已安装并启动 ${LABEL}；模型${state.modelReady ? '已就绪' : '尚未配置'}；长期记忆 ${state.memoryCount} 条。`);
  } else if (action === 'status') {
    const result = ctl('print', target);
    const match = result.stdout?.match(/\bpid = (\d+)/);
    const state = await health();
    console.log(JSON.stringify({ installed: existsSync(plistPath), loaded: result.status === 0, pid: match ? Number(match[1]) : null, healthy: Boolean(state?.ok), modelReady: Boolean(state?.modelReady) }, null, 2));
  } else if (action === 'stop') {
    if (loaded()) {
      runCtl('bootout', target);
      await waitForOffline();
    }
    console.log('已停止当前登录会话中的大肥鱼；下次登录仍会自动启动。');
  } else if (action === 'start') {
    if (!existsSync(plistPath)) throw new Error('尚未安装；请先运行 npm run service:install。');
    if (loaded()) runCtl('kickstart', '-k', target);
    else runCtl('bootstrap', domain, plistPath);
    const state = await waitForHealth();
    if (!state) throw new Error('已尝试启动，请查看服务状态和错误日志。');
    console.log('大肥鱼后台服务已启动。');
  } else if (action === 'uninstall') {
    if (loaded()) {
      runCtl('bootout', target);
      await waitForOffline();
    }
    if (existsSync(plistPath)) unlinkSync(plistPath);
    console.log('已移除大肥鱼开机自启配置。');
  } else {
    console.error('用法：npm run service:install|service:status|service:stop|service:start|service:uninstall');
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
