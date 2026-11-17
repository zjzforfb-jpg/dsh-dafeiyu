// 实时工作流控制台（GET /live + /api/live/*）的回归：
// 事件→阶段映射自洽、快照/详情接口不丢输入输出、摘要不泄露长正文、
// 静态资源只放行白名单、令牌缺失时一律 401（含 SSE）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startConnect } from '../connect/server.mjs';
import { recordAgentEvent } from '../connect/agent-events.mjs';
import { proposeTask } from '../connect/tasks.mjs';
import {
  digestOf, EVENT_ROUTE, stageForEvent, STAGE_IDS, stateOfStatus,
} from '../connect/live/catalog.mjs';

test('事件都能落到 9 个阶段之一，任务状态有明确颜色', () => {
  const known = new Set(Object.keys(EVENT_ROUTE));
  assert.ok(known.size >= 10, '事件路由表太窄，页面会大面积不亮');
  for (const type of known) {
    const route = stageForEvent({ eventType: type, payload: null });
    assert.ok(STAGE_IDS.includes(route.stage), `${type} 落到未知阶段 ${route.stage}`);
    assert.ok(['idle', 'active', 'ok', 'fail', 'wait', 'review'].includes(route.state), `${type} 状态非法`);
  }
  // 待确认要点紫灯，不是笼统的黄
  assert.equal(stageForEvent({ eventType: 'task_state_changed', payload: '{"status":"awaiting_confirmation"}' }).state, 'review');
  assert.equal(stageForEvent({ eventType: 'task_state_changed', payload: '{"status":"running"}' }).state, 'active');
  assert.equal(stageForEvent({ eventType: 'task_state_changed', payload: '{"status":"failed"}' }).state, 'fail');
  // 未知事件兜底到接入阶段，不抛错
  assert.equal(stageForEvent({ eventType: 'never_seen_before' }).stage, 'entry');
  assert.equal(stageForEvent().stage, 'entry');
  // 回执非成功要点红灯
  assert.equal(stageForEvent({ eventType: 'receipt_verified', payload: '{"status":"failed"}' }).state, 'fail');
  // 任务状态 → 颜色
  assert.equal(stateOfStatus('succeeded'), 'ok');
  assert.equal(stateOfStatus('awaiting_publish'), 'review');
  assert.equal(stateOfStatus('cancelled'), 'fail');
  assert.equal(stateOfStatus('莫名其妙'), 'idle');
});

test('一行摘要只挑关键字段，不把整段正文搬到列表里', () => {
  const summary = digestOf({ status: 'succeeded', operation: 'douyin.publish', long: 'x'.repeat(400) });
  assert.match(summary, /status=succeeded/u);
  assert.match(summary, /operation=douyin\.publish/u);
  assert.ok(!summary.includes('xxxx'), '长正文不该进摘要');
  assert.ok(summary.length <= 120);
  // 同值去重：status 与 working_status 相同只留一条
  assert.equal(digestOf({ status: 'running', working_status: 'running' }), 'status=running');
  assert.equal(digestOf(null), '');
});

test('/live 只放行白名单、接口要令牌、详情能看到输入与输出', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dafeiyu-live-'));
  const service = await startConnect({ root, port: 0, qq: false, config: { adminToken: 'token-abc', devices: {} } });
  const base = `http://127.0.0.1:${service.port}`;
  const auth = { authorization: 'Bearer token-abc' };
  try {
    // ---- 静态资源 ----
    const page = await fetch(`${base}/live`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
    const html = await page.text();
    assert.match(html, /src="\/live\/live\.js"/u);
    assert.match(html, /href="\/live\/live\.css"/u);
    const js = await fetch(`${base}/live/live.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /^text\/javascript/u);
    assert.equal((await fetch(`${base}/live/live.css`)).status, 200);
    for (const bad of ['/live/../server.mjs', '/live/nope.mjs', '/live/..%2fserver.mjs']) {
      const res = await fetch(`${base}${bad}`);
      assert.ok([400, 401, 404].includes(res.status), `${bad} 应该是 400/401/404，实际 ${res.status}`);
      assert.ok(!(await res.text()).includes('startConnect'), `${bad} 泄露了源码`);
    }

    // ---- 接口要令牌 ----
    assert.equal((await fetch(`${base}/api/live/snapshot`)).status, 401);
    assert.equal((await fetch(`${base}/api/live/tools`)).status, 401);
    assert.equal((await fetch(`${base}/api/live/event?id=event_x`)).status, 401);

    // ---- 造数据：一条任务 + 开始/完成事件（另开一条连接写，模拟真实调用方） ----
    const writer = new DatabaseSync(join(root, 'connect.sqlite'));
    const task = proposeTask(writer, {
      kind: 'c2c', convId: 'u1', sourceMessageId: 'msg-1', origin: 'test',
      intent: { intent: 'douyin.publish', operations: ['douyin.publish'] },
    });
    const started = recordAgentEvent(writer, { eventType: 'action_started', channel: 'system', taskId: task.id, payload: { operation: 'douyin.publish', step: 1 } });
    recordAgentEvent(writer, { eventType: 'action_finished', channel: 'system', taskId: task.id, payload: { operation: 'douyin.publish', status: 'succeeded' }, result: { ok: true, url: 'https://example.invalid/x' }, evidence: { checked: true } });
    writer.close();

    const snapshot = await (await fetch(`${base}/api/live/snapshot`, { headers: auth })).json();
    assert.equal(snapshot.stages.length, 9);
    assert.ok(snapshot.stages.every((stage) => typeof stage.wired === 'boolean'));
    assert.ok(snapshot.totals.events >= 2);
    assert.ok(snapshot.recent.some((row) => row.taskId === task.id));

    // 事件详情：输入（payload）与输出（result/evidence）都在，且是结构化对象
    const event = await (await fetch(`${base}/api/live/event?id=${started.id}`, { headers: auth })).json();
    assert.equal(event.event.eventType, 'action_started');
    assert.equal(event.event.input.operation, 'douyin.publish');
    assert.equal(event.task.id, task.id);
    assert.equal(event.event.stage, 'act');

    // 任务详情：步骤时间线 + 每步输入输出
    const detail = await (await fetch(`${base}/api/live/task?id=${task.id}`, { headers: auth })).json();
    assert.equal(detail.task.intent, 'douyin.publish');
    assert.ok(detail.steps.length >= 2, `步骤太少：${detail.steps.length}`);
    assert.equal(detail.steps.at(-1).output.ok, true);
    assert.ok(detail.steps.at(-1).evidence.checked);
    assert.equal(detail.summary.total, detail.steps.length);

    // 非法 / 不存在的 id
    assert.equal((await fetch(`${base}/api/live/event?id=%20%20`, { headers: auth })).status, 400);
    assert.equal((await fetch(`${base}/api/live/task?id=task_nope`, { headers: auth })).status, 404);

    // 工具清单：能力映射里的全部动作 + 只读工具，每行都带「人话说明书」
    const tools = await (await fetch(`${base}/api/live/tools`, { headers: auth })).json();
    assert.equal(tools.items.length, tools.actions + tools.readOnly);
    // 16：douyin.like_comments / douyin.prepare 已于 2026-11-18 下线
    assert.ok(tools.actions >= 15);
    assert.ok(tools.readOnly >= 5);
    const call = tools.items.find((item) => item.action === 'qq.call');
    assert.ok(call);
    assert.equal(call.title, '给爸爸打电话');
    assert.match(call.file, /qq-call\.mjs/u);
    assert.equal(call.level, 'ai');
    assert.equal(call.levelLabel, 'AI 介入');
    // 等级只有这四种，页面靠它上不同颜色
    for (const item of tools.items) assert.ok(['auto', 'ai', 'review', 'missing'].includes(item.level), item.action ?? item.tool);

    // SSE：令牌可以走 query（EventSource 带不了头）；没有令牌必须 401
    assert.equal((await fetch(`${base}/api/live/stream`)).status, 401);
  } finally {
    await service.close?.();
    rmSync(root, { recursive: true, force: true });
  }
});

test('工具卡会带出「最近一次判定 + 理由」，没跑过的只说没跑过', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const { migrateConnect } = await import('../connect/core/migrations.mjs');
  const { initCheckpoints, recordCheckpoint } = await import('../connect/core/checkpoints.mjs');
  const { toolList } = await import('../connect/live/api.mjs');

  const root = mkdtempSync(join(tmpdir(), 'dfy-live-last-'));
  const db = new DatabaseSync(join(root, 'connect.sqlite'));
  migrateConnect(db);
  initCheckpoints(db);
  recordCheckpoint(db, { taskId: 'task-x', operation: 'douyin.reply_comments', verdict: 'unconfirmed', reason: 'nothing_to_do', output: {}, ok: false });
  recordCheckpoint(db, { taskId: 'task-y', operation: 'douyin.hot_comment_round', verdict: 'mismatched', reason: 'count=0<2', output: {}, ok: false });

  const tools = toolList(db, Date.now());
  const reply = tools.items.find((i) => i.action === 'douyin.reply_comments');
  const hot = tools.items.find((i) => i.action === 'douyin.hot_comment_round');
  assert.equal(reply.lastVerdict, 'unconfirmed');
  assert.equal(reply.lastVerdictReason, 'nothing_to_do');
  assert.equal(hot.lastVerdictReason, 'count=0<2');
  assert.ok(reply.lastVerdictAt, '要带时间，否则页面只能显示「没跑过」');
  assert.equal(tools.items.find((i) => i.action === 'weather.get').lastVerdict, null);
  db.close();
});

test('工具清单带覆盖度：有证据 / 未确认 / 失败 / 没跑过 加起来等于动作数', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const { migrateConnect } = await import('../connect/core/migrations.mjs');
  const { initCheckpoints, recordCheckpoint } = await import('../connect/core/checkpoints.mjs');
  const { toolList } = await import('../connect/live/api.mjs');

  const root = mkdtempSync(join(tmpdir(), 'live-cov-'));
  const db = new DatabaseSync(join(root, 'connect.sqlite'));
  migrateConnect(db);
  initCheckpoints(db);
  recordCheckpoint(db, { taskId: 't', operation: 'douyin.check_interactions', verdict: 'confirmed', reason: 'ok', ok: true });
  recordCheckpoint(db, { taskId: 't', operation: 'douyin.reply_comments', verdict: 'unconfirmed', reason: 'nothing_to_do', ok: false });
  recordCheckpoint(db, { taskId: 't', operation: 'douyin.comment_latest', verdict: 'failed', reason: 'script_error', ok: false });
  const tools = toolList(db, Date.now());
  db.close();
  const cov = tools.coverage;
  assert.equal(cov.total, tools.actions);
  assert.equal(cov.confirmed + cov.unconfirmed + cov.failed + cov.untested, cov.total);
  assert.equal(cov.confirmed, 1);
  assert.equal(cov.unconfirmed, 1);
  assert.equal(cov.failed, 1);
});

test('工具详情带「判定历史」：最多 5 条、按时间倒序、理由原样带出', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { migrateConnect } = await import('../connect/core/migrations.mjs');
  const { initCheckpoints, recordCheckpoint } = await import('../connect/core/checkpoints.mjs');
  const { toolList } = await import('../connect/live/api.mjs');

  const root = mkdtempSync(join(tmpdir(), 'live-hist-'));
  const db = new DatabaseSync(join(root, 'connect.sqlite'));
  migrateConnect(db, { backup: false });
  initCheckpoints(db);
  for (const [index, verdict] of ['failed', 'unconfirmed', 'confirmed', 'unconfirmed', 'confirmed', 'confirmed'].entries()) {
    recordCheckpoint(db, {
      taskId: `t${index}`, operation: 'douyin.reply_comments', verdict,
      reason: verdict === 'unconfirmed' ? 'nothing_to_do(3):no_content×3' : verdict === 'confirmed' ? 'ok' : 'boom',
      ok: verdict === 'confirmed', now: 1_700_000_000_000 + index * 60_000,
    });
  }
  const tools = toolList(db, Date.now());
  const item = tools.items.find((entry) => entry.action === 'douyin.reply_comments');
  assert.ok(item, '工具清单里应有 douyin.reply_comments');
  assert.equal(item.history.length, 5, '最多保留 5 条');
  // 倒序：最后写入的最新
  const times = item.history.map((entry) => entry.at);
  assert.deepEqual(times, [...times].sort().reverse());
  assert.equal(item.history[0].verdict, 'confirmed');
  assert.ok(item.history.some((entry) => entry.reason.startsWith('nothing_to_do(')), '没活干的理由要原样留着');
});

test('「没活干」要有量级：一周内多次 nothing_to_do(n) 会被加起来', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { migrateConnect } = await import('../connect/core/migrations.mjs');
  const { initCheckpoints, recordCheckpoint } = await import('../connect/core/checkpoints.mjs');
  const { toolList } = await import('../connect/live/api.mjs');

  const root = mkdtempSync(join(tmpdir(), 'live-scan-'));
  const db = new DatabaseSync(join(root, 'connect.sqlite'));
  migrateConnect(db, { backup: false });
  initCheckpoints(db);
  const now = Date.now();
  recordCheckpoint(db, { taskId: 'a', operation: 'douyin.reply_comments', verdict: 'unconfirmed', reason: 'nothing_to_do(3):no_content×2,already_replied×1', ok: true, now: now - 1000 });
  recordCheckpoint(db, { taskId: 'b', operation: 'douyin.reply_comments', verdict: 'unconfirmed', reason: 'nothing_to_do(2):no_content×2', ok: true, now: now - 2000 });

  const tools = toolList(db, now);
  const item = tools.items.find((entry) => entry.action === 'douyin.reply_comments');
  assert.equal(item.weekScanned, 5, '两次共扫了 5 条');
  assert.equal(item.weekBreakdown.no_content, 4);
  assert.equal(item.weekBreakdown.already_replied, 1);
  assert.equal(item.weekRuns, 2);
});

test('判定历史带 task_id，能点回那次任务', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { migrateConnect } = await import('../connect/core/migrations.mjs');
  const { initCheckpoints, recordCheckpoint } = await import('../connect/core/checkpoints.mjs');
  const { toolList } = await import('../connect/live/api.mjs');

  const root = mkdtempSync(join(tmpdir(), 'live-taskid-'));
  const db = new DatabaseSync(join(root, 'connect.sqlite'));
  migrateConnect(db, { backup: false });
  initCheckpoints(db);
  recordCheckpoint(db, { taskId: 'task-abc', operation: 'douyin.hot_comment_round', verdict: 'confirmed', reason: 'ok', ok: true });

  const tools = toolList(db, Date.now());
  const item = tools.items.find((entry) => entry.action === 'douyin.hot_comment_round');
  assert.equal(item.history[0].taskId, 'task-abc', '判定历史要带 task_id 才能跳回去');
});

test('需要授权的动作都写了「跑之前要确认」，且每条至少两条', async () => {
  const { TOOL_META } = await import('../connect/live/tool-meta.mjs');
  const gated = ['qq.call', 'qq.call_mom', 'wechat.call', 'qq.hangup', 'douyin.publish', 'douyin.publish_draft', 'douyin.publish_video'];
  for (const action of gated) {
    const meta = TOOL_META[action];
    assert.ok(meta, `缺说明书：${action}`);
    assert.ok(Array.isArray(meta.preflight) && meta.preflight.length >= 2, `${action} 缺少前置检查清单`);
    for (const line of meta.preflight) assert.ok(String(line).trim().length >= 8, `${action} 的清单条目太短：${line}`);
  }
});

test('前置核验：探针全绿才 ready，缺一项就不 ready，判断不了的不冒充', async () => {
  const { probePreflight, PROBE_ACTIONS } = await import('../connect/live/preflight.mjs');
  const probes = {
    device: async () => ({ ok: true, detail: '1 台在线' }),
    wechat: async () => ({ ok: false, detail: '微信桌面端没启动' }),
    qqWindow: async () => ({ ok: true, detail: '1 个窗口（标题可读）' }),
    qqCallWindow: async () => ({ ok: false, detail: '当前没有进行中的通话' }),
    draft: async () => ({ ok: true, detail: '2 份草稿可发' }),
  };
  const out = await probePreflight({ probes });
  // 七个需要授权的动作都要有结论
  for (const action of ['qq.call', 'qq.call_mom', 'wechat.call', 'qq.hangup', 'douyin.publish', 'douyin.publish_draft', 'douyin.publish_video']) {
    assert.ok(out.results[action], `缺 ${action} 的核验结果`);
  }
  assert.equal(out.results['qq.call'].ready, true);
  assert.equal(out.results['wechat.call'].ready, false, '微信没启动就不能 ready');
  assert.equal(out.results['qq.hangup'].ready, false, '没在通话中不能 ready');
  assert.equal(out.results['douyin.publish'].ready, true);
  // 每个 check 都带原始 detail，页面直接显示证据
  assert.match(out.results['wechat.call'].checks[0].detail, /没启动/u);
  assert.deepEqual(PROBE_ACTIONS.sort(), ['douyin.publish', 'douyin.publish_draft', 'douyin.publish_video', 'qq.call', 'qq.call_mom', 'qq.hangup', 'wechat.call']);
  // 手机类动作单独一组：不算「授权项」，但要能答「这台手机现在能不能跑」
  assert.equal(out.results['douyin.reply_comments']?.group, 'device', '手机类动作要单独成组，别混进授权项');
  const { ALL_PROBE_ACTIONS, groupOf } = await import('../connect/live/preflight.mjs');
  assert.ok(ALL_PROBE_ACTIONS.length > PROBE_ACTIONS.length);
  assert.equal(groupOf('douyin.reply_comments'), 'device');
  assert.equal(groupOf('qq.call'), 'authorized');
});

test('发布类工具写了分步流程，页面上能看清「草稿→二审→发布」', async () => {
  const { TOOL_META } = await import('../connect/live/tool-meta.mjs');
  for (const action of ['douyin.publish', 'douyin.publish_draft']) {
    const steps = TOOL_META[action]?.steps;
    assert.ok(Array.isArray(steps) && steps.length >= 3, `${action} 缺少分步流程`);
    assert.ok(steps.some((step) => /草稿/u.test(step)), `${action} 的流程里要提到草稿`);
    assert.ok(steps.some((step) => /二审|同意/u.test(step)), `${action} 的流程里要提到人工二审`);
  }
});

test('顶栏「授权项就绪」点开能列全 7 项，缺什么写清楚', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../connect/live/live.js', import.meta.url), 'utf8');
  assert.match(source, /function openReady\(/u, '要有可点开的就绪清单');
  assert.match(source, /readyPill'\)\.addEventListener\('click'/u, '角标要能点');
  assert.match(source, /缺：\$\{check\.detail\}/u, '缺的条件要写在页面上，不能只说「不可用」');
  assert.match(source, /state\.preflight = data\?\.results/u, '核验结果要存下来复用，别每次点都重跑探针');
});

test('核验一次会留下事件，且同一 10 分钟内不重复刷', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const { startConnect } = await import('../connect/server.mjs');
  const { initAgentEvents, listAgentEvents } = await import('../connect/agent-events.mjs');

  const root = mkdtempSync(join(tmpdir(), 'preflight-event-'));
  const app = await startConnect({ root, port: 0, qq: false, config: { adminToken: 'tok', devices: {} } });
  const base = `http://127.0.0.1:${app.port ?? app.server?.address?.().port}`;
  const auth = { headers: { authorization: 'Bearer tok' } };
  try {
    const first = await (await fetch(`${base}/api/live/preflight`, auth)).json();
    assert.ok(Object.keys(first.results ?? {}).length >= 7, '核验要有 7 项结果');
    const db = new DatabaseSync(join(root, 'connect.sqlite'));
    initAgentEvents(db);
    const events = listAgentEvents(db, { limit: 50 }).filter((row) => row.event_type === 'preflight_checked');
    assert.equal(events.length, 1, '一次核验应该记一条事件');
    const payload = JSON.parse(events[0].payload);
    // 事件里只数「授权项」那 7 个（手机类 12 个也核验了，但混进来会显示成 15/16）
    const authorized = Object.values(first.results).filter((entry) => entry.group === 'authorized').length;
    assert.equal(payload.total, authorized, '事件口径应与顶栏「授权项就绪 X/Y」一致');
    assert.ok(Array.isArray(payload.missing), '要写清哪几项没就绪');
    db.close();

    // 再打两次（命中 20s 缓存 + 同一个 10 分钟桶）也不该再记
    await fetch(`${base}/api/live/preflight`, auth);
    await fetch(`${base}/api/live/preflight`, auth);
    const db2 = new DatabaseSync(join(root, 'connect.sqlite'));
    initAgentEvents(db2);
    assert.equal(listAgentEvents(db2, { limit: 50 }).filter((row) => row.event_type === 'preflight_checked').length, 1);
    db2.close();
  } finally {
    await app.close?.();
  }
});

test('定时任务行会标出「这个动作现在能不能跑」', async () => {
  const { annotateRows, readinessOf, readinessText } = await import('../connect/live/readiness.mjs');
  const results = {
    'douyin.publish': { ready: true, checks: [{ key: 'device', ok: true, detail: '1 台在线' }] },
    'qq.hangup': { ready: false, checks: [{ key: 'call', ok: false, detail: '当前没有进行中的通话' }] },
  };
  const rows = annotateRows(
    [{ action: 'douyin.publish' }, { action: 'qq.hangup' }, { action: 'douyin.browse' }],
    results,
  );
  assert.equal(rows[0].readiness.ready, true);
  assert.equal(rows[1].readiness.ready, false);
  assert.match(rows[1].readiness.missing[0], /没有进行中的通话/u);
  assert.equal(rows[2].readiness, null, '没核验过的动作要返回 null，不能假装能跑');
  assert.equal(readinessText(null), '没核验过');
  assert.equal(readinessText(rows[1].readiness), '还不行：当前没有进行中的通话');
  assert.equal(readinessOf('douyin.browse', results), null);

  // 页面确实用了它，而不是自己另写一套
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../connect/live/live.js', import.meta.url), 'utf8');
  assert.match(source, /annotateRows\(slots\.slots, state\.preflight/u, '定时任务必须用统一口径贴状态');
});

test('本周失败能按原因归类，没活干不算「问题」', async () => {
  const { reasonBucket, summarizeFailures } = await import('../connect/live/failures.mjs');
  assert.equal(reasonBucket('nothing_to_do(5):no_content×3')?.id, 'nothing_to_do');
  assert.equal(reasonBucket('blocked:这一小时已发 5 条')?.id, 'blocked');
  assert.equal(reasonBucket('count=0<1')?.id, 'count_short');
  assert.equal(reasonBucket('detail_not_opened:SearchResultActivity')?.id, 'ui_missing');
  assert.equal(reasonBucket('Command failed: node scripts/x.mjs')?.id, 'command_failed');
  assert.equal(reasonBucket('adb 看到 0 台设备')?.id, 'device');
  assert.equal(reasonBucket('ok'), null, '成功不算失败');
  assert.equal(reasonBucket('missing_count')?.id, 'missing_count');
  assert.equal(reasonBucket('unknown_action:weather.get')?.id, 'unknown_action', '只读工具当动作跑不算故障');
  assert.equal(reasonBucket(null)?.id, 'no_reason', '早期没写 reason 要单独标出来，不能混成原因不明');
  assert.equal(reasonBucket('莫名其妙的一句话')?.id, 'unknown', '不认识就老实说原因不明');

  const summary = summarizeFailures([
    { operation: 'douyin.reply_comments', verdict: 'unconfirmed', reason: 'nothing_to_do(5):no_content×5' },
    { operation: 'douyin.reply_comments', verdict: 'mismatched', reason: 'count=0<1' },
    { operation: 'douyin.comment_latest', verdict: 'failed', reason: 'detail_not_opened:SearchResultActivity' },
    { operation: 'douyin.daily_post', verdict: 'failed', reason: 'Command failed: node scripts/douyin-post.mjs' },
    { operation: 'douyin.hotspot', verdict: 'confirmed', reason: 'ok' },
  ]);
  // 「确实没活干」进归类但不算问题总数
  assert.equal(summary.total, 3);
  assert.deepEqual(
    summary.buckets.map((b) => b.id).sort(),
    ['command_failed', 'count_short', 'nothing_to_do', 'ui_missing'],
  );
  // 走错通道不计入「问题总数」
  const wrong = summarizeFailures([{ operation: 'weather.get', verdict: 'failed', reason: 'unknown_action:weather.get' }]);
  assert.equal(wrong.total, 0);
  assert.equal(wrong.buckets[0].id, 'unknown_action');
  const countShort = summary.buckets.find((b) => b.id === 'count_short');
  assert.equal(countShort.count, 1);
  assert.equal(countShort.ops['douyin.reply_comments'], 1);
  // 按次数倒序，最多的在前
  assert.ok(summary.buckets[0].count >= summary.buckets[summary.buckets.length - 1].count);
});

test('评论额度：能读到用量、上限可配置、文件不存在就用默认值', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { loadLimits, quotaOf } = await import('../connect/douyin/compliance.mjs');

  // 默认值
  const def = loadLimits(mkdtempSync(join(tmpdir(), 'limits-empty-')));
  assert.equal(def.source, 'default');
  assert.equal(def.hourlyComments, 5);

  // 配置文件覆盖
  const root = mkdtempSync(join(tmpdir(), 'limits-custom-'));
  mkdirSync(join(root, 'runtime', 'douyin'), { recursive: true });
  writeFileSync(join(root, 'runtime', 'douyin', 'limits.json'), JSON.stringify({ hourlyComments: 12, minIntervalMs: 30_000 }));
  const custom = loadLimits(root);
  assert.equal(custom.hourlyComments, 12);
  assert.equal(custom.minIntervalMs, 30_000);
  assert.match(custom.source, /limits\.json/u);

  const now = 1_800_000_000_000;
  const q = quotaOf([{ at: now - 60_000 }, { at: now - 10 * 60_000 }], { now, limits: custom });
  assert.equal(q.hourlyUsed, 2);
  assert.equal(q.hourlyLeft, 10);
  assert.equal(q.dailyUsed, 2);
  assert.equal(q.waitMs, 0, '间隔已超过 30 秒');

  const fresh = quotaOf([{ at: now - 5_000 }], { now, limits: custom });
  assert.equal(fresh.waitMs, 25_000, '距离下一条还差 25 秒');
});

test('「本周 N 次」里要能把「额度跳过」单列出来', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const { migrateConnect } = await import('../connect/core/migrations.mjs');
  const { initPlans } = await import('../connect/douyin/dayplan.mjs');
  const { toolList } = await import('../connect/live/api.mjs');

  const root = mkdtempSync(join(tmpdir(), 'live-quota-'));
  const db = new DatabaseSync(join(root, 'connect.sqlite'));
  migrateConnect(db, { backupDir: join(root, 'backups') });
  initPlans(db);

  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  db.prepare("INSERT INTO plan_slots (id, day, at_ms, action, args, status, note) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run('slot-q1', day, now - 3600_000, 'douyin.reply_comments', '{}', 'skipped', 'quota_exhausted:5/5');
  db.prepare("INSERT INTO plan_slots (id, day, at_ms, action, args, status, note) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run('slot-q2', day, now - 7200_000, 'douyin.reply_comments', '{}', 'skipped', 'quota_exhausted:5/5');

  const list = toolList(db, now);
  const reply = list.items.find((item) => item.action === 'douyin.reply_comments');
  assert.equal(reply.weekQuotaSkips, 2, '两次额度跳过要数出来');

  // 页面渲染也要把两者分开说
  const { readFileSync } = await import('node:fs');
  const ui = readFileSync(new URL('../connect/live/live.js', import.meta.url), 'utf8');
  assert.match(ui, /额度跳过/u, '卡片上要写「额度跳过 N 次」');
});

test('定时槽的「为什么跳过」要说人话，而不是让人读 note 原文', async () => {
  const { readFileSync } = await import('node:fs');
  const ui = readFileSync(new URL('../connect/live/live.js', import.meta.url), 'utf8');
  // 四种最常见的跳过原因都要有短标签
  for (const label of ['额度用完', '已有待审草稿', '已人工跑过', '抖动后重试']) {
    assert.ok(ui.includes(label), `缺「${label}」这个短标签`);
  }
  assert.match(ui, /function skipReason/u);
  assert.match(ui, /quota_exhausted/u);
});

test('四处（工具卡 / 定时行 / 首页 / 数据流）用同一套判定词汇', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const vocab = read('../connect/live/reason-text.mjs');
  const live = read('../connect/live/live.js');
  const home = read('../connect/home/home.js');
  const flow = read('../connect/flow/flow.js');

  // 词汇表只有一份，其余三处都从它取
  for (const [name, text] of [['live', live], ['home', home], ['flow', flow]]) {
    assert.match(text, /from '\/live\/reason-text\.mjs'|from '\.\/reason-text\.mjs'/u, `${name} 应该 import 共享词汇表`);
    assert.doesNotMatch(text, /const VERDICT_LABEL = \{/u, `${name} 不该再自己定义一份判定标签`);
  }
  // 关键说法必须一致
  for (const label of ['已确认', '未确认', '对不上', '没活干']) {
    assert.ok(vocab.includes(label), `词汇表缺「${label}」`);
  }
  assert.match(vocab, /quota_exhausted/u);
  assert.match(vocab, /function reasonText/u);
});

test('授权项核验事件要显示「6/7 就绪（缺 xx）」，不是键名', async () => {
  const { digestOf } = await import('../connect/live/catalog.mjs');
  assert.equal(digestOf({ ready: 6, total: 7, missing: ['qq.hangup'] }), '6/7 就绪（缺 qq.hangup）');
  assert.equal(digestOf({ ready: 7, total: 7, missing: [] }), '7/7 就绪');
});

test('放行清单覆盖 7 个真实副作用动作：每个都有命令、预期与收尾', async () => {
  const { readFileSync } = await import('node:fs');
  const doc = readFileSync(new URL('../docs/TOOL-RUNBOOK.md', import.meta.url), 'utf8');
  const pending = ['qq.call', 'qq.call_mom', 'wechat.call', 'qq.hangup', 'douyin.publish', 'douyin.publish_draft', 'douyin.publish_video'];

  assert.match(doc, /## 放行清单：7 个「真实副作用」动作/u);
  for (const action of pending) {
    const heading = new RegExp(`### \\d+\\. \`${action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\``, 'u');
    assert.match(doc, heading, `放行清单缺 ${action} 的小节`);
  }
  // 每个小节里都要有「跑什么」「见到什么算成功」「出事怎么收」
  const section = doc.split('## 放行清单')[1] ?? '';
  assert.ok((section.match(/```bash/gu) ?? []).length >= 7, '七个动作都要给可复制的命令');
  assert.ok((section.match(/预期/gu) ?? []).length >= 7, '七个动作都要写预期');
  assert.ok((section.match(/出事怎么收/g) ?? []).length >= 4, '有副作用的都要写怎么收尾');
});

test('工具详情要能给出「自己手动跑」的命令', async () => {
  const { TOOL_META } = await import('../connect/live/tool-meta.mjs');
  const entries = Object.entries(TOOL_META);
  assert.ok(entries.length >= 15, '动作说明书少于 15 条');
  for (const [action, meta] of entries) {
    assert.match(meta.command ?? '', /^node (scripts|connect)\//u, `${action} 缺可执行命令`);
  }
  // 7 个有副作用的动作必须给出「带参数」的命令，而不是裸脚本
  for (const action of ['qq.call', 'qq.call_mom', 'wechat.call', 'douyin.publish_video']) {
    assert.match(TOOL_META[action].command, /--/u, `${action} 的命令要带参数`);
  }
  const { readFileSync } = await import('node:fs');
  const ui = readFileSync(new URL('../connect/live/live.js', import.meta.url), 'utf8');
  assert.match(ui, /想自己手动跑/u, '详情里要有这一段');
  assert.match(ui, /navigator\.clipboard/u, '命令要能点一下复制');
});

test('手动跑完之后能在详情里刷新「最近一次」，不用整页重载', async () => {
  const { readFileSync } = await import('node:fs');
  const ui = readFileSync(new URL('../connect/live/live.js', import.meta.url), 'utf8');
  assert.match(ui, /function refreshTool/u, '要有只刷新这一条的函数');
  assert.match(ui, /刷新「最近一次」/u, '详情里要有刷新按钮');
  assert.match(ui, /api\('\/api\/live\/tools'\)/u, '刷新要走工具清单接口（拿最新判定）');
  // 刷新只重开详情，不许 reload 整页
  const fn = ui.slice(ui.indexOf('async function refreshTool'), ui.indexOf('function openTool(item)'));
  assert.doesNotMatch(fn, /location\.reload/u, '刷新不该整页重载');
});

test('「本轮报告」只把「有副作用、还没跑过」的算进待办，只读工具不算', async () => {
  const { readFileSync } = await import('node:fs');
  const ui = readFileSync(new URL('../connect/live/live.js', import.meta.url), 'utf8');
  assert.match(ui, /'report'/u, '页签里要有 report');
  assert.match(ui, /function renderReport/u);
  assert.match(ui, /!item\.readOnly/u, '只读工具不该算进「没跑过」');

  const { DatabaseSync } = await import('node:sqlite');
  const { toolList } = await import('../connect/live/api.mjs');
  const db = new DatabaseSync('runtime/connect/connect.sqlite');
  const list = toolList(db, Date.now());
  const readOnly = list.items.filter((item) => item.readOnly);
  assert.ok(readOnly.length >= 5, '只读工具应标 readOnly');
  const untested = list.items.filter((item) => !item.lastVerdict && !item.readOnly);
  assert.ok(!untested.some((item) => item.readOnly), '待办里不该出现只读工具');
  db.close();
});

test('runbook 里的「当前进度」块是生成的、可复算的，而且不包含只读工具', async () => {
  const { readFileSync } = await import('node:fs');
  const doc = readFileSync(new URL('../docs/TOOL-RUNBOOK.md', import.meta.url), 'utf8');
  assert.match(doc, /<!-- progress:start -->/u);
  assert.match(doc, /<!-- progress:end -->/u);
  const block = doc.slice(doc.indexOf('<!-- progress:start -->'), doc.indexOf('<!-- progress:end -->'));
  assert.match(block, /覆盖度：\*\*\d+\/\d+ 已确认\*\*/u, '要写清 X/Y 已确认');
  assert.match(block, /node scripts\/runbook-progress\.mjs/u, '要给出重新生成的命令');
  // 只读工具不进口径
  for (const tool of ['weather.get', 'works.list', 'capability.read', 'device.page']) {
    assert.ok(!block.includes(`\`${tool}\``), `${tool} 是只读工具，不该出现在进度表里`);
  }
  // 7 个待跑的动作总得在表里（要么没跑过，要么有判定）
  for (const action of ['qq.call', 'douyin.publish', 'douyin.publish_video']) {
    assert.ok(block.includes(`\`${action}\``), `进度表缺 ${action}`);
  }
});

test('已下线的动作留档，并在工具清单底部列出来（不许悄悄消失）', async () => {
  const { RETIRED_ACTIONS, retiredOf } = await import('../connect/live/retired.mjs');
  assert.ok(RETIRED_ACTIONS.length >= 3, '至少记录三个已下线的动作');
  for (const entry of RETIRED_ACTIONS) {
    assert.match(entry.action, /^[a-z][a-z0-9_.]+$/u, `${entry.action} 名字不像动作`);
    assert.ok(entry.label?.length >= 4, `${entry.action} 缺中文名`);
    assert.match(entry.retiredAt, /^\d{4}-\d{2}-\d{2}$/u, `${entry.action} 缺下线日期`);
    assert.ok(entry.reason?.length >= 12, `${entry.action} 的下线原因太笼统`);
  }
  // 下线的动作不许还留在动作表 / 说明书里（否则就是「下线了但菜单还在」）
  const { ACTIONS } = await import('../connect/actions.mjs');
  const { TOOL_META } = await import('../connect/live/tool-meta.mjs');
  for (const entry of RETIRED_ACTIONS) {
    assert.equal(ACTIONS[entry.action], undefined, `${entry.action} 已下线却还在 ACTIONS 里`);
    assert.equal(TOOL_META[entry.action], undefined, `${entry.action} 已下线却还有说明书`);
  }
  assert.equal(retiredOf('douyin.hotspot')?.action, 'douyin.hotspot');
  assert.equal(retiredOf('douyin.publish'), null, '在用的动作不该被当成已下线');

  // 接口要带出来，页面要有地方渲染
  const { readFileSync } = await import('node:fs');
  const api = readFileSync(new URL('../connect/live/api.mjs', import.meta.url), 'utf8');
  assert.match(api, /retired: RETIRED_ACTIONS/u, '工具清单接口要带 retired');
  const ui = readFileSync(new URL('../connect/live/live.js', import.meta.url), 'utf8');
  assert.match(ui, /renderRetired/u, '页面要渲染已下线一行');
  assert.match(ui, /已下线/u);
});

test('工具详情按「原因类别」分组：同类合并计数、成功不进组、长 reason 只留样本', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const { migrateConnect } = await import('../connect/core/migrations.mjs');
  const { initTasks } = await import('../connect/tasks.mjs');
  const { recordAgentEvent } = await import('../connect/agent-events.mjs');
  const { recordCheckpoint, initCheckpoints } = await import('../connect/core/checkpoints.mjs');
  const { toolList } = await import('../connect/live/api.mjs');

  const root = mkdtempSync(join(tmpdir(), 'live-reasons-'));
  const db = new DatabaseSync(join(root, 'connect.sqlite'));
  migrateConnect(db);
  initTasks(db);
  initCheckpoints(db);
  recordAgentEvent(db, { eventType: 'message_received', channel: 'qq', conversationId: 'c', payload: {} });

  const now = Date.now();
  // 三条同类（只成 0 条）、两条「没活干」、一条成功（不该进组）
  for (const [index, reason] of ['count=0<1', 'count=0<1', 'count=0<1', 'nothing_to_do', 'nothing_to_do'].entries()) {
    recordCheckpoint(db, { taskId: `t${index}`, operation: 'douyin.reply_comments', verdict: 'unconfirmed', reason, ok: false, now: now - index * 1000 });
  }
  recordCheckpoint(db, { taskId: 'ok1', operation: 'douyin.reply_comments', verdict: 'confirmed', reason: 'ok', ok: true, now });
  recordCheckpoint(db, { taskId: 'long', operation: 'douyin.comment_latest', verdict: 'failed', reason: `Command failed: ${'x'.repeat(300)}`, ok: false, now });

  const list = toolList(db, now);
  const reply = list.items.find((item) => item.action === 'douyin.reply_comments');
  assert.ok(reply.reasons.length >= 2, '同类要合并成一条，异类分开');
  const short = reply.reasons.find((entry) => entry.id === 'count_short');
  assert.equal(short.count, 3);
  assert.ok(!reply.reasons.some((entry) => entry.id === 'no_reason' && entry.count > 0 && entry.sample === 'ok'), '成功不该进分组');

  const comment = list.items.find((item) => item.action === 'douyin.comment_latest');
  assert.ok(comment.reasons.length >= 1);
  assert.ok((comment.reasons[0].sample ?? '').length <= 70, '长 reason 只留样本，不上整段');
  db.close();
});

test('近 5 周趋势：每周一个点、成功与未成功分开算、跳过的不进趋势', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const { migrateConnect } = await import('../connect/core/migrations.mjs');
  const { initTasks } = await import('../connect/tasks.mjs');
  const { recordAgentEvent } = await import('../connect/agent-events.mjs');
  const { recordCheckpoint, initCheckpoints } = await import('../connect/core/checkpoints.mjs');
  const { toolList } = await import('../connect/live/api.mjs');

  const root = mkdtempSync(join(tmpdir(), 'live-trend-'));
  const db = new DatabaseSync(join(root, 'connect.sqlite'));
  migrateConnect(db);
  initTasks(db);
  initCheckpoints(db);
  recordAgentEvent(db, { eventType: 'message_received', channel: 'qq', conversationId: 'c', payload: {} });

  const WEEK = 7 * 24 * 3600_000;
  const now = Date.now();
  const put = (weeksAgo, verdict, index) => recordCheckpoint(db, {
    taskId: `t-${weeksAgo}-${verdict}-${index}`, operation: 'douyin.reply_comments',
    verdict, reason: verdict === 'confirmed' ? 'ok' : 'count=0<1', ok: verdict === 'confirmed',
    now: now - weeksAgo * WEEK - index * 1000,
  });
  put(0, 'confirmed', 0); put(0, 'confirmed', 1); put(0, 'unconfirmed', 2);
  put(2, 'unconfirmed', 0);
  put(0, 'skipped', 0); // 跳过的不该进趋势

  const list = toolList(db, now);
  const reply = list.items.find((item) => item.action === 'douyin.reply_comments');
  assert.equal(reply.trend.length, 5, '固定 5 个点（周）');
  assert.deepEqual(reply.trend.map((point) => point.weeksAgo), [4, 3, 2, 1, 0], '按左旧右新排序');
  const thisWeek = reply.trend.find((point) => point.weeksAgo === 0);
  assert.deepEqual({ ok: thisWeek.ok, bad: thisWeek.bad }, { ok: 2, bad: 1 }, '跳过的不算');
  const twoWeeksAgo = reply.trend.find((point) => point.weeksAgo === 2);
  assert.deepEqual({ ok: twoWeeksAgo.ok, bad: twoWeeksAgo.bad }, { ok: 0, bad: 1 });
  db.close();
});

test('快照里带「现在有哪些临时放行」，且放行事件进闸门阶段', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const { migrateConnect } = await import('../connect/core/migrations.mjs');
  const { initTasks } = await import('../connect/tasks.mjs');
  const { recordAgentEvent } = await import('../connect/agent-events.mjs');
  const { stageForEvent } = await import('../connect/live/catalog.mjs');

  const root = mkdtempSync(join(tmpdir(), 'live-grant-'));
  const db = new DatabaseSync(join(root, 'connect.sqlite'));
  migrateConnect(db);
  initTasks(db);
  recordAgentEvent(db, { eventType: 'message_received', channel: 'qq', conversationId: 'c', payload: {} });

  const now = Date.now();
  mkdirSync(join(root, 'runtime', 'connect'), { recursive: true });
  writeFileSync(join(root, 'runtime', 'connect', 'live-run.json'), JSON.stringify({
    allowed: ['weather.get'],
    grants: [
      { action: 'works.list', until: now + 10 * 60_000 },
      { action: 'comments.list', until: now - 60_000 }, // 已过期，不该出现
    ],
  }));

  const prev = process.cwd();
  process.chdir(root);
  try {
    const { liveSnapshot } = await import('../connect/live/api.mjs');
    const snapshot = liveSnapshot(db, now);
    assert.equal(snapshot.grantInfo.count, 1, '过期的不算');
    assert.equal(snapshot.grantInfo.items[0].action, 'works.list');
    assert.deepEqual(snapshot.grantInfo.permanent, ['weather.get']);
  } finally {
    process.chdir(prev);
    db.close();
  }

  assert.deepEqual(stageForEvent({ eventType: 'run_granted' }), { stage: 'gate', state: 'wait' }, '放行事件要落在闸门段');
});

test('报告页要写清「放行前必须知道的三件事」', async () => {
  const { readFileSync } = await import('node:fs');
  const ui = readFileSync(new URL('../connect/live/live.js', import.meta.url), 'utf8');
  assert.match(ui, /放行前必须知道的三件事/u);
  assert.match(ui, /会用到：/u, '要说清会用到什么');
  assert.match(ui, /影响：/u, '要说清影响');
  assert.match(ui, /从来没有跑过/u, '第一次跑要直说');
  // 只读工具不该出现在这张卡里
  assert.match(ui, /!item\.readOnly && !item\.lastVerdict && Boolean\(item\.impact\)/u, '有真实副作用的才算待放行');
});

test('报告页默认只展开「下一步」和「覆盖度」，其余折起来', async () => {
  const { readFileSync } = await import('node:fs');
  const ui = readFileSync(new URL('../connect/live/live.js', import.meta.url), 'utf8');
  assert.match(ui, /el\('details'/u, '卡片应该是 details');
  assert.match(ui, /repCardHead/u, '标题要放在 summary 里');
  // 两张必须默认展开
  assert.match(ui, /card\('下一步该干什么'[^;]*\{ open: true \}/u);
  assert.match(ui, /card\('跑通覆盖度', \[body\], null, \{ open: true \}\)/u);
  // 长卡片必须折着
  assert.match(ui, /card\('放行前必须知道的三件事', \[list\], '[^']*'\)\)/u, '放行前须知应默认收起');
  assert.match(ui, /card\('放行当天按这个顺序', \[rows\]/u);
});

test('事件流只加载一批，但要告诉人「还有多少更早的」并能往前翻', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const { migrateConnect } = await import('../connect/core/migrations.mjs');
  const { initTasks } = await import('../connect/tasks.mjs');
  const { recordAgentEvent } = await import('../connect/agent-events.mjs');
  const { liveSnapshot, earlierEvents } = await import('../connect/live/api.mjs');

  const root = mkdtempSync(join(tmpdir(), 'live-more-'));
  const db = new DatabaseSync(join(root, 'connect.sqlite'));
  migrateConnect(db);
  initTasks(db);
  for (let i = 0; i < 40; i += 1) {
    recordAgentEvent(db, { eventType: 'message_received', channel: 'qq', conversationId: `c${i}`, payload: { preview: `第 ${i} 条` } });
  }
  const snapshot = liveSnapshot(db, Date.now());
  assert.equal(snapshot.recent.length, 26);
  assert.equal(snapshot.earlierCount, 14, '40 - 26');

  assert.ok(snapshot.oldestRowid > 0, '要用 rowid 当游标（id 是 event_xxx 字符串，比大小没意义）');
  const older = earlierEvents(db, { beforeRowid: snapshot.oldestRowid, limit: 50 });
  assert.equal(older.length, 14);
  assert.ok(older.at(-1).rowid < snapshot.oldestRowid, '翻出来的必须更早');
  db.close();
});

test('页面手动跑的判定记录要标出来，不和定时任务的账混在一起', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const { migrateConnect } = await import('../connect/core/migrations.mjs');
  const { initTasks } = await import('../connect/tasks.mjs');
  const { recordCheckpoint } = await import('../connect/core/checkpoints.mjs');
  const { toolList } = await import('../connect/live/api.mjs');

  const root = mkdtempSync(join(tmpdir(), 'live-origin-'));
  const db = new DatabaseSync(join(root, 'connect.sqlite'));
  migrateConnect(db);
  initTasks(db);
  recordCheckpoint(db, { taskId: 'ui-run-1794938921292', stage: 'execute', stepKey: 'ui:weather.get', stepIndex: 0, operation: 'weather.get', input: {}, output: { ok: true }, verdict: 'confirmed', reason: 'ok_text', ok: true });
  recordCheckpoint(db, { taskId: 'task-slot-1', stage: 'execute', stepKey: 'slot:1', stepIndex: 0, operation: 'weather.get', input: {}, output: { ok: true }, verdict: 'confirmed', reason: 'ok_text', ok: true });

  const list = toolList(db, Date.now());
  const item = list.items.find((entry) => entry.action === 'weather.get');
  const origins = (item.history ?? []).map((entry) => entry.origin).sort();
  assert.deepEqual(origins, ['task', 'ui']);
  db.close();
});

test('realOnly：只看真实业务时，页面上手动跑的记录不进账', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const { migrateConnect } = await import('../connect/core/migrations.mjs');
  const { initTasks } = await import('../connect/tasks.mjs');
  const { recordCheckpoint } = await import('../connect/core/checkpoints.mjs');
  const { toolList } = await import('../connect/live/api.mjs');

  const root = mkdtempSync(join(tmpdir(), 'live-real-'));
  const db = new DatabaseSync(join(root, 'connect.sqlite'));
  migrateConnect(db);
  initTasks(db);
  const base = { stage: 'execute', stepKey: 'k', stepIndex: 0, operation: 'weather.get', input: {}, output: { ok: true }, verdict: 'confirmed', reason: 'ok_text', ok: true };
  for (let i = 0; i < 5; i += 1) recordCheckpoint(db, { ...base, taskId: `ui-run-17949389212${i}` });
  recordCheckpoint(db, { ...base, taskId: 'task-slot-1' });

  const all = toolList(db, Date.now());
  const real = toolList(db, Date.now(), { realOnly: true });
  const pick = (list) => list.items.find((entry) => entry.action === 'weather.get');
  assert.equal(pick(all).weekRuns, 6);
  assert.equal(pick(real).weekRuns, 1, '手动跑的 5 次要被排掉');
  assert.equal(pick(real).history.length, 1);
  assert.equal(pick(real).history[0].origin, 'task');
  db.close();
});
