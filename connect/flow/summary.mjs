// /flow 页面用的一次性汇总：每个阶段最近一次事件 + 每个动作最近一次判定结论。
//
// 为什么不复用 /api/live/*：那套要 Bearer 令牌，而 /flow 是个可以直接打开看的页面
// （和 /arch 一样，只暴露事件类型、时间、判定，不含 payload 正文）。
import { hasTable } from '../core/migrations.mjs';
import { PIPELINE, stageOfEvent } from '../core/pipeline.mjs';
import { ACTIONS } from '../actions.mjs';
import { summarizeFailures } from '../live/failures.mjs';

const parse = (raw) => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } };

/** 阶段 → { count, lastAt, lastEvent }，只统计近 windowMs 内的事件。 */
export function stageSummary(db, { now = Date.now(), windowMs = 24 * 3600_000 } = {}) {
  const since = new Date(now - windowMs).toISOString();
  const stages = Object.fromEntries(PIPELINE.map((s) => [s.id, { count: 0, lastAt: null, lastEvent: null }]));
  let rows = [];
  try {
    rows = db.prepare('SELECT event_type, created_at FROM agent_events WHERE created_at >= ? ORDER BY rowid DESC LIMIT 3000').all(since);
  } catch { rows = []; }
  for (const row of rows) {
    const stage = stageOfEvent(row.event_type);
    const bucket = stages[stage];
    if (!bucket) continue;
    bucket.count += 1;
    if (!bucket.lastAt) { bucket.lastAt = row.created_at; bucket.lastEvent = row.event_type; }
  }
  return stages;
}

/** 动作 → 最近一次判定（verdict / reason / 时间）。 */
export function verdictSummary(db, { now = Date.now() } = {}) {
  const out = {};
  try {
    if (!hasTable(db, 'task_checkpoints')) return out;
    let rows = [];
    try {
      rows = db.prepare("SELECT operation, verdict, reason, created_ms, task_id FROM task_checkpoints WHERE operation != '' ORDER BY id DESC LIMIT 400").all();
    } catch {
      rows = db.prepare("SELECT operation, verdict, created_ms, task_id FROM task_checkpoints WHERE operation != '' ORDER BY id DESC LIMIT 400").all();
    }
    const history = {};
    for (const row of rows) {
      if (!row.operation) continue;
      const entry = { verdict: row.verdict, reason: row.reason ?? '', at: new Date(Number(row.created_ms)).toISOString(), taskId: row.task_id ?? null };
      if (!history[row.operation]) history[row.operation] = [];
      // 注意：entry 是同一个对象引用，history 里若直接塞 entry 会和 out 互指（JSON 循环）
      if (history[row.operation].length < 3) history[row.operation].push({ ...entry });
      if (!out[row.operation]) out[row.operation] = entry;
    }
    // 每个动作最多再带 3 条历史（页面侧面板用，不额外暴露 payload）
    for (const [operation, entries] of Object.entries(history)) {
      if (out[operation]) out[operation].history = entries;
    }
    // 近 7 天跑了几次（首页能力卡要用）
    try {
      const sinceMs = now - 7 * 24 * 3600_000;
      for (const row of db.prepare('SELECT operation, COUNT(*) n FROM task_checkpoints WHERE operation != ? AND created_ms >= ? GROUP BY operation').all('', sinceMs)) {
        if (out[row.operation]) out[row.operation].weekRuns = Number(row.n);
      }
    } catch { /* 老库没有 created_ms */ }
  } catch { /* 老库没有这张表 */ }
  return out;
}

/**
 * 覆盖度：动作总数里，有证据（confirmed）/ 未确认 / 失败 / 没跑过 各几个。
 * 口径与 /live 的 toolList.coverage 一致，两边数字必须一样。
 */
export function coverageSummary(tools) {
  const names = Object.keys(ACTIONS).filter((name) => ACTIONS[name] && !ACTIONS[name].offline);
  const cov = { total: names.length, confirmed: 0, unconfirmed: 0, failed: 0, untested: 0 };
  for (const name of names) {
    const verdict = tools?.[name]?.verdict;
    if (!verdict) cov.untested += 1;
    else if (verdict === 'confirmed') cov.confirmed += 1;
    else if (verdict === 'unconfirmed') cov.unconfirmed += 1;
    else cov.failed += 1;
  }
  return cov;
}

export function flowSummary(db, { now = Date.now() } = {}) {
  const stages = stageSummary(db, { now });
  const totals = { events: 0, actions: 0, fails: 0 };
  for (const bucket of Object.values(stages)) {
    totals.events += bucket.count;
  }
  // 执行/失败按事件类型数（和 /live 顶栏同口径）
  try {
    const since = new Date(now - 24 * 3600_000).toISOString();
    const row = db.prepare("SELECT SUM(CASE WHEN event_type IN ('action_started','action_finished','action_failed') THEN 1 ELSE 0 END) a, SUM(CASE WHEN event_type='action_failed' THEN 1 ELSE 0 END) f FROM agent_events WHERE created_at >= ?").get(since);
    totals.actions = Number(row?.a ?? 0);
    totals.fails = Number(row?.f ?? 0);
  } catch { /* 空库 */ }
  // 首页要用的「今天四个数」：不带令牌也能看到，别让主人为了看数字去翻令牌
  const today = { events: 0, actions: 0, fails: 0, awaiting: 0 };
  try {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const since = start.toISOString();
    const row = db.prepare("SELECT COUNT(*) e, SUM(CASE WHEN event_type IN ('action_started','action_finished','action_failed') THEN 1 ELSE 0 END) a, SUM(CASE WHEN event_type='action_failed' THEN 1 ELSE 0 END) f FROM agent_events WHERE created_at >= ?").get(since);
    today.events = Number(row?.e ?? 0);
    today.actions = Number(row?.a ?? 0);
    today.fails = Number(row?.f ?? 0);
    const pending = db.prepare("SELECT COUNT(*) n FROM external_tasks WHERE status = 'awaiting_confirmation'").get();
    today.awaiting = Number(pending?.n ?? 0);
  } catch { /* 空库或没有 external_tasks 表 */ }
  const tools = verdictSummary(db);
  // 最近一次「授权项就绪」核验（预检写入 preflight_checked，10 分钟一个桶）
  let readiness = null;
  try {
    const row = db.prepare("SELECT payload, created_at FROM agent_events WHERE event_type='preflight_checked' ORDER BY id DESC LIMIT 1").get();
    if (row) {
      const payload = parse(row.payload) ?? {};
      readiness = { ready: Number(payload.ready ?? 0), total: Number(payload.total ?? 0), missing: payload.missing ?? [], at: row.created_at };
    }
  } catch { /* 老库还没有这类事件 */ }
  // 近 7 天失败按原因归类（首页/数据流都要用，公开接口里只给计数与动作名，不带 payload）
  let failures = { total: 0, buckets: [] };
  try {
    const rows = db.prepare("SELECT verdict, reason, created_ms, task_id FROM task_checkpoints WHERE verdict IN ('failed','mismatched','unconfirmed') AND created_ms >= ?").all(now - 7 * 86_400_000);
    failures = summarizeFailures(rows);
  } catch { /* 空库或还没建表 */ }
  return { now: new Date(now).toISOString(), stages, tools, failures, readiness, coverage: coverageSummary(tools), totals, today };
}

export { parse };
