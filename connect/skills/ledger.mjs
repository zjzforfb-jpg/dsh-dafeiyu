// 技能账本：把动作执行记录到 connect.sqlite 的 skill_registry / skill_versions / skill_runs，
// 失败会自动走 reflection（learning_proposals 聚合）。
// 约定：这里不吞异常，写不进去就打到 stderr，但绝不打断真实动作。
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { registerSkill, initSkills, startSkillRun, finishSkillRun } from '../skills.mjs';
import { initStrategies } from '../strategies.mjs';
import { recordSteps } from './steps.mjs';
import { SKILL_DEFS, SKILL_BY_ACTION, classifyFailure, skillDef } from './defs.mjs';
import { currentVersion, maybeRollback, sweepLearning } from './learning.mjs';

export const SKILL_VERSION = 1;

function projectRoot(root) {
  const base = resolve(root ?? process.cwd());
  // 项目根：有 connect/actions.mjs + scripts/douyin.mjs
  if (existsSync(join(base, 'connect', 'actions.mjs')) && existsSync(join(base, 'scripts', 'douyin.mjs'))) return base;
  // connect 目录（runtime/connect）：往上两层就是项目根
  if (existsSync(join(base, 'connect.sqlite')) || existsSync(join(base, 'targets.json'))) return resolve(base, '..', '..');
  return base;
}

export function skillDbPath(root) {
  return join(projectRoot(root), 'runtime', 'connect', 'connect.sqlite');
}

/**
 * 打开技能/策略账本（CONNECT 库 runtime/connect/connect.sqlite）。
 *
 * 账本的唯一真源：skill_registry / skill_versions / skill_runs / strategy_trials 全部落在这本库里，
 * BRAIN 库（runtime/dsh-home/dafeiyu-memory.sqlite）不再持有任何 skill_* / strategy_trials 表。
 * 这里不跑版本化迁移（CONNECT 库的迁移归 connect/server.mjs），只做幂等的建表。
 *
 * @param {string} root 项目根目录（或 runtime/connect 目录，projectRoot 会自己判定）
 * @returns {import('node:sqlite').DatabaseSync} 已建好技能/策略表的 CONNECT 库连接
 */
export function openSkillLedger(root) {
  const file = skillDbPath(root);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 3000');
  initSkills(db);
  initStrategies(db);
  return db;
}

/** 注册（或补齐）8 个领域技能的 v1 定义；幂等，服务启动时调一次。 */
export function ensureSkillDefs(root, defs = SKILL_DEFS) {
  const db = openSkillLedger(root);
  let created = 0;
  try {
    for (const def of defs) {
      const exists = db.prepare('SELECT 1 FROM skill_versions WHERE skill_id=? AND version=?').get(def.skillId, SKILL_VERSION);
      if (exists) continue;
      registerSkill(db, {
        skillId: def.skillId,
        name: def.name,
        description: def.description,
        version: SKILL_VERSION,
        preconditions: { app: def.environment?.app ?? 'douyin' },
        steps: def.steps,
        postconditions: { steps: def.steps.map((step) => step.assert) },
        fallback: [],
        environment: def.environment ?? {},
        confidence: def.confidence ?? 0.4,
        status: 'validating',
      });
      created += 1;
    }
  } finally {
    db.close();
  }
  return { created, total: defs.length };
}

export function beginActionRun(root, { skillId, taskId = null, environment = {} } = {}) {
  if (!skillId) return null;
  try {
    const db = openSkillLedger(root);
    // 服务没跑过 ensureSkillDefs 时（CLI 直接调动作），按需补注册，避免外键失败。
    const known = db.prepare('SELECT 1 FROM skill_versions WHERE skill_id=? AND version=?').get(skillId, SKILL_VERSION);
    if (!known) {
      const def = skillDef(skillId);
      if (def) {
        registerSkill(db, {
          skillId: def.skillId, name: def.name, description: def.description, version: SKILL_VERSION,
          preconditions: { app: def.environment?.app ?? 'douyin' },
          steps: def.steps,
          postconditions: { steps: def.steps.map((step) => step.assert) },
          fallback: [], environment: def.environment ?? {}, confidence: def.confidence ?? 0.4, status: 'validating',
        });
      }
    }
    const version = currentVersion(db, skillId);
    const id = startSkillRun(db, { skillId, version, taskId, environment });
    db.close();
    return id;
  } catch (error) {
    process.stderr.write(`skill_run_begin_failed: ${String(error?.message ?? error).slice(0, 120)}\n`);
    return null;
  }
}

export function finishActionRun(root, runId, { success, verified = false, failureStage = null, durationMs = null, result = {}, steps = null, skillId = null } = {}) {
  if (!runId) return null;
  try {
    const db = openSkillLedger(root);
    const row = finishSkillRun(db, runId, { success, verified, failureStage, durationMs, result });
    if (Array.isArray(steps) && steps.length && skillId) recordSteps(db, { runId, skillId, steps });
    if (skillId && success === false) maybeRollback(db, skillId, { root });
    // P1-C / C-3：每次跑完都扫一遍学习闭环——R0/R2 的技能攒够次数就自己升版，
    // R3 的照旧等人点头。扫不出来也不该影响这次动作本身的成败。
    try { sweepLearning(db, { root }); } catch (error) {
      process.stderr.write(`learning_sweep_failed: ${String(error?.message ?? error).slice(0, 120)}\n`);
    }
    db.close();
    return row;
  } catch (error) {
    process.stderr.write(`skill_run_finish_failed: ${String(error?.message ?? error).slice(0, 120)}\n`);
    return null;
  }
}

/** 判断脚本输出是否算「验证过」：有明确状态且没有阻断。 */
export function verifiedFromData(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.blockers?.length) return false;
  const status = String(data.status ?? '');
  if (data.verified === true) return true;
  return ['ok', 'draft', 'ready', 'published', 'empty'].includes(status);
}

/**
 * 包一层：自动开/关 skill run。
 * fn 返回 { text, data }；失败抛异常时按消息分类步骤名。
 */
export async function withSkillRun(root, { action, taskId = null, environment = {} }, fn) {
  const skillId = SKILL_BY_ACTION[action] ?? null;
  const runId = beginActionRun(root, { skillId, taskId, environment: { action, ...environment } });
  const startedAt = Date.now();
  if (!runId) return fn();
  try {
    const outcome = await fn();
    const data = outcome && typeof outcome === 'object' ? outcome.data : undefined;
    finishActionRun(root, runId, {
      success: true,
      verified: verifiedFromData(data),
      failureStage: null,
      durationMs: Date.now() - startedAt,
      result: { action, durationMs: Date.now() - startedAt, data: data ?? null },
      steps: data?.steps ?? null,
      skillId,
    });
    return outcome;
  } catch (error) {
    const message = String(error?.message ?? error).slice(0, 200);
    const failureStage = classifyFailure(message, skillDef(skillId) ? 'action' : 'unknown');
    finishActionRun(root, runId, {
      success: false,
      verified: false,
      failureStage,
      durationMs: Date.now() - startedAt,
      result: { action, error: message, durationMs: Date.now() - startedAt },
      steps: [{ id: failureStage, ok: false, evidence: message }],
      skillId,
    });
    throw error;
  }
}

export { SKILL_DEFS, SKILL_BY_ACTION, classifyFailure };
