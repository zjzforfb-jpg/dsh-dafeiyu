/**
 * 大肥鱼统一智能体 · 架构图数据（唯一真源）。
 *
 * 这份文件同时被浏览器（connect/arch/main.js）和测试（tests/arch-graph.test.mjs）读取：
 * 坐标、颜色、依赖边、以及「事件 → 经过哪些节点」的路径表都在这里，页面只负责画。
 *
 * 图上的每个节点都能对应到仓库里的真实文件，别只当装饰：改架构时先改这张表。
 */

/** 七层里的一条（用来给节点分组上色）。 */
export const LAYERS = Object.freeze({
  channel: { label: '感知接入', color: '#22d3ee' },
  runtime: { label: '统一内核', color: '#818cf8' },
  cognition: { label: '认知与记忆', color: '#f472b6' },
  foundation: { label: '调度与自主', color: '#fbbf24' },
});

/**
 * @typedef {{id:string,label:string,sub:string,layer:string,pos:[number,number,number],
 *   size:number,facts:string[],hint:string}} Node
 */

/** @type {Node[]} */
export const NODES = [
  // ── 感知接入：外圈，所有渠道都把消息收敛成同一个 InteractionEvent ──
  {
    id: 'qq', label: 'QQ', sub: '私聊 / 群聊', layer: 'channel', pos: [-13.2, 0, 0.5], size: 1.05,
    hint: '六段主链路：ingest → identify → route → plan → executePlan → deliver',
    facts: ['connect/qq/gateway.mjs', 'connect/qq/service.mjs:336 handle()', 'connect/qq/store.mjs'],
  },
  {
    id: 'ilink', label: '微信 iLink', sub: '长轮询 + 共享预算', layer: 'channel', pos: [-9.5, 0, 9.5], size: 0.95,
    hint: 'iLink 从按账号记账改成跨渠道共享同一池',
    facts: ['connect/ilink/protocol.mjs', 'connect/ilink/store.mjs:30 ingestUpdates', 'connect/ilink/worker.mjs'],
  },
  {
    id: 'call', label: '语音通话', sub: 'WS PCM16 · 一等渠道', layer: 'channel', pos: [-0.2, 0, 13.4], size: 0.95,
    hint: 'D-3：通话事件 message_received/replied 落 agent_events，channel=call',
    facts: ['connect/call/service.mjs:38 emitEvent', 'connect/server.mjs:164 onEvent'],
  },
  {
    id: 'desktop', label: '桌宠', sub: 'macOS 常驻', layer: 'channel', pos: [9.3, 0, 9.6], size: 1.0,
    hint: '桌宠 → dsh-pet:3108 → Brain:3110（OpenAI 格式代理）',
    facts: ['scripts/run-pet.mjs', 'desktop/activity.mjs:72 publishDesktopActivity', 'connect/core/event-store.mjs'],
  },
  {
    id: 'android', label: 'Android', sub: 'Honor Magic5', layer: 'channel', pos: [13.3, 0, 0.2], size: 0.95,
    hint: 'WS /device：Bearer token + x-device-id，register/heartbeat/result/event',
    facts: ['connect/server.mjs:585 WS /device', 'device/uia.mjs', 'device/douyin.mjs'],
  },
  {
    id: 'board', label: '看板', sub: '网页 /board', layer: 'channel', pos: [9.5, 0, -9.5], size: 0.9,
    hint: '只读视图 + 少量操作入口；读的就是 agent_events 同一份真源',
    facts: ['connect/board-page.mjs', 'connect/board.mjs:67 boardSnapshot', 'GET /api/board'],
  },
  {
    id: 'douyin', label: '抖音', sub: '评论 / 发布', layer: 'channel', pos: [-0.4, 0, -13.4], size: 0.95,
    hint: '抖音没有官方推送，走设备自动化：评论流水线七段，全步骤可注入可测',
    facts: ['connect/core/comment-pipeline.mjs', 'connect/douyin/review.mjs', 'device/douyin.mjs'],
  },

  // ── 统一内核：中圈，所有渠道共用这一套 ──
  {
    id: 'events', label: '事件流', sub: 'agent_events · 唯一真源', layer: 'runtime', pos: [-5.8, 0, -5.8], size: 1.35,
    hint: '所有进程写事件都从 core/event-store.mjs 拿连接，不再各建一张同构表',
    facts: ['connect/agent-events.mjs:16 CHANNELS', 'connect/core/event-store.mjs', 'agent_events.trace_id + 索引'],
  },
  {
    id: 'route', label: '路由', sub: 'routePolicy', layer: 'runtime', pos: [-8.5, 0, 0], size: 1.15,
    hint: '单一裁决：这条消息是闲聊、要查、还是要动手',
    facts: ['connect/core/route.mjs:82 routePolicy', 'connect/core/llm.mjs chatCompletion'],
  },
  {
    id: 'tasks', label: '任务', sub: 'AgentTask 九态', layer: 'runtime', pos: [-4.3, 0, 4.3], size: 1.2,
    hint: 'external_tasks + working_tasks 镜像；目标也挂进同一张表（createGoalTask）',
    facts: ['connect/core/task.mjs', 'connect/tasks.mjs', 'connect/tasks.mjs:54 createGoalTask'],
  },
  {
    id: 'gate', label: '执行闸门', sub: '策略 R0–R3', layer: 'runtime', pos: [0.8, 0, 6.5], size: 1.3,
    hint: '唯一执行出口：evaluatePolicy(event,"external.execute") 不放行就不动手',
    facts: ['connect/core/execute.mjs', 'connect/policy.mjs:11 evaluatePolicy'],
  },
  {
    id: 'actions', label: '动作 / 设备', sub: '17 动作 · UI 自动化', layer: 'runtime', pos: [5.5, 0, 4.3], size: 1.2,
    hint: '拿到授权后才真的点手机、发内容；每步留回执',
    facts: ['connect/actions.mjs:26 ACTIONS', 'device/uia.mjs', 'connect/receipts.mjs'],
  },
  {
    id: 'approvals', label: '审批', sub: 'owner-only 一次性', layer: 'runtime', pos: [4.0, 0, -4.5], size: 1.0,
    hint: '审批落库、校验发起人、used_ms 一次性消费；不再是谁打「同意」都算',
    facts: ['connect/approvals.mjs', 'connect/core/execute.mjs executeApprovalAction'],
  },
  {
    id: 'budget', label: '预算', sub: 'daily_budget 共享池', layer: 'runtime', pos: [-1.0, 0, -7.0], size: 1.0,
    hint: 'QQ / 微信 / life 三个渠道落到同一行；model_calls 与 autonomous_actions 互不干扰',
    facts: ['connect/core/budget.mjs', 'daily_budget(day, model_calls, autonomous_actions, voice_requests)'],
  },

  // ── 认知与记忆：上层 ──
  {
    id: 'brain', label: 'Brain', sub: 'LLM 代理 :3110', layer: 'cognition', pos: [-1.8, 6.6, 2.4], size: 1.3,
    hint: 'OpenAI 兼容代理；接受 ilink/qq 身份信封，群聊冒充 owner 直接 400',
    facts: ['brain/server.mjs:117 信封校验', 'brain/cognition/kernel.mjs', 'POST /v1/chat/completions'],
  },
  {
    id: 'memory', label: '记忆', sub: '七类 · scope 隔离', layer: 'cognition', pos: [-4.6, 6.8, -1.6], size: 1.1,
    hint: 'private / group / public 三档；群聊记忆不会漏进主人私聊召回',
    facts: ['brain/memory.mjs:91 recall scope', 'brain/migrations.mjs v15', 'connect/core/memory.mjs search'],
  },
  {
    id: 'skills', label: '技能', sub: '账本 + 结构化断言', layer: 'cognition', pos: [2.8, 6.8, -1.2], size: 1.05,
    hint: '晋升要真实 verified run + 逐步重放断言全过；核不了就不升',
    facts: ['connect/skills/ledger.mjs', 'connect/skills/assertions.mjs', 'connect/skills/promotion.mjs'],
  },

  // ── 调度与自主：下层 ──
  {
    id: 'scheduler', label: '调度器', sub: '60s tick', layer: 'foundation', pos: [-2.8, -6.6, -1.4], size: 1.0,
    hint: '心情 / 日程 / 到点任务 / 复盘；不自批，全走 executeTaskAction 同一闸门',
    facts: ['connect/scheduler.mjs:113 tick', 'connect/scheduler.mjs:184 startScheduler'],
  },
  {
    id: 'life', label: '生活/目标', sub: 'explore ↔ 统一任务', layer: 'foundation', pos: [2.6, -6.6, 1.6], size: 1.0,
    hint: '每天的探索先建 reflection，再 createGoalTask 拿统一任务 id，linkGoalTask 指过去',
    facts: ['life/manager.mjs', 'life/tasks.mjs:41 linkGoalTask', 'scripts/life.mjs'],
  },
];

/** 中庭那颗「大肥鱼」本体。 */
export const CORE = Object.freeze({
  id: 'core', label: '大肥鱼', sub: '统一智能体', pos: [0, 0.6, 0], size: 1.5,
  hint: '所有渠道、所有任务、所有记忆共用同一套契约；这张图上的每条边都有 file:line 出处',
  facts: ['docs/UNIFIED_AGENT_IMPLEMENTATION_PLAN.md', 'docs/capabilities/', 'CLAUDE.md'],
});

/**
 * 有向边。[from, to, 曲率, 样式]
 * 曲率 0 = 直线；正负决定弯向，用来把边错开避免重叠。
 */
export const EDGES = Object.freeze([
  ['qq', 'events', 0.18, 'main'],
  ['ilink', 'events', 0.16, 'main'],
  ['call', 'events', 0.14, 'main'],
  ['desktop', 'events', 0.14, 'main'],
  ['android', 'events', 0.12, 'main'],
  ['douyin', 'events', 0.12, 'main'],
  ['board', 'events', -0.18, 'faint'],
  ['events', 'route', 0.1, 'main'],
  ['route', 'brain', -0.12, 'main'],
  ['brain', 'memory', 0.2, 'main'],
  ['route', 'tasks', -0.14, 'main'],
  ['tasks', 'gate', 0.12, 'main'],
  ['gate', 'actions', 0.1, 'main'],
  ['gate', 'approvals', 0.24, 'main'],
  ['approvals', 'gate', -0.2, 'dashed'],
  ['gate', 'budget', 0.2, 'dashed'],
  ['actions', 'events', 0.4, 'faint'],
  ['actions', 'douyin', 0.34, 'main'],
  ['scheduler', 'gate', -0.18, 'main'],
  ['scheduler', 'tasks', 0.16, 'faint'],
  ['life', 'tasks', -0.28, 'main'],
  ['skills', 'events', 0.2, 'faint'],
  ['memory', 'events', 0.16, 'faint'],
  ['board', 'tasks', 0.3, 'faint'],
]);

/**
 * 事件类型 → 一条路径（节点 id 序列）。
 * 路径必须由 EDGES 里真实存在的边连接，测试会核这件事。
 */
export const PATHS = Object.freeze({
  received: ['{channel}', 'events', 'route', 'brain'],
  replied: ['brain', 'route', 'events', '{channel}'],
  plan: ['route', 'tasks', 'gate'],
  action: ['tasks', 'gate', 'actions'],
  finished: ['actions', 'events', '{channel}'],
  failed: ['gate', 'actions', 'events'],
  task: ['tasks', 'gate', 'budget'],
  reported: ['tasks', 'gate', 'actions', 'events', '{channel}'],
  verified: ['actions', 'events'],
  corrected: ['{channel}', 'events', 'memory'],
  reflection: ['memory', 'events', 'skills'],
  observation: ['{channel}', 'events', 'memory'],
  // 通话结束：从通话渠道点回事件流，落在 事件流/记忆 之间，看得出「这通电话结束了」。
  callEnded: ['{channel}', 'events'],
});

/** agent_events.event_type → 路径键 + 颜色。 */
export const EVENT_STYLE = Object.freeze({
  message_received: { path: 'received', color: '#22d3ee', label: '收到消息' },
  message_replied: { path: 'replied', color: '#34d399', label: '已回复' },
  plan_created: { path: 'plan', color: '#a78bfa', label: '生成计划' },
  action_requested: { path: 'action', color: '#fbbf24', label: '请求动作' },
  action_started: { path: 'action', color: '#fb923c', label: '开始执行' },
  action_finished: { path: 'finished', color: '#4ade80', label: '执行完成' },
  action_failed: { path: 'failed', color: '#ef4444', label: '执行失败' },
  task_state_changed: { path: 'task', color: '#c084fc', label: '任务状态' },
  task_reported: { path: 'reported', color: '#38bdf8', label: '任务回报' },
  call_ended: { path: 'callEnded', color: '#f97316', label: '通话结束' },
  receipt_verified: { path: 'verified', color: '#facc15', label: '回执已核' },
  user_corrected: { path: 'corrected', color: '#f97316', label: '主人纠正' },
  reflection_created: { path: 'reflection', color: '#60a5fa', label: '写入反思' },
  observation_created: { path: 'observation', color: '#2dd4bf', label: '观察记录' },
});

/** agent_events.channel → 外圈节点。未知/系统事件落到 events 本身。 */
export const CHANNEL_NODE = Object.freeze({
  qq: 'qq', wechat: 'ilink', ilink: 'ilink', call: 'call',
  desktop: 'desktop', android: 'android', douyin: 'douyin', board: 'board',
  system: 'events',
});

export function nodesById() {
  return new Map(NODES.map((node) => [node.id, node]));
}

/** 边查找表（无向：画流光是双向可走的）。 */
export function edgeKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function edgeSet() {
  return new Set(EDGES.map(([from, to]) => edgeKey(from, to)));
}

/**
 * 把一条事件解析成可动画的节点路径。
 * @param {{eventType?:string, channel?:string}} event
 * @returns {{path:string[], color:string, label:string, eventType:string, channel:string}}
 */
export function pathForEvent(event = {}) {
  const eventType = String(event.eventType ?? event.event_type ?? 'observation_created');
  const channel = String(event.channel ?? 'system');
  const style = EVENT_STYLE[eventType] ?? { path: 'observation', color: '#94a3b8', label: eventType };
  const template = PATHS[style.path] ?? PATHS.observation;
  const node = CHANNEL_NODE[channel] ?? 'events';
  const path = template.map((id) => (id === '{channel}' ? node : id));
  return { path, color: style.color, label: style.label, eventType, channel };
}

/** 数据自检：返回问题列表，空数组表示这张图是自洽的。 */
export function validateGraph() {
  const problems = [];
  const ids = new Set([...NODES.map((node) => node.id), CORE.id]);
  if (ids.size !== NODES.length + 1) problems.push('节点 id 重复');
  for (const node of [...NODES, CORE]) {
    if (!LAYERS[node.layer] && node.id !== CORE.id) problems.push(`未知分层：${node.id}/${node.layer}`);
    if (!Array.isArray(node.facts) || node.facts.length === 0) problems.push(`缺 facts：${node.id}`);
    if (node.pos.length !== 3 || node.pos.some((value) => !Number.isFinite(value))) problems.push(`坐标非法：${node.id}`);
  }
  const edges = edgeSet();
  for (const [from, to] of EDGES) {
    if (!ids.has(from) || !ids.has(to)) problems.push(`边指向不存在的节点：${from}->${to}`);
  }
  for (const [name, template] of Object.entries(PATHS)) {
    for (let i = 0; i < template.length - 1; i += 1) {
      const a = template[i] === '{channel}' ? 'qq' : template[i];
      const b = template[i + 1] === '{channel}' ? 'qq' : template[i + 1];
      if (!edges.has(edgeKey(a, b))) problems.push(`路径 ${name} 用了不存在的边：${a}->${b}`);
    }
  }
  for (const [type, style] of Object.entries(EVENT_STYLE)) {
    if (!PATHS[style.path]) problems.push(`事件 ${type} 指向不存在的路径：${style.path}`);
    if (!/^#[0-9a-f]{6}$/iu.test(style.color)) problems.push(`事件 ${type} 颜色非法`);
  }
  return problems;
}
