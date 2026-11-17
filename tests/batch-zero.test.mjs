import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { anyReplySince } from '../connect/plans.mjs';
import { checkComment, LIMITS } from '../connect/douyin/compliance.mjs';
import { initQq, logInbound } from '../connect/qq/store.mjs';

test('plan reply check reads the owner private inbound message schema', () => {
  const root = mkdtempSync(join(tmpdir(), 'dfy-reply-check-'));
  const dir = join(root, 'runtime', 'connect');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'connect.sqlite'));
  try {
    initQq(db);
    const put = (id, kind, convId, at, author = null) => logInbound(db, { id, kind, convId, msgId: id, inputKind: 'text', text: '收到', createdMs: at, author });
    put('old', 'c2c', 'owner-openid', 99);
    put('group', 'group', 'owner-openid', 101);
    put('friend', 'c2c', 'friend-openid', 102);
    put('spoofed', 'c2c', 'owner-openid', 103, 'friend-openid');
    assert.equal(anyReplySince(root, 100, 'owner-openid'), false);
    put('owner', 'c2c', 'owner-openid', 104);
    assert.equal(anyReplySince(root, 100, 'owner-openid'), true);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('sixth comment within one hour is held for review', () => {
  const decision = checkComment('谢谢你来看小鱼', { hourCount: LIMITS.hourlyComments, todayCount: 5, now: 1000 });
  assert.deepEqual({ ok: decision.ok, level: decision.level, id: decision.id }, { ok: false, level: 'draft', id: 'hourly_cap' });
  assert.equal(checkComment('谢谢你来看小鱼', { hourCount: LIMITS.hourlyComments - 1, todayCount: 4, now: 1000 }).ok, true);
});
