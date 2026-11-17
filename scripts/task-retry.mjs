#!/usr/bin/env node
// 从断点续跑一个任务：已经成功的步骤跳过，只跑剩下的。
//
// 用法：
//   node scripts/task-retry.mjs <taskId>            # 真跑
//   node scripts/task-retry.mjs <taskId> --dry      # 只打印会跳过/会跑什么
//   node scripts/task-retry.mjs --list              # 列出可续跑的任务
import { DatabaseSync } from 'node:sqlite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { retryTask } from '../connect/core/retry.mjs';
import { checkpointSummary, initCheckpoints } from '../connect/core/checkpoints.mjs';
import { migrateConnect } from '../connect/core/migrations.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = resolve(root, 'runtime/connect/connect.sqlite');
const args = process.argv.slice(2);
const dry = args.includes('--dry');
const list = args.includes('--list');
const taskId = args.find((arg) => !arg.startsWith('--')) ?? '';

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout=3000');
migrateConnect(db, { backupDir: resolve(root, 'runtime/backups') });
initCheckpoints(db);

if (list) {
  const rows = db.prepare(
    `SELECT t.id, t.status, t.intent, t.updated_ms, COUNT(c.id) AS steps, SUM(CASE WHEN c.ok=1 THEN 1 ELSE 0 END) AS ok_steps
       FROM external_tasks t LEFT JOIN task_checkpoints c ON c.task_id = t.id
      WHERE t.status IN ('failed','running','awaiting_verification')
      GROUP BY t.id ORDER BY t.updated_ms DESC LIMIT 20`,
  ).all();
  if (!rows.length) { console.log('没有失败/半成功的任务。'); process.exit(0); }
  for (const row of rows) {
    console.log(`${row.id}  ${row.status.padEnd(22)} 步 ${row.ok_steps ?? 0}/${row.steps ?? 0}  ${String(row.intent).slice(0, 28)}`);
  }
  process.exit(0);
}

if (!taskId) {
  console.error('用法：node scripts/task-retry.mjs <taskId> [--dry] | --list');
  process.exit(1);
}

const summary = checkpointSummary(db, taskId);
if (dry) {
  console.log(JSON.stringify({ taskId, summary }, null, 2));
  process.exit(0);
}

const result = await retryTask(db, taskId, { root });
const verdict = result.ok ? '续跑成功' : `续跑仍有失败（${result.status}）`;
console.log(`${verdict}：跳过 ${result.skipped.length} 步，执行 ${result.ran.length} 步`);
for (const detail of result.details ?? []) console.log(`- ${detail}`);
if (result.summary) console.log(`快照：共 ${result.summary.total} 步，成功 ${result.summary.ok}，失败 ${result.summary.failed}`);
process.exit(result.ok ? 0 : 1);
