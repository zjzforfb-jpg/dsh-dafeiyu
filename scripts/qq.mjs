import { resolve } from 'node:path';
import { loadConnectConfig } from '../connect/server.mjs';

const root = resolve(import.meta.dirname, '../runtime/connect');
const base = 'http://127.0.0.1:8765';
const config = loadConnectConfig(root);
const headers = { authorization: `Bearer ${config.adminToken}`, 'content-type': 'application/json' };
const [command, kind, id, ...rest] = process.argv.slice(2);

async function call(path, init) {
  const response = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(15000), ...init });
  const value = await response.json();
  console.log(JSON.stringify(value, null, 2));
  if (!response.ok) process.exitCode = 1;
  return value;
}

const need = () => { if (!['c2c', 'group'].includes(kind) || !id) throw new Error('需要 <c2c|group> <openid>'); };
try {
  if (command === 'status') await call('/qq/status');
  else if (command === 'peers') await call('/qq/peers');
  else if (command === 'messages') await call('/qq/messages');
  else if (command === 'allow') { need(); await call('/qq/peers', { method: 'POST', body: JSON.stringify({ kind, id, label: rest.join(' ') || null, enabled: true, autoReply: true, voiceReply: true }) }); }
  else if (command === 'hold') { need(); await call('/qq/peers', { method: 'POST', body: JSON.stringify({ kind, id, enabled: true, autoReply: false, voiceReply: false }) }); }
  else if (command === 'block') { need(); await call('/qq/peers', { method: 'POST', body: JSON.stringify({ kind, id, enabled: false, autoReply: false, voiceReply: false }) }); }
  else if (command === 'call') { need(); await call('/qq/call', { method: 'POST', body: JSON.stringify({ kind, id, action: rest[0] ?? 'start' }) }); }
  else if (command === 'send') { need(); await call('/qq/send', { method: 'POST', body: JSON.stringify({ kind, id, content: rest.join(' ') }) }); }
  else if (command === 'voice') { need(); await call('/qq/voice', { method: 'POST', body: JSON.stringify({ kind, id, text: rest.join(' ') }) }); }
  else throw new Error('用法: connect:qq status|peers|messages|allow|hold|block <c2c|group> <openid>|call <c2c|group> <openid> start|end|send <c2c|group> <openid> <文本>|voice <c2c|group> <openid> <文本>');
} catch (error) { console.error(error.message); process.exitCode = 1; }
