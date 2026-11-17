import { ensureColumns } from '../core/migrations.mjs';
import { budgetUsage, reserve as reserveBudget } from '../core/budget.mjs';

export function initQq(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS qq_peers(
      conv_kind TEXT NOT NULL, conv_id TEXT NOT NULL, label TEXT,
      enabled INTEGER NOT NULL DEFAULT 1, auto_reply INTEGER NOT NULL DEFAULT 1, voice_reply INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(conv_kind, conv_id));
    CREATE TABLE IF NOT EXISTS qq_messages(
      id TEXT PRIMARY KEY, conv_kind TEXT NOT NULL, conv_id TEXT NOT NULL, msg_id TEXT UNIQUE,
      input_kind TEXT NOT NULL DEFAULT 'text', text TEXT, reply TEXT, status TEXT NOT NULL DEFAULT 'pending',
      error TEXT, delivery_kind TEXT, audio_duration_ms INTEGER, created_ms INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS qq_usage(
      day TEXT PRIMARY KEY, model_calls INTEGER NOT NULL DEFAULT 0, voice_requests INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS qq_members(
      conv_kind TEXT NOT NULL, conv_id TEXT NOT NULL, member_id TEXT NOT NULL, label TEXT NOT NULL,
      seen_ms INTEGER NOT NULL, PRIMARY KEY(conv_kind, conv_id, member_id));
    UPDATE qq_messages SET status='unknown', error='restart_interrupted' WHERE status IN ('transcribing','synthesizing','sending');`);
  ensureColumns(db, 'qq_messages', ['author']);
  ensureColumns(db, 'qq_peers', ['role']);
}

export function syncQqOwner(db, ownerId) {
  initQq(db);
  const valid = typeof ownerId === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(ownerId);
  db.prepare("UPDATE qq_peers SET role='friend' WHERE role='owner'").run();
  if (valid) {
    db.prepare("UPDATE qq_peers SET role='owner' WHERE conv_kind='c2c' AND conv_id=?").run(ownerId);
  }
}

function validKind(kind) {
  if (!['c2c', 'group'].includes(kind)) throw new Error('invalid_qq_conversation');
}

export function savePeer(db, { kind, id, label, enabled = true, autoReply = true, voiceReply = true }) {
  validKind(kind);
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(id)) throw new Error('invalid_qq_conversation_id');
  db.prepare(`INSERT INTO qq_peers(conv_kind, conv_id, label, enabled, auto_reply, voice_reply) VALUES(?,?,?,?,?,?)
    ON CONFLICT(conv_kind, conv_id) DO UPDATE SET label=COALESCE(excluded.label, label), enabled=excluded.enabled,
    auto_reply=excluded.auto_reply, voice_reply=excluded.voice_reply`).run(kind, id, typeof label === 'string' ? label.slice(0, 80) : null, enabled ? 1 : 0, autoReply ? 1 : 0, voiceReply ? 1 : 0);
  return peer(db, kind, id);
}

export function peer(db, kind, id) {
  return db.prepare('SELECT conv_kind AS kind, conv_id AS id, label, role, enabled, auto_reply AS autoReply, voice_reply AS voiceReply FROM qq_peers WHERE conv_kind=? AND conv_id=?').get(kind, id) ?? null;
}

export function peers(db) {
  return db.prepare('SELECT conv_kind AS kind, conv_id AS id, label, role, enabled, auto_reply AS autoReply, voice_reply AS voiceReply FROM qq_peers ORDER BY kind, id').all();
}

export function logInbound(db, { id, kind, convId, msgId, inputKind, text, createdMs, author = null }) {
  const result = db.prepare(`INSERT OR IGNORE INTO qq_messages(id, conv_kind, conv_id, msg_id, input_kind, text, status, created_ms, author)
    VALUES(?,?,?,?,?,?,'pending',?,?)`).run(id, kind, convId, msgId ?? null, inputKind, text ?? null, createdMs, typeof author === 'string' ? author.slice(0, 64) : null);
  return result.changes > 0;
}

/** 群成员的稳定称呼：第一次见到时分配「群友1」「群友2」…，之后固定。 */
export function memberLabel(db, kind, convId, memberId, now = Date.now()) {
  if (typeof memberId !== 'string' || !memberId) return '群友';
  const row = db.prepare('SELECT label FROM qq_members WHERE conv_kind=? AND conv_id=? AND member_id=?').get(kind, convId, memberId);
  if (row) { db.prepare('UPDATE qq_members SET seen_ms=? WHERE conv_kind=? AND conv_id=? AND member_id=?').run(now, kind, convId, memberId); return row.label; }
  const count = db.prepare('SELECT COUNT(*) AS n FROM qq_members WHERE conv_kind=? AND conv_id=?').get(kind, convId).n;
  const label = `群友${count + 1}`;
  db.prepare('INSERT INTO qq_members(conv_kind, conv_id, member_id, label, seen_ms) VALUES(?,?,?,?,?)').run(kind, convId, memberId, label, now);
  return label;
}

/** 群聊上下文：包含尚未回复的消息和自己的回复，按时间正序，带发言人。 */
export function groupTranscript(db, convId, limit = 16, excludeId = null) {
  const rows = db.prepare(`SELECT text, reply, author, created_ms FROM qq_messages WHERE conv_kind='group' AND conv_id=? AND text IS NOT NULL AND id != ? ORDER BY created_ms DESC LIMIT ?`).all(convId, excludeId ?? '', limit);
  return rows.reverse().map(row => ({ text: row.text ?? '', reply: row.reply ?? null, author: row.author ?? null, time: row.created_ms }));
}

export function updateMessage(db, id, fields) {
  const allowed = ['text', 'reply', 'status', 'error', 'delivery_kind', 'audio_duration_ms'];
  const keys = Object.keys(fields).filter(k => allowed.includes(k));
  if (!keys.length) return;
  db.prepare(`UPDATE qq_messages SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=?`).run(...keys.map(k => fields[k]), id);
}

export function messageRow(db, id) {
  return db.prepare('SELECT * FROM qq_messages WHERE id=?').get(id) ?? null;
}

export function recentMessages(db, limit = 20) {
  return db.prepare('SELECT id, conv_kind AS kind, conv_id AS id, msg_id, input_kind, text, reply, status, error, delivery_kind, audio_duration_ms, created_ms FROM qq_messages ORDER BY created_ms DESC LIMIT ?').all(limit);
}

export function conversationHistory(db, kind, convId, limit = 12) {
  const rows = db.prepare(`SELECT text, reply, created_ms FROM qq_messages WHERE conv_kind=? AND conv_id=? AND reply IS NOT NULL AND status IN ('sent','failed','unknown') ORDER BY created_ms DESC LIMIT ?`).all(kind, convId, limit);
  return rows.reverse().flatMap(row => [{ role: 'user', content: row.text ?? '' }, { role: 'assistant', content: row.reply }]);
}

export function dayKey(now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}

/**
 * D-2：QQ 的日配额并入统一预算（connect/core/budget.mjs 的 daily_budget）。
 * QQ 与 iLink、life 占用的是同一格累计——不再各记各的。
 * limit 是可选的调用方自设封顶（与统一上限取更小值），老调用点语义不变。
 */
export function reserve(db, day, column, limit) {
  if (!['model_calls', 'voice_requests'].includes(column)) throw new Error('invalid_qq_budget');
  return reserveBudget(db, day, column, limit ?? null);
}

export function usage(db, day) {
  const row = budgetUsage(db, day);
  return { day, model_calls: row.model_calls ?? 0, voice_requests: row.voice_requests ?? 0 };
}
