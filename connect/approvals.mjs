/**
 * 发布前审批流：把「要发的内容」发到 QQ 群/QQ 好友，等人回复同意。
 * 发送走 QQ 桌面客户端（机器人 API 不支持主动消息）；
 * 回执读取 connect 的 qq_messages（群全量消息模式下能收到所有人的消息）。
 */
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ensureBinaries, listWindows, click, sleep, waitFor } from './macui/index.mjs';
import { findMainWindow, openChat, QQ_LAYOUT } from './macui/qq.mjs';

const INPUT = { x: 480, y: 840 };
const APPROVE = /(同意|可以发|可以|发吧|批准|没问题|ok|OK)/u;

export function approvalDir(root) {
  return join(root, 'runtime', 'douyin', 'approvals');
}

/** 把审批请求发到 QQ（群或好友），文本 + 可选配图。 */
export async function sendApprovalRequest({ root = process.cwd(), target = '大肥鱼小可爱', title = '', caption = '', imageFile = null, note = '' }) {
  const bins = ensureBinaries(root);
  const main = await openChat(bins, target);
  if (!main) throw new Error('qq_window_missing');

  const text = [
    '【发布审批】大肥鱼想发一条抖音图文，请回复「同意」或「不行」。',
    title ? `标题：${title}` : '',
    caption ? `正文：${caption}` : '',
    note ? `备注：${note}` : '',
    `（请求时间 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}）`,
  ].filter(Boolean).join('\n');

  const input = { x: main.x + INPUT.x, y: main.y + INPUT.y };
  if (imageFile && existsSync(imageFile)) {
    execFileSync('osascript', ['-e', `set the clipboard to (read (POSIX file "${imageFile}") as picture)`]);
    click(bins, input.x, input.y);
    await sleep(600);
    execFileSync('osascript', ['-e', 'tell application "System Events" to keystroke "v" using {command down}']);
    await sleep(1500);
  }
  execFileSync('pbcopy', { input: text });
  click(bins, input.x, input.y);
  await sleep(500);
  execFileSync('osascript', ['-e', 'tell application "System Events" to keystroke "v" using {command down}']);
  await sleep(900);
  execFileSync('osascript', ['-e', 'tell application "System Events" to key code 36']);
  await sleep(1200);
  return { sentAt: Date.now(), target, text };
}

/** 打开 connect 库，轮询是否有人同意。 */
export function waitApproval({ root = process.cwd(), sinceMs, convId = loadTargets(root).qq.group, timeoutMs = 15 * 60_000, intervalMs = 5000 } = {}) {
  const dbFile = join(root, 'runtime', 'connect', 'connect.sqlite');
  return waitFor(() => {
    if (!existsSync(dbFile)) return null;
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      const rows = db.prepare(
        `SELECT text, created_ms, author FROM qq_messages
         WHERE conv_id = ? AND created_ms >= ? AND text IS NOT NULL AND LENGTH(text) > 0
         ORDER BY created_ms DESC LIMIT 30`,
      ).all(convId, String(sinceMs));
      const hit = rows.find((row) => APPROVE.test(row.text));
      if (hit) return { approved: true, text: hit.text, at: hit.created_ms, author: hit.author ?? '' };
      const refused = rows.find((row) => /(不行|不发|别发|不用|驳回|no)/iu.test(row.text));
      if (refused) return { approved: false, text: refused.text, at: refused.created_ms, author: refused.author ?? '' };
      return null;
    } finally {
      db.close();
    }
  }, { timeoutMs, intervalMs, label: 'approval' });
}
