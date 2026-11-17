import { runAction } from '../actions.mjs';
import { recordAgentEvent, normalizeChannel } from '../agent-events.mjs';
import { AUTO_ACTIONS } from '../douyin/dayplan.mjs';
import { evaluatePolicy } from '../policy.mjs';
import { interactionEvent } from '../core-contract.mjs';
import { hasTable } from './migrations.mjs';
import { EXTERNAL_STAGE, safeRecordPerformance } from '../performance.mjs';

const SYSTEM_EVENT = Object.freeze({
  sender: Object.freeze({ role: 'system' }),
  trust: Object.freeze({ instruction_trust: 'trusted_system' }),
});

function operationsOf(task) {
  try {
    const value = JSON.parse(task.payload);
    return { operations: Array.isArray(value.operations) ? value.operations : [], requiresConfirmation: value.requires_confirmation };
  } catch { return { operations: [], requiresConfirmation: true }; }
}

/**
 * 外部动作闸门的性能样本（计划 P1-C / C-5）。
 * stage 统一 external.execute：被策略拒绝（outcome=rejected）和真的执行（executed/failed）都进统计，
 * success 只在「动作真的跑成」时为 true，所以这条 stage 的成功率 = 外部动作的端到端成功率。
 * 旁路：写不进去不影响闸门判定。
 */
function sampleExternal(db, { operation, outcome, durationMs, channel = 'system', taskId = null, error = null }) {
  if (!db) return;
  safeRecordPerformance(db, {
    stage: EXTERNAL_STAGE,
    channel: normalizeChannel(channel),
    taskId,
    durationMs,
    success: outcome === 'executed',
    metadata: error ? { operation, outcome, error } : { operation, outcome },
  });
}

/** Check the persisted task and its grant immediately before dispatching an action. */
export async function executeTaskAction({ db, taskId, operation, event = null, root, args = {}, execute = runAction }) {
  const started = Date.now();
  const channel = event?.channel ?? 'system';
  const task = db.prepare('SELECT * FROM external_tasks WHERE id=?').get(taskId);
  const payload = task ? operationsOf(task) : { operations: [], requiresConfirmation: true };
  const requested = payload.operations.includes(operation)
    || (payload.operations.includes('douyin.publish') && ['douyin.draft', 'douyin.publish_draft'].includes(operation));
  const automatic = task?.origin === 'plan' && task?.approver_peer_id == null
    && payload.requiresConfirmation === false && payload.operations.length === 1 && AUTO_ACTIONS.has(operation);
  const approved = Boolean(task?.approver_peer_id && event?.sender?.platform_user_id === task.approver_peer_id);
  const decision = evaluatePolicy(automatic ? SYSTEM_EVENT : event, 'external.execute', { approved, automatic, operation });
  if (!task || task.status !== 'running' || !requested || !decision.allowed) {
    recordAgentEvent(db, {
      eventType: 'action_failed', channel: 'system', taskId: task ? taskId : null, actor: 'policy',
      payload: { operation, requested_task_id: task ? null : String(taskId ?? '').slice(0, 80), reason: 'external_action_unauthorized' },
      result: { ok: false, error: 'external_action_unauthorized' },
    });
    sampleExternal(db, {
      operation, outcome: 'rejected', durationMs: Date.now() - started, channel,
      taskId: task ? taskId : null, error: 'external_action_unauthorized',
    });
    return { ok: false, error: 'external_action_unauthorized' };
  }
  try {
    const outcome = await execute(operation, { root, args, channel, taskId });
    const ok = outcome?.ok === true;
    sampleExternal(db, {
      operation, outcome: ok ? 'executed' : 'failed', durationMs: Date.now() - started, channel, taskId,
      error: ok ? null : String(outcome?.error ?? 'action_failed').slice(0, 400),
    });
    return outcome;
  } catch (error) {
    sampleExternal(db, {
      operation, outcome: 'failed', durationMs: Date.now() - started, channel, taskId,
      error: errorDetail(error),
    });
    throw error;
  }
}

/**
 * 把子进程失败变成一句能诊断的话：Command failed 只说「失败了」，
 * 真正的原因在后面 stderr 里（node 的堆栈、adb 的报错），不能丢。
 */
function errorDetail(error, max = 600) {
  const parts = [String(error?.message ?? error ?? '')];
  const stderr = String(error?.stderr ?? '').trim();
  if (stderr && !parts[0].includes(stderr.slice(0, 40))) parts.push(stderr);
  return parts.join(' | ').replace(/\s+/gu, ' ').trim().slice(0, max);
}

/** A standalone approval may execute only its scoped operations and bound task. */
export async function executeApprovalAction({ db, approvalRequestId, expectedTaskId = null, ownerId, operation, root, args = {}, execute = runAction }) {
  const started = Date.now();
  // approvals 表由 connect/approvals.mjs 的 initApprovalLedger 惰性创建；
  // 首次审批之前来一个带 approval_request_id 的请求不能炸成 500，按「未授权」处理。
  const approval = hasTable(db, 'approvals') ? db.prepare('SELECT * FROM approvals WHERE id=?').get(approvalRequestId) : null;
  let operations = [];
  try { operations = JSON.parse(approval?.operations_json ?? '[]'); } catch {}
  const valid = approval?.task_id === expectedTaskId && approval.decision === 'approved'
    && approval.approver_role === 'owner' && approval.approver_peer_id === ownerId
    && Boolean(approval.message_id) && Array.isArray(operations) && operations.includes(operation)
    && (expectedTaskId !== null || approval.used_ms == null);
  const event = valid ? interactionEvent({ channel: 'qq', conversationId: ownerId, senderId: ownerId, senderRole: 'owner', text: 'approved plan', sourceEventId: approval.message_id }) : null;
  const channel = event?.channel ?? 'system';
  const decision = evaluatePolicy(event, 'external.execute', { approved: valid });
  const reserved = valid && decision.allowed && expectedTaskId === null
    ? db.prepare('UPDATE approvals SET used_ms=? WHERE id=? AND used_ms IS NULL').run(Date.now(), approvalRequestId).changes === 1
    : true;
  if (!valid || !decision.allowed || !reserved) {
    recordAgentEvent(db, {
      eventType: 'action_failed', channel: 'system', taskId: expectedTaskId, actor: 'policy',
      payload: { operation, approval_request_id: approvalRequestId, reason: 'external_action_unauthorized' },
      result: { ok: false, error: 'external_action_unauthorized' },
    });
    sampleExternal(db, {
      operation, outcome: 'rejected', durationMs: Date.now() - started, channel,
      taskId: expectedTaskId, error: 'external_action_unauthorized',
    });
    return { ok: false, error: 'external_action_unauthorized' };
  }
  try {
    const outcome = await execute(operation, { root, args, channel, taskId: expectedTaskId });
    const ok = outcome?.ok === true;
    sampleExternal(db, {
      operation, outcome: ok ? 'executed' : 'failed', durationMs: Date.now() - started, channel, taskId: expectedTaskId,
      error: ok ? null : String(outcome?.error ?? 'action_failed').slice(0, 400),
    });
    return outcome;
  } catch (error) {
    sampleExternal(db, {
      operation, outcome: 'failed', durationMs: Date.now() - started, channel, taskId: expectedTaskId,
      error: errorDetail(error),
    });
    throw error;
  }
}

export function executePlanAction({ planId, ...options }) {
  return executeApprovalAction({ ...options, expectedTaskId: planId });
}
