import { randomUUID } from 'node:crypto';
import { initReflections, reflectOnSkillRun } from './reflection.mjs';

const STATUSES = new Set(['candidate', 'validating', 'enabled', 'deprecated']);

export function initSkills(db) {
  initReflections(db);
  db.exec(`CREATE TABLE IF NOT EXISTS skill_registry(
    skill_id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'candidate', current_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS skill_versions(
    skill_id TEXT NOT NULL, version INTEGER NOT NULL, preconditions TEXT NOT NULL DEFAULT '{}',
    steps TEXT NOT NULL DEFAULT '[]', postconditions TEXT NOT NULL DEFAULT '{}', fallback TEXT NOT NULL DEFAULT '[]',
    environment TEXT NOT NULL DEFAULT '{}', confidence REAL NOT NULL DEFAULT 0.5,
    status TEXT NOT NULL DEFAULT 'candidate', created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY(skill_id,version), FOREIGN KEY(skill_id) REFERENCES skill_registry(skill_id)
  );
  CREATE TABLE IF NOT EXISTS skill_runs(
    id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, version INTEGER NOT NULL, task_id TEXT,
    environment TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'running',
    success INTEGER, verified INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER,
    retry_count INTEGER NOT NULL DEFAULT 0, failure_stage TEXT, result TEXT,
    started_at TEXT NOT NULL, finished_at TEXT, FOREIGN KEY(skill_id,version) REFERENCES skill_versions(skill_id,version)
  );
  CREATE TABLE IF NOT EXISTS skill_proposals(
    id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, version INTEGER NOT NULL, reason TEXT NOT NULL,
    evidence TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'candidate', created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS skill_runs_lookup ON skill_runs(skill_id,version,status);
  CREATE INDEX IF NOT EXISTS skill_registry_enabled ON skill_registry(status);`);
}
const encode = value => { try { return JSON.stringify(value ?? {}); } catch { return '{}'; } };
const decode = value => { try { return JSON.parse(value); } catch { return {}; } };

export function registerSkill(db, { skillId, name, description = '', version = 1, preconditions = {}, steps = [], postconditions = {}, fallback = [], environment = {}, confidence = 0.5, status = 'candidate' }) {
  initSkills(db); if (!skillId || !name || !STATUSES.has(status)) throw new Error('invalid_skill');
  const exists = db.prepare('SELECT skill_id FROM skill_registry WHERE skill_id=?').get(skillId);
  if (!exists) db.prepare('INSERT INTO skill_registry(skill_id,name,description,status,current_version) VALUES(?,?,?,?,?)').run(skillId,name,description,status,version);
  db.prepare(`INSERT OR REPLACE INTO skill_versions(skill_id,version,preconditions,steps,postconditions,fallback,environment,confidence,status)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(skillId,version,encode(preconditions),encode(steps),encode(postconditions),encode(fallback),encode(environment),Math.max(0,Math.min(1,Number(confidence)||0)),status);
  return skill(db, skillId, version);
}
export function skill(db, skillId, version = null) { initSkills(db); const row = version == null ? db.prepare('SELECT * FROM skill_registry WHERE skill_id=?').get(skillId) : db.prepare('SELECT r.*,v.* FROM skill_registry r JOIN skill_versions v ON v.skill_id=r.skill_id WHERE r.skill_id=? AND v.version=?').get(skillId,version); return row ? row : null; }
export function proposeSkill(db, { skillId, version, reason, evidence = {} }) { initSkills(db); const id=`proposal_${randomUUID()}`; db.prepare('INSERT INTO skill_proposals(id,skill_id,version,reason,evidence) VALUES(?,?,?,?,?)').run(id,skillId,version,String(reason).slice(0,500),encode(evidence)); return db.prepare('SELECT * FROM skill_proposals WHERE id=?').get(id); }
export function setSkillStatus(db, skillId, version, status) { initSkills(db); if(!STATUSES.has(status)) throw new Error('invalid_skill_status'); db.prepare('UPDATE skill_versions SET status=? WHERE skill_id=? AND version=?').run(status,skillId,version); if(status==='enabled') db.prepare('UPDATE skill_registry SET status=?,current_version=?,updated_at=datetime(\'now\') WHERE skill_id=?').run(status,version,skillId); return skill(db,skillId,version); }
export function startSkillRun(db, { skillId, version, taskId = null, environment = {}, now = new Date() }) { initSkills(db); const id=`run_${randomUUID()}`; db.prepare('INSERT INTO skill_runs(id,skill_id,version,task_id,environment,started_at) VALUES(?,?,?,?,?,?)').run(id,skillId,version,taskId,encode(environment),new Date(now).toISOString()); return id; }
export function finishSkillRun(db, id, { success, verified = false, durationMs = null, retryCount = 0, failureStage = null, result = {} }, now = new Date()) { initSkills(db); const status=success===true?'succeeded':success===false?'failed':'unknown'; db.prepare('UPDATE skill_runs SET status=?,success=?,verified=?,duration_ms=?,retry_count=?,failure_stage=?,result=?,finished_at=? WHERE id=?').run(status,success==null?null:success?1:0,verified?1:0,durationMs,retryCount,failureStage,encode(result),new Date(now).toISOString(),id); const row=db.prepare('SELECT * FROM skill_runs WHERE id=?').get(id); if (status !== 'succeeded') reflectOnSkillRun(db,id,now); return row; }
export function skillStats(db, skillId, version) { initSkills(db); return db.prepare("SELECT COUNT(*) AS runs, SUM(CASE WHEN success=1 AND verified=1 THEN 1 ELSE 0 END) AS verified_successes, AVG(duration_ms) AS avg_duration FROM skill_runs WHERE skill_id=? AND version=? AND status!='running'").get(skillId,version); }
export function listSkills(db, { status, limit = 100 } = {}) { initSkills(db); const safe=Math.max(1,Math.min(500,Number(limit)||100)); return status ? db.prepare('SELECT * FROM skill_registry WHERE status=? ORDER BY updated_at DESC LIMIT ?').all(status,safe) : db.prepare('SELECT * FROM skill_registry ORDER BY updated_at DESC LIMIT ?').all(safe); }
