// P1-B · 单一 Capability Manifest + 单一状态词表（R-10 收口）。
// 以前能力状态三套词表：core-contract CAPABILITY_MATRIX（stable/real_verified/prototype/not_implemented/disabled）、
// memory/capabilities.mjs（stable/beta）、qq/tools.mjs runTool（ok/failed/…）。加能力每加一次就多一套。
// 现在所有状态词表只在这里定义一处，别处 import，别再自己 new Set([...])。
//
// 两条正交的轴（别再混）：
//   CAPABILITY_STATUSES —— 能力「成熟度」：stable/beta/prototype/planned/disabled/not_implemented
//   RUN_STATUSES        —— 工具「执行结果」：ok/failed/verified/accepted/invoked/skipped
// 老词 real_verified 通过 STATUS_ALIASES 归一到 stable。

/** 能力成熟度词表（唯一真源）。 */
export const CAPABILITY_STATUSES = Object.freeze([
  'stable', 'beta', 'prototype', 'planned', 'disabled', 'not_implemented',
]);

/** 工具执行结果词表（唯一真源，runTool 用）。含 failedResults 关心的 blocked/unconfirmed。 */
export const RUN_STATUSES = Object.freeze([
  'ok', 'failed', 'verified', 'accepted', 'invoked', 'skipped', 'blocked', 'unconfirmed', 'unknown',
]);

/** 老词 → 规范词（能力成熟度）。 */
export const STATUS_ALIASES = Object.freeze({ real_verified: 'stable' });

export function isCapabilityStatus(status) {
  return CAPABILITY_STATUSES.includes(String(status ?? ''));
}

export function isRunStatus(status) {
  return RUN_STATUSES.includes(String(status ?? ''));
}

/** 归一到规范能力状态；不认识的兜底 prototype（原型最保守，不会把没验的东西说成 stable）。 */
export function normalizeStatus(status) {
  const value = String(status ?? '');
  if (CAPABILITY_STATUSES.includes(value)) return value;
  if (Object.prototype.hasOwnProperty.call(STATUS_ALIASES, value)) return STATUS_ALIASES[value];
  return 'prototype';
}

/** 校验一组 {key: status} 全在统一词表内，返回非法项（空数组=合规）。 */
export function invalidStatuses(matrix) {
  const bad = [];
  for (const [key, status] of Object.entries(matrix ?? {})) {
    if (!isCapabilityStatus(status)) bad.push(`${key}=${status}`);
  }
  return bad;
}

/**
 * 单一能力清单骨架（B-2 逐步补齐字段）。每项：
 * id/title/one/status/aliases/tags/files/detail + 输入/输出/版本/权限/依赖/验证要求。
 * 目前先提供状态词表与校验；清单条目仍在 connect/memory/capabilities.mjs 渐进式披露，
 * 但所有 status 必须过 normalizeStatus（= CAPABILITY_STATUSES）。
 */
export function manifestStatus(entry) {
  return normalizeStatus(entry?.status);
}
