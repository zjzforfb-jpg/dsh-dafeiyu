// M1：九段流水线唯一真源 + 情景记忆检索。
//
// 这两块一起解决「页面写着九段、代码里是六段 if-return、三份描述慢慢打架」和
// 「几百条历史轨迹只给看板看、planner 一次都没见过」。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { PIPELINE, PIPELINE_IDS, stageById, stageOfEvent, validatePipeline } from '../connect/core/pipeline.mjs';
import { STAGES, STAGE_IDS, EVENT_ROUTE } from '../connect/live/catalog.mjs';
import { PIPELINES } from '../connect/home/data.mjs';
import { similarTraces, tracesText, operationHints } from '../connect/core/traces.mjs';
import { initAgentEvents } from '../connect/agent-events.mjs';

test('九段流水线：自检干净、每段都有事件、和页面/看板用的是同一份', () => {
  assert.deepEqual(validatePipeline(), []);
  assert.equal(PIPELINE.length, 9);
  assert.deepEqual(PIPELINE_IDS, STAGE_IDS, '流水线与 /live 的阶段 id 必须一一对应');
  assert.deepEqual(PIPELINES.map((row) => row.id), PIPELINE_IDS, '主页的九步带必须来自同一份定义');
  for (const stage of PIPELINE) {
    assert.ok(stage.events.length >= 1, `${stage.id} 没有任何埋点事件，页面上会一直显示「未埋点」`);
    assert.ok(stage.files.length >= 1, `${stage.id} 没写代码位置`);
    assert.equal(stageById(stage.id).label, STAGES.find((row) => row.id === stage.id).label);
  }
  // 反向：/live 认识的事件都得有人认领，否则就是「页面会亮、代码里没有」
  for (const eventType of Object.keys(EVENT_ROUTE)) {
    assert.ok(stageOfEvent(eventType), `事件 ${eventType} 没有归属阶段`);
  }
  // 路由这一段现在真的在跑了
  assert.equal(stageOfEvent('route_decision'), 'route');
  assert.equal(EVENT_ROUTE.route_decision.stage, 'route');
});

test('情景记忆检索：按动作筛同类任务、只给结论、不搬正文', () => {
  const db = new DatabaseSync(':memory:');
  initAgentEvents(db);
  const insert = (id, type, taskId, payload, at) => db.prepare(
    'INSERT INTO agent_events(id, event_type, channel, task_id, actor, payload, created_at) VALUES(?,?,?,?,?,?,?)',
  ).run(id, type, 'qq', taskId, 'test', JSON.stringify(payload), at);

  const now = Date.parse('2026-11-17T00:00:00.000Z');
  insert('e1', 'task_reported', 'task-publish-1', { operations: ['douyin.publish'], status: 'failed', detail: '标题没填上' }, '2026-11-16T20:00:00.000Z');
  insert('e2', 'task_reported', 'task-call-1', { operations: ['qq.call'], status: 'succeeded', detail: '通话 00:57' }, '2026-11-16T21:00:00.000Z');
  insert('e3', 'action_failed', 'task-publish-2', { operation: 'douyin.publish', error: 'publish_unconfirmed' }, '2026-11-16T22:00:00.000Z');

  const publish = similarTraces(db, { operations: ['douyin.publish'], limit: 3, now });
  assert.equal(publish.length, 2);
  assert.ok(publish.every((row) => row.taskId.startsWith('task-publish')), '不该把打电话的任务混进来');
  assert.ok(publish[0].summary.length < 160, '摘要要短，别把正文搬进 prompt');

  const call = similarTraces(db, { operations: ['qq.call'], limit: 3, now });
  assert.equal(call.length, 1);
  assert.equal(call[0].taskId, 'task-call-1');

  // 不筛动作时给最近的几条
  assert.ok(similarTraces(db, { limit: 2, now }).length <= 2);
  // 超出回溯窗口就没有了
  assert.equal(similarTraces(db, { operations: ['douyin.publish'], now: now + 40 * 24 * 3600 * 1000 }).length, 0);

  const text = tracesText(publish);
  assert.match(text, /douyin\.publish/u);
  assert.equal(text.split('\n').length <= 3, true);
  assert.equal(tracesText([]), '');
});

test('从一句话猜动作：发布/评论/电话/热点都能命中', () => {
  assert.deepEqual(operationHints('再发一条图文'), ['douyin.publish']);
  assert.ok(operationHints('把收到的评论回一下').includes('douyin.reply_comments'));
  assert.ok(operationHints('给爸爸打个电话').includes('qq.call'));
  assert.ok(operationHints('看看今天有什么热点').includes('douyin.hotspot'));
  assert.deepEqual(operationHints('今天天气怎么样'), []);
});
