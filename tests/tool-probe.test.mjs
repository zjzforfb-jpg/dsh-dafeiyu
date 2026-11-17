import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

/**
 * 打电话这类「一按就响对方手机」的工具，必须有一个只读探针：
 * 能在不动声卡、不拨号的前提下回答「窗口在不在、联系人是谁、按钮坐标在哪」。
 * 这个测试盯的是「探针真的在拨号之前就返回了」。
 */
const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

test('qq-call 的 --probe 在拨号与切声卡之前就返回', () => {
  const source = read('scripts/qq-call.mjs');
  const probeAt = source.indexOf("if (has('probe'))");
  assert.ok(probeAt > 0, 'qq-call 没有 --probe 分支');
  const enableAt = source.indexOf("runSound('--enable')");
  assert.ok(enableAt > probeAt, '--probe 必须在切声卡之前返回（否则探针会打断系统音频）');
  const dialAt = source.indexOf('await dial(');
  assert.ok(dialAt > probeAt, '--probe 必须在拨号之前返回');
  const block = source.slice(probeAt, source.indexOf('\n  }', probeAt));
  assert.ok(!/await dial\(/u.test(block), '--probe 里不许拨号');
  assert.ok(!/startBridge\(/u.test(block), '--probe 里不许起声卡桥');
  assert.match(block, /contact/u, '探针要报出会拨给谁');
  assert.match(block, /QQ_LAYOUT\.callIcon/u, '探针要报出拨号按钮坐标');
});

test('wechat-call 的 --probe 同样在拨号之前返回', () => {
  const source = read('scripts/wechat-call.mjs');
  const probeAt = source.indexOf("if (has('probe'))");
  assert.ok(probeAt > 0, 'wechat-call 没有 --probe 分支');
  const callAt = source.indexOf('await startVoiceCall(');
  assert.ok(callAt > probeAt, '--probe 必须在拨号之前返回');
  const block = source.slice(probeAt, source.indexOf('process.exit(0)', probeAt));
  assert.ok(!/startVoiceCall\(/u.test(block), '--probe 里不许拨号');
  assert.ok(!/runSound\(/u.test(block), '--probe 里不许切声卡');
  assert.match(block, /微信/u, '探针要按中文 owner 名找窗口');
  assert.match(block, /WeChat/u, '探针也要兼容英文 owner 名');
});
