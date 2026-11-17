import test from 'node:test';
import assert from 'node:assert/strict';
import { HEAL_POLICY, NEVER_CLICK, pickHealTarget } from '../device/douyin.mjs';

const node = (text, clickable = true) => ({ text, desc: '', clickable, bounds: { cx: 10, cy: 20, left: 0, top: 10, right: 20, bottom: 30 } });

test('草稿恢复弹窗：按白名单点「放弃/取消」，不点「继续编辑」', () => {
  const nodes = [node('继续编辑作品'), node('放弃'), node('取消')];
  const target = pickHealTarget(nodes, 'draft_resume');
  assert.ok(target);
  assert.equal(target.text, '放弃');
  assert.equal(HEAL_POLICY.draft_resume.texts.includes('继续编辑'), false);
});

test('权限/登录/升级不自动处理', () => {
  assert.equal(HEAL_POLICY.permission, null);
  assert.equal(pickHealTarget([node('允许')], 'permission'), null);
  assert.equal(pickHealTarget([node('立即升级')], 'upgrade'), null);
  assert.equal(pickHealTarget([node('一键登录')], 'login'), null);
});

test('危险文字永不点击', () => {
  for (const text of ['允许', '同意授权', '立即更新', '发布', '发作品', '购买', '支付']) {
    assert.equal(NEVER_CLICK.test(text), true, text);
  }
  assert.equal(NEVER_CLICK.test('取消'), false);
  assert.equal(NEVER_CLICK.test('重试'), false);
});

test('网络错误可以点「重试」，没有匹配就不动', () => {
  assert.equal(pickHealTarget([node('重试')], 'network')?.text, '重试');
  assert.equal(pickHealTarget([node('好的')], 'network'), null);
  assert.equal(pickHealTarget([node('取消')], 'unknown_kind'), null);
});
