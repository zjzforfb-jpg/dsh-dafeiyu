// M2：执行判定（verify）与任务快照（checkpoints）的回归。
//
// 这两块一起解决「失败只能整单重来」和「ok 就算办好了」两个老毛病：
//   verify      —— 把「点到了」和「真成了」分开，通话类永远不给 confirmed；
//   checkpoints —— 每步落快照，重跑时跳过已成功的步骤，实现断点续跑。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  VERDICTS, evaluateOutcome, evaluateTask, expectationOf, describeVerdict,
} from '../connect/core/verify.mjs';
import {
  initCheckpoints, recordCheckpoint, checkpointsOf, doneSteps, lastFailure, checkpointSummary,
} from '../connect/core/checkpoints.mjs';
import { executeOperations } from '../connect/core/publish.mjs';
import { initTasks, proposeTask, approvePendingTask, startTask } from '../connect/tasks.mjs';
import { initAgentEvents } from '../connect/agent-events.mjs';
import { initQq } from '../connect/qq/store.mjs';
import { retryTask } from '../connect/core/retry.mjs';

const TS = Date.UTC(2026, 10, 17, 1, 0);

function freshDb() {
  const db = new DatabaseSync(':memory:');
  initCheckpoints(db);
  return db;
}

test('判定：ok 不等于办好了，通话类要给未核对', () => {
  // 成功但没有任何数据/文本 → 没有证据，不能算 confirmed
  assert.equal(evaluateOutcome({ operation: 'douyin.publish', result: { ok: true } }).verdict, VERDICTS.unconfirmed);
  // 发布类要有结果数据才算核对过：光有「已发 1 条」只是话术
  assert.equal(evaluateOutcome({ operation: 'douyin.publish', result: { ok: true, text: '已发 1 条' } }).verdict, VERDICTS.unconfirmed);
  assert.equal(evaluateOutcome({ operation: 'douyin.publish', result: { ok: true, text: '已发 1 条', data: { worksCount: 1 } } }).verdict, VERDICTS.confirmed);
  // 动作失败 → failed
  assert.equal(evaluateOutcome({ operation: 'douyin.publish', result: { ok: false, error: 'selector_miss' } }).verdict, VERDICTS.failed);
  // 说回了评论但计数是 0 → mismatched（不是「成功」）
  const zero = evaluateOutcome({ operation: 'douyin.reply_comments', result: { ok: true, data: { count: 0 }, text: '回了 0 条' } });
  assert.equal(zero.verdict, VERDICTS.mismatched);
  assert.match(zero.reason, /count=0/u);
  // 计数缺失 → unconfirmed
  assert.equal(evaluateOutcome({ operation: 'douyin.reply_comments', result: { ok: true, text: '好了' } }).verdict, VERDICTS.unconfirmed);
  // 拨号类：指令送达 ≠ 接通，必须等 call_ended
  const call = evaluateOutcome({ operation: 'qq.call', result: { ok: true, text: '正在拨号' } });
  assert.equal(call.verdict, VERDICTS.unconfirmed);
  assert.equal(call.reason, 'awaiting_external_event');
  // 未知动作沿用默认预期：有文本就算核对过
  assert.equal(expectationOf('never.seen').needsExternal, false);
  assert.equal(evaluateOutcome({ operation: 'never.seen', result: { ok: true, text: 'done' } }).verdict, VERDICTS.confirmed);
});

test('判定：整单结论按最坏的那一步算', () => {
  assert.equal(evaluateTask({ steps: [{ verdict: 'confirmed' }, { verdict: 'confirmed' }] }).verdict, 'confirmed');
  assert.equal(evaluateTask({ steps: [{ verdict: 'confirmed' }, { verdict: 'unconfirmed' }] }).verdict, 'unconfirmed');
  assert.equal(evaluateTask({ steps: [{ verdict: 'unconfirmed' }, { verdict: 'mismatched' }] }).verdict, 'mismatched');
  assert.equal(evaluateTask({ steps: [{ verdict: 'mismatched' }, { verdict: 'failed' }] }).verdict, 'failed');
  assert.equal(evaluateTask({ steps: [] }).verdict, 'unconfirmed', '空任务不该报成功');
  assert.match(describeVerdict('unconfirmed', 'no_evidence'), /未核对/u);
});

test('快照：每步落一行，能回答「哪些成了、卡在哪」', () => {
  const db = freshDb();
  recordCheckpoint(db, { taskId: 'task-1', stepKey: '#0:douyin.draft', stepIndex: 0, operation: 'douyin.draft', input: { theme: 'BLG' }, output: { ok: true, text: '草稿好了' }, verdict: 'confirmed', ok: true });
  recordCheckpoint(db, { taskId: 'task-1', stepKey: '#1:douyin.publish', stepIndex: 1, operation: 'douyin.publish', input: {}, output: { ok: false, error: 'publish_unconfirmed' }, verdict: 'failed', ok: false });

  const rows = checkpointsOf(db, 'task-1');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].input, { theme: 'BLG' });
  assert.equal(rows[0].ok, true);
  assert.deepEqual([...doneSteps(db, 'task-1')], ['#0:douyin.draft']);
  assert.equal(lastFailure(db, 'task-1').operation, 'douyin.publish');
  const summary = checkpointSummary(db, 'task-1');
  assert.deepEqual({ total: summary.total, ok: summary.ok, failed: summary.failed, resumable: summary.resumable }, { total: 2, ok: 1, failed: 1, resumable: true });
  // 另一个任务互不干扰
  assert.equal(checkpointsOf(db, 'task-2').length, 0);
  assert.equal(lastFailure(db, 'task-2'), null);
});

test('断点续跑：重跑同一任务时跳过已成功的步骤，只重做失败的那步', async () => {
  const db = freshDb();
  const tried = [];
  const calls = new Map();
  const flaky = async (name) => {
    tried.push(name);
    const seen = (calls.get(name) ?? 0) + 1;
    calls.set(name, seen);
    // 第一次跑必失败，第二次放行
    if (name === 'step.two' && seen === 1) return { ok: false, error: 'boom' };
    return { ok: true, text: `${name} ok`, data: { count: 1 } };
  };
  const operations = ['step.one', 'step.two'];

  const first = await executeOperations({ operations, execute: flaky, db, taskId: 'task-retry', stopOnFailure: false });
  assert.equal(first.ok, false);
  assert.deepEqual(tried, ['step.one', 'step.two']);

  // 第二次：第一步应被快照跳过，只有第二步真的再跑一次
  tried.length = 0;
  const second = await executeOperations({ operations, execute: flaky, db, taskId: 'task-retry', stopOnFailure: false });
  assert.deepEqual(tried, ['step.two'], '已成功的步骤不该重跑');
  assert.equal(second.ok, true);
  const skipped = second.receipts.find((row) => row.verdict === VERDICTS.skipped);
  assert.ok(skipped, '跳过的那一步要留下 skipped 回执');
  assert.equal(checkpointsOf(db, 'task-retry').length, 4, '两次执行各留两条快照');
  assert.equal(doneSteps(db, 'task-retry').size, 2);
});

test('续跑：已经成功的步骤跳过，只跑剩下的，并把任务收尾', async () => {
  const db = new DatabaseSync(':memory:');
  initQq(db); initTasks(db); initAgentEvents(db); initCheckpoints(db);
  const task = proposeTask(db, {
    kind: 'c2c', convId: 'u1', sourceMessageId: 'm-retry', origin: 'test',
    intent: { intent: 'external_action_request', operations: ['douyin.publish', 'douyin.reply_comments'], requires_confirmation: true, plan: [{ tool: 'douyin.publish' }, { tool: 'douyin.reply_comments' }] },
    now: TS, expiresMs: TS + 3_600_000,
  });
  approvePendingTask(db, task.id, 'owner', TS);
  startTask(db, task.id, TS);
  // 第一步之前已经真跑过并成功了
  recordCheckpoint(db, { taskId: task.id, stepKey: '#0:douyin.publish', stepIndex: 0, operation: 'douyin.publish', output: { ok: true, data: { worksCount: 1 } }, verdict: 'confirmed', ok: true, now: TS });

  const ran = [];
  const result = await retryTask(db, task.id, {
    now: TS + 1000,
    execute: async (name) => { ran.push(name); return { ok: true, text: `做好了 ${name}`, data: { count: 2 } }; },
  });

  assert.equal(ran.length, 1, '只有没成功的那一步应该被重跑');
  assert.equal(ran[0], 'douyin.reply_comments');
  assert.deepEqual(result.skipped, ['douyin.publish']);
  assert.equal(result.ok, true);
  assert.equal(db.prepare('SELECT status FROM external_tasks WHERE id=?').get(task.id).status, 'succeeded');
  const summary = checkpointSummary(db, task.id);
  assert.equal(summary.total >= 2, true);
  db.close();
});

test('续跑拒绝待确认的任务，避免绕过审批', async () => {
  const db = new DatabaseSync(':memory:');
  initQq(db); initTasks(db); initAgentEvents(db); initCheckpoints(db);
  const task = proposeTask(db, {
    kind: 'c2c', convId: 'u1', sourceMessageId: 'm-wait', origin: 'test',
    intent: { intent: 'external_action_request', operations: ['douyin.publish'], requires_confirmation: true },
    now: TS, expiresMs: TS + 3_600_000,
  });
  const result = await retryTask(db, task.id, { now: TS + 1, execute: async () => ({ ok: true }) });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'needs_approval');
  assert.equal(db.prepare('SELECT status FROM external_tasks WHERE id=?').get(task.id).status, 'awaiting_confirmation');
  db.close();
});

test('抖音回复/爆款两轮要带回结构化计数，否则判定层只能干瞪眼', async () => {
  const { evaluateOutcome, VERDICTS } = await import('../connect/core/verify.mjs');
  // 以前这两个动作只返回一行文字，data 是空的 → 永远 unconfirmed。现在要能判出 confirmed。
  const replied = evaluateOutcome({
    operation: 'douyin.reply_comments',
    result: { ok: true, text: '回复了 3 条评论', data: { status: 'ok', count: 3, verified: 0, accepted: 3 } },
  });
  assert.equal(replied.verdict, VERDICTS.confirmed);

  // 说回了 0 条，那就是对不上（预期至少 1 条）。
  const none = evaluateOutcome({
    operation: 'douyin.reply_comments',
    result: { ok: true, text: '回复了 0 条评论', data: { status: 'ok', count: 0 } },
  });
  assert.equal(none.verdict, VERDICTS.mismatched);
  assert.match(none.reason, /count=0<1/u);

  // 爆款评论这一轮 0 条：确实可能没得回，但也不能报成办好了。
  const empty = evaluateOutcome({
    operation: 'douyin.hot_comment_round',
    result: { ok: true, text: '今天在爆款下回了 0 条', data: { status: 'ok', count: 0, rounds: 2 } },
  });
  assert.equal(empty.verdict, VERDICTS.unconfirmed);
  assert.equal(empty.reason, 'nothing_to_do');

  const done = evaluateOutcome({
    operation: 'douyin.hot_comment_round',
    result: { ok: true, text: '今天在爆款下回了 2 条', data: { status: 'ok', count: 2, rounds: 2 } },
  });
  assert.equal(done.verdict, VERDICTS.confirmed);
});

test('没有可回的评论算「没活干」，不算失败也不算成功', async () => {
  const { evaluateOutcome } = await import('../connect/core/verify.mjs');
  const idle = evaluateOutcome({
    operation: 'douyin.reply_comments',
    result: { ok: true, data: { status: 'ok', count: 0, nothingToDo: true, skipped: ['no_content'] } },
    receipt: { ok: true },
  });
  assert.equal(idle.verdict, 'unconfirmed');
  assert.equal(idle.reason, 'nothing_to_do');

  const worked = evaluateOutcome({
    operation: 'douyin.reply_comments',
    result: { ok: true, data: { status: 'ok', count: 2 } },
    receipt: { ok: true },
  });
  assert.equal(worked.verdict, 'confirmed');
});

test('限流与「没活干」都算 unconfirmed，但理由要带得出证据', () => {
  // 被闸门挡住：不是故障，也不是成功
  const blocked = evaluateOutcome({
    operation: 'douyin.reply_comments',
    result: { ok: true, data: { status: 'blocked', count: 0, blocked: '这一小时已发 5 条，达到上限' } },
  });
  assert.equal(blocked.verdict, VERDICTS.unconfirmed);
  assert.match(blocked.reason, /^blocked:/u);

  // 没活干：reason 里要带「扫了几条」和「为什么跳过」
  const idle = evaluateOutcome({
    operation: 'douyin.reply_comments',
    result: {
      ok: true,
      data: { status: 'ok', count: 0, scanned: 5, nothingToDo: true, breakdown: { no_content: 3, already_replied: 2 } },
    },
  });
  assert.equal(idle.verdict, VERDICTS.unconfirmed);
  assert.match(idle.reason, /nothing_to_do\(5\)/u);
  assert.match(idle.reason, /no_content×3/u);

  // 有真失败照样判失败，别被「没活干」的旁路吞掉
  const failed = evaluateOutcome({ operation: 'douyin.reply_comments', result: { ok: false, text: '炸了' } });
  assert.equal(failed.verdict, VERDICTS.failed);
});
