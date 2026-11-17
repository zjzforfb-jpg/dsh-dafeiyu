/**
 * QQ 兜底发件箱：机器人「主动消息」发群会被 QQ 拒（error 40034105），
 * 但群里有新消息时（被动回复窗口）能发。所以发不出去的先排队，
 * 等这个会话下一条消息进来时带着 msgId 补发。
 */
export function initOutbox(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS qq_outbox(
    id INTEGER PRIMARY KEY AUTOINCREMENT, conv_kind TEXT NOT NULL, conv_id TEXT NOT NULL,
    text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', dedupe_key TEXT UNIQUE,
    created_at INTEGER NOT NULL, sent_at INTEGER);`);
}

export function queueOutbox(db, { kind, id, text, key = null, now = Date.now() } = {}) {
  if (!kind || !id || !text) return false;
  const dedupe = key ?? `out:${kind}:${id}:${text.slice(0, 40)}`;
  const result = db.prepare("INSERT OR IGNORE INTO qq_outbox(conv_kind,conv_id,text,status,dedupe_key,created_at) VALUES(?,?,?,'queued',?,?)")
    .run(kind, id, String(text), dedupe, now);
  return result.changes === 1;
}

export function pendingOutbox(db, kind, id, limit = 5) {
  return db.prepare("SELECT id, text FROM qq_outbox WHERE conv_kind=? AND conv_id=? AND status='queued' ORDER BY id ASC LIMIT ?")
    .all(kind, id, Math.max(1, Math.min(20, Number(limit) || 5)));
}

export function markOutboxSent(db, id, now = Date.now()) {
  db.prepare("UPDATE qq_outbox SET status='sent', sent_at=? WHERE id=?").run(now, id);
}

export function outboxSize(db) {
  return Number(db.prepare("SELECT COUNT(*) AS n FROM qq_outbox WHERE status='queued'").get()?.n ?? 0);
}
