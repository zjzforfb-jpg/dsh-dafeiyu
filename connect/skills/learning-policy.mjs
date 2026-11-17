// 学习闭环的风险分层策略（P1-C / C-3，堵 R-06 的最后一环）
//
// 原来的阈值写死在 learning.mjs / reflection.mjs 里（都是 2），而且提案永远等主人点头。
// 这里把「攒几次」和「要不要主人点头」都按技能背后的动作风险等级分层：
//
//   R0 —— 只读动作（看互动、刷抖音、查热点）。
//         攒够 2 次失败就可以自动升版：它改的只是自己怎么读，不碰任何外部世界。
//   R2 —— 自动可执行的动作（写草稿、回评论、写周记）。
//         攒够 2 次失败就自动升版：跟 D5 的「R2 自动」保持一致，主人在别处已经
//         允许这类动作自己跑了，技能自己学到的回退策略不该再卡一次人工。
//   R3 —— 外部动作（发布作品这类不可撤回的）。
//         攒够 3 次才够格提，而且必须主人点头：升完版就是新的自动执行路径。
//   未知 —— 查不到风险的技能一律按最保守处理（要审核）。
//
// 风险从 connect/core/capability-map.mjs 推，不新造词表：
// 技能 → 它服务的动作（只算真正实现了的动作）→ 动作的 risk，取最高的那一档。

import { CAPABILITY_MAP } from '../core/capability-map.mjs';

export const RISK_TIERS = Object.freeze({
  R0: Object.freeze({ threshold: 2, autoApprove: true }),
  R2: Object.freeze({ threshold: 2, autoApprove: true }),
  R3: Object.freeze({ threshold: 3, autoApprove: false }),
});

export const UNKNOWN_POLICY = Object.freeze({ risk: 'unknown', threshold: 2, autoApprove: false });

const RISK_ORDER = Object.freeze({ R0: 0, R1: 1, R2: 2, R3: 3, R4: 4 });

const SKILL_RISK = (() => {
  const map = new Map();
  for (const row of CAPABILITY_MAP) {
    if (!row?.skill || !row?.risk) continue;
    if (row.implemented === false) continue; // 没实现的动作不算它的风险
    const known = map.get(row.skill);
    if (!known || (RISK_ORDER[row.risk] ?? 0) > (RISK_ORDER[known] ?? 0)) map.set(row.skill, row.risk);
  }
  return map;
})();

export function riskForSkill(skillId) {
  if (!skillId) return null;
  return SKILL_RISK.get(skillId) ?? null;
}

export function policyForSkill(skillId) {
  const risk = riskForSkill(skillId);
  if (!risk || !RISK_TIERS[risk]) return { ...UNKNOWN_POLICY, skillId: skillId ?? null };
  return { ...RISK_TIERS[risk], risk, skillId };
}

export function thresholdForSkill(skillId) {
  return policyForSkill(skillId).threshold;
}

export function autoApproveForSkill(skillId) {
  return policyForSkill(skillId).autoApprove;
}

export function describePolicy(policy) {
  if (!policy) return '';
  if (policy.autoApprove) return `${policy.risk} · 攒够 ${policy.threshold} 次自动升版`;
  return `${policy.risk} · 攒够 ${policy.threshold} 次，需要你点头`;
}

export function skillPolicies() {
  return Object.fromEntries([...SKILL_RISK.entries()].map(([skillId, risk]) => [skillId, policyForSkill(skillId)]));
}
