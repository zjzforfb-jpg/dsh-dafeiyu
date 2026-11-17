/**
 * 多任务计划：把爸爸一次交代的几件事排成队列，依次执行；
 * 失败先私聊七海，5 分钟没回音就在群里说一声。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { runtimeDir } from './core/paths.mjs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runAction, ACTIONS } from './actions.mjs';
import { initApprovalLedger, sendApprovalRequest } from './approvals.mjs';
import { executePlanAction } from './core/execute.mjs';
import { loadTargets } from './targets.mjs';

/** 兼容旧调用：目标 ID 现在从 runtime/connect/targets.json 读取。 */
export const QQ = { get haihai() { return loadTargets().qq.dad; }, get group() { return loadTargets().qq.group; } };

function dir(root) { return join(runtimeDir(root), 'plans'); }
function file(root) { return join(dir(root), 'queue.json'); }

export function loadQueue(root) {
  try { return JSON.parse(readFileSync(file(root), 'utf8')); } catch { return { plans: [] }; }
}
export function saveQueue(root, data) {
  mkdirSync(dir(root), { recursive: true, mode: 0o700 });
  writeFileSync(file(root), JSON.stringify(data, null, 2), { mode: 0o600 });
}
export function addPlan(root, { steps, origin = 'qq', title = '', approvalRequestId = null }) {
  const data = loadQueue(root);
  const plan = { id: `plan_${randomUUID()}`, title, origin, approvalRequestId, createdAt: Date.now(), status: 'pending', steps: steps.map((step) => ({ name: step.name, args: step.args ?? {}, status: 'pending', result: '' })) };
  if (approvalRequestId) {
    const db = new DatabaseSync(join(runtimeDir(root), 'connect', 'connect.sqlite'));
    try {
      initApprovalLedger(db);
      const approval = db.prepare('SELECT decision,task_id,operations_json FROM approvals WHERE id=?').get(approvalRequestId);
      let operations = [];
      try { operations = JSON.parse(approval?.operations_json ?? '[]'); } catch {}
      if (approval?.decision !== 'approved' || approval.task_id || JSON.stringify(operations) !== JSON.stringify(plan.steps.map((step) => step.name))) throw new Error('plan_approval_invalid');
      if (db.prepare('UPDATE approvals SET task_id=? WHERE id=? AND task_id IS NULL').run(plan.id, approvalRequestId).changes !== 1) throw new Error('plan_approval_already_bound');
    } finally { db.close(); }
  }
  data.plans.push(plan);
  saveQueue(root, data);
  return plan;
}

export async function sendNotice({ root, target, text }) {
  try { await sendApprovalRequest({ root, target, title: '进展通知', caption: text, imageFile: null, approvalRequired: false }); return true; } catch { return false; }
}

export function anyReplySince(root, sinceMs, convId) {
  const dbFile = join(runtimeDir(root), 'connect', 'connect.sqlite');
  if (!existsSync(dbFile)) return false;
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM qq_messages WHERE conv_kind='c2c' AND conv_id=? AND created_ms>=? AND text IS NOT NULL AND (author IS NULL OR author=conv_id)").get(convId, sinceMs);
    return Number(row?.n ?? 0) > 0;
  } catch { return false; } finally { db.close(); }
}

/** 依次执行一个计划的步骤；失败时私聊七海，5 分钟没回复再群里说。 */
export async function runPlan(root, plan, { log = () => {}, execute = runAction } = {}) {
  const data = loadQueue(root);
  const stored = data.plans.find((item) => item.id === plan.id);
  if (!stored || stored.status !== 'pending') return { ok: false, error: 'plan_not_pending' };
  const db = new DatabaseSync(join(runtimeDir(root), 'connect', 'connect.sqlite'));
  try {
  initApprovalLedger(db);
  stored.status = 'running';
  saveQueue(root, data);
  for (const step of stored.steps) {
    const label = ACTIONS[step.name]?.label ?? step.name;
    log(`[plan] ${label}`);
    const result = await executePlanAction({ db, planId: plan.id, approvalRequestId: stored.approvalRequestId, ownerId: loadTargets(root).qq.dad, operation: step.name, root, args: step.args, execute });
    step.status = result.ok ? 'done' : 'failed';
    step.result = result.ok ? result.text : result.error;
    saveQueue(root, data);
    if (!result.ok) {
      plan.status = 'failed';
      stored.status = 'failed';
      saveQueue(root, data);
      if (result.error === 'external_action_unauthorized') return { ok: false, failedStep: step.name, error: result.error };
      const noticeAt = Date.now();
      const msg = `我这边把「${label}」做失败了（${result.error}）。要不要我重试，还是先做别的？`;
      await sendNotice({ root, target: '七海', text: msg });
      setTimeout(async () => {
        if (!anyReplySince(root, noticeAt, QQ.haihai)) {
          await sendNotice({ root, target: '大肥鱼小可爱', text: `跟大家说一声：${label} 没做成，我先记下来，等爸爸回来再处理。` });
        }
      }, 5 * 60_000).unref?.();
      return { ok: false, failedStep: step.name };
    }
  }
  plan.status = 'done';
  stored.status = 'done';
  saveQueue(root, data);
  return { ok: true, steps: stored.steps.length };
  } finally { db.close(); }
}
