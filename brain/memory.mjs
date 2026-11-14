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
  const normalized = String(text ?? '').toLowerCase();
  const out = new Set(normalized.match(/[a-z0-9]{2,}/g) ?? []);
  const han = [...normalized.matchAll(/[\p{Script=Han}]/gu)].map(([char]) => char);
  for (let i = 0; i < han.length - 1; i += 1) out.add(han[i] + han[i + 1]);
  return out;
}

function recency(createdAt) {
  const time = Date.parse(String(createdAt ?? '').replace(' ', 'T') + (String(createdAt).includes('Z') ? '' : 'Z'));
  if (!Number.isFinite(time)) return 0.5;
  const ageDays = Math.max(0, (Date.now() - time) / 86_400_000);
  return Math.exp(-ageDays / 180);
}

/**
 * 可解释的混合召回：关键词相关性 + 语义短语命中 + 可信度 + 时间衰减。
 * 保留旧的 recall(db, question, limit) 调用形式，同时支持结构化过滤。
 */
export function recall(db, question, limit = 5, options = {}) {
  if (typeof limit === 'object') { options = limit; limit = options.limit ?? 5; }
  const safeLimit = Math.max(1, Math.min(30, Number(limit) || 5));
  if (!String(question ?? '').trim()) return [];
  const rows = db.prepare(`SELECT id, content, kind, source, confidence, created_at, last_accessed_at, access_count
    FROM memories WHERE active = 1 AND include_context = 1
    AND (expires_at IS NULL OR expires_at > datetime('now'))
    ${options.kind ? 'AND kind = ?' : ''}
    ORDER BY id DESC LIMIT 1000`).all(...(options.kind ? [String(options.kind)] : []));
  const query = terms(question);
  const phrase = String(question ?? '').trim().toLowerCase();
  const scored = rows.map((row) => {
    const rowTerms = terms(row.content);
    const overlap = [...rowTerms].filter((term) => query.has(term)).length;
    const coverage = query.size ? overlap / query.size : 0;
    const exactPhrase = phrase.length >= 4 && String(row.content).toLowerCase().includes(phrase) ? 1 : 0;
    const confidence = Math.max(0, Math.min(1, Number(row.confidence) || 0));
    const freshness = recency(row.created_at);
    const score = exactPhrase * 4 + overlap * 1.5 + coverage * 2 + confidence * 1.5 + freshness * 0.35;
    return { ...row, score, match: { exactPhrase, overlap, coverage, confidence, freshness } };
  });
  scored.sort((a, b) => b.score - a.score || b.id - a.id);
  const relevant = scored.filter((row) => row.score > 0).slice(0, limit);
  if (/今天|今日|刚才|刚刚|干了什么|做了什么|忙了啥/u.test(question)) {
    const stamp = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
    const activities = db.prepare("SELECT id, content, kind, source, confidence, created_at FROM memories WHERE kind = 'activity' AND active = 1 AND content LIKE ? ORDER BY id DESC LIMIT 8")
      .all(`【活动·${stamp}】%`).reverse();
    if (activities.length) return [...activities, ...relevant].slice(0, activities.length + safeLimit);
  }
  const result = relevant.length > 0 ? relevant : (/记得|记住|以前|之前|关于我/u.test(String(question)) ? scored.slice(0, safeLimit) : []);
  if (result.length) {
    const ids = result.map((row) => row.id);
    const marks = ids.map(() => '?').join(',');
    db.prepare(`UPDATE memories SET access_count = COALESCE(access_count, 0) + 1, last_accessed_at = datetime('now') WHERE id IN (${marks})`).run(...ids);
  }
  return result;
}

export function capture(db, userText, assistantText, provenance = {}) {
  const record = memoryRecordFromUser(userText);
  if (!record) return { turnId: null, remembered: null };
  const { content, kind } = record;
  const previous = db.prepare('SELECT source_turn_id FROM memories WHERE content = ?').get(content);
  if (previous) return { turnId: Number(previous.source_turn_id), remembered: content };
  const turn = db.prepare('INSERT INTO turns (user_text, assistant_text) VALUES (?, ?)').run(userText, assistantText);
  const source = provenance.source ?? record.source;
  const confidence = provenance.confidence ?? record.confidence;
  const inserted = db.prepare('INSERT INTO memories (content, source_turn_id, kind, source, confidence) VALUES (?, ?, ?, ?, ?)').run(content, turn.lastInsertRowid, kind, source, confidence);
  const memoryId = Number(inserted.lastInsertRowid);
  if (['user_fact', 'pet_preference', 'shared_episode'].includes(kind)) {
    const subject = kind === 'pet_preference' ? 'pet' : 'owner';
    const predicate = kind === 'pet_preference' ? 'preference' : kind === 'shared_episode' ? 'shared_episode' : 'fact';
    db.prepare(`INSERT OR IGNORE INTO memory_facts
      (memory_id, subject, predicate, object_text, status, confidence, source)
      VALUES (?, ?, ?, ?, 'confirmed', ?, ?)`).run(memoryId, subject, predicate, content, confidence, source);
  }
  return { turnId: Number(turn.lastInsertRowid), remembered: content, memoryId };
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
    db.prepare("UPDATE memory_facts SET object_text = ?, confidence = 1, source = 'user_correction', updated_at = datetime('now') WHERE memory_id = ?").run(content, Number(id));
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
