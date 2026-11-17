import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { RELEASE_PLAN } from '../connect/live/release-plan.mjs';
import { TOOL_META } from '../connect/live/tool-meta.mjs';
import { hasPreflight } from '../connect/live/preflight.mjs';
import { EXPECT_AFTER, SIDE_EFFECT_ACTIONS } from '../connect/live/expect-after.mjs';

const doc = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('操作单、页面、代码三边说同一批动话：7 个副作用动作一个都不能漏', () => {
  const firstRun = doc('docs/FIRST-RUN.md');
  const planActions = new Set(RELEASE_PLAN.map((step) => step.action));

  for (const action of SIDE_EFFECT_ACTIONS) {
    assert.ok(planActions.has(action), `放行顺序里缺 ${action}`);
    assert.ok(firstRun.includes(`\`${action}\``), `docs/FIRST-RUN.md 里缺 ${action} 的操作步骤`);
    const meta = TOOL_META[action];
    assert.ok(meta, `tool-meta 缺 ${action}`);
    assert.ok(Array.isArray(meta.preflight) && meta.preflight.length >= 2, `${action} 的前置清单太少`);
    assert.ok(typeof meta.impact === 'string' && meta.impact.length >= 8, `${action} 没写清影响`);
    // 「跑完核对什么」住在 expect-after.mjs（真去查库/查系统），说明书里不重复写
    const after = EXPECT_AFTER[action];
    assert.ok(Array.isArray(after) && after.length >= 1, `${action} 没写跑完核对什么（expect-after.mjs）`);
    assert.ok(after.every((line) => typeof line === 'string' && line.trim().length >= 6), `${action} 的核对项必须是人能读懂的句子`);
    assert.ok(hasPreflight(action), `${action} 没有机器可判的前置条件`);
  }
});

test('操作单里提到的动作，必须在真动作表里存在（不许写幽灵步骤）', () => {
  const firstRun = doc('docs/FIRST-RUN.md');
  const mentioned = new Set([...firstRun.matchAll(/`((?:qq|wechat|douyin)\.[a-z_]+)`/gu)].map((match) => match[1]));
  const known = new Set([...Object.keys(TOOL_META), 'douyin.draft']);
  for (const action of mentioned) {
    assert.ok(known.has(action), `操作单提到 ${action}，但页面说明书里没有它`);
  }
});

test('页面必须给每个待放行动作提供：预演、检查、跑一次', () => {
  const ui = doc('connect/live/live.js');
  assert.match(ui, /预演：看它会做什么/u);
  assert.match(ui, /检查现在能不能跑/u);
  assert.match(ui, /我现在要跑它|确认，跑一次/u);
  const server = doc('connect/server.mjs');
  for (const route of ['/api/live/preflight', '/api/live/preview', '/api/live/run', '/api/live/grant']) {
    assert.ok(server.includes(route), `服务端缺接口 ${route}`);
  }
});

test('放行自检脚本能跑，且把 7 个动作逐条列出来', async () => {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, ['scripts/release-check.mjs'], { encoding: 'utf8' });
  assert.match(out, /放行自检/u);
  assert.match(out, /下一步该跑/u);
  for (const action of SIDE_EFFECT_ACTIONS) assert.ok(out.includes(action), `自检里缺 ${action}`);
  assert.match(out, /还有 \d+ 项不满足|全部就绪/u);
});

test('放行当天的文档必须和自检脚本说同一件事', () => {
  const doc1 = doc('docs/RELEASE-DAY.md');
  assert.match(doc1, /npm run release:check/u, '文档必须告诉人先跑自检');
  assert.match(doc1, /runbook-progress\.mjs/u, '收尾要写回 runbook 进度');
  assert.match(doc1, /导出这次证据/u, '每跑完一个要留证据');
  // 顺序：文档里的 7 个小节标题顺序 == RELEASE_PLAN 的顺序
  const inDoc = [...doc1.matchAll(/动作：`([a-z_.]+)`/gu)].map((match) => match[1]);
  assert.deepEqual(inDoc, RELEASE_PLAN.map((step) => step.action));
});
