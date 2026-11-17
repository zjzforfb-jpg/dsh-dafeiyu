/**
 * D-2 统一跨渠道日配额（单一真源）。
 *
 * 背景：QQ（connect/qq/store.mjs 的 qq_usage）、iLink（connect/ilink/store.mjs 的 ilink_usage）、
 * life（BRAIN 库的 daily_usage）三套日配额各写各的，语义重复。这里合并成一张 daily_budget：
 *
 * - 只有一份跨渠道共享的计数——各渠道占用的是同一格（这才叫「合并为一个跨渠道日配额」）。
 *   表落在调用方传进来的 db handle 上：QQ/iLink 传 CONNECT 库 handle（runtime/connect/connect.sqlite，
 *   它们本来就是）；life 侧由 life/manager.mjs 的 budgetDb 接线同一个 CONNECT handle。
 * - 两个独立维度：model_calls 与 autonomous_actions（计划点名的两个）；
 *   voice_requests 是语音渠道的细分计数（第三个字段，不是「两个独立维度」之一）。
 * - 上限统一由 DAILY_BUDGET 给出（跨渠道共享上限），不再各渠道各写各的上限。
 *
 * modelCalls 取 60：QQ 主链路原来 50/天、iLink 50/天、life 4/天，合并后共享一个 60/天 的模型池，
 * QQ 不被饿死，又比三套各写各的更省。
 */

export const DAILY_BUDGET = Object.freeze({ modelCalls: 60, autonomousActions: 2, voiceRequests: 50 });

// 维度白名单：只有这三个列名会被拼进 SQL，防注入（与原 connect/qq/store.mjs:99 reserve 的 column 白名单同思路）。
const LIMITS = Object.freeze({
  model_calls: DAILY_BUDGET.modelCalls,
  autonomous_actions: DAILY_BUDGET.autonomousActions,
  voice_requests: DAILY_BUDGET.voiceRequests,
});

function dimensionLimit(dimension, limit) {
  const unified = LIMITS[dimension];
  if (unified === undefined) throw new Error('invalid_budget_dimension');
  // 可选 limit 是调用方自设封顶（保留旧 QQ reserve(db, day, column, limit) 的 limit=3 语义兼容），
  // 与统一上限取更小值：任何调用方都不可能突破 DAILY_BUDGET，计数仍是同一格共享。
  return limit == null ? unified : Math.min(unified, Number(limit));
}

/** 幂等建表（可以重复调用，不重置已有计数）。 */
export function initBudget(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS daily_budget (
    day TEXT PRIMARY KEY,
    model_calls INTEGER NOT NULL DEFAULT 0,
    autonomous_actions INTEGER NOT NULL DEFAULT 0,
    voice_requests INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
}

/**
 * 原子占用一个维度的一格：BEGIN IMMEDIATE + 上限判断 + COMMIT
 * （与原 life/tasks.mjs reserveModelCall 的 BEGIN IMMEDIATE 版语义一致）。
 *
 * @param dimension 'model_calls' | 'autonomous_actions' | 'voice_requests'（白名单校验通过后列名才拼进 SQL）
 * @param limit 可选调用方自设封顶，与统一上限取 min（见 dimensionLimit）
 * @returns true=占用成功；false=当日该维度已超限（不越界）
 */
export function reserve(db, day, dimension, limit = null) {
  const cap = dimensionLimit(dimension, limit); // 非法维度在这里抛 invalid_budget_dimension，不会走到 SQL
  initBudget(db);
  backfillLegacyUsage(db, day); // 迁移当天不白送额度（只做一次）
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT OR IGNORE INTO daily_budget (day) VALUES (?)').run(day);
    const row = db.prepare(`SELECT ${dimension} AS used FROM daily_budget WHERE day = ?`).get(day);
    if (row.used >= cap) { db.exec('ROLLBACK'); return false; }
    db.prepare(`UPDATE daily_budget SET ${dimension} = ${dimension} + 1, updated_at = datetime('now') WHERE day = ?`).run(day);
    db.exec('COMMIT');
    return true;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function reserveModelCall(db, day, limit = null) { return reserve(db, day, 'model_calls', limit); }
export function reserveAutonomousAction(db, day, limit = null) { return reserve(db, day, 'autonomous_actions', limit); }
export function reserveVoiceRequest(db, day, limit = null) { return reserve(db, day, 'voice_requests', limit); }

/**
 * 旧三套配额的当日计数（表名 → 维度）。迁移前 QQ/iLink/life 各记各的，
 * 迁移后统一进 daily_budget——如果不把当日已经用掉的量带过来，
 * 等于迁移当天白送一份额度。表不存在就跳过（全新库没有旧表）。
 */
const LEGACY_SOURCES = Object.freeze([
  { table: 'qq_usage', dimension: 'model_calls' },
  { table: 'qq_usage', dimension: 'voice_requests' },
  { table: 'ilink_usage', dimension: 'model_calls' },
  { table: 'ilink_usage', dimension: 'voice_requests' },
  { table: 'daily_usage', dimension: 'model_calls' },
  { table: 'daily_usage', dimension: 'autonomous_actions' },
]);

// 每个 db handle、每一天只回填一次（进程内记忆，避免每次 reserve 都查旧表）。
const backfilled = new WeakMap();

export function legacyUsage(db, day) {
  const floors = { model_calls: 0, autonomous_actions: 0, voice_requests: 0 };
  for (const source of LEGACY_SOURCES) {
    try {
      const row = db.prepare(`SELECT COALESCE(SUM(${source.dimension}), 0) AS total FROM ${source.table} WHERE day = ?`).get(day);
      floors[source.dimension] += Number(row?.total ?? 0);
    } catch {
      // 旧表不存在（或没有这一列）——这一路没有历史可搬。
    }
  }
  return floors;
}

/**
 * 「只增不减」地抬高某一天的计数：daily_budget.count 取 max(现有, floor)。
 * 不会把已经记好的新计数改小，所以重复调用是安全的。
 */
export function ratchetBudget(db, day, floors = {}) {
  initBudget(db);
  db.prepare('INSERT OR IGNORE INTO daily_budget (day) VALUES (?)').run(day);
  for (const dimension of Object.keys(LIMITS)) {
    const floor = Number(floors[dimension] ?? 0);
    if (!Number.isFinite(floor) || floor <= 0) continue;
    db.prepare(`UPDATE daily_budget SET ${dimension} = MAX(${dimension}, ?), updated_at = datetime('now') WHERE day = ?`).run(Math.floor(floor), day);
  }
  return budgetUsage(db, day);
}

/**
 * 把旧三套配额当日已用的量棘轮进统一表。迁移当天不会凭空多出额度。
 * 只对当前 db handle 里的旧表有效——life 的旧表在 BRAIN 库，由调用方
 * 用 ratchetBudget 显式搬（见 life/manager.mjs）。
 */
export function backfillLegacyUsage(db, day) {
  let days = backfilled.get(db);
  if (!days) { days = new Set(); backfilled.set(db, days); }
  if (days.has(day)) return false;
  const floors = legacyUsage(db, day);
  if (!floors.model_calls && !floors.autonomous_actions && !floors.voice_requests) { days.add(day); return false; }
  ratchetBudget(db, day, floors);
  days.add(day);
  return true;
}

/**
 * 当日用量 + 上限。缺表/缺行都回 0（connect/board.mjs 传的是只读 handle，可能还没建表，不能自动建）。
 * @returns { day, model_calls, autonomous_actions, voice_requests, limits: { modelCalls, autonomousActions, voiceRequests } }
 */
export function budgetUsage(db, day) {
  try { backfillLegacyUsage(db, day); } catch { /* 只读 handle 改不动计数，照读即可。 */ }
  let row = null;
  try {
    row = db.prepare('SELECT model_calls, autonomous_actions, voice_requests FROM daily_budget WHERE day = ?').get(day) ?? null;
  } catch (error) {
    if (!/no such table/i.test(String(error?.message ?? error))) throw error;
  }
  return {
    day,
    model_calls: row?.model_calls ?? 0,
    autonomous_actions: row?.autonomous_actions ?? 0,
    voice_requests: row?.voice_requests ?? 0,
    limits: { ...DAILY_BUDGET },
  };
}
