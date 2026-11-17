// 「写草稿 → 人工二审 → 发布」这条两段式流程的可视化：
// 只做展示，不改变任何实际闸门——每一步的判定仍由 scheduler / actions 决定。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from '../core/paths.mjs';

function newestDraft(root) {
  const dir = join(projectRoot(root), 'runtime', 'douyin', 'drafts');
  let names = [];
  try { names = readdirSync(dir).filter((name) => name.endsWith('.json')); } catch { return null; }
  let best = null;
  for (const name of names) {
    try {
      const data = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      const at = Number(data.createdAt ?? data.created_at ?? 0) || 0;
      if (!best || at > best.at) best = { at, title: data.title ?? name, status: data.status ?? 'draft', file: name };
    } catch { /* 坏文件跳过 */ }
  }
  return best;
}

function pendingPost(root) {
  const file = join(projectRoot(root), 'runtime', 'douyin', 'pending.json');
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return data && data.status === 'pending' ? data : null;
  } catch { return null; }
}

/** 返回三步状态：draft（写草稿）/ review（人工二审）/ publish（发作品）。 */
export function publishFlowState(db, root = process.cwd(), now = Date.now()) {
  const draft = newestDraft(root);
  const pending = pendingPost(root);
  let awaiting = null;
  try {
    awaiting = db.prepare("SELECT id, status, updated_ms FROM external_tasks WHERE status='awaiting_confirmation' ORDER BY updated_ms DESC LIMIT 1").get() ?? null;
  } catch { /* 老库 */ }
  let published = null;
  try {
    published = db.prepare("SELECT verdict, reason, created_ms FROM task_checkpoints WHERE operation='douyin.publish' ORDER BY id DESC LIMIT 1").get() ?? null;
  } catch { /* 没表 */ }

  const steps = [
    {
      key: 'draft',
      label: '写草稿',
      state: draft ? 'done' : (pending ? 'done' : 'todo'),
      detail: draft ? `${draft.title}（${draft.file}）` : '还没有草稿文件',
      at: draft?.at ?? null,
    },
    {
      key: 'review',
      label: '人工二审',
      state: awaiting ? 'now' : (published?.verdict === 'confirmed' ? 'done' : 'todo'),
      detail: awaiting ? `有 1 条在等主人回「同意」` : (published?.verdict === 'confirmed' ? '已经确认过' : '没有等你确认的发布'),
      at: awaiting?.updated_ms ?? null,
      taskId: awaiting?.id ?? null,
    },
    {
      key: 'publish',
      label: '发作品',
      state: published?.verdict === 'confirmed' ? 'done' : (published ? 'fail' : 'todo'),
      detail: published ? `最近一次：${published.verdict}${published.reason && published.reason !== 'ok' ? `（${published.reason}）` : ''}` : '还没在判定里出现过发布结果',
      at: published?.created_ms ?? null,
    },
  ];
  const next = steps.find((step) => step.state !== 'done') ?? null;
  return { steps, next: next?.key ?? null, now };
}
