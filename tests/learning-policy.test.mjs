// P1-C / C-3：学习闭环按风险分层。
// R0/R2 攒够 2 次自动升版；R3 攒够 3 次且必须主人点头；查不到风险的技能按最保守处理。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initSkills, registerSkill, startSkillRun, finishSkillRun } from '../connect/skills.mjs';
import { policyForSkill, thresholdForSkill, describePolicy, skillPolicies } from '../connect/skills/learning-policy.mjs';
import { approveLearning, learningText, pendingLearning, shortId, sweepLearning } from '../connect/skills/learning.mjs';

function fresh(skillId = 'academy.study') {
  const dir = mkdtempSync(join(tmpdir(), 'dafeiyu-learn-policy-'));
  const db = new DatabaseSync(join(dir, 'connect.sqlite'));
  initSkills(db);
  registerSkill(db, { skillId, name: '测试技能', version: 1, steps: [{ id: 'read_rows' }], postconditions: {}, status: 'validating' });
  return { dir, db, root: dir, home: join(dir, 'runtime', 'dsh-home') };
}

const failedRun = (db, skillId, stage = 'blocked:draft_resume') => {
  const id = startSkillRun(db, { skillId, version: 1 });
  finishSkillRun(db, id, { success: false, verified: false, failureStage: stage });
  return id;
};

const okRun = (db, skillId) => {
  const id = startSkillRun(db, { skillId, version: 1 });
  finishSkillRun(db, id, { success: true, verified: true });
  return id;
};

test('风险档从 capability-map 推出来，不新造词表', () => {
  const r2 = policyForSkill('academy.study');
  assert.equal(r2.risk, 'R2');
  assert.equal(r2.threshold, 2);
  assert.equal(r2.autoApprove, true);

  const r3 = policyForSkill('douyin.publish_draft');
  assert.equal(r3.risk, 'R3');
  assert.equal(r3.threshold, 3);
  assert.equal(r3.autoApprove, false);

  const r0 = policyForSkill('douyin.check_interactions');
  assert.equal(r0.risk, 'R0');
  assert.equal(r0.autoApprove, true);

  const unknown = policyForSkill('some.unknown.skill');
  assert.equal(unknown.risk, 'unknown');
  assert.equal(unknown.autoApprove, false, '查不到风险就该要人点头');
  assert.equal(unknown.threshold, 2);

  assert.equal(thresholdForSkill('douyin.publish_draft'), 3);
  assert.match(describePolicy(r3), /R3 · 攒够 3 次，需要你点头/u);
  assert.ok(Object.keys(skillPolicies()).length >= 9, '技能下线后策略表也跟着少，但不该少于 9');
});

test('R2 技能攒够两次就自动升版（闭环不等主人点头）', () => {
  const { db, root, home } = fresh('academy.study');
  failedRun(db, 'academy.study');
  failedRun(db, 'academy.study');
  okRun(db, 'academy.study');

  const result = sweepLearning(db, { root, home });
  assert.equal(result.approved.length, 1);
  assert.equal(result.approved[0].skillId, 'academy.study');
  assert.equal(result.approved[0].from, 1);
  assert.equal(result.approved[0].to, 2);
  const registry = db.prepare('SELECT current_version, status FROM skill_registry WHERE skill_id=?').get('academy.study');
  assert.equal(registry.current_version, 2);
  assert.equal(registry.status, 'enabled');
  assert.equal(db.prepare('SELECT status FROM learning_proposals').get().status, 'validated');
  assert.equal(db.prepare('SELECT status FROM skill_proposals').get().status, 'active');
  assert.ok(existsSync(join(home, 'lessons.json')), '自动升版也要写经验本');
  const lessons = JSON.parse(readFileSync(join(home, 'lessons.json'), 'utf8'));
  assert.ok(lessons.length >= 1);
});

test('R3 技能攒够两次不够，攒够三次也仍然要主人点头', () => {
  const { db, root, home } = fresh('douyin.publish_draft');
  failedRun(db, 'douyin.publish_draft');
  failedRun(db, 'douyin.publish_draft');
  okRun(db, 'douyin.publish_draft');

  const early = sweepLearning(db, { root, home });
  assert.equal(early.approved.length, 0, '两次不够 R3 的三次门槛');
  assert.equal(early.pending.length, 1);
  assert.equal(early.pending[0].threshold, 3);
  assert.equal(early.pending[0].autoApprove, false);

  failedRun(db, 'douyin.publish_draft');
  const ready = sweepLearning(db, { root, home });
  assert.equal(ready.approved.length, 0, 'R3 不自动升版');
  assert.equal(ready.pending.length, 1);
  assert.equal(ready.pending[0].occurrences, 3);

  // 攒够了，也得主人点头才能升。
  const reflection = db.prepare("SELECT * FROM learning_proposals WHERE status IN ('candidate','validating')").get();
  const approved = approveLearning(db, shortId(reflection.id), { root, home });
  assert.equal(approved.ok, true);
  assert.equal(approved.from, 1);
  assert.equal(approved.to, 2);
});

test('R3 技能没攒够时手动批准会被挡回去', () => {
  const { db, root, home } = fresh('douyin.publish_draft');
  failedRun(db, 'douyin.publish_draft');
  failedRun(db, 'douyin.publish_draft');
  okRun(db, 'douyin.publish_draft');
  const reflection = db.prepare('SELECT * FROM learning_proposals').get();
  const blocked = approveLearning(db, shortId(reflection.id), { root, home });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'needs_repeat');
  assert.equal(db.prepare('SELECT current_version FROM skill_registry WHERE skill_id=?').get('douyin.publish_draft').current_version, 1);
});

test('清单文案按档位说话：自动档说两次，人工档说三次', () => {
  const auto = fresh('academy.study');
  failedRun(auto.db, 'academy.study');
  failedRun(auto.db, 'academy.study');
  const autoText = learningText(auto.db);
  assert.match(autoText, /攒够两次/u);
  assert.match(autoText, /我会自己升版本/u);
  assert.match(autoText, /^R[0-9a-z]{4} · academy\.study/im);

  const manual = fresh('douyin.publish_draft');
  failedRun(manual.db, 'douyin.publish_draft');
  failedRun(manual.db, 'douyin.publish_draft');
  failedRun(manual.db, 'douyin.publish_draft');
  const manualText = learningText(manual.db);
  assert.match(manualText, /攒够三次/u);
  assert.match(manualText, /需要你点头/u);
});

test('提案清单按各自档位的门槛过滤，不是写死两次', () => {
  const { db } = fresh('douyin.publish_draft');
  failedRun(db, 'douyin.publish_draft');
  failedRun(db, 'douyin.publish_draft');
  assert.equal(pendingLearning(db).reflections.length, 0, 'R3 两次不入清单');
  failedRun(db, 'douyin.publish_draft');
  assert.equal(pendingLearning(db).reflections.length, 1);
});
