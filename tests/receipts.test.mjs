import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  STATUS, createReceipt, validateReceipt, recordReceipt,
  receiptOk, receiptVerified, classifyResult,
} from '../connect/receipts.mjs';

// P0-C-3：回执五态。核心是把「我调用了 / 平台接受了 / 业务验证了」三态拆开，
// 别再把一个 ok:true 当成万事大吉（架构 ADR：执行结果需验证）。

test('classifyResult 把结果归到五态', () => {
  assert.equal(classifyResult({ ok: true, verified: true }), 'verified');   // 业务真核对过
  assert.equal(classifyResult({ ok: true }), 'accepted');                  // 平台接受了，没独立核账
  assert.equal(classifyResult({ ok: true, accepted: false }), 'invoked');  // 只按了，平台没确认
  assert.equal(classifyResult({ invoked: true }), 'invoked');
  assert.equal(classifyResult({ ok: false, error: 'x' }), 'failed');
  assert.equal(classifyResult({}), 'unknown');
  assert.equal(classifyResult(null), 'unknown');
});

test('三态语义：invoked → accepted → verified 是置信度递进', () => {
  const invoked = createReceipt({ operation: 'a', result: { ok: true, accepted: false } });
  const accepted = createReceipt({ operation: 'a', result: { ok: true } });
  const verified = createReceipt({ operation: 'a', result: { ok: true, verified: true } });
  // 三条都算「腿迈出去了」（任务能推进）……
  assert.ok(receiptOk(invoked.status));
  assert.ok(receiptOk(accepted.status));
  assert.ok(receiptOk(verified.status));
  // ……但只有 verified 才算「业务真的成了」。
  assert.equal(receiptVerified(invoked.status), false);
  assert.equal(receiptVerified(accepted.status), false);
  assert.equal(receiptVerified(verified.status), true);
});

test('createReceipt 五态 + 只认这五个', () => {
  const verified = createReceipt({ operation: 'douyin.reply_comments', adapter: 'douyin', result: { ok: true, verified: true, text: 'sent=2' } });
  const accepted = createReceipt({ operation: 'douyin.reply_comments', adapter: 'douyin', result: { ok: true, text: 'sent=2' } });
  const invoked = createReceipt({ operation: 'douyin.draft', adapter: 'douyin', result: { ok: true, accepted: false } });
  const fail = createReceipt({ operation: 'douyin.like_comments', adapter: 'douyin', result: { ok: false, error: 'not_implemented' } });
  const unknown = createReceipt({ operation: 'x', result: {} });
  assert.equal(verified.status, 'verified');
  assert.equal(accepted.status, 'accepted');
  assert.equal(invoked.status, 'invoked');
  assert.equal(fail.status, 'failed');
  assert.equal(unknown.status, 'unknown');
  assert.deepEqual([...STATUS].sort(), ['accepted', 'failed', 'invoked', 'unknown', 'verified']);
  for (const r of [verified, accepted, invoked, fail, unknown]) assert.equal(validateReceipt(r), true);
  assert.equal(validateReceipt({ status: 'succeeded' }), false); // 旧三态不再是合法值
  assert.equal(validateReceipt({ status: 'accepted' }), false);  // 缺字段也不认
});

test('receiptOk 只把失败/未知判成没成', () => {
  assert.ok(receiptOk('invoked'));
  assert.ok(receiptOk('accepted'));
  assert.ok(receiptOk('verified'));
  assert.ok(!receiptOk('failed'));
  assert.ok(!receiptOk('unknown'));
});

test('recordReceipt 按五态映射到统一事件流', () => {
  const db = new DatabaseSync(':memory:');
  const cases = [
    [{ ok: true, accepted: false }, 'action_started'],
    [{ ok: true }, 'action_finished'],
    [{ ok: true, verified: true }, 'receipt_verified'],
    [{ ok: false, error: 'e' }, 'action_failed'],
    [{}, 'observation_created'],
  ];
  for (const [index, [result, eventType]] of cases.entries()) {
    const receipt = createReceipt({ operation: 'op', adapter: 'douyin', result, observedAt: `2026-11-15T02:00:0${index}.000Z` });
    const event = recordReceipt(db, receipt, { taskId: 'task_1', channel: 'douyin' });
    assert.equal(event.event_type, eventType);
    assert.equal(event.task_id, 'task_1');
  }
  db.close();
});
