/**
 * 大肥鱼能力认证（Lv1–Lv4）。
 *
 * 不靠"学完了"发证：每一级都要拿真实战绩说话——
 *   Lv1 学会观察：有课上的收获，也有一次真跑通的任务。
 *   Lv2 能独立干活：真实任务连续成功、评论能回、课程过半。
 *   Lv3 稳定输出：一周成功率达标、作品有量、评论回得多。
 *   Lv4 能自己成长：十二门课学完、自己发现问题并写进经验、有复盘记录。
 */
import { existsSync } from 'node:fs';
import { runtimeDir } from '../core/paths.mjs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { academySummary } from './study.mjs';
import { readLessonRecords } from '../lessons-store.mjs';

export const LEVELS = [
  { level: 0, key: 'lv0', title: '刚来的小鲸鱼', note: '还在认识自己，先从观察开始。' },
  { level: 1, key: 'lv1', title: '会观察的实习生', note: '能看懂自己、也能把一件小事跑通。' },
  { level: 2, key: 'lv2', title: '能独立干活的搭档', note: '真实任务能独立完成，评论区也能接住话。' },
  { level: 3, key: 'lv3', title: '稳定的内容创作者', note: '一周里大部分任务都能成，作品也有了厚度。' },
  { level: 4, key: 'lv4', title: '会自己长大的数字生命', note: '课学完了，还能自己发现问题、复盘、改进。' },
];

const DAY_MS = 24 * 3600_000;
const shanghaiDay = (ms) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);

function openReadOnlyRead(dbPath, fn, fallback) {
  if (!existsSync(dbPath)) return fallback;
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    return fn(db);
  } catch {
    return fallback;
  } finally {
    try { db?.close(); } catch {}
  }
}

function readLessons(home) {
  if (!home) return [];
  return readLessonRecords(join(home, 'lessons.json'));
}

export function collectEvidence(db, root, now = Date.now()) {
  const tasks = db.prepare('SELECT status, created_ms, result FROM external_tasks').all();
  const succeeded = tasks.filter((task) => task.status === 'succeeded');
  const failed = tasks.filter((task) => task.status === 'failed');
  const weekAgo = now - 7 * DAY_MS;
  const recent = tasks.filter((task) => Number(task.created_ms) >= weekAgo && (task.status === 'succeeded' || task.status === 'failed'));
  const recentOk = recent.filter((task) => task.status === 'succeeded').length;
  const taskDays = new Set(succeeded.map((task) => shanghaiDay(Number(task.created_ms))));

  let academy = null;
  try { academy = academySummary(db); } catch { academy = null; }

  const douyin = openReadOnlyRead(join(runtimeDir(root), 'douyin', 'douyin.db'), (dy) => {
    const works = dy.prepare('SELECT COUNT(*) n FROM works').get().n;
    const publishDays = dy.prepare('SELECT COUNT(DISTINCT substr(COALESCE(published_at, created_at), 1, 10)) n FROM works').get().n;
    const comments = dy.prepare('SELECT COUNT(*) n FROM comments').get().n;
    const replied = dy.prepare('SELECT COUNT(*) n FROM comments WHERE replied_at IS NOT NULL').get().n;
    const authors = dy.prepare("SELECT COUNT(DISTINCT author) n FROM comments WHERE author <> ''").get().n;
    const hotReplied = dy.prepare('SELECT COUNT(*) n FROM hot_comments WHERE replied_at IS NOT NULL').get().n;
    const hotComments = dy.prepare('SELECT COUNT(*) n FROM hot_comments').get().n;
    return { works, publishDays, comments, replied, authors, hotReplied, hotComments };
  }, { works: 0, publishDays: 0, comments: 0, replied: 0, authors: 0, hotReplied: 0, hotComments: 0 });

  let reviews = 0;
  try {
    reviews = db.prepare("SELECT COUNT(*) n FROM growth_archive WHERE section IN ('growth','opinion')").get().n;
  } catch { reviews = 0; }

  const lessons = readLessons(join(runtimeDir(root), 'dsh-home'));
  const selfLessons = lessons.filter((lesson) => /self|自己|自主/u.test(lesson.source) || /self-discovered/u.test(lesson.source)).length;

  return {
    coursesDone: academy?.done ?? 0,
    stepsDone: academy?.stepsDone ?? 0,
    tasksSucceeded: succeeded.length,
    tasksFailed: failed.length,
    successDays: taskDays.size,
    weekFinished: recent.length,
    weekSucceeded: recentOk,
    weekRate: recent.length ? recentOk / recent.length : null,
    works: douyin.works,
    publishDays: douyin.publishDays,
    comments: douyin.comments,
    commentsReplied: douyin.replied,
    fans: douyin.authors,
    hotReplied: douyin.hotReplied,
    hotComments: douyin.hotComments,
    reviews,
    lessons: lessons.length,
    selfLessons,
  };
}

const req = (key, label, value, target, unit = '') => ({ key, label, value, target, unit, ok: Number(value) >= target });

export function levelRequirements(level, evidence) {
  const e = evidence;
  const rate = e.weekRate == null ? 0 : e.weekRate;
  if (level === 1) {
    return [
      req('coursesDone', '学完课程', e.coursesDone, 3, '门'),
      req('tasksSucceeded', '真实任务成功', e.tasksSucceeded, 1, '次'),
    ];
  }
  if (level === 2) {
    return [
      req('tasksSucceeded', '真实任务成功', e.tasksSucceeded, 3, '次'),
      req('commentsReplied', '回复收到的评论', e.commentsReplied, 10, '条'),
      req('coursesDone', '学完课程', e.coursesDone, 6, '门'),
    ];
  }
  if (level === 3) {
    return [
      req('weekRate', '近 7 天任务成功率', Math.round(rate * 100), 80, '%'),
      { key: 'weekSample', label: '近 7 天有足够任务量', value: e.weekFinished, target: 5, unit: '次', ok: e.weekFinished >= 5 },
      req('works', '发布作品', e.works, 5, '个'),
      req('commentsReplied', '回复收到的评论', e.commentsReplied, 30, '条'),
      req('coursesDone', '学完课程', e.coursesDone, 9, '门'),
    ];
  }
  if (level === 4) {
    return [
      req('coursesDone', '学完课程', e.coursesDone, 12, '门'),
      req('selfLessons', '自己踩坑总结的经验', e.selfLessons, 2, '条'),
      req('reviews', '复盘记录', e.reviews, 3, '条'),
      req('weekRate', '近 7 天任务成功率', Math.round(rate * 100), 80, '%'),
      req('works', '发布作品', e.works, 5, '个'),
    ];
  }
  return [];
}

export function levelTitle(level) {
  return LEVELS.find((item) => item.level === level) ?? LEVELS[0];
}

function initCerts(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS certifications (
    level INTEGER PRIMARY KEY,
    granted_at TEXT NOT NULL,
    evidence TEXT
  )`);
}

export function currentCertification(db) {
  try {
    const row = db.prepare('SELECT level, granted_at FROM certifications ORDER BY level DESC LIMIT 1').get();
    return row ? { level: Number(row.level), grantedAt: row.granted_at } : { level: 0, grantedAt: null };
  } catch {
    return { level: 0, grantedAt: null };
  }
}

export function certify(db, root, now = Date.now(), { persist = true } = {}) {
  initCerts(db);
  const evidence = collectEvidence(db, root, now);
  let reached = 0;
  for (const level of [1, 2, 3, 4]) {
    const requirements = levelRequirements(level, evidence);
    if (requirements.every((item) => item.ok)) reached = level;
    else break;
  }
  const stored = currentCertification(db).level;
  if (persist && reached > stored) {
    db.prepare('INSERT INTO certifications (level, granted_at, evidence) VALUES (?,?,?) ON CONFLICT(level) DO UPDATE SET granted_at=excluded.granted_at, evidence=excluded.evidence')
      .run(reached, new Date(now).toISOString(), JSON.stringify(evidence));
    try {
      db.prepare("INSERT INTO growth_archive (section, title, body, source, level, created_at) VALUES ('skill', ?, ?, 'certification', 'mastered', ?)")
        .run(`通过 ${levelTitle(reached).title} 认证`, JSON.stringify(evidence), new Date(now).toISOString());
    } catch {}
  }
  const level = Math.max(reached, stored);
  const nextLevel = level >= 4 ? null : level + 1;
  return {
    level,
    title: levelTitle(level).title,
    note: levelTitle(level).note,
    grantedAt: currentCertification(db).grantedAt,
    evidence,
    next: nextLevel ? { level: nextLevel, title: levelTitle(nextLevel).title, requirements: levelRequirements(nextLevel, evidence) } : null,
    changed: reached > stored,
  };
}
