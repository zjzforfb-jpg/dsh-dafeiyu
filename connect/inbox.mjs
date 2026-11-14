const ID = /^[a-zA-Z0-9_-]{1,100}$/;
export function initInbox(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY, device_id TEXT NOT NULL, label TEXT NOT NULL, wechat_title TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE UNIQUE INDEX IF NOT EXISTS contacts_title ON contacts(device_id,wechat_title) WHERE enabled=1;
    CREATE TABLE IF NOT EXISTS policy_meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
    INSERT OR IGNORE INTO policy_meta VALUES(1,1);
    CREATE TABLE IF NOT EXISTS communication_events (
    id TEXT PRIMARY KEY, device_id TEXT NOT NULL, contact_id TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE INDEX IF NOT EXISTS communication_recent ON communication_events(created_at);
    CREATE TABLE IF NOT EXISTS device_capabilities (device_id TEXT PRIMARY KEY, capabilities TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));`);
}
export function contacts(db, deviceId = null) {
  return deviceId ? db.prepare('SELECT * FROM contacts WHERE device_id=? ORDER BY id').all(deviceId) : db.prepare('SELECT * FROM contacts ORDER BY id').all();
}
export function policy(db, deviceId) {
  return { type: 'policy', revision: db.prepare('SELECT revision FROM policy_meta WHERE id=1').get().revision,
    contacts: contacts(db, deviceId).filter(c => c.enabled).map(c => ({ id: c.id, label: c.label, wechat_title: c.wechat_title })) };
}
export function saveContact(db, input, devices) {
  if (!input || (typeof input.id !== 'string' || !ID.test(input.id)) || !Object.hasOwn(devices, input.device_id)) throw new Error('invalid contact id or device');
  for (const field of ['label', 'wechat_title']) if (typeof input[field] !== 'string' || !input[field].trim() || input[field].length > 100 || /[\r\n\x00-\x1f]/.test(input[field])) throw new Error(`invalid ${field}`);
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('enabled must be boolean');
  const previous = db.prepare('SELECT * FROM contacts WHERE id=?').get(input.id);
  if (previous && previous.device_id !== input.device_id) throw new Error('contact belongs to another device');
  db.exec('BEGIN IMMEDIATE');
  try {
    if (input.enabled !== false && !previous?.enabled && db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE device_id=? AND enabled=1').get(input.device_id).n >= 100) throw new Error('contact limit reached');
    db.prepare(`INSERT INTO contacts(id,device_id,label,wechat_title,enabled) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      label=excluded.label,wechat_title=excluded.wechat_title,enabled=excluded.enabled,updated_at=datetime('now')`)
      .run(input.id, input.device_id, input.label.trim(), input.wechat_title.trim(), input.enabled === false ? 0 : 1);
    db.prepare('UPDATE policy_meta SET revision=revision+1 WHERE id=1').run(); db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return db.prepare('SELECT * FROM contacts WHERE id=?').get(input.id);
}
export function acceptDeviceEvent(db, deviceId, event) {
  if (typeof event.id !== 'string' || !ID.test(event.id)) return { accepted: false, reason: 'invalid_event' };
  const existing = db.prepare('SELECT device_id FROM communication_events WHERE id=?').get(event.id);
  if (existing) return { accepted: existing.device_id === deviceId, duplicate: true, reason: existing.device_id === deviceId ? null : 'event_conflict' };
  let contactId = null;
  let payload;
  if (event.event === 'wechat.notification') {
    const p = event.payload;
    const c = db.prepare('SELECT * FROM contacts WHERE id=? AND device_id=? AND enabled=1').get(p?.contact_id ?? '', deviceId);
    if (!c || p?.title !== c.wechat_title) return { accepted: false, reason: 'contact_not_allowed' };
    if (p.policy_revision !== policy(db, deviceId).revision) return { accepted: false, reason: 'stale_policy' };
    if (p.group !== false || typeof p.text !== 'string' || !p.text.trim() || p.text.length > 4000) return { accepted: false, reason: 'unsupported_notification' };
    const time = Date.parse(p.occurred_at);
    if (!Number.isFinite(time) || Math.abs(Date.now() - time) > 86400000) return { accepted: false, reason: 'stale_event' };
    contactId = c.id;
    payload = { text: p.text, title: c.wechat_title, occurred_at: p.occurred_at, source: 'android_notification', identity_verified: false, aggregate_count: Number.isInteger(p.aggregate_count) && p.aggregate_count >= 1 && p.aggregate_count <= 10000 ? p.aggregate_count : 1, can_open: p.can_open === true };
  } else if (event.event === 'device.diagnostic') {
    payload = { code: 'companion_event_pipeline_ok' };
  } else return { accepted: false, reason: 'unsupported_event' };
  db.prepare('INSERT INTO communication_events(id,device_id,contact_id,kind,payload) VALUES(?,?,?,?,?)').run(event.id, deviceId, contactId, event.event, JSON.stringify(payload));
  // Remove unneeded notification content after seven days; no raw payload is logged.
  db.prepare("DELETE FROM communication_events WHERE created_at < datetime('now','-7 days')").run();
  return { accepted: true, duplicate: false };
}
export function eventRows(db, limit = 30) {
  return db.prepare(`SELECT id,device_id,contact_id,kind,created_at FROM communication_events ORDER BY rowid DESC LIMIT ?`).all(limit);
}
