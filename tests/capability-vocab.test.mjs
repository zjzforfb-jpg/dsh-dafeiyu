import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { CAPABILITY_MATRIX } from '../connect/core-contract.mjs';
import { CAPABILITIES } from '../connect/memory/capabilities.mjs';
import { ALL_TOOLS, toolsFor } from '../connect/qq/tools.mjs';
import {
  CAPABILITY_STATUSES, RUN_STATUSES, normalizeStatus,
  isCapabilityStatus, isRunStatus,
} from '../connect/core/capability.mjs';

const CANONICAL = ['stable', 'beta', 'prototype', 'planned', 'disabled', 'not_implemented'];

test('状态词表收敛为一份：CAPABILITY_MATRIX / capabilities / runTool 同源', () => {
  // 单一真源就是 capability.mjs 里这一份
  assert.deepEqual([...CAPABILITY_STATUSES].sort(), [...CANONICAL].sort());

  // ① CAPABILITY_MATRIX 每个状态都在统一词表内
  for (const [key, status] of Object.entries(CAPABILITY_MATRIX)) {
    assert.ok(isCapabilityStatus(status), `CAPABILITY_MATRIX.${key}=${status} 不在统一词表`);
  }

  // ② capabilities.mjs 每条能力状态都在统一词表内
  for (const cap of CAPABILITIES) {
    assert.ok(isCapabilityStatus(cap.status), `${cap.id}=${cap.status} 不在统一词表`);
  }

  // ③ runTool 的执行状态词表也来自同一个 capability.mjs 源，且覆盖 failedResults 依赖的项
  assert.ok(isRunStatus('ok') && isRunStatus('failed') && isRunStatus('blocked') && isRunStatus('unconfirmed'));
  assert.ok(!isRunStatus('随便编的'));
});

test('老词 real_verified 已归一到 stable（三处不再各说各话）', () => {
  assert.equal(CAPABILITY_MATRIX.chat_voice_in, 'stable');
  assert.equal(CAPABILITY_MATRIX.voice_file_out, 'stable');
  assert.equal(CAPABILITY_MATRIX.android_observe, 'stable');
  assert.equal(normalizeStatus('real_verified'), 'stable');
  assert.equal(normalizeStatus('stable'), 'stable');
  assert.equal(normalizeStatus('乱写'), 'prototype');
});

test('node scripts/capabilities.mjs --check 仍是回归闸门，返回 {count:12, problems:[]}', () => {
  const out = execFileSync('node', ['scripts/capabilities.mjs', '--check'], {
    cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8',
  });
  const report = JSON.parse(out);
  assert.equal(report.count, 12);
  assert.deepEqual(report.problems, []);
  assert.equal(typeof report.indexLength, 'number');
});

test('B-4：capability.code 收进 owner-only，普通对话拿不到源码', () => {
  const codeTool = ALL_TOOLS.find((t) => t.name === 'capability.code');
  assert.ok(codeTool?.ownerOnly, 'capability.code 应标记 ownerOnly');
  // 非主人的工具目录里不该有它
  assert.ok(!toolsFor(ALL_TOOLS, { owner: false }).some((t) => t.name === 'capability.code'));
  assert.ok(toolsFor(ALL_TOOLS, { owner: true }).some((t) => t.name === 'capability.code'));
  // 显式非主人 ctx 调用时应被拒
  const denied = codeTool.run({ id: 'publishing' }, { root: new URL('..', import.meta.url).pathname, ownerPrivate: false });
  assert.match(String(denied), /只对主人私聊开放/u);
});
