/**
 * 多任务计划：把爸爸一次交代的几件事排成队列，依次执行；
 * 失败先私聊七海，5 分钟没回音就在群里说一声。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runAction, ACTIONS } from './actions.mjs';
import { sendApprovalRequest } from './approvals.mjs';
import { loadTargets } from './targets.mjs';

/** 兼容旧调用：目标 ID 现在从 runtime/connect/targets.json 读取。 */
export const QQ = { get haihai() { return loadTargets().qq.dad; }, get group() { return loadTargets().qq.group; } };

function dir(root) { return join(root, 'runtime', 'plans'); }
function file(root) { return join(dir(root), 'queue.json'); }

export function loadQueue(root) {
  try { return JSON.parse(readFileSync(file(root), 'utf8')); } catch { return { plans: [] }; }
}
export function saveQueue(root, data) {
  mkdirSync(dir(root), { recursive: true, mode: 0o700 });
  writeFileSync(file(root), JSON.stringify(data, null, 2), { mode: 0o600 });
}
export function addPlan(root, { steps, origin = 'qq', title = '' }) {
  const data = loadQueue(root);
  const plan = { id: `plan_${Date.now()}`, title, origin, createdAt: Date.now(), status: 'pending', steps: steps.map((step) => ({ name: step.name, args: step.args ?? {}, status: 'pending', result: '' })) };
  data.plans.push(plan);
  saveQueue(root, data);
  return plan;
}

export async function sendNotice({ root, target, text }) {
  try { await sendApprovalRequest({ root, target, title: '进展通知', caption: text, imageFile: null }); return true; } catch { return false; }
}

function anyReplySince(root, sinceMs, convId) {
  const dbFile = join(root, 'runtime', 'connect', 'connect.sqlite');
  if (!existsSync(dbFile)) return false;
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM qq_messages WHERE conv_id = ? AND created_ms >= ? AND direction = ?').get(convId, sinceMs, 'in');
    return Number(row?.n ?? 0) > 0;
  } catch { return false; } finally { db.close(); }
}

/** 依次执行一个计划的步骤；失败时私聊七海，5 分钟没回复再群里说。 */
export async function runPlan(root, plan, { log = () => {} } = {}) {
  const data = loadQueue(root);
  const stored = data.plans.find((item) => item.id === plan.id);
  for (const step of plan.steps) {
    const label = ACTIONS[step.name]?.label ?? step.name;
    log(`[plan] ${label}`);
    const result = await runAction(step.name, { root, args: step.args });
    step.status = result.ok ? 'done' : 'failed';
    step.result = result.ok ? result.text : result.error;
    if (stored) Object.assign(stored, { steps: plan.steps });
    saveQueue(root, data);
    if (!result.ok) {
      plan.status = 'failed';
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
  if (stored) stored.status = 'done';
  saveQueue(root, data);
  return { ok: true, steps: plan.steps.length };
}
