import assert from 'node:assert/strict';
import { test } from 'node:test';
import { interactionEvent } from '../connect/core-contract.mjs';
import { evaluatePolicy } from '../connect/policy.mjs';

const event = (senderRole, conversationKind = 'direct') => interactionEvent({
  channel: 'qq', conversationKind, conversationId: 'room-1',
  senderId: 'peer-1', senderRole, sourceEventId: 'msg-1', text: '执行',
});

test('owner private context can read memory and approve tasks', () => {
  const owner = event('owner');
  assert.equal(evaluatePolicy(owner, 'memory.read.owner').allowed, true);
  assert.equal(evaluatePolicy(owner, 'memory.write.owner').allowed, true);
  assert.equal(evaluatePolicy(owner, 'task.approve').allowed, true);
  assert.equal(evaluatePolicy(owner, 'external.execute').allowed, false);
  assert.equal(evaluatePolicy(owner, 'external.execute', { approved: true }).allowed, true);
});

test('friend and group messages cannot acquire owner authority', () => {
  for (const source of [event('friend'), event('owner', 'group'), event('member', 'group')]) {
    assert.equal(evaluatePolicy(source, 'memory.read.owner').allowed, false);
    assert.equal(evaluatePolicy(source, 'task.approve').allowed, false);
    assert.equal(evaluatePolicy(source, 'external.execute', { approved: true }).allowed, false);
  }
  assert.equal(evaluatePolicy(event('friend'), 'task.propose').allowed, false);
  assert.equal(evaluatePolicy(event('member', 'group'), 'task.propose').allowed, true);
});
