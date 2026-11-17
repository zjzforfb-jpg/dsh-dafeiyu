import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initAcademy } from '../connect/academy/study.mjs';
import { certify, collectEvidence } from '../connect/academy/levels.mjs';
import { graduationState } from '../connect/academy/graduation.mjs';
import { openDouyinDb, saveWork, saveComment, markReplied } from '../connect/douyin/store.mjs';

const NOW = Date.UTC(2026, 10, 15, 12, 0);

function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), 'dafeiyu-levels-'));
  const db = new DatabaseSync(join(root, 'connect.sqlite'));
  db.exec(`CREATE TABLE IF NOT EXISTS external_tasks (
    id TEXT PRIMARY KEY, conv_kind TEXT, conv_id TEXT, intent TEXT, payload TEXT, status TEXT,
    result TEXT, created_ms INTEGER, updated_ms INTEGER, expires_ms INTEGER, attempts INTEGER DEFAULT 0
  )`);
  initAcademy(db);
  return { root, db };
}

function addTasks(db, statuses, { base = NOW - 3600_000, step = 60_000 } = {}) {
  statuses.forEach((status, index) => {
    db.prepare('INSERT INTO external_tasks (id, conv_kind, conv_id, intent, status, created_ms) VALUES (?,?,?,?,?,?)')
      .run(`task-${Math.random().toString(36).slice(2)}`, 'c2c', 'p', '{}', status, base + index * step);
  });
}

function markCourseDone(db, id, step = 7) {
  db.prepare("INSERT INTO course_state (course_id, status, step, score, evidence, updated_at) VALUES (?, 'done', ?, 82, '{}', ?) ON CONFLICT(course_id) DO UPDATE SET status='done', step=7")
    .run(id, step, new Date(NOW).toISOString());
}

function addWorks(root, { works = 0, comments = 0, replied = 0, hotReplied = 0, publishDays = 1 }) {
  const dy = openDouyinDb(root);
  for (let i = 0; i < works; i += 1) {
    const day = new Date(NOW - (i % publishDays) * 86_400_000).toISOString();
    saveWork(dy, { id: `w${i}`, title: `作品 ${i}`, caption: '正文', topics: '#大肥鱼', publishedAt: day });
  }
  for (let i = 0; i < comments; i += 1) {
    saveComment(dy, { workId: works ? 'w0' : '', author: `粉${i % 6}`, text: `评论 ${i}`, commentAt: '今天', source: 'test' });
  }
  if (replied) {
    const rows = dy.prepare('SELECT id FROM comments LIMIT ?').all(replied);
    for (const row of rows) markReplied(dy, { id: row.id, reply: '回你啦', at: new Date(NOW).toISOString() });
  }
  for (let i = 0; i < hotReplied; i += 1) {
    dy.prepare("INSERT INTO videos (id, title, likes, status, discovered_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO NOTHING").run(`v${i}`, '爆款', 10000, 'hot', new Date(NOW - i * 1000).toISOString());
    dy.prepare('INSERT INTO hot_comments (video_id, author, text, likes, first_seen_at, replied_at) VALUES (?,?,?,?,?,?)').run(`v${i}`, 'a', `热评 ${i}`, 1000, new Date(NOW).toISOString(), new Date(NOW).toISOString());
  }
  dy.close();
}

test('认证：Lv1 要学完 3 门课 + 1 次真实任务成功', () => {
  const { root, db } = makeEnv();
  addTasks(db, ['succeeded']);
  const before = certify(db, root, NOW);
  assert.equal(before.level, 0);
  ['c01', 'c02', 'c03'].forEach((id) => markCourseDone(db, id));
  const after = certify(db, root, NOW);
  assert.equal(after.level, 1);
  assert.equal(after.changed, true);
});

test('认证：Lv2 要 3 次成功 + 回复 10 条 + 学完 6 门', () => {
  const { root, db } = makeEnv();
  addTasks(db, ['succeeded', 'succeeded', 'succeeded']);
  ['c01', 'c02', 'c03', 'c04', 'c05', 'c06'].forEach((id) => markCourseDone(db, id));
  addWorks(root, { works: 1, comments: 10, replied: 10 });
  const cert = certify(db, root, NOW);
  assert.equal(cert.level, 2);
  assert.equal(cert.next.level, 3);
  assert.ok(cert.next.requirements.some((item) => item.key === 'works' && !item.ok));
  assert.ok(collectEvidence(db, root, NOW).commentsReplied >= 10);
});

test('认证：Lv3 要一周成功率、5 个作品、30 条回复、9 门课', () => {
  const { root, db } = makeEnv();
  addTasks(db, ['succeeded', 'succeeded', 'succeeded', 'succeeded', 'failed']);
  ['c01', 'c02', 'c03', 'c04', 'c05', 'c06', 'c07', 'c08', 'c09'].forEach((id) => markCourseDone(db, id));
  addWorks(root, { works: 6, comments: 30, replied: 30, publishDays: 3 });
  const cert = certify(db, root, NOW);
  assert.equal(cert.level, 3);
  assert.equal(cert.next.level, 4);
  const rate = cert.next.requirements.find((item) => item.key === 'weekRate');
  assert.equal(rate.value, 80);
});

test('认证：等级不会因为数据回落而掉级', () => {
  const { root, db } = makeEnv();
  addTasks(db, ['succeeded', 'succeeded', 'succeeded']);
  ['c01', 'c02', 'c03', 'c04', 'c05', 'c06'].forEach((id) => markCourseDone(db, id));
  addWorks(root, { works: 1, comments: 10, replied: 10 });
  assert.equal(certify(db, root, NOW).level, 2);
  db.exec('DELETE FROM course_state');
  assert.equal(certify(db, root, NOW).level, 2);
});

test('毕业项目：12 项里程碑按真实数据判定', () => {
  const { root, db } = makeEnv();
  addTasks(db, ['succeeded', 'succeeded', 'succeeded']);
  ['c01', 'c02', 'c03', 'c04', 'c05', 'c06'].forEach((id) => markCourseDone(db, id));
  addWorks(root, { works: 3, comments: 10, replied: 10, hotReplied: 5, publishDays: 3 });
  const grad = graduationState(db, root, NOW);
  assert.equal(grad.total, 12);
  const done = new Set(grad.items.filter((item) => item.done).map((item) => item.key));
  for (const key of ['m01', 'm02', 'm03', 'm04', 'm05', 'm06', 'm07', 'm08']) assert.ok(done.has(key), key);
  assert.ok(!done.has('m10'));
  assert.ok(done.has('m11'));
  assert.equal(grad.certification.level, 2);
  assert.ok(grad.percent >= 50);
});
