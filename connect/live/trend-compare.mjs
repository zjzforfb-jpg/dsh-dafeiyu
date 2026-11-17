// 「和上周比」：把工具卡上那条 5 周趋势（左旧右新）折成一句话。
//
// 约定：trend 是 [{ weeksAgo: 4..0, ok, bad }]，weeksAgo=0 是本周、1 是上周。
// 只说「变好 / 变差 / 没变 / 这周没跑 / 上周之前没数据」，不评价对错——
// 变差也可能是「这周任务更多」，所以数字都带上。

const rateOf = (cell) => {
  const total = Number(cell?.ok ?? 0) + Number(cell?.bad ?? 0);
  return total === 0 ? null : Number(cell.ok ?? 0) / total;
};

/** @returns {{ status:'improved'|'regressed'|'flat'|'idle'|'new', now:number|null, before:number|null, nowRuns:number, beforeRuns:number }} */
export function compareWeeks(trend = []) {
  const now = trend.find((cell) => Number(cell?.weeksAgo) === 0) ?? null;
  const before = trend.find((cell) => Number(cell?.weeksAgo) === 1) ?? null;
  const nowRuns = Number(now?.ok ?? 0) + Number(now?.bad ?? 0);
  const beforeRuns = Number(before?.ok ?? 0) + Number(before?.bad ?? 0);
  const nowRate = rateOf(now);
  const beforeRate = rateOf(before);

  if (nowRuns === 0) {
    return { status: beforeRuns > 0 ? 'idle' : 'new', now: null, before: beforeRate, nowRuns, beforeRuns };
  }
  if (beforeRate === null) return { status: 'new', now: nowRate, before: null, nowRuns, beforeRuns };
  if (nowRate > beforeRate) return { status: 'improved', now: nowRate, before: beforeRate, nowRuns, beforeRuns };
  if (nowRate < beforeRate) return { status: 'regressed', now: nowRate, before: beforeRate, nowRuns, beforeRuns };
  return { status: 'flat', now: nowRate, before: beforeRate, nowRuns, beforeRuns };
}

const pct = (value) => (value === null ? '—' : `${Math.round(value * 100)}%`);

export function describeCompare(result) {
  if (!result) return '没有数据';
  if (result.status === 'new') return `本周 ${result.nowRuns} 次，上周没跑过`;
  if (result.status === 'idle') return `本周没跑（上周 ${result.beforeRuns} 次）`;
  const tail = `（本周 ${result.nowRuns} 次 / 上周 ${result.beforeRuns} 次）`;
  if (result.status === 'improved') return `成功率 ${pct(result.before)} → ${pct(result.now)}${tail}`;
  if (result.status === 'regressed') return `成功率 ${pct(result.before)} → ${pct(result.now)}${tail}`;
  return `成功率持平 ${pct(result.now)}${tail}`;
}

/** 汇总一批工具，按「值得先看」排序：变差 → 变好 → 本周没跑 → 新数据。 */
export function summarizeCompare(items = []) {
  const rows = items
    .filter((item) => !item.readOnly && Array.isArray(item.trend))
    .map((item) => ({ action: item.action, title: item.title ?? item.action, level: item.level, ...compareWeeks(item.trend) }));
  const order = { regressed: 0, improved: 1, idle: 2, new: 3, flat: 4 };
  rows.sort((a, b) => (order[a.status] - order[b.status]));
  const count = (status) => rows.filter((row) => row.status === status).length;
  return {
    rows,
    counts: {
      improved: count('improved'),
      regressed: count('regressed'),
      flat: count('flat'),
      idle: count('idle'),
      new: count('new'),
    },
  };
}
