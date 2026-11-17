// P1-C / C-4：技能从 validating 升到 enabled 的闸门。
// 要有一条验证过的成功 run + 把这条 run 的证据重放给结构化断言，全部核过才升。
// 核不了的步骤算失败——宁可少升，不可把没核过的技能放开。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initSkills, registerSkill, startSkillRun, finishSkillRun } from '../connect/skills.mjs';
import { recordSteps } from '../connect/skills/steps.mjs';
import { evaluateSkill, promoteSkills, promotionCandidates, runData } from '../connect/skills/promotion.mjs';

const LONG_SUMMARY = '这是一段足够长的学习摘要，用来验证摘要长度断言确实会核过而不是随便放行，所以这里再多写一点字，把长度补到六十个字符以上，确保断言是真的数了长度。';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'dafeiyu-promote-'));
  const db = new DatabaseSync(join(dir, 'connect.sqlite'));
  initSkills(db);
  db.exec('CREATE TABLE IF NOT EXISTS study_sessions(id INTEGER PRIMARY KEY, skill_id TEXT, step INTEGER, at TEXT)');
  db.prepare('INSERT INTO study_sessions(skill_id, step, at) VALUES(?,?,?)').run('academy.study', 4, '2026-11-16');
  registerSkill(db, {
    skillId: 'academy.study',
    name: '成长学院学一步',
    version: 1,
    steps: [{ id: 'pick_course' }, { id: 'digest' }, { id: 'save' }],
    postconditions: {},
    status: 'validating',
  });
  return { dir, db, root: dir };
}

const verifiedRun = (db, { skillId = 'academy.study', data = null, steps = null } = {}) => {
  const id = startSkillRun(db, { skillId, version: 1 });
  finishSkillRun(db, id, {
    success: true,
    verified: true,
    result: data
      ? { action: skillId, durationMs: 10, data }
      : { action: skillId, durationMs: 10, data: null },
  });
  if (steps) recordSteps(db, { runId: id, skillId, steps });
  return id;
};

const studyData = (overrides = {}) => ({
  status: 'step_done',
  courseId: 'c01',
  courseTitle: '自我认知与角色世界观',
  step: 4,
  summary: LONG_SUMMARY,
  degraded: false,
  ...overrides,
});

const studySteps = () => ([
  { id: 'pick_course', ok: true, evidence: '自我认知与角色世界观' },
  { id: 'digest', ok: true, evidence: '176 字' },
  { id: 'save', ok: true, evidence: '第 4/7 步 step_done' },
]);

test('有验证过的成功 run 且断言全过 → 升到 enabled', () => {
  const { db, root } = fresh();
  verifiedRun(db, { data: studyData(), steps: studySteps() });
  const result = promoteSkills(db, { root });
  assert.equal(result.promoted.length, 1);
  assert.equal(result.promoted[0].skillId, 'academy.study');
  assert.equal(result.promoted[0].passed, 3);
  assert.equal(result.promoted[0].total, 3);
  const registry = db.prepare('SELECT status, current_version FROM skill_registry WHERE skill_id=?').get('academy.study');
  assert.equal(registry.status, 'enabled');
  assert.equal(registry.current_version, 1);
  assert.equal(db.prepare('SELECT status FROM skill_versions WHERE skill_id=? AND version=1').get('academy.study').status, 'enabled');
});

test('没有验证过的成功 run → 不升', () => {
  const { db, root } = fresh();
  const id = startSkillRun(db, { skillId: 'academy.study', version: 1 });
  finishSkillRun(db, id, { success: true, verified: false, result: { data: studyData() } });
  const result = promoteSkills(db, { root });
  assert.equal(result.promoted.length, 0);
  assert.equal(db.prepare('SELECT status FROM skill_registry WHERE skill_id=?').get('academy.study').status, 'validating');
});

test('字段对不上就卡住，并说清卡在哪一步', () => {
  const { db, root } = fresh();
  verifiedRun(db, { data: studyData({ courseTitle: '' }), steps: studySteps() });
  const result = promoteSkills(db, { root });
  assert.equal(result.promoted.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].skillId, 'academy.study');
  assert.ok(result.skipped[0].blockers.some((item) => item.step === 'pick_course'));
  assert.equal(db.prepare('SELECT status FROM skill_registry WHERE skill_id=?').get('academy.study').status, 'validating');
});

test('数据缺字段、断言核不过就不升（核不了就是 false）', () => {
  const { db, root } = fresh();
  // 有验证过的成功 run，但业务数据缺关键字段（courseTitle/courseId）→
  // pick_course 的 field_not_empty 核不过 → 闸门不放行。核不了就不许升。
  verifiedRun(db, { data: { status: 'step_done', step: 4 }, steps: null });
  const evaluation = evaluateSkill(db, 'academy.study', { root });
  assert.equal(evaluation.ok, false);
  assert.ok(evaluation.blockers.some((item) => item.step === 'pick_course'));
  assert.equal(promoteSkills(db, { root }).promoted.length, 0);
});

test('升过一次就不再重复升', () => {
  const { db, root } = fresh();
  verifiedRun(db, { data: studyData(), steps: studySteps() });
  assert.equal(promoteSkills(db, { root }).promoted.length, 1);
  assert.equal(promoteSkills(db, { root }).promoted.length, 0);
  assert.equal(promotionCandidates(db).length, 0);
});

test('run.result 包了 data 的也能取出业务数据', () => {
  assert.equal(runData({ result: JSON.stringify({ action: 'x', data: { a: 1 } }) }).a, 1);
  assert.equal(runData({ result: JSON.stringify({ b: 2 }) }).b, 2);
});

test('界面类步骤没步骤证据就核不了 → 不升（不会拿最终 activity 糊弄）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dafeiyu-promote-ui-'));
  const db = new DatabaseSync(join(dir, 'connect.sqlite'));
  initSkills(db);
  registerSkill(db, {
    skillId: 'douyin.check_interactions',
    name: '查抖音评论消息',
    version: 1,
    steps: [{ id: 'reset_app' }, { id: 'open_interaction' }],
    postconditions: {},
    status: 'validating',
  });
  // 有验证过的成功 run，业务数据里 activity 为空、又没记步骤事件 →
  // reset_app/open_interaction 的 activity 断言无从核起 → 闸门不放行。
  const id = startSkillRun(db, { skillId: 'douyin.check_interactions', version: 1 });
  finishSkillRun(db, id, { success: true, verified: true, result: { data: { status: 'empty', verified: true } } });
  const evaluation = evaluateSkill(db, 'douyin.check_interactions', { root: dir });
  assert.equal(evaluation.ok, false);
  assert.ok(evaluation.blockers.some((item) => item.step === 'open_interaction'));
  assert.equal(promoteSkills(db, { root: dir }).promoted.length, 0);
});
