/**
 * 把「判定理由」归类，回答一个问题：这一周到底哪类问题最多。
 *
 * 输入是 `task_checkpoints.reason`（例如 `nothing_to_do(5):no_content×3`、`blocked:这一小时已发 5 条`、
 * `count=0<1`、`Command failed: ...`），输出一个稳定的类别。**只归类已知的**，剩下的记 unknown，
 * 不猜、不合并成「其它问题很严重」这种糊话。
 */

const CATEGORIES = [
  { id: 'nothing_to_do', label: '确实没活干', match: /^nothing_to_do/iu },
  // 只读工具被当成动作跑（走错通道），不是产品故障
  { id: 'unknown_action', label: '走错通道（只读工具当动作跑）', match: /unknown_action/iu },
  { id: 'blocked', label: '被自己的闸门挡住', match: /^blocked:/iu },
  { id: 'missing_count', label: '动作没带回需要的字段', match: /^missing_count$/iu },
  { id: 'count_short', label: '做了但数量不够', match: /^count=\d+<\d+/iu },
  { id: 'no_result_data', label: '动作没返回结构化数据', match: /no_result_data/iu },
  { id: 'device', label: '手机没连上', match: /(adb 看到 0 台|no_device|device offline|no devices|手机没连上)/iu },
  { id: 'ui_missing', label: '界面没开到位', match: /(detail_not_opened|comment_panel_not_open|comment_bar_missing|comment_send_missing|ui_missing|interactions_unconfirmed)/iu },
  { id: 'timeout', label: '超时', match: /(timed? ?out|etimedout)/iu },
  { id: 'network', label: '网络问题', match: /(econn|socket hang up|network)/iu },
  { id: 'auth', label: '权限或登录失效', match: /(unauthorized|auth|登录|permission denial)/iu },
  { id: 'command_failed', label: '脚本报错', match: /command[ _]failed/iu },
  { id: 'awaiting_external', label: '等外部事件', match: /awaiting_external_event/iu },
];

export function reasonBucket(reason) {
  const text = String(reason ?? '').trim();
  // 早期快照没写 reason（列是后加的），这不是「原因不明」，是「当时没记」
  if (!text) return { id: 'no_reason', label: '早期记录没写原因' };
  if (text === 'ok') return null;
  const hit = CATEGORIES.find((item) => item.match.test(text));
  return hit ? { id: hit.id, label: hit.label } : { id: 'unknown', label: '原因不明' };
}

/**
 * 一周的失败归类。
 * @param {Array<{operation?:string, verdict?:string, reason?:string}>} rows
 * @returns {{total:number, buckets:Array<{id:string,label:string,count:number,ops:Record<string,number>}>}}
 */
export function summarizeFailures(rows) {
  const buckets = new Map();
  let total = 0;
  for (const row of rows ?? []) {
    if (!/^(failed|mismatched|unconfirmed)$/u.test(String(row?.verdict ?? ''))) continue;
    // unconfirmed 里「确实没活干」「被闸门挡」「等外部事件」都不算故障，单独看，但别混进失败总数
    const bucket = reasonBucket(row.reason);
    if (!bucket) continue;
    const entry = buckets.get(bucket.id) ?? { id: bucket.id, label: bucket.label, count: 0, ops: {} };
    entry.count += 1;
    const op = String(row.operation ?? '未记录');
    entry.ops[op] = (entry.ops[op] ?? 0) + 1;
    buckets.set(bucket.id, entry);
    // 这三种是「本来就不该算失败」的：没活干、等外部事件、走错通道
    if (!['nothing_to_do', 'awaiting_external', 'unknown_action'].includes(bucket.id)) total += 1;
  }
  return {
    total,
    buckets: [...buckets.values()].sort((a, b) => b.count - a.count),
  };
}
