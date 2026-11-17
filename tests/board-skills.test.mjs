import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { initSkills, registerSkill, startSkillRun, finishSkillRun } from '../connect/skills.mjs';
import { initSteps, recordSteps } from '../connect/skills/steps.mjs';
import { boardList } from '../connect/board.mjs';

test('看板 skill_runs 列表带步骤数与失败阶段', () => {
  const db = new DatabaseSync(':memory:');
  initSkills(db);
  initSteps(db);
  registerSkill(db, { skillId: 'douyin.check_interactions', name: '看互动', version: 1, steps: ['a', 'b'] });
  const run = startSkillRun(db, { skillId: 'douyin.check_interactions', version: 1 });
  recordSteps(db, { runId: run, skillId: 'douyin.check_interactions', steps: [{ id: 'reset_app', ok: true }, { id: 'read_rows', ok: false, evidence: 'blocked:draft_resume' }] });
  finishSkillRun(db, run, { success: false, verified: false, failureStage: 'blocked:draft_resume', durationMs: 42 });
  const list = boardList(db, '/tmp', { section: 'skill_runs', page: 1, size: 10 });
  db.close();
  assert.equal(list.total, 1);
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].failure_stage, 'blocked:draft_resume');
  assert.equal(list.items[0].steps, 2);
});
