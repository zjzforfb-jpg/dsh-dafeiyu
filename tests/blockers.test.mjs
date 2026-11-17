import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findBlockers, emptyProof } from '../device/douyin.mjs';
import { classifyFailure } from '../connect/skills/defs.mjs';
import { failureReply } from '../connect/qq/service.mjs';

function node(text, extra = {}) {
  return { text, desc: '', cls: 'android.widget.TextView', clickable: false, bounds: { left: 0, top: 0, right: 100, bottom: 50 }, ...extra };
}

test('能识别「继续编辑作品」这类草稿恢复弹窗', () => {
  const blockers = findBlockers([node('继续编辑作品'), node('取消'), node('发作品')]);
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].kind, 'draft_resume');
  assert.equal(blockers[0].text, '继续编辑作品');
  assert.deepEqual(blockers[0].point, { x: 50, y: 25 });
});

test('describing 权限/登录/升级 也能识别，且同类只报一次', () => {
  const blockers = findBlockers([
    node('', { desc: '允许访问相册权限，按钮' }),
    node('允许访问相册权限'),
    node('一键登录'),
    node('立即升级'),
  ]);
  const kinds = blockers.map((item) => item.kind).sort();
  assert.deepEqual(kinds, ['login', 'permission', 'upgrade']);
  assert.equal(blockers.filter((item) => item.kind === 'permission').length, 1);
});

test('正常页面不误报', () => {
  assert.deepEqual(findBlockers([node('继续看'), node('发布'), node('评论 3')]), []);
  assert.deepEqual(findBlockers([]), []);
});

test('空态需要页面上的明确文案才算数', () => {
  assert.equal(emptyProof([node('暂时没有更多了')]).ok, true);
  assert.equal(emptyProof([node('还没有评论')]).ok, true);
  assert.equal(emptyProof([node('评论 0')]).ok, false);
  assert.equal(emptyProof([]).ok, false);
});

test('工具失败时不允许说成「看过了」', () => {
  assert.equal(failureReply([{ ok: true, status: 'ok', text: '评论 4 条' }]), '');
  const text = failureReply([
    { ok: false, status: 'blocked', text: '被弹窗挡住了：继续编辑作品。' },
    { ok: true, status: 'ok', text: '无关' },
  ]);
  assert.match(text, /没做成/u);
  assert.match(text, /继续编辑作品/u);
  assert.match(failureReply([{ ok: true, status: 'unconfirmed', text: '没读到列表' }]), /没读到列表/u);
});

test('读评论没确认会归到 read_comments 阶段（而不是笼统的 action）', () => {
  assert.equal(classifyFailure('interactions_unconfirmed:没读到评论列表，也没看到空态提示'), 'read_comments');
  assert.equal(classifyFailure('blocked_by_dialog:draft_resume:继续编辑作品'), 'blocked:draft_resume');
});
