import { backup, DatabaseSync } from 'node:sqlite';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.umask(0o077);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const databasePath = join(root, 'runtime', 'dsh-home', 'dafeiyu-memory.sqlite');
const backupDir = join(root, 'runtime', 'backups');

function stamp(date = new Date()) {
  return date.toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

async function makeBackup(destination) {
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(databasePath);
  try { await backup(db, destination); }
  finally { db.close(); }
  chmodSync(destination, 0o600);
  const checkDb = new DatabaseSync(destination, { readOnly: true });
  try {
    if (Object.values(checkDb.prepare('PRAGMA integrity_check').get() ?? {})[0] !== 'ok') throw new Error('备份完整性检查失败。');
    return { path: destination, memoryCount: Number(checkDb.prepare('SELECT COUNT(*) AS n FROM memories').get().n) };
  } finally { checkDb.close(); }
}

async function restore(source) {
  const input = resolve(source);
  if (input === databasePath) throw new Error('恢复文件不能是当前数据库本身。');
  if (!existsSync(input)) throw new Error(`找不到恢复文件：${input}`);
  const candidate = new DatabaseSync(input, { readOnly: true });
  try {
    const check = candidate.prepare('PRAGMA integrity_check').get();
    if (Object.values(check ?? {})[0] !== 'ok') throw new Error('备份文件未通过 SQLite 完整性检查。');
    if (!candidate.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memories'").get()) throw new Error('备份文件没有 memories 表。');
  } finally { candidate.close(); }

  try {
    const response = await fetch('http://127.0.0.1:3110/health', { signal: AbortSignal.timeout(1200) });
    if (response.ok) throw new Error('大肥鱼服务仍在运行。先运行 npm run service:stop，再恢复。');
  } catch (error) {
    if (error.message.includes('服务仍在运行')) throw error;
  }

  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const suffix = stamp();
  const safety = join(backupDir, `before-restore-${suffix}.sqlite`);
  if (existsSync(databasePath)) await makeBackup(safety);
  const replacement = `${databasePath}.restore-${suffix}`;
  copyFileSync(input, replacement);
  chmodSync(replacement, 0o600);

  const sidecars = [`${databasePath}-wal`, `${databasePath}-shm`];
  const saved = [];
  try {
    if (existsSync(databasePath)) {
      const old = `${databasePath}.before-restore-${suffix}`;
      renameSync(databasePath, old);
      saved.push([old, databasePath]);
    }
    for (const sidecar of sidecars) {
      if (!existsSync(sidecar)) continue;
      const old = `${sidecar}.before-restore-${suffix}`;
      renameSync(sidecar, old);
      saved.push([old, sidecar]);
    }
    renameSync(replacement, databasePath);
  } catch (error) {
    rmSync(replacement, { force: true });
    for (const [old, original] of saved.reverse()) if (existsSync(old)) renameSync(old, original);
    throw error;
  }
  console.log(JSON.stringify({ restoredFrom: basename(input), safetyBackup: existsSync(safety) ? safety : null }));
}

const [command, source, confirmation] = process.argv.slice(2);
try {
  if (command === 'backup') {
    if (!existsSync(databasePath)) throw new Error('本地记忆库尚未创建。');
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const destination = join(backupDir, `dafeiyu-${stamp()}.sqlite`);
    const result = await makeBackup(destination);
    const keepIndex = process.argv.indexOf('--keep');
    const keep = keepIndex >= 0 ? Math.max(1, Number(process.argv[keepIndex + 1]) || 7) : 7;
    const backups = readdirSync(backupDir).filter((name) => /^dafeiyu-.*\.sqlite$/u.test(name))
      .map((name) => ({ path: join(backupDir, name), mtime: statSync(join(backupDir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const stale of backups.slice(keep)) rmSync(stale.path, { force: true });
    console.log(JSON.stringify({ backup: result.path, memoryCount: result.memoryCount, retained: Math.min(backups.length, keep) }));
  } else if (command === 'restore' && source && confirmation === '--confirm') {
    await restore(source);
  } else {
    console.error('用法：npm run data:backup；npm run data:restore -- <备份文件> --confirm');
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
