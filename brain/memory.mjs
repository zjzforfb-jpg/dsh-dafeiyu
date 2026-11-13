import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrate } from './migrations.mjs';

export function openMemory(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(dirname(path), 0o700);
  const db = new DatabaseSync(path);
  if (process.platform !== 'win32') chmodSync(path, 0o600);
  db.exec('PRAGMA journal_mode = WAL');
  migrate(db);
  return db;
}

export function memoryRecordFromUser(text) {
  const cleaned = text.trim();
  const experience = cleaned.match(/^(?:请)?(?:记住)?(?:这是)?我们的回忆[：:,，\s]*(.+)$/u);
  const fact = cleaned.match(/^(?:爸爸(?:想让你)?|我(?:想让你)?)?\s*(?:请)?记住[：:,，\s]*(.+)$/u);
  const content = (experience?.[1] ?? fact?.[1])?.trim();
  if (!content || content.length > 500) return null;
  if (/(?:密码|口令|验证码|短信码|动态码|api[ _-]?key|access[ _-]?token|secret|银行卡|身份证号)/iu.test(content)) return null;
  return { content, kind: experience ? 'experience' : 'fact' };
}

export function memoryFromUser(text) {
  return memoryRecordFromUser(text)?.content ?? null;
}

function terms(text) {
  const normalized = text.toLowerCase();
  const out = new Set(normalized.match(/[a-z0-9]{2,}/g) ?? []);
  const han = [...normalized.matchAll(/[\p{Script=Han}]/gu)].map(([char]) => char);
  for (let i = 0; i < han.length - 1; i += 1) out.add(han[i] + han[i + 1]);
  return out;
}

export function recall(db, question, limit = 5) {
  const rows = db.prepare('SELECT id, content, kind, created_at FROM memories ORDER BY id DESC LIMIT 200').all();
  const query = terms(question);
  const scored = rows.map((row) => {
    const overlap = [...terms(row.content)].filter((term) => query.has(term)).length;
    return { ...row, score: overlap };
  });
  scored.sort((a, b) => b.score - a.score || b.id - a.id);
  const relevant = scored.filter((row) => row.score > 0).slice(0, limit);
  if (relevant.length > 0) return relevant;
  if (/记得|记住|以前|之前|关于我/u.test(question)) return scored.slice(0, limit);
  return [];
}

export function capture(db, userText, assistantText) {
  const record = memoryRecordFromUser(userText);
  if (!record) return { turnId: null, remembered: null };
  const { content, kind } = record;
  const previous = db.prepare('SELECT source_turn_id FROM memories WHERE content = ?').get(content);
  if (previous) return { turnId: Number(previous.source_turn_id), remembered: content };
  const turn = db.prepare('INSERT INTO turns (user_text, assistant_text) VALUES (?, ?)').run(userText, assistantText);
  db.prepare('INSERT INTO memories (content, source_turn_id, kind) VALUES (?, ?, ?)').run(content, turn.lastInsertRowid, kind);
  return { turnId: Number(turn.lastInsertRowid), remembered: content };
}
