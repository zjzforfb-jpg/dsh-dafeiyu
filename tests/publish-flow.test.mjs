import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateConnect } from '../connect/core/migrations.mjs';
import { initTasks, proposeTask, approvePendingTask } from '../connect/tasks.mjs';
import { recordCheckpoint } from '../connect/core/checkpoints.mjs';
import { publishFlowState } from '../connect/live/publish-flow.mjs';

function repoWithFakeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'publish-flow-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{}');
  return root;
}

test('三步：没草稿就停在第 1 步；有草稿、有待审、发布成功后依次点亮', () => {
  const root = repoWithFakeRoot();
  const db = new DatabaseSync(':memory:');
  migrateConnect(db);
  initTasks(db);

  const empty = publishFlowState(db, root);
  assert.deepEqual(empty.steps.map((step) => step.state), ['todo', 'todo', 'todo']);
  assert.equal(empty.next, 'draft', '下一步应该是写草稿');

  // 1) 草稿文件出现
  mkdirSync(join(root, 'runtime', 'douyin', 'drafts'), { recursive: true });
  writeFileSync(join(root, 'runtime', 'douyin', 'drafts', 'draft-1.json'), JSON.stringify({ title: '标题甲', createdAt: 1, status: 'draft' }));
  const withDraft = publishFlowState(db, root);
  assert.equal(withDraft.steps[0].state, 'done');
  assert.match(withDraft.steps[0].detail, /标题甲/u);

  // 2) 有待审任务
  const task = proposeTask(db, {
    kind: 'c2c', convId: 'u1', sourceMessageId: `msg-${Date.now()}`, origin: 'test',
    intent: { intent: 'douyin.publish', operations: ['douyin.publish'] }, expiresMs: Date.now() + 3600_000,
  });
  const withReview = publishFlowState(db, root);
  assert.equal(withReview.steps[1].state, 'now', '有待审就该停在第 2 步');

  // 3) 发布成功
  approvePendingTask(db, task.id, 'owner');
  recordCheckpoint(db, { taskId: task.id, operation: 'douyin.publish', verdict: 'confirmed', reason: 'ok', ok: true });
  const done = publishFlowState(db, root);
  assert.equal(done.steps[2].state, 'done');
  assert.equal(done.next, null, '三步都完成时没有下一步');
  db.close();
});

test('卡在「人工二审」时带上那条任务 id，页面据此给出处', () => {
  const root = repoWithFakeRoot();
  const db = new DatabaseSync(':memory:');
  migrateConnect(db);
  initTasks(db);
  // 先让第 1 步完成，才能断言「下一步是二审」
  mkdirSync(join(root, 'runtime', 'douyin', 'drafts'), { recursive: true });
  writeFileSync(join(root, 'runtime', 'douyin', 'drafts', 'draft-2.json'), JSON.stringify({ title: '标题乙', createdAt: 2 }));
  const task = proposeTask(db, {
    kind: 'c2c', convId: 'u2', sourceMessageId: `msg2-${Date.now()}`, origin: 'test',
    intent: { intent: 'douyin.publish', operations: ['douyin.publish'] }, expiresMs: Date.now() + 3600_000,
  });
  const state = publishFlowState(db, root);
  const review = state.steps.find((step) => step.key === 'review');
  assert.equal(review.state, 'now');
  assert.equal(review.taskId, task.id, '页面要靠这个 id 指回那条任务');
  assert.equal(state.next, 'review');
  db.close();
});
