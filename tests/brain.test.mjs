import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { startBrain } from '../brain/server.mjs';
import { capture, memoryFromUser, memoryRecordFromUser, openMemory, recall } from '../brain/memory.mjs';
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

test('长期记忆检索综合相关性、可信度并记录访问信号', () => {
  const home = mkdtempSync(join(tmpdir(), 'dafeiyu-recall-'));
  const db = openMemory(join(home, 'memory.sqlite'));
  try {
    db.prepare("INSERT INTO memories (content, kind, source, confidence, created_at) VALUES (?, 'user_fact', 'test', ?, datetime('now'))").run('爸爸喜欢草莓和温柔的语气', 1);
    db.prepare("INSERT INTO memories (content, kind, source, confidence, created_at) VALUES (?, 'user_fact', 'test', ?, datetime('now'))").run('爸爸喜欢水果', 0.3);
    assert.deepEqual(recall(db, '爸爸喜欢草莓', 1)[0].content, '爸爸喜欢草莓和温柔的语气');
    assert.equal(db.prepare('SELECT access_count FROM memories WHERE content = ?').get('爸爸喜欢草莓和温柔的语气').access_count, 1);
    assert.deepEqual(recall(db, '', 5), []);
  } finally { db.close(); rmSync(home, { recursive: true, force: true }); }
});

test('明确保存的长期记忆会生成可审计的结构化事实投影', () => {
  const home = mkdtempSync(join(tmpdir(), 'dafeiyu-facts-'));
  const db = openMemory(join(home, 'memory.sqlite'));
  try {
    const result = capture(db, '请记住：我喜欢草莓', '好的爸爸');
    const fact = db.prepare('SELECT subject, predicate, object_text, status FROM memory_facts WHERE memory_id = ?').get(result.memoryId);
    assert.equal(fact.subject, 'owner');
    assert.equal(fact.predicate, 'fact');
    assert.equal(fact.object_text, '我喜欢草莓');
    assert.equal(fact.status, 'confirmed');
  } finally { db.close(); rmSync(home, { recursive: true, force: true }); }
});

test('被替代的事实不会继续参与召回', () => {
  const home = mkdtempSync(join(tmpdir(), 'dafeiyu-superseded-')); const db = openMemory(join(home, 'memory.sqlite'));
 try { const a=db.prepare("INSERT INTO memories(content,kind,source,confidence) VALUES('爸爸喜欢苹果','user_fact','test',1)").run(); const b=db.prepare("INSERT INTO memories(content,kind,source,confidence) VALUES('爸爸喜欢草莓','user_fact','test',1)").run(); db.prepare("INSERT INTO memory_facts(memory_id,subject,predicate,object_text,status,confidence) VALUES(?,?,?,?,?,?)").run(a.lastInsertRowid,'owner','preference','苹果','superseded',1); db.prepare("INSERT INTO memory_facts(memory_id,subject,predicate,object_text,status,confidence) VALUES(?,?,?,?,?,?)").run(b.lastInsertRowid,'owner','preference','草莓','confirmed',1); assert.equal(recall(db,'苹果水果',5).length,0); assert.equal(recall(db,'草莓水果',5)[0].content,'爸爸喜欢草莓'); } finally { db.close(); rmSync(home,{recursive:true,force:true}); }
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
    const audit = openMemory(join(home, 'dafeiyu-memory.sqlite'));
    assert.ok(audit.prepare("SELECT COUNT(*) AS n FROM agent_events WHERE channel='desktop'").get().n >= 4);
    audit.close();
  } finally {
    await brain.close();
    await new Promise((resolve) => upstream.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }
});
