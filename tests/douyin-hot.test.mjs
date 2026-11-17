import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseCommentsWithLikes, parseLikes, parseSearchHotVideos, topComments } from '../device/douyin.mjs';
import { hotStats, markHotCommentReplied, openDouyinDb, saveHotComment, saveVideo, videosForRound } from '../connect/douyin/store.mjs';

const text = (value, cx, cy, { w = 200, h = 60, clickable = false } = {}) => ({
  cls: 'android.widget.TextView', text: value, clickable, bounds: { cx, cy, w, h, x: cx - w / 2, y: cy - h / 2 },
});

test('点赞数：「28.8万」「2803」「1.2w」都认得', () => {
  assert.equal(parseLikes('28.8万'), 288_000);
  assert.equal(parseLikes('2803'), 2_803);
  assert.equal(parseLikes('1.2w'), 12_000);
  assert.equal(parseLikes('·'), 0);
});

test('搜索结果按几何配出标题/日期/点赞，并按点赞降序', () => {
  const nodes = [
    text('29岁女程序员，我快扛不住了..‍..#程序员', 332, 1595, { w: 579, h: 141 }),
    text('程序员•我好哇噻', 292, 1719, { w: 304, h: 52 }),
    text('09.19', 180, 1767, { w: 79, h: 43 }),
    text('2803', 576, 1740, { w: 91, h: 54 }),
    text('我伟大的甲方，又来指导技术教学了', 981, 1595, { w: 579, h: 141 }),
    text('老头们的快乐生活', 929, 1719, { w: 280, h: 52 }),
    text('05.15', 829, 1767, { w: 79, h: 43 }),
    text('28.8万', 1212, 1740, { w: 117, h: 54 }),
    text('05:04', 1222, 1443, { w: 97, h: 56 }), // 时长，不是点赞
  ];
  const cards = parseSearchHotVideos(nodes);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].likes, 288_000);
  assert.equal(cards[0].title, '我伟大的甲方，又来指导技术教学了');
  assert.equal(cards[1].likes, 2_803);
});

test('评论区：给每条评论配上右边的点赞数，只挑最高赞的两条', () => {
  const nodes = [
    text('HTz', 247, 1353),
    text('这就是说的眼见不一定为实！搞软件的牛逼', 704, 1434, { w: 988 }),
    text('05-15', 268, 1518),
    text('回复', 591, 1518, { clickable: true }),
    text('3', 1097, 1518, { w: 25 }),
    text('sanshier', 287, 1741),
    text('哈哈哈，想起当初汇报智慧城市项目的痛苦日子', 732, 1860, { w: 1043 }),
    text('05-15', 268, 1982),
    text('回复', 591, 1982, { clickable: true }),
    text('2.3万', 1056, 1982, { w: 106 }),
    text('、Simple', 297, 2205),
    text('loading换thinking我是真没绷住', 561, 2286, { w: 702 }),
    text('05-15', 268, 2370),
    text('回复', 591, 2370, { clickable: true }),
    text('1.1万', 1056, 2370, { w: 106 }),
  ];
  const rows = parseCommentsWithLikes(nodes);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.likes), [3, 23_000, 11_000]);
  const top = topComments(rows, 2);
  assert.deepEqual(top.map((row) => row.likes), [23_000, 11_000]);
  assert.equal(top[0].author, 'sanshier');
});

test('爆款视频与热评落库：按点赞排、回复写回、统计正确', () => {
  const dir = mkdtempSync(join(tmpdir(), 'douyin-hot-'));
  const db = openDouyinDb(dir);
  try {
    const a = saveVideo(db, { title: '甲方又来了', author: '老头', likes: 288_000, likesText: '28.8万', keyword: '程序员' });
    saveVideo(db, { title: '小视频', author: '小明', likes: 12_000, likesText: '1.2万', keyword: '程序员' });
    const queued = videosForRound(db, 2);
    assert.equal(queued.length, 2);
    assert.equal(queued[0].id, a);
    const id = saveHotComment(db, { videoId: a, author: 'HTz', text: '搞软件的牛逼', likes: 3_000, likesText: '3000' });
    markHotCommentReplied(db, id, '那我可要学起来了');
    const stats = hotStats(db);
    assert.deepEqual(stats, { videos: 2, comments: 1, replied: 1 });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
