/** Douyin view over the shared lessons array in runtime/dsh-home/lessons.json. */
import { appendLessonRecord, migrateLessonRecords, readLessonRecords } from '../lessons-store.mjs';

export function loadLessons(file) {
  migrateLessonRecords(file);
  return { lessons: readLessonRecords(file).filter((row) => row.channels.includes('douyin')) };
}

export function addLesson(file, { kind = 'note', text, tags = [], channels = ['douyin'] }, now = Date.now()) {
  appendLessonRecord(file, { kind, text, tags, channels, source: 'douyin', at: new Date(now).toISOString() });
  return loadLessons(file);
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

// 界面速查：docs/DOUYIN_UI.md（爸爸 2026-11-14 教学整理）
