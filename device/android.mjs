import { execFile as execFileCallback } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const ADB = process.env.ADB_PATH || 'adb';
const TARGET_APPS = Object.freeze({
  douyin: { packageName: 'com.ss.android.ugc.aweme', label: '抖音' },
  wechat: { packageName: 'com.tencent.mm', label: '微信' },
});

async function adb(args, timeout = 10_000) {
  const { stdout } = await execFile(ADB, args, { encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024 });
  return stdout.trim();
}

function parseDevices(output) {
  return output.split(/\r?\n/u).slice(1).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('*')) return [];
    const [serial, state] = trimmed.split(/\s+/u);
    return serial && state ? [{ serial, state }] : [];
  });
}

async function readDevice(serial) {
  const getprop = async (name) => adb(['-s', serial, 'shell', 'getprop', name]);
  const [brand, model, release, sdk, securityPatch, appRows] = await Promise.all([
    getprop('ro.product.brand'),
    getprop('ro.product.model'),
    getprop('ro.build.version.release'),
    getprop('ro.build.version.sdk'),
    getprop('ro.build.version.security_patch'),
    Promise.all(Object.entries(TARGET_APPS).map(async ([id, app]) => {
      const output = await adb(['-s', serial, 'shell', 'dumpsys', 'package', app.packageName]);
      const version = output.match(/^\s*versionName=([^\s]+)/mu)?.[1] ?? null;
      return [id, { name: app.label, installed: output.includes(`Package [${app.packageName}]`), version }];
    })),
  ]);
  return {
    device: `${brand} ${model}`.trim(),
    android: release,
    sdk: Number(sdk) || null,
    securityPatch,
    apps: Object.fromEntries(appRows),
  };
}

export async function androidStatus() {
  let devices;
  try {
    devices = parseDevices(await adb(['devices', '-l']));
  } catch (error) {
    return { adbReady: false, error: error.message, devices: [] };
  }
  const results = await Promise.all(devices.map(async ({ serial, state }) => {
    if (state !== 'device') return { state };
    try {
      return { state, ...(await readDevice(serial)) };
    } catch (error) {
      return { state, error: error.message };
    }
  }));
  return { adbReady: true, connected: results.filter((row) => row.state === 'device').length, devices: results };
}

export async function captureAndroidScreenshot(outputDir) {
  const devices = parseDevices(await adb(['devices', '-l'])).filter((row) => row.state === 'device');
  if (devices.length !== 1) throw new Error(`截图需要恰好连接一台已授权设备；当前为 ${devices.length} 台`);
  const { stdout } = await execFile(ADB, ['-s', devices[0].serial, 'exec-out', 'screencap', '-p'], {
    encoding: 'buffer', timeout: 10_000, maxBuffer: 32 * 1024 * 1024,
  });
  if (!Buffer.isBuffer(stdout) || stdout.length < 8 || !stdout.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error('手机没有返回有效 PNG 截图');
  }
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(outputDir, 0o700);
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const file = join(outputDir, `screen-${stamp}.png`);
  writeFileSync(file, stdout, { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(file, 0o600);
  return { file, bytes: stdout.length };
}
