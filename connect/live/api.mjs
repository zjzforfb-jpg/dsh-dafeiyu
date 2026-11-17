/**
 * 实时工作流控制台的接口层（GET /api/live/*）。
 *
 * 全部只读：这层只负责把库里的「事实」按页面的形状拼好，
 * 不触发任何动作，也不改任何状态。
 */
import { CAPABILITY_MAP } from '../core/capability-map.mjs';
import { SKILL_DEFS } from '../skills/defs.mjs';
import { hasTable } from '../core/migrations.mjs';
import { summarizeFailures, reasonBucket } from './failures.mjs';
import { loadRunAllowlist } from './run-policy.mjs';
import { recentRuns } from './run-log.mjs';
import { publishFlowState } from './publish-flow.mjs';
import { LEVELS, TOOL_ONLY_META, expectOf, levelOf, metaOf } from './tool-meta.mjs';
import { RETIRED_ACTIONS } from './retired.mjs';
import { contractOf, contractSummary } from './contract.mjs';
import { channelLabel, digestOf, EVENT_ROUTE, stageForEvent, stateOfStatus, STAGES } from './catalog.mjs';

const MAX_ROWS = 200;
const parse = (value) => {
  if (value == null) return null;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
};
const clock = (iso) => {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

/** 今天的起点（本地时区）转 ISO，用于 created_at >= ?（库里存的是 UTC ISO 字符串）。 */
export function dayStartIso(now = Date.now()) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.toISOString();
}

export function eventView(row) {
  const payload = parse(row.payload);
  const route = stageForEvent({ eventType: row.event_type, payload });
  return {
    id: row.id,
    rowid: Number(row._rowid ?? 0) || null,
    eventType: row.event_type,
    channel: row.channel,
    channelLabel: channelLabel(row.channel),
    actor: row.actor ?? null,
    taskId: row.task_id ?? null,
    createdAt: row.created_at,
    clock: clock(row.created_at),
    stage: route.stage,
    state: route.state,
    summary: digestOf(payload),
  };
}

/** 事件详情：完整输入（payload）与输出（result/evidence），一眼能看到「它收到了什么、回了什么」。 */
export function eventDetail(db, id) {
  const row = db.prepare('SELECT * FROM agent_events WHERE id = ?').get(id);
  if (!row) return null;
  const task = row.task_id
    ? db.prepare('SELECT id, intent, status, origin, conv_kind, conv_id, attempts, created_ms, updated_ms FROM external_tasks WHERE id = ?').get(row.task_id) ?? null
    : null;
  const view = eventView(row);
  return {
    ok: true,
    event: {
      ...view,
      skillRunId: row.skill_run_id ?? null,
      privacyScope: row.privacy_scope ?? null,
      dedupeKey: row.dedupe_key ?? null,
      input: parse(row.payload),
      output: parse(row.result),
      evidence: parse(row.evidence),
    },
    task: task ? { ...task, state: stateOfStatus(task.status) } : null,
  };
}

/** 任务详情：任务头 + 每一步（事件时间线），每步都带输入/输出。 */
export function taskDetail(db, id) {
  const task = db.prepare('SELECT * FROM external_tasks WHERE id = ?').get(id);
  if (!task) return null;
  const working = db.prepare('SELECT * FROM working_tasks WHERE task_id = ?').get(id) ?? null;
  const rows = db.prepare('SELECT * FROM agent_events WHERE task_id = ? ORDER BY rowid LIMIT ?').all(id, MAX_ROWS);
  const steps = rows.map((row) => eventView(row));
  const detailSteps = rows.map((row) => ({
    ...eventView(row),
    input: parse(row.payload),
    output: parse(row.result),
    evidence: parse(row.evidence),
  }));
  const lastFail = [...detailSteps].reverse().find((step) => step.state === 'fail');
  return {
    ok: true,
    task: {
      id: task.id,
      intent: task.intent,
      status: task.status,
      state: stateOfStatus(task.status),
      origin: task.origin ?? null,
      convKind: task.conv_kind ?? null,
      convId: task.conv_id ?? null,
      attempts: task.attempts ?? 0,
      createdMs: task.created_ms ?? null,
      updatedMs: task.updated_ms ?? null,
      payload: parse(task.payload),
      result: parse(task.result),
      evidence: parse(task.evidence),
      idempotencyKey: task.idempotency_key ?? null,
    },
    working: working ? {
      status: working.status,
      state: stateOfStatus(working.status),
      goal: working.goal ?? null,
      environment: parse(working.environment),
      currentStep: working.current_step ?? null,
      selectedSkill: working.selected_skill ?? null,
      nextAction: working.next_action ?? null,
      retryCount: working.retry_count ?? 0,
      plan: parse(working.plan_json),
      strategy: working.selected_strategy ?? null,
    } : null,
    steps: detailSteps,
    summary: {
      total: steps.length,
      failed: steps.filter((step) => step.state === 'fail').length,
      lastFail: lastFail ? { eventType: lastFail.eventType, summary: lastFail.summary, at: lastFail.createdAt } : null,
    },
  };
}

/** 今日/某天的计划槽：定时任务有没有跑、失败原因是什么（note 原文，不截断）。 */
export function slotList(db, day) {
  const rows = db.prepare('SELECT * FROM plan_slots WHERE day = ? ORDER BY at_ms LIMIT 60').all(day);
  const counts = { planned: 0, fired: 0, done: 0, failed: 0, skipped: 0 };
  for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
  return {
    day,
    counts,
    slots: rows.map((row) => ({
      id: row.id,
      action: row.action,
      atMs: row.at_ms,
      clock: clock(new Date(row.at_ms).toISOString()),
      status: row.status,
      state: stateOfStatus(row.status),
      taskId: row.task_id ?? null,
      note: row.note ?? '',
      args: parse(row.args),
      firedAt: row.fired_at ?? null,
    })),
  };
}

/** 动作/工具/技能清单：能力映射表 + 近 7 天运行统计。 */
const PUBLISH_ACTIONS = new Set(['douyin.publish', 'douyin.publish_draft', 'douyin.publish_video']);

export function toolList(db, now = Date.now(), { realOnly = false } = {}) {
  // realOnly：只在「真实业务」上算账——排除我在页面上点着跑的 ui-run-* 记录
  const uiFilter = realOnly ? " AND task_id NOT LIKE 'ui-run-%'" : '';
  const since = new Date(now - 7 * 24 * 3600_000).toISOString();
  // 全新库（还没写过任何事件）里 agent_events 可能不存在，别让整个工具清单 500
  let rows = [];
  try {
    rows = db.prepare("SELECT event_type, payload, created_at FROM agent_events WHERE event_type IN ('action_started','action_finished','action_failed','receipt_verified') AND created_at >= ? ORDER BY rowid DESC LIMIT 400").all(since);
  } catch { rows = []; }
  const stats = new Map();
  const bump = (name, kind, at) => {
    if (!name) return;
    const item = stats.get(name) ?? { started: 0, ok: 0, fail: 0, lastAt: null, lastState: null };
    item[kind] += 1;
    if (!item.lastAt || at > item.lastAt) { item.lastAt = at; item.lastState = kind; }
    stats.set(name, item);
  };
  for (const row of rows) {
    const payload = parse(row.payload) ?? {};
    const name = payload.operation ?? payload.action ?? payload.tool ?? null;
    if (row.event_type === 'action_started') bump(name, 'started', row.created_at);
    else if (row.event_type === 'action_finished') bump(name, 'ok', row.created_at);
    else if (row.event_type === 'action_failed') bump(name, 'fail', row.created_at);
  }
  // 最近一次「判定结论」：task_checkpoints 里每个动作最后一条的 verdict
  const verdicts = new Map();
  // 每个动作最近几条判定（时间倒序），让「这周一共跑了几次、几次没活干」有据可查
  const history = new Map();
  const reasonStats = new Map();
  const trends = new Map();
  const week = {};
  const quotaSkips = {};
  const emptyStats = new Map();
  try {
    if (hasTable(db, 'task_checkpoints')) {
      // reason 列是后加的：老库里还没有时退回不带 reason 的查询，别让整张工具清单空掉
      let judged = [];
      try {
        judged = db.prepare(`SELECT operation, verdict, reason, created_ms, task_id FROM task_checkpoints WHERE operation != ''${uiFilter} ORDER BY id DESC LIMIT 400`).all();
      } catch {
        judged = db.prepare(`SELECT operation, verdict, created_ms, task_id FROM task_checkpoints WHERE operation != ''${uiFilter} ORDER BY id DESC LIMIT 400`).all();
      }
      // 本周（近 7 天）每个动作跑了几次：卡片上给个活跃度角标，不点进去也知道
      try {
        const sinceMs = now - 7 * 24 * 3600_000;
        for (const row of db.prepare(`SELECT operation, COUNT(*) n FROM task_checkpoints WHERE operation != ? AND created_ms >= ?${uiFilter} GROUP BY operation`).all('', sinceMs)) {
          week[row.operation] = Number(row.n);
        }
        // 「没活干」也要有量级：把一周内 nothing_to_do(n) 的 n 和跳过原因加起来
        for (const row of db.prepare(`SELECT operation, reason FROM task_checkpoints WHERE operation != ? AND created_ms >= ? AND reason LIKE 'nothing_to_do%'${uiFilter}`).all('', sinceMs)) {
          const m = /^nothing_to_do(?:\((\d+)\))?(?::(.+))?$/u.exec(String(row.reason ?? ''));
          if (!m) continue;
          const bucket = emptyStats.get(row.operation) ?? { scanned: 0, breakdown: {} };
          bucket.scanned += Number(m[1] ?? 0);
          for (const part of String(m[2] ?? '').split(',').filter(Boolean)) {
            const [key, n] = part.split('×');
            bucket.breakdown[key] = (bucket.breakdown[key] ?? 0) + Number(n ?? 1);
          }
          emptyStats.set(row.operation, bucket);
        }
      } catch { /* 老库没有 created_ms 或表不存在 */ }
      // 按「原因类别」分组：同一个类别反复出现，才是「卡在哪」的答案（最近 5 条看不出来）。
      // 原始 reason 可能很长（`Command failed: …` 几百字），所以先归类再计数，样本只留 70 字。
      for (const row of db.prepare(`SELECT operation, reason, verdict FROM task_checkpoints
        WHERE operation != '' AND verdict != 'skipped' AND created_ms >= ?${uiFilter}`).all(now - 7 * 24 * 3600_000)) {
        if (!row.operation) continue;
        if (row.verdict === 'confirmed') continue; // 成功的不用分组（reasonBucket('ok') 会返回 null）
        const bucket = reasonBucket(row.reason);
        if (!bucket) continue;
        if (!reasonStats.has(row.operation)) reasonStats.set(row.operation, new Map());
        const map = reasonStats.get(row.operation);
        const hit = map.get(bucket.id) ?? { id: bucket.id, label: bucket.label, count: 0, sample: '' };
        hit.count += 1;
        if (!hit.sample && row.reason) hit.sample = String(row.reason).replace(/\s+/gu, ' ').slice(0, 70);
        map.set(bucket.id, hit);
      }
      // 近 5 周趋势：每周成功 / 未成功各几次（只存 5 个点，不做图表库）
      const WEEK = 7 * 24 * 3600_000;
      for (const row of db.prepare(`SELECT operation, verdict, created_ms FROM task_checkpoints
        WHERE operation != '' AND verdict != 'skipped' AND created_ms >= ?${uiFilter}`).all(now - 5 * WEEK)) {
        if (!row.operation) continue;
        const weeksAgo = Math.min(4, Math.floor((now - Number(row.created_ms)) / WEEK));
        if (!trends.has(row.operation)) {
          trends.set(row.operation, Array.from({ length: 5 }, (_, index) => ({ weeksAgo: 4 - index, ok: 0, bad: 0 })));
        }
        const slot = trends.get(row.operation).find((point) => point.weeksAgo === weeksAgo);
        if (!slot) continue;
        if (row.verdict === 'confirmed') slot.ok += 1;
        else slot.bad += 1;
      }
      for (const row of judged) {
        if (!row.operation) continue;
        // 页面上手动跑的是 ui-run-<毫秒> 这种 taskId：标出来，别和定时任务的账混在一起
        const origin = String(row.task_id ?? '').startsWith('ui-run-') ? 'ui' : 'task';
        const entry = { verdict: row.verdict, reason: row.reason ?? '', at: new Date(Number(row.created_ms)).toISOString(), taskId: row.task_id ?? null, origin };
        // 历史要按动作累计（不是「每个动作只留一条」），最多 5 条；最新一条同时作为卡片上的「最近一次」
        if (!history.has(row.operation)) history.set(row.operation, []);
        const bucket = history.get(row.operation);
        if (bucket.length < 5) bucket.push(entry);
        if (!verdicts.has(row.operation)) verdicts.set(row.operation, entry);
      }
    }
  } catch { /* 老库没有这张表就不显示 */ }

  // 本周被「评论额度用完」挡住的次数：额度跳过的槽不写 checkpoint，只落在 plan_slots 的 note 里
  try {
    const since = new Date(now - 7 * 24 * 3600_000).toISOString().slice(0, 10);
    for (const row of db.prepare("SELECT action, COUNT(*) n FROM plan_slots WHERE day >= ? AND note LIKE 'quota_exhausted%' GROUP BY action").all(since)) {
      quotaSkips[row.action] = Number(row.n);
    }
  } catch { /* 没有 plan_slots 表（空库/老库） */ }

  // offline 的行是留档（likes / prepare 已下线），页面上不该再出现，否则等于给主人列一个用不了的入口
  const tools = CAPABILITY_MAP.filter((item) => !item.offline).map((item) => {
    const stat = stats.get(item.action) ?? null;
    const meta = metaOf(item.action, item.tool) ?? { title: item.label, file: '', intro: '', logic: '' };
    const level = levelOf(item.action, item.tool, item.risk ?? 'R0', Boolean(item.implemented));
    return {
      action: item.action,
      title: meta.title,
      file: meta.file,
      intro: meta.intro,
      logic: meta.logic,
      preflight: meta.preflight ?? [],
      command: meta.command ?? '',
      steps: meta.steps ?? [],
      // 跑完应该看到什么（只有 7 个有副作用的动作有）
      expect: expectOf(item.action),
      impact: meta.impact ?? '',
      uiRuns: recentRuns(process.cwd(), item.action, 3),
      flow: PUBLISH_ACTIONS.has(item.action) ? publishFlowState(db, process.cwd(), now) : null,
      level,
      levelLabel: LEVELS[level]?.label ?? level,
      levelColor: LEVELS[level]?.color ?? '#94a3b8',
      label: item.label,
      capability: item.capability ?? null,
      tool: item.tool ?? null,
      skill: item.skill ?? null,
      status: item.status ?? 'unknown',
      implemented: Boolean(item.implemented),
      risk: item.risk ?? 'R0',
      prompt: item.prompt ?? null,
      runs: stat?.started ?? 0,
      ok: stat?.ok ?? 0,
      fail: stat?.fail ?? 0,
      lastAt: stat?.lastAt ?? null,
      lastState: stat?.lastState ?? null,
      lastVerdict: verdicts.get(item.action)?.verdict ?? null,
      lastVerdictReason: verdicts.get(item.action)?.reason || null,
      lastVerdictAt: verdicts.get(item.action)?.at ?? null,
      history: history.get(item.action) ?? [],
      // 近 7 天「按原因分组」的判定统计（最多 6 类），页面用它回答「到底卡在哪」
      reasons: [...(reasonStats.get(item.action)?.values() ?? [])].sort((a, b) => b.count - a.count).slice(0, 6),
      trend: trends.get(item.action) ?? [],
      weekRuns: week[item.action] ?? 0,
      // 「本周 N 次」里被额度挡住的次数：单独给一列，页面就能说「真跑了 6 次 + 被额度挡 3 次」
      weekQuotaSkips: quotaSkips[item.action] ?? 0,
      weekScanned: emptyStats.get(item.action)?.scanned ?? 0,
      weekBreakdown: emptyStats.get(item.action)?.breakdown ?? null,
    };
  });
  // 只读工具（没有自主动作）也要出现在清单里，否则「大肥鱼会用哪些工具」是残缺的。
  const extra = Object.entries(TOOL_ONLY_META).map(([tool, meta]) => ({
    // 只读工具没有自主动作，但页面/API 统一按 action 取标识，这里填同名，避免调用方各自判空
    action: tool, title: meta.title, file: meta.file, intro: meta.intro, logic: meta.logic,
    // 只读工具不走判定链（不写 task_checkpoints），页面上别把它算成「没跑过」
    readOnly: true,
    uiRuns: recentRuns(process.cwd(), tool, 3),
    flow: null,
    impact: meta.impact ?? '',
    expect: expectOf(tool),
    level: meta.level, levelLabel: LEVELS[meta.level]?.label ?? meta.level, levelColor: LEVELS[meta.level]?.color ?? '#94a3b8',
    label: meta.title, capability: null, tool, skill: null, status: 'stable', implemented: true, risk: 'R0', prompt: null,
    runs: stats.get(tool)?.started ?? 0, ok: stats.get(tool)?.ok ?? 0, fail: stats.get(tool)?.fail ?? 0,
    lastAt: stats.get(tool)?.lastAt ?? null, lastState: stats.get(tool)?.lastState ?? null,
    // 只读工具一般没有步骤快照，但万一有人按动作跑过它（比如误用），结论也要如实显示
    lastVerdict: verdicts.get(tool)?.verdict ?? null,
    lastVerdictReason: verdicts.get(tool)?.reason || null,
    lastVerdictAt: verdicts.get(tool)?.at ?? null,
    history: history.get(tool) ?? [],
    reasons: [...(reasonStats.get(tool)?.values() ?? [])].sort((a, b) => b.count - a.count).slice(0, 6),
    trend: trends.get(tool) ?? [],
    weekRuns: week[tool] ?? 0,
    weekScanned: emptyStats.get(tool)?.scanned ?? 0,
    weekBreakdown: emptyStats.get(tool)?.breakdown ?? null,
  }));
  // 覆盖度：16 个动作里几个有证据、几个从没跑过——目标就是把这个条填满
  const coverage = { total: 0, confirmed: 0, unconfirmed: 0, failed: 0, untested: 0 };
  for (const item of tools) {
    coverage.total += 1;
    if (item.lastVerdict === 'confirmed') coverage.confirmed += 1;
    else if (item.lastVerdict === 'unconfirmed') coverage.unconfirmed += 1;
    else if (item.lastVerdict === 'failed' || item.lastVerdict === 'mismatched') coverage.failed += 1;
    else coverage.untested += 1;
  }
  // 契约体检：说明书 / 前置 / 跑后判定 三件是否齐（缺哪件页面上直接标）
  const allItems = [...tools, ...extra];
  const contracts = {};
  for (const item of allItems) contracts[item.action] = contractOf(item.action);
  return {
    coverage,
    contracts,
    contractSummary: contractSummary(tools.map((item) => item.action)),
    // 已下线的动作（菜单里没有了，但原因要留档，页面底部会列出来）
    retired: RETIRED_ACTIONS,
    generatedAt: new Date(now).toISOString(),
    actions: tools.length,
    readOnly: extra.length,
    tools: new Set(tools.map((item) => item.tool).filter(Boolean)).size,
    // 技能数以 defs 里的定义为准：有些技能还没有自主动作（douyin.crawl_stats 就只有步骤脚本）
    skills: SKILL_DEFS.length,
    items: [...tools, ...extra],
  };
}

/** 页面首屏快照：计数 + 9 个阶段 + 最近任务 + 今日计划槽 + 最近事件。 */
export function liveSnapshot(db, now = Date.now(), extra = {}) {
  // extra 允许传函数：每次取快照时现算（比如「本小时还剩几条评论」）
  const extras = typeof extra === 'function' ? (extra() ?? {}) : (extra ?? {});
  const sinceIso = dayStartIso(now);
  const today = db.prepare('SELECT event_type, channel, count(*) AS n FROM agent_events WHERE created_at >= ? GROUP BY event_type, channel').all(sinceIso);
  const totals = { events: 0, actions: 0, fails: 0, replies: 0 };
  const stageCount = new Map();
  for (const row of today) {
    totals.events += row.n;
    if (row.event_type === 'action_started' || row.event_type === 'action_finished') totals.actions += row.n;
    if (row.event_type === 'action_failed') totals.fails += row.n;
    if (row.event_type === 'message_replied') totals.replies += row.n;
    const stage = eventView({ event_type: row.event_type, channel: row.channel, payload: null }).stage;
    stageCount.set(stage, (stageCount.get(stage) ?? 0) + row.n);
  }
  // 近 7 天失败归类：哪些问题最多（只归类已知的，未知记「原因不明」）
  let failures = { total: 0, buckets: [] };
  try {
    const rows = db.prepare("SELECT operation, verdict, reason FROM task_checkpoints WHERE created_ms >= ? AND verdict IN ('failed','mismatched','unconfirmed')").all(now - 7 * 24 * 3600_000);
    failures = summarizeFailures(rows);
  } catch { /* 老库没有这一列/这一表 */ }
  const open = db.prepare("SELECT count(*) AS n FROM external_tasks WHERE status IN ('awaiting_confirmation','running','pending','awaiting_publish','planned')").get()?.n ?? 0;
  const awaiting = db.prepare("SELECT count(*) AS n FROM external_tasks WHERE status = 'awaiting_confirmation'").get()?.n ?? 0;

  const stageLast = new Map();
  for (const row of db.prepare('SELECT event_type, channel, payload, created_at, task_id FROM agent_events ORDER BY rowid DESC LIMIT 120').all()) {
    const view = eventView(row);
    if (!stageLast.has(view.stage)) stageLast.set(view.stage, view);
  }

  const tasks = db.prepare('SELECT id, intent, status, origin, conv_kind, attempts, created_ms, updated_ms, payload FROM external_tasks ORDER BY rowid DESC LIMIT 14').all()
    .map((row) => {
      const payload = parse(row.payload) ?? {};
      const ops = Array.isArray(payload.operations) ? payload.operations : (payload.operation ? [payload.operation] : []);
      return {
        id: row.id, intent: row.intent, status: row.status, state: stateOfStatus(row.status),
        origin: row.origin ?? null, convKind: row.conv_kind ?? null, attempts: row.attempts ?? 0,
        updatedMs: row.updated_ms ?? null, ops, summary: digestOf(payload, 60),
      };
    });
  const recentRows = db.prepare('SELECT rowid AS _rowid, * FROM agent_events ORDER BY rowid DESC LIMIT 26').all();
  const recent = recentRows.map(eventView).reverse();
  // 事件流只加载最近 26 条：告诉页面「还有多少更早的没显示」，别让人以为总共就这些。
  // 注意用 rowid 而不是 id——agent_events.id 是 'event_xxx' 字符串，比大小没有意义。
  let earlierCount = 0;
  let oldestRowid = null;
  try {
    oldestRowid = Number(recentRows.at(-1)?._rowid ?? 0) || null;
    earlierCount = oldestRowid ? Number(db.prepare('SELECT COUNT(*) n FROM agent_events WHERE rowid < ?').get(oldestRowid)?.n ?? 0) : 0;
  } catch { /* 空库 */ }
  const day = new Date(now).toLocaleDateString('sv-SE');
  // 新库 / 测试库里可能还没有 plan_slots（调度器没起过），缺表时给空面板而不是 500。
  let slots = { day, counts: {}, slots: [] };
  try { slots = slotList(db, day); } catch { /* 没有调度表就先空着 */ }

  // 哪些阶段有事件埋点：没有任何事件类型映射到它，说明这条链路是「看得见但没数据」的。
  const wired = new Set(Object.values(EVENT_ROUTE).map((route) => route.stage));
  // 当前有效的临时放行（页面上要能看到「现在有 N 条放行、最近一条什么时候」）
  let grantInfo = { count: 0, items: [], latestAt: null };
  try {
    const allow = loadRunAllowlist(process.cwd());
    const active = (allow.grants ?? []).filter((grant) => grant.until > now);
    grantInfo = {
      count: active.length,
      items: active.map((grant) => ({ action: grant.action, until: grant.until })),
      permanent: allow.allowed ?? [],
      note: allow.note ?? '',
    };
  } catch { /* 读不到就当没有 */ }

  return {
    generatedAt: new Date(now).toISOString(),
    grantInfo,
    day,
    totals: { ...totals, open, awaiting },
    stages: STAGES.map((stage) => {
      const last = stageLast.get(stage.id) ?? null;
      return {
        id: stage.id,
        label: stage.label,
        sub: stage.sub,
        hint: stage.hint,
        count: stageCount.get(stage.id) ?? 0,
        wired: wired.has(stage.id),
        lastAt: last?.createdAt ?? null,
        lastEvent: last?.eventType ?? null,
        lastSummary: last?.summary ?? '',
        state: last ? last.state : 'idle',
      };
    }),
    failures,
    ...extras,
    tasks,
    slots,
    recent,
    earlierCount,
    oldestRowid,
  };
}

/** SSE：hello（整屏快照）→ 事件增量 → 计数。只推事件元数据与摘要，payload 正文点开再取。 */
export function attachLiveStream(db, req, res, { intervalMs = 1200, now = () => Date.now(), extra = {} } = {}) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  let cursor = db.prepare('SELECT coalesce(max(rowid), 0) AS rid FROM agent_events').get()?.rid ?? 0;
  let closed = false;
  let tick = 0;
  const send = (payload) => { if (!closed) res.write(`data: ${JSON.stringify(payload)}\n\n`); };
  send({ type: 'hello', snapshot: liveSnapshot(db, now(), extra) });

  const timer = setInterval(() => {
    if (closed) return;
    try {
      tick += 1;
      const rows = db.prepare('SELECT rowid AS rid, * FROM agent_events WHERE rowid > ? ORDER BY rowid LIMIT 40').all(cursor);
      if (rows.length) {
        cursor = rows[rows.length - 1].rid;
        send({ type: 'events', events: rows.map(eventView) });
      }
      if (tick % 4 === 0) {
        const snapshot = liveSnapshot(db, now(), extra);
        send({ type: 'stats', totals: snapshot.totals, stages: snapshot.stages, tasks: snapshot.tasks, slots: snapshot.slots });
      }
    } catch (error) {
      send({ type: 'error', error: String(error?.message ?? error) });
    }
  }, intervalMs);

  const stop = () => { if (closed) return; closed = true; clearInterval(timer); res.end(); };
  req.on('close', stop);
  req.on('error', stop);
  res.on('error', stop);
  return stop;
}

export default { liveSnapshot, attachLiveStream, eventDetail, taskDetail, slotList, toolList, eventView, dayStartIso };

/** 按 id 倒序取一页更早的事件（给「加载更早」用）。 */
export function eventsForTask(db, taskId, limit = 12) {
  try {
    const rows = db.prepare("SELECT rowid AS rid, id, event_type, channel, actor, task_id, payload, created_at FROM agent_events WHERE task_id = ? ORDER BY rowid DESC LIMIT ?").all(taskId, limit);
    return rows.map((row) => eventView(row)).reverse();
  } catch { return []; }
}

export function earlierEvents(db, { beforeRowid, limit = 50 } = {}) {
  const cap = Math.max(1, Math.min(200, Number(limit) || 50));
  const cursor = Number(beforeRowid);
  if (!Number.isFinite(cursor) || cursor <= 0) return [];
  const rows = db.prepare('SELECT rowid AS _rowid, * FROM agent_events WHERE rowid < ? ORDER BY rowid DESC LIMIT ?').all(cursor, cap);
  return rows.map(eventView).reverse();
}
