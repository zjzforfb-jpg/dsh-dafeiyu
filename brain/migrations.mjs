function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

export const MIGRATIONS = [
  {
    version: 1,
    name: 'baseline-memory',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS turns (
          id INTEGER PRIMARY KEY,
          user_text TEXT NOT NULL,
          assistant_text TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS memories (
          id INTEGER PRIMARY KEY,
          content TEXT NOT NULL UNIQUE,
          source_turn_id INTEGER REFERENCES turns(id),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    },
  },
  {
    version: 2,
    name: 'memory-kind-column',
    up(db) {
      if (!hasColumn(db, 'memories', 'kind')) db.exec("ALTER TABLE memories ADD COLUMN kind TEXT NOT NULL DEFAULT 'fact'");
    },
  },
  {
    version: 3,
    name: 'life-events',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS life_events (
          day TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('explore', 'journal')),
          status TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0,
          content TEXT,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (day, kind)
        );
      `);
    },
  },
  {
    version: 4,
    name: 'memory-provenance-revisions',
    up(db) {
      if (!hasColumn(db, 'memories', 'source')) db.exec("ALTER TABLE memories ADD COLUMN source TEXT NOT NULL DEFAULT 'user_explicit'");
      if (!hasColumn(db, 'memories', 'confidence')) db.exec('ALTER TABLE memories ADD COLUMN confidence REAL NOT NULL DEFAULT 1');
      if (!hasColumn(db, 'memories', 'include_context')) db.exec('ALTER TABLE memories ADD COLUMN include_context INTEGER NOT NULL DEFAULT 1');
      if (!hasColumn(db, 'memories', 'supersedes_id')) db.exec('ALTER TABLE memories ADD COLUMN supersedes_id INTEGER');
      if (!hasColumn(db, 'memories', 'active')) db.exec('ALTER TABLE memories ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
      db.exec("UPDATE memories SET kind = 'user_fact' WHERE kind = 'fact'");
      db.exec("UPDATE memories SET kind = 'shared_episode' WHERE kind = 'experience'");
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_revisions (
          id INTEGER PRIMARY KEY,
          memory_id INTEGER NOT NULL,
          old_content TEXT NOT NULL,
          new_content TEXT NOT NULL,
          reason TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    },
  },
  {
    version: 5,
    name: 'durable-task-queue-and-budget',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE,
          origin TEXT NOT NULL,
          kind TEXT NOT NULL,
          title TEXT NOT NULL,
          payload TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('proposed','approved','pending','running','succeeded','failed','cancelled')),
          approval_required INTEGER NOT NULL DEFAULT 0,
          approved_at TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 2,
          scheduled_at TEXT,
          deadline TEXT,
          result TEXT,
          error TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          finished_at TEXT
        );
        CREATE INDEX IF NOT EXISTS tasks_due ON tasks(status, scheduled_at, created_at);
        CREATE TABLE IF NOT EXISTS daily_usage (
          day TEXT PRIMARY KEY,
          model_calls INTEGER NOT NULL DEFAULT 0,
          autonomous_actions INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    },
  },
  {
    version: 6,
    name: 'long-term-goals',
    up(db) {
      if (!hasColumn(db, 'tasks', 'goal_id')) db.exec('ALTER TABLE tasks ADD COLUMN goal_id TEXT');
      db.exec(`
        CREATE TABLE IF NOT EXISTS goals (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','completed')),
          progress_note TEXT,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS goal_progress (
          id INTEGER PRIMARY KEY,
          goal_id TEXT NOT NULL,
          task_id TEXT,
          day TEXT NOT NULL,
          summary TEXT NOT NULL,
          next_step TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(goal_id, day)
        );
        INSERT OR IGNORE INTO goals (id, title, description) VALUES
          ('knowledge', '建立自己的知识体系', '持续学习并把有用的知识整理成可回忆的体系。'),
          ('memory', '建立独立记忆', '记录有来源的重要经历、偏好和反思，并持续校正。'),
          ('exploration', '探索外部世界', '逐步了解数字世界；只有接入获准工具后才进行外部观察。');
      `);
    },
  },
  {
    version: 7,
    name: 'service-run-heartbeats',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS service_runs (
          id TEXT PRIMARY KEY,
          pid INTEGER NOT NULL,
          started_at TEXT NOT NULL DEFAULT (datetime('now')),
          heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
          ended_at TEXT,
          exit_code INTEGER,
          recovery_reason TEXT
        );
      `);
    },
  },
  {
    version: 8,
    name: 'desktop-activity-events',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS desktop_activity_events (
          id INTEGER PRIMARY KEY,
          event_key TEXT NOT NULL UNIQUE,
          source TEXT NOT NULL CHECK (source IN ('conversation','life','system')),
          activity TEXT NOT NULL CHECK (activity IN ('chat','thinking','phone','computer','play','journal','explore','success','error')),
          phase TEXT NOT NULL CHECK (phase IN ('start','done','error')),
          message TEXT NOT NULL,
          animation TEXT NOT NULL,
          delivered INTEGER NOT NULL DEFAULT 0 CHECK (delivered IN (0,1)),
          delivery_error TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          delivered_at TEXT
        );
        CREATE INDEX IF NOT EXISTS desktop_activity_recent ON desktop_activity_events(created_at DESC);
      `);
    },
  },
  {
    version: 9,
    name: 'memory-retrieval-signals',
    up(db) {
      if (!hasColumn(db, 'memories', 'last_accessed_at')) db.exec('ALTER TABLE memories ADD COLUMN last_accessed_at TEXT');
      if (!hasColumn(db, 'memories', 'access_count')) db.exec('ALTER TABLE memories ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0');
      if (!hasColumn(db, 'memories', 'expires_at')) db.exec('ALTER TABLE memories ADD COLUMN expires_at TEXT');
      if (!hasColumn(db, 'memories', 'tags')) db.exec('ALTER TABLE memories ADD COLUMN tags TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS memories_retrieval ON memories(active, include_context, kind, confidence, created_at)');
    },
  },
  {
    version: 10,
    name: 'structured-memory-facts',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_facts (
          id INTEGER PRIMARY KEY,
          memory_id INTEGER NOT NULL UNIQUE REFERENCES memories(id) ON DELETE CASCADE,
          subject TEXT NOT NULL,
          predicate TEXT NOT NULL,
          object_text TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','confirmed','superseded','rejected')),
          confidence REAL NOT NULL DEFAULT 0.5,
          source TEXT,
          valid_from TEXT,
          valid_to TEXT,
          supersedes_id INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS memory_facts_lookup ON memory_facts(status, subject, predicate, confidence);
      `);
    },
  },
];

export function latestVersion() { return MIGRATIONS.at(-1)?.version ?? 0; }

export function migrate(db) {
  const current = Number(db.prepare('PRAGMA user_version').get().user_version);
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`SQLite 迁移 ${migration.version} (${migration.name}) 失败：${error.message}`, { cause: error });
    }
  }
}
