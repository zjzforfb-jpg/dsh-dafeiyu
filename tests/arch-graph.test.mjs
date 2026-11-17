// 架构可视化（GET /arch + /api/arch/stream）的回归：
// 图数据自洽、事件类型都能落成一条真实存在的路径、静态资源只放行白名单、
// SSE 只推元数据（payload 正文不许外泄）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startConnect } from '../connect/server.mjs';
import { recordAgentEvent } from '../connect/agent-events.mjs';
import { CORE, EVENT_STYLE, NODES, PATHS, pathForEvent, validateGraph } from '../connect/arch/graph.mjs';

const ids = new Set([...NODES.map((node) => node.id), CORE.id]);

test('架构图数据自洽：节点/边/路径/配色都能对上', () => {
  assert.deepEqual(validateGraph(), []);
  assert.ok(NODES.length >= 18, '节点太少，架构图会漏层');
  for (const node of NODES) {
    assert.equal(typeof node.hint, 'string');
    assert.ok(node.hint.length > 8, `${node.id} 缺一句话说明`);
    assert.ok(node.facts.length >= 1, `${node.id} 没有 file:line 出处`);
  }
  // 每种事件都要能落到图上；渠道占位符替换成对应节点
  for (const type of Object.keys(EVENT_STYLE)) {
    const spec = pathForEvent({ eventType: type, channel: 'wechat' });
    assert.ok(spec.path.length >= 2, `${type} 路径太短`);
    for (const id of spec.path) assert.ok(ids.has(id), `${type} 路径含未知节点 ${id}`);
    if (PATHS[EVENT_STYLE[type].path][0] === '{channel}') assert.equal(spec.path[0], 'ilink');
    assert.match(spec.color, /^#[0-9a-f]{6}$/u);
  }
  // 一等渠道 call 不能被折叠到 system
  assert.equal(pathForEvent({ eventType: 'message_received', channel: 'call' }).path[0], 'call');
  // 未知事件 / 未知渠道走兜底，不抛错
  const unknown = pathForEvent({ eventType: 'not_a_real_type', channel: 'not_a_channel' });
  assert.equal(unknown.path[0], 'events');
  assert.ok(unknown.path.length >= 2);
  assert.equal(pathForEvent().eventType, 'observation_created');
});

test('/arch 页面与静态资源只放行白名单，SSE 只推事件元数据', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dafeiyu-arch-'));
  const service = await startConnect({ root, port: 0, qq: false, config: { adminToken: 'admin', devices: {} } });
  const base = `http://127.0.0.1:${service.port}`;
  const controller = new AbortController();
  try {
    const page = await fetch(`${base}/arch`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(page.headers.get('cache-control'), 'no-store');
    const html = await page.text();
    assert.match(html, /type="importmap"/u);
    assert.match(html, /src="\/arch\/main\.js"/u);

    const main = await fetch(`${base}/arch/main.js`);
    assert.equal(main.status, 200);
    assert.match(main.headers.get('content-type'), /^text\/javascript/u);
    assert.match(await main.text(), /from '\.\/graph\.mjs'/u);

    assert.equal((await fetch(`${base}/arch/index.html`)).status, 200);
    assert.equal((await fetch(`${base}/arch/vendor/three.module.js`)).status, 200);
    // three.js 必须本地 vendor，页面不依赖外网 CDN
    assert.doesNotMatch(html, /cdn\.jsdelivr|unpkg|cdnjs/u);

    for (const bad of ['/arch/%2e%2e/server.mjs', '/arch/..%2fserver.mjs', '/arch/nope.js', '/arch/vendor/../../server.mjs']) {
      const response = await fetch(base + bad);
      // 目录穿越 URL 会被解析成仓内其它路径，落到后面的 token 闸门（401）或 404 —— 总之不许 200。
      assert.ok([400, 401, 404].includes(response.status), `${bad} 不该被放行（拿到 ${response.status}）`);
      assert.doesNotMatch(await response.text(), /startConnect/u);
    }

    const response = await fetch(`${base}/api/arch/stream`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/u);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const nextMessage = async (match, timeoutMs = 6000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary >= 0) {
          const chunk = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const line = chunk.split('\n').find((item) => item.startsWith('data: '));
          if (!line) continue;
          const data = JSON.parse(line.slice(6));
          if (!match || match(data)) return data;
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('SSE 提前关闭');
        buffer += decoder.decode(value, { stream: true });
      }
      throw new Error('等 SSE 消息超时');
    };

    const hello = await nextMessage((message) => message.type === 'hello');
    assert.equal(typeof hello.totals.tasks, 'number');
    assert.equal(typeof hello.channels, 'object');

    // 真实写一条事件，SSE 应该在两个 tick 内推过来；且只带元数据
    const db = new DatabaseSync(join(root, 'connect.sqlite'));
    recordAgentEvent(db, { eventType: 'action_finished', channel: 'android', taskId: 'task-arch-1', payload: { private_text: '不该出现在页面上' } });
    db.close();
    const event = await nextMessage((message) => message.type === 'event');
    assert.equal(event.event.eventType, 'action_finished');
    assert.equal(event.event.channel, 'android');
    assert.equal(event.event.taskId, 'task-arch-1');
    assert.equal(event.event.payload, undefined, 'SSE 不该把 payload 正文推给页面');
    assert.match(event.event.id, /^event_/u, 'ticker 点开单条事件要能用 id 反查');

    // ── 点 ticker 查任务流程：/api/arch/task ──
    const db2 = new DatabaseSync(join(root, 'connect.sqlite'));
    db2.prepare(`INSERT INTO external_tasks (id, conv_kind, conv_id, intent, payload, status, result, created_ms, updated_ms, origin, attempts)
      VALUES (?, 'c2c', 'peer-1', 'douyin.publish', '{}', 'running', '{}', ?, ?, 'qq', 2)`)
      .run('task-arch-1', 1794700000000, 1794700100000);
    db2.close();
    const detail = await fetch(`${base}/api/arch/task?id=task-arch-1`);
    assert.equal(detail.status, 200);
    const flow = await detail.json();
    assert.equal(flow.task.intent, 'douyin.publish');
    assert.equal(flow.task.status, 'running');
    assert.equal(flow.task.attempts, 2);
    assert.equal(flow.events.length, 1);
    assert.equal(flow.events[0].eventType, 'action_finished');
    // 长正文只给摘要，不整段回吐
    assert.doesNotMatch(JSON.stringify(flow), /不该出现在页面上/u);

    assert.equal((await fetch(`${base}/api/arch/task?id=task_nope`)).status, 404);
    assert.equal((await fetch(`${base}/api/arch/task?id=%20%20`)).status, 400);
    const single = await fetch(`${base}/api/arch/event?id=${encodeURIComponent(event.event.id)}`);
    assert.equal(single.status, 200);
    assert.equal((await single.json()).event.eventType, 'action_finished');

    // 演示脉冲要 token 守卫
    const denied = await fetch(`${base}/api/arch/pulse`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(denied.status, 401);
    const accepted = await fetch(`${base}/api/arch/pulse`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
      body: JSON.stringify({ eventType: 'message_replied', channel: 'call' }),
    });
    assert.equal(accepted.status, 202);
    assert.equal((await accepted.json()).delivered, 1);
    const pulsed = await nextMessage((message) => message.type === 'event' && message.event.eventType === 'message_replied');
    assert.equal(pulsed.event.channel, 'call');
  } finally {
    controller.abort();
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
