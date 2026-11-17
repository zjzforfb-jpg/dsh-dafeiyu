import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createGoalTask, initTasks } from '../connect/tasks.mjs';
import { enqueueTask, goalsWithTasks, goalTaskHistory, linkGoalTask, taskList } from '../life/tasks.mjs';
import { openLife } from '../life/manager.mjs';

const DAY = '2026-11-16';

function brainDb() {
  // openMemory 会把 dirname 收成 0700，所以必须给它一个专属子目录。
  const home = mkdtempSync(join(tmpdir(), 'dafeiyu-goals-'));
  const db = openLife(home);
  return { db, home, cleanup: () => { try { db.close(); } catch { /* 已关就算了。 */ } rmSync(home, { recursive: true, force: true }); } };
}

function connectDb() {
  const db = new DatabaseSync(':memory:');
  initTasks(db);
  return db;
}

test('D-1 目标推进登记的 task_id 就是统一 AgentTask 的 id', () => {
  const { db, cleanup } = brainDb();
  try {
    const goal = db.prepare("SELECT id FROM goals WHERE status = 'active' ORDER BY created_at ASC LIMIT 1").get();
    assert.ok(goal, '初始化后应有种子长期目标');
    const row = linkGoalTask(db, { goalId: goal.id, taskId: 'task_goal_abc', day: DAY, summary: '推进了一轮', nextStep: '下一步' });
    assert.equal(row.task_id, 'task_goal_abc');
    const saved = db.prepare('SELECT task_id, summary, next_step FROM goal_progress WHERE goal_id = ? AND day = ?').get(goal.id, DAY);
    assert.equal(saved.task_id, 'task_goal_abc');
    assert.equal(saved.summary, '推进了一轮');
    assert.equal(saved.next_step, '下一步');
  } finally { cleanup(); }
});

test('D-1 同一天同一目标重复推进是更新，不是多出一行', () => {
  const { db, cleanup } = brainDb();
  try {
    linkGoalTask(db, { goalId: 'knowledge', taskId: 'task_1', day: DAY, summary: '第一轮', nextStep: 'A' });
    linkGoalTask(db, { goalId: 'knowledge', taskId: 'task_2', day: DAY, summary: '第二轮', nextStep: 'B' });
    const rows = db.prepare('SELECT COUNT(*) AS n FROM goal_progress WHERE goal_id = ? AND day = ?').get('knowledge', DAY);
    assert.equal(rows.n, 1, 'UNIQUE(goal_id, day) 之下只留一行');
    const row = db.prepare('SELECT task_id, summary, next_step FROM goal_progress WHERE goal_id = ? AND day = ?').get('knowledge', DAY);
    assert.equal(row.task_id, 'task_2', '指向最新的那次推进');
    assert.equal(row.summary, '第二轮');
    assert.equal(row.next_step, 'B');
  } finally { cleanup(); }
});

test('D-1 目标清单带出最近关联的 task', () => {
  const { db, cleanup } = brainDb();
  try {
    linkGoalTask(db, { goalId: 'memory', taskId: 'task_memory_1', day: DAY, summary: '记忆建设', nextStep: '整理' });
    const goals = goalsWithTasks(db, { taskLimit: 5 });
    const memory = goals.find((goal) => goal.id === 'memory');
    assert.ok(memory, '目标清单应含 memory 目标');
    assert.equal(memory.recentTasks.length, 1);
    assert.equal(memory.recentTasks[0].task_id, 'task_memory_1');
    assert.equal(memory.recentTasks[0].summary, '记忆建设');
    const knowledge = goals.find((goal) => goal.id === 'knowledge');
    assert.deepEqual(knowledge.recentTasks, [], '没推进过的目标不带 task');
    const history = goalTaskHistory(db, 'memory', 5);
    assert.equal(history.length, 1);
    assert.equal(history[0].task_id, 'task_memory_1');
  } finally { cleanup(); }
});

test('D-1 目标 → 推进 → 统一 AgentTask 是一条链（goal_progress.task_id 指向 external_tasks.id）', () => {
  const { db, cleanup } = brainDb();
  const connect = connectDb();
  try {
    const task = createGoalTask(connect, { goalId: 'knowledge', day: DAY, goal: '今天把知识体系理一理', result: { question: '从哪开始？' } });
    assert.ok(task?.id, '应登记出统一 AgentTask');
    assert.equal(task.status, 'succeeded');
    assert.equal(task.origin, 'life');
    assert.equal(task.conv_id, 'goal:knowledge');
    const payload = JSON.parse(task.payload);
    assert.equal(payload.goal_id, 'knowledge');
    assert.equal(payload.day, DAY);

    linkGoalTask(db, { goalId: 'knowledge', taskId: task.id, day: DAY, summary: '知识体系推进', nextStep: '整理成表' });
    const progress = db.prepare('SELECT task_id FROM goal_progress WHERE goal_id = ? AND day = ?').get('knowledge', DAY);
    assert.equal(progress.task_id, task.id, '推进记录指向的就是那张统一任务');
    // 链路的另一头：统一任务里也带着目标 id。
    const back = connect.prepare('SELECT payload FROM external_tasks WHERE id = ?').get(progress.task_id);
    assert.equal(JSON.parse(back.payload).goal_id, 'knowledge');
  } finally { connect.close(); cleanup(); }
});

test('D-1 同一天同一目标只登记一次统一任务（幂等）', () => {
  const { db, cleanup } = brainDb();
  const connect = connectDb();
  try {
    const first = createGoalTask(connect, { goalId: 'exploration', day: DAY, goal: '看看外面' });
    const second = createGoalTask(connect, { goalId: 'exploration', day: DAY, goal: '看看外面' });
    assert.equal(first.id, second.id, '同一个目标同一天拿到同一个任务 id');
    const count = connect.prepare('SELECT COUNT(*) AS n FROM external_tasks WHERE idempotency_key = ?').get(`life:goal:exploration:${DAY}`);
    assert.equal(count.n, 1);
    // 换一天就是新的推进。
    const nextDay = createGoalTask(connect, { goalId: 'exploration', day: '2026-11-17', goal: '看看外面' });
    assert.notEqual(nextDay.id, first.id);
  } finally { connect.close(); cleanup(); }
});

test('D-1 日常任务入队时带上 goal 与统一 AgentTask 的对应关系', () => {
  const { db, cleanup } = brainDb();
  const connect = connectDb();
  try {
    const task = createGoalTask(connect, { goalId: 'memory', day: DAY, goal: '记一条' });
    enqueueTask(db, {
      idempotencyKey: 'life:explore:memory:2026-11-16',
      origin: 'life', kind: 'explore', title: '探索记忆',
      goalId: 'memory', agentTaskId: task.id,
      payload: { question: '记一条' },
    });
    const saved = taskList(db, 10).find((row) => row.idempotency_key === 'life:explore:memory:2026-11-16');
    assert.ok(saved, '任务应入队');
    assert.equal(saved.goal_id, 'memory');
    const payload = JSON.parse(db.prepare('SELECT payload FROM tasks WHERE idempotency_key = ?').get('life:explore:memory:2026-11-16').payload);
    assert.equal(payload.agentTaskId, task.id, 'payload 里带统一 AgentTask id');
    // 同幂等键再入队一次不重复。
    enqueueTask(db, { idempotencyKey: 'life:explore:memory:2026-11-16', origin: 'life', kind: 'explore', title: '探索记忆', goalId: 'memory' });
    assert.equal(taskList(db, 10).filter((row) => row.idempotency_key === 'life:explore:memory:2026-11-16').length, 1);
  } finally { connect.close(); cleanup(); }
});
