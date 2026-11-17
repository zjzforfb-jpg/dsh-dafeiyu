import assert from 'node:assert/strict';
import test from 'node:test';
import { renderEvidence } from '../connect/live/evidence.mjs';

test('证据包把回执、判定、核对、事件四样都写全了', () => {
  const md = renderEvidence({
    action: 'qq.call',
    at: Date.UTC(2026, 10, 18, 4, 0, 0),
    title: '给爸爸打电话',
    verdict: 'unconfirmed',
    reason: 'no-answer',
    elapsedMs: 41300,
    text: '拨出去了，30 秒没人接',
    after: { verdict: 'unconfirmed', reason: 'no_answer', checks: [{ key: 'call_ended', ok: false, detail: '近 1 小时没有 call_ended（可能没接通）' }] },
    events: [{ clock: '12:00:01', eventType: 'action_finished', summary: 'operation=qq.call · status=accepted' }],
    origin: 'ui',
  });
  assert.match(md, /给爸爸打电话（qq\.call）/u);
  assert.match(md, /页面手动跑/u);
  assert.match(md, /判定：\*\*unconfirmed\*\*（no-answer）/u);
  assert.match(md, /跑完之后核对/u);
  assert.match(md, /❌ call_ended/u);
  assert.match(md, /库里留下的事件（1 条）/u);
  assert.match(md, /41300 ms/u);
});

test('超长文本会截断并标出原长度，不把几百行日志塞进证据', () => {
  const md = renderEvidence({ action: 'douyin.draft', text: 'x'.repeat(3000), verdict: 'confirmed', elapsedMs: 1 });
  assert.match(md, /共 3000 字/u);
  assert.ok(md.length < 2000);
});

test('证据接口按 task 汇总：页面上跑的那次能导出 Markdown', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const { migrateConnect } = await import('../connect/core/migrations.mjs');
  const { initTasks } = await import('../connect/tasks.mjs');
  const { recordCheckpoint } = await import('../connect/core/checkpoints.mjs');
  const { startConnect } = await import('../connect/server.mjs');
  const { recordAgentEvent } = await import('../connect/agent-events.mjs');

  const root = mkdtempSync(join(tmpdir(), 'live-evidence-'));
  const db = new DatabaseSync(join(root, 'connect.sqlite'));
  migrateConnect(db);
  initTasks(db);
  recordCheckpoint(db, {
    taskId: 'ui-run-1794940710605', stage: 'execute', stepKey: 'ui:weather.get', stepIndex: 0,
    operation: 'weather.get', input: {}, output: { text: '石家庄 Clear 6°C' }, verdict: 'confirmed', reason: 'ok_text', ok: true,
  });
  recordAgentEvent(db, { eventType: 'action_finished', channel: 'system', actor: 'live-ui', taskId: 'ui-run-1794940710605', payload: { operation: 'weather.get', status: 'confirmed' } });
  db.close();

  const server = await startConnect({ root, port: 0, qq: false, config: { adminToken: 'tok', devices: {} } });
  try {
    const url = `http://127.0.0.1:${server.port}/api/live/evidence?id=ui-run-1794940710605`;
    assert.equal((await fetch(url)).status, 401, '没有令牌不许导出');
    const res = await fetch(url, { headers: { authorization: 'Bearer tok' } });
    const payload = await res.json();
    assert.equal(res.status, 200);
    assert.match(payload.markdown, /weather\.get/u);
    assert.match(payload.markdown, /页面手动跑/u);
    assert.equal(payload.verdict, 'confirmed');
    assert.equal((await fetch('http://127.0.0.1:' + server.port + '/api/live/evidence?id=task_nope', { headers: { authorization: 'Bearer tok' } })).status, 404);
  } finally {
    await server.close();
  }
});
