import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { startConnect } from '../connect/server.mjs';

test('Connect authenticates, dispatches once, records receipts, rejects expiry and handles disconnect', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dafeiyu-connect-'));
  const config = { adminToken: 'admin', devices: { honor_magic5: 'device-secret' } };
  const service = await startConnect({ root, port: 0, config });
  const base = `http://127.0.0.1:${service.port}`;
  const headers = { authorization: 'Bearer admin', 'content-type': 'application/json' };
  const call = (path, data) => fetch(base + path, { method: data ? 'POST' : 'GET', headers, ...(data ? { body: JSON.stringify(data) } : {}) });
  let socket;
  try {
    assert.equal((await fetch(base + '/devices')).status, 401);
    const bad = new WebSocket(base.replace('http', 'ws') + '/device', { headers: { 'x-device-id': 'honor_magic5', authorization: 'Bearer wrong' } });
    await new Promise(resolve => bad.once('error', resolve));
    const command = { id: 'one', device_id: 'honor_magic5', action: 'app.launch', payload: { app: 'settings' }, expires_at: new Date(Date.now() + 20000).toISOString() };
    assert.equal((await call('/commands', command)).status, 409);
    socket = new WebSocket(base.replace('http', 'ws') + '/device', { headers: { 'x-device-id': 'honor_magic5', authorization: 'Bearer device-secret' } });
    await once(socket, 'open');
    const ack = once(socket, 'message');
    const policyAck = new Promise(resolve => { const listener = raw => { if (JSON.parse(raw).type === 'policy') { socket.off('message', listener); resolve(); } }; socket.on('message', listener); });
    socket.send(JSON.stringify({ type: 'register', device_id: 'honor_magic5', model: 'test' })); await ack; await policyAck;
    assert.equal((await (await call('/devices')).json()).devices[0].online, true);
    assert.equal((await call('/commands', { ...command, expires_at: new Date(0).toISOString() })).status, 400);
    assert.equal((await call('/commands', { ...command, payload: { app: 'unlisted' } })).status, 400);
    const received = once(socket, 'message');
    assert.equal((await call('/commands', command)).status, 202);
    assert.equal(JSON.parse((await received)[0]).id, 'one');
    assert.equal((await (await call('/commands', command)).json()).duplicate, true);
    assert.equal((await call('/commands', { ...command, payload: { app: 'wechat' } })).status, 409);
    const receipt = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'result', device_id: 'honor_magic5', id: 'one', ok: true, result: { code: 'launch_requested' } })); await receipt;
    assert.equal((await (await call('/commands/one')).json()).status, 'succeeded');
    await call('/commands', { ...command, id: 'two' });
    socket.close(); await once(socket, 'close');
    const result = await (await call('/commands/two')).json();
    assert.equal(result.status, 'unknown');
  } finally { socket?.terminate(); await service.close(); rmSync(root, { recursive: true, force: true }); }
});
