import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { finishSkillRun, initSkills, proposeSkill, registerSkill, setSkillStatus, skillStats, startSkillRun } from '../connect/skills.mjs';

test('技能支持版本、候选提议、运行记录和启用', () => {
  const db = new DatabaseSync(':memory:'); initSkills(db);
  registerSkill(db, { skillId: 'douyin.open_comments', name: '打开评论区', steps: ['observe', 'tap'], version: 1 });
  const proposal = proposeSkill(db, { skillId: 'douyin.open_comments', version: 1, reason: '首次验证', evidence: { source: 'test' } });
  assert.equal(proposal.status, 'candidate');
  setSkillStatus(db, 'douyin.open_comments', 1, 'enabled');
  const run = startSkillRun(db, { skillId: 'douyin.open_comments', version: 1, environment: { device: 'Magic5' } });
  finishSkillRun(db, run, { success: true, verified: true, durationMs: 120 });
  const stats = skillStats(db, 'douyin.open_comments', 1);
  assert.equal(stats.runs, 1); assert.equal(stats.verified_successes, 1);
  db.close();
});
