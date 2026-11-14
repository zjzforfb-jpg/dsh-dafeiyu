import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isVoiceAttachment, normalizeDispatch } from '../connect/qq/gateway.mjs';
import { loadQqConfig, QqApi } from '../connect/qq/api.mjs';
import { initQq, logInbound, savePeer, peer, conversationHistory, reserve, usage, dayKey } from '../connect/qq/store.mjs';
import { CallSessions } from '../connect/qq/call.mjs';
import { QqService } from '../connect/qq/service.mjs';
import { openMemory } from '../brain/memory.mjs';
import { listMemories } from '../connect/qq/memory.mjs';

const KIND = 'c2c', CONV = 'user-openid-0001', TS = Date.UTC(2026, 10, 14, 1, 0);
const response = data => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
const setup = () => { const db = new DatabaseSync(':memory:'); initQq(db); return db; };
const key = value => createHash('sha256').update(String(value)).digest('hex');
const media = () => new Response(Buffer.from('audio'), { status: 200, headers: { 'content-length': '5' } });
const fakeVoice = overrides => ({
  transcribeBytes: async () => ({ text: '语音内容', source: 'local_whisper_cpp' }),
  synthesize: async () => ({ duration_ms: 1200, silk: Buffer.from('silk-bytes') }),
  status: () => ({ provider: 'test' }),
  ...overrides,
});
const service = (db, { voice = fakeVoice(), ask = async () => '我是大肥鱼。', api = { sendText: async () => ({}), sendVoice: async () => ({}) }, now = () => TS, gateway = { start: async () => {}, close: async () => {} }, downloadImpl } = {}) => new QqService({ db, voice, api, ask, gateway, now, ...(downloadImpl ? { downloadImpl } : {}) });

test('QQ config comes from qq.json or environment and rejects malformed values', () => {
  const root = mkdtempSync(join(tmpdir(), 'dafeiyu-qq-'));
  try {
    assert.equal(loadQqConfig(root, {}), null);
    writeFileSync(join(root, 'qq.json'), JSON.stringify({ appId: 'app-1', secret: 'secret-1' }));
    assert.deepEqual(loadQqConfig(root, {}), { appId: 'app-1', secret: 'secret-1' });
    writeFileSync(join(root, 'qq.json'), JSON.stringify({ appId: 'app-1' }));
    assert.throws(() => loadQqConfig(root, {}), /invalid_qq_config/);
    assert.deepEqual(loadQqConfig(join(root, 'missing'), { QQ_BOT_APP_ID: 'a', QQ_BOT_SECRET: 'b' }), { appId: 'a', secret: 'b' });
    assert.throws(() => new QqApi({ appId: '', secret: 'x' }), /invalid_qq_credentials/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('QQ API caches tokens, scopes paths by conversation, and uploads voice before the voice message', async () => {
  const seen = [];
  let tokens = 0;
  const api = new QqApi({
    appId: 'app-1', secret: 'secret-1', now: () => 1000,
    fetchImpl: async (url, options) => {
      seen.push({ url, options, body: options?.body ? JSON.parse(options.body) : null });
      if (url.endsWith('/getAppAccessToken')) { tokens++; return response({ access_token: 'token-1', expires_in: 7200 }); }
      if (url.endsWith('/files')) return response({ file_info: 'file-info-1' });
      return response({ id: 'msg-1' });
    },
  });
  await api.sendText({ kind: 'c2c', id: CONV, content: '  你好  ', msgId: 'incoming-1' });
  await api.sendText({ kind: 'group', id: 'group-openid-1', content: '群消息' });
  assert.equal(tokens, 1);
  assert.equal(seen[1].url, 'https://api.sgroup.qq.com/v2/users/user-openid-0001/messages');
  assert.deepEqual(seen[1].body, { content: '你好', msg_type: 0, msg_id: 'incoming-1' });
  assert.equal(seen[1].options.headers.authorization, 'QQBot token-1');
  assert.equal(seen[2].url, 'https://api.sgroup.qq.com/v2/groups/group-openid-1/messages');
  await api.sendVoice({ kind: 'c2c', id: CONV, silk: Buffer.from('silk'), msgId: 'incoming-2' });
  assert.equal(seen[3].url, 'https://api.sgroup.qq.com/v2/users/user-openid-0001/files');
  assert.equal(seen[3].body.file_type, 3);
  assert.equal(seen[3].body.file_data, Buffer.from('silk').toString('base64'));
  assert.equal(seen[4].body.msg_type, 7);
  assert.deepEqual(seen[4].body.media, { file_info: 'file-info-1' });
  assert.throws(() => api.sendText({ kind: 'c2c', id: 'bad id', content: 'x' }), /invalid_qq_conversation_id/);
  assert.throws(() => api.sendText({ kind: 'c2c', id: CONV, content: '   ' }), /qq_empty_message/);
});

test('QQ store deduplicates inbound messages, isolates histories, and caps daily budgets', () => {
  const db = setup();
  const row = { id: 'a'.repeat(64), kind: KIND, convId: CONV, msgId: 'm-1', inputKind: 'text', text: '你好', createdMs: TS };
  assert.equal(logInbound(db, row), true);
  assert.equal(logInbound(db, row), false);
  db.prepare("UPDATE qq_messages SET status='sent', reply='回复'").run();
  assert.equal(conversationHistory(db, KIND, CONV).length, 2);
  assert.equal(conversationHistory(db, KIND, 'other-openid-1').length, 0);
  assert.equal(savePeer(db, { kind: KIND, id: CONV }).voiceReply, 1);
  assert.equal(peer(db, KIND, CONV).enabled, 1);
  const day = dayKey(TS);
  for (let index = 0; index < 3; index += 1) assert.equal(reserve(db, day, 'model_calls', 3), true);
  assert.equal(reserve(db, day, 'model_calls', 3), false);
  assert.deepEqual(usage(db, day), { day, model_calls: 3, voice_requests: 0 });
  assert.throws(() => savePeer(db, { kind: 'c2c', id: 'short' }), /invalid_qq_conversation_id/);
  assert.throws(() => reserve(db, day, 'other', 1), /invalid_qq_budget/);
  db.close();
});

test('QQ call sessions expire after the quiet window and cap turns', () => {
  let clock = 0;
  const calls = new CallSessions({ timeoutMs: 60_000, maxTurns: 2, now: () => clock });
  calls.start(KIND, CONV);
  assert.ok(calls.active(KIND, CONV));
  clock = 30_000; calls.touch(KIND, CONV);
  clock = 70_000; assert.ok(calls.active(KIND, CONV));
  clock = 95_000; assert.equal(calls.active(KIND, CONV), null);
  const expired = calls.sweep();
  assert.deepEqual(expired, []);
  calls.start(KIND, CONV); clock += 10_000; calls.touch(KIND, CONV); clock += 10_000; calls.touch(KIND, CONV);
  assert.equal(calls.active(KIND, CONV), null);
  assert.equal(calls.list().length, 0);
});

test('QQ service holds unknown peers, replies once per message, and keeps duplicate deliveries out', async () => {
  const db = setup();
  const sent = [];
  const qq = service(db, { api: { sendText: async value => { sent.push(value); }, sendVoice: async () => ({}) } });
  const event = { kind: KIND, id: CONV, messageId: 'm-1', text: '在吗', attachments: [] };
  await qq.handle(event);
  assert.equal(qq.row(key('m-1')).status, 'held');
  assert.equal(sent.length, 0);
  savePeer(db, { kind: KIND, id: CONV });
  const again = { ...event, messageId: 'm-2' };
  await qq.handle(again);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].msgId, 'm-2');
  assert.equal(sent[0].content, '我是大肥鱼。');
  await qq.handle(again);
  assert.equal(sent.length, 1);
  assert.equal(qq.row(key('m-2')).status, 'sent');
  db.close();
});

test('QQ voice input is transcribed and answered with a voice bar, falling back to text when synthesis fails', async () => {
  const db = setup();
  savePeer(db, { kind: KIND, id: CONV, voiceReply: true });
  const voiceSent = []; const texts = [];
  const attachment = { content_type: 'audio/silk', url: 'https://gchat.qpic.cn/media/voice.silk', filename: 'voice.silk' };
  assert.equal(isVoiceAttachment(attachment), true);
  assert.equal(isVoiceAttachment({ content_type: 'image/png', url: 'https://x/y.png' }), false);
  const downloadImpl = async url => { assert.equal(url, attachment.url); return media(); };
  const qq = service(db, {
    api: { sendText: async value => { texts.push(value); }, sendVoice: async value => { voiceSent.push(value); } },
    voice: fakeVoice(), downloadImpl,
  });
  await qq.handle({ kind: KIND, id: CONV, messageId: 'v-1', text: '', attachments: [attachment] });
  assert.equal(qq.row(key('v-1')).delivery_kind, 'voice');
  assert.equal(voiceSent.length, 1);
  assert.equal(texts.length, 0);
  const broken = service(db, {
    api: { sendText: async value => { texts.push(value); }, sendVoice: async () => { throw new Error('voice_unavailable'); } },
    voice: fakeVoice(), downloadImpl,
  });
  await broken.handle({ kind: KIND, id: CONV, messageId: 'v-2', text: '', attachments: [attachment] });
  assert.equal(texts.length, 1);
  assert.equal(texts[0].msgId, 'v-2');
  db.close();
});

test('QQ walkie-talkie commands switch replies to voice until hangup or quiet timeout', async () => {
  const db = setup();
  savePeer(db, { kind: KIND, id: CONV, voiceReply: false });
  let clock = 1000;
  const voiceSent = [];
  const qq = service(db, {
    now: () => clock,
    api: { sendText: async () => ({}), sendVoice: async value => { voiceSent.push(value); } },
  });
  const start = await qq.handle({ kind: KIND, id: CONV, messageId: 'c-1', text: '/通话', attachments: [] });
  assert.equal(start.command, 'call_start');
  assert.equal(qq.calls.list().length, 1);
  clock += 5000;
  await qq.handle({ kind: KIND, id: CONV, messageId: 'c-2', text: '你在干嘛', attachments: [] });
  assert.equal(voiceSent.length, 1);
  clock += 61_000;
  qq.sweep();
  assert.equal(qq.calls.list().length, 0);
  await qq.handle({ kind: KIND, id: CONV, messageId: 'c-3', text: '还在吗', attachments: [] });
  assert.equal(voiceSent.length, 1);
  db.close();
});

test('QQ service stops answering when the daily model budget is exhausted', async () => {
  const db = setup();
  savePeer(db, { kind: KIND, id: CONV, voiceReply: false });
  const day = dayKey(TS);
  for (let index = 0; index < 50; index += 1) reserve(db, day, 'model_calls', 50);
  const texts = [];
  const qq = service(db, { api: { sendText: async value => { texts.push(value); }, sendVoice: async () => ({}) } });
  const result = await qq.handle({ kind: KIND, id: CONV, messageId: 'b-1', text: '你好', attachments: [] });
  assert.equal(result.error, 'daily_model_budget');
  assert.equal(qq.row(key('b-1')).status, 'held');
  assert.equal(texts.length, 1);
  db.close();
});

test('QQ chat writes long-term memory, recalls it into the brain, and logs desktop activity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dafeiyu-qq-memory-'));
  const memory = openMemory(join(dir, 'dafeiyu-memory.sqlite'));
  try {
    const db = setup();
    savePeer(db, { kind: KIND, id: CONV, label: '爸爸', enabled: true, autoReply: true, voiceReply: false });
    const sent = [];
    const contexts = [];
    const serviceWith = ask => new QqService({
      db, memory, home: dir, now: () => TS,
      voice: fakeVoice(),
      ask: async context => { contexts.push(context); return ask(context); },
      api: { sendText: async message => { sent.push(message); return {}; }, sendVoice: async () => ({}) },
      gateway: { start: async () => {}, close: async () => {} },
    });

    await serviceWith(async () => '好呀。').handle({ kind: KIND, id: CONV, messageId: 'mem-1', text: '/记住 生日是2026年10月17日', attachments: [] });
    const rows = listMemories(memory, 5);
    assert.equal(rows.length, 1);
    assert.match(rows[0].content, /生日是2026年10月17日/u);

    await serviceWith(async () => '好呀。').handle({ kind: KIND, id: CONV, messageId: 'mem-2', text: '/记忆', attachments: [] });
    assert.match(sent.at(-1).content, /#\d+/u);

    await serviceWith(async () => '喵。').handle({ kind: KIND, id: CONV, messageId: 'mem-3', text: '记住我属猫', attachments: [] });
    assert.equal(listMemories(memory, 10).length, 2);
    assert.ok(Array.isArray(contexts.at(-1).memories));

    const events = memory.prepare('SELECT source, phase, message FROM desktop_activity_events').all();
    assert.ok(events.some(event => event.phase === 'start' && event.message.startsWith('爸爸：')));
    assert.ok(events.some(event => event.phase === 'done' && event.message.startsWith('大肥鱼：')));
  } finally {
    memory.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('QQ group messages normalize mentions and only answer a fraction of ambient chatter', async () => {
  const full = normalizeDispatch({ t: 'GROUP_MESSAGE_CREATE', d: { id: 'm-1', group_openid: 'group-openid-1', author: { member_openid: 'member-1' }, content: '今天好热 <@7A3B9C1D5E2F4A6B> 你们吃了吗', mentions: [{ id: '7A3B9C1D5E2F4A6B' }] } });
  assert.equal(full.kind, 'group');
  assert.equal(full.atMe, false);
  assert.equal(full.text, '今天好热 你们吃了吗');
  const atAll = normalizeDispatch({ t: 'GROUP_MESSAGE_CREATE', d: { id: 'm-2', group_openid: 'group-openid-1', content: '<@all> 集合', mentions: [{ id: 'bot', bot: true }] } });
  assert.equal(atAll.atMe, true);
  const at = normalizeDispatch({ t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'm-3', group_openid: 'group-openid-1', content: '在吗' } });
  assert.equal(at.atMe, true);

  const db = setup();
  savePeer(db, { kind: 'group', id: 'group-openid-1', label: '家人群', enabled: true, autoReply: true, voiceReply: false });
  let clock = TS;
  const sent = [];
  const build = () => new QqService({
    db, now: () => clock, random: () => 0, groupReplyRate: 0.5, groupCooldownMs: 10000,
    voice: fakeVoice(), ask: async () => '我在呢',
    api: { sendText: async message => { sent.push(message); return {}; }, sendVoice: async () => ({}) },
    gateway: { start: async () => {}, close: async () => {} },
  });

  const service = build();
  assert.equal((await service.handle({ kind: 'group', id: 'group-openid-1', messageId: 'g-1', text: '今天吃什么', attachments: [], atMe: false })).replied, 'text');
  clock += 1000;
  assert.equal((await service.handle({ kind: 'group', id: 'group-openid-1', messageId: 'g-2', text: '有人吗', attachments: [], atMe: false })).ignored, 'ambient_skip');
  assert.equal((await service.handle({ kind: 'group', id: 'group-openid-1', messageId: 'g-3', text: '大肥鱼在吗', attachments: [], atMe: true })).replied, 'text');
  assert.equal(sent.length, 2);
});
