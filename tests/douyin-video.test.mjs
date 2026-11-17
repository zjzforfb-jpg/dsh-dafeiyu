import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = join(import.meta.dirname, '..');
const source = readFileSync(join(root, 'scripts', 'douyin-video.mjs'), 'utf8');

test('视频发布脚本默认不发出去，只有 --publish 才点发布', () => {
  assert.match(source, /const publish = has\('publish'\)/u);
  assert.match(source, /if \(!publish\) \{/u, '没有 --publish 时要停在发布页之前');
});

test('视频发布走「先收话题面板再点发作品」的确定性顺序', () => {
  // 描述里带 # 会弹话题候选面板，把「发作品」视觉上盖住；直接点坐标会点到话题列表。
  assert.match(source, /async function settlePublishPage\(/u, '要有收尾函数统一处理面板');
  assert.match(source, /chipCount\(page\) < 5 && hasText\(page, '发作品'\)/u);
  assert.match(source, /input keyevent 4/u, '面板开着时先退到剪辑页');
  assert.match(source, /=== '下一步'/u, '再点下一步回到发布页');
  assert.match(source, /=== '发作品'/u);
});

test('视频发布用视频媒体的 content URI，且真的发出去才记为 published', () => {
  assert.match(source, /content:\/\/media\/external\/video\/media\/\$\{mediaId\}/u, '分享 intent 要用 video 的 content URI');
  assert.match(source, /-t video\/mp4/u, 'MIME 必须是 video/mp4');
  assert.match(source, /leftEditor/u, '要靠「是否离开剪辑页」判断，而不是只看文本');
  assert.match(source, /status: published \? 'published' : 'unknown'/u);
  assert.match(source, /recordActivity\(/u, '发出去要留一条活动记录');
});
