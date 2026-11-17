// M3 / C4：把「反复失败的类别」蒸馏成经验，喂回规划器。
//
// lessons 以前只有手写的 7 条（connect/qq/lessons.mjs 的 LESSONS 常量）。
// 现在多一个来源：学习账本里 occurrences 够高的动作失败，自动写成一句可执行的提醒。
// 只写一句话、不带任务号，避免把 prompt 撑大，也避免把隐私搬进去。
import { join } from 'node:path';
import { appendLessonRecord } from '../lessons-store.mjs';
import { labelForCategory } from './reflect.mjs';

const PATTERN = /^action:failure:(.+):(.+)$/u;

export function lessonsFileOf(home) {
  return join(home, 'lessons.json');
}

/** 把攒够次数的失败类别写成经验；同文只留一条（appendLessonRecord 自己去重）。 */
export function distillLessons(db, { home, minOccurrences = 2, limit = 5, now = Date.now() } = {}) {
  if (!home) return { added: [], skipped: 'no_home' };
  const rows = db.prepare(
    `SELECT pattern_key, occurrences, summary FROM learning_proposals
      WHERE kind='action_reflection' AND status IN ('candidate','validating') AND occurrences >= ?
      ORDER BY occurrences DESC, updated_at DESC LIMIT ?`,
  ).all(Math.max(1, Number(minOccurrences) || 2), Math.max(1, Math.min(20, Number(limit) || 5)));

  const file = lessonsFileOf(home);
  const added = [];
  for (const row of rows) {
    const matched = PATTERN.exec(String(row.pattern_key ?? ''));
    if (!matched) continue;
    const [, operation, category] = matched;
    // 「原因不明」的失败写不成经验：既说不出下次该注意什么，还会把 prompt 塞满。
    if (category === 'unknown') continue;
    const text = `${operation} 反复因为「${labelForCategory(category)}」失败（${row.occurrences} 次）：下次动手前先确认这一点，同一做法别原样重试。`;
    const result = appendLessonRecord(file, { text, tags: ['auto', 'failure'], at: new Date(now).toISOString() });
    if (result?.changed !== false) added.push({ operation, category, text });
  }
  return { added };
}
