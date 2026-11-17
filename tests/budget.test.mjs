import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  DAILY_BUDGET, backfillLegacyUsage, budgetUsage, initBudget, ratchetBudget,
  reserve, reserveAutonomousAction, reserveModelCall, reserveVoiceRequest,
} from '../connect/core/budget.mjs';
import { reserve as qqReserve, usage as qqUsage } from '../connect/qq/store.mjs';
import { syncLegacyLifeUsage } from '../life/manager.mjs';

const DAY = '2026-11-16';

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

test('D-2 三个渠道占用同一个跨渠道日配额（只有一份累计）', () => {
  const db = freshDb();
  initBudget(db);
  // 模拟三个渠道各来一次：QQ 走 store.reserve，微信/桌宠走统一预算。
  assert.equal(qqReserve(db, DAY, 'model_calls', null), true);
  assert.equal(reserveModelCall(db, DAY), true);
  assert.equal(reserveVoiceRequest(db, DAY), true);
  assert.equal(reserveAutonomousAction(db, DAY), true);

  const usage = budgetUsage(db, DAY);
  assert.equal(usage.model_calls, 2, 'QQ 与其它渠道共用同一个模型池');
  assert.equal(usage.voice_requests, 1);
  assert.equal(usage.autonomous_actions, 1, '自主动作是另一个独立维度');
  assert.deepEqual(usage.limits, { ...DAILY_BUDGET });

  // 旧表不再被写：只有 daily_budget 一处真值。
  const legacy = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('qq_usage','ilink_usage') AND name='qq_usage'").get().n;
  assert.equal(legacy, 0, '不该凭空造出旧表');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM daily_budget').get().n, 1, '只有一张统一表');
  db.close();
});

test('D-2 模型调用与自主动作是两个互不影响的维度', () => {
  const db = freshDb();
  initBudget(db);
  // 自主动作只有 2 次额度，模型调用有 60 次——先用光前者不影响后者。
  assert.equal(reserveAutonomousAction(db, DAY), true);
  assert.equal(reserveAutonomousAction(db, DAY), true);
  assert.equal(reserveAutonomousAction(db, DAY), false, '自主动作超限');
  assert.equal(reserveModelCall(db, DAY), true, '模型维度独立，不受自主动作影响');
  const usage = budgetUsage(db, DAY);
  assert.equal(usage.autonomous_actions, 2);
  assert.equal(usage.model_calls, 1);
  db.close();
});

test('D-2 调用方自设封顶与统一上限取更小值（保留旧的 limit 语义）', () => {
  const db = freshDb();
  initBudget(db);
  for (let index = 0; index < 3; index += 1) assert.equal(qqReserve(db, DAY, 'model_calls', 3), true);
  assert.equal(qqReserve(db, DAY, 'model_calls', 3), false, 'limit=3 封顶生效');
  assert.deepEqual(qqUsage(db, DAY), { day: DAY, model_calls: 3, voice_requests: 0 });
  assert.throws(() => qqReserve(db, DAY, 'other', 1), /invalid_qq_budget/);
  assert.throws(() => reserve(db, DAY, 'other', 1), /invalid_budget_dimension/);
  db.close();
});

test('D-2 统一上限就是共享上限（QQ 不再各写各的 50）', () => {
  const db = freshDb();
  initBudget(db);
  for (let index = 0; index < DAILY_BUDGET.modelCalls; index += 1) assert.equal(reserveModelCall(db, DAY), true);
  assert.equal(reserveModelCall(db, DAY), false, '超过统一上限就停');
  assert.equal(budgetUsage(db, DAY).model_calls, DAILY_BUDGET.modelCalls);
  db.close();
});

test('D-2 预算表还没建时读取不报错（看板是只读句柄）', () => {
  const db = freshDb();
  const usage = budgetUsage(db, DAY);
  assert.equal(usage.model_calls, 0);
  assert.equal(usage.voice_requests, 0);
  assert.equal(usage.autonomous_actions, 0);
  assert.deepEqual(usage.limits, { ...DAILY_BUDGET });
  db.close();
});

test('D-2 迁移当天不白送额度：旧三套配额的当日用量被棘轮进统一账', () => {
  const db = freshDb();
  // 迁移前各自记账的旧表（QQ 5 次模型、微信 3 次模型 2 次语音、life 4 次模型）。
  db.exec(`CREATE TABLE qq_usage(day TEXT PRIMARY KEY, model_calls INTEGER NOT NULL DEFAULT 0, voice_requests INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE ilink_usage(account_id TEXT NOT NULL, day TEXT NOT NULL, model_calls INTEGER NOT NULL DEFAULT 0, voice_requests INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(account_id, day));
    CREATE TABLE daily_usage(day TEXT PRIMARY KEY, model_calls INTEGER NOT NULL DEFAULT 0, autonomous_actions INTEGER NOT NULL DEFAULT 0);`);
  db.prepare('INSERT INTO qq_usage(day, model_calls, voice_requests) VALUES(?,?,?)').run(DAY, 5, 1);
  db.prepare('INSERT INTO ilink_usage(account_id, day, model_calls, voice_requests) VALUES(?,?,?,?)').run('acct', DAY, 3, 2);
  db.prepare('INSERT INTO daily_usage(day, model_calls, autonomous_actions) VALUES(?,?,?)').run(DAY, 4, 1);

  assert.equal(backfillLegacyUsage(db, DAY), true);
  const usage = budgetUsage(db, DAY);
  assert.equal(usage.model_calls, 12, 'QQ 5 + 微信 3 + life 4 都搬过来了');
  assert.equal(usage.voice_requests, 3, 'QQ 1 + 微信 2');
  assert.equal(usage.autonomous_actions, 1);

  // 再占用一格，计数是 13 而不是 12+5（不重复累加）。
  assert.equal(reserveModelCall(db, DAY), true);
  assert.equal(budgetUsage(db, DAY).model_calls, 13);
  db.close();
});

test('D-2 棘轮只增不减：不会把已经记好的新计数改小', () => {
  const db = freshDb();
  initBudget(db);
  assert.equal(reserveModelCall(db, DAY), true);
  ratchetBudget(db, DAY, { model_calls: 3 });
  assert.equal(budgetUsage(db, DAY).model_calls, 3, '抬到旧账的水平');
  reserveModelCall(db, DAY);
  ratchetBudget(db, DAY, { model_calls: 1 });
  assert.equal(budgetUsage(db, DAY).model_calls, 4, '旧账更小就不动');
  db.close();
});

test('D-2 同一天只回填一次（不会重复搬旧账）', () => {
  const db = freshDb();
  db.exec('CREATE TABLE qq_usage(day TEXT PRIMARY KEY, model_calls INTEGER NOT NULL DEFAULT 0, voice_requests INTEGER NOT NULL DEFAULT 0)');
  db.prepare('INSERT INTO qq_usage(day, model_calls, voice_requests) VALUES(?,?,?)').run(DAY, 5, 0);
  assert.equal(backfillLegacyUsage(db, DAY), true);
  assert.equal(backfillLegacyUsage(db, DAY), false, '同一天第二次不重复回填');
  assert.equal(budgetUsage(db, DAY).model_calls, 5);
  db.close();
});

test('D-2 life 的旧账在另一本库，也要加进同一格（相加，不是取大）', () => {
  const connect = freshDb();
  const brain = freshDb();
  try {
    connect.exec('CREATE TABLE qq_usage(day TEXT PRIMARY KEY, model_calls INTEGER NOT NULL DEFAULT 0, voice_requests INTEGER NOT NULL DEFAULT 0)');
    connect.prepare('INSERT INTO qq_usage(day, model_calls, voice_requests) VALUES(?,?,?)').run(DAY, 3, 0);
    brain.exec('CREATE TABLE daily_usage(day TEXT PRIMARY KEY, model_calls INTEGER NOT NULL DEFAULT 0, autonomous_actions INTEGER NOT NULL DEFAULT 0)');
    brain.prepare('INSERT INTO daily_usage(day, model_calls, autonomous_actions) VALUES(?,?,?)').run(DAY, 1, 1);

    syncLegacyLifeUsage(connect, brain, DAY);
    const usage = budgetUsage(connect, DAY);
    assert.equal(usage.model_calls, 4, 'QQ 的 3 加 life 的 1');
    assert.equal(usage.autonomous_actions, 1, 'life 的自主动作也算进来');
    // 再同步一次不重复累加。
    syncLegacyLifeUsage(connect, brain, DAY);
    assert.equal(budgetUsage(connect, DAY).model_calls, 4);
  } finally { connect.close(); brain.close(); }
});
