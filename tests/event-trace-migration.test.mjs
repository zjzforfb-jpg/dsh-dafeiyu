// 计划 A-4（trace_id 提升为列 + channel 词表收敛 + 事件单一真源）与
// 计划 A-8（CONNECT / DOUYIN 统一版本化迁移）的回归。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHANNELS, initAgentEvents, listAgentEvents, normalizeChannel, recordAgentEvent } from '../connect/agent-events.mjs';
import { openEventStore } from '../connect/core/event-store.mjs';
import {
  COLUMN_SPECS, CONNECT_MIGRATIONS, DOUYIN_MIGRATIONS, ensureColumn, ensureColumns, hasColumn, hasTable, migrate, migrateConnect, migrateDouyin,
} from '../connect/core/migrations.mjs';

test('trace_id 是真列而不是 payload 里的一段 JSON', () => {
  const db = new DatabaseSync(':memory:');
  initAgentEvents(db);
  assert.equal(hasColumn(db, 'agent_events', 'trace_id'), true);
  recordAgentEvent(db, { eventType: 'message_received', channel: 'qq', traceId: 'trace-abc', payload: { trace_id: 'trace-abc' } });
  recordAgentEvent(db, { eventType: 'message_replied', channel: 'qq', traceId: 'trace-abc' });
  recordAgentEvent(db, { eventType: 'message_received', channel: 'qq', traceId: 'trace-xyz' });
  const rows = listAgentEvents(db, { traceId: 'trace-abc' });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.trace_id === 'trace-abc'));
  assert.equal(listAgentEvents(db, { traceId: 'trace-none' }).length, 0);
  db.close();
});

test('channel 词表只有一份，别名收敛到统一取值', () => {
  assert.deepEqual([...CHANNELS], ['desktop', 'qq', 'wechat', 'android', 'douyin', 'call', 'system']);
  assert.equal(normalizeChannel('ilink'), 'wechat');
  // D-3：call 是一等渠道，不再并进 system（否则通话事件查不到 channel='call'）。
  assert.equal(normalizeChannel('call'), 'call');
  assert.equal(normalizeChannel('board'), 'system');
  assert.equal(normalizeChannel('vision'), 'android');
  assert.equal(normalizeChannel('QQ'), 'qq');
  assert.equal(normalizeChannel('不知道是啥'), 'system');
  assert.equal(normalizeChannel(undefined), 'system');
  // 同一条微信消息在两个库里曾经分别记成 'wechat' 和 'ilink'，现在必须一致。
  assert.equal(normalizeChannel('wechat'), normalizeChannel('ilink'));
});

test('事件写入时 channel 落库就是收敛后的值', () => {
  const db = new DatabaseSync(':memory:');
  initAgentEvents(db);
  recordAgentEvent(db, { eventType: 'message_received', channel: 'ilink', conversationId: 'peer-1' });
  recordAgentEvent(db, { eventType: 'message_received', channel: 'call', conversationId: 'peer-2' });
  const rows = listAgentEvents(db, { limit: 10 });
  assert.deepEqual(rows.map((row) => row.channel).sort(), ['call', 'wechat']);
  assert.equal(listAgentEvents(db, { channel: 'wechat' }).length, 1);
  assert.equal(listAgentEvents(db, { channel: 'call' }).length, 1);
  db.close();
});

test('未登记的列定义会报错，防止各模块自己写 ALTER', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE demo(id INTEGER PRIMARY KEY)');
  assert.throws(() => ensureColumn(db, 'demo', 'unknown_col'), /未登记的列定义 demo\.unknown_col/);
  assert.throws(() => ensureColumn(db, 'demo', 'x; DROP TABLE demo'), /未登记的列定义/);
  db.close();
});

test('补列幂等：表不存在时跳过，已存在时不动', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE qq_peers(peer_id TEXT PRIMARY KEY, label TEXT)');
  assert.equal(ensureColumn(db, 'qq_peers', 'role'), true);
  assert.equal(ensureColumn(db, 'qq_peers', 'role'), false);
  assert.deepEqual(ensureColumns(db, 'qq_peers', ['role']), []);
  assert.equal(hasColumn(db, 'qq_peers', 'role'), true);
  assert.equal(ensureColumn(db, 'external_tasks', 'evidence'), false); // 表还没建，跳过
  db.close();
});

test('迁移失败会回滚并抛出带版本号和名字的错误', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY)');
  const bad = [{ version: 1, name: 'ok-one', up() { db.exec("INSERT INTO t(id) VALUES(1)"); } },
    { version: 2, name: 'boom', up() { db.exec("INSERT INTO t(id) VALUES(2)"); throw new Error('故意失败'); } }];
  assert.throws(() => migrate(db, bad), /SQLite 迁移 2 \(boom\) 失败：故意失败/);
  // 每个迁移一个事务：v1 已提交所以留下，v2 失败的那一步要回滚掉自己的写入。
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM t').get().n, 1);
  assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), 1);
  db.close();
});

test('迁移重复执行不会重复改动库', () => {
  const db = new DatabaseSync(':memory:');
  const migrations = [{ version: 1, name: 'add-col', up(db) { ensureColumn(db, 'qq_peers', 'role'); } }];
  db.exec('CREATE TABLE qq_peers(peer_id TEXT PRIMARY KEY)');
  const first = migrate(db, migrations);
  assert.deepEqual(first.applied, [1]);
  assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), 1);
  const second = migrate(db, migrations);
  assert.deepEqual(second.applied, []);
  assert.equal(second.from, 1);
  db.close();
});

test('CONNECT 迁移补齐登记过的列并给 agent_events 建 trace 索引', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE qq_peers(peer_id TEXT PRIMARY KEY);
    CREATE TABLE agent_events(id TEXT PRIMARY KEY, event_type TEXT, channel TEXT, created_at TEXT);`);
  const result = migrateConnect(db);
  assert.deepEqual(result.applied, [1, 2, 3]);
  assert.equal(hasColumn(db, 'qq_peers', 'role'), true);
  assert.equal(hasColumn(db, 'agent_events', 'trace_id'), true);
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agent_events'").all().map((row) => row.name);
  assert.ok(indexes.includes('agent_events_trace'));
  db.close();
});

test('DOUYIN 迁移补齐作品与评论的统计列', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE works(task_id TEXT PRIMARY KEY, title TEXT); CREATE TABLE comments(work_id TEXT, author TEXT);');
  const result = migrateDouyin(db);
  assert.deepEqual(result.applied, [1]);
  assert.equal(hasColumn(db, 'works', 'views'), true);
  assert.equal(hasColumn(db, 'comments', 'comment_epoch'), true);
  db.close();
});

test('迁移表清单覆盖所有已登记的列定义', () => {
  // 防止有人加了 COLUMN_SPECS 却忘了写进某个库的迁移清单。
  const covered = new Set();
  for (const migration of [...CONNECT_MIGRATIONS, ...DOUYIN_MIGRATIONS]) {
    const source = migration.up.toString();
    for (const key of Object.keys(COLUMN_SPECS)) {
      const [table] = key.split('.');
      if (source.includes(`'${table}'`)) covered.add(key);
    }
  }
  const missing = Object.keys(COLUMN_SPECS).filter((key) => !covered.has(key));
  assert.deepEqual(missing, [], `这些列没有出现在任何迁移里：${missing.join(', ')}`);
});

test('事件库打开在 runtime/connect 下并且带 trace_id 列', () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'dafeiyu-eventstore-'));
  try {
    const db = openEventStore(runtimeRoot);
    assert.equal(hasTable(db, 'agent_events'), true);
    assert.equal(hasColumn(db, 'agent_events', 'trace_id'), true);
    recordAgentEvent(db, { eventType: 'observation_created', channel: 'desktop', traceId: 't1' });
    assert.equal(listAgentEvents(db, { traceId: 't1' }).length, 1);
    db.close();
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
