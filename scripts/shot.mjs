// 用 CDP 驱动 headless Chrome 截图（避免 --screenshot 的等待死锁）
// 用法: node scripts/shot.mjs <url> <out.png> [w] [h] [waitMs] [evalExpr]
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const [url, out, w = '1600', h = '1000', waitMs = '3500', expr = ''] = process.argv.slice(2);
const port = 9600 + Math.floor(Math.random() * 200);
const profile = `/tmp/cdp-prof-${port}`;
rmSync(profile, { recursive: true, force: true });

const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
  '--no-sandbox', '--disable-gpu', '--enable-unsafe-swiftshader',
  '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
  '--disable-crash-reporter', '--crash-dumps-dir=/tmp/crashdumps',
  `--window-size=${w},${h}`, 'about:blank',
], { stdio: 'ignore' });

let wsUrl = null;
for (let i = 0; i < 100 && !wsUrl; i++) {
  await sleep(120);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`);
    const j = await r.json();
    wsUrl = j.webSocketDebuggerUrl;
  } catch {}
}
if (!wsUrl) { console.error('chrome did not start'); chrome.kill('SIGKILL'); process.exit(1); }

const { WebSocket } = await import('ws');
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

let id = 0;
const pending = new Map();
const logs = [];
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    logs.push('EXCEPTION: ' + (d.exception?.description || d.text) + ' @' + (d.url || '') + ':' + d.lineNumber);
  } else if (m.method === 'Runtime.consoleAPICalled') {
    logs.push('CONSOLE ' + m.params.type + ': ' + m.params.args.map(a => a.value ?? a.description ?? a.type).join(' '));
  } else if (m.method === 'Log.entryAdded') {
    logs.push('LOG ' + m.params.entry.level + ': ' + m.params.entry.text);
  }
});
function send(method, params = {}, sessionId) {
  const msg = { id: ++id, method, params };
  if (sessionId) msg.sessionId = sessionId;
  ws.send(JSON.stringify(msg));
  return new Promise((res) => pending.set(msg.id, res));
}

const { targetId } = (await send('Target.createTarget', { url: 'about:blank' })).result;
const { sessionId } = (await send('Target.attachToTarget', { targetId, flatten: true })).result;
const S = (m, p) => send(m, p, sessionId);

await S('Page.enable');
await S('Runtime.enable');
await S('Log.enable');
await S('Emulation.setDeviceMetricsOverride', {
  width: +w, height: +h, deviceScaleFactor: 1, mobile: false,
});
await S('Page.navigate', { url });
await sleep(+waitMs);

if (expr) {
  const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  console.log('EVAL:', JSON.stringify(r.result?.result?.value ?? r.result));
  await sleep(1100);
}

const shot = await S('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
if (logs.length) console.log(logs.slice(0, 12).join('\n'));
console.log('wrote', out);

ws.close();
chrome.kill('SIGKILL');
await sleep(200);
rmSync(profile, { recursive: true, force: true });
process.exit(0);
