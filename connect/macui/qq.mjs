import { execFileSync } from 'node:child_process';
import { activate, click, listWindows, sleep, waitFor } from './index.mjs';

/**
 * QQ desktop (Electron) does not expose the chat canvas to accessibility, so the
 * call flow is driven by coordinates measured from a shadow-free window capture.
 */
export const QQ_LAYOUT = {
  owner: 'QQ',
  mainWindow: 'QQ',
  callWindow: /语音(通话|聊天)|视频(通话|聊天)/,
  searchBox: { x: 167, y: 65 },
  chatRowX: 120,
  chatFirstRowY: 128,
  chatRowStep: 58,
  callIcon: { x: 738, y: 65 },
  hangup: { x: 295, y: 495 },
  // Incoming call window: green accept on the left, red reject on the right.
  accept: { x: 110, y: 495 },
};

export function chatRowPoint(bounds, row) {
  return { x: bounds.x + QQ_LAYOUT.chatRowX, y: bounds.y + QQ_LAYOUT.chatFirstRowY + row * QQ_LAYOUT.chatRowStep };
}

export function searchBoxPoint(bounds) {
  return { x: bounds.x + QQ_LAYOUT.searchBox.x, y: bounds.y + QQ_LAYOUT.searchBox.y };
}

export function callIconPoint(bounds) {
  return { x: bounds.x + QQ_LAYOUT.callIcon.x, y: bounds.y + QQ_LAYOUT.callIcon.y };
}

export function acceptPoint(bounds) {
  return { x: bounds.x + QQ_LAYOUT.accept.x, y: bounds.y + QQ_LAYOUT.accept.y };
}

export function hangupPoint(bounds) {
  return { x: bounds.x + QQ_LAYOUT.hangup.x, y: bounds.y + QQ_LAYOUT.hangup.y };
}

export function findMainWindow(windows) {
  return windows.find((window) => window.name === QQ_LAYOUT.mainWindow) ?? null;
}

/**
 * 来电窗口识别。
 *
 * 首选按窗口标题（`语音通话` / `视频通话`）。但读标题要「屏幕录制」权限：
 * 常驻进程（launchd 拉起的 node）通常没有，此时窗口名全是空串 —— 这种情况下
 * 退回按尺寸识别：通话窗口是竖长的窄窗（实测 360x640），主窗口宽得多（960x949）。
 * 只有「所有 QQ 窗口都没标题」时才走尺寸兜底，避免有权限时误判小面板。
 */
export function findCallWindow(windows) {
  const named = windows.find((window) => QQ_LAYOUT.callWindow.test(window.name ?? ''));
  if (named) return named;
  // 标题全都读不到 = 缺屏幕录制权限，这时才按几何兜底（竖窄窗）。
  // 有标题却对不上通话关键词时不敢猜：QQ 的小面板（表情、群公告）也是这个尺寸，
  // 误判会把「表情」当成来电去点接听，比漏接更糟。
  if (!windows.length || !windows.every((window) => !window.name)) return null;
  return windows.find((window) => {
    const width = Number(window.width) || 0;
    const height = Number(window.height) || 0;
    return width >= 260 && width <= 640 && height >= 380 && height <= 900;
  }) ?? null;
}

/** Dismiss any popup (member picker, menus) before driving the UI. */
function dismissPopups() {
  for (let i = 0; i < 3; i += 1) {
    try { execFileSync('osascript', ['-e', 'tell application "System Events" to key code 53'], { stdio: 'ignore' }); } catch {}
    execFileSync('sleep', ['0.35']);
  }
}

/** Open a conversation by contact name: search box → paste → Enter. */
export async function openChat(bins, name) {
  activate(QQ_LAYOUT.owner);
  await sleep(900);
  const main = await waitFor(() => findMainWindow(listWindows(bins, QQ_LAYOUT.owner)), { timeoutMs: 15_000 });
  if (!main) throw new Error('qq_window_missing');
  dismissPopups();
  const search = searchBoxPoint(main);
  click(bins, search.x, search.y);
  await sleep(600);
  execFileSync('pbcopy', { input: name });
  execFileSync('osascript', ['-e', 'tell application "System Events" to keystroke "v" using {command down}'], { stdio: 'ignore' });
  await sleep(1200);
  execFileSync('osascript', ['-e', 'tell application "System Events" to key code 36'], { stdio: 'ignore' });
  await sleep(2200);
  return findMainWindow(listWindows(bins, QQ_LAYOUT.owner)) ?? main;
}

export async function dial(bins, contact) {
  const main = await openChat(bins, contact);
  const point = callIconPoint(main);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    click(bins, point.x, point.y);
    const call = await waitFor(() => findCallWindow(listWindows(bins, QQ_LAYOUT.owner)), { timeoutMs: 8000 });
    if (call) return call;
    await sleep(600);
  }
  throw new Error('qq_call_window_missing');
}

export async function hangup(bins) {
  const call = findCallWindow(listWindows(bins, QQ_LAYOUT.owner));
  if (!call) return false;
  const point = hangupPoint(call);
  click(bins, point.x, point.y);
  await sleep(1200);
  return true;
}

/** 读通话窗口上的文字（有 ocr 二进制时可用）：用来判断到底接没接上。 */
export function callWindowText(bins, id) {
  if (!bins?.ocr) return '';
  try {
    return execFileSync(bins.ocr, [String(id)], { encoding: 'utf8', timeout: 15000 }).replace(/\s+/gu, ' ');
  } catch {
    return '';
  }
}

/**
 * Click the green accept button on an incoming call window.
 *
 * 一次点击不保证生效：QQ 的来电窗不一定拿得到焦点，第一次点击可能只被用来激活窗口；
 * 而且没有「辅助功能」权限时 CGEvent 会被系统静默丢弃（点了等于没点）。
 * 所以点完读一次窗口文字，还看得见「接听」就再点，最多 attempts 次。
 * 返回 null 表示点了仍是响铃状态（大概率缺辅助功能权限，调用方要出声提醒）。
 */
export async function acceptIncoming(bins, { attempts = 3, waitMs = 1200 } = {}) {
  let call = findCallWindow(listWindows(bins, QQ_LAYOUT.owner));
  if (!call) return null;
  // 先读一次窗：没有「接听」说明根本不是响铃态（已接上/已挂断/只是个窄面板），
  // 这时别点——点了等于把鼠标拽到一个没按钮的地方，看着像「鼠标自己乱动」。
  const opening = callWindowText(bins, call.id);
  if (opening && !/接听/u.test(opening)) return call;
  for (let round = 0; round < attempts; round += 1) {
    const point = acceptPoint(call);
    click(bins, point.x, point.y);
    await sleep(waitMs);
    const next = listWindows(bins, QQ_LAYOUT.owner);
    if (!next.some((window) => window.id === call.id)) return call; // 窗口没了也算接上
    const current = next.find((window) => window.id === call.id) ?? call;
    const text = callWindowText(bins, current.id);
    if (!text || !/接听/u.test(text)) return call;
    call = current;
  }
  return null;
}

/** 读通话窗的文字，判断这通电话处在哪一步（拨出没接通 / 已接通 / 被拒）。 */
export function classifyCallText(text) {
  const raw = String(text ?? '').replace(/\s+/gu, ' ').trim();
  if (!raw) return 'unknown';
  // QQ 接通后窗口里会出现通话计时（00:07 这种），这是「接通」最可靠的信号。
  if (/\d{1,2}:\d{2}/u.test(raw)) return 'connected';
  if (/对方拒绝|已拒绝|拒接|已被拒绝|对方已拒绝/u.test(raw)) return 'rejected';
  if (/已取消|通话结束|已挂断/u.test(raw)) return 'cancelled';
  if (/正在等待|等待对方|邀请你|正在呼叫|呼叫中|响铃中/u.test(raw)) return 'ringing';
  return 'unknown';
}

/**
 * 盯着一通电话直到窗口消失，给出结局。
 * 以前这里只有「窗口没了 = 结束」，于是「对方拒接」和「接通聊了十分钟」在日志里长得一模一样。
 */
export async function watchCall(bins, { intervalMs = 1000, timeoutMs = 30 * 60_000 } = {}) {
  const startedAt = Date.now();
  let sawConnected = false;
  let lastText = '';
  for (;;) {
    const call = findCallWindow(listWindows(bins, QQ_LAYOUT.owner));
    if (!call) {
      const outcome = sawConnected ? 'ended' : lastText && /拒绝|拒接/u.test(lastText) ? 'rejected' : 'no_answer';
      return { outcome, connected: sawConnected, durationMs: Date.now() - startedAt, lastText };
    }
    lastText = callWindowText(bins, call.id) ?? lastText;
    if (classifyCallText(lastText) === 'connected') sawConnected = true;
    if (Date.now() - startedAt > timeoutMs) {
      return { outcome: sawConnected ? 'timeout_connected' : 'timeout_ringing', connected: sawConnected, durationMs: Date.now() - startedAt, lastText };
    }
    await sleep(intervalMs);
  }
}

export async function waitCallEnd(bins, timeoutMs = 30 * 60_000) {
  return waitFor(() => (findCallWindow(listWindows(bins, QQ_LAYOUT.owner)) ? null : true), {
    timeoutMs,
    intervalMs: 1000,
  });
}
