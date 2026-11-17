import { createCognitionPlan, policyCheck } from '../brain/cognition/kernel.mjs';
import { recordAgentEvent } from './agent-events.mjs';
import { updateWorkingTask, workingTask } from './working-state.mjs';
import { chooseStrategy } from './strategies.mjs';

export function planWorkingTask(db, taskId, input = {}) {
  const task = workingTask(db, taskId);
  if (!task) return null;
  const plan = createCognitionPlan(input);
  const policy = policyCheck(plan, { ownerApproved: input.ownerApproved === true });
  if (!policy.allowed) return { plan, policy };
  const updated = updateWorkingTask(db, taskId, { status: 'running', currentStep: plan.steps[0]?.action ?? null, nextAction: plan.steps[0]?.action ?? null, selectedSkill: plan.selectedSkill?.skillId ?? null, environment: input.environment ?? {} });
  db.prepare('UPDATE working_tasks SET plan_json=? WHERE task_id=?').run(JSON.stringify(plan), taskId);
  recordAgentEvent(db, { eventType: 'plan_created', channel: input.channel ?? 'system', taskId, actor: input.actor ?? 'owner', payload: { plan_id: plan.planId, goal: plan.goal, risk: plan.risk, steps: plan.steps.length }, result: { policy: policy.reason }, dedupeKey: `plan:${taskId}:${plan.planId}` });
  return { plan, policy, workingTask: updated };
}

export function preparePlanStep(db, taskId, { index = 0, strategyIds = [], environment = {} } = {}) {
  const task = workingTask(db, taskId); if (!task?.plan_json) return null;
  const plan = JSON.parse(task.plan_json); const step = plan.steps[index]; if (!step) throw new Error('invalid_plan_step');
  const choice = chooseStrategy(db, { strategyIds, environment });
  db.prepare('UPDATE working_tasks SET selected_strategy=?,current_step=?,next_action=?,updated_ms=? WHERE task_id=?').run(choice.strategy, step.action, step.action, Date.now(), taskId);
  recordAgentEvent(db, { eventType: 'plan_created', channel: 'system', taskId, actor: 'system', payload: { plan_id: plan.planId, step: index, action: step.action, strategy: choice.strategy }, result: { reason: choice.reason } });
  return { planId: plan.planId, index, step, strategy: choice };
}
