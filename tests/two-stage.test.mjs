import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initTasks, proposeTask, approvePendingTask, startTask, markAwaitingPublish, latestPendingTask, task } from '../connect/tasks.mjs';

const intent = { intent: 'external_action_request', operations: ['douyin.publish'], target: 'user_requested', requires_confirmation: true, theme: '刚建好抖音号' };

test('两次审核：主题阶段批准后进入运行，准备完停在 awaiting_publish 等二审', () => {
  const db = new DatabaseSync(':memory:');
  initTasks(db);
  const row = proposeTask(db, { kind: 'c2c', convId: 'dad', sourceMessageId: 'm1', intent });
  assert.equal(row.status, 'awaiting_confirmation');
  assert.equal(JSON.parse(row.payload).theme, '刚建好抖音号');

  const first = approvePendingTask(db, row.id, 'dad');
  assert.deepEqual(first, { ok: true, previous: 'awaiting_confirmation' });
  assert.equal(startTask(db, row.id), true);

  assert.equal(markAwaitingPublish(db, row.id, { prepared: { title: '标题', topics: ['#大肥鱼'], settings: {} } }), true);
  const pending = task(db, row.id);
  assert.equal(pending.status, 'awaiting_publish');
  assert.equal(JSON.parse(pending.result).title, '标题');

  const second = approvePendingTask(db, row.id, 'dad');
  assert.deepEqual(second, { ok: true, previous: 'awaiting_publish' });
  db.close();
});

test('awaiting_publish 的任务也算 pending，二审时能被取到', () => {
  const db = new DatabaseSync(':memory:');
  initTasks(db);
  const row = proposeTask(db, { kind: 'c2c', convId: 'dad', sourceMessageId: 'm2', intent });
  approvePendingTask(db, row.id, 'dad');
  startTask(db, row.id);
  markAwaitingPublish(db, row.id, { prepared: null });
  assert.equal(latestPendingTask(db, 'c2c', 'dad').id, row.id);
  assert.equal(latestPendingTask(db, 'c2c', 'dad').status, 'awaiting_publish');
  db.close();
});

test('已完成或失败的任务不再被当成待审', () => {
  const db = new DatabaseSync(':memory:');
  initTasks(db);
  const row = proposeTask(db, { kind: 'c2c', convId: 'dad', sourceMessageId: 'm3', intent });
  approvePendingTask(db, row.id, 'dad');
  startTask(db, row.id);
  markAwaitingPublish(db, row.id, { prepared: null });
  approvePendingTask(db, row.id, 'dad');
  assert.equal(latestPendingTask(db, 'c2c', 'dad'), null);
  db.close();
});
