import { randomUUID } from 'node:crypto';

export function initReflections(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS learning_proposals(
    id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'reflection', skill_id TEXT, version INTEGER,
    pattern_key TEXT NOT NULL, summary TEXT NOT NULL, evidence TEXT NOT NULL DEFAULT '{}',
    occurrences INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'candidate' CHECK(status IN ('candidate','validating','validated','rejected')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  ); CREATE UNIQUE INDEX IF NOT EXISTS learning_pattern ON learning_proposals(pattern_key);`);
}
const encode = value => { try { return JSON.stringify(value ?? {}); } catch { return '{}'; } };
const decode = value => { try { return JSON.parse(value); } catch { return {}; } };

export function reflectOnSkillRun(db, runId, now = new Date()) {
  initReflections(db);
  const run = db.prepare('SELECT * FROM skill_runs WHERE id=?').get(runId);
  if (!run || run.status === 'succeeded') return null;
  const result = decode(run.result);
  const patternKey = `${run.skill_id}:failure:${run.failure_stage ?? 'unknown'}`;
  const previous = db.prepare('SELECT * FROM learning_proposals WHERE pattern_key=?').get(patternKey);
  const evidence = { run_id: run.id, status: run.status, failure_stage: run.failure_stage, result, environment: decode(run.environment) };
  if (previous) {
    db.prepare('UPDATE learning_proposals SET occurrences=occurrences+1,evidence=?,updated_at=? WHERE id=?').run(encode(evidence), new Date(now).toISOString(), previous.id);
    return db.prepare('SELECT * FROM learning_proposals WHERE id=?').get(previous.id);
  }
  const summary = `技能 ${run.skill_id}.v${run.version} 在 ${run.failure_stage ?? '未知阶段'} 未完成，需要重新观察并验证恢复策略。`;
  const id = `reflection_${randomUUID()}`;
  db.prepare('INSERT INTO learning_proposals(id,skill_id,version,pattern_key,summary,evidence) VALUES(?,?,?,?,?,?)').run(id,run.skill_id,run.version,patternKey,summary,encode(evidence));
  return db.prepare('SELECT * FROM learning_proposals WHERE id=?').get(id);
}

export function listReflections(db, { status, limit = 100 } = {}) { initReflections(db); const safe=Math.max(1,Math.min(500,Number(limit)||100)); return status ? db.prepare('SELECT * FROM learning_proposals WHERE status=? ORDER BY updated_at DESC LIMIT ?').all(status,safe) : db.prepare('SELECT * FROM learning_proposals ORDER BY updated_at DESC LIMIT ?').all(safe); }

export function setReflectionStatus(db, id, status) { initReflections(db); if(!['candidate','validating','validated','rejected'].includes(status)) throw new Error('invalid_reflection_status'); db.prepare('UPDATE learning_proposals SET status=?,updated_at=datetime(\'now\') WHERE id=?').run(status,id); return db.prepare('SELECT * FROM learning_proposals WHERE id=?').get(id); }

// P1-C / C-3：证据门槛不再写死 2 次，按技能风险档（R0/R2 两次、R3 三次）传进来。
export function validateReflection(db, id, { successfulRunId, minOccurrences = 2 } = {}) {
  initReflections(db);
  const proposal = db.prepare('SELECT * FROM learning_proposals WHERE id=?').get(id);
  if (!proposal) return null;
  if (Number(proposal.occurrences ?? 0) < Number(minOccurrences ?? 2)) throw new Error('reflection_needs_repeated_evidence');
  const run = db.prepare("SELECT * FROM skill_runs WHERE id=? AND skill_id=? AND version=? AND status='succeeded' AND success=1 AND verified=1").get(successfulRunId, proposal.skill_id, proposal.version);
  if (!run) throw new Error('verified_successful_run_required');
  db.prepare("UPDATE learning_proposals SET status='validated',evidence=?,updated_at=datetime('now') WHERE id=?").run(encode({ ...decode(proposal.evidence), validation_run_id: run.id }), id);
  const skillProposalId = `skill_proposal_${randomUUID()}`;
  db.prepare('INSERT INTO skill_proposals(id,skill_id,version,reason,evidence,status) VALUES(?,?,?,?,?,?)').run(skillProposalId, proposal.skill_id, proposal.version, proposal.summary, encode({ reflection_id: id, validation_run_id: run.id }), 'candidate');
  return { reflection: db.prepare('SELECT * FROM learning_proposals WHERE id=?').get(id), skillProposal: db.prepare('SELECT * FROM skill_proposals WHERE id=?').get(skillProposalId) };
}
