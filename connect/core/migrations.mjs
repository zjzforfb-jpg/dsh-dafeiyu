/**
 * 统一迁移机制（计划 A-8）。
 *
 * 目标：把散落在各模块里的 `PRAGMA table_info` 探测式 ALTER 收口到一处，
 * 让 CONNECT / DOUYIN 两个库也有和 `brain/migrations.mjs` 同形的版本化升级路径。
 *
 * 规则：
 * 1. 所有新增列的类型定义只登记一次（COLUMN_SPECS），模块不得自己写 ALTER 语句。
 * 2. 模块调用 `ensureColumn(db, table, column)` 幂等补列——表还不存在时跳过，
 *    因为表的归属模块会用完整 DDL 建表，列自然齐。
 * 3. `migrate(db, migrations)` 按 `PRAGMA user_version` 递增执行，每个迁移一个事务，
 *    失败自动 ROLLBACK 并抛出带版本号和名字的错误。
 * 4. 升级前可选地 `VACUUM INTO` 备份到 runtime/backups/。
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** 列定义登记表：`表名.列名` → ALTER 时追加的列类型片段。 */
export const COLUMN_SPECS = Object.freeze({
  // connect/tasks.mjs
  'external_tasks.evidence': 'TEXT',
  'external_tasks.origin': "TEXT NOT NULL DEFAULT 'qq'",
  'external_tasks.proposer_peer_id': 'TEXT',
  'external_tasks.approver_peer_id': 'TEXT',
  'external_tasks.idempotency_key': 'TEXT',
  'external_tasks.attempts': 'INTEGER NOT NULL DEFAULT 0',
  'external_tasks.expires_ms': 'INTEGER',
  // connect/working-state.mjs
  'working_tasks.plan_json': 'TEXT',
  'working_tasks.selected_strategy': 'TEXT',
  // connect/core/checkpoints.mjs：判定理由（nothing_to_do / count=0<1 / no_evidence …）
  'task_checkpoints.reason': 'TEXT',
  // connect/daily-memory.mjs
  'daily_memory_events.role': "TEXT NOT NULL DEFAULT 'user'",
  'daily_memory_events.content': 'TEXT',
  'daily_memory_events.key_info': 'TEXT',
  'daily_memory_events.message_id': 'TEXT',
  'daily_memory_events.dedupe_key': 'TEXT',
  // connect/qq/store.mjs
  'qq_messages.author': 'TEXT',
  'qq_peers.role': "TEXT NOT NULL DEFAULT 'friend'",
  // connect/voice/service.mjs
  'ilink_messages.input_kind': "TEXT NOT NULL DEFAULT 'text'",
  'ilink_messages.media_json': 'TEXT',
  'ilink_messages.transcript_source': 'TEXT',
  'ilink_messages.delivery_kind': "TEXT NOT NULL DEFAULT 'text'",
  'ilink_messages.audio_duration_ms': 'INTEGER',
  'ilink_messages.voice_confirmed': 'INTEGER NOT NULL DEFAULT 0',
  'ilink_messages.fallback_status': 'TEXT',
  'ilink_messages.fallback_outbound_id': 'TEXT',
  'ilink_usage.voice_requests': 'INTEGER NOT NULL DEFAULT 0',
  // connect/academy/study.mjs
  'study_sessions.step_key': 'TEXT',
  'study_sessions.output': 'TEXT',
  'study_sessions.score': 'REAL',
  'study_sessions.passed': 'INTEGER',
  'growth_archive.level': "TEXT DEFAULT 'understood'",
  // connect/douyin/store.mjs
  'comments.comment_epoch': 'INTEGER',
  'works.code': 'TEXT',
  'works.views': 'INTEGER',
  'works.likes': 'INTEGER',
  'works.favorites': 'INTEGER',
  'works.shares': 'INTEGER',
  'works.comments_stat': 'INTEGER',
  'works.stats_at': 'TEXT',
  'works.images': 'TEXT',
  'works.draft_file': 'TEXT',
  // connect/approvals.mjs
  'approvals.operations_json': "TEXT NOT NULL DEFAULT '[]'",
  'approvals.used_ms': 'INTEGER',
  // connect/agent-events.mjs（计划 A-4：trace_id 提升为独立列）
  'agent_events.trace_id': 'TEXT',
});

export function hasTable(db, table) {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table));
}

export function hasColumn(db, table, column) {
  if (!hasTable(db, table)) return false;
  // PRAGMA 不支持绑定参数，表名只能拼接——先卡一道只允许标识符字符。
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error(`非法表名 ${table}`);
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

/**
 * 幂等补列。列定义必须先登记在 COLUMN_SPECS。
 * @returns {boolean} true 表示这次真的执行了 ALTER。
 */
export function ensureColumn(db, table, column) {
  const spec = COLUMN_SPECS[`${table}.${column}`];
  if (!spec) throw new Error(`未登记的列定义 ${table}.${column}，请先加到 connect/core/migrations.mjs 的 COLUMN_SPECS`);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) throw new Error(`非法表名或列名 ${table}.${column}`);
  if (!hasTable(db, table)) return false;
  if (hasColumn(db, table, column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${spec}`);
  return true;
}

/** 批量补列，返回实际新增的列名数组。 */
export function ensureColumns(db, table, columns) {
  const added = [];
  for (const column of columns) if (ensureColumn(db, table, column)) added.push(column);
  return added;
}

/** 把库里某张表登记过的列全部补齐（供版本化迁移调用）。 */
export function ensureRegisteredColumns(db, table) {
  const columns = Object.keys(COLUMN_SPECS)
    .filter((key) => key.startsWith(`${table}.`))
    .map((key) => key.slice(table.length + 1));
  return ensureColumns(db, table, columns);
}

/** 迁移前备份：VACUUM INTO 到目标目录。返回备份路径，失败返回 null。 */
export function backupDatabase(db, dir, stamp = new Date().toISOString().replace(/[:.]/g, '-')) {
  try {
    mkdirSync(dir, { recursive: true });
    const target = join(dir, `backup-${stamp}.sqlite`);
    if (existsSync(target)) return target;
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    return target;
  } catch {
    return null;
  }
}

/**
 * 版本化迁移执行器：与 brain/migrations.mjs 同形。
 * @param {object} db SQLite 连接
 * @param {Array<{version:number,name:string,up:(db)=>void}>} migrations
 * @param {{backupDir?:string}} options
 */
export function migrate(db, migrations, options = {}) {
  const current = Number(db.prepare('PRAGMA user_version').get().user_version);
  const pending = migrations.filter((migration) => migration.version > current);
  if (!pending.length) return { from: current, to: current, applied: [], backup: null };

  let backup = null;
  if (options.backupDir) backup = backupDatabase(db, options.backupDir);

  const applied = [];
  for (const migration of pending) {
    db.exec('BEGIN IMMEDIATE');
    try {
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
      applied.push(migration.version);
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw new Error(`SQLite 迁移 ${migration.version} (${migration.name}) 失败：${error.message}`, { cause: error });
    }
  }
  return { from: current, to: pending.at(-1).version, applied, backup };
}

/** CONNECT 库（runtime/connect/connect.sqlite）的版本化迁移。 */
export const CONNECT_MIGRATIONS = [
  {
    version: 1,
    name: 'baseline-columns',
    up(db) {
      ensureRegisteredColumns(db, 'external_tasks');
      ensureRegisteredColumns(db, 'working_tasks');
      ensureRegisteredColumns(db, 'daily_memory_events');
      ensureRegisteredColumns(db, 'qq_messages');
      ensureRegisteredColumns(db, 'qq_peers');
      ensureRegisteredColumns(db, 'ilink_messages');
      ensureRegisteredColumns(db, 'ilink_usage');
      ensureRegisteredColumns(db, 'study_sessions');
      ensureRegisteredColumns(db, 'growth_archive');
      ensureRegisteredColumns(db, 'approvals');
    },
  },
  {
    version: 2,
    name: 'agent-events-trace-id',
    up(db) {
      ensureRegisteredColumns(db, 'agent_events');
      if (hasTable(db, 'agent_events')) db.exec('CREATE INDEX IF NOT EXISTS agent_events_trace ON agent_events(trace_id,created_at)');
    },
  },
  {
    version: 3,
    name: 'task-checkpoints-reason',
    up(db) {
      // 判定理由（nothing_to_do / count=0<1 / no_evidence…）：老库建表时还没有这一列
      ensureRegisteredColumns(db, 'task_checkpoints');
    },
  },
];

/** DOUYIN 库（runtime/douyin/douyin.db）的版本化迁移。 */
export const DOUYIN_MIGRATIONS = [
  {
    version: 1,
    name: 'baseline-columns',
    up(db) {
      ensureRegisteredColumns(db, 'works');
      ensureRegisteredColumns(db, 'comments');
    },
  },
];

export function migrateConnect(db, options = {}) {
  return migrate(db, CONNECT_MIGRATIONS, options);
}

export function migrateDouyin(db, options = {}) {
  return migrate(db, DOUYIN_MIGRATIONS, options);
}
