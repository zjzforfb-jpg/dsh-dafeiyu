#!/usr/bin/env node
import { backup, DatabaseSync } from 'node:sqlite';
import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.umask(0o077);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
const snapshotDir = join(root, 'runtime', 'backups', `unified-${stamp}`);
const stores = [
  { name: 'memory', source: join(root, 'runtime', 'dsh-home', 'dafeiyu-memory.sqlite'), required: 'memories' },
  { name: 'connect', source: join(root, 'runtime', 'connect', 'connect.sqlite'), required: 'external_tasks' },
  { name: 'douyin', source: join(root, 'runtime', 'douyin', 'douyin.db'), required: 'works' },
];

function inspect(file, required) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (Object.values(db.prepare('PRAGMA integrity_check').get() ?? {})[0] !== 'ok') {
      throw new Error(`integrity_check_failed:${file}`);
    }
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(required)) {
      throw new Error(`required_table_missing:${required}`);
    }
    return {
      user_version: Number(db.prepare('PRAGMA user_version').get().user_version),
      required_rows: Number(db.prepare(`SELECT COUNT(*) AS count FROM ${required}`).get().count),
    };
  } finally {
    db.close();
  }
}

try {
  mkdirSync(snapshotDir, { recursive: true, mode: 0o700 });
  const manifest = { created_at: new Date().toISOString(), stores: [] };
  for (const store of stores) {
    const source = new DatabaseSync(store.source, { readOnly: true });
    const destination = join(snapshotDir, `${store.name}.sqlite`);
    try {
      await backup(source, destination);
    } finally {
      source.close();
    }
    chmodSync(destination, 0o600);
    const original = inspect(destination, store.required);
    const drill = join(snapshotDir, `${store.name}.restore-check.sqlite`);
    try {
      copyFileSync(destination, drill);
      const restored = inspect(drill, store.required);
      if (JSON.stringify(restored) !== JSON.stringify(original)) throw new Error(`restore_check_failed:${store.name}`);
    } finally {
      rmSync(drill, { force: true });
    }
    manifest.stores.push({ name: store.name, file: `${store.name}.sqlite`, ...original });
  }
  writeFileSync(join(snapshotDir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  process.stdout.write(JSON.stringify({ snapshotDir, stores: manifest.stores }) + '\n');
} catch (error) {
  rmSync(snapshotDir, { recursive: true, force: true });
  console.error(error.message);
  process.exitCode = 1;
}
