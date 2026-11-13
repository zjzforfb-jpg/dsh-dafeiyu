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
