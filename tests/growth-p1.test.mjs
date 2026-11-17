import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildPlan, dueSlots, initPlans, markSlot, planText, readPlan, savePlan, hasRun, markRun } from '../connect/douyin/dayplan.mjs';
import { ensureMood, initMood, moodInputs, nextMood, readMood, shanghaiClock, shanghaiDay, moodHistory } from '../connect/douyin/mood.mjs';
import { fireSlot, tick } from '../connect/scheduler.mjs';
import { initTasks, proposeTask, startAutomaticTask } from '../connect/tasks.mjs';

function fresh() {
  const root = mkdtempSync(join(tmpdir(), 'dfy-p1-'));
  const db = new DatabaseSync(':memory:');
  initTasks(db);
  initMood(db);
  initPlans(db);
  return { root, db, done: () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

const at = (day, hh, mm = 0) => Date.parse(`${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+08:00`);

test('心情规则：连挂两件事就没电，久不发作品会好奇，顺的时候开心', () => {
  assert.equal(nextMood({ total: 3, succeeded: 1, failed: 2, daysSincePublish: 1 }).mood, 'low_energy');
  assert.equal(nextMood({ total: 0, succeeded: 0, failed: 0, daysSincePublish: 5 }, () => 0).mood, 'curious');
  assert.ok(['happy', 'curious'].includes(nextMood({ total: 3, succeeded: 3, failed: 0, daysSincePublish: 1 }, () => 0).mood));
  const idle = nextMood({ total: 0, succeeded: 0, failed: 0, daysSincePublish: 1 }, () => 0);
  assert.ok(['calm', 'playful'].includes(idle.mood));
});

test('今天的心情落库 + 写 mood.json，重跑不换心情', () => {
  const { root, db, done } = fresh();
  try {
    const now = at('2026-11-16', 8, 10);
    const first = ensureMood(db, root, now, () => 0);
    assert.equal(first.date, '2026-11-16');
    const file = JSON.parse(readFileSync(join(root, '..', 'persona', 'mood.json'), 'utf8'));
    assert.equal(file.date, '2026-11-16');
    assert.equal(file.mood, first.mood);
    const again = ensureMood(db, root, now, () => 0.99);
    assert.equal(again.mood, first.mood);
    assert.equal(moodHistory(db).length, 1);
    assert.equal(readMood(root).mood, first.mood);
  } finally { done(); }
});

test('日程：电足时 5 轮热评，电少时 2 轮；时间递增、id 唯一', () => {
  const full = buildPlan({ day: '2026-11-16', mood: 'happy', energy: 0.8 });
  const rounds = full.slots.filter((slot) => slot.action === 'douyin.hot_comment_round');
  assert.equal(rounds.length, 5);
  assert.equal(rounds[0].args.videos, 2);
  assert.equal(rounds[0].args.perVideo, 2);
  const times = full.slots.map((slot) => slot.at_ms);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  assert.equal(new Set(full.slots.map((slot) => slot.id)).size, full.slots.length);
  const low = buildPlan({ day: '2026-11-16', mood: 'low_energy', energy: 0.3 });
  assert.equal(low.slots.filter((slot) => slot.action === 'douyin.hot_comment_round').length, 2);
  assert.equal(low.slots.filter((slot) => slot.action === 'academy.study').length, 0);
  assert.match(planText(full, { mood: 'happy', why: '测试' }), /今天心情：happy/);
});

test('日程落库、按时取 due、标记状态、幂等台账', () => {
  const { db, done } = fresh();
  try {
    const plan = buildPlan({ day: '2026-11-16', mood: 'calm', energy: 0.6 });
    savePlan(db, plan, at('2026-11-16', 8, 5));
    const loaded = readPlan(db, '2026-11-16');
    assert.equal(loaded.slots.length, plan.slots.length);
    const due = dueSlots(db, at('2026-11-16', 9, 31));
    assert.equal(due.filter((slot) => slot.action === 'douyin.check_interactions').length, 1);
    assert.equal(due.filter((slot) => slot.action === 'douyin.daily_post').length, 1);
    for (const slot of due) markSlot(db, slot.id, { status: 'done' });
    assert.equal(dueSlots(db, at('2026-11-16', 9, 31)).length, 0);
    assert.equal(hasRun(db, 'plan:2026-11-16'), false);
    markRun(db, 'plan:2026-11-16', '5 slots');
    assert.equal(hasRun(db, 'plan:2026-11-16'), true);
  } finally { done(); }
});

test('到点执行：只读动作自动跑并写回执；发布类只建任务等人确认', async () => {
  const { root, db, done } = fresh();
  try {
    const now = at('2026-11-16', 11, 1);
    const plan = savePlan(db, buildPlan({ day: '2026-11-16', mood: 'calm', energy: 0.6 }), now);
    const slot = plan.slots.find((row) => row.action === 'douyin.reply_comments');
    const calls = [];
    const executed = await fireSlot({
      db, root, slot, now,
      execute: async (name) => { calls.push(name); return { ok: true, text: '回复了 3 条评论' }; },
      notify: async () => {},
      targets: { qq: { dad: 'owner-1', group: 'group-1' } },
    });
    assert.equal(executed.status, 'succeeded');
    assert.deepEqual(calls, ['douyin.reply_comments']);
    const task = db.prepare('SELECT status, origin, approver_peer_id FROM external_tasks WHERE id=?').get(executed.taskId);
    assert.equal(task.status, 'succeeded');
    assert.equal(task.origin, 'plan');
    assert.equal(task.approver_peer_id, null);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_events WHERE task_id=? AND payload LIKE '%\"approved\"%'").get(executed.taskId).n, 0);
    assert.equal(readPlan(db, '2026-11-16').slots.find((row) => row.id === slot.id).status, 'done');

    const publish = { ...plan.slots.find((row) => row.action === 'douyin.publish') ?? plan.slots[0], action: 'douyin.publish', id: 'test-publish', args: {} };
    const notes = [];
    const held = await fireSlot({
      db, root, slot: publish, now,
      execute: async () => { throw new Error('不应该执行'); },
      notify: async (message) => { notes.push(message); },
      targets: { qq: { dad: 'owner-1', group: 'group-1' } },
    });
    assert.equal(held.status, 'awaiting_confirmation');
    assert.equal(notes[0].id, 'owner-1');
    assert.match(notes[0].text, /回「同意」/);
    assert.equal(db.prepare('SELECT status FROM external_tasks WHERE id=?').get(held.taskId).status, 'awaiting_confirmation');
  } finally { done(); }
});

test('自动日程只能启动白名单动作，不能给待审批任务自批', () => {
  const { db, done } = fresh();
  try {
    const now = Date.now();
    const intent = (operation, requiresConfirmation) => ({ intent: 'plan_slot', operations: [operation], requires_confirmation: requiresConfirmation });
    const publish = proposeTask(db, { kind: 'c2c', convId: 'owner-1', sourceMessageId: 'publish', intent: intent('douyin.publish', true), origin: 'plan', now });
    const disguised = proposeTask(db, { kind: 'c2c', convId: 'owner-1', sourceMessageId: 'disguised', intent: intent('douyin.publish', false), origin: 'plan', now });
    const external = proposeTask(db, { kind: 'c2c', convId: 'owner-1', sourceMessageId: 'external', intent: intent('douyin.browse', false), origin: 'qq', now });
    assert.equal(startAutomaticTask(db, publish.id, now), false);
    assert.equal(startAutomaticTask(db, disguised.id, now), false);
    assert.equal(startAutomaticTask(db, external.id, now), false);
    for (const row of [publish, disguised, external]) {
      const state = db.prepare('SELECT status,approver_peer_id FROM external_tasks WHERE id=?').get(row.id);
      assert.equal(state.status, 'awaiting_confirmation');
      assert.equal(state.approver_peer_id, null);
    }
  } finally { done(); }
});

test('tick 一次：生成心情 + 日程并播报到群，重启不重复', async () => {
  const { root, db, done } = fresh();
  try {
    const group = [];
    const notify = async (message) => { group.push(message); };
    writeFileSync(join(root, 'targets.json'), JSON.stringify({ qq: { dad: 'owner-1', group: 'group-1' } }));
    const now = at('2026-11-16', 8, 30);
    // 日常图文这条路要真的去写稿，测试里换成假实现：只校验调度与播报，不落真草稿。
    const runPrepare = async (theme) => ({ status: 'draft', theme, title: theme, draft: '/tmp/fake-draft' });
    const first = await tick({ db, root, now, notify, execute: async () => ({ ok: true }), runPrepare });
    assert.ok(first.mood);
    assert.ok(first.plan > 0);
    // 群里只播一次日程；08:30 那条日常图文会另发一条二审消息给爸爸（不是群播报）。
    const groupMessages = group.filter((message) => message.kind === 'group');
    assert.equal(groupMessages.length, 1);
    assert.match(groupMessages[0].text, /今天的日程/);
    const second = await tick({ db, root, now: now + 60_000, notify, execute: async () => ({ ok: true }), runPrepare });
    assert.equal(second.mood, null);
    assert.equal(second.plan, null);
    assert.equal(group.filter((message) => message.kind === 'group').length, 1, '重启后不该再排一次日程播报');
    assert.equal(shanghaiDay(now), '2026-11-16');
    assert.equal(shanghaiClock(now), '08:30');
  } finally { done(); }
});

test('群里发不出去的播报会排队，等有消息再补发', async () => {
  const { db, done } = fresh();
  try {
    const { initOutbox, queueOutbox, pendingOutbox, markOutboxSent, outboxSize } = await import('../connect/qq/outbox.mjs');
    initOutbox(db);
    assert.equal(queueOutbox(db, { kind: 'group', id: 'g1', text: '今天的日程', now: 1 }), true);
    assert.equal(queueOutbox(db, { kind: 'group', id: 'g1', text: '今天的日程', now: 2 }), false); // 同样内容不重复排
    assert.equal(pendingOutbox(db, 'group', 'g1').length, 1);
    assert.equal(pendingOutbox(db, 'group', 'g2').length, 0);
    markOutboxSent(db, pendingOutbox(db, 'group', 'g1')[0].id, 3);
    assert.equal(pendingOutbox(db, 'group', 'g1').length, 0);
    assert.equal(outboxSize(db), 0);
  } finally { done(); }
});
