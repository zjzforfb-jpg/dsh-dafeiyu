/**
 * 大肥鱼成长学院 · 学习块（七步闭环）。
 *
 * 每门课分 7 步：导入 → 知识 → 案例 → 模仿 → 独立实践 → 考核 → 成长总结。
 * 一次学习块只推进 1 步，产出写进 study_sessions，关键结论进 growth_archive。
 */
import { DatabaseSync } from 'node:sqlite';
import { runtimeDir } from '../core/paths.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COURSES, COURSE_BY_ID, LESSON_STEPS, nextCourse, courseText } from './courses.mjs';

export const ARCHIVE_SECTIONS = [
  { key: 'knowledge', label: '我的知识' },
  { key: 'skill', label: '我的技能' },
  { key: 'experience', label: '我的经验' },
  { key: 'opinion', label: '我的观点' },
  { key: 'growth', label: '我的成长' },
  { key: 'todo', label: '待学习清单' },
];

export const UNDERSTANDING = [
  { key: 'seen', label: '看过，还不理解' },
  { key: 'understood', label: '理解了，还不会用' },
  { key: 'practiced', label: '实践过' },
  { key: 'mastered', label: '已经熟练' },
  { key: 'opinion', label: '形成了自己的观点' },
];

export function openAcademyDb(root) {
  const file = join(runtimeDir(root), 'connect', 'connect.sqlite');
  const db = new DatabaseSync(file);
  initAcademy(db);
  return db;
}

import { ensureColumns } from '../core/migrations.mjs';

export function initAcademy(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS course_state (
    course_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'new',
    step INTEGER NOT NULL DEFAULT 0,
    score REAL,
    evidence TEXT,
    updated_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS study_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    day TEXT NOT NULL,
    course_id TEXT NOT NULL,
    step INTEGER NOT NULL DEFAULT 0,
    summary TEXT,
    practice TEXT,
    created_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS growth_archive (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    source TEXT,
    created_at TEXT NOT NULL
  )`);
  ensureColumns(db, 'study_sessions', ['step_key','output','score','passed']);
  ensureColumns(db, 'growth_archive', ['level']);
  db.exec('CREATE INDEX IF NOT EXISTS study_sessions_day ON study_sessions(day DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS growth_archive_section ON growth_archive(section, created_at DESC)');
}

const iso = (now = Date.now()) => new Date(now).toISOString();
const dayOf = (now) => new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
const TOTAL_STEPS = LESSON_STEPS.length;

function readSettings(home) {
  try {
    return JSON.parse(readFileSync(join(home, 'dsh-pet', 'standalone-ai.json'), 'utf8'));
  } catch {
    return {};
  }
}

const STEP_PROMPTS = {
  intro: (course) => `用你自己的话讲：为什么要学《${course.title}》，它想解决什么问题。150 字以内，第一人称。`,
  knowledge: (course) => `把下面这些知识模块嚼碎，用你自己的话讲重点和容易踩的坑（3-5 条）：\n${course.knowledge.map((item) => `- ${item.name}：${item.detail}`).join('\n')}`,
  case: (course) => `拆这个案例，说清它好在哪、如果换你会怎么做：\n${course.case}`,
  imitate: (course) => `照着这门课的方法，模仿做一遍，直接给出产物（不要写"我会…"）：\n练习：${course.drills[0]}\n案例参考：${course.case}`,
  practice: (course) => `设计一个能真实做的独立任务来练这门课（不要模拟题），写清做什么、怎么算做到。可参考：${course.drills.join('；')}`,
  assess: (course) => `按考核标准给自己这次学习打分（0-100），指出两条最该补的不足。\n考核标准：${course.rubric.join('；')}\n毕业标准：${course.graduation}`,
  summary: (course) => `写这次学习的成长总结：学到了什么、哪里还没懂、下一步准备怎么练。100 字以内，第一人称。`,
};

function fallback(stepKey, course) {
  if (stepKey === 'intro') return `学《${course.title}》是为了${course.goal}`;
  if (stepKey === 'knowledge') return course.knowledge.map((item) => `${item.name}：${item.detail}`).join('；');
  if (stepKey === 'case') return course.case;
  if (stepKey === 'imitate') return course.drills[0];
  if (stepKey === 'practice') return course.drills.join('；');
  if (stepKey === 'assess') return `按标准自查：${course.rubric.join('；')}`;
  return `这门课我要记住的是：${course.goal}`;
}

export async function digestStep({ home, course, stepKey, ask, fetchImpl = fetch, now = Date.now() }) {
  const prompt = STEP_PROMPTS[stepKey]?.(course) ?? STEP_PROMPTS.intro(course);
  const system = '你是大肥鱼的学习教练。回答用中文、第一人称、口语化、具体，不要说空话。';
  let text = '';
  let lastError = null;
  try {
    if (ask) {
      text = String(await ask(prompt, system) ?? '').trim();
    } else {
      const settings = readSettings(home);
      const baseUrl = String(settings.baseUrl ?? 'http://127.0.0.1:3110/v1').replace(/\/+$/u, '');
      const budgets = [Number(settings.maxTokens) || 900, 2200];
      for (const maxTokens of budgets) {
        const response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.apiKey ?? 'local'}` },
          body: JSON.stringify({
            model: settings.model ?? 'deepseek-flash',
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: `${prompt}\n\n课程全文：\n${courseText(course)}` },
            ],
            max_tokens: maxTokens,
            temperature: 0.6,
          }),
          signal: AbortSignal.timeout(60_000),
        });
        if (!response.ok) throw new Error(`llm_${response.status}`);
        const data = await response.json();
        const message = data?.choices?.[0]?.message ?? {};
        text = String(message.content ?? '').trim();
        if (text) break;
        // 模型把额度都花在 reasoning 上时 content 会是空的，加预算再来一次。
        if (!message.reasoning_content) break;
        lastError = 'empty_answer';
      }
    }
  } catch (error) {
    return { text: fallback(stepKey, course), score: null, passed: null, error: String(error?.message ?? error) };
  }
  if (!text) return { text: fallback(stepKey, course), score: null, passed: null, error: lastError ?? 'empty_answer' };
  let score = null;
  let passed = null;
  if (stepKey === 'assess') {
    const match = text.match(/(\d{1,3})\s*分?/u);
    score = match ? Math.max(0, Math.min(100, Number(match[1]))) : null;
    passed = score != null ? score >= 60 : null;
  }
  return { text, score, passed, error: null };
}

function nextStepOf(state) {
  const done = Number(state?.step ?? 0);
  return done < TOTAL_STEPS ? done : null;
}

export function academyState(db) {
  const rows = db.prepare('SELECT course_id, status, step, score FROM course_state').all();
  const map = new Map(rows.map((row) => [row.course_id, row]));
  return COURSES.map((course) => {
    const row = map.get(course.id) ?? { status: 'new', step: 0, score: null };
    const step = Number(row.step ?? 0);
    return {
      id: course.id,
      stage: course.stage,
      title: course.title,
      goal: course.goal,
      status: row.status,
      step,
      total: TOTAL_STEPS,
      stepLabel: step >= TOTAL_STEPS ? '已完成' : LESSON_STEPS[step]?.label ?? '未开始',
      score: row.score ?? null,
    };
  });
}

export function doneCourseIds(db) {
  return db.prepare("SELECT course_id FROM course_state WHERE status='done'").all().map((row) => row.course_id);
}

export function academySummary(db) {
  const state = academyState(db);
  const done = state.filter((item) => item.status === 'done').length;
  const learning = state.filter((item) => item.status === 'learning').length;
  const stepsDone = state.reduce((sum, item) => sum + Math.min(item.step, item.total), 0);
  return {
    total: state.length,
    done,
    learning,
    stepsDone,
    stepsTotal: state.length * TOTAL_STEPS,
    state,
    stages: [1, 2, 3, 4].map((stage) => {
      const items = state.filter((item) => item.stage === stage);
      return { stage, total: items.length, done: items.filter((item) => item.status === 'done').length };
    }),
  };
}

export function archiveEntry(db, { section = 'knowledge', title, body = '', source = '', level = 'understood', now = Date.now() }) {
  db.prepare('INSERT INTO growth_archive (section, title, body, source, level, created_at) VALUES (?,?,?,?,?,?)')
    .run(section, String(title), String(body), String(source), String(level), iso(now));
}

export async function runStudyStep({ db, root, home, now = Date.now(), ask, fetchImpl = fetch, random = Math.random }) {
  const state = academyState(db);
  const pending = state.find((item) => item.status !== 'done');
  const course = pending ? COURSE_BY_ID.get(pending.id) : nextCourse(doneCourseIds(db));
  if (!course) return { status: 'finished', reason: 'all_courses_done' };
  const current = db.prepare('SELECT step, score FROM course_state WHERE course_id=?').get(course.id) ?? { step: 0, score: null };
  const index = nextStepOf(current);
  if (index == null) return { status: 'finished', reason: 'course_done' };
  const step = LESSON_STEPS[index];
  const digest = await digestStep({ home, course, stepKey: step.key, ask, fetchImpl, now });
  const summary = String(digest.text).slice(0, 600);
  db.prepare('INSERT INTO study_sessions (day, course_id, step, step_key, summary, practice, output, score, passed, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(dayOf(now), course.id, index + 1, step.key, summary, step.key === 'practice' ? summary : '', summary, digest.score ?? null, digest.passed == null ? null : (digest.passed ? 1 : 0), iso(now));
  const nextIndex = index + 1;
  const done = nextIndex >= TOTAL_STEPS;
  const score = step.key === 'assess' ? digest.score ?? null : (current.score ?? null);
  db.prepare('INSERT INTO course_state (course_id, status, step, score, evidence, updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(course_id) DO UPDATE SET status=excluded.status, step=excluded.step, score=excluded.score, evidence=excluded.evidence, updated_at=excluded.updated_at')
    .run(course.id, done ? 'done' : 'learning', nextIndex, score, JSON.stringify({ lastStep: step.key }), iso(now));
  if (step.key === 'knowledge') archiveEntry(db, { section: 'knowledge', title: course.title, body: summary, source: `course:${course.id}`, level: 'understood', now });
  if (step.key === 'practice') archiveEntry(db, { section: 'todo', title: `练习任务：${course.title}`, body: summary, source: `course:${course.id}`, level: 'seen', now });
  if (step.key === 'assess') archiveEntry(db, { section: 'skill', title: `考核：${course.title}`, body: `${score == null ? '未评分' : `${score} 分`}\n${summary}`, source: `course:${course.id}`, level: digest.passed ? 'practiced' : 'understood', now });
  if (step.key === 'summary') archiveEntry(db, { section: 'growth', title: course.title, body: summary, source: `course:${course.id}`, level: 'mastered', now });
  if (digest.error) archiveEntry(db, { section: 'growth', title: `学习块降级：${course.title}`, body: String(digest.error), source: `course:${course.id}`, level: 'seen', now });
  return {
    status: done ? 'course_done' : 'step_done',
    courseId: course.id,
    courseTitle: course.title,
    step: index + 1,
    stepKey: step.key,
    stepLabel: step.label,
    total: TOTAL_STEPS,
    summary,
    score: digest.score ?? null,
    passed: digest.passed ?? null,
    degraded: Boolean(digest.error),
    error: digest.error ?? null,
  };
}

/** 兼容旧调用：一次学习块推进一小步。 */
export async function runStudyBlock(options) {
  return runStudyStep(options);
}

export function recentSessions(db, limit = 10) {
  const safe = Math.min(Math.max(Number(limit) || 10, 1), 200);
  return db.prepare('SELECT id, day, course_id, step, step_key, summary, score, passed, created_at FROM study_sessions ORDER BY id DESC LIMIT ?').all(safe);
}

export function recentArchive(db, limit = 10, section = null) {
  const safe = Math.min(Math.max(Number(limit) || 10, 1), 200);
  if (section) return db.prepare('SELECT * FROM growth_archive WHERE section=? ORDER BY id DESC LIMIT ?').all(section, safe);
  return db.prepare('SELECT * FROM growth_archive ORDER BY id DESC LIMIT ?').all(safe);
}

export function resetAcademy(db) {
  db.exec('DELETE FROM course_state');
  db.exec('DELETE FROM study_sessions');
  return { ok: true };
}
