// P1-B · B-1：评论专用流水线七段（ADR-004）。
//
// 验收目标：
//  1) 七段固定且按序留痕：understand → intent → draft → compliance → decision → publish → verify。
//  2) 与通用聊天链路解耦：整条流水线在**没有手机**的情况下可跑完（设备动作全靠注入）。
//  3) 风险分层（D5）：R2 自动、R3 必人工；合规 draft 也转人工；合规 block 直接不发。
//  4) 回执用 P0-C 五态：平台说发了只是 accepted，业务核过才是 verified。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMMENT_STAGES, DECISIONS,
  understandComment, decideIntent, draftReply, checkCompliance, decideAction, verifyPublish,
  runCommentPipeline, summarizePipeline,
} from '../connect/core/comment-pipeline.mjs';

const allow = (text) => ({ ok: true, level: 'allow', id: 'ok', reason: 'ok', text });

test('B-1：七段顺序固定，每次运行都留下完整轨迹', async () => {
  const result = await runCommentPipeline({
    comment: { author: '小鱼', text: '这条视频拍得真好看' },
    generate: async () => '谢谢你喜欢！',
    publish: async () => ({ sent: true, verified: true }),
    check: allow,
  });
  assert.deepEqual(result.stages.map((s) => s.stage), [...COMMENT_STAGES]);
  assert.ok(result.stages.every((s) => s.status));
  assert.ok(result.ok);
});

test('B-1：纯表情评论回可爱表情，不硬编文字', async () => {
  let generated = false;
  const result = await runCommentPipeline({
    comment: { text: '🐟' },
    generate: async () => { generated = true; return '不该被调用'; },
    publish: async () => ({ sent: true, verified: true }),
    check: allow,
    random: () => 0,
  });
  assert.equal(generated, false);
  assert.equal(result.intent.intent, 'emoji');
  assert.equal(result.draft.kind, 'emoji');
  assert.ok(result.draft.text.length > 0);
});

test('B-1：只有图/空评论直接跳过，不进拟稿也不进发布', async () => {
  let published = false;
  const result = await runCommentPipeline({
    comment: { text: '' },
    publish: async () => { published = true; return { sent: true }; },
    check: allow,
  });
  assert.equal(published, false);
  assert.equal(result.skipped, true);
  assert.equal(result.stage, 'intent');
  assert.equal(result.stages.find((s) => s.stage === 'publish').status, 'skipped');
});

test('B-1：合规 block 不发出去', async () => {
  let published = false;
  const result = await runCommentPipeline({
    comment: { text: '来看看这个' },
    generate: async () => '加微信 abc123',
    publish: async () => { published = true; return { sent: true }; },
    check: () => ({ ok: false, level: 'block', id: 'BF001', reason: '含联系方式' }),
  });
  assert.equal(published, false);
  assert.equal(result.decision.decision, 'skip');
  assert.equal(result.stages.find((s) => s.stage === 'publish').status, 'skipped');
});

test('B-1：合规 draft 转人工确认，不自动发', async () => {
  let published = false;
  const result = await runCommentPipeline({
    comment: { text: '多少钱' },
    generate: async () => '私信聊价格',
    publish: async () => { published = true; return { sent: true }; },
    check: () => ({ ok: false, level: 'draft', id: 'BF006', reason: '价格敏感' }),
  });
  assert.equal(published, false);
  assert.equal(result.needsReview, true);
  assert.equal(result.decision.reason, '价格敏感');
});

test('B-1：风险 R3 即使合规也必须人工确认', async () => {
  let published = false;
  const result = await runCommentPipeline({
    comment: { text: '你好' },
    generate: async () => '你好呀',
    publish: async () => { published = true; return { sent: true }; },
    check: allow,
    risk: 'R3',
  });
  assert.equal(published, false);
  assert.equal(result.needsReview, true);
  assert.equal(result.decision.reason, 'risk_requires_confirmation');
});

test('B-1：too_fast 是重试不是失败', async () => {
  const result = await runCommentPipeline({
    comment: { text: '你好' },
    generate: async () => '你好呀',
    publish: async () => ({ sent: true }),
    check: () => ({ ok: false, level: 'block', id: 'too_fast', reason: '发太快' }),
  });
  assert.equal(result.retry, true);
  assert.equal(result.ok, false);
  assert.equal(result.decision.decision, 'retry');
});

test('B-1：回执五态——平台说发了只是 accepted，业务核过才是 verified', async () => {
  const accepted = await runCommentPipeline({
    comment: { text: '你好' },
    generate: async () => '你好呀',
    publish: async () => ({ sent: true }),
    check: allow,
  });
  assert.equal(accepted.receipt.status, 'accepted');
  assert.equal(accepted.receipt.verified, false);
  assert.equal(accepted.ok, true);

  const verified = await runCommentPipeline({
    comment: { text: '你好' },
    generate: async () => '你好呀',
    publish: async () => ({ sent: true, verified: true }),
    check: allow,
  });
  assert.equal(verified.receipt.status, 'verified');
  assert.equal(verified.receipt.verified, true);

  const failed = await runCommentPipeline({
    comment: { text: '你好' },
    generate: async () => '你好呀',
    publish: async () => ({ sent: false, ok: false, error: '弹窗挡住' }),
    check: allow,
  });
  assert.equal(failed.receipt.status, 'failed');
  assert.equal(failed.ok, false);
});

test('B-1：拟稿失败要显式失败，不静默', async () => {
  const result = await runCommentPipeline({
    comment: { text: '你好' },
    generate: async () => { throw new Error('model_down'); },
    publish: async () => ({ sent: true }),
    check: allow,
  });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'draft');
  assert.equal(result.stages.find((s) => s.stage === 'draft').status, 'failed');
});

test('B-1：dry-run 只拟稿不发', async () => {
  let published = false;
  const result = await runCommentPipeline({
    comment: { text: '你好' },
    generate: async () => '你好呀',
    publish: async () => { published = true; return { sent: true }; },
    check: allow,
    dryRun: true,
  });
  assert.equal(published, false);
  assert.equal(result.dryRun, true);
  assert.equal(result.draft.text, '你好呀');
});

test('B-1：纯函数逐段可单测', () => {
  assert.deepEqual(understandComment('🐟🐠'), { kind: 'emoji', meaningful: false, text: '🐟🐠' });
  assert.deepEqual(understandComment(''), { kind: 'image', meaningful: false, text: '' });
  assert.deepEqual(understandComment('好看'), { kind: 'text', meaningful: true, text: '好看' });
  assert.deepEqual(understandComment('拍得真好看'), { kind: 'text', meaningful: true, text: '拍得真好看' });

  assert.deepEqual(decideIntent({ kind: 'emoji', meaningful: false }), { intent: 'emoji', reason: 'low_signal' });
  assert.deepEqual(decideIntent({ kind: 'text', meaningful: true }), { intent: 'reply', reason: 'has_content' });
  assert.deepEqual(decideIntent({ kind: 'image', meaningful: false }), { intent: 'skip', reason: 'no_content' });

  assert.deepEqual(checkCompliance({ text: 'x', check: allow }), { ok: true, level: 'allow', id: 'ok', reason: 'ok' });
  assert.equal(decideAction({ compliance: { ok: true, level: 'allow', id: 'ok', reason: 'ok' }, risk: 'R2' }).decision, 'auto');
  assert.equal(decideAction({ compliance: { ok: true, level: 'allow', id: 'ok', reason: 'ok' }, risk: 'R3' }).decision, 'review');
  assert.equal(decideAction({ compliance: { ok: false, level: 'block', id: 'BF1', reason: 'x' } }).decision, 'skip');
  assert.equal(decideAction({ compliance: { ok: false, level: 'block', id: 'too_fast', reason: 'x' } }).decision, 'retry');
  assert.ok(DECISIONS.includes('auto'));
});

test('B-1：摘要分情况说得清楚', () => {
  assert.match(summarizePipeline({ skipped: true }), /跳过/);
  assert.match(summarizePipeline({ needsReview: true, draft: { text: '草稿' } }), /点个头/);
  assert.match(summarizePipeline({ retry: true }), /等会儿/);
  assert.match(summarizePipeline({ ok: false, reason: 'boom' }), /没回成/);
  assert.match(summarizePipeline({ ok: true, receipt: { status: 'verified', verified: true }, draft: { text: '回好了' } }), /回好了/);
  assert.match(summarizePipeline({ ok: true, receipt: { status: 'accepted' }, draft: { text: '发了' } }), /平台没回执确认/);
});

test('B-1：回执工具函数直接可用', () => {
  const receipt = verifyPublish({ result: { sent: true, verified: true } });
  assert.equal(receipt.status, 'verified');
  assert.equal(receipt.operation, 'douyin.reply_comments');
  assert.equal(receipt.adapter, 'douyin');
});
