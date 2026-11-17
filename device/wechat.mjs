import { execFile as execFileCallback } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const ADB = process.env.ADB_PATH || 'adb';
const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function adb(args, timeout = 20_000) {
  const { stdout } = await execFile(ADB, args, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

async function shell(serial, command, timeout) {
  return adb(['-s', serial, 'shell', command], timeout);
}

export async function deviceSerial() {
  const rows = (await adb(['devices', '-l']))
    .split(/\r?\n/u)
    .slice(1)
    .map((line) => line.trim().split(/\s+/u))
    .filter((row) => row[1] === 'device');
  if (rows.length !== 1) throw new Error(`手机没连上（adb 看到 ${rows.length} 台设备）：抖音和微信操作都需要恰好一台在线的安卓手机。`);
  return rows[0][0];
}

export async function capturePng(serial, outputDir, prefix = 'wechat') {
  const { stdout } = await execFile(ADB, ['-s', serial, 'exec-out', 'screencap', '-p'], {
    encoding: 'buffer',
    timeout: 10_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (!Buffer.isBuffer(stdout) || stdout.length < 8 || !stdout.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new Error('手机没有返回有效 PNG 截图');
  }
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(outputDir, 0o700);
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const file = join(outputDir, `${prefix}-${stamp}.png`);
  writeFileSync(file, stdout, { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(file, 0o600);
  return { file, bytes: stdout.length };
}

async function tap(serial, point) {
  await shell(serial, `input tap ${point.x} ${point.y}`);
}

async function broadcast(serial, action, extra = '') {
  return shell(serial, `am broadcast -a ${action}${extra}`);
}

async function switchIme(serial, imeId) {
  const installed = (await shell(serial, 'ime list -s'))
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!installed.includes(imeId)) {
    throw new Error(
      `没有检测到 ADBKeyboard 输入法（${imeId}）。先安装 ADBKeyboard.apk，再执行：adb shell ime enable ${imeId}`,
    );
  }
  const before = (await shell(serial, 'settings get secure default_input_method')).trim();
  if (before !== imeId) await shell(serial, `ime set ${imeId}`);
  return before || null;
}

/**
 * 把微信拉回聊天列表。微信聊天页是 LauncherUI 内部页面，uiautomator 也读不到，
 * 所以用「启动 → 返回 → 再启动 → 点微信 tab」这套确定性动作，避免停在某个聊天里。
 */
async function openChatList(serial, config) {
  const start = ['-s', serial, 'shell', 'am', 'start', '--user', String(config.user), '-n', `${config.packageName}/${config.activity}`];
  await adb(start);
  await sleep(900);
  // 两次返回：第一次收键盘，第二次退出聊天页；都落在顶层页或桌面，再由 am start 拉回微信
  await shell(serial, 'input keyevent BACK');
  await sleep(400);
  await shell(serial, 'input keyevent BACK');
  await sleep(400);
  await adb(start);
  await sleep(900);
  await tap(serial, config.tabs.chat);
  await sleep(800);
}

/**
 * 发一条微信消息。文字用 ADBKeyboard 广播（支持中文/emoji），发送用 IME_ACTION_SEND。
 * dryRun=true 时只填入输入框并截图，不发送，随后清空草稿。
 */
export async function sendWechatMessage({ contact, message, config, dryRun = false, outputDir }) {
  if (!contact) throw new Error('缺少 --to（要发给谁）');
  if (!message) throw new Error('缺少 --message（要发的内容）');
  const target = config.contacts?.[contact];
  if (!target) {
    throw new Error(`配置里没有联系人「${contact}」；可选：${Object.keys(config.contacts ?? {}).join('、') || '（空）'}`);
  }

  const serial = await deviceSerial();
  const imeBefore = await switchIme(serial, config.ime);
  const screenshots = [];
  try {
    await openChatList(serial, config);
    await tap(serial, target);
    await sleep(1000);
    await tap(serial, config.input);
    await sleep(600);

    const base64 = Buffer.from(message, 'utf8').toString('base64');
    await broadcast(serial, 'ADB_INPUT_B64', ` --es msg '${base64}'`);
    await sleep(500);
    screenshots.push(await capturePng(serial, outputDir));

    if (dryRun) {
      await broadcast(serial, 'ADB_CLEAR_TEXT');
      await sleep(300);
      screenshots.push(await capturePng(serial, outputDir));
      return { sent: false, dryRun: true, contact, message, screenshots };
    }

    await broadcast(serial, 'ADB_EDITOR_CODE', ' --ei code 4');
    await sleep(1000);
    screenshots.push(await capturePng(serial, outputDir));
    return { sent: true, dryRun: false, contact, message, screenshots };
  } finally {
    if (imeBefore && imeBefore !== config.ime) {
      try {
        await shell(serial, `ime set ${imeBefore}`);
        await sleep(300);
        // 切回原输入法后键盘会顶起来，按一次返回收起
        await shell(serial, 'input keyevent BACK');
      } catch {
        // 恢复输入法失败不覆盖主流程的错误
      }
    }
  }
}
