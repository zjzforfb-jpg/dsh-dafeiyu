/**
 * 把「现在能不能跑」贴到定时任务/事件行上。
 *
 * 只做一件事：拿 `probePreflight()` 的 results，给每一行标一个 ready 状态。
 * 没有核验过的动作返回 null —— 页面显示「没核验」而不是假装能用。
 */

/** 单条：{action} → {ready, missing[], detail} 或 null */
export function readinessOf(action, results) {
  const row = results?.[action];
  if (!row) return null;
  const missing = (row.checks ?? []).filter((check) => !check.ok).map((check) => check.detail);
  return {
    ready: Boolean(row.ready),
    missing,
    detail: (row.checks ?? []).map((check) => check.detail).join(' · '),
  };
}

/**
 * 给一组行（slot / event）批量贴状态。
 * `pick(row)` 决定去哪拿动作名，默认 `row.action`。
 */
export function annotateRows(rows, results, pick = (row) => row?.action) {
  return (rows ?? []).map((row) => ({ ...row, readiness: readinessOf(pick(row), results) }));
}

/** 一行字：给 title / 徽标用 */
export function readinessText(readiness) {
  if (!readiness) return '没核验过';
  return readiness.ready ? '现在能跑' : `还不行：${readiness.missing[0] ?? '条件未满足'}`;
}
