import { recordAgentEvent } from './agent-events.mjs';

// 计划 P0-C-3：回执五态。以前只有 {succeeded, failed, unknown}，把「我调用了」
// 和「平台收到了」和「业务真的成了」混成一个 succeeded，结果无从验证（架构 ADR：
// 执行结果需验证）。现在拆成五态，正好用上 runTool 一直带着却没人读的 `verified` 字段。
//
//   invoked   已调用（只知道自己按了，平台还没确认）
//   accepted  平台已接受（适配器回报成功，但业务结果没独立核对）
//   verified  业务已验证（真的去看过结果，确实成了）
//   failed    明确失败
//   unknown   无法判断（没有回执 / 返回体缺字段）
//
// 三态语义（invoked → accepted → verified）是「成功这条腿」的置信度递进；
// failed / unknown 是「没成」的两种。任务完成判断用 receiptOk()（前三态都算腿迈出去了），
// 只有要严格核账时才用 receiptVerified()。

export const STATUS = Object.freeze(['invoked', 'accepted', 'verified', 'failed', 'unknown']);

/** 这条腿算不算迈出去了（非失败、非未知）。任务能否推进用它。 */
const WENT_THROUGH = new Set(['invoked', 'accepted', 'verified']);
export function receiptOk(status) {
  return WENT_THROUGH.has(String(status ?? ''));
}

/** 严格口径：只有业务真核对过才算。 */
export function receiptVerified(status) {
  return String(status ?? '') === 'verified';
}

/**
 * 把一条工具/适配器结果归到五态之一。
 * 判定顺序：明确失败 > 明确核验通过 > 报了成功（看有没有 accepted 标记）> 只知调用 > 未知。
 */
export function classifyResult(result) {
  if (!result || typeof result !== 'object') return 'unknown';
  if (result.ok === false) return 'failed';
  if (result.verified === true) return 'verified';
  if (result.ok === true) return result.accepted === false ? 'invoked' : 'accepted';
  if (result.invoked === true) return 'invoked';
  return 'unknown';
}

export function createReceipt({ operation, adapter = 'unknown', result = {}, observedAt = new Date().toISOString(), evidence = [] } = {}) {
  const status = classifyResult(result);
  const through = receiptOk(status);
  return {
    operation,
    adapter,
    status,
    observed_at: observedAt,
    evidence: Array.isArray(evidence) ? evidence.slice(0, 20) : [],
    detail: through
      ? String(result?.text ?? '').slice(0, 500)
      : String(result?.error ?? 'unknown').slice(0, 240),
  };
}

export function validateReceipt(receipt) {
  return Boolean(
    receipt
    && typeof receipt.operation === 'string'
    && STATUS.includes(receipt.status)
    && typeof receipt.adapter === 'string'
    && typeof receipt.observed_at === 'string'
    && Array.isArray(receipt.evidence),
  );
}

/** 回执五态 → 统一事件流的事件类型。 */
const EVENT_BY_STATUS = Object.freeze({
  invoked: 'action_started',
  accepted: 'action_finished',
  verified: 'receipt_verified',
  failed: 'action_failed',
  unknown: 'observation_created',
});

export function recordReceipt(db, receipt, { taskId = null, channel = 'system', privacyScope = 'private' } = {}) {
  if (!validateReceipt(receipt)) throw new Error('invalid_receipt');
  return recordAgentEvent(db, {
    eventType: EVENT_BY_STATUS[receipt.status] ?? 'observation_created',
    channel,
    taskId,
    actor: 'adapter',
    payload: { operation: receipt.operation, adapter: receipt.adapter, status: receipt.status },
    result: { status: receipt.status, detail: receipt.detail },
    evidence: receipt.evidence,
    privacyScope,
    dedupeKey: taskId ? `receipt:${taskId}:${receipt.operation}:${receipt.observed_at}` : null,
    at: receipt.observed_at,
  });
}
