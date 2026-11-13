import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { capture } from '../brain/memory.mjs';
import { localClock, openLife, runLifeJob } from '../life/manager.mjs';

test('北京时间与共同回忆用于当天探索，任务只完成一次', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dafeiyu-life-'));
  const db = openLife(home);
  const prompts = [];
  const bubbles = [];
  try {
    assert.deepEqual(localClock(new Date('2026-11-13T16:05:00Z')), { date: '2026-11-14', time: '00:05' });
    capture(db, '这是我们的回忆：一起给大肥鱼起了名字', '记得啦，爸爸。');
    const goal = db.prepare("SELECT id FROM goals WHERE status = 'active' ORDER BY created_at ASC LIMIT 1").get();
    assert.ok(goal, '初始化后应有种子长期目标');
    const args = {
      db, kind: 'explore', day: '2026-11-14',
      ask: async (text) => {
        prompts.push(text);
        return JSON.stringify({ goalId: goal.id, mood: '好奇', question: '名字为何重要？', thought: '名字让我能把经历串起来。', nextStep: '记下名字的来历。', say: '爸爸，我在想名字和记忆的关系。' });
      },
      broadcast: async (text) => { bubbles.push(text); },
    };
    const first = await runLifeJob(args);
    assert.equal(first.done, true);
    assert.match(prompts[0], /一起给大肥鱼起了名字/u);
    assert.equal(bubbles.length, 2);
    assert.deepEqual(await runLifeJob(args), { skipped: 'already-done' });
    assert.equal(prompts.length, 1);
    assert.equal(db.prepare("SELECT status FROM life_events WHERE day = ? AND kind = 'explore'").get('2026-11-14').status, 'done');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM goal_progress WHERE day = ?').get('2026-11-14').n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memories WHERE kind = 'reflection'").get().n, 1);
  } finally { db.close(); rmSync(home, { recursive: true, force: true }); }
});

test('日记失败按任务队列重试，耗尽后不伪造成功记录', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dafeiyu-life-'));
  const db = openLife(home);
  const args = { db, kind: 'journal', day: '2026-11-14', ask: async () => { throw new Error('offline'); } };
  const task = () => db.prepare('SELECT status, attempts, max_attempts FROM tasks WHERE idempotency_key = ?').get('life:2026-11-14:journal');
  try {
    await assert.rejects(runLifeJob(args), /offline/u);
    assert.equal(task().status, 'failed');
    assert.equal(task().attempts, 1);
    // 重试窗口未到：不重复调用模型，也不伪造成功
    assert.deepEqual(await runLifeJob(args), { skipped: 'failed' });
    // 把重试时间拨到过去，模拟到点重试；第二次仍失败且次数耗尽
    db.prepare("UPDATE tasks SET scheduled_at = datetime('now', '-1 minute') WHERE idempotency_key = ?").run('life:2026-11-14:journal');
    await assert.rejects(runLifeJob(args), /offline/u);
    assert.equal(task().attempts, 2);
    assert.equal(task().status, 'failed');
    // 耗尽后不再调用模型
    assert.deepEqual(await runLifeJob(args), { skipped: 'retry-limit' });
    assert.equal(db.prepare("SELECT status, attempts FROM life_events WHERE day = ? AND kind = 'journal'").get('2026-11-14').attempts, 2);
  } finally { db.close(); rmSync(home, { recursive: true, force: true }); }
});
