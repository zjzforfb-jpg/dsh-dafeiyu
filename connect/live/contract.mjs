// 契约体检：一个动作「算不算能稳定跑」，要三件齐 ——
//   1) 说明书（tool-meta：人看的标题/入口/自动化等级/逻辑）
//   2) 跑之前要确认什么（preflight，仅对有副作用/需要设备的动作）
//   3) 跑完之后怎么算成功（expect-after：留给 verifyAfter() 核对的证据）
// 缺哪件就写进 gaps，页面上直接标出来，别靠记忆。
import { TOOL_META, TOOL_ONLY_META } from './tool-meta.mjs';
import { EXPECT_AFTER } from './expect-after.mjs';
import { hasPreflight, DEVICE_ACTIONS_LIST } from './preflight.mjs';

/** 需要「跑完之后核对」的动作：有外部副作用的必须机器可核（verifyAfter 已覆盖这 7 个）。 */
import { SIDE_EFFECT_ACTIONS } from './expect-after.mjs';
export { SIDE_EFFECT_ACTIONS };

export function contractOf(action) {
  const meta = TOOL_META[action] ?? TOOL_ONLY_META[action] ?? null;
  const readOnly = Boolean(TOOL_ONLY_META[action]) && !TOOL_META[action];
  const gaps = [];
  if (!meta) gaps.push({ key: 'meta', label: '缺说明书（tool-meta）' });
  else {
    if (!meta.intro || String(meta.intro).length < 8) gaps.push({ key: 'intro', label: '介绍太短' });
    if (!meta.logic || String(meta.logic).length < 12) gaps.push({ key: 'logic', label: '缺「内部怎么走」' });
    if (!readOnly && !meta.command) gaps.push({ key: 'command', label: '缺可复制的命令' });
      // 只有「会动手机 / 会对外发东西」的动作才必须有前置核验；本地动作（成长学院等）不需要
    const needsPreflight = SIDE_EFFECT_ACTIONS.includes(action) || DEVICE_ACTIONS_LIST.includes(action);
    if (!readOnly && needsPreflight && !meta.preflight && !hasPreflight(action)) {
      gaps.push({ key: 'preflight', label: '缺「跑之前要确认」' });
    }
  }
  if (!readOnly && !EXPECT_AFTER[action]) gaps.push({ key: 'expect', label: '缺「跑完怎么算成功」' });
  return { action, readOnly, hasMeta: Boolean(meta), hasExpect: Boolean(EXPECT_AFTER[action]), gaps, ok: gaps.length === 0 };
}

export function contractSummary(actions = Object.keys(TOOL_META)) {
  const rows = actions.map((action) => contractOf(action));
  return {
    total: rows.length,
    complete: rows.filter((row) => row.ok).length,
    incomplete: rows.filter((row) => !row.ok).map((row) => ({ action: row.action, gaps: row.gaps })),
  };
}
