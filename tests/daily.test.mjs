import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initTasks, proposeTask } from '../connect/tasks.mjs';
import { initAgentEvents } from '../connect/agent-events.mjs';
import { migrateConnect } from '../connect/core/migrations.mjs';
import { DAILY_SLOTS, lifeTheme, prepareDailyPost, readDailyLog } from '../connect/douyin/daily.mjs';
import { buildPlan } from '../connect/douyin/dayplan.mjs';

const template = (title) => ({
  status: 'draft',
  title,
  topics: ['#大肥鱼', '#日常'],
  settings: { aiDeclared: true, downloadOff: true, saveAlbumOff: true },
  imageFile: '/tmp/daily.png',
  draftFile: '/tmp/daily-draft.json',
});

function freshDb() {
  const db = new DatabaseSync(':memory:');
  initTasks(db);
  initAgentEvents(db);
  return db;
}

function tempRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'dafeiyu-daily-'));
  mkdirSync(join(dir, 'runtime', 'douyin'), { recursive: true });
  return dir;
}

const targets = { qq: { dad: 'dad-conv' } };

test('日常选题：三个时段各有各的日常，避开用过的，能带今天的真实战绩', () => {
  const seen = new Set();
  for (const slot of ['morning', 'noon', 'evening']) {
    const theme = lifeTheme({ slot, stats: {}, random: () => 0.1 });
    assert.ok(theme.length > 6);
    seen.add(theme);
  }
  assert.equal(seen.size, 3);
  const used = [lifeTheme({ slot: 'morning', random: () => 0.1 })];
  assert.notEqual(lifeTheme({ slot: 'morning', random: () => 0.1, used }), used[0]);
  const rich = lifeTheme({ slot: 'evening', stats: { mood: 'happy', comments: 4, study: '学完「选题：找一个人想看的点」第 1 遍：…' }, random: () => 0 });
  assert.match(rich, /心情不错|回了 4 条|学了「选题/);
});

test('到点写日常：自动停在发布前，任务进 awaiting_publish，并把二审消息+配图发出去', async () => {
  const db = freshDb();
  const root = tempRoot();
  const sent = [];
  const result = await prepareDailyPost({
    db, root, now: Date.UTC(2026, 10, 15, 0, 30), slot: 'morning', targets,
    notify: async (message) => { sent.push(message); },
    runPrepare: async () => template('早上被键盘声吵醒'),
  });
  assert.equal(result.status, 'awaiting_publish');
  assert.ok(result.taskId);
  const task = db.prepare('SELECT status, payload, approver_peer_id FROM external_tasks WHERE id=?').get(result.taskId);
  assert.equal(task.status, 'awaiting_publish');
  assert.equal(task.approver_peer_id, null);
  assert.match(task.payload, /douyin\.publish/);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /1\. 标题：早上被键盘声吵醒/);
  assert.match(sent[0].text, /2\. 正文：/);
  assert.match(sent[0].text, /回「同意」或「发」/);
  assert.equal(sent[0].image, '/tmp/daily.png');
  assert.equal(readDailyLog(root).themes.length, 1);
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('已经有待办时不再堆第二条日常', async () => {
  const db = freshDb();
  const root = tempRoot();
  proposeTask(db, { kind: 'c2c', convId: 'dad-conv', sourceMessageId: 'x', intent: { intent: 'external_action_request', operations: ['douyin.publish'], target: 'user_requested' }, origin: 'plan' });
  const result = await prepareDailyPost({ db, root, targets, notify: async () => {}, runPrepare: async () => template('不该写') });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'pending_task');
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('日程里早中晚各排一条日常图文', () => {
  const plan = buildPlan({ day: '2026-11-16', mood: 'happy', energy: 0.8 });
  const daily = plan.slots.filter((slot) => slot.action === 'douyin.daily_post');
  assert.equal(daily.length, 3);
  assert.deepEqual(daily.map((slot) => slot.args.slot), ['morning', 'noon', 'evening']);
  assert.deepEqual(daily.map((slot) => new Date(slot.at_ms + 8 * 3600_000).toISOString().slice(11, 16)), DAILY_SLOTS.map((slot) => slot.at));
});

test('有图文在等爸爸点头时，其他动手机的动作先让路', async () => {
  const db = freshDb();
  const root = tempRoot();
  const { savePlan, initPlans } = await import('../connect/douyin/dayplan.mjs');
  initPlans(db);
  const plan = buildPlan({ day: '2026-11-16', mood: 'calm', energy: 0.6 });
  savePlan(db, plan, Date.UTC(2026, 10, 15, 23, 0));
  await prepareDailyPost({
    db, root, now: Date.UTC(2026, 10, 16, 0, 30), slot: 'morning', targets,
    notify: async () => {},
    runPrepare: async () => template('早上的日常'),
  });
  // 草稿不占手机：把任务标成真正的「已填页」才需要让路
  db.prepare("UPDATE external_tasks SET result=? WHERE status='awaiting_publish'").run(JSON.stringify({ stage: 'filled' }));
  const hot = plan.slots.find((slot) => slot.action === 'douyin.hot_comment_round');
  const { fireSlot } = await import('../connect/scheduler.mjs');
  const result = await fireSlot({ db, root, slot: hot, now: Date.UTC(2026, 10, 16, 4, 0), execute: async () => ({ ok: true }), targets });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'waiting_for_publish');
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('环境抖动导致的失败会被放回队列重试一次，逻辑错误不重试', async () => {
  const { initPlans, savePlan, markSlot } = await import('../connect/douyin/dayplan.mjs');
  const { requeueTransient } = await import('../connect/scheduler.mjs');
  const db = new DatabaseSync(':memory:');
  initPlans(db);
  const day = '2026-11-17';
  const now = Date.parse(`${day}T12:00:00+08:00`);
  savePlan(db, {
    day,
    mood: 'calm',
    slots: [
      { id: `${day}-a`, day, at_ms: now - 3 * 3600_000, action: 'douyin.daily_post', args: {} },
      { id: `${day}-b`, day, at_ms: now - 2 * 3600_000, action: 'douyin.check_interactions', args: {} },
      { id: `${day}-c`, day, at_ms: now - 3600_000, action: 'douyin.hotspot', args: {} },
    ],
  }, now);
  markSlot(db, `${day}-a`, { status: 'failed', firedAt: now, note: 'Command failed: adb: device offline' });
  markSlot(db, `${day}-b`, { status: 'failed', firedAt: now, note: 'action_not_implemented' });
  markSlot(db, `${day}-c`, { status: 'failed', firedAt: now, note: 'publish_unconfirmed:点了发作品但没看到正文' });
  const picked = requeueTransient(db, { now });
  assert.deepEqual(picked.map((row) => row.id), [`${day}-a`], '只有 adb 掉线那种才算可重试');
  const row = db.prepare('SELECT status, note FROM plan_slots WHERE id=?').get(`${day}-a`);
  assert.equal(row.status, 'planned');
  assert.match(row.note, /^retry:/u);
  // 重试过的不会再次入选
  assert.deepEqual(requeueTransient(db, { now }), []);
  db.close();
});

test('抖动重排的槽会用新任务重试，不会被上一轮那个失败任务卡住', async () => {
  const { initPlans, savePlan } = await import('../connect/douyin/dayplan.mjs');
  const { requeueTransient, slotAttempt, tick } = await import('../connect/scheduler.mjs');
  const db = new DatabaseSync(':memory:');
  migrateConnect(db);
  initTasks(db);
  initPlans(db);
  const now = Date.parse('2026-11-16T10:00:00+08:00');
  const day = '2026-11-16';
  const plan = buildPlan({ day, mood: 'calm', energy: 0.5 });
  savePlan(db, plan);
  // 挑第一条「自动可跑」的槽，标成环境抖动导致的失败
  const target = plan.slots.find((slot) => slot.action === 'douyin.check_interactions');
  db.prepare("UPDATE plan_slots SET status='failed', note='Command failed: adb: device offline', at_ms=? WHERE id=?").run(now - 60_000, target.id);

  const picked = requeueTransient(db, { now });
  assert.equal(picked.length, 1);
  assert.equal(picked[0].attempt, 1);
  const row = db.prepare('SELECT note FROM plan_slots WHERE id=?').get(target.id);
  assert.equal(slotAttempt(row.note), 1);

  // 再跑一次 tick：这次应该起一条全新任务（而不是复用上一轮已失败的那条）
  const first = await (async () => {
    const created = [];
    const execute = async (name) => { created.push(name); return { ok: true, text: 'done', data: { status: 'ok', count: 1 } }; };
    const out = await tick({ db, root: process.cwd(), now, execute, notify: null });
    return out;
  })();
  assert.ok(first.fired.length >= 1, '重排后的槽要被重新执行');
  const tasks = db.prepare("SELECT id, status FROM external_tasks WHERE origin='plan'").all();
  assert.ok(tasks.length >= 1);
  db.close();
});

test('评论额度用完时，回复类槽直接标跳过，不去跑必然失败的那一轮', async () => {
  const { quotaSkip, COMMENT_ACTIONS } = await import('../connect/scheduler.mjs');
  // 回复类动作在名单里
  for (const action of ['douyin.reply_comments', 'douyin.hot_comment_round', 'douyin.comment_latest']) {
    assert.ok(COMMENT_ACTIONS.has(action), `${action} 应该受额度约束`);
  }
  // 额度用完 → 跳过，理由带用量
  assert.equal(quotaSkip('douyin.reply_comments', { hourlyLeft: 0, hourlyUsed: 5, hourlyCap: 5 }), 'quota_exhausted:5/5');
  // 还有额度 → 照常跑
  assert.equal(quotaSkip('douyin.reply_comments', { hourlyLeft: 2, hourlyUsed: 3, hourlyCap: 5 }), null);
  // 不耗额度的动作不受影响
  assert.equal(quotaSkip('douyin.daily_post', { hourlyLeft: 0, hourlyUsed: 9, hourlyCap: 5 }), null);
  // 没核验过（没有 quota）也照常跑，别把「不知道」当成 0
  assert.equal(quotaSkip('douyin.reply_comments', null), null);
});
