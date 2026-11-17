// 步骤级事件：记录每个技能「第几步做了什么、断言过没过」。
// 表落在 connect.sqlite，行由动作执行方在结束时随结果一起写回（脚本输出 steps 数组）。
export function initSteps(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS skill_step_events(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    skill_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    ok INTEGER NOT NULL DEFAULT 0,
    verified INTEGER NOT NULL DEFAULT 0,
    at TEXT NOT NULL,
    evidence TEXT
  );
  CREATE INDEX IF NOT EXISTS skill_step_run ON skill_step_events(run_id);
  CREATE INDEX IF NOT EXISTS skill_step_recent ON skill_step_events(at DESC);`);
}

export function recordSteps(db, { runId, skillId, steps, now = new Date() }) {
  if (!runId || !Array.isArray(steps) || !steps.length) return 0;
  initSteps(db);
  const at = new Date(now).toISOString();
  const insert = db.prepare('INSERT INTO skill_step_events(run_id, skill_id, step_id, ok, verified, at, evidence) VALUES (?,?,?,?,?,?,?)');
  let count = 0;
  for (const step of steps) {
    if (!step?.id) continue;
    insert.run(
      runId,
      skillId,
      String(step.id).slice(0, 40),
      step.ok === true ? 1 : 0,
      step.verified === true || step.ok === true ? 1 : 0,
      at,
      String(step.evidence ?? '').slice(0, 240) || null,
    );
    count += 1;
  }
  return count;
}

export function stepsForRun(db, runId) {
  initSteps(db);
  return db.prepare('SELECT * FROM skill_step_events WHERE run_id=? ORDER BY id ASC').all(runId);
}

export function recentSteps(db, limit = 60) {
  initSteps(db);
  return db.prepare('SELECT * FROM skill_step_events ORDER BY id DESC LIMIT ?').all(Math.max(1, Math.min(200, Number(limit) || 60)));
}
