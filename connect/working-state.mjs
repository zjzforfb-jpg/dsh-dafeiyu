import { initAgentEvents, recordAgentEvent } from './agent-events.mjs';
import { ensureColumns } from './core/migrations.mjs';

export function initWorkingTasks(db) {
  initAgentEvents(db);
  db.exec(`CREATE TABLE IF NOT EXISTS working_tasks(
    task_id TEXT PRIMARY KEY,
    goal TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','waiting_verification','succeeded','failed','unknown','cancelled','expired')),
    environment TEXT NOT NULL DEFAULT '{}',
    current_step TEXT,
    selected_skill TEXT,
    last_observation_id TEXT,
    next_action TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    deadline_ms INTEGER, plan_json TEXT, selected_strategy TEXT,
    created_ms INTEGER NOT NULL,
    updated_ms INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS working_tasks_status ON working_tasks(status,updated_ms);`);
  ensureColumns(db, 'working_tasks', ['plan_json','selected_strategy']);
}

function json(value) { try { return JSON.stringify(value ?? {}); } catch { return '{}'; } }

export function createWorkingTask(db, { taskId, goal, environment = {}, deadlineMs = null, now = Date.now() }) {
  initWorkingTasks(db);
  db.prepare(`INSERT OR IGNORE INTO working_tasks(task_id,goal,status,environment,deadline_ms,created_ms,updated_ms)
    VALUES(?,?, 'pending', ?, ?, ?, ?)`).run(String(taskId), String(goal).slice(0, 300), json(environment), deadlineMs, now, now);
  return workingTask(db, taskId);
}

export function updateWorkingTask(db, taskId, patch = {}, now = Date.now()) {
  initWorkingTasks(db);
  const current = workingTask(db, taskId);
  if (!current) return null;
  const next = {
    status: patch.status ?? current.status,
    environment: patch.environment ?? parseJson(current.environment),
    currentStep: patch.currentStep ?? current.current_step,
    selectedSkill: patch.selectedSkill ?? current.selected_skill,
    lastObservationId: patch.lastObservationId ?? current.last_observation_id,
    nextAction: patch.nextAction ?? current.next_action,
    retryCount: patch.retryCount ?? current.retry_count,
    deadlineMs: patch.deadlineMs ?? current.deadline_ms,
  };
  db.prepare(`UPDATE working_tasks SET status=?,environment=?,current_step=?,selected_skill=?,last_observation_id=?,next_action=?,retry_count=?,deadline_ms=?,updated_ms=? WHERE task_id=?`)
    .run(next.status, json(next.environment), next.currentStep, next.selectedSkill, next.lastObservationId, next.nextAction, next.retryCount, next.deadlineMs, now, String(taskId));
  recordAgentEvent(db, { eventType: 'task_state_changed', channel: 'system', taskId: String(taskId), actor: 'system', payload: { working_status: next.status, current_step: next.currentStep, next_action: next.nextAction }, dedupeKey: `working:${taskId}:${next.status}:${now}` });
  return workingTask(db, taskId);
}

export function workingTask(db, taskId) {
  initWorkingTasks(db);
  return db.prepare('SELECT * FROM working_tasks WHERE task_id=?').get(String(taskId)) ?? null;
}

export function listWorkingTasks(db, { status, limit = 100 } = {}) {
  initWorkingTasks(db);
  const safe = Math.max(1, Math.min(500, Number(limit) || 100));
  return status
    ? db.prepare('SELECT * FROM working_tasks WHERE status=? ORDER BY updated_ms DESC LIMIT ?').all(String(status), safe)
    : db.prepare('SELECT * FROM working_tasks ORDER BY updated_ms DESC LIMIT ?').all(safe);
}

export function recoverWorkingTasks(db, now = Date.now()) {
  initWorkingTasks(db);
  const rows = db.prepare("SELECT task_id FROM working_tasks WHERE status IN ('running','waiting_verification')").all();
  for (const row of rows) updateWorkingTask(db, row.task_id, { status: 'unknown' }, now);
  return rows.length;
}

export function recoverWorkingTask(db, taskId, { observationId, environment = {}, now = Date.now() } = {}) {
  initWorkingTasks(db);
  if (!observationId || typeof observationId !== 'string') throw new Error('observation_required');
  const current = workingTask(db, taskId);
  if (!current || current.status !== 'unknown') return null;
  return updateWorkingTask(db, taskId, { status: 'pending', environment, lastObservationId: observationId, nextAction: 'replan_after_observation' }, now);
}

function parseJson(value) { try { return JSON.parse(value); } catch { return {}; } }
