import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { parseOwnWorkStats } from '../device/douyin.mjs';
import { fanSummary, fanTrend, listFans, listHotspots, openDouyinDb, saveFan, saveFanSnapshot, saveHotspot, saveWork, saveWorkStats, statsDelta, statsHistory, worksMissingStats } from '../connect/douyin/store.mjs';
import { weekStats, writeWeekly } from '../connect/academy/weekly.mjs';
import { initAcademy } from '../connect/academy/study.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'dfy-weekly-'));

const text = (value, cx = 300, cy = 300, extra = {}) => ({
  cls: 'android.widget.TextView', text: value, desc: '', clickable: false, bounds: { cx, cy, w: 200, h: 60, x: cx - 100, y: cy - 30 }, ...extra,
});

test('作品详情页能读出播放/点赞/评论数', () => {
  const nodes = [
    text('177浏览'),
    text('10', 300, 800),
    text('', 300, 700, { desc: '未点赞，喜欢10，按钮' }),
    text('', 300, 760, { desc: '评论1，按钮' }),
    text('BLG夺冠那晚我尾巴撞桌角转'),
  ];
  const stats = parseOwnWorkStats(nodes);
  assert.equal(stats.views, 177);
  assert.equal(stats.likes, 10);
  assert.equal(stats.comments, 1);
  assert.equal(stats.title, 'BLG夺冠那晚我尾巴撞桌角转');
});

test('平台数据写回 works，缺数据的作品能被列出来', () => {
  const root = tmp();
  const db = openDouyinDb(root);
  try {
    const id = saveWork(db, { id: 'w1', title: '测试作品', caption: '正文', publishedAt: new Date().toISOString(), status: 'published' });
    assert.equal(worksMissingStats(db, 5).length, 1);
    saveWorkStats(db, id, { views: 177, likes: 10, comments: 3 });
    const row = db.prepare('SELECT views, likes, comments_stat FROM works WHERE id = ?').get(id);
    assert.deepEqual({ ...row }, { views: 177, likes: 10, comments_stat: 3 });
    assert.equal(worksMissingStats(db, 5).length, 0);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('粉丝档案按互动次数累计', () => {
  const root = tmp();
  const db = openDouyinDb(root);
  try {
    saveFan(db, { name: '木纹', text: '@' });
    saveFan(db, { name: '木纹', text: '再来' });
    saveFan(db, { name: 'LP0423', text: '宕机' });
    const summary = fanSummary(db);
    assert.equal(summary.fans, 2);
    assert.equal(summary.interactions, 3);
    assert.equal(summary.top[0].name, '木纹');
    assert.equal(listFans(db, 5).length, 2);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('热点判断能落库', () => {
  const root = tmp();
  const db = openDouyinDb(root);
  try {
    saveHotspot(db, { topic: '程序员', videos: 4, topLikes: 288_000, verdict: 'join', note: '可以跟' });
    saveHotspot(db, { topic: '裁员', videos: 1, topLikes: 12_000, verdict: 'avoid', note: '太沉重' });
    const rows = listHotspots(db, 5);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].topic, '裁员');
    assert.equal(rows[1].verdict, 'join');
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('周记：真实数据进档案，模型挂了用模板兜底', async () => {
  const root = tmp();
  const db = new DatabaseSync(join(root, 'connect.sqlite'));
  const now = Date.now();
  try {
    db.exec(`CREATE TABLE external_tasks (id TEXT PRIMARY KEY, status TEXT, created_ms INTEGER);`);
    initAcademy(db);
    db.prepare('INSERT INTO external_tasks VALUES (?,?,?)').run('t1', 'succeeded', now - 3600_000);
    db.prepare('INSERT INTO external_tasks VALUES (?,?,?)').run('t2', 'failed', now - 7200_000);
    db.prepare('INSERT INTO study_sessions (day, course_id, step_key, created_at) VALUES (?,?,?,?)').run('2026-11-15', 'c01', 'intro', new Date(now - 3600_000).toISOString());
    const stats = weekStats(db, root, now);
    assert.equal(stats.tasks.total, 2);
    assert.equal(stats.tasks.succeeded, 1);
    assert.equal(stats.tasks.rate, 50);
    const ok = await writeWeekly(db, root, root, now, { ask: async () => '这周我回了几条评论，下周早点睡。' });
    assert.equal(ok.degraded, false);
    assert.equal(ok.body, '这周我回了几条评论，下周早点睡。');
    const row = db.prepare("SELECT title, body, source FROM growth_archive WHERE source = 'weekly'").get();
    assert.ok(row.title.startsWith('成长日记'));
    assert.equal(row.body, ok.body);
    const bad = await writeWeekly(db, root, root, now, { ask: async () => { throw new Error('llm_down'); } });
    assert.equal(bad.degraded, true);
    assert.match(bad.body, /llm_down/u);
    assert.match(bad.body, /任务 2 个/u);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('平台数据每天留快照，能算出两次之间涨了多少', () => {
  const root = tmp();
  const db = openDouyinDb(root);
  try {
    const id = saveWork(db, { id: 'w2', title: '趋势作品', caption: '正文', publishedAt: '2026-11-10T00:00:00.000Z', status: 'published' });
    saveWorkStats(db, id, { views: 100, likes: 10, at: '2026-11-10T10:00:00.000Z' });
    saveWorkStats(db, id, { views: 160, likes: 14, at: '2026-11-11T10:00:00.000Z' });
    saveWorkStats(db, id, { views: 220, likes: 18, at: '2026-11-12T09:00:00.000Z' });
    const rows = statsHistory(db, id, 14);
    assert.equal(rows.length, 3);
    const delta = statsDelta(db, id);
    assert.equal(delta.day, '2026-11-12');
    assert.equal(delta.views, 60);
    assert.equal(delta.likes, 4);
  } finally { db.close(); }
});

test('粉丝快照按天去重，趋势可查', () => {
  const root = tmp();
  const db = openDouyinDb(root);
  try {
    saveFan(db, { name: '小明', text: '你好' });
    saveFan(db, { name: '小红', text: '来了' });
    saveFanSnapshot(db, { at: '2026-11-12T10:00:00.000Z' });
    saveFanSnapshot(db, { at: '2026-11-12T22:00:00.000Z' }); // 同一天覆盖
    saveFanSnapshot(db, { at: '2026-11-13T10:00:00.000Z' });
    const trend = fanTrend(db, 10);
    assert.equal(trend.length, 2);
    assert.equal(trend[0].day, '2026-11-12');
    assert.equal(trend[0].fans, 2);
    assert.equal(trend[1].day, '2026-11-13');
  } finally { db.close(); }
});
