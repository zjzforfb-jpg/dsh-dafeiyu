import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EXPECT_AFTER, verifyAfter } from '../connect/live/verify-after.mjs';
import { SIDE_EFFECT_ACTIONS } from '../connect/live/expect-after.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'verify-after-'));
  mkdirSync(join(root, 'runtime', 'douyin'), { recursive: true });
  return root;
}

function makeWorksDb(root, rows = []) {
  const db = new DatabaseSync(join(root, 'runtime', 'douyin', 'douyin.db'));
  db.exec('CREATE TABLE works (id TEXT PRIMARY KEY, title TEXT, status TEXT, published_at TEXT, created_at TEXT)');
  for (const row of rows) db.prepare('INSERT INTO works (id,title,status,published_at,created_at) VALUES (?,?,?,?,?)')
    .run(row.id, row.title ?? '', row.status ?? 'published', row.published_at ?? new Date().toISOString(), row.created_at ?? '');
  return db;
}

test('「跑完应该看到什么」覆盖 7 个有副作用的动作，且都是人话', () => {
  const actions = ['qq.call', 'qq.call_mom', 'wechat.call', 'qq.hangup', 'douyin.publish', 'douyin.publish_draft', 'douyin.publish_video'];
  for (const action of actions) {
    const lines = EXPECT_AFTER[action];
    assert.ok(Array.isArray(lines) && lines.length >= 1, `${action} 缺验收句子`);
    for (const line of lines) assert.ok(line.length >= 8, `${action} 的句子太短：${line}`);
  }
  // 只读动作不该有
  assert.equal(EXPECT_AFTER['weather.get'], undefined);
});

test('发布类：作品表真的新增才算通过，没新增就是 fail', async () => {
  const root = makeRoot();
  const empty = await verifyAfter('douyin.publish', { root, probes: {} });
  assert.equal(empty.verdict, 'fail');
  assert.match(empty.checks[0].detail, /没有新增/u);

  const db = makeWorksDb(root, [{ id: 'w1', title: '新作品', published_at: new Date().toISOString() }]);
  db.close();
  const done = await verifyAfter('douyin.publish', { root, probes: {} });
  assert.equal(done.verdict, 'pass');
  assert.match(done.checks[0].detail, /新作品/u);
});

test('待审草稿：pending.json 没了才算发出去', async () => {
  const root = makeRoot();
  const pending = join(root, 'runtime', 'douyin', 'pending.json');
  writeFileSync(pending, JSON.stringify({ status: 'draft' }));
  const db = makeWorksDb(root, [{ id: 'w1', title: '发了', published_at: new Date().toISOString() }]);
  db.close();

  const still = await verifyAfter('douyin.publish_draft', { root, probes: {} });
  assert.equal(still.verdict, 'fail');
  assert.ok(still.checks.some((c) => c.key === 'pending' && c.ok === false));

  const { rmSync } = await import('node:fs');
  rmSync(pending);
  const gone = await verifyAfter('douyin.publish_draft', { root, probes: {} });
  assert.equal(gone.verdict, 'pass');
});

test('通话类：没有 call_ended 是「不知道」，不是失败', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE agent_events (id INTEGER PRIMARY KEY, event_type TEXT, created_at TEXT, payload TEXT)");
  const none = await verifyAfter('qq.call', { db, probes: { qqCallWindow: async () => ({ ok: false, detail: '没有进行中的通话' }) } });
  assert.equal(none.verdict, 'unknown', '没接通不等于失败');

  db.prepare('INSERT INTO agent_events (event_type, created_at, payload) VALUES (?,?,?)')
    .run('call_ended', new Date().toISOString(), JSON.stringify({ outcome: 'ended', durationMs: 42_000 }));
  const yes = await verifyAfter('qq.call', { db, probes: {} });
  assert.equal(yes.verdict, 'pass');
  assert.match(yes.checks[0].detail, /ended/u);
  db.close();
});

test('没有副作用定义的动作返回 unknown，并说明原因', async () => {
  const root = makeRoot();
  const result = await verifyAfter('weather.get', { root, probes: {} });
  assert.equal(result.verdict, 'unknown');
  assert.equal(result.checks.length, 0);
  assert.match(result.reason, /没有跑后检查/u);
});

test('工具清单把验收句子和「跑完核对」接口都暴露出来', async () => {
  const { readFileSync } = await import('node:fs');
  const api = readFileSync(join(ROOT, 'connect/live/api.mjs'), 'utf8');
  assert.match(api, /expect: expectOf\(item\.action\)/u);
  const server = readFileSync(join(ROOT, 'connect/server.mjs'), 'utf8');
  assert.match(server, /path === '\/api\/live\/verify'/u);
  assert.match(server, /verifyAfter\(action/u);
  const js = readFileSync(join(ROOT, 'connect/live/live.js'), 'utf8');
  assert.match(js, /跑完应该看到什么/u);
  assert.match(js, /\/api\/live\/verify\?action=/u);
});

test('每个「有副作用」的动作都有一张第一次真跑的操作单', async () => {
  const { readFileSync } = await import('node:fs');
  const doc = readFileSync(new URL('../docs/FIRST-RUN.md', import.meta.url), 'utf8');
  const actions = SIDE_EFFECT_ACTIONS;
  assert.equal(actions.length, 7, '有外部副作用的动作恰好 7 个');

  for (const action of actions) {
    assert.ok(doc.includes(`\`${action}\``), `操作单里没有 ${action}`);
  }
  // 每张单子都要有「前置 / 跑完应该看到 / 三种收场」这三段，缺一段就等于没写
  assert.match(doc, /跑前/g);
  assert.ok((doc.match(/\*\*跑完应该看到\*\*/gu) ?? []).length >= actions.length, '每张单子都要写「跑完应该看到」');
  assert.ok((doc.match(/\*\*收场\*\*/gu) ?? []).length >= 4, '收场要分开写清楚');
  // 命名的命令必须真实存在，别写成想象中的脚本
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const root = new URL('..', import.meta.url).pathname;
  for (const script of ['qq-call.mjs', 'wechat-call.mjs', 'douyin-confirm.mjs', 'douyin-post.mjs', 'douyin-video.mjs']) {
    assert.ok(existsSync(join(root, 'scripts', script)), `操作单引用了不存在的脚本：${script}`);
    assert.ok(doc.includes(`scripts/${script}`), `操作单里没提 ${script}`);
  }
});
