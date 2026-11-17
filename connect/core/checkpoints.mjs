// M2 / D2：任务执行快照表。
//
// 为什么要它：现在外部动作失败以后只有两条路——整单重来，或者永远卡在 unknown。
// 中间发生过什么只存在这一次函数调用的栈里，进程一重启就没了。
//
// 这里给每个「步骤」落一行快照：输入参数、输出结果、判定结论。
// 三个用途：
//   1. 失败重试时用 doneSteps() 还原「哪些步已经成了」，executeOperations 已有的
//      doneStepKeys 幂等跳过机制直接就能续跑；
//   2. 复盘时能回答「失败在第几步、那一步的输入输出是什么」，不用猜；
//   3. 幂等键之外再加一层保险：同名 step_key 已经 ok 的，不再重复产生副作用。
//
// 刻意不做的事：不存整个 agent 的内存状态（我们没有 LangGraph 那种任意 state 快照），
// 只存「步骤级」输入输出——够用来续跑，也不至于把数据库写成垃圾场。

import { ensureColumn, hasTable } from './migrations.mjs';

export const CHECKPOINT_STAGES = Object.freeze(['plan', 'approve', 'execute', 'verify', 'deliver']);

const DDL = `
CREATE TABLE IF NOT EXISTS task_checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  step_key TEXT NOT NULL DEFAULT '',
  step_index INTEGER NOT NULL DEFAULT 0,
  operation TEXT NOT NULL DEFAULT '',
  input_json TEXT NOT NULL DEFAULT '{}',
  output_json TEXT NOT NULL DEFAULT '{}',
  verdict TEXT NOT NULL DEFAULT 'unknown',
  reason TEXT NOT NULL DEFAULT '',
  ok INTEGER NOT NULL DEFAULT 0,
  created_ms INTEGER NOT NULL
);
`;

export function initCheckpoints(db) {
  if (!db) return;
  db.exec(DDL);
  ensureColumn(db, 'task_checkpoints', 'reason');
  db.exec('CREATE INDEX IF NOT EXISTS task_checkpoints_task ON task_checkpoints(task_id, id)');
  db.exec('CREATE INDEX IF NOT EXISTS task_checkpoints_step ON task_checkpoints(task_id, step_key)');
}

function encode(value) {
  if (value === undefined || value === null) return '{}';
  try {
    const text = JSON.stringify(value);
    // JSON.stringify(undefined) 是 undefined；顺手把函数/循环引用挡在外面。
    return typeof text === 'string' ? text.slice(0, 4000) : '{}';
  } catch {
    return '{}';
  }
}

function decode(text, fallback = {}) {
  if (!text) return fallback;
  try {
    const value = JSON.parse(text);
    return value === null ? fallback : value;
  } catch { return fallback; }
}

/**
 * 记一条步骤快照。任何字段坏了都不能影响执行本身，所以整段 try/catch。
 * @returns {number|null} 行 id
 */
export function recordCheckpoint(db, {
  taskId = null,
  stage = 'execute',
  stepKey = '',
  stepIndex = 0,
  operation = '',
  input = null,
  output = null,
  verdict = 'unknown',
  reason = '',
  ok = false,
  now = Date.now(),
} = {}) {
  if (!db || !taskId) return null;
  try {
    initCheckpoints(db);
    const info = db.prepare(
      'INSERT INTO task_checkpoints(task_id, stage, step_key, step_index, operation, input_json, output_json, verdict, reason, ok, created_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    ).run(String(taskId), String(stage), String(stepKey ?? ''), Number(stepIndex) || 0, String(operation ?? ''), encode(input), encode(output), String(verdict), String(reason ?? ''), ok ? 1 : 0, now);
    return Number(info.lastInsertRowid);
  } catch { return null; }
}

/** 某个任务的全部快照，按时间正序。 */
export function checkpointsOf(db, taskId) {
  if (!db || !taskId) return [];
  try {
    if (!hasTable(db, 'task_checkpoints')) return [];
    return db.prepare('SELECT * FROM task_checkpoints WHERE task_id=? ORDER BY id ASC').all(String(taskId))
      .map((row) => ({
        ...row,
        input: decode(row.input_json, null),
        output: decode(row.output_json, null),
        ok: row.ok === 1,
      }));
  } catch { return []; }
}

/** 已经成功的步骤键（给 executeOperations 的 doneStepKeys 用）。 */
export function doneSteps(db, taskId) {
  const done = new Set();
  for (const row of checkpointsOf(db, taskId)) {
    if (row.ok && row.step_key) done.add(String(row.step_key));
  }
  return done;
}

/** 最后一条失败快照：重试时用它回答「上次卡在哪」。 */
export function lastFailure(db, taskId) {
  const rows = checkpointsOf(db, taskId);
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (!rows[index].ok) return rows[index];
  }
  return null;
}

/**
 * 断点摘要：几个成了、几个没过、卡在哪一步。
 * 给 /live 的任务详情和失败回执用，避免每次都要人肉翻表。
 */
export function checkpointSummary(db, taskId) {
  const rows = checkpointsOf(db, taskId);
  const ok = rows.filter((row) => row.ok).length;
  const failed = rows.filter((row) => !row.ok && row.verdict !== 'skipped').length;
  const last = rows.length ? rows[rows.length - 1] : null;
  return {
    total: rows.length,
    ok,
    failed,
    lastStep: last?.step_key ?? null,
    lastOperation: last?.operation ?? null,
    lastVerdict: last?.verdict ?? null,
    resumable: ok > 0 && failed > 0,
  };
}
