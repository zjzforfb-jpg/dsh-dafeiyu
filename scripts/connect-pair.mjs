import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConnectConfig } from '../connect/server.mjs';
const root = resolve(import.meta.dirname, '..');
const adb = '/opt/homebrew/bin/adb';
const run = (...args) => execFileSync(adb, args, { encoding: 'utf8', timeout: 30000 }).trim();
const devices = run('devices').split(/\r?\n/).filter(line => /\sdevice$/.test(line)).map(line => line.split(/\s+/)[0]);
if (devices.length !== 1) throw new Error('配对需要恰好一台已授权的 USB 设备');
const serial = devices[0];
const pairingStartedAt = Date.now();
const cmd = (...args) => run('-s', serial, ...args);
const apk = resolve(root, 'android/DaFeiYuCompanion/app/build/outputs/apk/debug/app-debug.apk');
if (!existsSync(apk)) throw new Error('请先构建 Companion APK');
cmd('push', apk, '/data/local/tmp/dafeiyu-companion.apk');
const installed = cmd('shell', 'pm', 'install', '-r', '/data/local/tmp/dafeiyu-companion.apk');
if (!installed.includes('Success')) throw new Error(installed);
cmd('shell', 'rm', '/data/local/tmp/dafeiyu-companion.apk');
const config = loadConnectConfig(resolve(root, 'runtime/connect'));
cmd('shell', 'run-as', 'com.dafeiyu.companion', 'mkdir', '-p', 'files');
const result = spawnSync(adb, ['-s', serial, 'shell', 'run-as', 'com.dafeiyu.companion', 'sh', '-c', "'cat > files/pairing.json'"], {
  input: JSON.stringify({ device_id: 'honor_magic5', url: 'ws://127.0.0.1:8765/device', token: config.devices.honor_magic5 }), encoding: 'utf8', timeout: 5000,
});
if (result.status !== 0) throw new Error('写入配对配置失败');
writeFileSync(resolve(root, 'runtime/connect/usb-device.json'), JSON.stringify({ serial }), { mode: 0o600 });
cmd('reverse', 'tcp:8765', 'tcp:8765');
cmd('shell', 'pm', 'grant', 'com.dafeiyu.companion', 'android.permission.POST_NOTIFICATIONS');
cmd('shell', 'am', 'force-stop', 'com.dafeiyu.companion');
cmd('shell', 'am', 'start', '-n', 'com.dafeiyu.companion/.MainActivity');
const packageInfo = cmd('shell', 'dumpsys', 'package', 'com.dafeiyu.companion');
const expectedVersion = packageInfo.match(/versionName=([^\s]+)/)?.[1];
let ready = false;
for (let i = 0; i < 60; i++) {
  try {
    const res = await fetch('http://127.0.0.1:8765/devices', { headers: { authorization: `Bearer ${config.adminToken}` }, signal: AbortSignal.timeout(1500) });
    const data = await res.json();
    ready = data.devices?.some(d => d.id === 'honor_magic5' && d.online && d.capabilities?.version === expectedVersion && (!d.capabilities.notification_access || d.capabilities.listener_connected) && Date.parse(d.connected_at) >= pairingStartedAt);
    if (ready) break;
  } catch { /* 等待新 Companion 会话；不向旧连接下发命令。 */ }
  await new Promise(resolve => setTimeout(resolve, 500));
}
if (!ready) throw new Error('APK 已安装，但新 Companion 会话尚未注册就绪；请查看手机连接状态与 Connect 服务。');
console.log('已安装、配对并打开大肥鱼 Connect；设备凭证仅保存在应用沙箱与 Mac 私有运行目录。');
console.log(packageInfo.split('\n').filter(line => /versionName=|lastUpdateTime=/.test(line)).join('\n'));
