import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemory, remember, recall, MEMORY_TYPES } from '../brain/memory.mjs';
import { search, rememberScoped } from '../connect/core/memory.mjs';

// P1-A：七类记忆 + 范围过滤（R-05/R-07）。
// 验收门槛两条：① 群聊记忆不漏进主人私聊召回；② 七类每类可写入可召回。

function memDb() {
  // openMemory 会对所在目录 chmod 0700，所以给每个用例一个专属子目录（别直接放 tmpdir 根）。
  return openMemory(join(tmpdir(), `dfy-mem-${Date.now()}-${Math.random().toString(36).slice(2)}`, 'mem.sqlite'));
}

test('范围隔离：群聊记忆不出现在主人私聊召回里', () => {
  const db = memDb();
  remember(db, { content: '主人在私聊说最喜欢吃豚骨拉面', scope: 'private', type: 'semantic', channel: 'qq' });
  remember(db, { content: '群里讨论周末一起去爬山露营', scope: 'group', type: 'episodic', channel: 'qq' });

  // 主人私聊召回：用「爬山」查，不该看到群里的爬山计划
  const priv = recall(db, '周末 爬山 露营', 10, { scope: 'private' });
  assert.ok(!priv.some((r) => r.content.includes('爬山')), '群聊记忆不得漏进主人私聊召回');
  // 主人私聊自己的记忆用自己的词能召回
  assert.ok(recall(db, '豚骨 拉面', 10, { scope: 'private' }).some((r) => r.content.includes('拉面')), '主人私聊自己的记忆应当召回');

  // 群聊召回：能看到群里的记忆，但不该看到主人私聊的豚骨拉面
  const grp = recall(db, '周末 爬山 露营', 10, { scope: 'group' });
  assert.ok(grp.some((r) => r.content.includes('爬山')), '群聊召回应看到群里的记忆');
  assert.ok(!grp.some((r) => r.content.includes('豚骨')), '主人私聊记忆不得漏进群聊召回');
});

test('public 记忆到处可见，friend 不漏进 group', () => {
  const db = memDb();
  remember(db, { content: '大肥鱼是一只会说话的鱼', scope: 'public', type: 'semantic' });
  remember(db, { content: '好友小明说过生日', scope: 'friend', type: 'social' });
  assert.ok(recall(db, '会说话的鱼', 10, { scope: 'private' }).some((r) => r.scope === 'public'));
  assert.ok(recall(db, '会说话的鱼', 10, { scope: 'group' }).some((r) => r.scope === 'public'));
  assert.ok(!recall(db, '小明 生日', 10, { scope: 'group' }).some((r) => r.content.includes('小明')));
});

test('七类记忆每类都能写入并按 type 召回', () => {
  const db = memDb();
  for (const type of MEMORY_TYPES) {
    remember(db, { content: `一条关于${type}的独特记忆标记`, type, scope: 'private' });
  }
  for (const type of MEMORY_TYPES) {
    const rows = recall(db, `${type} 记忆 标记`, 10, { type, scope: 'private' });
    assert.ok(rows.some((r) => r.type === type && r.content.includes(type)), `七类之一 ${type} 应可写入并召回`);
  }
});

test('统一检索入口 search() 强制范围过滤，群聊不漏进私聊', () => {
  const db = memDb();
  rememberScoped(db, { content: '主人私聊定的写作计划', scope: 'private', type: 'semantic' });
  rememberScoped(db, { content: '群里商量周五团建', scope: 'group', type: 'episodic' });
  // 私聊检索不到群里的团建
  assert.ok(!search(db, '周五 团建', { scope: 'private' }).some((r) => r.content.includes('团建')));
  // 群聊检索得到群里的团建
  assert.ok(search(db, '周五 团建', { scope: 'group' }).some((r) => r.content.includes('团建')));
  // 默认 scope 就是 private（不传也安全）
  assert.ok(!search(db, '周五 团建').some((r) => r.content.includes('团建')));
});
