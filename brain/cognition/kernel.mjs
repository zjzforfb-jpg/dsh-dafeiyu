import { randomUUID } from 'node:crypto';

const RISK = new Set(['low', 'medium', 'high']);
export function createCognitionPlan({ goal, environment = {}, memories = [], skills = [], actor = 'owner', risk = 'low', steps = [] } = {}) {
  if (!String(goal ?? '').trim()) throw new Error('goal_required');
  if (!RISK.has(risk)) throw new Error('invalid_risk');
  if (risk === 'high' && actor !== 'owner') return { planId: `plan_${randomUUID()}`, status: 'blocked', reason: 'owner_approval_required', steps: [] };
  const selectedSkill = skills.find((skill) => skill.status === 'enabled' && (!environment.app || skill.environment?.app === environment.app)) ?? skills.find((skill) => skill.status === 'enabled') ?? null;
  return { planId: `plan_${randomUUID()}`, status: 'proposed', goal: String(goal).slice(0, 500), actor, risk, environment, memoryIds: memories.map((m) => m.id).filter(Boolean), selectedSkill: selectedSkill ? { skillId: selectedSkill.skillId ?? selectedSkill.skill_id, version: selectedSkill.version ?? selectedSkill.current_version } : null, steps: steps.slice(0, 12).map((step, index) => ({ index, status: 'pending', action: String(step.action ?? step).slice(0, 240), precondition: step.precondition ?? null, postcondition: step.postcondition ?? null })) };
}
export function advancePlan(plan, index, { status = 'running', observationId = null, result = null } = {}) {
  if (!plan || !Array.isArray(plan.steps) || !plan.steps[index]) throw new Error('invalid_plan_step');
  const next = structuredClone(plan); next.steps[index] = { ...next.steps[index], status, observationId, result };
  next.status = next.steps.some((s) => s.status === 'failed' || s.status === 'unknown') ? 'needs_reobserve' : next.steps.every((s) => s.status === 'succeeded') ? 'succeeded' : 'running';
  return next;
}
export function policyCheck(plan, { ownerApproved = false } = {}) {
  if (!plan || plan.status === 'blocked') return { allowed: false, reason: plan?.reason ?? 'invalid_plan' };
  if (plan.risk === 'high' && !ownerApproved) return { allowed: false, reason: 'owner_approval_required' };
  if (plan.steps.some((step) => !step.action)) return { allowed: false, reason: 'step_action_required' };
  return { allowed: true, reason: 'policy_passed' };
}
