import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { COURSES, LESSON_STEPS, nextCourse } from '../connect/academy/courses.mjs';
import { initAcademy, runStudyStep, resetAcademy, academySummary, academyState, recentSessions, recentArchive } from '../connect/academy/study.mjs';

const makeDb = () => { const db = new DatabaseSync(':memory:'); initAcademy(db); return db; };
const stubAsk = async () => '这是我自己的话：先想清楚，再动手做，做完看结果。';

test('课程表：12 门课、四阶段、每门有知识/案例/实战/考核/毕业标准', () => {
  assert.equal(COURSES.length, 12);
  assert.deepEqual([...new Set(COURSES.map((course) => course.stage))], [1, 2, 3, 4]);
  assert.equal(nextCourse([]).id, 'c01');
  assert.equal(nextCourse(['c01', 'c02']).id, 'c03');
  assert.equal(nextCourse(COURSES.map((course) => course.id)), null);
  for (const course of COURSES) {
    assert.ok(course.knowledge.length >= 4, `${course.id} 知识点太少`);
    assert.ok(course.case.length > 10);
    assert.ok(course.drills.length >= 3);
    assert.ok(course.rubric.length >= 3);
    assert.ok(course.graduation.length > 5);
  }
  assert.equal(LESSON_STEPS.length, 7);
});

test('七步学习：每步写一条 session，第 7 步后课程完成', async () => {
  const db = makeDb();
  const steps = [];
  for (let i = 0; i < 7; i += 1) {
    const result = await runStudyStep({ db, root: '/tmp', home: '/tmp', now: Date.UTC(2026, 10, 15 + i, 12, 0), ask: stubAsk });
    steps.push(result);
  }
  assert.deepEqual(steps.map((step) => step.stepKey), LESSON_STEPS.map((step) => step.key));
  assert.equal(steps.at(-1).status, 'course_done');
  assert.equal(recentSessions(db, 20).length, 7);
  const c01 = academyState(db).find((course) => course.id === 'c01');
  assert.equal(c01.status, 'done');
  assert.equal(c01.step, 7);
  assert.equal(academySummary(db).stepsTotal, 12 * 7);
});

test('考核步骤：从回答里读分数，60 分以上记为通过并写进技能档案', async () => {
  const db = makeDb();
  for (const key of ['intro', 'knowledge', 'case', 'imitate', 'practice']) {
    await runStudyStep({ db, root: '/tmp', home: '/tmp', ask: stubAsk });
  }
  const assess = await runStudyStep({ db, root: '/tmp', home: '/tmp', ask: async () => '我给自己打 82 分，不足是案例拆得浅、练习次数少。' });
  assert.equal(assess.stepKey, 'assess');
  assert.equal(assess.score, 82);
  assert.equal(assess.passed, true);
  const skill = recentArchive(db, 20, 'skill');
  assert.equal(skill.length, 1);
  assert.match(skill[0].body, /82 分/);
});

test('学习块：模型挂了用课程内容兜底并标出降级', async () => {
  const db = makeDb();
  const result = await runStudyStep({ db, root: '/tmp', home: '/tmp', ask: async () => { throw new Error('llm_down'); } });
  assert.equal(result.degraded, true);
  assert.equal(result.error, 'llm_down');
  assert.ok(result.summary.length > 0);
  assert.equal(recentArchive(db, 10).filter((row) => row.section === 'growth').length, 1);
});

test('重置学习进度：清空课程进度和学习记录，档案保留', async () => {
  const db = makeDb();
  await runStudyStep({ db, root: '/tmp', home: '/tmp', ask: stubAsk });
  await runStudyStep({ db, root: '/tmp', home: '/tmp', ask: stubAsk });
  resetAcademy(db);
  assert.equal(recentSessions(db, 10).length, 0);
  assert.equal(academyState(db).find((course) => course.id === 'c01').step, 0);
  assert.ok(recentArchive(db, 10).length >= 1);
});
