import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { initAgentEvents } from '../connect/agent-events.mjs';
import { executeOperations } from '../connect/core/publish.mjs';
import { requireIdempotencyKeys, createTaskStep, stepKeys } from '../connect/core/task.mjs';
import { executeTaskAction } from '../connect/core/execute.mjs';
import { setTaskStatus, readTaskStatusEverywhere, ensureTaskMirrorTables } from '../connect/core/task-store.mjs';

// P0-C：统一 AgentTask 的执行侧。
//  - C-4 步骤幂等：重放同一 step_key 不重跑；对外副作用步骤强制带 idempotency_key。
//  - C-5 桌面接入执行闸门：桌面（role='self'）不带授权发起外部动作会被拒绝并记录。

function memDb() {
  const db = new DatabaseSync(':memory:');
  initAgentEvents(db);
  db.exec(`CREATE TABLE IF NOT EXISTS external_tasks(
    id TEXT PRIMARY KEY, kind TEXT, conversation_id TEXT, source_message_id TEXT,
    origin TEXT, status TEXT, payload TEXT, intent_json TEXT, risk_level TEXT,
    approver_peer_id TEXT, deadline_at TEXT, result TEXT, evidence TEXT, created_at TEXT, updated_ms INTEGER
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS working_tasks(
    task_id TEXT PRIMARY KEY, goal TEXT, status TEXT, created_ms INTEGER, updated_ms INTEGER
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS ilink_messages(
    id TEXT PRIMARY KEY, status TEXT, updated_at TEXT
  );`);
  ensureTaskMirrorTables(db);
  return db;
}

test('C-1：改一处，external_tasks/working_tasks/brain_tasks/ilink_messages 四库同步', () => {
  const db = memDb();
  // 一个任务 + 它的源消息，四处都记一笔初始状态
  db.prepare(`INSERT INTO external_tasks(id,source_message_id,status) VALUES(?,?,?)`).run('t1', 'm1', 'proposed');
  db.prepare(`INSERT INTO working_tasks(task_id,status) VALUES(?,?)`).run('t1', 'proposed');
  db.prepare(`INSERT INTO brain_tasks(task_id,status) VALUES(?,?)`).run('t1', 'proposed');
  db.prepare(`INSERT INTO ilink_messages(id,status) VALUES(?,?)`).run('m1', 'proposed');

  // 改一处（只调 setTaskStatus）→ 四库一起变
  setTaskStatus(db, 't1', 'running', { now: 1000 });
  let all = readTaskStatusEverywhere(db, 't1');
  assert.deepEqual(all, {
    external_tasks: 'running', working_tasks: 'running', brain_tasks: 'running', ilink_messages: 'running',
  });

  setTaskStatus(db, 't1', 'succeeded', { now: 2000 });
  all = readTaskStatusEverywhere(db, 't1');
  assert.deepEqual(all, {
    external_tasks: 'succeeded', working_tasks: 'succeeded', brain_tasks: 'succeeded', ilink_messages: 'succeeded',
  });
  // 没有 source_message_id 的任务不会去碰 ilink（不会误伤别的消息）
  db.prepare(`INSERT INTO external_tasks(id,status) VALUES(?,?)`).run('t2', 'proposed');
  setTaskStatus(db, 't2', 'running', { now: 3000 });
  assert.equal(readTaskStatusEverywhere(db, 't2').ilink_messages, null);
});

test('C-4：executeOperations 重放时跳过已执行的 step_key，不重跑副作用', async () => {
  const calls = [];
  const execute = async (action, args) => { calls.push(action); return { ok: true, text: `${action} ok` }; };
  const steps = [
    { operation: 'douyin.draft', step_key: 'draft#0' },
    { operation: 'douyin.publish_draft', step_key: 'publish#1' },
  ];
  const done = new Set(['draft#0']);            // draft#0 上一轮已经跑过
  const recorded = [];
  const outcome = await executeOperations({
    operations: steps,
    execute,
    doneStepKeys: done,
    onStepDone: (key) => recorded.push(key),
  });
  // 只跑了 publish#1，draft#0 被跳过
  assert.deepEqual(calls, ['douyin.publish_draft']);
  assert.deepEqual(recorded, ['publish#1']);
  assert.equal(outcome.ok, true);
  // 跳过那步也算「腿迈出」，不拖垮整批
  assert.equal(outcome.receipts.length, 2);
});

test('C-4：requireIdempotencyKeys 让缺 idempotency_key 的副作用步骤抛错', () => {
  const sideEffect = () => true;
  // 有 key → 通过
  const good = [createTaskStep({ action: 'douyin.publish_draft', index: 0, idempotencyKey: 'abc' })];
  assert.equal(requireIdempotencyKeys(good, sideEffect), true);
  // 缺 key → 抛
  const bad = [createTaskStep({ action: 'douyin.publish_draft', index: 0 })];
  assert.throws(() => requireIdempotencyKeys(bad, sideEffect), /idempotency_key/);
  // 非副作用步骤不强制
  const read = [createTaskStep({ action: 'memory.read', index: 0 })];
  assert.equal(requireIdempotencyKeys(read, (a) => a.startsWith('douyin.')), true);
});

test('C-4：stepKeys 侦测重复 step_key，createTaskStep 给每步稳定键', () => {
  const s0 = createTaskStep({ action: 'a', index: 0 });
  const s1 = createTaskStep({ action: 'a', index: 1 });
  assert.equal(s0.step_key, 'a#0');
  assert.equal(s1.step_key, 'a#1');
  const dup = stepKeys([s0, s1, createTaskStep({ action: 'a', index: 0 })]);
  assert.deepEqual(dup.duplicated, ['a#0']);
});

test('C-5：桌面（role=self）发起外部动作被拒绝并记录 action_failed', async () => {
  const db = memDb();
  db.prepare(`INSERT INTO external_tasks(id,kind,conversation_id,origin,status,payload,approver_peer_id)
    VALUES(?,?,?,?,?,?,?)`).run('t1', 'c2c', 'conv', 'qq', 'running',
    JSON.stringify({ operations: ['douyin.publish'], requires_confirmation: true }), null);

  // 桌面信封：sender.role='self'，不是 owner，也没有审批 → external.execute 应被拒。
  const desktopEvent = {
    channel: 'desktop', conversation: { conversation_id: 'conv', type: 'direct' },
    sender: { platform_user_id: 'pet', role: 'self' },
    trust: { instruction_trust: 'trusted_system' },
  };
  let executed = false;
  const res = await executeTaskAction({
    db, taskId: 't1', operation: 'douyin.publish', event: desktopEvent,
    root: '/tmp', args: {}, execute: async () => { executed = true; return { ok: true }; },
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'external_action_unauthorized');
  assert.equal(executed, false, '未经授权不得真的执行副作用');
  // 被记录：agent_events 里留下 action_failed / external_action_unauthorized
  const row = db.prepare(`SELECT * FROM agent_events WHERE event_type='action_failed' AND task_id='t1'`).get();
  assert.ok(row, '拒绝必须留痕');
  assert.match(String(row.result ?? ''), /external_action_unauthorized/);
});
