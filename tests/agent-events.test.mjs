import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { initAgentEvents, listAgentEvents, recordAgentEvent } from '../connect/agent-events.mjs';
import { approveTask, completeTask, initTasks, proposeTask, startTask } from '../connect/tasks.mjs';
import { listWorkingTasks, recoverWorkingTask, updateWorkingTask, workingTask } from '../connect/working-state.mjs';
import { attachObservation, observeWorkingTask } from '../connect/environment-observer.mjs';

test('统一事件流水支持去重、任务关联和查询', () => {
  const db = new DatabaseSync(':memory:');
  initAgentEvents(db);
  const first = recordAgentEvent(db, { eventType: 'observation_created', channel: 'android', payload: { screen: 'comments' }, dedupeKey: 'obs:1' });
  const duplicate = recordAgentEvent(db, { eventType: 'observation_created', channel: 'android', payload: { screen: 'changed' }, dedupeKey: 'obs:1' });
  assert.equal(first.id, duplicate.id);
  assert.equal(listAgentEvents(db, { eventType: 'observation_created' }).length, 1);
  db.close();
});

test('任务状态变化自动写入统一事件轨迹', () => {
  const db = new DatabaseSync(':memory:');
  initTasks(db);
  const proposed = proposeTask(db, { kind: 'c2c', convId: 'peer-1', sourceMessageId: 'msg-1', proposerPeerId: 'peer-1', intent: { intent: 'douyin.manage_comments', operations: ['douyin.reply_comments'] } });
  assert.equal(approveTask(db, proposed.id, 'owner'), true);
  assert.equal(startTask(db, proposed.id), true);
  completeTask(db, proposed.id, { ok: true, result: { verified: true } });
  const events = listAgentEvents(db, { taskId: proposed.id, limit: 10 });
  assert.ok(events.some((event) => event.event_type === 'action_started'));
  assert.ok(events.some((event) => event.event_type === 'action_finished'));
  db.close();
});

test('工作状态保存当前步骤并在重启恢复前标记未知', () => {
  const db = new DatabaseSync(':memory:');
  initTasks(db);
  const proposed = proposeTask(db, { kind: 'c2c', convId: 'peer-2', sourceMessageId: 'msg-2', intent: { intent: 'douyin.reply_comments', operations: ['douyin.reply_comments'] } });
  assert.equal(updateWorkingTask(db, proposed.id, { status: 'running', currentStep: 'open_comments', selectedSkill: 'douyin.open_comments.v1', nextAction: 'tap_comments' }).current_step, 'open_comments');
  assert.equal(listWorkingTasks(db, { status: 'running' }).length, 1);
  initTasks(db);
  assert.equal(workingTask(db, proposed.id).status, 'unknown');
  assert.equal(recoverWorkingTask(db, proposed.id, { observationId: 'obs-after-restart', environment: { screen: 'comments' } }).status, 'pending');
  assert.equal(workingTask(db, proposed.id).last_observation_id, 'obs-after-restart');
  const observation = observeWorkingTask(db, proposed.id, { sessions: new Map(), now: Date.now() });
  assert.equal(observation.task_id, proposed.id);
  assert.equal(attachObservation(db, proposed.id, observation).last_observation_id, observation.observation_id);
  db.close();
});
