// P1-C / C-1「技能账本归一」：技能/策略账本只有 CONNECT 库（runtime/connect/connect.sqlite）一个真源，
// BRAIN 库（runtime/dsh-home/dafeiyu-memory.sqlite）不再持有 skill_* / strategy_trials 表。
//
// 覆盖：
// 1. openSkillLedger(root) 打开的确实是 CONNECT 库，技能表 + 策略表都在同一本账里；
// 2. beginSkill→endSkill / beginStrategy→endStrategy 的记账落在 CONNECT 库；
// 3. 跑完流程后 BRAIN 库里没有 skill_* / strategy_trials 表；
// 4. scripts/douyin.mjs 已经不再引用 BRAIN 库，统一走 CONNECT 账本。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openMemory } from '../../brain/memory.mjs';
import { openSkillLedger, skillDbPath, withSkillRun } from './ledger.mjs';
import { registerSkill, startSkillRun, finishSkillRun } from '../skills.mjs';
import { chooseStrategy, startStrategyTrial, finishStrategyTrial } from '../strategies.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONNECT_REL = join('runtime', 'connect', 'connect.sqlite');
const BRAIN_REL = join('runtime', 'dsh-home', 'dafeiyu-memory.sqlite');

/** 临时项目根：放特征文件，projectRoot 才能把它认成项目根（connect/actions.mjs + scripts/douyin.mjs）。 */
function project() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ledger-douyin-'));
  mkdirSync(join(root, 'connect'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'runtime', 'dsh-home'), { recursive: true });
  writeFileSync(join(root, 'connect', 'actions.mjs'), '// test fixture\n');
  writeFileSync(join(root, 'scripts', 'douyin.mjs'), '// test fixture\n');
  return root;
}

const tableNames = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
const skillTables = (names) => names.filter((name) => name.startsWith('skill_') || name === 'strategy_trials');

/** 与 scripts/douyin.mjs 里 beginSkill/endSkill 完全同一套调用（同一批公开 API）。 */
function beginSkill(root, skillId, environment = {}) {
  const db = openSkillLedger(root);
  if (!db.prepare('SELECT 1 FROM skill_registry WHERE skill_id=?').get(skillId)) {
    registerSkill(db, { skillId, name: skillId, description: '由抖音操作流程自动登记的候选技能', environment });
  }
  const runId = startSkillRun(db, { skillId, version: 1, environment });
  return { db, runId, startedAt: Date.now() };
}
function endSkill(run, outcome) {
  if (!run) return;
  finishSkillRun(run.db, run.runId, { ...outcome, durationMs: Date.now() - run.startedAt });
  run.db.close();
}

/** 与 scripts/douyin.mjs 里 beginStrategy/endStrategy 完全同一套调用（同一批公开 API）。 */
function beginStrategy(root, skillId, environment) {
  const db = openSkillLedger(root);
  const selected = chooseStrategy(db, { strategyIds: ['uia_smart', 'coordinate_fallback'], environment, requireVerified: true });
  const trial = startStrategyTrial(db, { strategyId: selected.strategy ?? 'uia_smart', skillId, environment, reason: selected.reason });
  return { db, trial, strategy: selected.strategy ?? 'uia_smart', startedAt: Date.now() };
}
function endStrategy(run, outcome) {
  if (!run) return;
  finishStrategyTrial(run.db, run.trial, { ...outcome, durationMs: Date.now() - run.startedAt });
  run.db.close();
}

test('openSkillLedger 打开的是 CONNECT 库，技能表和策略表在同一本账里', () => {
  const root = project();
  const db = openSkillLedger(root);
  const tables = tableNames(db);
  db.close();
  assert.equal(skillDbPath(root), join(root, CONNECT_REL));
  assert.ok(existsSync(join(root, CONNECT_REL)), 'CONNECT 库文件没建出来');
  for (const name of ['skill_registry', 'skill_versions', 'skill_runs', 'strategy_trials']) {
    assert.ok(tables.includes(name), `CONNECT 库缺表 ${name}`);
  }
  assert.ok(existsSync(join(root, 'runtime', 'connect')), 'runtime/connect 目录没建出来');
});

test('beginSkill→endSkill：技能记录落在 CONNECT 库', () => {
  const root = project();
  const run = beginSkill(root, 'douyin.post_comment', { device: 'emulator-5554', app: 'douyin' });
  endSkill(run, { success: true, verified: true, failureStage: null, result: { sent: true } });

  const db = new DatabaseSync(join(root, CONNECT_REL));
  const row = db.prepare('SELECT skill_id, status, success, verified FROM skill_runs WHERE id=?').get(run.runId);
  const registry = db.prepare('SELECT name FROM skill_registry WHERE skill_id=?').get('douyin.post_comment');
  db.close();
  assert.equal(row.skill_id, 'douyin.post_comment');
  assert.equal(row.status, 'succeeded');
  assert.equal(row.success, 1);
  assert.equal(row.verified, 1);
  assert.equal(registry.name, 'douyin.post_comment');
});

test('beginStrategy→endStrategy：策略试次落在 CONNECT 库', () => {
  const root = project();
  const run = beginStrategy(root, 'douyin.post_comment', { device: 'emulator-5554', app: 'douyin', screen: 'comments' });
  endStrategy(run, { success: true, verified: true, result: { sent: true } });

  const db = new DatabaseSync(join(root, CONNECT_REL));
  const row = db.prepare('SELECT strategy_id, skill_id, status, verified FROM strategy_trials WHERE id=?').get(run.trial);
  db.close();
  assert.equal(row.strategy_id, 'uia_smart');
  assert.equal(row.skill_id, 'douyin.post_comment');
  assert.equal(row.status, 'succeeded');
  assert.equal(row.verified, 1);
});

test('跑完技能/策略流程后，BRAIN 库里没有 skill_* / strategy_trials 表', () => {
  const root = project();
  // 先把 BRAIN 库建出来（模拟线上已存在的 BRAIN 库），记下它原本的表集合。
  const brainPath = join(root, BRAIN_REL);
  const brain = openMemory(brainPath);
  const before = tableNames(brain).sort();
  brain.close();
  assert.deepEqual(skillTables(before), [], 'BRAIN 库本来就不该有技能表');

  const skillRun = beginSkill(root, 'douyin.post_comment', { device: 'emulator-5554', app: 'douyin' });
  endSkill(skillRun, { success: false, verified: false, failureStage: 'compliance', result: { error: 'compliance' } });
  const strategyRun = beginStrategy(root, 'douyin.post_comment', { device: 'emulator-5554', app: 'douyin', screen: 'comments' });
  endStrategy(strategyRun, { success: false, verified: false, result: { error: 'compliance' } });

  const after = new DatabaseSync(brainPath);
  const tables = tableNames(after).sort();
  after.close();
  assert.deepEqual(skillTables(tables), [], 'BRAIN 库被写出了技能/策略表');
  assert.deepEqual(tables, before, 'BRAIN 库的表集合不该变化');

  // 同样的记录确实在 CONNECT 库里（证明只是换了真源，没有丢记账）。
  const connect = new DatabaseSync(join(root, CONNECT_REL));
  const runs = connect.prepare('SELECT COUNT(*) c FROM skill_runs WHERE skill_id=?').get('douyin.post_comment');
  const trials = connect.prepare('SELECT COUNT(*) c FROM strategy_trials WHERE skill_id=?').get('douyin.post_comment');
  connect.close();
  assert.equal(runs.c, 1);
  assert.equal(trials.c, 1);
});

test('ledger 自带的 withSkillRun 也只写 CONNECT 库', async () => {
  const root = project();
  const outcome = await withSkillRun(root, { action: 'douyin.check_interactions' }, async () => ({ text: 'ok', data: { status: 'ok', verified: true } }));
  assert.equal(outcome.text, 'ok');

  const db = new DatabaseSync(join(root, CONNECT_REL));
  const runs = db.prepare('SELECT status, verified FROM skill_runs').all();
  db.close();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'succeeded');
  assert.equal(runs[0].verified, 1);
  assert.ok(!existsSync(join(root, BRAIN_REL)), 'BRAIN 库不该被创建');
});

test('scripts/douyin.mjs 不再写 BRAIN 库，技能账本统一走 CONNECT 库', () => {
  const source = readFileSync(join(REPO_ROOT, 'scripts', 'douyin.mjs'), 'utf8');
  assert.ok(!/dafeiyu-memory\.sqlite/u.test(source), 'douyin.mjs 还在引用 BRAIN 库路径');
  assert.ok(!/openMemory/u.test(source), 'douyin.mjs 还在用 openMemory');
  assert.ok(!/\binitSkills\b/u.test(source), 'douyin.mjs 还在自己建技能表');
  assert.ok(!/\binitStrategies\b/u.test(source), 'douyin.mjs 还在自己建策略表');
  assert.match(source, /from '\.\.\/connect\/skills\/ledger\.mjs'/u);
  assert.match(source, /openSkillLedger\(root\)/u);
});
