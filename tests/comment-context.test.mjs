// 「回复评论要带上下文」这条链路的纯函数测试：上下文整理 → 提示词文本 → 控件树解析 → 流水线透传。
// 全部离线；设备那次真实抓取在 scripts/douyin.mjs --probe-context 里，产物是 /tmp/douyin-detail.json。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildReplyContext, contextText, kindLabel, workKindOf,
} from '../connect/core/comment-context.mjs';
import { parseCommentDetail } from '../device/douyin.mjs';
import { runCommentPipeline } from '../connect/core/comment-pipeline.mjs';

/** 造一个抖音控件节点（字段与 device/uia.mjs 的 dumpUi 对齐）。 */
function node(cls, text, x, y, w = 200, h = 60, desc = '') {
  return { cls, text, desc, bounds: { cx: x, cy: y, x: x - w / 2, y: y - h / 2, w, h } };
}

test('上下文按「有没有作品、有没有评论链」分三种模式，长文本会被截断', () => {
  const full = buildReplyContext({
    work: { title: '三峡大坝那条', caption: '我'.repeat(500), kind: '视频', author: '大肥鱼小吃货' },
    comment: { author: '乐小小', text: '[比心][比心]' },
    thread: [
      { author: '乐小小', text: '[比心][比心]' },
      { author: '大肥鱼小吃货', text: '回复@乐小小' },
    ],
  });
  assert.equal(full.mode, 'work+thread');
  assert.equal(full.work.kind, 'video', '「视频」要归一成 video');
  assert.ok(full.work.caption.length <= 300, '作品正文要截断，别把整篇塞进提示词');

  const workOnly = buildReplyContext({
    work: { title: '只有作品', caption: '一句话', kind: 'image' },
    comment: { author: 'A', text: '好看' },
  });
  assert.equal(workOnly.mode, 'work_only');

  const bare = buildReplyContext({ comment: { author: 'B', text: '在吗' } });
  assert.equal(bare.mode, 'comment_only');
  assert.equal(bare.work, null);
});

test('提示词文本：有作品就写进作品与人话类型，没作品必须明说没读到', () => {
  const withWork = buildReplyContext({
    work: { title: '三峡大坝那条', caption: '蓝毛湿透了 #大肥鱼', kind: 'video' },
    comment: { author: '乐小小', text: '哈哈哈哈好可爱' },
    thread: [{ author: '乐小小', text: '哈哈哈哈好可爱' }],
    earlier: [{ author: '我', text: '谢谢你看' }],
  });
  const text = contextText(withWork);
  assert.match(text, /作品（视频）：三峡大坝那条/u);
  assert.match(text, /蓝毛湿透了/u);
  assert.match(text, /之前在这个帖子下说过/u);
  assert.match(text, /现在要回的是：乐小小 说「哈哈哈哈好可爱」/u);

  const bare = contextText(buildReplyContext({ comment: { author: 'C', text: '嗯' } }));
  assert.match(bare, /没读到/u, '抓不到作品时必须明确说没读到，模型才不敢编');
  assert.ok(bare.length <= 600, '提示词文本要有长度上限');
});

test('作品类型识别：中文/英文/缺省', () => {
  assert.equal(workKindOf('视频'), 'video');
  assert.equal(workKindOf('图文'), 'image');
  assert.equal(workKindOf('图集'), 'image');
  assert.equal(workKindOf(''), 'unknown');
  assert.equal(kindLabel('image'), '图文');
});

test('作品详情页的控件树能读出作者、正文、计数与评论链', () => {
  const nodes = [
    node('TextView', '评论 5', 127, 1078),
    node('TextView', '赞 19', 341, 1078),
    node('TextView', '收藏 0', 555, 1078),
    node('TextView', '浏览 204', 807, 1078),
    node('View', '', 656, 1338, 1312, 2676, '暂停视频，按钮'),
    node('TextView', '大肥鱼小吃货', 345, 1216, 270, 62),
    node('TextView', '作者', 543, 1217, 70, 47),
    node('TextView', '蓝毛小鲸鱼溜上三峡大坝吹风结果湿透了。梦里溜到三峡大坝吹了圈风。&#10;#大肥鱼 昨天20:23', 733, 1444, 1046, 365),
    node('TextView', '乐小小', 278, 1736, 135, 62),
    node('TextView', '[比心][比心]', 287, 1821, 154, 79),
    node('TextView', '昨天 22:05', 318, 2280, 216, 62),
    node('TextView', '回复', 692, 2280, 90, 62),
    node('View', '', 1078, 2281, 63, 63, '赞0,未选中'),
  ];
  const detail = parseCommentDetail(nodes);
  assert.equal(detail.work.author, '大肥鱼小吃货');
  assert.equal(detail.work.kind, 'video', '有视频播放控件就该判成视频');
  assert.match(detail.work.caption, /蓝毛小鲸鱼/u);
  assert.doesNotMatch(detail.work.caption, /昨天20:23/u, '正文结尾的时间戳要剥掉');
  assert.deepEqual(detail.counts, {
    评论: '5', 赞: '19', 收藏: '0', 浏览: '204',
  });
  assert.equal(detail.thread.length, 1);
  assert.deepEqual(
    { author: detail.thread[0].author, text: detail.thread[0].text },
    { author: '乐小小', text: '[比心][比心]' },
  );
});

test('上下文会一路传到拟稿函数，并记在流水线轨迹里', async () => {
  const context = buildReplyContext({
    work: { title: '三峡大坝那条', caption: '蓝毛湿透了', kind: 'video' },
    comment: { author: '乐小小', text: '哈哈哈哈好可爱' },
  });
  let seen = null;
  const result = await runCommentPipeline({
    comment: { author: '乐小小', text: '哈哈哈哈好可爱' },
    context,
    generate: async (payload) => {
      seen = payload;
      return '谢谢你呀，那条尾巴到现在还是湿的';
    },
    check: () => ({ ok: true, level: 'ok' }),
    publish: async () => ({ sent: true, ok: true }),
    dryRun: false,
  });
  assert.equal(seen.context.mode, 'work_only');
  assert.equal(seen.context.work.title, '三峡大坝那条');
  const draftStage = result.stages.find((item) => item.stage === 'draft');
  assert.equal(draftStage.context, 'work_only');
  assert.equal(result.draft.text, '谢谢你呀，那条尾巴到现在还是湿的');
});
