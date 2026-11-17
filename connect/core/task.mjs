// 计划 P0-B-3 / P0-C-1 / P0-C-2 / P0-C-4：
// 唯一的任务与意图契约。原先散在 connect/tasks.mjs（正则意图）、
// connect/actions.mjs（[DO:...] 标记）、connect/qq/tools.mjs（模型给的 steps）三处的
// 「这是一件什么事、要做哪几步、要不要人点头」统一到这里。
//
// 设计原则：
//   1. 纯函数，不碰数据库 —— 这样路由决策表可以单独测。
//   2. 状态机是唯一的事实来源；存储层只负责把状态存下来。

/** 任务九态。proposed → awaiting_approval → approved → running → verifying → 终态。 */
export const TASK_STATES = Object.freeze({
  proposed: 'proposed',
  awaiting_approval: 'awaiting_approval',
  approved: 'approved',
  running: 'running',
  verifying: 'verifying',
  succeeded: 'succeeded',
  failed: 'failed',
  unknown: 'unknown',
  cancelled: 'cancelled',
});

export const TASK_STATE_LIST = Object.freeze(Object.keys(TASK_STATES));

/** 终态：进入后不再自动迁移。 */
export const TERMINAL_TASK_STATES = Object.freeze(['succeeded', 'failed', 'unknown', 'cancelled']);

/**
 * 允许的状态迁移。写入路径必须先问 canTransition，
 * 免得又出现「approved 直接跳 succeeded」这种没中间态的历史。
 */
export const TASK_TRANSITIONS = Object.freeze({
  proposed: ['awaiting_approval', 'approved', 'cancelled', 'failed'],
  awaiting_approval: ['approved', 'cancelled', 'expired', 'failed', 'unknown'],
  approved: ['running', 'cancelled', 'failed', 'unknown'],
  running: ['verifying', 'succeeded', 'failed', 'unknown', 'cancelled'],
  verifying: ['succeeded', 'failed', 'unknown'],
  succeeded: [],
  failed: [],
  unknown: ['running', 'verifying', 'succeeded', 'failed', 'cancelled'],
  cancelled: [],
  expired: [],
});

export function isTaskState(value) {
  return Object.prototype.hasOwnProperty.call(TASK_STATES, String(value ?? ''));
}

export function canTransition(from, to) {
  if (!isTaskState(to)) return false;
  if (from === to) return true;
  const allowed = TASK_TRANSITIONS[String(from ?? '')] ?? [];
  return allowed.includes(String(to));
}

/**
 * 旧库里那批任务用的是 awaiting_confirmation / awaiting_publish 这类名字。
 * 这里给出唯一映射口，新代码只认九态。
 */
export const LEGACY_TASK_STATES = Object.freeze({
  awaiting_confirmation: 'awaiting_approval',
  awaiting_publish: 'verifying',
  expired: 'cancelled',
});

export function toTaskState(value) {
  const raw = String(value ?? '').trim();
  if (isTaskState(raw)) return raw;
  return LEGACY_TASK_STATES[raw] ?? null;
}

/** 对外动作的风险等级，和 connect/policy.mjs 的 RISKS 对齐（这里只多一个 R4）。 */
export const RISK_LEVELS = Object.freeze(['R0', 'R1', 'R2', 'R3', 'R4']);

export function normalizeRisk(value, fallback = 'R2') {
  const raw = String(value ?? '').trim().toUpperCase();
  return RISK_LEVELS.includes(raw) ? raw : fallback;
}

/**
 * 统一意图：不管来源是正则、模型还是 [DO:...] 标记，
 * 到这里都变成同一个形状。
 * @returns {{intent:string,operations:string[],requires_confirmation:boolean,confidence:number,rationale:string}}
 */
export function normalizeIntent(raw = {}) {
  const intent = String(raw.intent ?? '').trim() || 'chat.reply';
  const operations = [...new Set((Array.isArray(raw.operations) ? raw.operations : [])
    .map((name) => String(name ?? '').trim())
    .filter(Boolean))];
  const requiresConfirmation = raw.requires_confirmation === true || raw.requiresConfirm === true;
  const confidence = Number.isFinite(Number(raw.confidence))
    ? Math.min(1, Math.max(0, Number(raw.confidence)))
    : (operations.length ? 0.6 : 0.9);
  const rationale = String(raw.rationale ?? '').trim();
  return Object.freeze({
    intent,
    operations,
    requires_confirmation: requiresConfirmation,
    confidence,
    rationale,
    // 兼容旧字段：外部动作一律需要确认，除非显式说不必。
    target: raw.target ?? null,
    theme: raw.theme ?? null,
    plan: Array.isArray(raw.plan) ? raw.plan : [],
  });
}

/** 空意图：只是聊天，不需要任何动作。 */
export function chatIntent(rationale = '') {
  return normalizeIntent({ intent: 'chat.reply', operations: [], requires_confirmation: false, confidence: 1, rationale });
}

/**
 * 正则意图识别（原来叫 parseExternalIntent，住在 connect/tasks.mjs）。
 * 迁到这里是为了让「规则 vs 模型」的判断只有一个出处。
 * 注意：只有问句（有没有新评论？）不该命中，真正要执行才命中。
 */
export function intentFromText(text) {
  const value = String(text ?? '').replace(/\s+/gu, ' ').trim();
  if (!value) return null;
  const douyin = /(抖音|评论区|评论|点赞)/u.test(value);
  const manage = /(回复|回|点赞|维护|互动)/u.test(value);
  if (!douyin || !manage) return null;
  // 「有没有新评论」「回了吗」「点赞了吗」这类是在问，不是在下令。
  if (/(有没有|有没有新|是不是有|回了吗|点赞了吗|多少条|几条|查一下|看看有)/u.test(value)) return null;
  const operations = [];
  if (/(回复|回|维护)/u.test(value)) operations.push('douyin.reply_comments');
  if (/点赞|赞|维护/u.test(value)) operations.push('douyin.like_comments');
  if (!operations.length) return null;
  return normalizeIntent({
    intent: 'douyin.manage_comments',
    operations,
    target: 'my_latest_work',
    requires_confirmation: true,
    confidence: 0.55,
    rationale: '规则命中：文本里同时出现抖音动作词和操作词',
  });
}

/**
 * 把模型给的步骤（qq/tools.mjs 的 normalizeSteps 结果）折成统一意图。
 */
export function intentFromSteps(steps = [], extra = {}) {
  const operations = [...new Set(steps.map((step) => String(step?.tool ?? '').trim()).filter(Boolean))];
  if (!operations.length) return chatIntent(extra.rationale ?? '模型没有给出任何动作');
  return normalizeIntent({
    intent: extra.intent ?? 'external_action_request',
    operations,
    requires_confirmation: true,
    confidence: extra.confidence ?? 0.7,
    rationale: extra.rationale ?? '模型规划了写操作',
    ...extra,
  });
}

/**
 * 一步任务。step_key 是重放保护的核心：同一个 step_key 不会被执行两次。
 */
export function createTaskStep({ index = 0, action = '', params = {}, precondition = '', postcondition = '', stepKey = '', idempotencyKey = '' } = {}) {
  const actionName = String(action ?? '').trim();
  return Object.freeze({
    index: Number(index) || 0,
    action: actionName,
    params: params && typeof params === 'object' ? { ...params } : {},
    precondition: String(precondition ?? ''),
    postcondition: String(postcondition ?? ''),
    step_key: stepKey || `${actionName}#${index}`,
    idempotency_key: idempotencyKey || null,
    state: 'pending',
    receipt: null,
  });
}

/** 从步骤列表算重放键：同一个 step_key 出现两次就是重复。 */
export function stepKeys(steps = []) {
  const seen = new Set();
  const duplicated = [];
  for (const step of steps) {
    const key = String(step?.step_key ?? '').trim();
    if (!key) continue;
    if (seen.has(key)) duplicated.push(key);
    seen.add(key);
  }
  return { keys: [...seen], duplicated };
}

/**
 * 对外副作用步骤强制带 idempotency_key：缺了就抛，别让重放双写。
 * isSideEffect(action, step) 返回 true 表示这步有对外副作用（写库/发消息/发抖音…）。
 */
export function requireIdempotencyKeys(steps = [], isSideEffect = () => true) {
  const missing = [];
  for (const step of steps) {
    const action = String(step?.action ?? step?.operation ?? '');
    if (!isSideEffect(action, step)) continue;
    const key = String(step?.idempotency_key ?? step?.idempotencyKey ?? '').trim();
    if (!key) missing.push(String(step?.step_key ?? '') || action || '?');
  }
  if (missing.length) throw new Error(`副作用步骤缺 idempotency_key: ${missing.join(', ')}`);
  return true;
}

/**
 * 统一任务对象。存储层只保存其中的 id/status/payload 等，
 * 但接口形状在这里定死，别处不再自造字段。
 */
export function createAgentTask({
  id = '', origin = 'qq', scope = null, goal = '', intent = null, risk = 'R2',
  status = 'proposed', steps = [], dependsOn = [], parentTask = null, approval = null,
  idempotencyKey = '', createdAt = null, updatedAt = null, deadline = null,
} = {}) {
  const normalizedIntent = intent ? normalizeIntent(intent) : chatIntent();
  return Object.freeze({
    id: String(id ?? ''),
    origin: String(origin ?? 'qq'),
    scope: scope ?? null,
    goal: String(goal ?? '') || normalizedIntent.intent,
    intent: normalizedIntent,
    risk: normalizeRisk(risk, normalizedIntent.operations.length ? 'R3' : 'R0'),
    status: isTaskState(status) ? status : 'proposed',
    steps: Object.freeze(steps.map((step) => (step?.state ? step : createTaskStep(step)))),
    depends_on: [...new Set(dependsOn.map(String).filter(Boolean))],
    parent_task: parentTask ?? null,
    approval: approval ?? { state: 'none', approver_peer_id: null, decided_at: null },
    idempotency_key: idempotencyKey || '',
    created_at: createdAt,
    updated_at: updatedAt,
    deadline: deadline ?? null,
  });
}

/**
 * 幂等键的唯一构造方式。以前有七种写法，现在只留这一种。
 */
export function taskIdempotencyKey({ origin = 'qq', kind = 'c2c', convId = '', sourceMessageId = '', intent = '', operations = [] } = {}) {
  const ops = (Array.isArray(operations) ? operations : []).join(',');
  return `${origin}:${kind}:${convId}:${sourceMessageId ?? ''}:${intent}:${ops}`;
}

/**
 * 任务的执行风险：有没有对外副作用、要不要人点头。
 */
export function riskOfIntent(intent) {
  const normalized = normalizeIntent(intent);
  if (!normalized.operations.length) return 'R0';
  if (normalized.requires_confirmation) return 'R3';
  return 'R2';
}
