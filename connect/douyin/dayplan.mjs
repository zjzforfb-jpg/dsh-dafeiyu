/**
 * 每日日程：早上按今天的心情排一天的活儿，落成时间点（slot），scheduler 到点执行。
 * 规则骨架先定死（时间窗、间隔、配额），后面的 LLM 只能改理由、不能改时间与配额。
 */
export const LABELS = {
  'douyin.check_interactions': '看一眼互动消息',
  'douyin.reply_comments': '回收到的评论',
  'douyin.hot_comment_round': '去爆款视频底下挑热评回',
  'douyin.browse': '刷刷抖音找灵感',
  'academy.study': '学 25 分钟课程',
  'academy.weekly': '写这周的成长日记',
  'douyin.prepare': '准备一条图文（等你审主题）',
  'douyin.publish': '把准备好的作品发出去',
};

/** 可以自动执行、不用等爸爸点头的动作。 */
export const AUTO_ACTIONS = new Set(['douyin.check_interactions', 'douyin.reply_comments', 'douyin.browse', 'douyin.hot_comment_round', 'academy.study', 'academy.weekly']);
/** 会碰账号/需要人点头的动作：到点只建任务、发提醒，不自动跑。 */
export const CONFIRM_ACTIONS = new Set(['douyin.publish', 'douyin.prepare']);

export function dayStartMs(day) {
  return Date.parse(`${day}T00:00:00+08:00`);
}

export function atClock(day, hour, minute = 0) {
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return Date.parse(`${day}T${hh}:${mm}:00+08:00`);
}

export function clockOf(ms) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
}

export function initPlans(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS daily_plans(
    day TEXT PRIMARY KEY, mood TEXT, energy REAL, summary TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS plan_slots(
    id TEXT PRIMARY KEY, day TEXT NOT NULL, at_ms INTEGER NOT NULL, action TEXT NOT NULL, args TEXT,
    status TEXT NOT NULL DEFAULT 'planned', task_id TEXT, fired_at INTEGER, note TEXT,
    UNIQUE(day, at_ms, action));
  CREATE INDEX IF NOT EXISTS plan_slots_due ON plan_slots(status, at_ms);
  CREATE TABLE IF NOT EXISTS scheduled_runs(
    key TEXT PRIMARY KEY, ran_at INTEGER NOT NULL, result TEXT);`);
}

/**
 * 生成一天的日程。
 * 上满：10 个爆款视频 × 2 条热评 = 20 条，拆成 5 轮（每轮 2 视频 × 2 条），受 5 条/小时、90 秒间隔约束。
 */
export function buildPlan({ day, mood = 'calm', energy = 0.6, rounds = null } = {}) {
  const slots = [];
  const add = (hour, minute, action, args = {}) => {
    slots.push({
      id: `${day}-${String(slots.length + 1).padStart(2, '0')}`,
      day,
      at_ms: atClock(day, hour, minute),
      action,
      args,
      status: 'planned',
    });
  };
  add(9, 30, 'douyin.check_interactions');
  add(11, 0, 'douyin.reply_comments');
  const hotTimes = rounds ?? (energy >= 0.5
    ? [[12, 0], [14, 0], [16, 0], [18, 30], [21, 0]]
    : [[13, 0], [17, 0]]);
  for (const [hour, minute] of hotTimes) add(hour, minute, 'douyin.hot_comment_round', { videos: 2, perVideo: 2 });
  if (energy >= 0.45) add(20, 0, 'academy.study', { minutes: 25 });
  // 早中晚各一条「日常生活」图文：自动写好停在发布前，等爸爸回「发」。
  // 周日晚上写周记（一周一次）。
  const weekday = new Date(dayStartMs(day) + 8 * 3600_000).getUTCDay();
  if (weekday === 0) add(21, 0, 'academy.weekly');
  add(8, 30, 'douyin.daily_post', { slot: 'morning' });
  add(12, 30, 'douyin.daily_post', { slot: 'noon' });
  add(19, 30, 'douyin.daily_post', { slot: 'evening' });
  slots.sort((a, b) => a.at_ms - b.at_ms);
  slots.forEach((slot, index) => { slot.id = `${day}-${String(index + 1).padStart(2, '0')}`; });
  const summary = energy >= 0.7
    ? '今天电量足：5 轮热评、回评论、学一课，早中晚各写一条日常。'
    : energy >= 0.45
      ? '今天正常节奏：热评几轮、回评论、学一课，日常三篇。'
      : '今天省着点：两轮热评、回评论，日常还是三篇。';
  return { day, mood, energy, summary, slots };
}

export function savePlan(db, plan, now = Date.now()) {
  db.prepare('INSERT INTO daily_plans(day,mood,energy,summary,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(day) DO UPDATE SET mood=excluded.mood,energy=excluded.energy,summary=excluded.summary,updated_at=excluded.updated_at')
    .run(plan.day, plan.mood ?? null, plan.energy ?? null, plan.summary ?? null, now, now);
  const insert = db.prepare('INSERT OR IGNORE INTO plan_slots(id,day,at_ms,action,args,status) VALUES(?,?,?,?,?,?)');
  for (const slot of plan.slots ?? []) insert.run(slot.id, slot.day, slot.at_ms, slot.action, JSON.stringify(slot.args ?? {}), slot.status ?? 'planned');
  return readPlan(db, plan.day);
}

export function readPlan(db, day) {
  const row = db.prepare('SELECT * FROM daily_plans WHERE day=?').get(day);
  if (!row) return null;
  const slots = db.prepare('SELECT * FROM plan_slots WHERE day=? ORDER BY at_ms ASC').all(day)
    .map((slot) => ({ ...slot, args: safeJson(slot.args) }));
  return { ...row, slots };
}

function safeJson(value) {
  try { return JSON.parse(value ?? '{}'); } catch { return {}; }
}

/** 到点该干的活儿（最多 limit 条，避免一次补跑一大串）。 */
export function dueSlots(db, now = Date.now(), limit = 3) {
  return db.prepare("SELECT * FROM plan_slots WHERE status='planned' AND at_ms<=? ORDER BY at_ms ASC LIMIT ?")
    .all(now, Math.max(1, Math.min(20, Number(limit) || 3)))
    .map((slot) => ({ ...slot, args: safeJson(slot.args) }));
}

export function markSlot(db, id, { status, taskId = null, firedAt = null, note = null } = {}) {
  db.prepare('UPDATE plan_slots SET status=COALESCE(?,status), task_id=COALESCE(?,task_id), fired_at=COALESCE(?,fired_at), note=COALESCE(?,note) WHERE id=?')
    .run(status ?? null, taskId, firedAt, note, id);
}

export function slotTask(db, id) {
  return db.prepare("SELECT task_id FROM plan_slots WHERE id=?").get(id)?.task_id ?? null;
}

export function planText(plan, mood) {
  if (!plan) return '';
  const lines = (plan.slots ?? []).map((slot) => `· ${clockOf(slot.at_ms)} ${LABELS[slot.action] ?? slot.action}`);
  const head = `今天心情：${mood?.mood ?? plan.mood ?? 'calm'}${mood?.why ? `（${mood.why}）` : ''}`;
  return ['今天的日程', head, ...lines].join('\n');
}

export function hasRun(db, key) {
  return Boolean(db.prepare('SELECT 1 FROM scheduled_runs WHERE key=?').get(key));
}

export function markRun(db, key, result = '', now = Date.now()) {
  db.prepare('INSERT OR REPLACE INTO scheduled_runs(key,ran_at,result) VALUES(?,?,?)').run(key, now, String(result ?? '').slice(0, 200));
}
