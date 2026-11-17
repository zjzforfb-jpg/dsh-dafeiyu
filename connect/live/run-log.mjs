// 页面「真跑一次」的留档：每次跑完落一个 JSON 到 runtime/connect/live-runs/，
// 关掉页面再打开还能回看「什么时候跑过、结果是什么」。
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from '../core/paths.mjs';

export function runsDirOf(root = process.cwd()) {
  return join(projectRoot(root), 'runtime', 'connect', 'live-runs');
}

function fileNameOf(at, action) {
  return `${new Date(at).toISOString().replace(/[:.]/gu, '-')}-${String(action).replace(/[^a-z0-9._-]/giu, '_')}.json`;
}

/** 记一条；text 只留前 1000 字（回执已截断，这里不重复存全量）。 */
export function recordRun(root, run) {
  const at = Number(run.at ?? Date.now());
  const dir = runsDirOf(root);
  mkdirSync(dir, { recursive: true });
  const entry = {
    action: String(run.action ?? ''),
    at,
    elapsedMs: Number(run.elapsedMs ?? 0),
    verdict: String(run.verdict ?? 'unknown'),
    reason: String(run.reason ?? ''),
    text: String(run.text ?? '').slice(0, 1000),
    after: run.after ?? null,
    via: 'live-ui',
  };
  writeFileSync(join(dir, fileNameOf(at, entry.action)), `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
  return entry;
}

/** 某动作最近的几条（默认 3 条，新的在前）。 */
export function recentRuns(root, action, limit = 3) {
  const dir = runsDirOf(root);
  let names = [];
  try { names = readdirSync(dir).filter((name) => name.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const name of names.sort().reverse()) {
    try {
      const entry = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (entry.action !== action) continue;
      out.push(entry);
      if (out.length >= limit) break;
    } catch { /* 坏文件跳过 */ }
  }
  return out;
}
