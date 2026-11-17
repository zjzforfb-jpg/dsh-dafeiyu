// M3：动作失败要能进学习闭环，同类聚合、不同类别分开记。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { classifyFailure, failureSummary, reflectOnActionFailure } from '../connect/core/reflect.mjs';
import { initReflections, listReflections } from '../connect/reflection.mjs';

test('失败原文能分出类别，分不出就老实说 unknown', () => {
  assert.equal(classifyFailure('Command failed: adb: device offline'), 'adb_offline');
  assert.equal(classifyFailure('timed out after 300000ms'), 'timeout');
  assert.equal(classifyFailure('read ECONNRESET'), 'network');
  assert.equal(classifyFailure('interactions_unconfirmed:没读到评论列表'), 'unconfirmed');
  assert.equal(classifyFailure('页面找不到「发布」按钮'), 'ui_missing');
  assert.equal(classifyFailure('随便一句别的话'), 'unknown');
});

test('同动作同类别累加，不同类别分开成两条', () => {
  const db = new DatabaseSync(':memory:');
  initReflections(db);
  const first = reflectOnActionFailure(db, { operation: 'douyin.daily_post', reason: 'adb: device offline', taskId: 't1' });
  assert.equal(first.isNew, true);
  const second = reflectOnActionFailure(db, { operation: 'douyin.daily_post', reason: 'adb: device offline again', taskId: 't2' });
  assert.equal(second.isNew, false);
  assert.equal(second.id, first.id);
  assert.equal(second.occurrences, 2);

  const other = reflectOnActionFailure(db, { operation: 'douyin.daily_post', reason: 'timed out after 300s', taskId: 't3' });
  assert.notEqual(other.id, first.id);
  assert.equal(listReflections(db).length, 2);

  const summary = failureSummary(db);
  assert.equal(summary[0].occurrences, 2, '最常失败的那条排在最前');
  assert.match(summary[0].summary, /手机离线|ADB/u);
  db.close();
});

test('提案里带着证据，方便事后追到具体任务', () => {
  const db = new DatabaseSync(':memory:');
  initReflections(db);
  reflectOnActionFailure(db, { operation: 'douyin.check_interactions', reason: '没读到评论列表', taskId: 'task-abc' });
  const row = listReflections(db)[0];
  const evidence = JSON.parse(row.evidence);
  assert.equal(evidence.first_task, 'task-abc');
  assert.equal(evidence.category, 'ui_missing');
  assert.equal(row.kind, 'action_reflection');
  db.close();
});

test('手机掉线单独成一类，不和「原因不明」混在一起', async () => {
  const { classifyFailure } = await import('../connect/core/reflect.mjs');
  assert.equal(classifyFailure('手机没连上（adb 看到 0 台设备）：抖音和微信操作都需要恰好一台在线的安卓手机。'), 'no_device');
  assert.equal(classifyFailure('adb: device offline'), 'adb_offline');
  assert.equal(classifyFailure('Command failed: 别的错误'), 'unknown');
});
