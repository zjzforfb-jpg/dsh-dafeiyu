#!/usr/bin/env node
// 一次性回填：reason 列是后加的，之前的快照 reason 为空。
// 这些行的 output_json 里其实存了当时的 text/data —— 用同一条 evaluateOutcome() 重算一遍，
// 能推断的补上；推断不出来的保持空白，页面上标「早期记录没写原因」，绝不编。
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot, runtimeDir } from '../connect/core/paths.mjs';
import { evaluateOutcome, VERDICTS } from '../connect/core/verify.mjs';

const args = new Set(process.argv.slice(2));
const dry = args.has('--dry');
const root = projectRoot(process.cwd());
const file = join(runtimeDir(root), 'connect', 'connect.sqlite');
if (!existsSync(file)) {
  console.error(`找不到库：${file}`);
  process.exit(1);
}

const db = new DatabaseSync(file);
// reason 列是后加的：老行是 NULL，新行为空串，两种都要算
const rows = db.prepare("SELECT id, operation, verdict, reason, output_json FROM task_checkpoints WHERE reason IS NULL OR TRIM(reason) = '' ORDER BY id").all();
console.log(`reason 为空的快照：${rows.length} 条${dry ? '（只演练）' : ''}`);

const update = db.prepare('UPDATE task_checkpoints SET verdict = ?, reason = ? WHERE id = ?');
let updated = 0;
let kept = 0;
const buckets = new Map();
for (const row of rows) {
  let output = null;
  try { output = row.output_json ? JSON.parse(row.output_json) : null; } catch { output = null; }
  const result = { ok: output?.ok === true, text: output?.text ?? null, data: output?.data ?? null, error: output?.error ?? null };
  // 失败行常常只有 error（没 text/data），那也要能判出理由
  if (!result.text && !result.data && !result.error) { kept += 1; continue; }
  const judged = evaluateOutcome({ operation: row.operation, result, receipt: {} });
  // 只补「能说出理由」的；重算成 confirmed 但原判定不是 confirmed 的不动（避免改历史结论）
  if (!judged.reason || judged.reason === 'ok') { kept += 1; continue; }
  if (judged.verdict === VERDICTS.confirmed && row.verdict !== 'confirmed') { kept += 1; continue; }
  // 老记录里的 `Command failed: <整段命令+堆栈>` 有几百字，存进 reason 会把页面撑爆：
  // 归一成 `command_failed`（分组照样能认出来），细节仍留在 output_json 里可查。
  const clean = /^Command failed/iu.test(judged.reason)
    ? 'command_failed'
    : judged.reason.replace(/\s+/gu, ' ').slice(0, 120);
  const key = `${row.verdict} → ${judged.verdict} / ${clean}`;
  buckets.set(key, (buckets.get(key) ?? 0) + 1);
  if (!dry) update.run(judged.verdict, clean, row.id);
  updated += 1;
}

console.log(`可回填 ${updated} 条，保持空白 ${kept} 条`);
for (const [key, count] of [...buckets].sort((a, b) => b[1] - a[1])) console.log(`  ${key} ×${count}`);
db.close();
if (dry) console.log('（--dry：没有写库）');
