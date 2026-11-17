#!/usr/bin/env node
// 放行前的自检清单：只读，不跑任何副作用动作。
//
// 用途：主人在放行前（或放行途中）敲一次，确认「顺序对不对、前置够不够、
// 操作单和页面说的是不是同一件事」，不用一条条翻页面。

import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { projectRoot, runtimeDir } from '../connect/core/paths.mjs';
import { RELEASE_PLAN, nextReleaseStep } from '../connect/live/release-plan.mjs';
import { loadRunAllowlist, isAllowed } from '../connect/live/run-policy.mjs';
import { systemProbes, probePreflight } from '../connect/live/preflight.mjs';
import { SIDE_EFFECT_ACTIONS } from '../connect/live/expect-after.mjs';

const base = projectRoot(process.cwd());
const root = runtimeDir(base);
const dbPath = resolve(root, 'connect', 'connect.sqlite');

const allow = loadRunAllowlist(root);
const probes = systemProbes({ root });
const { results } = await probePreflight({ root, actions: SIDE_EFFECT_ACTIONS, probes });

const db = existsSync(dbPath) ? new DatabaseSync(dbPath, { readOnly: true }) : null;
const lastVerdict = (action) => {
  if (!db) return null;
  try {
    const row = db.prepare("SELECT verdict FROM task_checkpoints WHERE operation = ? AND task_id NOT LIKE 'ui-run-%' ORDER BY id DESC LIMIT 1").get(action);
    return row?.verdict ?? null;
  } catch { return null; }
};

const step = nextReleaseStep(SIDE_EFFECT_ACTIONS.map((action) => ({ action, lastVerdict: lastVerdict(action) })));
const lines = [];
const mark = (ok) => (ok ? '✅' : '⚠️');

lines.push(`放行自检 · ${new Date().toLocaleString('zh-CN', { hour12: false })}`);
lines.push('');
lines.push(`顺序：${RELEASE_PLAN.map((item) => item.action).join(' → ')}`);
lines.push(step.next
  ? `下一步该跑：**${step.next.action}**（还差 ${step.remaining.length}/${step.total} 步）`
  : `7 步全部确认过了`);
lines.push('');
lines.push(`放行清单：永久 ${allow.allowed.length} 个${allow.grants.length ? ` · 临时 ${allow.grants.length} 个` : ''}${allow.note ? '' : ' ⚠️ 没有备注'}`);
if (allow.note) lines.push(`  备注：${allow.note}`);
lines.push('');
lines.push('| 动作 | 已放行 | 前置 | 上次判定 |');
lines.push('|---|---|---|---|');
let blocked = 0;
for (const action of SIDE_EFFECT_ACTIONS) {
  const allowed = isAllowed(action, allow);
  const ready = results[action]?.ready === true;
  if (!allowed || !ready) blocked += 1;
  const verdict = lastVerdict(action) ?? '没跑过';
  lines.push(`| \`${action}\` | ${mark(allowed)} | ${mark(ready)}${ready ? '' : `（${(results[action]?.checks ?? []).find((check) => !check.ok)?.detail ?? '缺条件'}）`} | ${verdict} |`);
}
lines.push('');
lines.push(blocked === 0
  ? '全部就绪：可以按上面的顺序开始跑。每跑完一个，回到 /live 看回执与「跑完之后核对」。'
  : `还有 ${blocked} 项不满足（未放行或前置没到），先把这些补齐再跑。`);

console.log(lines.join('\n'));
if (db) db.close();
process.exitCode = 0;
