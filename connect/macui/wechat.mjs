/** 微信桌面端的最小 UI 自动化：打开会话、发起语音通话、判断通话窗口。 */
import { execFileSync } from 'node:child_process';
import { ensureBinaries, listWindows, click, activate } from './index.mjs';

const APP = 'WeChat';

function wechatWindows(root) {
  const bins = ensureBinaries(root);
  const seen = new Map();
  for (const owner of ['微信', 'WeChat']) {
    for (const w of listWindows(bins, owner)) if (!seen.has(w.id)) seen.set(w.id, w);
  }
  return [...seen.values()];
}

export function findWechatWindow(root) {
  return wechatWindows(root).find((w) => /微信|WeChat/u.test(w.name ?? '')) ?? wechatWindows(root)[0] ?? null;
}

export function findCallWindow(root) {
  return wechatWindows(root).find((w) => /语音通话|视频通话/u.test(w.name ?? '')) ?? null;
}

export async function openChat(root, name) {
  const bins = ensureBinaries(root);
  const win = findWechatWindow(root);
  if (!win) throw new Error('wechat_window_missing');
  activate(APP);
  await new Promise((r) => setTimeout(r, 700));
  const x = win.x;
  const y = win.y;
  click(bins, x + 120, y + 28); // 搜索框
  await new Promise((r) => setTimeout(r, 500));
  execFileSync('pbcopy', { input: name });
  execFileSync('osascript', ['-e', 'tell application "System Events" to keystroke "v" using {command down}']);
  await new Promise((r) => setTimeout(r, 900));
  execFileSync('osascript', ['-e', 'tell application "System Events" to key code 36']); // Enter
  await new Promise((r) => setTimeout(r, 1200));
  return { window: win.id };
}

export async function startVoiceCall(root) {
  const bins = ensureBinaries(root);
  const win = findWechatWindow(root);
  if (!win) throw new Error('wechat_window_missing');
  click(bins, win.x + 1074, win.y + 27); // 右上角电话图标
  await new Promise((r) => setTimeout(r, 2200));
  const call = findCallWindow(root);
  if (!call) throw new Error('wechat_call_window_missing');
  return call;
}
