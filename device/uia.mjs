import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const ADB = process.env.ADB_PATH || 'adb';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function adb(args, timeout = 20_000) {
  const { stdout } = await execFile(ADB, args, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

export { sleep };

const NODE = /<node\b([^>]*?)\/?>/gu;
const ATTR = /([\w:-]+)="([^"]*)"/gu;

function parseBounds(raw) {
  const match = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/u.exec(raw ?? '');
  if (!match) return null;
  const [x1, y1, x2, y2] = match.slice(1).map(Number);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1, cx: Math.round((x1 + x2) / 2), cy: Math.round((y1 + y2) / 2) };
}

const SERVER_PORT = Number(process.env.DAFEIYU_UIA_PORT || 19008);
const DEVICE_PORT = 9008;

/** Reuse the device-side uiautomator2 server through an adb port forward. */
async function ping(serial) {
  try {
    const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/ping`, { signal: AbortSignal.timeout(4000) });
    return response.ok;
  } catch {
    return false;
  }
}

/** Reuse the device-side uiautomator2 server through an adb port forward. */
async function ensureServer(serial) {
  if (await ping(serial)) return;
  await adb(['-s', serial, 'forward', '--remove', `tcp:${SERVER_PORT}`], 10_000).catch(() => {});
  await adb(['-s', serial, 'forward', `tcp:${SERVER_PORT}`, `tcp:${DEVICE_PORT}`], 15_000);
  for (let i = 0; i < 6; i += 1) {
    if (await ping(serial)) return;
    await sleep(700);
  }
  throw new Error('uiautomator_server_unavailable');
}

async function dumpXml(serial, attempt = 0) {
  try {
    await ensureServer(serial);
    const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/jsonrpc/0`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'dumpWindowHierarchy', params: [false] }),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json();
    if (!payload?.result) throw new Error(payload?.error?.message ?? 'uiautomator_dump_failed');
    return payload.result;
  } catch (error) {
    // 设备端服务偶尔会被抢 UiAutomation 或瞬时掉线：重连一次再试，别把整条任务带崩
    if (attempt < 2) {
      await sleep(1500);
      return dumpXml(serial, attempt + 1);
    }
    throw new Error(`uia_dump_failed: ${error.message}`);
  }
}

/** Dump the current window and return lightweight nodes. */
export async function dumpUi(serial) {
  const xml = await dumpXml(serial);
  const nodes = [];
  for (const match of xml.matchAll(NODE)) {
    const attrs = {};
    for (const pair of match[1].matchAll(ATTR)) attrs[pair[1]] = pair[2];
    const bounds = parseBounds(attrs.bounds);
    if (!bounds) continue;
    nodes.push({
      text: attrs.text ?? '',
      desc: attrs['content-desc'] ?? '',
      cls: attrs.class ?? '',
      clickable: attrs.clickable === 'true',
      focused: attrs.focused === 'true',
      bounds,
    });
  }
  return nodes;
}

export function findNodes(nodes, { text, regex, desc, cls } = {}) {
  const pattern = regex ? new RegExp(regex, 'u') : null;
  return nodes.filter((node) => {
    if (text && !node.text.includes(text)) return false;
    if (desc && !node.desc.includes(desc)) return false;
    if (cls && !node.cls.includes(cls)) return false;
    if (pattern) {
      const haystack = `${node.text}\n${node.desc}`;
      if (!pattern.test(haystack)) return false;
    }
    return true;
  });
}

export function visibleTexts(nodes) {
  return nodes.map((node) => node.text).filter(Boolean);
}

export async function tapPoint(serial, point) {
  await adb(['-s', serial, 'shell', 'input', 'tap', String(Math.round(point.x)), String(Math.round(point.y))]);
}

export async function tapNode(serial, node) {
  await tapPoint(serial, { x: node.bounds.cx, y: node.bounds.cy });
}

export async function currentIme(serial) {
  return (await adb(['-s', serial, 'shell', 'settings', 'get', 'secure', 'default_input_method'], 10_000)).trim();
}

export async function setIme(serial, ime) {
  await adb(['-s', serial, 'shell', 'ime', 'set', ime], 20_000);
  await sleep(400);
}

/** Type text into the focused field through ADBKeyboard (base64 keeps unicode intact). */
export async function inputText(serial, text) {
  const payload = Buffer.from(text, 'utf8').toString('base64');
  await adb(['-s', serial, 'shell', 'am', 'broadcast', '-a', 'ADB_INPUT_B64', '--es', 'msg', payload], 20_000);
}

const ADB_KEYBOARD = 'com.android.adbkeyboard/.AdbIME';

export async function withAdbKeyboard(serial, run) {
  const before = await currentIme(serial);
  if (before !== ADB_KEYBOARD) await setIme(serial, ADB_KEYBOARD);
  try {
    return await run();
  } finally {
    if (before && before !== ADB_KEYBOARD) await setIme(serial, before);
  }
}
