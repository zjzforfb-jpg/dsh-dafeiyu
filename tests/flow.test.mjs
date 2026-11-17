import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * 平面数据流页（/flow）的护栏：
 *  - 图上每个节点都得有格子，每条连线两端都得有位置，和 arch/graph.mjs 不能脱节；
 *  - /live 的九段与流程图节点要能互相跳（两个方向都覆盖）；
 *  - 页面只引用站内资源，模块路径都能取到。
 */
import { NODES, EDGES, PATHS, EVENT_STYLE } from '../connect/arch/graph.mjs';
import { PIPELINE_IDS } from '../connect/core/pipeline.mjs';
import { CELLS, STAGE_NODE, NODE_STAGE, canvasSize, centerOf, validateLayout } from '../connect/flow/layout.mjs';
import { startConnect } from '../connect/server.mjs';

test('平面流程图的布局与 3D 图、九段流水线三者自洽', () => {
  assert.deepEqual(validateLayout({ nodes: NODES, edges: EDGES }, [...PIPELINE_IDS]), []);
  assert.equal(Object.keys(CELLS).length, NODES.length, '每个节点都必须有格子');
  for (const node of NODES) {
    const point = centerOf(node.id);
    assert.ok(point && Number.isFinite(point.x) && Number.isFinite(point.y), `${node.id} 没有坐标`);
  }
  const box = canvasSize();
  for (const node of NODES) {
    const point = centerOf(node.id);
    assert.ok(point.x > 0 && point.x < box.width, `${node.id} 超出画布`);
    assert.ok(point.y > 0 && point.y < box.height, `${node.id} 超出画布`);
  }
  // 每条事件路径上的节点都得能画出折线
  for (const [name, path] of Object.entries(PATHS)) {
    for (const id of path) {
      if (id === '{channel}') continue;
      assert.ok(CELLS[id], `事件路径 ${name} 里的 ${id} 没有位置`);
    }
  }
  for (const [type, style] of Object.entries(EVENT_STYLE)) {
    assert.ok(PATHS[style.path], `事件 ${type} 指向不存在的路径 ${style.path}`);
  }
});

test('/live 九段与流程图节点双向可跳，没有任何一段落空', () => {
  for (const stage of PIPELINE_IDS) {
    assert.ok(STAGE_NODE[stage], `/live 阶段 ${stage} 没有对应节点`);
  }
  for (const node of NODES) {
    assert.ok(NODE_STAGE[node.id], `节点 ${node.id} 没定义跳回哪一段`);
    assert.ok(PIPELINE_IDS.includes(NODE_STAGE[node.id]), `节点 ${node.id} 跳到了不存在的阶段`);
  }
});

test('/flow 页面与模块只引用站内资源，且跨页链接都在', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../connect/flow/index.html', import.meta.url), 'utf8');
  assert.match(html, /<canvas id="cv"/u);
  assert.match(html, /id="labels"/u);
  assert.match(html, /src="\/flow\/flow\.js"/u);
  assert.doesNotMatch(html, /https?:\/\//u, '流程图页面不该依赖外网资源');
  const js = readFileSync(new URL('../connect/flow/flow.js', import.meta.url), 'utf8');
  assert.match(js, /\/api\/arch\/stream/u, '没有接实时事件流');
  assert.match(js, /\/flow\/layout\.mjs/u);
  assert.match(js, /\/live\/\?stage=/u, '节点上没有跳回实时工作流的链接');
  const liveHtml = readFileSync(new URL('../connect/live/index.html', import.meta.url), 'utf8');
  assert.match(liveHtml, /id="dFlow"/u, '/live 详情栏缺「在数据流图里看」入口');
  assert.match(liveHtml, /\/flow\//u);
});

test('/flow 与 /live 都能被 connect 服务出来', async () => {
  const root = `/tmp/flow-test-${process.pid}-${Date.now()}`;
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'flow-'));
  const app = await startConnect({ root: dir, port: 0, qq: false, config: { adminToken: 'token-flow', devices: {} } });
  const base = `http://127.0.0.1:${app.port ?? app.server?.address?.().port}`;
  try {
    const page = await fetch(`${base}/flow/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/u);
    const js = await fetch(`${base}/flow/flow.js`);
    assert.equal(js.status, 200);
    const layout = await fetch(`${base}/flow/layout.mjs`);
    assert.equal(layout.status, 200);
    const graph = await fetch(`${base}/arch/graph.mjs`);
    assert.equal(graph.status, 200, '流程图依赖 /arch/graph.mjs，必须能取到');
    const redirect = await fetch(`${base}/flow`, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    const hop = await fetch(`${base}/flow/../../server.mjs`);
    assert.ok([400, 401, 404].includes(hop.status), `目录穿越没挡住：${hop.status}`);
    void root;
  } finally {
    await app.close?.();
  }
});

test('/api/flow/summary 不需要令牌，只给阶段最近事件与动作判定，不含 payload', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const { migrateConnect } = await import('../connect/core/migrations.mjs');
  const { initCheckpoints, recordCheckpoint } = await import('../connect/core/checkpoints.mjs');
  const { flowSummary } = await import('../connect/flow/summary.mjs');

  const root = mkdtempSync(join(tmpdir(), 'flow-summary-'));
  const db = new DatabaseSync(join(root, 'connect.sqlite'));
  migrateConnect(db);
  initCheckpoints(db);
  recordCheckpoint(db, { taskId: 't1', operation: 'douyin.check_interactions', verdict: 'confirmed', reason: 'ok', output: { text: '机密正文不该出现在汇总里' }, ok: true });

  // 直接算一遍：阶段计数、动作判定、totals 都要有
  const summary = flowSummary(db, { now: Date.now() });
  assert.ok(summary.stages.entry, '九段都要有键');
  assert.equal(Object.keys(summary.stages).length, 9);
  assert.equal(summary.tools['douyin.check_interactions']?.verdict, 'confirmed');
  assert.ok(summary.totals && typeof summary.totals.events === 'number');
  assert.doesNotMatch(JSON.stringify(summary), /机密正文/u, '汇总不能泄露 payload 正文');
  db.close();

  // 再走 HTTP：不带任何令牌也要 200
  const app = await startConnect({ root, port: 0, qq: false, config: { adminToken: 'token-flow', devices: {} } });
  const base = `http://127.0.0.1:${app.port ?? app.server?.address?.().port}`;
  try {
    const response = await fetch(`${base}/api/flow/summary`);
    assert.equal(response.status, 200, '流程图汇总不该要令牌');
    const body = await response.json();
    assert.equal(body.tools['douyin.check_interactions']?.verdict, 'confirmed');
    assert.equal(Object.keys(body.stages).length, 9);
  } finally {
    await app.close?.();
  }
});

test('/api/flow/summary 带「今天四个数」，不带令牌也能看到', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const { migrateConnect } = await import('../connect/core/migrations.mjs');
  const { initTasks } = await import('../connect/tasks.mjs');
  const { recordAgentEvent } = await import('../connect/agent-events.mjs');
  const { flowSummary } = await import('../connect/flow/summary.mjs');

  const root = mkdtempSync(join(tmpdir(), 'flow-today-'));
  const db = new DatabaseSync(join(root, 'connect.sqlite'));
  migrateConnect(db);
  initTasks(db);
  const now = Date.now();
  recordAgentEvent(db, { eventType: 'action_finished', channel: 'qq', actor: 'test', payload: { operation: 'douyin.draft' } });
  recordAgentEvent(db, { eventType: 'action_failed', channel: 'qq', actor: 'test', payload: { operation: 'douyin.draft' } });

  const summary = flowSummary(db, { now });
  assert.ok(summary.today, 'today 计数必须有');
  assert.ok(summary.today.events >= 2);
  assert.equal(summary.today.actions >= 2, true);
  assert.equal(summary.today.fails >= 1, true);
  assert.equal(typeof summary.today.awaiting, 'number');
  db.close();

  const app = await startConnect({ root, port: 0, qq: false, config: { adminToken: 'tok', devices: {} } });
  const base = `http://127.0.0.1:${app.port ?? app.server?.address?.().port}`;
  try {
    const response = await fetch(`${base}/api/flow/summary`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.today && typeof body.today.events === 'number', '不带令牌也要能拿到今天的数字');
  } finally {
    await app.close?.();
  }
});

test('汇总里的覆盖度和动作表对得上，且只有四类、加起来等于总数', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { ACTIONS } = await import('../connect/actions.mjs');
  const { flowSummary } = await import('../connect/flow/summary.mjs');
  const { initCheckpoints, recordCheckpoint } = await import('../connect/core/checkpoints.mjs');

  const root = mkdtempSync(join(tmpdir(), 'flow-cov-'));
  const db = new DatabaseSync(join(root, 'c.sqlite'));
  initCheckpoints(db);
  recordCheckpoint(db, { taskId: 't1', operation: 'douyin.draft', verdict: 'confirmed', reason: 'ok', ok: true });
  recordCheckpoint(db, { taskId: 't2', operation: 'douyin.reply_comments', verdict: 'unconfirmed', reason: 'nothing_to_do(2):no_content×2' });

  const summary = flowSummary(db, { now: Date.now() });
  const cov = summary.coverage;
  const live = Object.values(ACTIONS).filter((item) => item && !item.offline).length;
  assert.equal(cov.total, live, '覆盖度总数必须等于在用的动作数');
  assert.equal(cov.confirmed, 1);
  assert.equal(cov.unconfirmed, 1);
  assert.equal(cov.failed, 0);
  assert.equal(cov.confirmed + cov.unconfirmed + cov.failed + cov.untested, cov.total);
  assert.equal(summary.tools['douyin.reply_comments'].reason, 'nothing_to_do(2):no_content×2');
  // 侧栏「判定：…」要用到的历史：最多 3 条、跟着最新一条一起走
  assert.ok(Array.isArray(summary.tools['douyin.reply_comments'].history), '判定历史要带出来');
  assert.ok(summary.tools['douyin.reply_comments'].history.length <= 3, '最多 3 条');
  assert.equal(summary.tools['douyin.reply_comments'].history[0].verdict, 'unconfirmed');
});

test('汇总里带最近一次「授权项就绪」，闸门节点能显示 6/7 缺谁', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const { initAgentEvents, recordAgentEvent } = await import('../connect/agent-events.mjs');
  const { flowSummary } = await import('../connect/flow/summary.mjs');

  const db = new DatabaseSync(join(mkdtempSync(join(tmpdir(), 'flow-ready-')), 'connect.sqlite'));
  initAgentEvents(db);
  // 没核验过时不能编一个数字出来
  assert.equal(flowSummary(db).readiness, null);
  recordAgentEvent(db, {
    eventType: 'preflight_checked',
    channel: 'system',
    actor: 'preflight',
    payload: { ready: 6, total: 7, missing: ['qq.hangup'] },
    dedupeKey: 'preflight:test',
  });
  const out = flowSummary(db);
  assert.deepEqual(out.readiness.missing, ['qq.hangup']);
  assert.equal(out.readiness.ready, 6);
  assert.equal(out.readiness.total, 7);
  db.close();
});

test('闸门/执行节点的面板里也有「下一步要谁点头」，三个页面说法一致', async () => {
  const { readFileSync } = await import('node:fs');
  const js = readFileSync(new URL('../connect/flow/flow.js', import.meta.url), 'utf8');
  assert.match(js, /下一步/u);
  assert.match(js, /待放行/u);
  assert.match(js, /\/live\/\?tab=report/u, '要能跳到 /live 的报告页签');
  assert.match(js, /\/docs\/FIRST-RUN\.md/u, '要能点开操作单');
  // 只对「闸门」和「执行」两个节点加这一行（别把每个节点都塞满）
  assert.match(js, /selected === 'gate' \|\| selected === 'actions'/u);
});
