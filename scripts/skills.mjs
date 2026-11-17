// 查看技能账本：定义、运行记录、失败聚合。
// 用法：node scripts/skills.mjs --list | --runs [--limit 20] | --defs | --failures
//       | --learning | --steps | --sweep（跑一遍学习闭环）| --promote（把够格的技能升版）
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SKILL_DEFS } from '../connect/skills/defs.mjs';
import { skillDbPath } from '../connect/skills/ledger.mjs';

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const option = (name, fallback = '') => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? (args[at + 1] ?? fallback) : fallback;
};

function db() {
  const path = skillDbPath(process.cwd());
  if (!existsSync(path)) throw new Error(`找不到账本：${path}`);
  return new DatabaseSync(path);
}

if (has('defs')) {
  const { describeAssertion } = await import('../connect/skills/assertions.mjs');
  for (const def of SKILL_DEFS) {
    console.log(`${def.skillId} · ${def.name}（${def.steps.length} 步）`);
    for (const step of def.steps) {
      // P1-C：assert 已是结构化对象，直接打印会变成 [object Object]，
      // 所以给人看渲染后的人话，人话背后是真正能执行的机器断言。
      const human = step.assertText ?? describeAssertion(step.assert);
      console.log(`  - ${step.id}：${step.action} → ${human}`);
      if (!step.assertText) console.log(`      [${describeAssertion(step.assert)}]`);
    }
  }
  process.exit(0);
}

if (has('failures')) {
  const conn = db();
  const rows = conn.prepare(`SELECT pattern_key, occurrences, updated_at FROM learning_proposals ORDER BY occurrences DESC LIMIT 30`).all();
  conn.close();
  if (!rows.length) console.log('还没有失败聚合记录。');
  for (const row of rows) {
    const [skillId, , stage] = String(row.pattern_key).split(':');
    console.log(`${skillId} · ${stage} · ${row.occurrences} 次 · ${row.updated_at}`);
  }
  process.exit(0);
}

if (has('learning') || has('提案')) {
  const { learningText } = await import('../connect/skills/learning.mjs');
  console.log(learningText(db()));
  process.exit(0);
}

if (has('steps')) {
  const limit = Math.max(1, Math.min(200, Number(option('limit', '20')) || 20));
  const conn = db();
  const rows = conn.prepare(`SELECT step_id, ok, evidence, at, skill_id, run_id FROM skill_step_events ORDER BY id DESC LIMIT ?`).all(limit);
  conn.close();
  if (!rows.length) console.log('还没有步骤事件。');
  for (const row of rows) console.log(`${row.ok ? '✅' : '❌'} ${row.at} · ${row.skill_id} · ${row.step_id} · ${String(row.evidence ?? '').slice(0, 50)}`);
  process.exit(0);
}

if (has('runs')) {
  const limit = Math.max(1, Math.min(100, Number(option('limit', '15')) || 15));
  const conn = db();
  const rows = conn.prepare(`SELECT id, skill_id, status, success, verified, failure_stage, duration_ms, started_at FROM skill_runs ORDER BY started_at DESC LIMIT ?`).all(limit);
  conn.close();
  if (!rows.length) console.log('还没有运行记录。');
  for (const row of rows) {
    const mark = row.status === 'succeeded' ? '✅' : row.status === 'failed' ? '❌' : '…';
    console.log(`${mark} ${row.started_at} · ${row.skill_id} · ${row.status}${row.verified ? ' · 已验证' : ''}${row.failure_stage ? ` · 卡在 ${row.failure_stage}` : ''} · ${row.duration_ms ?? '?'}ms`);
  }
  process.exit(0);
}

if (has('sweep')) {
  // P1-C / C-3：把学习闭环跑一遍——R0/R2 攒够次数就自己升版，R3 仍等人点头。
  const { sweepLearning } = await import('../connect/skills/learning.mjs');
  const result = sweepLearning(db(), { root: process.cwd() });
  console.log(`自动升版 ${result.approved.length} 个 · 待主人点头 ${result.pending.length} 个 · 跳过 ${result.skipped.length} 个`);
  for (const item of result.approved) console.log(`✅ 自动升版 ${item.skillId} v${item.from} → v${item.to}（卡在「${item.stage}」）`);
  for (const item of result.pending) console.log(`⏳ ${item.skillId} · ${item.occurrences}/${item.threshold} 次 · ${item.autoApprove ? '自动档' : '要你点头'}`);
  for (const item of result.skipped) console.log(`⚠️ 跳过 ${item.reflection ?? ''} · ${item.reason}`);
  process.exit(0);
}

if (has('promote')) {
  // P1-C / C-4：技能升版闸门——要验证过的成功 run + 结构化断言全过。
  const { promoteSkills } = await import('../connect/skills/promotion.mjs');
  const result = promoteSkills(db(), { root: process.cwd() });
  console.log(`升版 ${result.promoted.length} 个 · 没升 ${result.skipped.length} 个`);
  for (const item of result.promoted) console.log(`✅ ${item.skillId} v${item.version} · 断言 ${item.passed}/${item.total} 通过 · 依据 run ${item.runId}`);
  for (const item of result.skipped) {
    console.log(`⛔ ${item.skillId} · ${item.reason} · 断言 ${item.passed}/${item.total}`);
    for (const blocker of item.blockers ?? []) console.log(`    - ${blocker.step} · ${blocker.basis} · ${blocker.detail}`);
  }
  process.exit(0);
}

const conn = db();
const rows = conn.prepare('SELECT skill_id, name, status, current_version, updated_at FROM skill_registry ORDER BY skill_id').all();
const runs = conn.prepare("SELECT COUNT(*) c, SUM(CASE WHEN verified=1 AND success=1 THEN 1 ELSE 0 END) v FROM skill_runs").get();
conn.close();
console.log(`技能 ${rows.length} 个 · 运行 ${runs.c} 次 · 已验证成功 ${runs.v} 次`);
for (const row of rows) console.log(`- ${row.skill_id} · ${row.name} · ${row.status} v${row.current_version} · ${row.updated_at}`);
