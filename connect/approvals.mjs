/**
 * 发布前审批流：把「要发的内容」发到 QQ 群/QQ 好友，等人回复同意。
 * 发送走 QQ 桌面客户端（机器人 API 不支持主动消息）；
 * 回执读取 connect 的 qq_messages（群全量消息模式下能收到所有人的消息）。
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ensureBinaries, click, sleep, waitFor } from './macui/index.mjs';
import { openChat } from './macui/qq.mjs';
import { loadTargets } from './targets.mjs';

const INPUT = { x: 480, y: 840 };
const APPROVE = /^(同意|可以发|可以|发吧|批准|没问题|ok)$/iu;

import { ensureColumns } from './core/migrations.mjs';

export function approvalDir(root) {
  return join(root, 'runtime', 'douyin', 'approvals');
}

export function initApprovalLedger(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS approvals(
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    task_id TEXT,
    approver_peer_id TEXT NOT NULL,
    approver_role TEXT NOT NULL DEFAULT 'owner',
    decision TEXT NOT NULL DEFAULT 'pending',
    channel TEXT NOT NULL DEFAULT 'qq',
    message_id TEXT UNIQUE,
    operations_json TEXT NOT NULL DEFAULT '[]',
    sent_ms INTEGER NOT NULL,
    expires_ms INTEGER NOT NULL,
    decided_ms INTEGER,
    used_ms INTEGER
  );
  CREATE INDEX IF NOT EXISTS approvals_pending ON approvals(decision, approver_peer_id, expires_ms);`);
  ensureColumns(db, 'approvals', ['operations_json','used_ms']);
}

export function createApprovalRecord(db, { id, code, ownerId, taskId = null, operations = [], sentMs = Date.now(), timeoutMs = 15 * 60_000 }) {
  initApprovalLedger(db);
  if (!id || !code || !ownerId || !Number.isSafeInteger(sentMs) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0
    || !Array.isArray(operations) || operations.some((name) => typeof name !== 'string' || !name)) throw new Error('invalid_approval_request');
  db.prepare(`INSERT INTO approvals(id,code,task_id,approver_peer_id,operations_json,sent_ms,expires_ms)
    VALUES(?,?,?,?,?,?,?)`).run(id, code, taskId, ownerId, JSON.stringify(operations), sentMs, sentMs + timeoutMs);
  return db.prepare('SELECT * FROM approvals WHERE id=?').get(id);
}

/** 把审批请求发到 QQ（群或好友），文本 + 可选配图。 */
export async function sendApprovalRequest({ root = process.cwd(), target = '大肥鱼小可爱', title = '', caption = '', imageFile = null, note = '', approvalRequired = true, taskId = null, operations = [], timeoutMs = 15 * 60_000 }) {
  const ownerId = approvalRequired ? loadTargets(root).qq.dad : null;
  if (approvalRequired && !ownerId) throw new Error('qq_owner_not_configured');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('invalid_approval_timeout');
  const bins = ensureBinaries(root);
  const main = await openChat(bins, target);
  if (!main) throw new Error('qq_window_missing');
  const requestId = approvalRequired ? `approval_${randomUUID()}` : null;
  const code = requestId ? requestId.slice(-12).toUpperCase() : null;

  const text = [
    approvalRequired
      ? `【发布审批 ${code}】请爸爸在 QQ 私聊回复「同意 ${code}」或「不行 ${code}」。当前只有这一条待审时也可直接回复「同意」或「不行」。`
      : '【进展通知】',
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
  const sentAt = Date.now();
  execFileSync('osascript', ['-e', 'tell application "System Events" to key code 36']);
  await sleep(1200);
  if (approvalRequired) {
    const db = new DatabaseSync(join(root, 'runtime', 'connect', 'connect.sqlite'));
    try { createApprovalRecord(db, { id: requestId, code, ownerId, taskId, operations, sentMs: sentAt, timeoutMs }); }
    finally { db.close(); }
  }
  return { sentAt, target, text, requestId, code };
}

export function claimApprovalDecision(db, { requestId, ownerId, now = Date.now() }) {
  initApprovalLedger(db);
  const request = db.prepare('SELECT * FROM approvals WHERE id=? AND approver_peer_id=?').get(requestId, ownerId);
  if (!request || request.decision !== 'pending' || request.approver_role !== 'owner') return null;
  const rows = db.prepare(`SELECT id, text, created_ms FROM qq_messages
    WHERE conv_kind='c2c' AND conv_id=? AND (author IS NULL OR author=conv_id)
      AND created_ms>=? AND created_ms<?
    ORDER BY created_ms DESC, rowid DESC LIMIT 30`).all(ownerId, request.sent_ms, Math.min(now + 1, request.expires_ms));
  for (const row of rows) {
    const match = String(row.text ?? '').trim().match(/^(同意|可以发|可以|发吧|批准|没问题|ok|不行|不发|别发|不用|驳回|no)(?:\s+([A-Za-z0-9_-]+))?$/iu);
    if (!match) continue;
    const code = match[2]?.toUpperCase() ?? null;
    if (code && code !== request.code) continue;
    if (!code) {
      const pending = db.prepare(`SELECT COUNT(*) AS count FROM approvals
        WHERE approver_peer_id=? AND sent_ms<=? AND expires_ms>?`)
        .get(ownerId, row.created_ms, row.created_ms).count;
      if (pending !== 1) continue;
    }
    const decision = APPROVE.test(match[1]) ? 'approved' : 'rejected';
    const changed = db.prepare(`UPDATE OR IGNORE approvals
      SET decision=?,message_id=?,decided_ms=?
      WHERE id=? AND decision='pending' AND message_id IS NULL`)
      .run(decision, row.id, row.created_ms, requestId).changes;
    if (changed) return { approved: decision === 'approved', text: row.text, at: row.created_ms, author: ownerId, requestId, messageId: row.id };
  }
  if (now >= request.expires_ms) {
    db.prepare("UPDATE approvals SET decision='expired' WHERE id=? AND decision='pending'").run(requestId);
  }
  return null;
}

/** 打开 connect 库，轮询主人私聊是否做出决定。 */
export async function waitApproval({ root = process.cwd(), requestId, ownerId = loadTargets(root).qq.dad, timeoutMs = 15 * 60_000, intervalMs = 5000 } = {}) {
  const dbFile = join(root, 'runtime', 'connect', 'connect.sqlite');
  if (!ownerId) throw new Error('qq_owner_not_configured');
  if (!requestId) throw new Error('approval_request_required');
  const result = await waitFor(() => {
    if (!existsSync(dbFile)) return null;
    const db = new DatabaseSync(dbFile);
    try {
      return claimApprovalDecision(db, { requestId, ownerId });
    } finally {
      db.close();
    }
  }, { timeoutMs, intervalMs, label: 'approval' });
  if (!result) {
    const db = new DatabaseSync(dbFile);
    try {
      initApprovalLedger(db);
      db.prepare("UPDATE approvals SET decision='expired' WHERE id=? AND decision='pending'").run(requestId);
    } finally { db.close(); }
  }
  return result;
}
