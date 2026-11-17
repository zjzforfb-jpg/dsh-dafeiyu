import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDouyinDb, saveWork, saveComment, markReplied, listComments, listWorks,
  contentSummary, classifyComment, pickCuteReply, parseRelativeTime, bindOrphans, publishDraft,
} from '../connect/douyin/store.mjs';

test('作品和评论按 work_id 关联，能按时间/按作品排序', () => {
  const root = mkdtempSync(join(tmpdir(), 'dy-store-'));
  const db = openDouyinDb(root);
  const workId = saveWork(db, {
    id: 'dy-test1', title: '测试标题', caption: '测试正文', topics: '#大肥鱼', publishedAt: '2026-11-15T02:00:00.000Z',
  });
  assert.equal(workId, 'dy-test1');
  saveComment(db, { workId, author: '小明', text: '好可爱呀', kind: 'text', commentAt: '昨天 10:00' });
  saveComment(db, { workId, author: '小红', text: '🐟', kind: 'emoji', commentAt: '11小时前' });
  saveComment(db, { workId: '', author: '路人', text: '路过看看', kind: 'text', commentAt: '3分钟前' });

  const byTime = listComments(db, { order: 'time' });
  assert.equal(byTime.length, 3);
  assert.equal(byTime[0].author, '路人');
  assert.equal(byTime[1].author, '小红');

  const byWork = listComments(db, { workId, order: 'work' });
  assert.equal(byWork.length, 2);
  assert.deepEqual(byWork.map((row) => row.author), ['小红', '小明']);

  const works = listWorks(db);
  assert.equal(works.length, 1);
  assert.equal(works[0].comments, 2);
  assert.equal(contentSummary(db).comments, 3);
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('回复写回同一条评论，不新增行', () => {
  const root = mkdtempSync(join(tmpdir(), 'dy-store-'));
  const db = openDouyinDb(root);
  saveComment(db, { workId: 'w1', author: '小明', text: '在吗', kind: 'text' });
  markReplied(db, { workId: 'w1', author: '小明', text: '在吗', reply: '在的呀', at: '2026-11-15T03:00:00.000Z' });
  const rows = listComments(db, { workId: 'w1' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reply_text, '在的呀');
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('评论分类：纯表情/只有图/一两个字都算「没什么可回」', () => {
  assert.deepEqual(classifyComment('🐟🐟🐟'), { kind: 'emoji', meaningful: false });
  assert.deepEqual(classifyComment('@'), { kind: 'emoji', meaningful: false });
  assert.deepEqual(classifyComment(''), { kind: 'image', meaningful: false });
  assert.equal(classifyComment('你好啊大鱼鱼').meaningful, true);
  assert.equal(classifyComment('可不可以和我的鱼交个朋友@肥鱼').meaningful, true);
  for (let i = 0; i < 20; i += 1) {
    const reply = pickCuteReply(() => i / 20);
    assert.ok(reply.length > 0 && reply.length <= 4, `表情回复要短：${reply}`);
  }
});

test('相对时间能换算成可排序的时间戳', () => {
  const now = new Date('2026-11-15T03:00:00Z').getTime();
  assert.equal(parseRelativeTime('刚刚', now), now);
  assert.equal(parseRelativeTime('2小时前', now), now - 2 * 3600_000);
  assert.equal(parseRelativeTime('10小时前', now), now - 10 * 3600_000);
  assert.equal(parseRelativeTime('昨天 21:49', now) !== null, true);
});

test('通知列表里抓到的评论，能并回已知作品', () => {
  const root = mkdtempSync(join(tmpdir(), 'dy-store-'));
  const db = openDouyinDb(root);
  saveComment(db, { workId: 'w1', author: 'LP0423', text: '[宕机][宕机]...' });
  saveComment(db, { workId: '', author: 'LP0423', text: '[宕机][宕机]', commentAt: '10小时前' });
  const bound = bindOrphans(db);
  assert.equal(bound, 1);
  assert.equal(contentSummary(db).comments, 1);
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('草稿作品先入库不占编号，发布时才补 DFY 编号', () => {
  const root = mkdtempSync(join(tmpdir(), 'dy-store-'));
  const db = openDouyinDb(root);
  saveWork(db, { id: 'draft:1', title: '草稿一', caption: '草稿正文', topics: '#大肥鱼', status: 'draft' });
  saveWork(db, { id: 'draft:2', title: '草稿二', caption: '草稿正文', topics: '#大肥鱼', status: 'draft' });
  const drafts = db.prepare("SELECT id, code, status FROM works WHERE status='draft' ORDER BY id").all();
  assert.equal(drafts.length, 2);
  assert.equal(drafts[0].code, null);
  assert.equal(drafts[1].code, null);

  const first = publishDraft(db, 'draft:1', { publishedAt: '2026-11-15T03:00:00.000Z' });
  assert.equal(first.id, 'draft:1');
  assert.equal(first.code, 'DFY-0001');
  const second = publishDraft(db, 'draft:2', { status: 'published_unverified' });
  assert.equal(second.code, 'DFY-0002');
  const rows = db.prepare("SELECT id, code, status FROM works ORDER BY code").all();
  assert.deepEqual(rows.map((r) => r.code), ['DFY-0001', 'DFY-0002']);
  assert.equal(rows[1].status, 'published_unverified');
  assert.equal(publishDraft(db, 'missing', {}), null);
  db.close();
  rmSync(root, { recursive: true, force: true });
});
