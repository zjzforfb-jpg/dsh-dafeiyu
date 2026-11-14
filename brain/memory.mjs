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
  const preference = cleaned.match(/^(?:请)?(?:你要)?(?:记住|記住|记下|記下)[：:,，\s]*(?:你)?(?:最)?喜欢(?:的)?[：:,，\s]*(.+)$/u);
  const fact = cleaned.match(/^(?:爸爸(?:想让你)?|我(?:想让你)?)?\s*(?:请)?(?:记住|記住|记下|記下)[：:,，\s]*(.+)$/u);
  const rawContent = (experience?.[1] ?? preference?.[1] ?? fact?.[1])?.trim();
  const content = preference && rawContent ? `大肥鱼喜欢${rawContent}` : rawContent;
  if (!content || content.length > 500) return null;
  if (/(?:密码|口令|验证码|短信码|动态码|api[ _-]?key|access[ _-]?token|secret|银行卡|身份证号)/iu.test(content)) return null;
  return { content, kind: experience ? 'shared_episode' : preference ? 'pet_preference' : 'user_fact', source: 'user_explicit', confidence: 1 };
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
  const rows = db.prepare('SELECT id, content, kind, source, confidence, created_at FROM memories WHERE active = 1 AND include_context = 1 ORDER BY id DESC LIMIT 300').all();
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

export function capture(db, userText, assistantText, provenance = {}) {
  const record = memoryRecordFromUser(userText);
  if (!record) return { turnId: null, remembered: null };
  const { content, kind } = record;
  const previous = db.prepare('SELECT source_turn_id FROM memories WHERE content = ?').get(content);
  if (previous) return { turnId: Number(previous.source_turn_id), remembered: content };
  const turn = db.prepare('INSERT INTO turns (user_text, assistant_text) VALUES (?, ?)').run(userText, assistantText);
  db.prepare('INSERT INTO memories (content, source_turn_id, kind, source, confidence) VALUES (?, ?, ?, ?, ?)').run(content, turn.lastInsertRowid, kind, provenance.source ?? record.source, provenance.confidence ?? record.confidence);
  return { turnId: Number(turn.lastInsertRowid), remembered: content };
}

export function reviseMemory(db, id, nextContent, reason = '用户明确纠正') {
  const content = String(nextContent ?? '').trim();
  if (!Number.isInteger(Number(id)) || Number(id) < 1) throw new Error('记忆编号无效');
  if (!content || content.length > 500) throw new Error('新记忆不能为空且不能超过 500 字');
  if (/(?:密码|口令|验证码|短信码|动态码|api[ _-]?key|access[ _-]?token|secret|银行卡|身份证号)/iu.test(content)) throw new Error('新内容看起来包含敏感信息，未保存');
  const old = db.prepare('SELECT content, kind FROM memories WHERE id = ? AND active = 1').get(Number(id));
  if (!old) throw new Error(`没有可修改的活跃记忆 ${id}`);
  if (old.content === content) return { id: Number(id), changed: false };
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO memory_revisions (memory_id, old_content, new_content, reason) VALUES (?, ?, ?, ?)').run(Number(id), old.content, content, reason);
    db.prepare("UPDATE memories SET content = ?, source = 'user_correction', confidence = 1, include_context = 1 WHERE id = ?").run(content, Number(id));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { id: Number(id), changed: true };
}

export function forgetMemory(db, id) {
  const memory = db.prepare('SELECT source_turn_id FROM memories WHERE id = ?').get(Number(id));
  if (!memory) return false;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM memory_revisions WHERE memory_id = ?').run(Number(id));
    db.prepare('DELETE FROM memories WHERE id = ?').run(Number(id));
    if (memory.source_turn_id) db.prepare('DELETE FROM turns WHERE id = ?').run(memory.source_turn_id);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return true;
}
