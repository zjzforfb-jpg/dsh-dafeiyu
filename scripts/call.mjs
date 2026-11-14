import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConnectConfig } from '../connect/server.mjs';
const root = resolve(import.meta.dirname, '../runtime/connect');
const config = loadConnectConfig(root);
const url = `http://127.0.0.1:8765/call?token=${encodeURIComponent(config.adminToken)}`;
console.log(`在 Mac 浏览器打开：${url}`);
if (process.argv.includes('--open') && process.platform === 'darwin') {
  execFileSync('/usr/bin/open', [url]);
  console.log('已在默认浏览器打开。说「开始通话」即可。');
}
