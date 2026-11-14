import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
const label = 'com.dafeiyu.connect';
const root = resolve(import.meta.dirname, '..');
const domain = `gui/${process.getuid()}`;
const target = `${domain}/${label}`;
const plist = join(homedir(), 'Library/LaunchAgents', `${label}.plist`);
const logs = join(homedir(), 'Library/Logs/DaFeiYu');
const ctl = (...args) => spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
const check = r => { if (r.status !== 0) throw new Error(r.stderr || r.stdout); };
const loaded = () => ctl('print', target).status === 0;
const xml = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const action = process.argv[2] ?? 'status';
if (action === 'install') {
  mkdirSync(join(homedir(), 'Library/LaunchAgents'), { recursive: true });
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  for (const file of ['connect.log', 'connect-error.log']) { const path = join(logs, file); closeSync(openSync(path, 'a', 0o600)); chmodSync(path, 0o600); }
  const node = execFileSync('/usr/bin/which', ['node'], { encoding: 'utf8' }).trim();
  const args = [node, join(root, 'scripts/connect.mjs'), 'start'].map(v => `<string>${xml(v)}</string>`).join('');
  writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args}</array><key>WorkingDirectory</key><string>${xml(root)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(join(logs, 'connect.log'))}</string><key>StandardErrorPath</key><string>${xml(join(logs, 'connect-error.log'))}</string></dict></plist>`);
  check(spawnSync('/usr/bin/plutil', ['-lint', plist], { encoding: 'utf8' }));
  if (loaded()) check(ctl('bootout', target));
  check(ctl('enable', target)); check(ctl('bootstrap', domain, plist));
  console.log('已安装大肥鱼 Connect 独立登录服务');
} else if (action === 'stop') { if (loaded()) check(ctl('bootout', target)); console.log('Connect 已停止'); }
else if (action === 'start') { check(loaded() ? ctl('kickstart', '-k', target) : ctl('bootstrap', domain, plist)); console.log('Connect 已启动'); }
else if (action === 'uninstall') { if (loaded()) check(ctl('bootout', target)); if (existsSync(plist)) unlinkSync(plist); console.log('Connect 已卸载登录服务'); }
else if (action === 'status') console.log(JSON.stringify({ installed: existsSync(plist), loaded: loaded() }));
else throw new Error('unknown service action');

if (['install','start'].includes(action)) {
  let ready = false;
  for (let i=0; i<40; i++) {
    try { const res = await fetch('http://127.0.0.1:8765/health', {signal:AbortSignal.timeout(1000)}); ready = res.ok && (await res.json()).service === 'DaFeiYu Connect'; if(ready)break; } catch {}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  if(!ready)throw new Error('Connect 已注册但健康检查未通过，请查看服务日志');
}
