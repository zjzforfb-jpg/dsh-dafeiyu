import { randomUUID } from 'node:crypto';
import { ensureColumn } from './core/migrations.mjs';

const EVENT_TYPES = new Set([
  'message_received', 'message_replied', 'observation_created', 'plan_created',
  'action_requested', 'action_started', 'action_finished', 'action_failed',
  'receipt_verified', 'user_corrected', 'reflection_created', 'task_state_changed', 'task_reported',
  // M1：这句话被路由成了什么（同意/拒绝/命令/要查/闲聊）。有了它，「路由」这一段才算真的在跑。
  'route_decision',
  // M2：只读步骤失手后的一次重规划（写操作永不自动重放）。
  'replan_requested',
  // D-3 续：通话结束是独立事件——「拨出去」和「接通了/被拒了」是两件事，回执不能只写 accepted。
  'call_ended',
  'preflight_checked',
  'run_granted',
  // 闸门：任务停下来等人点头（approval_requested）与这个人点完的结果（approval_resolved）。
  // 之前这两步只有 task_state_changed，页面上的「闸门」段永远点亮不了。
  'approval_requested', 'approval_resolved',
  // 认知段：写进长期记忆、技能被跑起来/跑完/被提名。PIPELINE 与 /live 已经按这几个名字归段。
  'memory_written', 'skill_run_started', 'skill_run_finished', 'skill_candidate',
]);

/**
 * 事件流唯一的 channel 词表（计划 A-4：词表收敛为一份）。
 * 之前的漂移：QQ 侧写 'qq'、iLink 侧写 'wechat'、Brain 侧写 'ilink'/'desktop'，
 * 同一条微信消息在两个库里分别被记成 'wechat' 和 'ilink'。
 */
// D-3：call 是一等 ingest 渠道（与 connect/core-contract.mjs 的白名单一致），不再并进 system。
/**
 * 事件类型清单（只读）。/live 的覆盖检查用它确保「新加的事件类型必须在页面上有归属」，
 * 避免以后加了事件、页面却悄悄漏掉。
 */
export const EVENT_TYPE_LIST = Object.freeze([...EVENT_TYPES]);

export const CHANNELS = Object.freeze(['desktop', 'qq', 'wechat', 'android', 'douyin', 'call', 'system']);

const CHANNEL_ALIASES = Object.freeze({ ilink: 'wechat', board: 'system', vision: 'android' });

/** 把任意来源的 channel 收敛到词表内；未知值落到 'system'，不静默丢事件。 */
export function normalizeChannel(value) {
  const raw = String(value ?? 'system').trim().toLowerCase();
  const mapped = CHANNEL_ALIASES[raw] ?? raw;
  return CHANNELS.includes(mapped) ? mapped : 'system';
}

export function initAgentEvents(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_events(
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'system',
    conversation_id TEXT,
    task_id TEXT,
    skill_run_id TEXT,
    actor TEXT NOT NULL DEFAULT 'system',
    payload TEXT NOT NULL DEFAULT '{}',
    result TEXT,
    evidence TEXT,
    privacy_scope TEXT NOT NULL DEFAULT 'private',
    dedupe_key TEXT UNIQUE,
    trace_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS agent_events_timeline ON agent_events(created_at,id);
  CREATE INDEX IF NOT EXISTS agent_events_task ON agent_events(task_id,created_at);
  CREATE INDEX IF NOT EXISTS agent_events_type ON agent_events(event_type,created_at);`);
  // 计划 A-4：trace_id 提升为独立列（老库由 connect/core/migrations.mjs 的 v2 迁移补齐）
  ensureColumn(db, 'agent_events', 'trace_id');
  db.exec('CREATE INDEX IF NOT EXISTS agent_events_trace ON agent_events(trace_id,created_at)');
}

function safeJson(value, max = 8000) {
  try {
    const raw = JSON.stringify(value ?? {});
    return raw.replace(/sk-[A-Za-z0-9_-]{12,}|(?:api[_ -]?key|access[_ -]?token|password|密码|验证码|短信码|银行卡|身份证)\\?"?\\s*[:=]\\s*\\?"?[^,}\\"]+/giu, '[redacted]').slice(0, max);
  } catch { return '{}'; }
}

export function recordAgentEvent(db, {
  id = `event_${randomUUID()}`,
  eventType,
  channel = 'system',
  conversationId = null,
  taskId = null,
  skillRunId = null,
  actor = 'system',
  payload = {},
  result = null,
  evidence = null,
  privacyScope = 'private',
  dedupeKey = null,
  traceId = null,
  at = new Date(),
} = {}) {
  initAgentEvents(db);
  if (!EVENT_TYPES.has(eventType)) throw new Error(`invalid_agent_event_type:${eventType}`);
  const row = db.prepare(`INSERT OR IGNORE INTO agent_events
    (id,event_type,channel,conversation_id,task_id,skill_run_id,actor,payload,result,evidence,privacy_scope,dedupe_key,trace_id,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      String(id), String(eventType), normalizeChannel(channel), conversationId == null ? null : String(conversationId).slice(0, 160),
      taskId == null ? null : String(taskId).slice(0, 160), skillRunId == null ? null : String(skillRunId).slice(0, 160),
      String(actor).slice(0, 80), safeJson(payload), result == null ? null : safeJson(result, 4000),
      evidence == null ? null : safeJson(evidence, 4000), String(privacyScope).slice(0, 40),
      dedupeKey == null ? null : String(dedupeKey).slice(0, 240),
      traceId == null ? null : String(traceId).slice(0, 120),
      new Date(at).toISOString(),
    );
  return row.changes ? db.prepare('SELECT * FROM agent_events WHERE id=?').get(String(id)) : (dedupeKey ? db.prepare('SELECT * FROM agent_events WHERE dedupe_key=?').get(String(dedupeKey)) : null);
}

export function listAgentEvents(db, { taskId, eventType, traceId, channel, limit = 100 } = {}) {
  initAgentEvents(db);
  const safe = Math.max(1, Math.min(500, Number(limit) || 100));
  const clauses = [], values = [];
  if (taskId) { clauses.push('task_id=?'); values.push(String(taskId)); }
  if (eventType) { clauses.push('event_type=?'); values.push(String(eventType)); }
  if (traceId) { clauses.push('trace_id=?'); values.push(String(traceId)); }
  if (channel) { clauses.push('channel=?'); values.push(String(channel)); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM agent_events ${where} ORDER BY created_at DESC,id DESC LIMIT ?`).all(...values, safe);
}
