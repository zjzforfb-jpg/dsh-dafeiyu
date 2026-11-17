import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { contractOf, contractSummary } from '../connect/live/contract.mjs';
import { TOOL_META } from '../connect/live/tool-meta.mjs';

test('每个在用的动作三件齐：说明书 + 前置声明 + 跑完判定', () => {
  const summary = contractSummary(Object.keys(TOOL_META));
  assert.equal(summary.total, Object.keys(TOOL_META).length);
  assert.deepEqual(summary.incomplete, [], `还有动作缺契约：${JSON.stringify(summary.incomplete)}`);
  assert.equal(summary.complete, summary.total);
});

test('缺什么就报什么（造一个反例，别只看全绿）', () => {
  // 未知动作：既没说明书也没跑后判定
  const unknown = contractOf('does.not.exist');
  assert.equal(unknown.ok, false);
  assert.ok(unknown.gaps.some((gap) => gap.key === 'meta'));
  assert.ok(unknown.gaps.some((gap) => gap.key === 'expect'));
  // 只读工具：不需要命令/前置/跑后判定
  const readOnly = contractOf('weather.get');
  assert.equal(readOnly.readOnly, true);
  assert.equal(readOnly.ok, true, `只读工具不该被要求命令：${JSON.stringify(readOnly.gaps)}`);
});

test('接口与页面都暴露了契约体检', () => {
  const api = readFileSync(new URL('../connect/live/api.mjs', import.meta.url), 'utf8');
  assert.match(api, /contractSummary: contractSummary\(/u);
  assert.match(api, /contracts\[item\.action\] = contractOf/u);
  const ui = readFileSync(new URL('../connect/live/live.js', import.meta.url), 'utf8');
  assert.match(ui, /契约体检/u);
  assert.match(ui, /c-gap/u, '卡片上要能看见「契约缺 N 项」');
});
