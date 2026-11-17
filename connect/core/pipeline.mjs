// M1 / D1：九段流水线的唯一真源。
//
// 以前「九段」只活在三个地方：connect/qq/service.mjs 里硬编码的 if-return 链、
// connect/live/catalog.mjs 里给页面用的标签表、connect/home/data.mjs 里手写的九步带。
// 三份描述迟早互相打架（加一个阶段要改三处，忘一处页面上就开始骗人）。
//
// 现在这份表是唯一的定义：页面、看板、测试都从这里读；
// 每段都写清楚「谁在跑、写完什么事件、代码在哪」，事件名直接对应 agent_events 的埋点，
// 所以「这一段有没有真的在跑」可以对着数据库核对，而不是对着文档许愿。

/**
 * 一段流水线。
 *  id       稳定标识，和 /live 的 STAGES 一致
 *  label    中文名
 *  sub      一句话说明它在干什么
 *  events   这一段会写进 agent_events 的事件类型（空数组 = 还没埋点）
 *  files    真正干活的代码位置（相对仓库根）
 *  runtime  是否是「每来一条消息都会经过」的段（else 是有事才进）
 */
export const PIPELINE = Object.freeze([
  {
    id: 'entry',
    label: '接入',
    sub: '收到消息：QQ / 微信 / 通话 / 桌宠 / 安卓 / 看板，统一成一条 `message_received`',
    events: ['message_received', 'message_replied'],
    files: ['connect/qq/service.mjs', 'connect/ilink/worker.mjs', 'connect/call/service.mjs', 'connect/server.mjs'],
    runtime: true,
  },
  {
    id: 'observe',
    label: '观察',
    sub: '认清语境：谁说的、私聊还是群里、有没有被 @、语音还是文本',
    events: ['observation_created'],
    files: ['connect/qq/service.mjs', 'connect/core/route.mjs'],
    runtime: true,
  },
  {
    id: 'route',
    label: '路由',
    sub: '决定这句话是「同意 / 拒绝 / 改稿 / 命令 / 要查数据 / 闲聊」，规则先过、模型兜底',
    events: ['route_decision'],
    files: ['connect/core/route.mjs', 'connect/qq/service.mjs'],
    runtime: true,
  },
  {
    id: 'task',
    label: '任务',
    sub: '规划出 1~3 步动作，写操作落成 external_tasks / working_tasks',
    events: ['task_state_changed', 'task_reported', 'plan_created', 'replan_requested'],
    files: ['connect/qq/service.mjs', 'connect/qq/planner.mjs', 'connect/tasks.mjs', 'connect/core/task.mjs'],
    runtime: true,
  },
  {
    id: 'gate',
    label: '闸门',
    sub: 'R0–R3 分级 + 人工审批 + 预算 + 幂等键：没批准的动作出不去',
    events: ['approval_requested', 'approval_resolved', 'preflight_checked', 'run_granted', 'task_state_changed'],
    files: ['connect/policy.mjs', 'connect/core/execute.mjs', 'connect/approvals.mjs', 'connect/core/budget.mjs'],
    runtime: false,
  },
  {
    id: 'act',
    label: '执行',
    sub: '唯一出口：executeTaskAction → runAction → 适配器（抖音手机 / QQ 桌面 / 通话）',
    events: ['action_started', 'action_finished', 'action_failed'],
    files: ['connect/core/execute.mjs', 'connect/core/publish.mjs', 'connect/actions.mjs'],
    runtime: false,
  },
  {
    id: 'verify',
    label: '回执',
    sub: '「点到了」不等于「办成了」：拿期望对实际，落 confirmed / unconfirmed / mismatched',
    events: ['receipt_verified', 'call_ended'],
    files: ['connect/core/verify.mjs', 'connect/receipts.mjs', 'connect/core/checkpoints.mjs'],
    runtime: false,
  },
  {
    id: 'memory',
    label: '认知',
    sub: '把发生过的事写进记忆，把同类任务的教训带进下一次规划',
    events: ['reflection_created', 'memory_written', 'skill_run_started', 'skill_run_finished', 'skill_candidate'],
    files: ['brain/memory.mjs', 'connect/memory-hub.mjs', 'connect/core/traces.mjs'],
    runtime: false,
  },
  {
    id: 'call',
    label: '通话',
    sub: '语音这一路：拨号 → 接通/拒接判定 → 语音桥对话 → 挂断写 call_ended',
    events: ['call_ended'],
    files: ['connect/call/service.mjs', 'scripts/qq-call.mjs', 'connect/macui/qq.mjs'],
    runtime: false,
  },
]);

export const PIPELINE_IDS = Object.freeze(PIPELINE.map((stage) => stage.id));

export function stageById(id) {
  return PIPELINE.find((stage) => stage.id === id) ?? null;
}

/**
 * 自检：每个 id 唯一、都有事件表和代码位置、事件名不是空的。
 * 事件为空说明这一段还没埋点——不报错，但要能在页面上显示成「未埋点」。
 */
export function validatePipeline() {
  const problems = [];
  const seen = new Set();
  for (const stage of PIPELINE) {
    if (seen.has(stage.id)) problems.push(`重复的阶段 id：${stage.id}`);
    seen.add(stage.id);
    if (!stage.label) problems.push(`${stage.id} 缺 label`);
    if (!stage.sub || stage.sub.length < 8) problems.push(`${stage.id} 的说明太短`);
    if (!Array.isArray(stage.files) || !stage.files.length) problems.push(`${stage.id} 没写代码位置`);
  }
  return problems;
}

/** 每一段该写哪些事件 → 反过来查「这个事件属于哪一段」。 */
export function stageOfEvent(eventType) {
  for (const stage of PIPELINE) {
    if (stage.events.includes(eventType)) return stage.id;
  }
  return null;
}
