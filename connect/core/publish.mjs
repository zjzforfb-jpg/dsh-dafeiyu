// 计划 P0-B-6：两段式发布握手只有一份实现。
//
// 「做内容 → 爸爸审 → 真发」这个流程以前在四处各写一遍：
//   connect/qq/service.mjs（私聊里批准）
//   connect/server.mjs（看板上写一条）
//   connect/scheduler.mjs（日程触发）
//   connect/douyin/daily.mjs（日常内容）
// 现在统一到 executeOperations() + 两段的动作映射表 + 统一的发布任务意图。

import { proposeTask } from '../tasks.mjs';
import { createReceipt, receiptOk, recordReceipt } from '../receipts.mjs';
import { doneSteps, recordCheckpoint } from './checkpoints.mjs';
import { reflectOnActionFailure } from './reflect.mjs';
import { evaluateOutcome, VERDICTS } from './verify.mjs';

/** 发布链路的三个阶段。 */
export const PUBLISH_STAGES = Object.freeze({
  draft: 'draft',       // 第一段：把内容做出来，等人审
  publish: 'publish',   // 第二段：内容审过了，真的按发布
  direct: 'direct',     // 不需要审的一次性动作
});

/** 发布类动作。命中它的任务走两段式。 */
export const PUBLISH_OPERATIONS = Object.freeze(['douyin.publish']);

/**
 * 第一段的动作映射：用户要「发布」，第一段其实是「写草稿」。
 * @param {string} operation 原始动作名
 */
export function draftOperationFor(operation) {
  return operation === 'douyin.publish' ? 'douyin.draft' : operation;
}

/**
 * 第二段的动作映射：草稿审过了，去按发布。
 * @param {string} operation 原始动作名
 * @param {object} prepared  草稿（{stage:'draft', draftFile}）
 */
export function publishOperationFor(operation, prepared = {}) {
  if (prepared?.stage === 'draft') return 'douyin.publish_draft';
  return operation;
}

/** 这个任务是不是要两段式。 */
export function isPublishTask(operations = []) {
  return (Array.isArray(operations) ? operations : []).some((name) => PUBLISH_OPERATIONS.includes(name));
}

/**
 * 统一的发布任务意图。四处建任务时都走这里，字段不会再各写各的。
 *
 * @param {object} options
 *   operations  动作名数组，默认 ['douyin.publish']
 *   source      来源标记（qq / board / scheduler / daily）
 *   requiresConfirmation  是否要人点头，默认 true
 *   theme       主题（可空）
 *   slot        日程槽位（可空）
 *   target      目标标记，默认 'user_requested'
 *   plan        计划步骤（可空）
 */
export function publishIntent({
  operations = PUBLISH_OPERATIONS,
  source = 'unknown',
  requiresConfirmation = true,
  theme = null,
  slot = null,
  target = 'user_requested',
  plan = null,
} = {}) {
  return {
    intent: 'external_action_request',
    source,
    operations: [...operations],
    target,
    requires_confirmation: Boolean(requiresConfirmation),
    ...(theme ? { theme } : {}),
    ...(slot ? { slot } : {}),
    ...(plan ? { plan } : {}),
  };
}

/**
 * 建一个发布任务（四处共用）。
 *
 * @param {object} options
 *   db / kind / convId / sourceMessageId / origin / now
 *   intent       已构造好的意图（不给就用 publishIntent 造）
 *   expiresMs    过期时间
 */
export function proposePublishTask({
  db,
  kind = 'c2c',
  convId,
  sourceMessageId,
  origin = 'plan',
  now = Date.now(),
  expiresMs = null,
  intent = null,
  ...intentOptions
}) {
  return proposeTask(db, {
    kind,
    convId,
    sourceMessageId,
    intent: intent ?? publishIntent(intentOptions),
    origin,
    expiresMs,
    now,
  });
}

/**
 * 跑一串动作，每步出一条回执。
 *
 * @param {object} options
 *   operations  动作名数组
 *   execute     async (name, args) => {ok, text?, data?, error?}，通常是 executeTaskAction
 *   args        传给 execute 的参数
 *   argsFor     (operation, actionName) => 每次调用单独给的参数
 *   mapAction   (operation, args) => 实际要跑的动作名（两段式靠它切换）
 *   receiptFor  (operation, actionName) => 回执里记的动作名（默认记原始动作）
 *   adapter     回执里的适配器名，默认 'douyin'
 *   adapterFor  (operation) => 适配器名
 *   createReceipt / recordReceipt  回执生成与落库（默认用 connect/receipts.mjs）
 *   db / taskId / channel  落库用
 *   stopOnFailure  一步失败就停，默认 true
 * @returns {{ok:boolean, status:string, receipts:Array, details:string[], errors:string[], data:any}}
 */
export async function executeOperations({
  operations = [],
  execute,
  args = {},
  argsFor = null,
  mapAction = null,
  receiptFor = null,
  adapter = 'douyin',
  adapterFor = null,
  createReceipt: makeReceipt = createReceipt,
  recordReceipt: saveReceipt = recordReceipt,
  db = null,
  taskId = null,
  channel = 'douyin',
  stopOnFailure = true,
  doneStepKeys = null,
  onStepDone = null,
} = {}) {
  const receipts = [];
  const details = [];
  const errors = [];
  let ok = true;
  let data = null;

  // 断点续跑：调用方没显式给 doneStepKeys 时，从快照表还原「哪些步已经成了」。
  const finished = doneStepKeys instanceof Set ? doneStepKeys : (db && taskId ? doneSteps(db, taskId) : null);
  for (const [index, entry] of operations.entries()) {
    // 每个 entry 可以是字符串 action 名，也可以是 {operation|action, step_key, idempotency_key}。
    const isObj = entry !== null && typeof entry === 'object';
    const operation = isObj ? String(entry.operation ?? entry.action ?? '') : String(entry);
    const givenKey = isObj ? String(entry.step_key ?? '').trim() : '';
    // 没给 step_key 时按「第几步 + 动作名」派生一个：同一个任务重跑时它是稳定的，
    // 所以失败重试能跳过已经成功的步骤，而不是整单重来。
    const stepKey = givenKey || `#${index}:${operation}`;
    // 幂等重放：这一步已经执行过就跳过，不重跑。
    if (finished instanceof Set && finished.has(stepKey)) {
      const skipped = makeReceipt({
        operation: receiptFor ? receiptFor(operation, operation) : operation,
        adapter: adapterFor ? adapterFor(operation, operation) : adapter,
        result: { ok: true, text: `跳过：步骤 ${stepKey} 已执行过（幂等重放）` },
      });
      receipts.push({ ...skipped, verdict: VERDICTS.skipped });
      details.push(`跳过：${stepKey}`);
      recordCheckpoint(db, { taskId, stage: 'execute', stepKey, stepIndex: index, operation, input: args, output: { skipped: true }, verdict: VERDICTS.skipped, ok: true });
      continue;
    }
    const actionName = mapAction ? mapAction(operation, args) : operation;
    const callArgs = argsFor ? argsFor(operation, actionName) : args;
    let result = null;
    let failure = null;
    try {
      result = await execute(actionName, callArgs);
    } catch (error) {
      failure = String(error?.message ?? error);
      result = { ok: false, error: failure };
    }
    if (typeof onStepDone === 'function') {
      try { onStepDone(stepKey); } catch { /* 记账失败不该影响执行 */ }
    }
    const receipt = makeReceipt({
      operation: receiptFor ? receiptFor(operation, actionName) : operation,
      adapter: adapterFor ? adapterFor(operation, actionName) : adapter,
      result,
    });
    // 判定「说做到了」和「真做到了」是不是一回事，结论跟着回执一起落库。
    const judged = evaluateOutcome({ operation, result, receipt });
    receipt.verdict = judged.verdict;
    receipt.verdict_reason = judged.reason;
    receipt.evidence = [...(receipt.evidence ?? []), ...judged.evidence].slice(0, 20);
    // 只要不是「确认成功」，就把这次失败归到「动作 + 类别」的账上：
    // 同类反复出现才会被学习闭环升级成提案（见 connect/core/reflect.mjs）。
    if (judged.verdict !== VERDICTS.confirmed && judged.verdict !== VERDICTS.skipped && db) {
      try {
        reflectOnActionFailure(db, { operation, reason: String(judged.reason ?? result?.error ?? 'unknown'), taskId, evidence: { verdict: judged.verdict } });
      } catch { /* 学习是附加信息，不能影响执行结论 */ }
    }
    receipts.push(receipt);
    recordCheckpoint(db, {
      taskId, stage: 'execute', stepKey, stepIndex: index, operation,
      input: callArgs, output: { ok: result?.ok === true, text: result?.text ?? null, data: result?.data ?? null, error: result?.error ?? failure ?? null },
      verdict: judged.verdict, reason: judged.reason ?? '', ok: judged.verdict === VERDICTS.confirmed || judged.verdict === VERDICTS.skipped,
    });
    if (result?.ok && result?.data && !data) data = result.data;
    if (!receiptOk(receipt.status)) {
      ok = false;
      const reason = String(result?.error ?? failure ?? '未知原因');
      errors.push(reason);
      details.push(`失败：${reason}`);
      if (stopOnFailure) break;
    } else {
      details.push(String(result?.text ?? '').trim());
    }
    if (db && saveReceipt) {
      try { saveReceipt(db, receipt, { taskId, channel }); } catch { /* 回执落库失败不该影响执行结果 */ }
    }
  }

  return { ok, status: ok ? 'succeeded' : 'failed', receipts, details, errors, data };
}

/**
 * 第一段：把内容做出来，等爸爸审。
 * 动作映射：douyin.publish → douyin.draft。
 */
export async function prepareDraft(options) {
  return executeOperations({
    ...options,
    mapAction: (operation) => draftOperationFor(operation),
    receiptFor: options?.receiptFor ?? ((operation) => operation),
  });
}

/**
 * 第二段：内容审过了，去真发。
 */
export async function commitPublish(options) {
  const { prepared = null, ...rest } = options ?? {};
  const stage = prepared ?? rest?.args?.prepared ?? {};
  return executeOperations({
    ...rest,
    mapAction: (operation) => publishOperationFor(operation, stage),
    receiptFor: rest?.receiptFor ?? ((operation) => operation),
  });
}
