import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer, WebSocket } from 'ws';
import { IlinkGateway } from './ilink/gateway.mjs';
import { initInbox, contacts, policy, saveContact, acceptDeviceEvent, eventRows } from './inbox.mjs';
import { loadQqConfig, QqApi } from './qq/api.mjs';
import { openQqMemory } from './qq/memory.mjs';
import { QqService } from './qq/service.mjs';
import { CALL_PAGE, CallService } from './call/service.mjs';
import { buildFeed } from './messages/feed.mjs';
import { MESSAGES_PAGE } from './messages/page.mjs';
import { peer as qqPeer, savePeer as saveQqPeer, peers as qqPeers } from './qq/store.mjs';
import { LocalVoice } from './voice/local.mjs';

export const APPS = Object.freeze({ settings: 'com.android.settings', wechat: 'com.tencent.mm', douyin: 'com.ss.android.ugc.aweme', companion: 'com.dafeiyu.companion' });
export function loadConnectConfig(root) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const file = join(root, 'credentials.json');
  if (!existsSync(file)) writeFileSync(file, JSON.stringify({ adminToken: randomBytes(32).toString('hex'), devices: { honor_magic5: randomBytes(32).toString('hex') } }, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
  return JSON.parse(readFileSync(file, 'utf8'));
}
function equal(a, b) { return typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
function json(res, status, data) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); }
async function body(req) {
  let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 16384) throw new Error('request too large'); }
  return JSON.parse(raw);
}
const iqPeer = data => Boolean(data) && ['c2c', 'group'].includes(data.kind) && typeof data.id === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(data.id);
const allowedQqPeer = (db, kind, id) => { const value = qqPeer(db, kind, id); return Boolean(value?.enabled && value.autoReply); };
export async function startConnect({ root, port = 8765, config = loadConnectConfig(root), onEvent = async () => {}, ilinkClient, askIlink, askQq, askCall, voiceRoot, home = null, qq: qqEnabled = true }) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(root, 'connect.sqlite'));
  chmodSync(join(root, 'connect.sqlite'), 0o600);
  db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, model TEXT, last_seen TEXT);
    CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, action TEXT NOT NULL, payload TEXT NOT NULL,
    status TEXT NOT NULL, expires_at TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    UPDATE commands SET status='unknown' WHERE status='dispatched';`);
  initInbox(db);
  db.prepare("DELETE FROM communication_events WHERE created_at < datetime('now','-7 days')").run();
  const ilink = new IlinkGateway({db,root,voiceRoot,client:ilinkClient,ask:askIlink});
  const localVoice = new LocalVoice({ root: voiceRoot ?? join(root, 'voice') });
  const calls = new CallService({ voice: localVoice, ask: askCall ?? (async () => { throw new Error('call_brain_not_configured'); }), log: value => console.error(JSON.stringify(value)) });
  let qq = null, qqError = null, qqMemory = null;
  if (qqEnabled && home) { try { qqMemory = openQqMemory(home); } catch (error) { qqError = `memory:${error.message}`; } }
  if (qqEnabled) {
    try {
      const credentials = loadQqConfig(root);
      if (credentials) {
        qq = new QqService({ db, voice: localVoice, api: new QqApi(credentials), ask: askQq ?? (async () => { throw new Error('qq_brain_not_configured'); }), WebSocketImpl: WebSocket, memory: qqMemory, home, groupReplyRate: Number(process.env.QQ_GROUP_REPLY_RATE ?? 0.08), groupCooldownMs: Number(process.env.QQ_GROUP_COOLDOWN_MS ?? 90000), log: value => console.error(JSON.stringify(value)) });
        qq.start().catch(error => { qqError = error.message; });
      }
    } catch (error) { qqError = error.message; }
  }
  const sessions = new Map();
  const sendPolicy = id => {
    const ws = sessions.get(id);
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(policy(db, id)));
  };
  const snapshot = () => Object.keys(config.devices).map(id => ({ id, online: sessions.has(id), connected_at: sessions.get(id)?.connectedAt ?? null, ...(db.prepare('SELECT model, last_seen FROM devices WHERE id=?').get(id) ?? {}), capabilities: JSON.parse(db.prepare('SELECT capabilities FROM device_capabilities WHERE device_id=?').get(id)?.capabilities ?? '{}'), policy_revision: policy(db,id).revision }));
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path.startsWith('/ilink/bind/') && await ilink.public(req,res,path,body,server.address().port)) return;
    if (path === '/health' && req.method === 'GET') return json(res, 200, { ok: true, service: 'DaFeiYu Connect', version: '0.3' });
    if (path === '/call' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(CALL_PAGE); }
    if (path === '/messages' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(MESSAGES_PAGE); }
    if (!equal(req.headers.authorization, `Bearer ${config.adminToken}`)) return json(res, 401, { error: 'unauthorized' });
    if (path === '/messages/feed' && req.method === 'GET') { const params = new URL(req.url, 'http://localhost').searchParams; return json(res, 200, { items: buildFeed(db, Number(params.get('limit') ?? 60)) }); }
    if (path.startsWith('/ilink/')) return ilink.admin(req,res,path,body,server.address().port);
    if (path.startsWith('/qq/')) {
      if (!qq) return json(res, 503, { error: qqError ?? 'qq_not_configured' });
      if (path === '/qq/status' && req.method === 'GET') return json(res, 200, { running: true, ...qq.status() });
      if (path === '/qq/peers' && req.method === 'GET') return json(res, 200, { peers: qqPeers(db) });
      if (path === '/qq/peers' && req.method === 'POST') {
        try { saveQqPeer(db, await body(req)); return json(res, 200, { ok: true }); }
        catch { return json(res, 400, { error: 'invalid_qq_peer' }); }
      }
      if (path === '/qq/call' && req.method === 'POST') {
        try {
          const data = await body(req);
          if (!iqPeer(data)) return json(res, 400, { error: 'invalid_qq_peer' });
          if (data.action === 'start') { qq.calls.start(data.kind, data.id); return json(res, 200, { ok: true, calls: qq.calls.list() }); }
          if (data.action === 'end') return json(res, 200, { ok: true, ended: qq.calls.end(data.kind, data.id) });
          return json(res, 400, { error: 'invalid_qq_action' });
        } catch { return json(res, 400, { error: 'invalid_request' }); }
      }
      if (path === '/qq/messages' && req.method === 'GET') return json(res, 200, { messages: qq.messages() });
      if (path === '/qq/send' && req.method === 'POST') {
        try {
          const data = await body(req);
          if (!iqPeer(data) || typeof data.content !== 'string' || !data.content.trim()) return json(res, 400, { error: 'invalid_qq_message' });
          if (!allowedQqPeer(db, data.kind, data.id)) return json(res, 403, { error: 'qq_peer_not_allowed' });
          const result = await qq.api.sendText({ kind: data.kind, id: data.id, content: data.content });
          return json(res, 200, { ok: true, id: result.id ?? null });
        } catch (error) { return json(res, 502, { error: 'qq_send_failed' }); }
      }
      if (path === '/qq/voice' && req.method === 'POST') {
        try {
          const data = await body(req);
          if (!iqPeer(data) || typeof data.text !== 'string' || !data.text.trim()) return json(res, 400, { error: 'invalid_qq_message' });
          if (!allowedQqPeer(db, data.kind, data.id)) return json(res, 403, { error: 'qq_peer_not_allowed' });
          const { createHash } = await import('node:crypto');
          const key = createHash('sha256').update(`${Date.now()}:${data.text}`).digest('hex');
          const audio = await qq.voice.synthesize(key, data.text);
          const result = await qq.api.sendVoice({ kind: data.kind, id: data.id, silk: audio.silk, fileName: '大肥鱼语音回复.silk' });
          return json(res, 200, { ok: true, duration_ms: audio.duration_ms, id: result.id ?? null });
        } catch (error) { return json(res, 502, { error: error.message?.startsWith('daily_') ? error.message : 'qq_voice_failed' }); }
      }
      return json(res, 404, { error: 'not_found' });
    }
    if (path === '/devices' && req.method === 'GET') return json(res, 200, { devices: snapshot() });
    if (path === '/contacts' && req.method === 'GET') return json(res, 200, { contacts: contacts(db) });
    if (path === '/contacts' && req.method === 'POST') {
      try { const contact = saveContact(db, await body(req), config.devices); sendPolicy(contact.device_id); return json(res, 200, contact); }
      catch { return json(res, 400, { error: 'invalid or conflicting contact' }); }
    }
    if (path === '/events' && req.method === 'GET') return json(res, 200, { events: eventRows(db) });
    if (path.startsWith('/events/') && req.method === 'GET') {
      const row = db.prepare('SELECT * FROM communication_events WHERE id=?').get(path.slice(8));
      return json(res, row ? 200 : 404, row ? { ...row, payload: JSON.parse(row.payload) } : { error: 'not found' });
    }
    if (path.startsWith('/commands/') && req.method === 'GET') {
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(path.slice(10))) return json(res, 400, { error: 'invalid command id' });
      const row = db.prepare('SELECT * FROM commands WHERE id=?').get(path.slice(10));
      return json(res, row ? 200 : 404, row ? { ...row, payload: JSON.parse(row.payload), result: row.result ? JSON.parse(row.result) : null } : { error: 'not found' });
    }
    if (path !== '/commands' || req.method !== 'POST') return json(res, 404, { error: 'not found' });
    try {
      const data = await body(req);
      if (typeof data.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(data.id) || !Object.hasOwn(config.devices, data.device_id)) return json(res, 400, { error: 'invalid command id or device' });
      if (!['device.ping', 'device.capabilities', 'device.diagnostic', 'wechat.scan_notifications', 'app.launch', 'wechat.open_notification'].includes(data.action)) return json(res, 400, { error: 'unsupported action' });
      const payload = data.action === 'app.launch' ? { app: data.payload?.app } : data.action === 'wechat.open_notification' ? { event_id: data.payload?.event_id, contact_id: data.payload?.contact_id } : {};
      if (data.action === 'app.launch' && !Object.hasOwn(APPS, payload.app)) return json(res, 400, { error: 'app not allowed' });
      if (data.action === 'wechat.open_notification') {
        const event = db.prepare("SELECT * FROM communication_events WHERE id=? AND device_id=? AND contact_id=? AND kind='wechat.notification'").get(payload.event_id ?? '', data.device_id, payload.contact_id ?? '');
        const contact = db.prepare('SELECT * FROM contacts WHERE id=? AND device_id=? AND enabled=1').get(payload.contact_id ?? '',data.device_id);
        if (!event || !contact) return json(res, 403, { error: 'contact or notification not allowed' });
      }
      const previous = db.prepare('SELECT * FROM commands WHERE id=?').get(data.id);
      if (previous) {
        if (previous.device_id !== data.device_id || previous.action !== data.action || previous.payload !== JSON.stringify(payload)) return json(res, 409, { error: 'command id already used for different request' });
        return json(res, 200, { id: previous.id, status: previous.status, duplicate: true });
      }
      const expires = Date.parse(data.expires_at);
      if (!Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + 120000) return json(res, 400, { error: 'expiry must be within 120 seconds' });
      const socket = sessions.get(data.device_id);
      if (!socket || socket.readyState !== WebSocket.OPEN) return json(res, 409, { error: 'device offline' });
      db.prepare('INSERT INTO commands(id, device_id, action, payload, status, expires_at) VALUES(?,?,?,?,?,?)').run(data.id, data.device_id, data.action, JSON.stringify(payload), 'dispatched', data.expires_at);
      socket.send(JSON.stringify({ ...data, type: 'command', payload }));
      return json(res, 202, { id: data.id, status: 'dispatched' });
    } catch { return json(res, 400, { error: 'invalid request' }); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16384 });
  const callWss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    if (req.url?.startsWith('/call/ws')) {
      const token = new URL(req.url, 'http://localhost').searchParams.get('token');
      if (!equal(token, config.adminToken)) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
      callWss.handleUpgrade(req, socket, head, ws => calls.attach(ws));
      return;
    }
    const id = req.headers['x-device-id'];
    if (req.url !== '/device' || !Object.hasOwn(config.devices, id) || !equal(req.headers.authorization, `Bearer ${config.devices[id]}`)) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      sessions.get(id)?.close(4001, 'session replaced'); sessions.set(id, ws); ws.lastSeen = Date.now(); ws.connectedAt = new Date().toISOString();
      ws.on('message', raw => {
        try {
          const value = JSON.parse(raw.toString());
          if (!value || typeof value !== 'object' || value.device_id !== id) return ws.close(1008, 'invalid device');
          if (!['register', 'heartbeat', 'result', 'event', 'policy_ack'].includes(value.type)) return ws.close(1008, 'invalid type');
          ws.lastSeen = Date.now();
          db.prepare("INSERT INTO devices(id,model,last_seen) VALUES(?,?,datetime('now')) ON CONFLICT(id) DO UPDATE SET model=COALESCE(excluded.model,model), last_seen=datetime('now')").run(id, value.type === 'register' ? String(value.model ?? '').slice(0, 120) : null);
          if (value.type === 'event') {
            const outcome = acceptDeviceEvent(db, id, value);
            if (outcome.accepted && !outcome.duplicate) Promise.resolve().then(() => onEvent({ id: value.id, device_id: id, kind: value.event })).catch(() => {});
            ws.send(JSON.stringify({ type: 'event_ack', id: value.id, ...outcome }));
          } else if (value.type === 'policy_ack') {
            const safe = { notification_access: value.notification_access === true, listener_connected: value.listener_connected === true, overlay: value.overlay === true, policy_revision: Number(value.revision) || 0, version: String(value.version ?? '').slice(0,20) };
            db.prepare("INSERT INTO device_capabilities(device_id,capabilities) VALUES(?,?) ON CONFLICT(device_id) DO UPDATE SET capabilities=excluded.capabilities, updated_at=datetime('now')").run(id, JSON.stringify(safe));
          } else if (value.type === 'result') {
            const cmd = db.prepare('SELECT * FROM commands WHERE id=? AND device_id=?').get(value.id, id);
            if (!cmd) return;
            if (['dispatched', 'unknown'].includes(cmd.status)) db.prepare('UPDATE commands SET status=?, result=? WHERE id=?').run(value.ok === true ? 'succeeded' : 'failed', JSON.stringify(value.result ?? {}), value.id);
            ws.send(JSON.stringify({ type: 'result_ack', id: value.id }));
          } else {
            ws.send(JSON.stringify({ type: 'ack', for: value.type, server_time: new Date().toISOString() }));
            if (value.type === 'register') sendPolicy(id);
          }
        } catch { ws.close(1008, 'invalid message'); }
      });
      ws.on('error', () => {});
      ws.on('close', () => {
        if (sessions.get(id) !== ws) return;
        sessions.delete(id);
        db.prepare("UPDATE commands SET status='unknown' WHERE device_id=? AND status='dispatched'").run(id);
      });
    });
  });
  const timer = setInterval(() => {
    db.prepare('UPDATE ilink_messages SET context_token=NULL WHERE created_ms<?').run(Date.now()-600000);
    db.prepare('DELETE FROM ilink_messages WHERE created_ms<?').run(Date.now()-7*86400000);
    db.prepare('DELETE FROM ilink_cursors WHERE binding_id NOT IN (SELECT binding_id FROM ilink_accounts)').run();
    db.prepare("DELETE FROM communication_events WHERE created_at < datetime('now','-7 days')").run();
    for (const ws of sessions.values()) if (Date.now() - ws.lastSeen > 45000) ws.terminate();
    db.prepare("UPDATE commands SET status='unknown' WHERE status='dispatched' AND expires_at < ?").run(new Date().toISOString());
  }, 5000);
  timer.unref();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  qq?.setMessageUrl(`http://127.0.0.1:${server.address().port}/messages?token=${config.adminToken}`);
  return { port: server.address().port, config, close: async () => { await qq?.close(); qqMemory?.close(); await ilink.close(); calls.close(); clearInterval(timer); for (const ws of callWss.clients) ws.terminate(); for (const ws of wss.clients) ws.terminate(); callWss.close(); await new Promise(r => wss.close(r)); server.close(); server.closeAllConnections?.(); await new Promise(r => server.close(r)); db.close(); } };
}
