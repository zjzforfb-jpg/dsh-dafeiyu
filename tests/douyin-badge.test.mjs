import assert from 'node:assert/strict';
import test from 'node:test';

import { parseMessageBadge } from '../device/douyin.mjs';

const node = (text, cx, cy, extra = {}) => ({
  cls: 'android.widget.TextView',
  text,
  desc: '',
  bounds: { x: cx - 40, y: cy - 30, w: 80, h: 60, cx, cy },
  ...extra,
});

const tabs = () => [
  node('首页', 130, 2762),
  node('朋友', 392, 2762),
  node('消息', 917, 2762),
  node('我', 1180, 2762),
];

test('首页「消息」tab 右上角的小数字就是红点', () => {
  const badge = parseMessageBadge([...tabs(), node('3', 996, 2738, { bounds: { x: 980, y: 2720, w: 34, h: 40, cx: 996, cy: 2740 } })]);
  assert.equal(badge.has, true);
  assert.equal(badge.count, 3);
  assert.equal(badge.label, '3');
  assert.deepEqual(badge.point, { x: 996, y: 2740 });
});

test('99+ 这种溢出数字按 99 记，不丢「有未读」这个事实', () => {
  const badge = parseMessageBadge([...tabs(), node('99+', 1000, 2735, { bounds: { x: 980, y: 2718, w: 46, h: 34, cx: 1002, cy: 2735 } })]);
  assert.equal(badge.has, true);
  assert.equal(badge.count, 99);
  assert.equal(badge.label, '99+');
});

test('没有红点时不要误报', () => {
  assert.deepEqual(
    [parseMessageBadge(tabs()).has, parseMessageBadge(tabs()).count],
    [false, null],
  );
});

test('离「消息」tab 很远的数字（比如视频点赞数）不算红点', () => {
  const badge = parseMessageBadge([...tabs(), node('5848', 1288, 1200, { bounds: { x: 1250, y: 1180, w: 76, h: 40, cx: 1288, cy: 1200 } })]);
  assert.equal(badge.has, false);
});

test('新版本把条数写进 desc 时也认', () => {
  const badge = parseMessageBadge(tabs().map((item) => (item.text === '消息'
    ? { ...item, desc: '消息，5条未读' }
    : item)));
  assert.equal(badge.has, true);
  assert.equal(badge.count, 5);
});

test('红点哨兵脚本：默认 60 秒一次、只看首页、有红点才去回', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const source = readFileSync(join(import.meta.dirname, '..', 'scripts', 'douyin-inbox-watch.mjs'), 'utf8');
  assert.match(source, /openFeed\(/u, '要回首页读红点');
  assert.match(source, /parseMessageBadge\(/u);
  assert.match(source, /option\('interval', 60\)/u, '默认一分钟一次');
  assert.match(source, /--reply-inbox/u, '有红点才进评论流水线');
  assert.match(source, /inbox-watch\.lock/u, '常驻进程要互斥，别两个实例抢手机');
});
