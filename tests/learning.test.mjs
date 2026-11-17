import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initSkills, registerSkill, startSkillRun, finishSkillRun } from '../connect/skills.mjs';
import { approveLearning, learningText, listRollbacks, maybeRollback, pendingLearning, rejectLearning, shortId } from '../connect/skills/learning.mjs';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'dafeiyu-learn-'));
  const db = new DatabaseSync(join(dir, 'connect.sqlite'));
  initSkills(db);
  registerSkill(db, { skillId: 'douyin.check_interactions', name: '看互动', version: 1, steps: [{ id: 'read_rows', assert: 'count' }], postconditions: {}, status: 'enabled' });
  return { dir, db, root: dir, home: join(dir, 'runtime', 'dsh-home') };
}

const failedRun = (db, stage = 'blocked:draft_resume') => {
  const id = startSkillRun(db, { skillId: 'douyin.check_interactions', version: 1 });
  finishSkillRun(db, id, { success: false, verified: false, failureStage: stage });
  return id;
};
const okRun = (db) => {
  const id = startSkillRun(db, { skillId: 'douyin.check_interactions', version: 1 });
  finishSkillRun(db, id, { success: true, verified: true });
  return id;
};
const failOnVersion = (db, version, times) => {
  for (let i = 0; i < times; i += 1) {
    const id = startSkillRun(db, { skillId: 'douyin.check_interactions', version });
    finishSkillRun(db, id, { success: false, verified: false, failureStage: 'blocked:draft_resume' });
  }
};

test('同一个失败两次才进提案，一次不算', () => {
  const { db } = fresh();
  failedRun(db);
  assert.equal(pendingLearning(db).reflections.length, 0);
  failedRun(db);
  const { reflections } = pendingLearning(db);
  assert.equal(reflections.length, 1);
  assert.equal(reflections[0].occurrences, 2);
});

test('批准后升到 v2、写经验本、记录回退策略', () => {
  const { db, dir, root, home } = fresh();
  failedRun(db); failedRun(db); okRun(db);
  const { reflections } = pendingLearning(db);
  const result = approveLearning(db, shortId(reflections[0].id), { root, home, now: Date.UTC(2026, 10, 16) });
  assert.equal(result.ok, true);
  assert.equal(result.from, 1);
  assert.equal(result.to, 2);
  const registry = db.prepare('SELECT current_version, status FROM skill_registry WHERE skill_id=?').get('douyin.check_interactions');
  assert.equal(registry.current_version, 2);
  const v2 = db.prepare('SELECT fallback, status FROM skill_versions WHERE skill_id=? AND version=2').get('douyin.check_interactions');
  assert.equal(v2.status, 'enabled');
  assert.match(v2.fallback, /close_dialog_then_retry/u);
  assert.ok(existsSync(join(home, 'lessons.json')));
  const lessons = JSON.parse(readFileSync(join(home, 'lessons.json'), 'utf8'));
  assert.ok(Array.isArray(lessons));
  assert.ok(lessons.some((lesson) => /继续编辑作品/u.test(lesson.text) && lesson.channels.includes('douyin') && lesson.channels.includes('qq')));
});

test('新版本连续三次失败自动回滚，并记一条回滚经验', () => {
  const { db, root, home } = fresh();
  failedRun(db); failedRun(db); okRun(db);
  const { reflections } = pendingLearning(db);
  approveLearning(db, shortId(reflections[0].id), { root, home });
  failOnVersion(db, 2, 3);
  const result = maybeRollback(db, 'douyin.check_interactions', { root, home });
  assert.equal(result.rolledBack, true);
  assert.equal(result.from, 2);
  assert.equal(result.to, 1);
  assert.equal(db.prepare('SELECT current_version FROM skill_registry WHERE skill_id=?').get('douyin.check_interactions').current_version, 1);
  assert.equal(db.prepare('SELECT status FROM skill_versions WHERE skill_id=? AND version=2').get('douyin.check_interactions').status, 'deprecated');
  const rollbacks = listRollbacks(db);
  assert.equal(rollbacks.length, 1);
  assert.equal(rollbacks[0].from_version, 2);
  assert.equal(rollbacks[0].to_version, 1);
});

test('驳回、找不到、没有验证成功过都不改版本', () => {
  const { db, root, home } = fresh();
  failedRun(db); failedRun(db);
  const { reflections } = pendingLearning(db);
  assert.equal(rejectLearning(db, shortId(reflections[0].id)).ok, true);
  assert.equal(pendingLearning(db).reflections.length, 0);
  assert.equal(approveLearning(db, 'zzzz', { root, home }).ok, false);

  const second = fresh();
  failedRun(second.db); failedRun(second.db);
  const target = pendingLearning(second.db).reflections[0];
  const blocked = approveLearning(second.db, shortId(target.id), { root: second.root, home: second.home });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'verified_successful_run_required');
  assert.equal(second.db.prepare('SELECT current_version FROM skill_registry WHERE skill_id=?').get('douyin.check_interactions').current_version, 1);
});

test('学习清单文案带可批准编号', () => {
  const { db } = fresh();
  failedRun(db); failedRun(db);
  const text = learningText(db);
  assert.match(text, /^R[0-9a-z]{4} · douyin\.check_interactions/im);
  assert.match(text, /继续编辑作品/u);
});

test('QQ：提案清单 + 批准命令真的升版本（走 service 分支）', async () => {
  const { default: assertExtra } = await import('node:assert/strict');
  const { initTasks } = await import('../connect/tasks.mjs');
  const { initAgentEvents } = await import('../connect/agent-events.mjs');
  const { initQq, savePeer, syncQqOwner } = await import('../connect/qq/store.mjs');
  const { QqService } = await import('../connect/qq/service.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'dafeiyu-learn-qq-'));
  const db = new DatabaseSync(join(dir, 'connect.sqlite'));
  initTasks(db); initQq(db); initAgentEvents(db);
  savePeer(db, { kind: 'c2c', id: 'user-openid-0001', label: '爸爸' }); syncQqOwner(db, 'user-openid-0001');
  registerSkill(db, { skillId: 'douyin.check_interactions', name: '看互动', version: 1, steps: [{ id: 'read_rows' }], status: 'enabled' });
  const run = (ok, stage = null) => { const id = startSkillRun(db, { skillId: 'douyin.check_interactions', version: 1 }); finishSkillRun(db, id, { success: ok, verified: ok, failureStage: stage }); };
  run(false, 'blocked:draft_resume'); run(false, 'blocked:draft_resume'); run(true);
  const sent = [];
  const svc = new QqService({
    db,
    voice: { transcribeBytes: async () => ({ text: '语音' }), synthesize: async () => ({ silk: Buffer.from('x'), duration_ms: 1 }), status: () => ({}) },
    api: { sendText: async (value) => { sent.push(typeof value === 'string' ? value : value.content); }, sendVoice: async () => ({}), sendImage: async () => ({}) },
    ask: async () => '我是大肥鱼。',
    planner: { plan: async () => ({ say: '', steps: [] }) },
    home: join(dir, 'runtime', 'dsh-home'),
    now: () => Date.now(),
    gateway: { start: async () => {}, close: async () => {} },
  });
  await svc.handle({ kind: 'c2c', id: 'user-openid-0001', messageId: 'm1', text: '提案' });
  assertExtra.match(sent.at(-1), /攒够两次/);
  const reflection = db.prepare('SELECT id FROM learning_proposals').get();
  await svc.handle({ kind: 'c2c', id: 'user-openid-0001', messageId: 'm2', text: `批准 R${shortId(reflection.id)}` });
  assertExtra.match(sent.at(-1), /升到 v2/);
  assertExtra.equal(db.prepare('SELECT current_version FROM skill_registry WHERE skill_id=?').get('douyin.check_interactions').current_version, 2);
});
