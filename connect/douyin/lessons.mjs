/**
 * 抖音操作经验本：每遇到一次没见过的步骤/失败，就记一条，下次先查。
 * 存 runtime/douyin/lessons.json，注入给评论/发布决策使用。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function loadLessons(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return { lessons: [] }; }
}

export function addLesson(file, { kind = 'note', text, tags = [] }, now = Date.now()) {
  const data = loadLessons(file);
  const item = { at: new Date(now).toISOString(), kind, text: String(text).trim(), tags };
  if (!item.text) return data;
  const dup = data.lessons.find((lesson) => lesson.text === item.text);
  if (dup) return data;
  data.lessons = [...data.lessons, item].slice(-200);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return data;
}

export function formatLessons(file, limit = 8) {
  const { lessons } = loadLessons(file);
  return lessons.slice(-limit).map((lesson) => `- [${lesson.kind}] ${lesson.text}`).join('\n');
}

/** 把已知坑翻译成提示词片段。 */
export function lessonsPrompt(file, limit = 8) {
  const text = formatLessons(file, limit);
  return text ? `你踩过这些坑，操作时先绕开：\n${text}` : '';
}
