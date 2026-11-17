// P1-C / C-4：技能从 validating 晋升到 enabled 的闸门。
//
// 晋升不是「跑过一次就算」。要两样都齐：
//   1. 有一条 **验证过** 的真实成功 run（status='succeeded' AND success=1 AND verified=1）；
//   2. 把这条 run 的证据重新喂给技能定义里的结构化断言，全部核过。
// 核不了的步骤一律算失败（basis='missing'）——宁可少升一个技能，不可把没核过的技能放开。
//
// 证据从三处来：
//   run.result  → ctx.data（字段断言：courseTitle / caption / topics …）
//   run 的 activity → ctx.activity（活页断言）
//   skill_step_events → ctx.steps（步骤事件断言：这一步当时到底成了没）

import { skillDef } from './defs.mjs';
import { runAssertions } from './assertions.mjs';
import { setSkillStatus, listSkills } from '../skills.mjs';
import { stepsForRun } from './steps.mjs';

const decode = (value, fallback) => { try { const parsed = JSON.parse(value ?? ''); return parsed ?? fallback; } catch { return fallback; } };

/** 这个技能有没有验证过的成功 run。 */
export function verifiedRuns(db, skillId) {
  try {
    return db.prepare("SELECT * FROM skill_runs WHERE skill_id=? AND status='succeeded' AND success=1 AND verified=1 ORDER BY started_at DESC, id DESC").all(skillId);
  } catch {
    return [];
  }
}

/** 待晋升的技能：注册表里还停在 validating，且有验证过的成功 run。 */
export function promotionCandidates(db) {
  let rows = [];
  try { rows = listSkills(db, { status: 'validating' }); } catch { rows = []; }
  return rows
    .map((row) => {
      const runs = verifiedRuns(db, row.skill_id);
      return {
        skillId: row.skill_id,
        version: Number(row.current_version ?? 1),
        verifiedRuns: runs.length,
        runId: runs[0]?.id ?? null,
      };
    })
    .filter((row) => row.verifiedRuns > 0);
}

/** run.result 里真正的业务数据（有的 run 把 data 包在 result.data 里）。 */
export function runData(run) {
  const parsed = decode(run?.result, {});
  if (parsed && typeof parsed === 'object' && parsed.data && typeof parsed.data === 'object') return parsed.data;
  return parsed && typeof parsed === 'object' ? parsed : {};
}

/** 把一条 run 重放成断言上下文。 */
export function buildContext(db, run, { root = null } = {}) {
  const data = runData(run);
  const steps = {};
  let rows = [];
  try { rows = stepsForRun(db, run.id) ?? []; } catch { rows = []; }
  for (const row of rows) steps[row.step_id] = { ok: row.ok, verified: row.verified, evidence: row.evidence };
  return { data, activity: data.activity ?? null, steps, db, root: root ?? process.cwd(), nodes: undefined, pixels: undefined };
}

const ACTIVITY_LIKE = /[A-Za-z][A-Za-z0-9_.]*(Activity|activity)$/u;

/**
 * 逐步重放：每一步都带着「这一步当时看到的 activity」去核。
 * run.result 里只有一个最终 activity，而步骤事件的 evidence 里记的是那一步当时的 activity，
 * 所以核 activity 类断言时优先用步骤证据，别拿最终状态糊弄。
 */
export function evaluateSteps(def, ctx) {
  const results = [];
  for (const step of def.steps ?? []) {
    const event = ctx.steps?.[step.id] ?? null;
    const evidence = typeof event?.evidence === 'string' ? event.evidence : '';
    const stepCtx = {
      ...ctx,
      activity: ACTIVITY_LIKE.test(evidence.trim()) ? evidence.trim() : ctx.activity,
    };
    const one = runAssertions([step], stepCtx);
    for (const row of one.results ?? []) results.push(row);
  }
  const failed = results.filter((row) => !row.ok);
  return {
    ok: results.length > 0 && failed.length === 0,
    results,
    passed: results.length - failed.length,
    total: results.length,
  };
}

/** 评估某个技能能不能晋升：全部步骤断言都过才算过。 */
export function evaluateSkill(db, skillId, { runId = null, root = null } = {}) {
  const def = skillDef(skillId);
  if (!def) return { ok: false, skillId, reason: 'no_definition', blockers: [] };
  const runs = verifiedRuns(db, skillId);
  const run = runId ? runs.find((item) => item.id === runId) : runs[0];
  if (!run) return { ok: false, skillId, reason: 'no_verified_run', blockers: [] };
  const ctx = buildContext(db, run, { root });
  const result = evaluateSteps(def, ctx);
  const blockers = (result.results ?? [])
    .filter((row) => !row.ok)
    .map((row) => ({ step: row.step ?? null, kind: row.kind ?? null, basis: row.basis ?? null, detail: row.detail ?? null }));
  return {
    ok: Boolean(result.ok),
    skillId,
    version: Number(run.version ?? 1),
    runId: run.id,
    passed: result.passed,
    total: result.total,
    basis: result.basis,
    results: result.results,
    blockers,
  };
}

/** 把够格的技能逐个升到 enabled，返回升了哪些、哪些没过、卡在哪一步。 */
export function promoteSkills(db, { root = null, limit = 50 } = {}) {
  const promoted = [];
  const skipped = [];
  for (const candidate of promotionCandidates(db).slice(0, Math.max(1, Number(limit) || 50))) {
    const evaluation = evaluateSkill(db, candidate.skillId, { runId: candidate.runId, root });
    if (!evaluation.ok) {
      skipped.push({
        skillId: candidate.skillId,
        reason: evaluation.reason ?? 'assertions_failed',
        blockers: evaluation.blockers ?? [],
        passed: evaluation.passed ?? 0,
        total: evaluation.total ?? 0,
      });
      continue;
    }
    setSkillStatus(db, candidate.skillId, evaluation.version, 'enabled');
    promoted.push({ skillId: candidate.skillId, version: evaluation.version, runId: evaluation.runId, passed: evaluation.passed, total: evaluation.total });
  }
  return { promoted, skipped };
}
