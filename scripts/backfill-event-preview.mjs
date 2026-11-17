#!/usr/bin/env node
/**
 * 把历史事件补上 preview（消息前 80 字）。
 *
 * P2 之后 message_received / message_replied 的 payload 里才有 preview；
 * 更早的事件只有 text_length，页面上看不到说了什么。这里按
 * `message_id` 回查 qq_messages / ilink_messages 的原文补进去，只补空的、可重复执行。
 *
 *   node scripts/backfill-event-preview.mjs           # 真写
 *   node scripts/backfill-event-preview.mjs --dry     # 只看会改多少条
 */
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dry = process.argv.includes('--dry');
const clip = (text, max = 80) => {
  const flat = String(text ?? '').replace(/\s+/gu, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

const db = new DatabaseSync(resolve(root, 'runtime/connect/connect.sqlite'));
const byMsgId = (table, id) => {
  if (!id) return null;
  // qq_messages 用 id 与 msg_id 两个键；ilink_messages 用 id 与 upstream_id。
  const columns = table === 'qq_messages' ? ['id', 'msg_id'] : ['id', 'upstream_id'];
  for (const column of columns) {
    try {
      const row = db.prepare(`SELECT text, reply FROM ${table} WHERE ${column} = ? LIMIT 1`).get(id);
      if (row) return row;
    } catch { /* 列不存在就试下一个 */ }
  }
  return null;
};

const rows = db.prepare(`SELECT rowid AS rid, id, event_type, payload FROM agent_events
  WHERE event_type IN ('message_received', 'message_replied') ORDER BY rowid`).all();
let touched = 0;
let skipped = 0;
const update = db.prepare('UPDATE agent_events SET payload = ? WHERE rowid = ?');
for (const row of rows) {
  let payload;
  try { payload = JSON.parse(row.payload ?? '{}'); } catch { skipped += 1; continue; }
  if (payload.preview) { skipped += 1; continue; }
  const messageId = String(payload.message_id ?? '');
  const key = String(row.id ?? '').replace(/:(in|out)$/u, '');
  const found = byMsgId('qq_messages', messageId) ?? byMsgId('qq_messages', key)
    ?? byMsgId('ilink_messages', messageId) ?? byMsgId('ilink_messages', key);
  const text = row.event_type === 'message_received' ? found?.text : (found?.reply ?? found?.text);
  if (!text) { skipped += 1; continue; }
  payload.preview = clip(text);
  touched += 1;
  if (!dry) update.run(JSON.stringify(payload), row.rid);
}
console.log(JSON.stringify({ ok: true, dry, touched, skipped, scanned: rows.length }));
