// M2 / D2：把一个失败（或半成功）的任务从断点接着跑完。
//
// 为什么需要它：写操作一旦失败，之前成功的那些步骤已经产生了真实副作用
// （比如图已经发出去了、评论已经回了三条），整单重跑等于重复操作。
// 所以这里不「重试」，而是「续跑」：先看快照表里哪些步已经成了，跳过它们。
import { runAction } from '../actions.mjs';
import { checkpointSummary, doneSteps, initCheckpoints } from './checkpoints.mjs';
import { executeOperations } from './publish.mjs';
import { completeTask, task, taskPayload } from '../tasks.mjs';
import { recordAgentEvent } from '../agent-events.mjs';

/** 哪些动作走哪条渠道（和 service 里的 opChannel 保持一致）。 */
function channelOf(operation) {
  const head = String(operation ?? '').split('.')[0];
  return ['qq', 'wechat', 'ilink'].includes(head) ? head : 'douyin';
}

/**
 * 续跑一个任务。
 * @param {object} db   connect.sqlite
 * @param {string} taskId
 * @param {object} options execute/root/now，测试可注入
 * @returns {Promise<{ok,status,resumed,skipped,ran,summary,receipts}>}
 */
export async function retryTask(db, taskId, { execute = runAction, root = process.cwd(), now = Date.now() } = {}) {
  initCheckpoints(db);
  const row = task(db, taskId);
  if (!row) return { ok: false, status: 'missing', error: 'task_not_found' };

  const payload = taskPayload(row) ?? {};
  const operations = Array.isArray(payload.operations) ? payload.operations : [];
  if (!operations.length) return { ok: false, status: row.status, error: 'no_operations' };
  if (row.status === 'awaiting_confirmation') return { ok: false, status: row.status, error: 'needs_approval' };

  const before = doneSteps(db, taskId);
  const skipped = [];
  const operationsToRun = [];
  for (const [index, entry] of operations.entries()) {
    const name = typeof entry === 'string' ? entry : String(entry?.operation ?? entry?.action ?? '');
    const key = typeof entry === 'object' && entry?.step_key ? String(entry.step_key) : `#${index}:${name}`;
    if (before.has(key)) skipped.push(name);
    else operationsToRun.push(entry);
  }
  if (!operationsToRun.length) {
    return { ok: true, status: 'succeeded', resumed: true, skipped, ran: [], summary: checkpointSummary(db, taskId), receipts: [] };
  }

  db.prepare("UPDATE external_tasks SET status='running', updated_ms=? WHERE id=?").run(now, taskId);
  recordAgentEvent(db, {
    eventType: 'task_state_changed', channel: 'system', taskId, actor: 'system',
    payload: { status: 'running', reason: 'retry_from_checkpoint', skipped: skipped.length, remaining: operationsToRun.length },
    dedupeKey: `task:${taskId}:retry:${now}`,
  });

  const ran = [];
  const outcome = await executeOperations({
    operations: operationsToRun,
    execute: async (name, opts) => {
      ran.push(name);
      return execute(name, opts);
    },
    db,
    taskId,
    channel: channelOf(typeof operationsToRun[0] === 'string' ? operationsToRun[0] : operationsToRun[0]?.operation),
    adapterFor: (name) => channelOf(name),
    stopOnFailure: false,
    args: payload.args ?? {},
  });

  completeTask(db, taskId, { ok: outcome.ok, result: outcome.receipts }, now);
  return {
    ok: outcome.ok,
    status: outcome.ok ? 'succeeded' : 'failed',
    resumed: skipped.length > 0,
    skipped,
    ran,
    summary: checkpointSummary(db, taskId),
    receipts: outcome.receipts,
    details: outcome.details,
  };
}
