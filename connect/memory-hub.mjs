/**
 * 大肥鱼的统一长期记忆：
 * - 桌面桌宠、QQ、微信、抖音共用 runtime/dsh-home/dafeiyu-memory.sqlite
 * - 「今天干了什么」靠 kind='activity' 的自述活动记录回答
 */
import { join } from 'node:path';
import { openMemory, capture } from '../brain/memory.mjs';
import { initDailyMemory } from './daily-memory.mjs';
import { runtimeDir } from './core/paths.mjs';

export function openHub(root) {
  // 同 openDouyinDb：root 可能是 <repo>/runtime/connect，必须归一到仓库根再找 runtime/dsh-home
  const db=openMemory(join(runtimeDir(root), 'dsh-home', 'dafeiyu-memory.sqlite'));initDailyMemory(db);return db;
}

/** 记一条「我做了什么」：power 活动日志，供回忆与「今天干了什么」使用。 */
export function recordActivity(db, text, { channel = 'self', at = new Date() } = {}) {
  const content = String(text).trim().slice(0, 200);
  if (!content) return null;
  const stamp = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(at);
  const line = `【活动·${stamp}】${content}`;
  const exists = db.prepare('SELECT id FROM memories WHERE content = ?').get(line);
  if (exists) return { id: Number(exists.id), content: line };
  const row = db.prepare('INSERT INTO memories (content, kind, source, confidence, include_context) VALUES (?, ?, ?, ?, 1)')
    .run(line, 'activity', `self:${channel}`, 1);
  return { id: Number(row.lastInsertRowid), content: line };
}

/** 把一次对话写进统一记忆（QQ/微信都走这里，保证「爸爸妈妈的记忆」合并）。 */
export function captureExchange(db, userText, replyText, { source = 'chat' } = {}) {
  return capture(db, userText, replyText, { source, confidence: 0.8 });
}

/** 今天的活动摘要，直接塞进提示词。scope 过滤：群聊的活动不该进主人私聊的提示词（R-05/R-07）。 */
export function todayDigest(db, { now = new Date(), limit = 12, scope = 'private' } = {}) {
  const stamp = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(now);
  const rows = db.prepare("SELECT id, content FROM memories WHERE kind = 'activity' AND active = 1 AND (COALESCE(scope,'private') = ? OR scope = 'public') AND content LIKE ? ORDER BY id DESC LIMIT ?")
    .all(scope, `【活动·${stamp}】%`, limit);
  if (!rows.length) return '';
  return rows.reverse().map((row) => row.content.replace(/^【活动·[^】]+】/u, '· ')).join('\n');
}

/** 回忆时优先补上今天做过的事。 */
export function notesWithActivities(db, question, limit = 8, { scope = 'private' } = {}) {
  const notes = [];
  const asksToday = /今天|今日|刚才|刚刚|干了什么|做了什么|忙了啥/u.test(String(question ?? ''));
  if (asksToday) {
    const digest = todayDigest(db, { scope });
    if (digest) notes.push({ id: 0, content: `我今天做过这些事：\n${digest}`, kind: 'activity_digest' });
  }
  return notes;
}
