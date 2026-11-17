/**
 * 性能样本接主链路（计划 P1-C / C-5）的验收：
 *   - 动作跑一次 → performance_samples 里真的多一行
 *   - 外部动作闸门被策略拒绝 → 也要有一行（success=false）
 *   - 建表幂等，重复调用不报错
 *   - 采样写不进去也不能让动作失败（旁路）
 *
 * 全部用临时目录的库，不碰真实 runtime/connect。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ACTIONS, runAction } from './actions.mjs';
import { executeTaskAction } from './core/execute.mjs';
import { interactionEvent } from './core-contract.mjs';
import { EXTERNAL_STAGE, actionStage, initPerformance, performanceStats, recordPerformance } from './performance.mjs';
import { approvePendingTask, initTasks, proposeTask, startTask } from './tasks.mjs';

const owner = interactionEvent({ channel: 'qq', conversationId: 'dad-1', senderId: 'dad-1', senderRole: 'owner', text: '同意', sourceEventId: 'perf-approval-1' });

/** 临时项目根：带 runtime/connect（connect 库就落在这里）。 */
function tempRoot(label, { withConnectDir = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), `dfy-perf-${label}-`));
  if (withConnectDir) mkdirSync(join(root, 'runtime', 'connect'), { recursive: true });
  return root;
}

function connectDbPath(root) {
  return join(root, 'runtime', 'connect', 'connect.sqlite');
}

function samplesOf(root) {
  const db = new DatabaseSync(connectDbPath(root));
  try { return db.prepare('SELECT * FROM performance_samples ORDER BY id').all(); }
  finally { db.close(); }
}

test('stage 命名：动作是 action:<name>，外部闸门是 external.execute', () => {
  assert.equal(actionStage('douyin.publish'), 'action:douyin.publish');
  assert.equal(actionStage(''), 'action:unknown');
  assert.equal(EXTERNAL_STAGE, 'external.execute');
});

test('performance 样本能算出 p50 p95 p99 和成功率', () => {
  const root = tempRoot('stats');
  try {
    const db = new DatabaseSync(connectDbPath(root));
    for (let i = 1; i <= 20; i += 1) recordPerformance(db, { stage: 'action:test', channel: 'qq', durationMs: i, success: i < 15 });
    const stats = performanceStats(db, { stage: 'action:test' });
    assert.equal(stats.samples, 20);
    assert.ok(stats.p50 !== null && stats.p50 > 0, 'p50 应该有值');
    assert.ok(stats.p95 >= stats.p50, 'p95 不该小于 p50');
    assert.ok(stats.p99 >= stats.p95, 'p99 不该小于 p95');
    assert.ok(stats.success_rate >= 0 && stats.success_rate <= 1, '成功率应该在 0..1');
    assert.equal(stats.success_rate, 14 / 20);
    db.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('runAction 成功和失败都落一条性能样本', async () => {
  const root = tempRoot('action');
  ACTIONS['test.perf.ok'] = { label: '测试动作', run: async () => { await new Promise((resolve) => setTimeout(resolve, 12)); return { text: '跑完了' }; } };
  ACTIONS['test.perf.fail'] = { label: '测试失败动作', run: async () => { throw new Error('perf_test_boom'); } };
  try {
    const ok = await runAction('test.perf.ok', { root, channel: 'qq', taskId: 'task-perf-1' });
    assert.equal(ok.ok, true);
    assert.equal(ok.text, '跑完了');
    const failed = await runAction('test.perf.fail', { root, channel: 'qq' });
    assert.equal(failed.ok, false);
    assert.equal(failed.error, 'perf_test_boom');

    const rows = samplesOf(root);
    assert.equal(rows.length, 2, '一次成功一次失败，各一条样本');
    const [first, second] = rows;
    assert.equal(first.stage, 'action:test.perf.ok');
    assert.equal(first.channel, 'qq');
    assert.equal(first.task_id, 'task-perf-1');
    assert.equal(first.success, 1);
    assert.ok(first.duration_ms >= 10, `真实耗时应该被记下来，实际 ${first.duration_ms}`);
    assert.deepEqual(JSON.parse(first.metadata), { action: 'test.perf.ok' });
    assert.equal(second.stage, 'action:test.perf.fail');
    assert.equal(second.success, 0);
    assert.equal(second.task_id, null);
    assert.equal(JSON.parse(second.metadata).error, 'perf_test_boom');

    const db = new DatabaseSync(connectDbPath(root));
    const stats = performanceStats(db, { stage: 'action:test.perf.ok' });
    assert.equal(stats.samples, 1);
    assert.ok(stats.p50 !== null && stats.p99 !== null);
    assert.equal(stats.success_rate, 1);
    db.close();
  } finally {
    delete ACTIONS['test.perf.ok'];
    delete ACTIONS['test.perf.fail'];
    rmSync(root, { recursive: true, force: true });
  }
});

test('外部动作闸门被策略拒绝时也落一条失败样本', async () => {
  const db = new DatabaseSync(':memory:');
  initTasks(db);
  const now = Date.now();
  const row = proposeTask(db, {
    kind: 'c2c', convId: 'dad-1', sourceMessageId: 'perf-1',
    intent: { intent: 'publish', operations: ['douyin.publish'], requires_confirmation: true }, now,
  });
  const calls = [];
  const result = await executeTaskAction({
    db, taskId: row.id, operation: 'douyin.publish', event: owner,
    execute: async (name) => { calls.push(name); return { ok: true }; }, now,
  });
  assert.equal(result.error, 'external_action_unauthorized');
  assert.deepEqual(calls, [], '被拒绝就不该真的执行');

  const rows = db.prepare('SELECT * FROM performance_samples WHERE stage=?').all(EXTERNAL_STAGE);
  assert.equal(rows.length, 1, '拒绝也必须留一条样本');
  assert.equal(rows[0].success, 0);
  assert.equal(rows[0].channel, 'qq');
  assert.equal(rows[0].task_id, row.id);
  assert.equal(JSON.parse(rows[0].metadata).outcome, 'rejected');
  const stats = performanceStats(db, { stage: EXTERNAL_STAGE });
  assert.equal(stats.samples, 1);
  assert.equal(stats.success_rate, 0);
  db.close();
});

test('外部动作闸门放行时落一条成功样本', async () => {
  const db = new DatabaseSync(':memory:');
  initTasks(db);
  const now = Date.now();
  const row = proposeTask(db, {
    kind: 'c2c', convId: 'dad-1', sourceMessageId: 'perf-2',
    intent: { intent: 'publish', operations: ['douyin.publish'], requires_confirmation: true }, now,
  });
  assert.equal(approvePendingTask(db, row.id, 'dad-1', now).ok, true);
  assert.equal(startTask(db, row.id, now), true);
  const result = await executeTaskAction({
    db, taskId: row.id, operation: 'douyin.publish', event: owner,
    execute: async () => ({ ok: true, text: 'done' }), now,
  });
  assert.equal(result.ok, true);
  const rows = db.prepare('SELECT * FROM performance_samples WHERE stage=?').all(EXTERNAL_STAGE);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].success, 1);
  assert.equal(rows[0].task_id, row.id);
  assert.equal(JSON.parse(rows[0].metadata).outcome, 'executed');
  db.close();
});

test('建表幂等：表已存在时重复写、重复跑动作都不报错', async () => {
  const root = tempRoot('idem');
  ACTIONS['test.perf.idem'] = { label: '幂等动作', run: async () => ({ text: 'ok' }) };
  try {
    const db = new DatabaseSync(connectDbPath(root));
    initPerformance(db);
    initPerformance(db);
    recordPerformance(db, { stage: 'action:idem', durationMs: 5, success: true });
    recordPerformance(db, { stage: 'action:idem', durationMs: 7, success: false });
    db.close();

    assert.equal((await runAction('test.perf.idem', { root })).ok, true);
    assert.equal((await runAction('test.perf.idem', { root })).ok, true);

    const rows = samplesOf(root);
    assert.equal(rows.length, 4, '两条手写的 + 两次动作各一条');
    assert.equal(rows.filter((row) => row.stage === 'action:test.perf.idem').length, 2);
  } finally {
    delete ACTIONS['test.perf.idem'];
    rmSync(root, { recursive: true, force: true });
  }
});

test('库被别的连接占着（server 长期持有 + WAL）时采样照样写得进去', async () => {
  const root = tempRoot('wal');
  ACTIONS['test.perf.wal'] = { label: 'WAL 动作', run: async () => ({ text: 'ok' }) };
  try {
    // 模拟 server：另一条连接一直开着这张库（WAL 模式）。
    const holder = new DatabaseSync(connectDbPath(root));
    holder.exec('PRAGMA journal_mode=WAL');
    initPerformance(holder);
    holder.prepare('SELECT COUNT(*) AS c FROM performance_samples').get();
    const result = await runAction('test.perf.wal', { root });
    assert.equal(result.ok, true);
    const rows = samplesOf(root);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].stage, 'action:test.perf.wal');
    assert.equal(rows[0].success, 1);
    holder.close();
  } finally {
    delete ACTIONS['test.perf.wal'];
    rmSync(root, { recursive: true, force: true });
  }
});

test('采样写不进去时动作本身照常成功（性能采样是旁路）', async () => {
  const root = tempRoot('bypass', { withConnectDir: false });
  ACTIONS['test.perf.nodb'] = { label: '没有库的动��', run: async () => ({ text: 'ok' }) };
  try {
    const result = await runAction('test.perf.nodb', { root });
    assert.equal(result.ok, true, '采样失败不能把动作带崩');
    assert.equal(result.text, 'ok');
  } finally {
    delete ACTIONS['test.perf.nodb'];
    rmSync(root, { recursive: true, force: true });
  }
});
