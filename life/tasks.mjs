import { randomUUID } from 'node:crypto';
import {
  DAILY_BUDGET,
  reserveModelCall as reserveBudgetModelCall,
  reserveAutonomousAction as reserveBudgetAutonomousAction,
} from '../connect/core/budget.mjs';

// D-2：日配额已并入 connect/core/budget.mjs 的统一 daily_budget（跨渠道共享同一格累计），
// 这里只 re-export 保持旧引用点（life/manager.mjs、scripts/life.mjs）可用。
export { DAILY_BUDGET };

// D-1：goalId 写 tasks.goal_id；agentTaskId 记进 payload.agentTaskId（统一 AgentTask 的
// external_tasks.id，见 connect/tasks.mjs），把「自主目标」和统一 AgentTask 打通。
export function enqueueTask(db, { idempotencyKey, origin = 'schedule', kind, title, payload = {}, approvalRequired = false, maxAttempts = 2, scheduledAt = null, deadline = null, goalId = null, agentTaskId = null }) {
  const record = agentTaskId ? { ...payload, agentTaskId } : payload;
  db.prepare(`INSERT OR IGNORE INTO tasks
    (id, idempotency_key, origin, kind, title, payload, goal_id, approval_required, max_attempts, scheduled_at, deadline)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), idempotencyKey, origin, kind, title, JSON.stringify(record), goalId, Number(approvalRequired), maxAttempts, scheduledAt, deadline);
  return db.prepare('SELECT * FROM tasks WHERE idempotency_key = ?').get(idempotencyKey);
}

/**
 * D-2：委托统一预算（connect/core/budget.mjs 的 daily_budget）。签名保持 (db, day) 兼容。
 * db handle 决定 daily_budget 落哪本库——生产接线（life/manager.mjs 的 budgetDb、scripts/life.mjs）
 * 传 CONNECT 库 handle，与 QQ/iLink 共用同一份累计；只给一个 handle 的调用方（旧单测）就落那一本。
 */
export function reserveModelCall(db, day) {
  return reserveBudgetModelCall(db, day);
}

export function reserveAutonomousAction(db, day) {
  return reserveBudgetAutonomousAction(db, day);
}

/**
 * D-1：把一条 goal_progress 关联到一个统一 AgentTask id（通常是 connect/tasks.mjs external_tasks 的 id，
 * 也兼容 BRAIN tasks.id）——写 goal_progress.task_id。同 (goalId, day) 重复推进会更新
 * （goal_progress 有 UNIQUE(goal_id, day)）。返回写入的 goal_progress 行。
 */
export function linkGoalTask(db, { goalId, taskId, day, summary, nextStep }) {
  db.prepare(`INSERT INTO goal_progress (goal_id, task_id, day, summary, next_step) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(goal_id, day) DO UPDATE SET task_id = excluded.task_id, summary = excluded.summary, next_step = excluded.next_step`)
    .run(goalId, taskId ?? null, day, summary, nextStep);
  return db.prepare('SELECT * FROM goal_progress WHERE goal_id = ? AND day = ?').get(goalId, day);
}

/** D-1：一个 goal 的推进历史（关联的 task 按最近优先），goals 命令/看板用。 */
export function goalTaskHistory(db, goalId, limit = 5) {
  return db.prepare('SELECT id, goal_id, task_id, day, summary, next_step, created_at FROM goal_progress WHERE goal_id = ? ORDER BY day DESC, id DESC LIMIT ?').all(goalId, limit);
}

/** D-1：每个 goal 附带最近关联的 task（goal_progress.task_id 即 AgentTask id）。 */
export function goalsWithTasks(db, { taskLimit = 5 } = {}) {
  const goals = db.prepare('SELECT id, title, description, status, progress_note, updated_at FROM goals ORDER BY created_at').all();
  return goals.map((goal) => ({ ...goal, recentTasks: goalTaskHistory(db, goal.id, taskLimit) }));
}

export function claimTask(db, id) {
  const result = db.prepare(`UPDATE tasks SET status = 'running', attempts = attempts + 1, updated_at = datetime('now')
    WHERE id = ? AND status IN ('pending','failed') AND attempts < max_attempts
    AND approval_required = 0 AND (scheduled_at IS NULL OR scheduled_at <= datetime('now'))`).run(id);
  return result.changes === 1 ? db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) : null;
}

export function completeTask(db, id, result) {
  db.prepare("UPDATE tasks SET status = 'succeeded', result = ?, error = NULL, updated_at = datetime('now'), finished_at = datetime('now') WHERE id = ? AND status = 'running'")
    .run(JSON.stringify(result), id);
}

export function failTask(db, task, error) {
  const exhausted = task.attempts >= task.max_attempts;
  const retryAt = new Date(Date.now() + 5 * 60_000).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(`UPDATE tasks SET status = 'failed', error = ?, scheduled_at = ?, updated_at = datetime('now'),
    finished_at = CASE WHEN ? THEN datetime('now') ELSE NULL END WHERE id = ? AND status = 'running'`)
    .run(String(error?.message ?? error).slice(0, 500), exhausted ? task.scheduled_at : retryAt, Number(exhausted), task.id);
}

export function recoverStaleTasks(db, olderThanMinutes = 10) {
  return db.prepare(`UPDATE tasks SET status = 'failed', error = 'Recovered after interrupted run',
    scheduled_at = datetime('now'), updated_at = datetime('now'),
    finished_at = CASE WHEN attempts >= max_attempts THEN datetime('now') ELSE NULL END
    WHERE status = 'running' AND updated_at < datetime('now', ?)`)
    .run(`-${olderThanMinutes} minutes`).changes;
}

export function taskList(db, limit = 20) {
  return db.prepare('SELECT id, idempotency_key, origin, kind, title, goal_id, status, attempts, max_attempts, scheduled_at, result, error, created_at, updated_at FROM tasks ORDER BY created_at DESC LIMIT ?').all(limit);
}
