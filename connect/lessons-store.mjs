import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function legacyFileFor(file) {
  return basename(dirname(file)) === 'dsh-home'
    ? join(dirname(file), '..', 'douyin', 'lessons.json') : null;
}

function save(file, rows) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(rows.slice(-200), null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

function normalize(raw, defaultChannel) {
  const text = String(typeof raw === 'string' ? raw : raw?.text ?? '').trim();
  if (!text) return null;
  const channels = Array.isArray(raw?.channels)
    ? raw.channels.filter((channel) => channel === 'qq' || channel === 'douyin')
    : [defaultChannel];
  return {
    text, source: String(raw?.source ?? 'manual'), kind: String(raw?.kind ?? 'note'),
    tags: Array.isArray(raw?.tags) ? raw.tags.map(String) : [],
    channels: [...new Set(channels)], at: raw?.at ?? null,
  };
}

function rowsOf(data, defaultChannel) {
  const rows = Array.isArray(data) ? data : Array.isArray(data?.lessons) ? data.lessons : [];
  return rows.map((row) => normalize(row, defaultChannel)).filter(Boolean);
}

/** Canonical top-level array. The old Douyin object file is read during migration. */
export function readLessonRecords(file) {
  const canonical = readJson(file);
  const rows = rowsOf(canonical, Array.isArray(canonical) ? 'qq' : 'douyin');
  const legacy = legacyFileFor(file);
  if (legacy && existsSync(legacy)) rows.push(...rowsOf(readJson(legacy), 'douyin'));
  const merged = new Map();
  for (const row of rows) {
    const previous = merged.get(row.text);
    if (previous) previous.channels = [...new Set([...previous.channels, ...row.channels])];
    else merged.set(row.text, row);
  }
  return [...merged.values()].slice(-200);
}

/** Materialize the shared array and keep the legacy Douyin file as a backup. */
export function migrateLessonRecords(file) {
  const legacy = legacyFileFor(file);
  const old = readJson(file);
  if ((!legacy || !existsSync(legacy)) && (old === null || Array.isArray(old))) return readLessonRecords(file);
  const rows = readLessonRecords(file);
  save(file, rows);
  if (legacy && existsSync(legacy)) {
    const backup = `${legacy}.migrated${existsSync(`${legacy}.migrated`) ? `.${Date.now()}` : ''}`;
    renameSync(legacy, backup);
  }
  return rows;
}

export function appendLessonRecord(file, lesson) {
  const rows = readLessonRecords(file);
  const original = readJson(file);
  const canonicalRows = rowsOf(original, Array.isArray(original) ? 'qq' : 'douyin');
  const incoming = normalize(lesson, 'qq');
  if (!incoming) return { rows, changed: false };
  const existing = rows.find((row) => row.text === incoming.text);
  let changed = false;
  if (existing) {
    const channels = [...new Set([...existing.channels, ...incoming.channels])];
    changed = channels.length !== existing.channels.length;
    existing.channels = channels;
  } else {
    rows.push(incoming);
    changed = true;
  }
  if (changed || JSON.stringify(canonicalRows) !== JSON.stringify(rows)) {
    save(file, rows);
  }
  return { rows: rows.slice(-200), changed };
}

export function lessonTexts(file, channel, limit = 20) {
  return readLessonRecords(file).filter((row) => row.channels.includes(channel)).slice(-limit).map((row) => row.text);
}
