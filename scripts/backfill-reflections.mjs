#!/usr/bin/env node
// 把历史上「动作失败」的事件补进学习账本，让 learning_proposals 不再是空的。
//
// 以前只有 skill_runs 失败才会产生提案，可真正天天失败的是动作层（定时任务）。
// 这个脚本只读 agent_events、只写 learning_proposals，重复跑是幂等的（按类别累加）。
//
// 用法：node scripts/backfill-reflections.mjs [--days 30] [--dry]
import { DatabaseSync } from 'node:sqlite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyFailure, reflectOnActionFailure } from '../connect/core/reflect.mjs';
import { initReflections } from '../connect/reflection.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dry = args.includes('--dry');
const days = Number(args[args.indexOf('--days') + 1]) || 30;

const db = new DatabaseSync(resolve(root, 'runtime/connect/connect.sqlite'));
db.exec('PRAGMA busy_timeout=3000');
initReflections(db);

const since = new Date(Date.now() - days * 86_400_000).toISOString();
const rows = db.prepare(
  `SELECT id, task_id, payload, result, created_at FROM agent_events
    WHERE event_type='action_failed' AND created_at >= ? ORDER BY id`,
).all(since);

let seen = 0;
let skipped = 0;
const byKey = new Map();
for (const row of rows) {
  let payload = {};
  try { payload = JSON.parse(row.payload ?? '{}'); } catch { payload = {}; }
  // 早期的事件只写了 {"status":"failed"}，动作名在 result 里。取不到就跳过——
  // 没有动作名的失败进账本只会变成一条「unknown」，那是噪音不是经验。
  let result = null;
  try { result = row.result ? JSON.parse(row.result) : null; } catch { result = null; }
  const receipt = Array.isArray(result?.result) ? result.result[0] : null;
  const operation = String(
    payload.operation ?? payload.operations ?? payload.action
    ?? receipt?.operation ?? receipt?.adapter ?? '',
  );
  const reason = String(
    payload.error ?? payload.reason ?? payload.detail
    ?? receipt?.detail ?? receipt?.error ?? receipt?.status ?? payload.status ?? 'unknown',
  );
  if (!operation || operation === 'unknown.operation') { skipped += 1; continue; }
  seen += 1;
  if (dry) {
    const key = `${operation}|${classifyFailure(reason)}`;
    byKey.set(key, (byKey.get(key) ?? 0) + 1);
    continue;
  }
  reflectOnActionFailure(db, { operation, reason, taskId: row.task_id ?? null, now: Date.parse(row.created_at) || Date.now() });
}

if (dry) {
  console.log(`扫到 ${seen} 条 action_failed（会跳过无动作名的），，按「动作|原因」聚合：`);
  for (const [key, count] of [...byKey.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`${String(count).padStart(3)}x  ${key}`);
} else {
  const rowsAfter = db.prepare("SELECT pattern_key, occurrences, status FROM learning_proposals ORDER BY occurrences DESC LIMIT 15").all();
  console.log(`回填完成：扫 ${seen} 条事件（跳过 ${skipped} 条无动作名），账本现有 ${rowsAfter.length} 条（前 15 条）：`);
  for (const row of rowsAfter) console.log(`${String(row.occurrences).padStart(3)}x  ${row.status.padEnd(10)} ${row.pattern_key}`);
}
