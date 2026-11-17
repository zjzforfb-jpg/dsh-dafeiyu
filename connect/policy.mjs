import { AUTO_ACTIONS } from './douyin/dayplan.mjs';

const RISKS = Object.freeze({
  'conversation.reply': 'R0',
  'memory.read.owner': 'R1',
  'memory.write.owner': 'R2',
  'task.propose': 'R2',
  'task.approve': 'R3',
  'external.execute': 'R3',
});

/** Evaluate a trusted adapter event. Caller-supplied message text never grants authority. */
export function evaluatePolicy(event, action, { approved = false, automatic = false, operation = null } = {}) {
  const risk = action === 'external.execute' && automatic && AUTO_ACTIONS.has(operation) ? 'R2' : RISKS[action];
  if (!risk) throw new Error(`unknown_policy_action:${action}`);
  const ownerPrivate = event?.sender?.role === 'owner'
    && event?.conversation?.type === 'direct'
    && event?.trust?.instruction_trust === 'verified_user_input';
  let allowed = false;
  if (action === 'conversation.reply') allowed = true;
  if (action === 'memory.read.owner' || action === 'memory.write.owner' || action === 'task.approve') {
    allowed = ownerPrivate;
  }
  if (action === 'task.propose') allowed = ownerPrivate || event?.conversation?.type === 'group';
  if (action === 'external.execute') allowed = (ownerPrivate && approved === true)
    || (automatic === true && AUTO_ACTIONS.has(operation)
      && event?.sender?.role === 'system' && event?.trust?.instruction_trust === 'trusted_system');
  return Object.freeze({
    allowed: Boolean(allowed),
    risk,
    reason: allowed ? 'allowed' : action === 'external.execute' && ownerPrivate ? 'approval_required' : 'source_not_authorized',
  });
}

