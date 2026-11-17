/**
 * 实时工作流控制台的数据字典（浏览器与测试共用，避免两边各写一套）。
 *
 * 这里只描述「一条事件落在哪个阶段、要点哪种状态」，不含任何渲染逻辑：
 * 页面拿 STAGES 画线，拿 stageForEvent() 决定哪个节点亮。
 */

/** 一条事件的生命周期里可能出现的状态。页面按这个上色。 */
export const STATES = Object.freeze({
  idle: { label: '空闲', color: '#4b5563' },
  active: { label: '进行中', color: '#22d3ee' },
  ok: { label: '完成', color: '#34d399' },
  fail: { label: '失败', color: '#ef4444' },
  wait: { label: '等待', color: '#fbbf24' },
  review: { label: '待确认', color: '#a78bfa' },
});

/**
 * 流水线阶段：一条消息从进来到吐出结果，会依次穿过这些节点。
 * id 与 stageForEvent() 的返回值一一对应；阶段本体定义在 connect/core/pipeline.mjs，
 * 这里只补「页面上怎么显示」的部分，避免两边各写一份慢慢漂移。
 */
import { PIPELINE } from '../core/pipeline.mjs';

const STAGE_HINTS = Object.freeze({
  entry: '谁在说话：网关收消息、通话事件、桌宠动作、安卓设备上报。',
  observe: '执行前先看环境：安卓当前页面、抖音有没有登录、QQ 窗口在不在。',
  route: '判断这句话是闲聊、指令还是确认/拒绝，决定走哪条路。',
  task: '把要做的事落成任务：意图、参数、状态机，可追踪可重试。',
  gate: '危险动作过策略与审批：R3 需要人点头，approvals 表记录谁批的。',
  act: '唯一执行出口：runAction → 具体适配器（抖音 / QQ / 微信 / 设备）。',
  verify: '不听说「应该成功了」：拿期望对实际，落 confirmed / unconfirmed / mismatched。',
  memory: '成功与失败都沉淀：技能账本、记忆、反思候选。',
  call: '拨出去、接通、被拒、没人接，分开记，回执不能只写 accepted。',
});

export const STAGES = Object.freeze(PIPELINE.map((stage) => ({
  id: stage.id,
  label: stage.label,
  sub: stage.sub.split('：')[0].slice(0, 28),
  hint: STAGE_HINTS[stage.id] ?? stage.sub,
  events: stage.events,
})));

export const STAGE_IDS = Object.freeze(STAGES.map((stage) => stage.id));

/** 事件类型 → 阶段 + 状态。payload 用于细分（例如任务状态 waiting 要点黄灯）。 */
export const EVENT_ROUTE = Object.freeze({
  message_received: { stage: 'entry', state: 'active' },
  message_replied: { stage: 'entry', state: 'ok' },
  observation_created: { stage: 'observe', state: 'ok' },
  route_decision: { stage: 'route', state: 'ok' },
  replan_requested: { stage: 'task', state: 'wait' },
  task_state_changed: { stage: 'task', state: 'wait' },
  task_reported: { stage: 'task', state: 'ok' },
  action_started: { stage: 'act', state: 'active' },
  action_finished: { stage: 'act', state: 'ok' },
  action_failed: { stage: 'act', state: 'fail' },
  receipt_verified: { stage: 'verify', state: 'ok' },
  call_ended: { stage: 'call', state: 'ok' },
  preflight_checked: { stage: 'gate', state: 'review' },
  run_granted: { stage: 'gate', state: 'wait' },
  reflection_created: { stage: 'memory', state: 'ok' },
  memory_written: { stage: 'memory', state: 'ok' },
  skill_run_started: { stage: 'memory', state: 'active' },
  skill_run_finished: { stage: 'memory', state: 'ok' },
  skill_candidate: { stage: 'memory', state: 'wait' },
  approval_requested: { stage: 'gate', state: 'review' },
  approval_resolved: { stage: 'gate', state: 'ok' },
});

function parseMaybeJson(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return value; }
}

const STATUS_STATE = {
  done: 'ok', succeeded: 'ok', completed: 'ok', verified: 'ok',
  running: 'active', started: 'active', executing: 'active',
  awaiting_confirmation: 'review', awaiting_publish: 'review', waiting_verification: 'wait',
  pending: 'wait', planned: 'wait', queued: 'wait', waiting: 'wait',
  failed: 'fail', cancelled: 'fail', rejected: 'fail', unknown: 'fail', expired: 'fail',
};

/** 任务状态 → 颜色状态（页面给任务卡上色用）。 */
export function stateOfStatus(status) {
  return STATUS_STATE[String(status ?? '').toLowerCase()] ?? 'idle';
}

/**
 * 一条 agent_event 落在哪个阶段、点哪种灯。
 * 任务状态变化会看 payload.status，把「待确认」点成紫色而不是笼统的黄。
 */
export function stageForEvent(event) {
  const type = String(event?.eventType ?? event?.event_type ?? '');
  const base = EVENT_ROUTE[type] ?? { stage: 'entry', state: 'ok' };
  const payload = parseMaybeJson(event?.payload) ?? {};
  if (type === 'task_state_changed') {
    const status = payload.status ?? payload.working_status;
    return { stage: 'task', state: STATUS_STATE[String(status ?? '')] ?? 'wait', status };
  }
  if (type === 'receipt_verified' && payload.status && payload.status !== 'succeeded') {
    return { stage: 'verify', state: 'fail' };
  }
  return base;
}

/** 事件的一行摘要：给事件流表格用，不展开长文本。 */
const DIGEST_KEYS = ['status', 'working_status', 'operation', 'detail', 'summary', 'reason', 'error', 'step', 'action', 'adapter', 'intent', 'next_action'];

/** 给「一行摘要」用的中文映射：消息类事件没有 status/operation，但有 kind/input_kind，别让列表里出现 trace_id 这种内部字段。 */
const ENUM_VALUE = {
  c2c: '私聊', group: '群聊', channel: '频道', text: '文本', image: '图片', voice: '语音', file: '文件',
  single: '整条发送', segmented: '分条发送', batch: '批量', reply: '回复', proactive: '主动',
};
const HUMAN_KEY = {
  kind: { label: '', suffix: '' },
  input_kind: { label: '', suffix: '输入' },
  text_length: { label: '', suffix: '字' },
  delivery_kind: { label: '', suffix: '' },
  subtype: { label: '', suffix: '' },
  videos: { label: '视频', suffix: '个' },
  comments: { label: '评论', suffix: '条' },
  count: { label: '', suffix: '条' },
};

export function digestOf(payload, max = 120) {
  const data = parseMaybeJson(payload);
  if (!data || typeof data !== 'object') return data == null ? '' : String(data).slice(0, max);
  // 授权项核验：直接写「6/7 就绪（缺 qq.hangup）」，别把 ready/total/missing 三个键名搬上来
  if (typeof data.ready === 'number' && typeof data.total === 'number') {
    const missing = Array.isArray(data.missing) && data.missing.length ? `（缺 ${data.missing.join('、')}）` : '';
    return `${data.ready}/${data.total} 就绪${missing}`.slice(0, max);
  }
  const parts = [];
  const seen = new Set();
  // 去重按「值」而不是按整串：status=running 与 working_status=running 说的是同一件事。
  const push = (value, text) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    parts.push(text);
  };
  for (const key of DIGEST_KEYS) {
    const raw = data[key];
    if (raw == null || raw === '') continue;
    const value = typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
    push(value, `${key}=${value}`);
    if (parts.length >= 4) break;
  }
  if (!parts.length) {
    for (const [key, spec] of Object.entries(HUMAN_KEY)) {
      const raw = data[key];
      if (raw == null || raw === '') continue;
      const value = String(raw);
      push(value, `${ENUM_VALUE[value] ?? value}${spec.suffix}`);
      if (parts.length >= 3) break;
    }
  }
  // 消息类事件带 preview（消息前 80 字）：直接把这句人话放在最前面，
  // 列表上就能看到「爸爸说了什么」，不用点开。
  const preview = typeof data.preview === 'string' ? data.preview.trim() : '';
  if (preview) parts.unshift(`「${preview.length > 60 ? `${preview.slice(0, 60)}…` : preview}」`);
  const joined = parts.join(' · ') || Object.keys(data).slice(0, 3).filter((key) => key !== 'trace_id').join(', ');
  return joined.length > max ? `${joined.slice(0, max)}…` : joined;
}

export const CHANNEL_LABEL = Object.freeze({
  qq: 'QQ', wechat: '微信', ilink: '微信', call: '通话', desktop: '桌宠', android: '安卓', board: '看板', douyin: '抖音', plan: '日程', system: '系统',
});

/**
 * 已知但还没接进页面的业务事件（写清楚为什么，别让"漏了"和"故意没做"混在一起）。
 * 覆盖检查 tests/live-coverage.test.mjs 会要求：EVENT_TYPES 里的每个类型，
 * 要么在 EVENT_ROUTE 里有归属，要么在这里登记理由。
 */
export const UNMAPPED_EVENTS = Object.freeze({
  plan_created: '只有计划模块内部用，事件带不出可展示的结构，先不点亮（要展示得先补 payload）',
  action_requested: '和 action_started 同义、且只在执行入口发一次，页面按 action_started 显示即可',
  user_corrected: '人工纠错还没有真正的写入点（谁在哪儿纠错没定义），等埋点定下来再点亮',
});

export function channelLabel(channel) {
  return CHANNEL_LABEL[String(channel ?? '')] ?? String(channel ?? '系统');
}

export default { STATES, STAGES, STAGE_IDS, EVENT_ROUTE, UNMAPPED_EVENTS, stageForEvent, stateOfStatus, digestOf, channelLabel, CHANNEL_LABEL };
