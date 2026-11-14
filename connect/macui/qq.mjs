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

export function hangupPoint(bounds) {
  return { x: bounds.x + QQ_LAYOUT.hangup.x, y: bounds.y + QQ_LAYOUT.hangup.y };
}

export function findMainWindow(windows) {
  return windows.find((window) => window.name === QQ_LAYOUT.mainWindow) ?? null;
}

export function findCallWindow(windows) {
  return windows.find((window) => QQ_LAYOUT.callWindow.test(window.name ?? '')) ?? null;
}

/** Dismiss any popup (member picker, menus) before driving the UI. */
function dismissPopups() {
  try {
    execFileSync('osascript', ['-e', 'tell application "System Events" to key code 53'], { stdio: 'ignore' });
    execFileSync('osascript', ['-e', 'tell application "System Events" to key code 53'], { stdio: 'ignore' });
  } catch {
    // Escape is best effort.
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
  await sleep(1600);
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

export async function waitCallEnd(bins, timeoutMs = 30 * 60_000) {
  return waitFor(() => (findCallWindow(listWindows(bins, QQ_LAYOUT.owner)) ? null : true), {
    timeoutMs,
    intervalMs: 1000,
  });
}
