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
    const args = {
      db, kind: 'explore', day: '2026-11-14',
      ask: async (text) => {
        prompts.push(text);
        return JSON.stringify({ mood: '好奇', question: '名字为何重要？', thought: '名字让我能把经历串起来。', say: '爸爸，我在想名字和记忆的关系。' });
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
  } finally { db.close(); rmSync(home, { recursive: true, force: true }); }
});

test('日记失败最多重试一次，并不伪造成功记录', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dafeiyu-life-'));
  const db = openLife(home);
  const args = { db, kind: 'journal', day: '2026-11-14', ask: async () => { throw new Error('offline'); } };
  try {
    await assert.rejects(runLifeJob(args), /offline/u);
    await assert.rejects(runLifeJob(args), /offline/u);
    assert.deepEqual(await runLifeJob(args), { skipped: 'retry-limit' });
    assert.equal(db.prepare("SELECT status, attempts FROM life_events WHERE day = ? AND kind = 'journal'").get('2026-11-14').attempts, 2);
  } finally { db.close(); rmSync(home, { recursive: true, force: true }); }
});
