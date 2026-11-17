import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { interactionEvent } from '../connect/core-contract.mjs';
import { executeApprovalAction, executeTaskAction } from '../connect/core/execute.mjs';
import { startConnect } from '../connect/server.mjs';
import { claimApprovalDecision, createApprovalRecord } from '../connect/approvals.mjs';
import { addPlan, loadQueue, runPlan } from '../connect/plans.mjs';
import { initQq, logInbound } from '../connect/qq/store.mjs';
import { approvePendingTask, initTasks, proposeTask, startAutomaticTask, startTask } from '../connect/tasks.mjs';

const owner = interactionEvent({ channel: 'qq', conversationId: 'dad-1', senderId: 'dad-1', senderRole: 'owner', text: '同意', sourceEventId: 'approval-1' });
const group = interactionEvent({ channel: 'qq', conversationKind: 'group', conversationId: 'group-1', senderId: 'dad-1', senderRole: 'owner', text: '同意', sourceEventId: 'approval-2' });

test('execution gate checks task state, requester scope and persisted approver', async () => {
  const db = new DatabaseSync(':memory:');
  initTasks(db);
  const now = Date.now();
  const row = proposeTask(db, { kind: 'c2c', convId: 'dad-1', sourceMessageId: 'one', intent: { intent: 'publish', operations: ['douyin.publish'], requires_confirmation: true }, now });
  const calls = [];
  const execute = async (name) => { calls.push(name); return { ok: true, text: 'done' }; };
  assert.equal((await executeTaskAction({ db, taskId: row.id, operation: 'douyin.publish', event: owner, execute, now })).error, 'external_action_unauthorized');
  assert.equal(approvePendingTask(db, row.id, 'dad-1', now).ok, true);
  assert.equal(startTask(db, row.id, now), true);
  assert.equal((await executeTaskAction({ db, taskId: row.id, operation: 'douyin.publish', event: group, execute, now })).error, 'external_action_unauthorized');
  assert.equal((await executeTaskAction({ db, taskId: row.id, operation: 'douyin.comment_latest', event: owner, execute, now })).error, 'external_action_unauthorized');
  assert.equal((await executeTaskAction({ db, taskId: row.id, operation: 'douyin.publish_draft', event: owner, execute, now })).ok, true);
  assert.deepEqual(calls, ['douyin.publish_draft']);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_events WHERE task_id=? AND event_type='action_failed'").get(row.id).n, 3);
  db.close();
});

test('only a scheduled allowlist task may execute without owner approval', async () => {
  const db = new DatabaseSync(':memory:');
  initTasks(db);
  const now = Date.now();
  const intent = (operation) => ({ intent: 'plan_slot', operations: [operation], requires_confirmation: false });
  const browse = proposeTask(db, { kind: 'c2c', convId: 'dad-1', sourceMessageId: 'browse', intent: intent('douyin.browse'), origin: 'plan', now });
  const publish = proposeTask(db, { kind: 'c2c', convId: 'dad-1', sourceMessageId: 'publish', intent: intent('douyin.publish'), origin: 'plan', now });
  assert.equal(startAutomaticTask(db, browse.id, now), true);
  assert.equal(startAutomaticTask(db, publish.id, now), false);
  const calls = [];
  assert.equal((await executeTaskAction({ db, taskId: browse.id, operation: 'douyin.browse', execute: async (name) => { calls.push(name); return { ok: true }; }, now })).ok, true);
  assert.deepEqual(calls, ['douyin.browse']);
  assert.equal((await executeTaskAction({ db, taskId: publish.id, operation: 'douyin.publish', execute: async () => { throw new Error('must not execute'); }, now })).error, 'external_action_unauthorized');
  db.close();
});

test('board mutation endpoints require the administrator token before dispatch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dfy-board-auth-'));
  const service = await startConnect({ root, port: 0, config: { adminToken: 'board-secret', devices: {} }, qq: false });
  try {
    const base = `http://127.0.0.1:${service.port}`;
    for (const path of ['/api/board/approve?id=task-x', '/api/board/draft/publish?id=draft-x', '/api/board/write', '/api/academy/reset']) {
      const response = await fetch(base + path, { method: 'POST' });
      assert.equal(response.status, 401, path);
    }
    assert.equal((await fetch(base + '/api/board/auth')).status, 401);
    assert.equal((await fetch(base + '/api/board/auth', { headers: { authorization: 'Bearer board-secret' } })).status, 200);
    assert.equal((await fetch(base + '/api/board')).status, 401);
    assert.equal((await fetch(base + '/api/board/list?section=finished')).status, 401);
    assert.notEqual((await fetch(base + '/api/board', { headers: { authorization: 'Bearer board-secret' } })).status, 401);
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('standalone plan runs only actions bound to its owner approval', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dfy-approved-plan-'));
  const connectDir = join(root, 'runtime', 'connect');
  mkdirSync(connectDir, { recursive: true });
  writeFileSync(join(connectDir, 'targets.json'), JSON.stringify({ qq: { dad: 'dad-1' } }));
  const db = new DatabaseSync(join(connectDir, 'connect.sqlite'));
  try {
    initQq(db);
    const sentMs = Date.now() - 1000;
    createApprovalRecord(db, { id: 'approval-plan', code: 'PLAN1', ownerId: 'dad-1', operations: ['douyin.browse'], sentMs });
    logInbound(db, { id: 'plan-reply', kind: 'c2c', convId: 'dad-1', msgId: 'plan-reply', inputKind: 'text', text: '同意 PLAN1', createdMs: sentMs + 100 });
    assert.equal(claimApprovalDecision(db, { requestId: 'approval-plan', ownerId: 'dad-1' })?.approved, true);
    const plan = addPlan(root, { steps: [{ name: 'douyin.browse' }], origin: 'day-plan', approvalRequestId: 'approval-plan' });
    assert.equal(db.prepare('SELECT task_id FROM approvals WHERE id=?').get('approval-plan').task_id, plan.id);
    const calls = [];
    const result = await runPlan(root, { ...plan, steps: [{ name: 'douyin.publish' }] }, { execute: async (name) => { calls.push(name); return { ok: true, text: 'done' }; } });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, ['douyin.browse']);
    assert.equal(loadQueue(root).plans[0].status, 'done');
    assert.equal((await runPlan(root, plan, { execute: async () => { throw new Error('duplicate'); } })).error, 'plan_not_pending');
    const unapproved = addPlan(root, { steps: [{ name: 'douyin.publish' }], origin: 'day-plan' });
    const denied = await runPlan(root, unapproved, { execute: async () => { throw new Error('unauthorized'); } });
    assert.equal(denied.error, 'external_action_unauthorized');
    assert.equal(loadQueue(root).plans.find((item) => item.id === unapproved.id).status, 'failed');
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('standalone publication cannot run before its matching approval is consumed', async () => {
  const db = new DatabaseSync(':memory:');
  initQq(db);
  const sentMs = Date.now() - 1000;
  createApprovalRecord(db, { id: 'approval-publish', code: 'POST1', ownerId: 'dad-1', operations: ['douyin.publish'], sentMs });
  const calls = [];
  const execute = async (name) => { calls.push(name); return { ok: true }; };
  const options = { db, approvalRequestId: 'approval-publish', ownerId: 'dad-1', operation: 'douyin.publish', execute };
  assert.equal((await executeApprovalAction(options)).error, 'external_action_unauthorized');
  logInbound(db, { id: 'publish-reply', kind: 'c2c', convId: 'dad-1', msgId: 'publish-reply', inputKind: 'text', text: '同意 POST1', createdMs: sentMs + 100 });
  assert.equal(claimApprovalDecision(db, { requestId: 'approval-publish', ownerId: 'dad-1' })?.approved, true);
  assert.equal((await executeApprovalAction(options)).ok, true);
  assert.equal((await executeApprovalAction(options)).error, 'external_action_unauthorized');
  assert.deepEqual(calls, ['douyin.publish']);
  db.close();
});

test('approvals 表还没被惰性创建时，审批执行按未授权处理而不是抛 no such table', async () => {
  const db = new DatabaseSync(':memory:');
  // 故意不调 initApprovalLedger：真实库里 approvals 是首次审批才建的。
  const result = await executeApprovalAction({ db, approvalRequestId: 'approval-never-created', ownerId: 'dad-1', operation: 'douyin.publish', execute: async () => { throw new Error('should_not_run'); } });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'external_action_unauthorized');
  db.close();
});
