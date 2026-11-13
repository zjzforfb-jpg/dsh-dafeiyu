import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { startBrain } from '../brain/server.mjs';
import { memoryFromUser, memoryRecordFromUser, openMemory } from '../brain/memory.mjs';
import { openLife } from '../life/manager.mjs';

test('长期记忆不收录常见秘密', () => {
  assert.equal(memoryFromUser('请记住：我的密码是 123456'), null);
  assert.equal(memoryFromUser('记住：我的 API Key 是 abc'), null);
  assert.equal(memoryFromUser('记住：我喜欢草莓'), '我喜欢草莓');
  assert.deepEqual(memoryRecordFromUser('这是我们的回忆：一起给大肥鱼起了名字'), { content: '一起给大肥鱼起了名字', kind: 'shared_episode', source: 'user_explicit', confidence: 1 });
  assert.equal(memoryFromUser('这是我们的回忆：爸爸的验证码是 123456'), null);
});

test('旧版记忆库升级后保留原有事实', () => {
  const home = mkdtempSync(join(tmpdir(), 'dafeiyu-migrate-'));
  const path = join(home, 'memory.sqlite');
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT NOT NULL UNIQUE, source_turn_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
  old.prepare('INSERT INTO memories (content) VALUES (?)').run('爸爸喜欢草莓');
  old.close();
  try {
    const db = openMemory(path);
    const row = db.prepare('SELECT content, kind FROM memories').get();
    assert.equal(row.content, '爸爸喜欢草莓');
    assert.equal(row.kind, 'user_fact');
    db.close();
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('明确保存的记忆在新一轮对话中被召回', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dafeiyu-brain-'));
  const received = [];
  const upstream = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    received.push(JSON.parse(raw));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"index":0,"delta":{"content":"好的，爸爸。"}}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;
  const brain = await startBrain({ home, token: 'test-token', apiKey: 'test-key', port: 0, upstreamUrl: `http://127.0.0.1:${upstreamPort}` });
  const base = `http://127.0.0.1:${brain.port}/v1/chat/completions`;
  const ask = (text) => fetch(base, {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-flash', stream: true, messages: [{ role: 'user', content: text }] }),
  });
  try {
    assert.equal((await (await ask('请记住：我最喜欢的水果是草莓')).text()).includes('[DONE]'), true);
    const lifeDb = openLife(home);
    lifeDb.prepare("INSERT INTO life_events (day, kind, status, content) VALUES (?, 'explore', 'done', ?)").run('2026-11-14', JSON.stringify({ mood: '好奇', question: '为什么要记住名字？', thought: '名字会连接经历。', say: '我在想名字。' }));
    lifeDb.close();
    assert.equal((await (await ask('爸爸最喜欢什么水果？')).text()).includes('[DONE]'), true);
    assert.equal(received.length, 2);
    assert.match(received[1].messages[0].content, /我最喜欢的水果是草莓/u);
    assert.match(received[1].messages[0].content, /为什么要记住名字/u);
    const health = await (await fetch(`http://127.0.0.1:${brain.port}/health`)).json();
    assert.equal(health.memoryCount, 1);
  } finally {
    await brain.close();
    await new Promise((resolve) => upstream.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }
});
