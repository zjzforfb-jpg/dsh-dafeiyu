import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { claimApprovalDecision, createApprovalRecord } from '../connect/approvals.mjs';
import { initQq, logInbound } from '../connect/qq/store.mjs';

test('approval decision is persisted and one owner reply can be claimed only once', () => {
  const db = new DatabaseSync(':memory:');
  initQq(db);
  const ownerId = 'owner-openid-0001';
  createApprovalRecord(db, { id: 'request-1', code: 'CODE1', ownerId, taskId: 'task-1', sentMs: 100, timeoutMs: 1000 });
  logInbound(db, { id: 'group-reply', kind: 'group', convId: 'group-openid-1', msgId: 'group-reply', inputKind: 'text', text: '同意 CODE1', createdMs: 110, author: ownerId });
  logInbound(db, { id: 'friend-reply', kind: 'c2c', convId: 'friend-openid-1', msgId: 'friend-reply', inputKind: 'text', text: '同意 CODE1', createdMs: 111 });
  logInbound(db, { id: 'spoofed-reply', kind: 'c2c', convId: ownerId, msgId: 'spoofed-reply', inputKind: 'text', text: '同意 CODE1', createdMs: 112, author: 'other-member' });
  assert.equal(claimApprovalDecision(db, { requestId: 'request-1', ownerId, now: 120 }), null);
  logInbound(db, { id: 'owner-reply', kind: 'c2c', convId: ownerId, msgId: 'owner-reply', inputKind: 'text', text: '同意 CODE1', createdMs: 121 });
  assert.equal(claimApprovalDecision(db, { requestId: 'request-1', ownerId, now: 122 })?.approved, true);
  assert.equal(claimApprovalDecision(db, { requestId: 'request-1', ownerId, now: 123 }), null);
  assert.deepEqual({ ...db.prepare('SELECT task_id,approver_peer_id,approver_role,decision,channel,message_id,decided_ms FROM approvals WHERE id=?').get('request-1') }, {
    task_id: 'task-1', approver_peer_id: ownerId, approver_role: 'owner', decision: 'approved', channel: 'qq', message_id: 'owner-reply', decided_ms: 121,
  });
  db.close();
});

test('concurrent approvals require a code and replies cannot be reused', () => {
  const db = new DatabaseSync(':memory:');
  initQq(db);
  const ownerId = 'owner-openid-0001';
  createApprovalRecord(db, { id: 'request-a', code: 'CODEA', ownerId, sentMs: 100, timeoutMs: 1000 });
  createApprovalRecord(db, { id: 'request-b', code: 'CODEB', ownerId, sentMs: 101, timeoutMs: 1000 });
  const put = (id, text, at) => logInbound(db, { id, kind: 'c2c', convId: ownerId, msgId: id, inputKind: 'text', text, createdMs: at });
  put('ambiguous', '同意', 120);
  assert.equal(claimApprovalDecision(db, { requestId: 'request-a', ownerId, now: 121 }), null);
  assert.equal(claimApprovalDecision(db, { requestId: 'request-b', ownerId, now: 121 }), null);
  put('coded', '不行 CODEB', 122);
  assert.equal(claimApprovalDecision(db, { requestId: 'request-b', ownerId, now: 123 })?.approved, false);
  assert.equal(claimApprovalDecision(db, { requestId: 'request-a', ownerId, now: 123 }), null);
  put('approved', '同意 CODEA', 124);
  assert.equal(claimApprovalDecision(db, { requestId: 'request-a', ownerId, now: 125 })?.approved, true);
  assert.deepEqual(db.prepare('SELECT id,decision,message_id FROM approvals ORDER BY id').all().map((row) => ({ ...row })), [
    { id: 'request-a', decision: 'approved', message_id: 'approved' },
    { id: 'request-b', decision: 'rejected', message_id: 'coded' },
  ]);
  db.close();
});

test('expired approval cannot be claimed', () => {
  const db = new DatabaseSync(':memory:');
  initQq(db);
  const ownerId = 'owner-openid-0001';
  createApprovalRecord(db, { id: 'request-expired', code: 'EXPIRED', ownerId, sentMs: 100, timeoutMs: 10 });
  logInbound(db, { id: 'late-reply', kind: 'c2c', convId: ownerId, msgId: 'late-reply', inputKind: 'text', text: '同意 EXPIRED', createdMs: 111 });
  assert.equal(claimApprovalDecision(db, { requestId: 'request-expired', ownerId, now: 112 }), null);
  assert.equal(db.prepare('SELECT decision FROM approvals WHERE id=?').get('request-expired').decision, 'expired');
  createApprovalRecord(db, { id: 'request-on-time', code: 'ONTIME', ownerId, sentMs: 200, timeoutMs: 10 });
  logInbound(db, { id: 'on-time-reply', kind: 'c2c', convId: ownerId, msgId: 'on-time-reply', inputKind: 'text', text: '同意 ONTIME', createdMs: 209 });
  assert.equal(claimApprovalDecision(db, { requestId: 'request-on-time', ownerId, now: 212 })?.approved, true);
  db.close();
});
