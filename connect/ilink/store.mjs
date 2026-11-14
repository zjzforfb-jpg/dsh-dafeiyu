import { initVoice } from '../voice/service.mjs';
import { createHash, randomUUID } from 'node:crypto';
export function initIlink(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ilink_accounts(id TEXT PRIMARY KEY,owner_peer_id TEXT NOT NULL,binding_id TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'bound',last_poll TEXT,last_error TEXT);
    CREATE TABLE IF NOT EXISTS ilink_peers(account_id TEXT NOT NULL,peer_id TEXT NOT NULL,label TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'friend',enabled INTEGER NOT NULL DEFAULT 0,auto_reply INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(account_id,peer_id));
    CREATE TABLE IF NOT EXISTS ilink_cursors(binding_id TEXT PRIMARY KEY,cursor TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ilink_messages(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,binding_id TEXT NOT NULL,peer_id TEXT NOT NULL,upstream_id TEXT NOT NULL,text TEXT NOT NULL DEFAULT '',context_token TEXT,created_ms INTEGER NOT NULL,status TEXT NOT NULL,reply TEXT,error TEXT,client_id TEXT NOT NULL,outbound_id TEXT,updated_at TEXT NOT NULL DEFAULT(datetime('now')));
    CREATE INDEX IF NOT EXISTS ilink_inbox ON ilink_messages(account_id,binding_id,status,created_ms);
    CREATE TABLE IF NOT EXISTS ilink_usage(account_id TEXT NOT NULL,day TEXT NOT NULL,model_calls INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(account_id,day));
    UPDATE ilink_messages SET status='unknown',error='process_restarted_during_send' WHERE status='sending';
    UPDATE ilink_messages SET status='failed',error='process_restarted_during_generation' WHERE status='drafting';`);
  initVoice(db);
}
export function registerAccount(db, account) {
  db.prepare('INSERT OR IGNORE INTO ilink_voice_settings(account_id) VALUES(?)').run(account.id);
  const old = db.prepare('SELECT binding_id FROM ilink_accounts WHERE id=?').get(account.id);
  if (old?.binding_id === account.bindingId) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("INSERT INTO ilink_accounts(id,owner_peer_id,binding_id) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET owner_peer_id=excluded.owner_peer_id,binding_id=excluded.binding_id,enabled=1,status='bound',last_error=NULL").run(account.id, account.ownerPeerId, account.bindingId);
    db.prepare("UPDATE ilink_voice_settings SET native_state='unverified',trial_remaining=0,verified_at=NULL,last_error=NULL WHERE account_id=?").run(account.id);
    db.prepare("UPDATE ilink_peers SET role='friend',enabled=0,auto_reply=0 WHERE account_id=?").run(account.id);
    db.prepare("INSERT INTO ilink_peers(account_id,peer_id,label,role,enabled,auto_reply) VALUES(?,?,'爸爸','owner',1,1) ON CONFLICT(account_id,peer_id) DO UPDATE SET label='爸爸',role='owner',enabled=1,auto_reply=1").run(account.id, account.ownerPeerId);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
export function ingestUpdates(db, account, response, now = Date.now()) {
  if (!Array.isArray(response.msgs ?? []) || (response.msgs?.length ?? 0) > 1000 || (response.get_updates_buf !== undefined && (typeof response.get_updates_buf !== 'string' || response.get_updates_buf.length > 1048576))) throw new Error('invalid_update_batch');
  let added = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const msg of response.msgs ?? []) {
      if (Number(msg.message_type) !== 1 || Number(msg.message_state) === 1 || msg.group_id || (msg.to_user_id && msg.to_user_id !== account.id)) continue;
      if (typeof msg.from_user_id !== 'string' || !msg.from_user_id || msg.from_user_id.length > 256) continue;
      const upstream = typeof msg.message_id === 'string' ? msg.message_id : Number.isSafeInteger(msg.message_id) ? String(msg.message_id) : null;
      if (!upstream || upstream.length > 256) continue;
      const id = createHash('sha256').update(JSON.stringify([account.id, account.bindingId, upstream])).digest('hex');
      if (db.prepare('SELECT 1 FROM ilink_messages WHERE id=?').get(id)) continue;
      db.prepare("INSERT OR IGNORE INTO ilink_peers(account_id,peer_id,label) VALUES(?,?,'待授权联系人')").run(account.id, msg.from_user_id);
      const peer = db.prepare('SELECT * FROM ilink_peers WHERE account_id=? AND peer_id=?').get(account.id, msg.from_user_id);
      const items = Array.isArray(msg.item_list) ? msg.item_list : [];
      const textOnly = items.length > 0 && items.every(i => Number(i.type) === 1 && typeof i.text_item?.text === 'string');
      const voice = items.length===1 && Number(items[0].type)===3 && items[0].voice_item && typeof items[0].voice_item==='object' ? items[0].voice_item : null;
      const voiceValid=!!voice && JSON.stringify(voice).length<=20000 && (!voice.playtime || Number(voice.playtime)<=90000);
      const text = textOnly ? items.map(i => i.text_item.text).join('\n').trim() : ''; 
      const time = Number(msg.create_time_ms);
      const fresh = Number.isFinite(time) && Math.abs(now - time) < 600000;
      const token = typeof msg.context_token === 'string' && msg.context_token.length <= 10000 ? msg.context_token : null;
      let status = !peer.enabled ? 'blocked' : (!textOnly || !text || text.length > 4000) && !voiceValid ? 'unsupported' : !fresh ? 'expired' : !token ? 'missing_context' : peer.auto_reply ? 'pending' : 'held';
      db.prepare('INSERT INTO ilink_messages(id,account_id,binding_id,peer_id,upstream_id,text,context_token,created_ms,status,client_id,error,input_kind,media_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, account.id, account.bindingId, msg.from_user_id, upstream, peer.enabled ? text.slice(0,4000) : '', peer.enabled ? token : null, Number.isFinite(time) ? time : now, status, `dafeiyu-${randomUUID()}`, ({blocked:'contact_not_authorized',unsupported:'text_only_channel',expired:'stale_or_missing_timestamp',missing_context:'context_missing'})[status] ?? null, voiceValid?'voice':'text', peer.enabled&&voiceValid ? JSON.stringify(voice) : null); added++;
    }
    if (response.get_updates_buf !== undefined) db.prepare('INSERT INTO ilink_cursors(binding_id,cursor) VALUES(?,?) ON CONFLICT(binding_id) DO UPDATE SET cursor=excluded.cursor').run(account.bindingId, response.get_updates_buf);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return added;
}
export function peerHistory(db, row) {
  return db.prepare("SELECT text,reply FROM ilink_messages WHERE account_id=? AND binding_id=? AND peer_id=? AND status='sent' ORDER BY created_ms DESC,rowid DESC LIMIT 6").all(row.account_id,row.binding_id,row.peer_id).reverse().flatMap(m => [{ role:'user',content:m.text },{ role:'assistant',content:m.reply }]);
}
export function safeAccounts(db) { return db.prepare('SELECT id,enabled,status,last_poll,last_error FROM ilink_accounts ORDER BY id').all(); }
export function safeMessages(db) { return db.prepare('SELECT id,account_id,peer_id,status,created_ms,error,input_kind,delivery_kind,audio_duration_ms FROM ilink_messages ORDER BY rowid DESC LIMIT 30').all(); }
export function authorizePeer(db, data) {
  if (typeof data.account_id !== 'string' || typeof data.peer_id !== 'string' || typeof data.label !== 'string' || !data.label.trim() || data.label.length > 80 || typeof data.enabled !== 'boolean' || typeof data.auto_reply !== 'boolean') throw new Error('invalid_peer_policy');
  const old = db.prepare('SELECT role FROM ilink_peers WHERE account_id=? AND peer_id=?').get(data.account_id,data.peer_id);
  if (!old) throw new Error('peer_not_found');
  db.prepare('UPDATE ilink_peers SET label=?,enabled=?,auto_reply=? WHERE account_id=? AND peer_id=?').run(data.label.trim(),data.enabled?1:0,data.auto_reply?1:0,data.account_id,data.peer_id);
}
