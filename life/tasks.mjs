import { randomUUID } from 'node:crypto';

export const DAILY_BUDGET = Object.freeze({ modelCalls: 4, autonomousActions: 2 });

export function enqueueTask(db, { idempotencyKey, origin = 'schedule', kind, title, payload = {}, approvalRequired = false, maxAttempts = 2, scheduledAt = null, deadline = null }) {
  db.prepare(`INSERT OR IGNORE INTO tasks
    (id, idempotency_key, origin, kind, title, payload, approval_required, max_attempts, scheduled_at, deadline)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), idempotencyKey, origin, kind, title, JSON.stringify(payload), Number(approvalRequired), maxAttempts, scheduledAt, deadline);
  return db.prepare('SELECT * FROM tasks WHERE idempotency_key = ?').get(idempotencyKey);
}

export function reserveModelCall(db, day) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT OR IGNORE INTO daily_usage (day) VALUES (?)').run(day);
    const row = db.prepare('SELECT model_calls FROM daily_usage WHERE day = ?').get(day);
    if (row.model_calls >= DAILY_BUDGET.modelCalls) { db.exec('ROLLBACK'); return false; }
    db.prepare("UPDATE daily_usage SET model_calls = model_calls + 1, updated_at = datetime('now') WHERE day = ?").run(day);
    db.exec('COMMIT');
    return true;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function reserveAutonomousAction(db, day) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT OR IGNORE INTO daily_usage (day) VALUES (?)').run(day);
    const row = db.prepare('SELECT autonomous_actions FROM daily_usage WHERE day = ?').get(day);
    if (row.autonomous_actions >= DAILY_BUDGET.autonomousActions) { db.exec('ROLLBACK'); return false; }
    db.prepare("UPDATE daily_usage SET autonomous_actions = autonomous_actions + 1, updated_at = datetime('now') WHERE day = ?").run(day);
    db.exec('COMMIT');
    return true;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
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
