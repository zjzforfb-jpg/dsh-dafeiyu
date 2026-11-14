import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import WebSocket from 'ws';
import { initInbox, saveContact, policy, acceptDeviceEvent } from '../connect/inbox.mjs';
import { startConnect } from '../connect/server.mjs';

test('inbox enforces explicit device contact, current policy, freshness, non-group and immutable receipts', () => {
  const db = new DatabaseSync(':memory:'); initInbox(db);
  const devices = { honor_magic5: 'a', other: 'b' };
  const input = { id: 'dad', device_id: 'honor_magic5', label: 'Dad', wechat_title: 'Allowed Dad' };
  saveContact(db, input, devices);
  assert.throws(() => saveContact(db, { ...input, id: 'duplicate' }, devices));
  assert.throws(() => saveContact(db, { ...input, device_id: 'other' }, devices));
  assert.throws(() => saveContact(db, { ...input, enabled: 'false' }, devices));
  const event = { id: 'notification1', event: 'wechat.notification', payload: { contact_id: 'dad', title: 'Allowed Dad', text: '[2条]Allowed Dad: test content', group: false, aggregate_count: 2, policy_revision: policy(db,'honor_magic5').revision, occurred_at: new Date().toISOString() } };
  assert.equal(acceptDeviceEvent(db, 'other', event).accepted, false);
  assert.equal(acceptDeviceEvent(db, 'honor_magic5', { ...event, payload: { ...event.payload, group: true } }).accepted, false);
  assert.equal(acceptDeviceEvent(db, 'honor_magic5', { ...event, payload: { ...event.payload, policy_revision: 0 } }).accepted, false);
  assert.equal(acceptDeviceEvent(db, 'honor_magic5', { ...event, payload: { ...event.payload, occurred_at: new Date(0).toISOString() } }).accepted, false);
  assert.equal(acceptDeviceEvent(db, 'honor_magic5', event).accepted, true);
  assert.equal(acceptDeviceEvent(db, 'honor_magic5', event).duplicate, true);
  assert.equal(acceptDeviceEvent(db, 'other', event).accepted, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM communication_events').get().n, 1);
  assert.equal(JSON.parse(db.prepare('SELECT payload FROM communication_events').get().payload).aggregate_count, 2);
  saveContact(db, { ...input, enabled: false }, devices);
  assert.equal(acceptDeviceEvent(db, 'honor_magic5', { ...event, id: 'notification2' }).accepted, false);
  db.close();
});

test('M1 routes authenticated policies and notification events; listings hide content, revoked contacts cannot open', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dafeiyu-m1-'));
  const callbacks = [];
  const service = await startConnect({ root, port: 0, onEvent: event => callbacks.push(event), config: { adminToken: 'admin', devices: { honor_magic5: 'device' } } });
  const base = `http://127.0.0.1:${service.port}`;
  const headers = { authorization: 'Bearer admin', 'content-type': 'application/json' };
  const call = (path, value) => fetch(base + path, { headers, method: value ? 'POST' : 'GET', ...(value ? { body: JSON.stringify(value) } : {}) });
  const ws = new WebSocket(base.replace('http', 'ws') + '/device', { headers: { authorization: 'Bearer device', 'x-device-id': 'honor_magic5' } });
  const wait = type => new Promise((resolve,reject) => { const timer = setTimeout(() => { ws.off('message', listener); reject(new Error(`missing ${type}`)); }, 3000); const listener = raw => { const v = JSON.parse(raw); if(v.type === type) { clearTimeout(timer); ws.off('message', listener); resolve(v); } }; ws.on('message', listener); });
  try {
    await once(ws, 'open');
    let pending = wait('policy'); ws.send(JSON.stringify({ type: 'register', device_id: 'honor_magic5', model: 'test' })); await pending;
    const contact = { id: 'dad', device_id: 'honor_magic5', label: 'Dad', wechat_title: 'Allowed Dad' };
    pending = wait('policy'); assert.equal((await call('/contacts', contact)).status, 200); const p = await pending; assert.equal(p.contacts[0].id, 'dad');
    ws.send(JSON.stringify({ type: 'policy_ack', device_id: 'honor_magic5', revision: p.revision, notification_access: true, version: '0.2.0' }));
    const incoming = { type: 'event', device_id: 'honor_magic5', id: 'm1note', event: 'wechat.notification', payload: { contact_id: 'dad', title: 'Allowed Dad', text: 'private preview', group: false, policy_revision: p.revision, occurred_at: new Date().toISOString(), can_open: true } };
    pending = wait('event_ack'); ws.send(JSON.stringify(incoming));
    assert.equal((await pending).accepted, true);
    pending = wait('event_ack'); ws.send(JSON.stringify(incoming)); assert.equal((await pending).duplicate, true);
    assert.equal(callbacks.length, 1);
    assert.equal(Object.hasOwn(callbacks[0], 'payload'), false);
    const listing = await (await call('/events')).json(); assert.equal(listing.events.length, 1); assert.equal(JSON.stringify(listing).includes('private preview'), false);
    const detail = await (await call('/events/m1note')).json(); assert.equal(detail.payload.text, 'private preview'); assert.equal(detail.payload.identity_verified, false);
    const command = { id: 'open1', device_id: 'honor_magic5', action: 'wechat.open_notification', payload: { event_id: 'm1note', contact_id: 'dad' }, expires_at: new Date(Date.now()+20000).toISOString() };
    pending = wait('command'); assert.equal((await call('/commands', command)).status, 202); await pending;
    pending = wait('policy'); await call('/contacts', { ...contact, enabled: false }); await pending;
    assert.equal((await call('/commands', { ...command, id: 'open2' })).status, 403);
  } finally { ws.terminate(); await service.close(); rmSync(root, { recursive: true, force: true }); }
});
