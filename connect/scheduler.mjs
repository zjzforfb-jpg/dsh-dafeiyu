/**
 * 日程大脑的定时器：每 60 秒醒一次，管四件事。
 *  1. 今天还没心情 → 生成一个（写 mood.json + mood_history）
 *  2. 今天还没日程 → 按心情排一天，落库，并到 QQ 群播报
 *  3. 到点的 slot → 只读/回评论自动执行；发布类只建任务等人点头
 *  4. 22:30 → 当日复盘播报
 * 所有动作幂等（scheduled_runs + plan_slots 状态机），服务重启不会重跑。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ACTIONS, runAction } from './actions.mjs';
import { commentQuota } from './live/quota.mjs';
import { recordAgentEvent } from './agent-events.mjs';
import { executeTaskAction } from './core/execute.mjs';
import { executeOperations } from './core/publish.mjs';
import { reflectOnActionFailure } from './core/reflect.mjs';
import { distillLessons } from './core/lessons-distill.mjs';
import { extractFactCandidates } from './fact-candidates.mjs';
import { prepareDailyPost } from './douyin/daily.mjs';
import { completeTask, proposeTask, startAutomaticTask } from './tasks.mjs';
import { saveFanSnapshot } from './douyin/store.mjs';
import { AUTO_ACTIONS, buildPlan, dueSlots, hasRun, initPlans, markRun, markSlot, planText, readPlan, savePlan } from './douyin/dayplan.mjs';
import { ensureMood, initMood, shanghaiClock, shanghaiDay } from './douyin/mood.mjs';

const DAY_MS = 86_400_000;
const TICK_MS = 60_000;

export function readTargets(root) {
  const path = join(root, 'targets.json');
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
}

function todayStats(db, now) {
  const day = shanghaiDay(now);
  const start = Date.parse(`${day}T00:00:00+08:00`);
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM external_tasks WHERE created_ms>=? AND created_ms<? GROUP BY status').all(start, start + DAY_MS);
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.n)]));
}

async function notifySafe(notify, kind, id, text, fallbackText = null) {
  if (!id || !notify) return false;
  try { await notify({ kind, id, text, fallbackText }); return true; } catch { return false; }
}

/** 跑一条到点的日程。 */
// 会消耗「评论额度」的动作：额度用完就别跑了，白跑 4 分钟还会记一条失败
export const COMMENT_ACTIONS = new Set(['douyin.reply_comments', 'douyin.hot_comment_round', 'douyin.comment_latest']);

/** 纯函数：这个槽现在该不该因为「本小时评论额度用完」而跳过。返回跳过原因或 null。 */
export function quotaSkip(action, quota) {
  if (!COMMENT_ACTIONS.has(action)) return null;
  if (!quota || typeof quota.hourlyLeft !== 'number') return null;
  return quota.hourlyLeft <= 0 ? `quota_exhausted:${quota.hourlyUsed}/${quota.hourlyCap}` : null;
}

export async function fireSlot({ db, root, slot, now = Date.now(), execute = runAction, notify = null, targets = {}, home = null, random = Math.random, runPrepare = null }) {
  // 额度闸门：评论额度用完就直接标「跳过」，不去跑必然失败的那 4 分钟
  const quota = commentQuota(root, { now });
  const skippedByQuota = quotaSkip(slot.action, quota);
  if (skippedByQuota) {
    markSlot(db, slot.id, { status: 'skipped', note: skippedByQuota });
    try {
      recordAgentEvent(db, {
        eventType: 'action_finished', channel: 'plan', actor: 'scheduler', taskId: slot.task_id ?? null,
        payload: { operation: slot.action, slot: slot.id, status: 'skipped', detail: skippedByQuota },
        dedupeKey: `slot_quota_skip:${slot.id}`,
      });
    } catch { /* 事件是附加信息 */ }
    return { slot: slot.id, action: slot.action, status: 'skipped', taskId: slot.task_id ?? null, detail: skippedByQuota };
  }
  if (slot.action === 'douyin.daily_post') {
    // 日常图文：自动写好、停在发布前，把二审消息发到 QQ，等爸爸回「发」。
    markSlot(db, slot.id, { status: 'fired', firedAt: now });
    try {
      const result = await prepareDailyPost({ db, root, home, now, slot: slot.args?.slot ?? 'morning', targets, notify, random, runPrepare });
      const ok = result.status === 'awaiting_publish';
      markSlot(db, slot.id, { status: ok ? 'done' : 'skipped', note: `${result.status}${result.reason ? ':' + result.reason : ''}` });
      return { slot: slot.id, action: slot.action, status: ok ? 'succeeded' : 'skipped', taskId: result.taskId ?? null, detail: result.theme ?? result.reason ?? '' };
    } catch (error) {
      // 报错要留着能诊断：以前截 120 字，命令行本身就把额度占满，真正的 node 报错被切掉，
      // 看板上只剩半句「Command failed: ...」。现在留 900 字，页面整段显示。
      const detail = String(error?.message ?? error).replace(/\s+/gu, ' ').trim();
      markSlot(db, slot.id, { status: 'failed', note: detail.slice(0, 900) });
      // 失败也进学习账本：同类失败攒够了才会变成一条提案，不用人肉盯日志。
      try { reflectOnActionFailure(db, { operation: slot.action, reason: detail, taskId: slot.task_id ?? null, now }); } catch { /* 学习是附加信息 */ }
      try {
        recordAgentEvent(db, {
          eventType: 'action_failed', channel: 'plan', actor: 'scheduler', taskId: slot.task_id ?? null,
          payload: { operation: slot.action, slot: slot.id, error: detail.slice(0, 900) },
          dedupeKey: `slot_failed:${slot.id}`,
        });
      } catch { /* 事件是附加信息，写不进去不影响主流程 */ }
      return { slot: slot.id, action: slot.action, status: 'failed', detail };
    }
  }
  // 手机只有一块屏：有「写好待审」的图文时，其他要动手机的动作先让路，
  // 否则 resetDouyin / 返回首页会把草稿冲掉，爸爸点「发」时会找不到发布页。
  if (slot.action.startsWith('douyin.') && slot.action !== 'douyin.publish') {
    const held = db.prepare("SELECT id FROM external_tasks WHERE status='awaiting_publish' AND conv_kind='c2c' AND result LIKE '%\"stage\":\"filled\"%' LIMIT 1").get();
    if (held) {
      markSlot(db, slot.id, { status: 'skipped', firedAt: now, note: 'waiting_for_publish' });
      return { slot: slot.id, action: slot.action, status: 'skipped', reason: 'waiting_for_publish' };
    }
  }
  if (!ACTIONS[slot.action]) {
    markSlot(db, slot.id, { status: 'skipped', firedAt: now, note: 'action_not_implemented' });
    return { slot: slot.id, action: slot.action, status: 'skipped', reason: 'action_not_implemented' };
  }
  const convId = targets?.qq?.dad ?? '';
  const auto = AUTO_ACTIONS.has(slot.action);
  const intent = {
    intent: 'plan_slot',
    source: 'scheduler',
    operations: [slot.action],
    args: slot.args ?? {},
    target: 'self',
    requires_confirmation: !auto,
  };
  // 重试轮次进幂等键：同一个槽第二次跑必须是一条新任务，才能被 startAutomaticTask 启动。
  const attempt = slotAttempt(slot.note);
  const sourceMessageId = attempt > 0 ? `${slot.id}#${attempt}` : slot.id;
  const task = proposeTask(db, { kind: 'c2c', convId, sourceMessageId, intent, origin: 'plan', expiresMs: now + 15 * 60_000, now });
  markSlot(db, slot.id, { status: 'fired', taskId: task.id, firedAt: now });
  if (!auto) {
    // 需要爸爸点头：只建任务 + 提醒，等待 QQ 里回「同意」。
    await notifySafe(notify, 'c2c', convId, `日程到点了：「${slot.action}」我已经存成任务（${task.id.slice(0, 17)}），回「同意」我就去做。`);
    return { slot: slot.id, action: slot.action, status: 'awaiting_confirmation', taskId: task.id };
  }
  if (!startAutomaticTask(db, task.id, now)) {
    markSlot(db, slot.id, { status: 'failed', note: 'task_not_startable' });
    return { slot: slot.id, action: slot.action, status: 'failed', reason: 'task_not_startable', taskId: task.id };
  }
  // 单个自动动作：走统一的 executeOperations（一份回执逻辑，别再自己拼 receipt）。
  const outcome = await executeOperations({
    operations: [slot.action],
    execute: (name, args) => executeTaskAction({ db, taskId: task.id, operation: name, root, args, execute }),
    args: slot.args ?? {},
    adapterFor: (name) => String(name).split('.')[0] || 'unknown',
    db,
    taskId: task.id,
    channel: 'douyin',
    stopOnFailure: true,
  });
  const ok = outcome.ok;
  const detail = ok
    ? outcome.details.filter(Boolean).join('；').slice(0, 300)
    : String(outcome.errors[0] ?? 'unknown').slice(0, 200);
  completeTask(db, task.id, { ok, result: outcome.receipts }, now);
  if (!ok) {
    try { reflectOnActionFailure(db, { operation: slot.action, reason: String(outcome.errors?.[0] ?? 'unknown'), taskId: task.id, now }); } catch { /* 同上 */ }
  }
  // 失败原因要留着查：以前截到 120 字，正好把真正的报错截掉，只剩「Command failed:」。
  markSlot(db, slot.id, {
    status: ok ? 'done' : 'failed',
    note: String(detail).replace(/\s+/gu, ' ').trim().slice(0, 900),
  });
  return { slot: slot.id, action: slot.action, status: ok ? 'succeeded' : 'failed', taskId: task.id, detail };
}

// 哪些失败值得重试一次：都是「环境暂时不对」，不是逻辑错。
// 逻辑错重试也是白重试，反而把日志刷满。
const TRANSIENT_PATTERNS = [
  /command failed/iu, /timed?\s?out|etimedout/iu, /econnreset|econnrefused|enotfound/iu,
  /device offline|no devices|adb: device/iu, /network|socket hang up/iu, /busy|another instance/iu,
];

function looksTransient(note) {
  const text = String(note ?? '');
  if (!text || /^retry:/u.test(text)) return false;
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * 把今天「因为环境抖了一下」失败的日程放回待跑队列，各重试一次。
 * 重试过的会在 note 前面打 `retry:` 标记，避免无限循环。
 */
/**
 * 槽的 note 里记着重试次数（`retry:2:...`）。
 * 重试要换任务幂等键，不然会撞上上一轮那个已经失败的任务。
 */
export function slotAttempt(note) {
  const matched = /^retry:(\d+):/u.exec(String(note ?? ''));
  return matched ? Number(matched[1]) : 0;
}

export function requeueTransient(db, { now = Date.now(), withinMs = 6 * 3600_000, limit = 3 } = {}) {
  const day = shanghaiDay(now);
  const rows = db.prepare(
    "SELECT id, action, note, at_ms, args FROM plan_slots WHERE day=? AND status='failed' AND at_ms>=? ORDER BY at_ms DESC",
  ).all(day, now - withinMs);
  const picked = [];
  for (const row of rows) {
    if (picked.length >= limit) break;
    if (!looksTransient(row.note)) continue;
    // note 里记「第几次重试」，因为同一个槽重跑时必须换一个任务幂等键，
    // 否则 proposeTask 会把上一轮那个已失败的任务还回来，startAutomaticTask 直接判不可启动。
    const attempt = slotAttempt(row.note) + 1;
    db.prepare("UPDATE plan_slots SET status='planned', at_ms=?, fired_at=NULL, note=? WHERE id=?")
      .run(now, `retry:${attempt}:${String(row.note).slice(0, 76)}`, row.id);
    picked.push({ id: row.id, action: row.action, attempt });
  }
  return picked;
}

/** 一次心跳：全部幂等，返回这次做了什么（方便测试与看板）。 */
export async function tick({ db, root, now = Date.now(), execute = runAction, notify = null, random = Math.random, home = null, runPrepare = null } = {}) {
  initMood(db);
  initPlans(db);
  const day = shanghaiDay(now);
  const clock = shanghaiClock(now);
  const targets = readTargets(root);
  const out = { day, clock, mood: null, plan: null, fans: null, fired: [], review: null };

  // 1. 心情
  if (clock >= '08:00' && !hasRun(db, `mood:${day}`)) {
    try {
      const mood = ensureMood(db, root, now, random);
      markRun(db, `mood:${day}`, mood.mood, now);
      out.mood = mood.mood;
    } catch (error) { markRun(db, `mood:${day}`, `error:${String(error?.message ?? error).slice(0, 80)}`, now); }
  }

  // 2. 日程 + QQ 群播报
  if (clock >= '08:05' && !hasRun(db, `plan:${day}`)) {
    try {
      const existing = readPlan(db, day);
      const mood = db.prepare('SELECT mood, energy, why FROM mood_history WHERE day=?').get(day);
      const plan = existing ?? savePlan(db, buildPlan({ day, mood: mood?.mood ?? 'calm', energy: Number(mood?.energy ?? 0.6) }), now);
      if (!existing) {
        markRun(db, `plan:${day}`, `${plan.slots?.length ?? 0} slots`, now);
        await notifySafe(notify, 'group', targets?.qq?.group, planText(plan, mood), `今天日程排好了：${plan.slots?.length ?? 0} 件事。QQ 不让我主动发群，等群里有人说话我补发。`);
      } else markRun(db, `plan:${day}`, 'already_exists', now);
      out.plan = plan.slots?.length ?? 0;
    } catch (error) { markRun(db, `plan:${day}`, `error:${String(error?.message ?? error).slice(0, 80)}`, now); }
  }

  // 2.5 每天记一次粉丝快照（给看板画增长曲线）
  if (clock >= '08:10' && !hasRun(db, `fans:${day}`)) {
    try {
      const douyinFile = join(root, '..', 'douyin', 'douyin.db');
      const douyin = existsSync(douyinFile) ? new DatabaseSync(douyinFile) : null;
      if (douyin) {
        try {
          const snap = saveFanSnapshot(douyin, { at: new Date(now).toISOString() });
          markRun(db, `fans:${day}`, `${snap.fans} fans`, now);
          out.fans = snap.fans;
        } finally { douyin.close(); }
      } else markRun(db, `fans:${day}`, 'douyin_db_missing', now);
    } catch (error) { markRun(db, `fans:${day}`, `error:${String(error?.message ?? error).slice(0, 80)}`, now); }
  }

  // 3. 到点的活儿（早于 90 分钟没跑的算错过，标记掉，不一次性补跑一大堆）
  db.prepare("UPDATE plan_slots SET status='skipped', note='stale' WHERE status='planned' AND at_ms < ?").run(now - 90 * 60_000);
  // 环境抖动导致的失败（adb 掉线、网络、超时）各重试一次，别让一天的活白丢。
  out.requeued = requeueTransient(db, { now });
  for (const slot of dueSlots(db, now, 3)) {
    try {
      out.fired.push(await fireSlot({ db, root, slot, now, execute, notify, targets, home, random, runPrepare }));
    } catch (error) {
      markSlot(db, slot.id, { status: 'failed', firedAt: now, note: `error:${String(error?.message ?? error).slice(0, 80)}` });
      out.fired.push({ slot: slot.id, action: slot.action, status: 'failed' });
    }
  }

  // 3.5 夜间整理（23:30）：把今天的对话提炼成事实候选，把攒够的失败写成经验。
  // 只做一次，用 scheduled_runs 记键；失败不影响主流程。
  if (clock >= '23:30' && !hasRun(db, `housekeeping:${day}`)) {
    try {
      let facts = 0;
      try {
        const ids = extractFactCandidates(db, day);
        facts = ids.length;
      } catch { facts = 0; }
      let lessons = 0;
      try {
        const distilled = distillLessons(db, { home, now });
        lessons = distilled.added?.length ?? 0;
      } catch { lessons = 0; }
      markRun(db, `housekeeping:${day}`, JSON.stringify({ facts, lessons }), now);
      out.housekeeping = { facts, lessons };
    } catch (error) { markRun(db, `housekeeping:${day}`, `error:${String(error?.message ?? error).slice(0, 80)}`, now); }
  }

  // 3.6 学习闭环（凌晨 03:00）：够格的自动升版，R3 留给爸爸点头。
  if (clock >= '03:00' && clock < '04:00' && !hasRun(db, `learning:${day}`)) {
    try {
      const { sweepLearning } = await import('./skills/learning.mjs');
      const result = sweepLearning(db, { root });
      markRun(db, `learning:${day}`, JSON.stringify({ approved: result.approved.length, pending: result.pending.length }), now);
      out.learning = { approved: result.approved.length, pending: result.pending.length };
    } catch (error) { markRun(db, `learning:${day}`, `error:${String(error?.message ?? error).slice(0, 80)}`, now); }
  }

  // 4. 夜间复盘
  if (clock >= '22:30' && !hasRun(db, `review:${day}`)) {
    try {
      const stats = todayStats(db, now);
      const text = `今天收工啦 🐟\n任务：成功 ${stats.succeeded ?? 0} · 失败 ${stats.failed ?? 0} · 待确认 ${stats.awaiting_confirmation ?? 0}\n心情：${db.prepare('SELECT mood FROM mood_history WHERE day=?').get(day)?.mood ?? 'calm'}\n明天见～`;
      await notifySafe(notify, 'group', targets?.qq?.group, text, `今天收工啦 🐟 任务成功 ${stats.succeeded ?? 0} · 失败 ${stats.failed ?? 0}`);
      markRun(db, `review:${day}`, JSON.stringify(stats), now);
      out.review = stats;
    } catch (error) { markRun(db, `review:${day}`, `error:${String(error?.message ?? error).slice(0, 80)}`, now); }
  }
  return out;
}

/** 挂到 startConnect 上；返回 { stop, tick }。 */
export function startScheduler({ db, root, home = null, notify = null, execute = runAction, now = () => Date.now(), intervalMs = TICK_MS, random = Math.random, logger = () => {}, runPrepare = null } = {}) {
  let running = false;
  const run = async () => {
    if (running) return null;
    running = true;
    try { return await tick({ db, root, home, now: now(), execute, notify, random, runPrepare }); }
    catch (error) { logger({ scheduler: 'tick_failed', error: String(error?.message ?? error) }); return null; }
    finally { running = false; }
  };
  const timer = setInterval(() => { run(); }, intervalMs);
  timer.unref?.();
  setTimeout(() => { run(); }, 2_000).unref?.();
  return { stop: () => clearInterval(timer), tick: run };
}
