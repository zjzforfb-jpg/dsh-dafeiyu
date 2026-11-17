#!/usr/bin/env node
/**
 * 每日记忆整理：把某一天的活动流水压缩成一条「当天记忆」，写入长期记忆库。
 *   node scripts/memory-digest.mjs [--day YYYY-MM-DD] [--print]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openHub, recordActivity } from '../connect/memory-hub.mjs';
import { ownerDigestEvents, markDailyDigested, purgeDailyMemory } from '../connect/daily-memory.mjs';

const root = process.cwd();
const args = process.argv.slice(2);
const option = (name, fallback = '') => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
};
const fmt = (d) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(d);
const day = option('day') || fmt(new Date(Date.now() - 86_400_000));

const hub = openHub(root);
if (!hub) { console.error('memory_hub_unavailable'); process.exit(1); }

const rows = hub.prepare("SELECT content, created_at FROM memories WHERE kind='activity' AND content LIKE ? ORDER BY id").all(`【活动·${day}%`);
const events = ownerDigestEvents(hub,day,{undigestedOnly:true});
if (!rows.length && !events.length) {
  console.log(JSON.stringify({ day, activities: 0, daily_events: 0, digest: null }, null, 2));
  process.exit(0);
}

const lines = [...rows.map((r) => r.content.replace(/^【活动·[^】]*】/, '')),...events.map(e=>`[${e.channel}/${e.conversation_kind}/${e.role}] ${e.content??`${e.user_text??''} → ${e.assistant_text??''}`}`)];
const settings = JSON.parse(readFileSync(join(root, 'runtime/dsh-home/dsh-pet/standalone-ai.json'), 'utf8'));
const response = await fetch('http://127.0.0.1:3110/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.apiKey}` },
  body: JSON.stringify({
    model: 'deepseek-flash',
    max_tokens: 260,
    thinking: { type: 'disabled' },
    messages: [
      { role: 'system', content: '你在帮一只叫大肥鱼的小鲸鱼整理当天记忆。把流水压缩成 2–4 句第一人称小结，按时间顺序，抓住「做了什么、遇到什么、结果如何」，不要罗列每条。' },
      { role: 'user', content: `这是 ${day} 的活动流水：\n${lines.join('\n')}` },
    ],
  }),
});
const data = await response.json();
const text = String(data?.choices?.[0]?.message?.content ?? '').trim();
const digest = text || `今天一共做了 ${rows.length} 件事：${lines.slice(0, 5).join('；')}`;

const record = recordActivity(hub, `【当天记忆·${day}】${digest}`, { channel: 'digest' });
hub.prepare("UPDATE memories SET kind='daily_digest', confidence=0.9 WHERE id=?").run(record.id);
markDailyDigested(hub,day);purgeDailyMemory(hub,30);
console.log(JSON.stringify({ day, activities: rows.length, daily_events: events.length, digest, memoryId: record.id }, null, 2));
