// 「预演」：不执行动作，只把「它会跑什么命令、影响什么、跑完核对什么」摆出来。
//
// 为什么不真的 dry-run：抖音/通话这几条脚本即使带 --dry-run 也会打开手机 UI
// （要读屏才能拟稿），那不是预演，是「半执行」。既然没法保证零副作用，
// 就老实做「命令预演」，并在页面上说清「这一条没有真正的 dry-run」。
import { probePreflight, systemProbes } from './preflight.mjs';

/** 有真正 dry-run（不碰设备）的动作；目前为空——脚本都会动手机。 */
export const TRUE_DRY_RUN = new Set();

export function buildPreview(action, item = null, { root = process.cwd(), probes = null } = {}) {
  if (!item) return null;
  const checks = Array.isArray(item.expect) ? item.expect : [];
  const preflight = Array.isArray(item.preflight) ? item.preflight : [];
  let checksNow = null;
  if (probes) {
    // probePreflight 是 async：这里同步拿到的会是 Promise，所以直接算同步那部分
    try {
      const table = probes;
      const needs = preflight.map((label) => label);
      checksNow = { pending: true, needs };
      void table; void needs;
    } catch { /* ignore */ }
  }
  return {
    action,
    title: item.title ?? action,
    supported: TRUE_DRY_RUN.has(action),
    command: item.command ?? '',
    what: item.intro ?? '',
    impact: item.impact ?? '',
    expect: checks,
    preflight,
    preflightNow: checksNow,
    why: TRUE_DRY_RUN.has(action)
      ? ''
      : '这一条没有真正的 dry-run：脚本要打开手机界面才能拟稿，带 --dry-run 也会动 UI。下面是它会执行的命令、会造成的影响、以及跑完该核对什么。',
  };
}

/** 预览：带上当前前置核验结果（异步真跑一次只读探针）。 */
export async function previewWithProbes(action, item, { root = process.cwd() } = {}) {
  const base = buildPreview(action, item, { root });
  try {
    const result = await probePreflight({ root, actions: [action] });
    base.preflightNow = result?.results?.[action] ?? null;
  } catch { base.preflightNow = null; }
  return base;
}
