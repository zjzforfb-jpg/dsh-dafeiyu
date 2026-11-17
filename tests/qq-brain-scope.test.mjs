import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { qqBrain } from '../connect/qq/brain.mjs';
import { qqPlanner } from '../connect/qq/planner.mjs';

test('QQ replies and planner pass the source scope to Brain', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dafeiyu-qq-scope-'));
  mkdirSync(join(home, 'dsh-pet'));
  writeFileSync(join(home, 'dsh-pet', 'standalone-ai.json'), JSON.stringify({ apiKey: 'local-test' }));
  const calls = [];
  const fetchImpl = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"say":"你好","steps":[]}' } }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const reply = qqBrain(home, { fetchImpl });
    await reply({ kind: 'group', id: 'group-1', peer: { role: 'friend' }, accountId: 'bot-1', messageId: 'group-msg-1', text: '你好', history: [], inputKind: 'text' });
    const groupScope = calls[0].metadata.connect;
    assert.deepEqual({ channel: groupScope.channel, role: groupScope.role, conversation_kind: groupScope.conversation_kind }, {
      channel: 'qq', role: 'member', conversation_kind: 'group',
    });
    assert.equal(groupScope.message_id, 'group-msg-1');
    await reply({ kind: 'c2c', id: 'friend-1', peer: { role: 'friend' }, accountId: 'bot-1', messageId: 'friend-msg-1', text: '你好', history: [], inputKind: 'text' });
    assert.equal(calls[1].metadata.connect.role, 'friend');
    assert.equal(calls[1].messages[0].content.includes('当前联系人不是爸爸'), true);
    const planner = qqPlanner(home, { fetchImpl });
    await planner({ text: '查作品', peerId: 'owner-1', accountId: 'bot-1', messageId: 'owner-msg-1' });
    assert.equal(calls[2].metadata.connect.role, 'owner');
    assert.equal(calls[2].metadata.connect.peer_id, 'owner-1');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
