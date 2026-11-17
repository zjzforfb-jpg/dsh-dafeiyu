// 计划 P0-B-5：只读步的执行结果回灌只有一种格式。
//
// 以前有三套：qq/planner.mjs 的 factsText、qq/service.mjs 的 factsDigest、
// 以及 brain 侧直接把 facts 塞进提示词。现在统一在这里：
//   factsText()  给模型看的事实块（带工具名）
//   factsDigest() 给老板看的一句话摘要（去掉工具名，只留结论）

/** 工具失败时的固定标注，模型和老板都看得懂。 */
export const FAILED_MARK = '（失败）';

/**
 * 把只读工具的执行结果拼成给模型看的事实块。
 * @param {Array<{tool:string, ok?:boolean, status?:string, text?:string}>} results
 */
export function factsText(results) {
  if (!results?.length) return '';
  return results
    .map((r) => `【${r?.tool ?? 'tool'}】${r?.ok ? '' : FAILED_MARK}${r?.text ?? ''}`)
    .join('\n');
}

/**
 * 事实块的一句话摘要：去掉【工具名】前缀，只留结论，最多 maxLines 条。
 */
export function factsDigest(facts, maxLines = 4) {
  const lines = String(facts ?? '')
    .replace(/【[^】]*】/gu, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return '';
  const [head, ...rest] = lines;
  return [head, ...rest.slice(0, maxLines - 1)].join('；').slice(0, 280);
}

/**
 * 一次执行里有没有失败项。失败项必须覆盖模型回复，不能让模型把
 * 「被弹窗挡住」说成「没有新评论」。
 */
export function failedResults(results) {
  return (results ?? []).filter((item) => item
    && (item.ok === false || ['blocked', 'unconfirmed', 'failed'].includes(String(item.status ?? ''))));
}
