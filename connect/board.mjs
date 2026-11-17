import { existsSync, readFileSync } from 'node:fs';
import { runtimeDir } from './core/paths.mjs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { listRollbacks } from './skills/learning.mjs';
import { DAILY_BUDGET, budgetUsage as unifiedUsage } from './core/budget.mjs';

import { ARCHIVE_SECTIONS, academySummary, academyState, recentArchive, recentSessions } from './academy/study.mjs';
import { certify } from './academy/levels.mjs';
import { graduationState } from './academy/graduation.mjs';
import { fanTrend, listFans } from './douyin/store.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
const iso = (ms) => (num(ms) ? new Date(Number(ms)).toISOString() : null);

function openReadOnly(file) {
  if (!existsSync(file)) return null;
  try { return new DatabaseSync(file, { readOnly: true }); } catch { return null; }
}

/** 看板数据：一眼看清「在跑什么、等着批什么、发过什么、回过什么」。 */
function readAcademy(db) {
  try { return academySummary(db); } catch { return null; }
}


const FAILURE_KINDS = [
  [/spawn .* ENOENT|ENOENT/iu, '找不到命令/文件'],
  [/need_text/iu, '缺少文案参数'],
  [/comment_button_missing/iu, '评论区按钮没找到'],
  [/comments_empty/iu, '评论区没加载出来'],
  [/card_missing|search_unreachable|detail_not_opened/iu, '搜索/详情跳转失败'],
  [/ECONNREFUSED|fetch failed/iu, '网络或代理不通'],
  [/too_fast|rate/iu, '操作太频繁被拦'],
  [/timeout|ETIMEDOUT/iu, '超时'],
  [/photo_post/iu, '图文没有评论区'],
];

function classifyFailure(text) {
  const raw = String(text ?? '');
  for (const [re, label] of FAILURE_KINDS) if (re.test(raw)) return label;
  return raw ? '其他' : '未记录原因';
}

/** 最近失败任务的「为什么」排行。 */
function readFailures(db, limit = 30) {
  let rows = [];
  try {
    rows = db.prepare("SELECT id, intent, result, created_ms FROM external_tasks WHERE status='failed' ORDER BY created_ms DESC LIMIT ?").all(limit);
  } catch { return []; }
  const groups = new Map();
  for (const row of rows) {
    let detail = '';
    try {
      const parsed = JSON.parse(row.result ?? 'null');
      detail = Array.isArray(parsed) ? parsed.map((item) => item?.detail ?? '').join(' ') : String(parsed ?? '');
    } catch { detail = String(row.result ?? ''); }
    const reason = classifyFailure(detail);
    const entry = groups.get(reason) ?? { reason, count: 0, last_at: null, detail: '' };
    entry.count += 1;
    if (!entry.last_at) { entry.last_at = iso(row.created_ms); entry.detail = detail.replace(/\s+/gu, ' ').slice(0, 120); }
    groups.set(reason, entry);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 6);
}

export function boardSnapshot(db, root, qqStatus = null, now = Date.now()) {
  const since = now - DAY_MS;
  const tasks = db.prepare(`SELECT id, conv_kind, conv_id, intent, payload, status, result, created_ms, updated_ms, expires_ms, attempts
    FROM external_tasks ORDER BY created_ms DESC LIMIT 40`).all()
    .map((row) => {
      let payload = null;
      try { payload = JSON.parse(row.payload ?? 'null'); } catch { payload = null; }
      let result = null;
      try { result = JSON.parse(row.result ?? 'null'); } catch { result = null; }
      return {
        id: row.id,
        status: row.status,
        intent: row.intent,
        operations: payload?.operations ?? [],
        theme: payload?.theme ?? null,
        created_at: iso(row.created_ms),
        updated_at: iso(row.updated_ms),
        expires_at: iso(row.expires_ms),
        attempts: row.attempts ?? 0,
        detail: Array.isArray(result) ? result.map((item) => `${item.operation ?? ''}:${item.status ?? ''}${item.detail ? ` · ${String(item.detail).split('\n')[0]}` : ''}`).join('；') : '',
        conv: row.conv_id,
      };
    });
  const order = { running: 0, awaiting_publish: 1, awaiting_confirmation: 2, approved: 3, pending: 4, succeeded: 5, failed: 6, cancelled: 7, expired: 8 };
  const running = tasks.filter((task) => task.status === 'running');
  const pending = tasks.filter((task) => task.status === 'awaiting_confirmation' || task.status === 'awaiting_publish' || task.status === 'approved');
  const finishedAll = tasks.filter((task) => !running.includes(task) && !pending.includes(task));
  const reasons = new Map();
  try {
    for (const row of db.prepare("SELECT task_id, payload FROM agent_events WHERE event_type='task_state_changed' AND task_id IS NOT NULL ORDER BY id").all()) {
      let payload = null;
      try { payload = JSON.parse(row.payload ?? 'null'); } catch { payload = null; }
      if (payload?.reason) reasons.set(row.task_id, payload.reason);
    }
  } catch {}
  const finished = finishedAll.slice(0, 8).map((task) => ({ ...task, reason: reasons.get(task.id) ?? (task.status === 'succeeded' ? '' : '没记原因') }));

  const events = db.prepare('SELECT event_type, task_id, created_at, payload FROM agent_events ORDER BY id DESC LIMIT 40').all()
    .map((row) => {
      let payload = null;
      try { payload = JSON.parse(row.payload ?? 'null'); } catch { payload = null; }
      const note = payload?.note ?? payload?.reason ?? (payload?.text ? String(payload.text).slice(0, 40) : '') ?? '';
      return { type: row.event_type, task_id: row.task_id, at: row.created_at, note, state: payload?.status ?? null };
    });

  const counters = {
    messages_today: db.prepare("SELECT COUNT(*) c FROM qq_messages WHERE created_ms >= ?").get(since).c,
    tasks_today: db.prepare('SELECT COUNT(*) c FROM external_tasks WHERE created_ms >= ?').get(since).c,
  };

  const day = new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
  const dayStart = Date.parse(day + 'T00:00:00+08:00');
  const usage = (() => {
    // D-2：看板读统一预算（跨渠道同一格），不再只看 QQ 自己的账。
    try { return unifiedUsage(db, day); }
    catch { return { model_calls: 0, voice_requests: 0, autonomous_actions: 0 }; }
  })();
  const todayTasks = (() => {
    const out = { succeeded: 0, failed: 0, running: 0, waiting: 0, cancelled: 0, expired: 0, total: 0 };
    try {
      for (const row of db.prepare('SELECT status, COUNT(*) c FROM external_tasks WHERE created_ms >= ? GROUP BY status').all(dayStart)) {
        out.total += row.c;
        if (row.status === 'succeeded') out.succeeded += row.c;
        else if (row.status === 'failed') out.failed += row.c;
        else if (row.status === 'running') out.running += row.c;
        else if (row.status === 'cancelled') out.cancelled += row.c;
        else if (row.status === 'expired') out.expired += row.c;
        else out.waiting += row.c;
      }
    } catch {}
    return out;
  })();
  const failures = readFailures(db);
  // 粉丝存在 douyin.db 里，别拿 connect 库查
  const fanInfo = (() => {
    const fanDb = openReadOnly(douyinPath(root));
    if (!fanDb) return { total: 0, interactions: 0, top: [], trend: [] };
    try {
      const total = fanDb.prepare('SELECT COUNT(*) n, COALESCE(SUM(interactions),0) c FROM fans').get();
      return { total: total.n, interactions: total.c, top: listFans(fanDb, 8), trend: fanTrend(fanDb, 14) };
    } catch { return { total: 0, interactions: 0, top: [], trend: [] }; } finally { fanDb.close(); }
  })();

  const douyin = openReadOnly(join(runtimeDir(root), 'douyin', 'douyin.db'));
  let works = [];
  let comments = [];
  let worksTotal = 0;
  let commentsTotal = 0;
  let hotVideosTotal = 0;
  let hotCommentsTotal = 0;
  let hotRepliedTotal = 0;
  let commentsToday = 0;
  if (douyin) {
    try {
      worksTotal = douyin.prepare('SELECT COUNT(*) c FROM works').get().c;
      commentsTotal = douyin.prepare('SELECT COUNT(*) c FROM comments').get().c;
      commentsToday = douyin.prepare('SELECT COUNT(*) c FROM comments WHERE COALESCE(comment_epoch,0) >= ?').get(dayStart).c;
      works = readWorks(douyin, 1, 6);
      comments = readComments(douyin, 1, 8);
      const titles = new Map(works.map((work) => [work.id, work.title]));
      comments = comments.map((row) => ({ ...row, work_title: titles.get(row.work_id) ?? (row.work_id ? row.work_id : '未绑定作品') }));
      try {
        hotVideosTotal = douyin.prepare('SELECT COUNT(*) c FROM videos').get().c;
        hotCommentsTotal = douyin.prepare('SELECT COUNT(*) c FROM hot_comments').get().c;
        hotRepliedTotal = douyin.prepare('SELECT COUNT(*) c FROM hot_comments WHERE replied_at IS NOT NULL').get().c;
      } catch {}
    } finally { douyin.close(); }
  }

  function readSkills(db) {
  const out = { total: 0, runs: 0, verified: 0, failed: 0, steps: 0, heals: { total: 0, kinds: [] }, recent: [], proposals: [], versions: [], rollbacks: [] };
  try { out.total = db.prepare('SELECT COUNT(*) c FROM skill_registry').get().c; } catch {}
  try {
    const row = db.prepare("SELECT COUNT(*) c, SUM(CASE WHEN success=1 AND verified=1 THEN 1 ELSE 0 END) v, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) f FROM skill_runs WHERE status != 'running'").get();
    out.runs = row.c ?? 0; out.verified = row.v ?? 0; out.failed = row.f ?? 0;
  } catch {}
  try { out.steps = db.prepare('SELECT COUNT(*) c FROM skill_step_events').get().c; } catch {}
  try {
    const rows = db.prepare("SELECT step_id, COUNT(*) n FROM skill_step_events WHERE step_id LIKE 'heal:%' GROUP BY step_id ORDER BY n DESC LIMIT 6").all();
    out.heals = { total: rows.reduce((sum, row) => sum + Number(row.n || 0), 0), kinds: rows.map((row) => ({ kind: String(row.step_id).slice(5), n: Number(row.n) })) };
  } catch { out.heals = { total: 0, kinds: [] }; }
  try {
    out.recent = db.prepare(`SELECT r.id, r.skill_id, r.version, r.status, r.success, r.verified, r.failure_stage, r.duration_ms, r.started_at,
      (SELECT COUNT(*) FROM skill_step_events e WHERE e.run_id=r.id) steps
      FROM skill_runs r WHERE r.status != 'running' ORDER BY r.started_at DESC LIMIT 6`).all();
  } catch {}
  try {
    out.proposals = db.prepare('SELECT pattern_key, occurrences, updated_at FROM learning_proposals ORDER BY occurrences DESC, updated_at DESC LIMIT 6').all();
  } catch {}
  try {
    out.versions = db.prepare(`SELECT v.skill_id, v.version, v.status, v.created_at,
      (SELECT COUNT(*) FROM skill_runs r WHERE r.skill_id=v.skill_id AND r.version=v.version AND r.status!='running') runs,
      (SELECT COUNT(*) FROM skill_runs r WHERE r.skill_id=v.skill_id AND r.version=v.version AND r.success=1 AND r.verified=1) verified,
      (SELECT COUNT(*) FROM skill_runs r WHERE r.skill_id=v.skill_id AND r.version=v.version AND r.status='failed') failed
      FROM skill_versions v ORDER BY v.skill_id ASC, v.version DESC LIMIT 24`).all();
  } catch { out.versions = []; }
  out.rollbacks = listRollbacks(db, 6);
  return out;
}

function readAcademySafe() {
    try { return { summary: academySummary(db), md: null }; } catch { return null; }
  }
  const academy = readAcademySafe()?.summary ?? null;
  let certification = null;
  try { certification = certify(db, root, now); } catch {}
  let archive = null;
  try {
    const counts = ARCHIVE_SECTIONS.map((section) => ({ ...section, n: recentArchive(db, 500, section.key).length }));
    archive = { sections: counts, recent: recentArchive(db, 6) };
  } catch { archive = null; }

  return {
    academy,
    certification,
    archive,
    skills: readSkills(db),
    mood: readMoodToday(db, now),
    moodTrend: readMoodTrend(db, now),
    usageTrend: readUsageTrend(db, now),
    plan: readPlanToday(db, now),
    pulse: {
      day,
      model_calls: usage.model_calls ?? 0,
      voice_requests: usage.voice_requests ?? 0,
      model_budget: DAILY_BUDGET.modelCalls,
      tasks_today: todayTasks,
      comments_today: commentsToday,
      fans: fanInfo.total,
      interactions: fanInfo.interactions,
      unreplied: commentsTotal ? unrepliedCount(douyinPath(root)) : 0,
    },
    failures,
    fans: fanInfo,
    now: new Date(now).toISOString(),
    status: {
      qq: qqStatus,
      model: readModel(root),
      counters,
      works: worksTotal,
      comments: commentsTotal,
      unreplied: commentsTotal ? unrepliedCount(douyinPath(root)) : 0,
      hot_videos: hotVideosTotal,
      hot_comments: hotCommentsTotal,
      hot_replied: hotRepliedTotal,
    },
    running,
    pending,
    finished,
    finished_total: db.prepare("SELECT COUNT(*) c FROM external_tasks WHERE status NOT IN ('running','awaiting_confirmation','awaiting_publish','approved','pending')").get().c,
    works,
    works_total: worksTotal,
    comments,
    comments_total: commentsTotal,
    activity: events,
    activity_total: db.prepare('SELECT COUNT(*) c FROM agent_events').get().c,
    order,
  };
}

function readMoodToday(db, now) {
  try {
    const day = new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
    const row = db.prepare('SELECT day, mood, energy, valence, why FROM mood_history WHERE day=?').get(day);
    return row ?? null;
  } catch { return null; }
}

function readMoodTrend(db, now) {
  try {
    const rows = db.prepare('SELECT day, energy FROM mood_history ORDER BY day DESC LIMIT 7').all();
    return rows.reverse().map((row) => ({ day: row.day, energy: Number(row.energy ?? 0) }));
  } catch { return []; }
}

function readUsageTrend(db, now) {
  // D-2：趋势图看统一账（daily_budget）；迁移之前的旧日还在 qq_usage 里，
  // 两边合并，避免看板在切换当天断掉。
  const byDay = new Map();
  try {
    for (const row of db.prepare('SELECT day, model_calls, voice_requests FROM daily_budget ORDER BY day DESC LIMIT 14').all()) {
      byDay.set(row.day, { day: row.day, model_calls: row.model_calls ?? 0, voice_requests: row.voice_requests ?? 0 });
    }
  } catch { /* 表还没建（全新库）就只留旧账。 */ }
  try {
    for (const row of db.prepare('SELECT day, model_calls, voice_requests FROM qq_usage ORDER BY day DESC LIMIT 14').all()) {
      if (!byDay.has(row.day)) byDay.set(row.day, { day: row.day, model_calls: row.model_calls ?? 0, voice_requests: row.voice_requests ?? 0 });
    }
  } catch { /* 旧表不存在也没关系。 */ }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

function readPlanToday(db, now) {
  try {
    const day = new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
    const plan = db.prepare('SELECT day, mood, energy, summary FROM daily_plans WHERE day=?').get(day);
    if (!plan) return null;
    const slots = db.prepare('SELECT id, at_ms, action, status, note FROM plan_slots WHERE day=? ORDER BY at_ms').all(day)
      .map((slot) => ({ ...slot, at: new Date(slot.at_ms).toISOString() }));
    return { ...plan, slots };
  } catch { return null; }
}

const clean = (value, fallback, min, max) => {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
};

function unrepliedCount(file) {
  const douyin = openReadOnly(file);
  if (!douyin) return 0;
  try { return douyin.prepare('SELECT COUNT(*) c FROM comments WHERE replied_at IS NULL').get().c; } finally { douyin.close(); }
}

const douyinPath = (root) => join(runtimeDir(root), 'douyin', 'douyin.db');

function readWorks(douyin, page, size) {
  return douyin.prepare('SELECT id, code, task_id, title, caption, topics, image_file, theme, settings, published_at, status, created_at, views, likes, favorites, shares, stats_at, images, draft_file FROM works ORDER BY CASE WHEN status = \'draft\' THEN 0 ELSE 1 END, COALESCE(published_at, created_at) DESC LIMIT ? OFFSET ?').all(size, (page - 1) * size)
    .map((row) => {
      const stat = douyin.prepare('SELECT COUNT(*) c, SUM(CASE WHEN replied_at IS NOT NULL THEN 1 ELSE 0 END) r FROM comments WHERE work_id=?').get(row.id);
      let settings = null;
      try { settings = row.settings ? JSON.parse(row.settings) : null; } catch { settings = null; }
      let images = [];
      try { images = row.images ? JSON.parse(row.images) : []; } catch { images = []; }
      if (!images.length && row.image_file) images = [row.image_file];
      let delta = null;
      try {
        const hist = douyin.prepare('SELECT day, views, likes FROM work_stats_history WHERE work_id=? ORDER BY day DESC LIMIT 2').all(row.id);
        if (hist.length === 2 && hist[0].views != null && hist[1].views != null) {
          delta = { day: hist[0].day, views: hist[0].views - hist[1].views, likes: (hist[0].likes ?? 0) - (hist[1].likes ?? 0) };
        }
      } catch {}
      return { id: row.id, code: row.code ?? '', task_id: row.task_id ?? null, title: row.title, caption: row.caption, topics: row.topics, image: row.image_file, images, theme: row.theme, settings, published_at: row.published_at, status: row.status, created_at: row.created_at, comment_count: stat?.c ?? 0, replied_count: stat?.r ?? 0, views: row.views ?? null, likes: row.likes ?? null, favorites: row.favorites ?? null, shares: row.shares ?? null, stats_at: row.stats_at ?? null, delta };
    });
}

function readComments(douyin, page, size, workId = null, replied = null) {
  const clauses = [];
  const params = [];
  if (workId) { clauses.push('work_id=?'); params.push(workId); }
  if (replied === 'yes') clauses.push('replied_at IS NOT NULL');
  if (replied === 'no') clauses.push('replied_at IS NULL');
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const rows = douyin.prepare(`SELECT id, work_id, author, text, comment_at, reply_text, replied_at, kind FROM comments ${where} ORDER BY COALESCE(comment_epoch, 0) DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, size, (page - 1) * size);
  const titles = new Map(douyin.prepare('SELECT id, title FROM works').all().map((row) => [row.id, row.title]));
  return rows.map((row) => ({ ...row, work_title: titles.get(row.work_id) ?? (row.work_id ? row.work_id : '未绑定作品') }));
}

function readVideos(douyin, page, size) {
  return douyin.prepare('SELECT id, title, author, likes, likes_text, keyword, date_text, status, discovered_at, last_round_at, comment_rounds FROM videos ORDER BY likes DESC LIMIT ? OFFSET ?')
    .all(size, (page - 1) * size)
    .map((row) => {
      const stat = douyin.prepare('SELECT COUNT(*) c, SUM(CASE WHEN replied_at IS NOT NULL THEN 1 ELSE 0 END) r FROM hot_comments WHERE video_id=?').get(row.id);
      return { ...row, like_text: row.likes_text, comment_count: stat?.c ?? 0, replied_count: stat?.r ?? 0 };
    });
}

function readHotComments(douyin, page, size, videoId = null, replied = null) {
  const clauses = [];
  const params = [];
  if (videoId) { clauses.push('video_id=?'); params.push(videoId); }
  if (replied === 'yes') clauses.push('replied_at IS NOT NULL');
  if (replied === 'no') clauses.push('replied_at IS NULL');
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const rows = douyin.prepare(`SELECT id, video_id, author, text, likes, likes_text, first_seen_at, reply_text, replied_at FROM hot_comments ${where} ORDER BY likes DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, size, (page - 1) * size);
  const titles = new Map(douyin.prepare('SELECT id, title FROM videos').all().map((row) => [row.id, row.title]));
  return rows.map((row) => ({ ...row, video_title: titles.get(row.video_id) ?? row.video_id, video: row.video_id }));
}

/** 分页列表：作品 / 评论（可按作品过滤）/ 最近完成 / 活动 / 爆款视频 / 热评。 */
export function boardList(db, root, { section, page = 1, size = 8, work = null, replied = null } = {}) {
  const current = clean(page, 1, 1, 10_000);
  if (section === 'videos') {
    const douyin = openReadOnly(douyinPath(root));
    if (!douyin) return { section, page: current, size: 10, total: 0, pages: 1, items: [], error: 'douyin_db_missing' };
    try {
      const limit = clean(size, 10, 1, 50);
      const total = douyin.prepare('SELECT COUNT(*) c FROM videos').get().c;
      return { section, page: current, size: limit, total, pages: Math.max(1, Math.ceil(total / limit)), items: readVideos(douyin, current, limit) };
    } finally { douyin.close(); }
  }
  if (section === 'skill_runs') {
    const limit = clean(size, 10, 1, 50);
    let total = 0;
    try { total = db.prepare("SELECT COUNT(*) c FROM skill_runs WHERE status != 'running'").get().c; } catch { total = 0; }
    const items = (() => {
      try {
        return db.prepare(`SELECT r.id, r.skill_id, r.status, r.success, r.verified, r.failure_stage, r.duration_ms, r.started_at,
          (SELECT COUNT(*) FROM skill_step_events e WHERE e.run_id=r.id) steps
          FROM skill_runs r WHERE r.status != 'running' ORDER BY r.started_at DESC LIMIT ? OFFSET ?`).all(limit, (current - 1) * limit);
      } catch { return []; }
    })();
    return { section, page: current, size: limit, total, pages: Math.max(1, Math.ceil(total / limit)), items };
  }
  if (section === 'skill_proposals') {
    const limit = clean(size, 10, 1, 50);
    let total = 0;
    try { total = db.prepare('SELECT COUNT(*) c FROM learning_proposals').get().c; } catch { total = 0; }
    const items = (() => {
      try {
        return db.prepare('SELECT pattern_key, occurrences, evidence, created_at, updated_at FROM learning_proposals ORDER BY occurrences DESC, updated_at DESC LIMIT ? OFFSET ?').all(limit, (current - 1) * limit);
      } catch { return []; }
    })();
    return { section, page: current, size: limit, total, pages: Math.max(1, Math.ceil(total / limit)), items };
  }
  if (section === 'finished') {
    const limit = clean(size, 8, 1, 50);
    const total = db.prepare("SELECT COUNT(*) c FROM external_tasks WHERE status NOT IN ('running','awaiting_confirmation','awaiting_publish','approved','pending')").get().c;
    const rows = db.prepare(`SELECT id, conv_kind, conv_id, intent, payload, status, result, created_ms, updated_ms, expires_ms, attempts
      FROM external_tasks WHERE status NOT IN ('running','awaiting_confirmation','awaiting_publish','approved','pending')
      ORDER BY created_ms DESC LIMIT ? OFFSET ?`).all(limit, (current - 1) * limit);
    const items = rows.map((row) => {
      let payload = null;
      let result = null;
      try { payload = JSON.parse(row.payload ?? 'null'); } catch { payload = null; }
      try { result = JSON.parse(row.result ?? 'null'); } catch { result = null; }
      return {
        id: row.id, status: row.status, intent: row.intent, operations: payload?.operations ?? [], theme: payload?.theme ?? null,
        created_at: iso(row.created_ms), attempts: row.attempts ?? 0,
        detail: Array.isArray(result) ? result.map((item) => `${item.operation ?? ''}:${item.status ?? ''}${item.detail ? ` · ${String(item.detail).split('\n')[0]}` : ''}`).join('；') : '',
      };
    });
    return { section, page: current, size: limit, total, pages: Math.max(1, Math.ceil(total / limit)), items };
  }
  if (section === 'courses') {
    try {
      const state = academyState(db);
      let certification = null;
      let graduation = null;
      try { certification = certify(db, root); } catch {}
      try { graduation = graduationState(db, root); } catch {}
      return { section, page: 1, size: state.length, total: state.length, pages: 1, items: state, certification, graduation };
    } catch { return { section, page: 1, size: 0, total: 0, pages: 1, items: [], error: 'academy_missing' }; }
  }
  if (section === 'study') {
    try {
      const limit = clean(size, 10, 1, 50);
      const rows = recentSessions(db, 200);
      const total = rows.length;
      const items = rows.slice((current - 1) * limit, current * limit).map((row) => ({ ...row, at: row.created_at }));
      return { section, page: current, size: limit, total, pages: Math.max(1, Math.ceil(total / limit)), items };
    } catch { return { section, page: 1, size: 0, total: 0, pages: 1, items: [], error: 'academy_missing' }; }
  }
  if (section === 'archive') {
    try {
      const limit = clean(size, 10, 1, 50);
      const wanted = work && work !== 'all' ? String(work) : null;
      const rows = recentArchive(db, 500, wanted);
      const total = rows.length;
      const items = rows.slice((current - 1) * limit, current * limit);
      return { section, page: current, size: limit, total, pages: Math.max(1, Math.ceil(total / limit)), items, sections: ARCHIVE_SECTIONS };
    } catch { return { section, page: 1, size: 0, total: 0, pages: 1, items: [], error: 'academy_missing' }; }
  }
  if (section === 'activity') {
    const limit = clean(size, 15, 1, 100);
    const total = db.prepare('SELECT COUNT(*) c FROM agent_events').get().c;
    const items = db.prepare('SELECT id, event_type, task_id, created_at, payload FROM agent_events ORDER BY id DESC LIMIT ? OFFSET ?').all(limit, (current - 1) * limit)
      .map((row) => {
        let payload = null;
        try { payload = JSON.parse(row.payload ?? 'null'); } catch { payload = null; }
        const note = payload?.note ?? payload?.reason ?? (payload?.text ? String(payload.text).slice(0, 40) : '') ?? '';
        return { id: row.id, type: row.event_type, task_id: row.task_id, at: row.created_at, note, state: payload?.status ?? null };
      });
    return { section, page: current, size: limit, total, pages: Math.max(1, Math.ceil(total / limit)), items };
  }
  const douyin = openReadOnly(douyinPath(root));
  if (!douyin) return { section, page: current, size: clean(size, 8, 1, 50), total: 0, pages: 1, items: [], error: 'douyin_db_missing' };
  try {
    if (section === 'works') {
      const limit = clean(size, 6, 1, 30);
      const total = douyin.prepare('SELECT COUNT(*) c FROM works').get().c;
      return { section, page: current, size: limit, total, pages: Math.max(1, Math.ceil(total / limit)), items: readWorks(douyin, current, limit) };
    }
    if (section === 'hot') {
      const limit = clean(size, 10, 1, 50);
      const clauses = [];
      const params = [];
      if (work) { clauses.push('video_id=?'); params.push(work); }
      if (replied === 'yes') clauses.push('replied_at IS NOT NULL');
      if (replied === 'no') clauses.push('replied_at IS NULL');
      const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
      const total = douyin.prepare(`SELECT COUNT(*) c FROM hot_comments ${where}`).get(...params).c;
      return { section, page: current, size: limit, total, pages: Math.max(1, Math.ceil(total / limit)), items: readHotComments(douyin, current, limit, work, replied) };
    }
    if (section === 'comments') {
      const limit = clean(size, 8, 1, 50);
      const clauses = [];
      const params = [];
      if (work) { clauses.push('work_id=?'); params.push(work); }
      if (replied === 'yes') clauses.push('replied_at IS NOT NULL');
      if (replied === 'no') clauses.push('replied_at IS NULL');
      const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
      const total = douyin.prepare(`SELECT COUNT(*) c FROM comments ${where}`).get(...params).c;
      return { section, page: current, size: limit, total, pages: Math.max(1, Math.ceil(total / limit)), items: readComments(douyin, current, limit, work, replied) };
    }
  } finally { douyin.close(); }
  return { section, page: 1, size: 8, total: 0, pages: 1, items: [], error: 'unknown_section' };
}

function readModel(root) {
  try {
    const file = join(runtimeDir(root), 'dsh-home', 'dsh-pet', 'standalone-ai.json');
    const settings = JSON.parse(readFileSync(file, 'utf8'));
    return { model: settings.model ?? null, base_url: settings.baseUrl ?? null };
  } catch { return { model: null, base_url: null }; }
}
