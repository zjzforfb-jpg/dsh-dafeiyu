// 「下一步该干什么」：把当前状态翻译成一串有优先级的事情。
//
// 纯函数，浏览器与 Node 共用。顺序按「卡住的程度」排：
//   1) 失败（真的坏了）→ 2) 未确认但理由可疑 → 3) 没跑过（要放行）
//   → 4) 已下线（留档，不用动）
const REASON_OK = new Set(['ok', 'ok_text', 'nothing_to_do']);

/** 一条「未确认」是不是正常现象（没活干 / 等外部事件 / 被自己闸门挡住）。 */
export function isExpectedReason(reason = '') {
  if (!reason) return true;
  if (REASON_OK.has(reason)) return true;
  return /^(nothing_to_do|awaiting_external_event|blocked:)/u.test(reason);
}

/**
 * @param {{coverage?:object, items?:Array, retired?:Array, failures?:object}} input
 * @returns {Array<{priority:number, kind:string, title:string, detail:string, actions:Array}>}
 */
export function nextSteps({ coverage = {}, items = [], retired = [], failures = {} } = {}) {
  const steps = [];
  const live = items.filter((item) => !item.readOnly);
  const failed = live.filter((item) => ['failed', 'mismatched'].includes(item.lastVerdict));
  const doubtful = live.filter((item) => item.lastVerdict === 'unconfirmed' && !isExpectedReason(item.lastVerdictReason));
  const untested = live.filter((item) => !item.lastVerdict);

  if (failed.length) {
    steps.push({
      priority: 1,
      kind: 'fail',
      title: `先修 ${failed.length} 个失败的动作`,
      detail: failed.map((item) => `${item.action}（${item.lastVerdictReason || '没写原因'}）`).join('；'),
      actions: failed.map((item) => ({ label: `看 ${item.action}`, href: `?tab=tools&tool=${encodeURIComponent(item.action)}` })),
    });
  }

  if (doubtful.length) {
    steps.push({
      priority: 2,
      kind: 'unconfirmed',
      title: `有 ${doubtful.length} 个「未确认」的理由不太正常`,
      detail: doubtful.map((item) => `${item.action}：${item.lastVerdictReason || '没写原因'}`).join('；'),
      actions: doubtful.map((item) => ({ label: `看 ${item.action}`, href: `?tab=tools&tool=${encodeURIComponent(item.action)}` })),
    });
  }

  if (untested.length) {
    steps.push({
      priority: 3,
      kind: 'untested',
      title: `还有 ${untested.length} 个动作没跑过（要主人放行）`,
      detail: untested.map((item) => `${item.action}（${item.levelLabel ?? ''}）`).join('、'),
      actions: [
        { label: '看第一次真跑操作单', href: '/docs/FIRST-RUN.md', external: true },
        ...untested.slice(0, 3).map((item) => ({ label: `看 ${item.action}`, href: `?tab=tools&tool=${encodeURIComponent(item.action)}` })),
      ],
    });
  }

  // ops 是「动作名 → 次数」的对象（不是数组），这里统一成条目列表再排
  const opsOf = (bucket) => Object.entries(bucket?.ops ?? {})
    .map(([operation, count]) => ({ operation, count: Number(count) }))
    .sort((a, b) => b.count - a.count);
  const keyOf = (bucket) => bucket?.id ?? bucket?.key ?? '';
  const top = (failures?.buckets ?? [])
    .filter((bucket) => !['nothing_to_do', 'no_reason', 'blocked', 'unknown_action'].includes(keyOf(bucket)))
    .sort((a, b) => Number(b.count ?? 0) - Number(a.count ?? 0))[0];
  if (top && Number(top.count ?? 0) > 0) {
    steps.push({
      priority: 4,
      kind: 'pattern',
      title: `本周最常出问题的是「${top.label}」（${top.count} 次）`,
      detail: opsOf(top).slice(0, 4).map((op) => `${op.operation} ×${op.count}`).join('、') || '见工具清单',
      actions: [],
    });
  }

  if (retired.length) {
    steps.push({
      priority: 5,
      kind: 'retired',
      title: `已下线 ${retired.length} 个（留档，不用动）`,
      detail: retired.map((entry) => `${entry.label ?? entry.action}：${entry.reason}`).join('；'),
      actions: [],
    });
  }

  if (!steps.length) {
    steps.push({
      priority: 9,
      kind: 'done',
      title: '当前没有待办：所有在用的动作都有明确的判定',
      detail: `已确认 ${coverage.confirmed ?? 0}/${coverage.total ?? 0}`,
      actions: [],
    });
  }
  return steps.sort((a, b) => a.priority - b.priority);
}
