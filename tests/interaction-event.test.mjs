import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { interactionEvent } from '../connect/core-contract.mjs';
import { ownerDigestEvents, recordDailyMessage } from '../connect/daily-memory.mjs';

const validEvent = () => ({ channel: 'qq', conversationKind: 'direct', conversationId: 'owner-room', senderId: 'owner-id', senderRole: 'owner', text: '你好' });

test('interaction event rejects an unknown channel', () => {
  assert.throws(() => interactionEvent({ ...validEvent(), channel: 'untrusted' }), /invalid_interaction_channel/);
});

test('interaction event rejects an unknown conversation type', () => {
  assert.throws(() => interactionEvent({ ...validEvent(), conversationKind: 'private_group' }), /invalid_interaction_conversation/);
});

test('interaction event rejects an unknown input type', () => {
  assert.throws(() => interactionEvent({ ...validEvent(), inputKind: 'command' }), /invalid_interaction_content/);
});

test('interaction event requires both conversation and sender identity', () => {
  assert.throws(() => interactionEvent({ ...validEvent(), conversationId: '' }), /invalid_interaction_identity/);
  assert.throws(() => interactionEvent({ ...validEvent(), senderId: '' }), /invalid_interaction_identity/);
});

test('interaction identity is stable within a channel and isolated across accounts', () => {
  const input = {
    channel: 'wechat', accountId: 'bot-a', conversationId: 'peer-a',
    senderId: 'peer-a', senderRole: 'friend', sourceEventId: 'msg-1',
    text: '你好',
  };
  const first = interactionEvent(input);
  assert.equal(first.event_id, interactionEvent(input).event_id);
  assert.notEqual(first.event_id, interactionEvent({ ...input, accountId: 'bot-b' }).event_id);
  assert.equal(first.trust.instruction_trust, 'untrusted_user_input');
  assert.equal(first.sender.canonical_person_id, null);
  assert.deepEqual(first.permissions_context.scopes, ['conversation']);
  const owner = interactionEvent({ ...input, senderRole: 'owner' });
  assert.equal(owner.trust.instruction_trust, 'verified_user_input');
  assert.equal(owner.trust.source_class, 'private');
  assert.equal(owner.sender.canonical_person_id, 'owner');
  const group = interactionEvent({ ...input, conversationKind: 'group', senderRole: 'owner' });
  assert.equal(group.trust.instruction_trust, 'untrusted_user_input');
  assert.equal(group.trust.source_class, 'group');
});

test('owner digest excludes friend, group and legacy unscoped WeChat rows', () => {
  const db = new DatabaseSync(':memory:');
  const at = new Date('2026-11-16T03:00:00Z');
  const day = '2026-11-16';
  recordDailyMessage(db, { channel: 'wechat', peerId: 'friend', speaker: 'friend', content: '朋友的秘密', privacyScope: 'friend', at });
  recordDailyMessage(db, { channel: 'wechat', peerId: 'legacy', content: '旧版好友内容', privacyScope: 'private', at });
  recordDailyMessage(db, { channel: 'qq', conversationKind: 'group', peerId: 'group', content: '群内消息', privacyScope: 'group', at });
  recordDailyMessage(db, { channel: 'wechat', peerId: 'owner', speaker: 'owner', content: '爸爸的话', privacyScope: 'private', at });
  assert.deepEqual(ownerDigestEvents(db, day).map((row) => row.content), ['爸爸的话']);
  db.close();
});
