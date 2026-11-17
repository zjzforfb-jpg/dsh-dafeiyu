import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LESSONS, lessonsFor, learnLesson, loadDynamicLessons, staticLessonsFor } from '../connect/qq/lessons.mjs';
import { addLesson, loadLessons } from '../connect/douyin/lessons.mjs';
import { migrateLessonRecords } from '../connect/lessons-store.mjs';
import { CASES, categoryOf, forbidsWrite } from '../scripts/intent-regress.mjs';

test('经验库：常驻规则每次都在，关键词规则按需带', () => {
  const chat = staticLessonsFor('今天好累').map((item) => item.id);
  assert.ok(chat.includes('question-not-command'));
  assert.ok(chat.includes('facts-before-promise'));
  assert.ok(!chat.includes('comment-rate-limit'));
  const comment = staticLessonsFor('把评论都回一遍').map((item) => item.id);
  assert.ok(comment.includes('comment-rate-limit'));
  assert.ok(comment.includes('write-needs-confirm'));
});

test('经验库：踩过的坑会写进 lessons.json 并读回来，去重且限量', () => {
  const home = mkdtempSync(join(tmpdir(), 'dafeiyu-lessons-'));
  assert.deepEqual(loadDynamicLessons(home), []);
  assert.equal(learnLesson(home, '问句不要建任务', 'test'), true);
  assert.equal(learnLesson(home, '问句不要建任务', 'test'), false);
  assert.equal(learnLesson(home, '', 'test'), false);
  assert.deepEqual(loadDynamicLessons(home), ['问句不要建任务']);
  assert.ok(lessonsFor(home, '随便聊聊').includes('问句不要建任务'));
  assert.ok(existsSync(join(home, 'lessons.json')));
  assert.match(readFileSync(join(home, 'lessons.json'), 'utf8'), /问句不要建任务/);
});

test('shared lessons keep QQ and Douyin channels separate and import the old Douyin file', () => {
  const root = mkdtempSync(join(tmpdir(), 'dafeiyu-lessons-migration-'));
  const home = join(root, 'runtime', 'dsh-home');
  const legacyDir = join(root, 'runtime', 'douyin');
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, 'lessons.json'), JSON.stringify({ lessons: [{ text: '只在抖音用的旧经验', kind: 'note' }] }));
  try {
    const file = join(home, 'lessons.json');
    assert.equal(lessonsFor(home, '随便聊聊').includes('只在抖音用的旧经验'), false);
    assert.ok(existsSync(join(legacyDir, 'lessons.json.migrated')));
    assert.ok(loadLessons(file).lessons.some((row) => row.text === '只在抖音用的旧经验'));
    addLesson(file, { text: '只在抖音用的旧经验' });
    assert.ok(existsSync(file));
    assert.equal(learnLesson(home, '只在 QQ 用的新经验', 'test'), true);
    addLesson(file, { text: '只在抖音用的新经验' });
    assert.equal(loadLessons(file).lessons.some((row) => row.text === '只在 QQ 用的新经验'), false);
    assert.equal(lessonsFor(home, '随便聊聊').includes('只在抖音用的新经验'), false);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(Array.isArray(saved));
    assert.ok(saved.some((row) => row.text === '只在抖音用的旧经验' && row.channels.includes('douyin')));
    assert.equal(migrateLessonRecords(file).length, saved.length);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('回归集：分类器把步骤映射成意图类型', () => {
  assert.equal(categoryOf([]), 'chat');
  assert.equal(categoryOf([{ tool: 'weather.get' }]), 'weather');
  assert.equal(categoryOf([{ tool: 'works.list' }]), 'read');
  assert.equal(categoryOf([{ tool: 'device.page' }]), 'device');
  assert.equal(categoryOf([{ tool: 'works.list' }, { tool: 'douyin.reply_comments' }]), 'write-reply');
  assert.equal(categoryOf([{ tool: 'douyin.publish' }]), 'write-publish');
});

test('回归集：问句护栏能认出提问', () => {
  assert.equal(forbidsWrite('现在有新增的未回复评论吗？'), true);
  assert.equal(forbidsWrite('把收到的评论都回一遍'), false);
  assert.equal(CASES.length, 30);
  for (const [text, expected] of CASES) {
    assert.ok(Array.isArray(expected) && expected.length, `case ${text} 没写期望`);
    assert.ok(!(forbidsWrite(text) && expected.some((item) => item.startsWith('write-'))), `case ${text} 问句期望写操作`);
  }
});
