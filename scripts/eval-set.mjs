#!/usr/bin/env node
// M4：把「这套东西到底有多靠谱」变成四个数字。
//
// 不编数据：只统计库里真实发生过的事（external_tasks + task_checkpoints + agent_events）。
// 指标定义（与 M4 约定一致）：
//   成功率       —— status='succeeded' 的任务占比
//   平均步数     —— 每个任务实际执行了几步（以 task_checkpoints 计）
//   回执未确认率 —— 写操作回执里 verdict 不是 confirmed 的比例
//   人工介入率   —— 需要过审批（出现过 approval/task_state_changed→awaiting_confirmation）的任务占比
//
// 用法：node scripts/eval-set.mjs [--days 7] [--json] [--op douyin.publish]
import { DatabaseSync } from 'node:sqlite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const days = Number(args[args.indexOf('--days') + 1]) || 7;
const asJson = args.includes('--json');
const onlyOp = args[args.indexOf('--op') + 1] && args.includes('--op') ? args[args.indexOf('--op') + 1] : null;

const db = new DatabaseSync(resolve(root, 'runtime/connect/connect.sqlite'));
db.exec('PRAGMA busy_timeout=3000');
const since = Date.now() - days * 86_400_000;

const hasTable = (name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

const tasks = db.prepare('SELECT id, intent, status, attempts, created_ms, updated_ms, payload, result FROM external_tasks WHERE created_ms >= ?').all(since);
const checkpoints = hasTable('task_checkpoints')
  ? db.prepare('SELECT task_id, operation, verdict, ok FROM task_checkpoints WHERE created_ms >= ?').all(since)
  : [];
const approvals = db.prepare(
  "SELECT DISTINCT task_id FROM agent_events WHERE event_type='task_state_changed' AND payload LIKE '%awaiting_confirmation%' AND created_at >= ?",
).all(new Date(since).toISOString());

const operationsOf = (task) => {
  try {
    const payload = JSON.parse(task.payload ?? '{}');
    if (Array.isArray(payload.operations) && payload.operations.length) return payload.operations;
    if (Array.isArray(payload.plan)) return payload.plan.map((step) => step.tool ?? step.operation).filter(Boolean);
  } catch { /* 坏 payload 就当没有 */ }
  return [];
};

const filtered = onlyOp ? tasks.filter((task) => operationsOf(task).includes(onlyOp)) : tasks;
const stepsByTask = new Map();
for (const row of checkpoints) stepsByTask.set(row.task_id, (stepsByTask.get(row.task_id) ?? 0) + 1);

const total = filtered.length;
const succeeded = filtered.filter((task) => task.status === 'succeeded').length;
const failed = filtered.filter((task) => task.status === 'failed').length;
const cancelled = filtered.filter((task) => task.status === 'cancelled').length;
const open = filtered.filter((task) => ['pending', 'awaiting_confirmation', 'running'].includes(task.status)).length;

const steps = filtered.map((task) => stepsByTask.get(task.id) ?? 0);
const avgSteps = total ? steps.reduce((a, b) => a + b, 0) / total : 0;

const verified = checkpoints.filter((row) => row.verdict && row.verdict !== 'skipped');
const unconfirmed = verified.filter((row) => row.verdict !== 'confirmed').length;
const unconfirmedRate = verified.length ? unconfirmed / verified.length : null;

const approvalIds = new Set(approvals.map((row) => row.task_id));
const needed = filtered.filter((task) => approvalIds.has(task.id)).length;

const byOperation = new Map();
for (const row of checkpoints) {
  const key = row.operation ?? 'unknown';
  const entry = byOperation.get(key) ?? { operation: key, steps: 0, confirmed: 0, other: 0 };
  entry.steps += 1;
  if (row.verdict === 'confirmed') entry.confirmed += 1;
  else if (row.verdict && row.verdict !== 'skipped') entry.other += 1;
  byOperation.set(key, entry);
}

const pct = (value, base) => (base ? `${((value / base) * 100).toFixed(1)}%` : '—');
const report = {
  window_days: days,
  scope: onlyOp ?? 'all',
  tasks: { total, succeeded, failed, cancelled, open },
  success_rate: total ? succeeded / total : null,
  // 取消的任务多半是主人自己撤的，算进成功率会把「系统不靠谱」和「主人改主意」混在一起
  success_rate_terminal: total - cancelled ? succeeded / (total - cancelled) : null,
  avg_steps: Number(avgSteps.toFixed(2)),
  receipts: { verified: verified.length, not_confirmed: unconfirmed, unconfirmed_rate: unconfirmedRate },
  human_in_loop: { tasks: needed, rate: total ? needed / total : null },
  by_operation: [...byOperation.values()].sort((a, b) => b.steps - a.steps),
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`评估窗口：最近 ${days} 天${onlyOp ? `（只看 ${onlyOp}）` : ''}`);
  console.log(`任务 ${total} 个：成功 ${succeeded} · 失败 ${failed} · 取消 ${cancelled} · 未结 ${open}`);
  console.log(`成功率 ${pct(succeeded, total)}（含取消）· ${pct(succeeded, total - cancelled)}（不含取消）`);
  console.log(`平均步数：${report.avg_steps} 步/任务`);
  console.log(`回执：已核 ${verified.length} 步，其中未确认 ${unconfirmed} 步 → 未确认率 ${unconfirmedRate == null ? '—' : pct(unconfirmed, verified.length)}`);
  console.log(`人工介入：${needed} 个任务过了审批 → ${pct(needed, total)}`);
  if (byOperation.size) {
    console.log('按操作：');
    for (const row of report.by_operation) {
      console.log(`  ${row.operation.padEnd(28)} 步 ${String(row.steps).padStart(3)} · 确认 ${String(row.confirmed).padStart(3)} · 其它 ${row.other}`);
    }
  }
}
