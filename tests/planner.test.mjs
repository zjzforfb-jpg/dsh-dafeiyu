import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QqService } from '../connect/qq/service.mjs';
import { approvePendingTask, initTasks, markAwaitingPublish, proposeTask, startTask } from '../connect/tasks.mjs';
import { initAgentEvents } from '../connect/agent-events.mjs';
import { formatDraftReview } from '../connect/douyin/review.mjs';
import { initQq, savePeer, syncQqOwner } from '../connect/qq/store.mjs';
import { parsePlan, factsText } from '../connect/qq/planner.mjs';
import { catalogText, normalizeSteps, runTool, READONLY_TOOLS } from '../connect/qq/tools.mjs';
import { openDouyinDb, saveWork, saveComment } from '../connect/douyin/store.mjs';

const KIND = 'c2c', CONV = 'user-openid-0001', TS = Date.UTC(2026, 10, 15, 3, 0);

function service(db, { planner = null, ask = async () => '我是大肥鱼。', sent = [], execute = null } = {}) {
  return new QqService({
    db,
    voice: { transcribeBytes: async () => ({ text: '语音' }), synthesize: async () => ({ silk: Buffer.from('x'), duration_ms: 1 }), status: () => ({}) },
    api: { sendText: async (value) => { sent.push(value); }, sendVoice: async () => ({}) },
    ask,
    planner,
    ...(execute ? { execute } : {}),
    now: () => TS,
    gateway: { start: async () => {}, close: async () => {} },
  });
}

test('计划解析容错：裸 JSON、```json 围栏、夹带废话都能读出来', () => {
  assert.deepEqual(parsePlan('{"say":"好","steps":[{"tool":"works.list","args":{}}]}').steps, [{ tool: 'works.list', args: {} }]);
  assert.equal(parsePlan('```json\n{"say":"查一下","steps":[]}\n```').say, '查一下');
  assert.equal(parsePlan('我想想：{"say":"嗯","steps":[]} 就这样').say, '嗯');
  assert.deepEqual(parsePlan('完全不是 JSON').steps, []);
});

test('计划校验：未知工具丢掉、写动作标成需确认、参数按 schema 收敛', () => {
  const { steps, rejected } = normalizeSteps([
    { tool: 'douyin.publish', args: {} },
    { tool: 'rm -rf', args: {} },
    { tool: 'weather.get', args: { city: '保定' } },
    { tool: 'comments.list', args: { limit: '999', workId: 42 } },
  ]);
  assert.deepEqual(steps, [
    { tool: 'douyin.publish', args: {}, write: true },
    { tool: 'weather.get', args: { city: '保定' } },
    { tool: 'comments.list', args: { limit: 999, workId: '42' } },
  ]);
  assert.deepEqual(rejected, [{ tool: 'rm -rf', reason: 'tool_not_allowed' }]);
  assert.ok(catalogText().includes('works.list'));
  assert.equal(READONLY_TOOLS.every((tool) => tool.name !== 'douyin.publish'), true);
});

test('写工具不会被直接执行，只交回一句「需要确认」', async () => {
  const out = await runTool({ tool: 'douyin.reply_comments', args: { limit: 3 } }, { root: process.cwd() });
  assert.equal(out.ok, false);
  assert.match(out.text, /确认/);
});

test('服务：模型规划写动作时只建任务，不执行，并在回复里说明', async () => {
  const db = new DatabaseSync(':memory:');
  initQq(db);
  savePeer(db, { kind: KIND, id: CONV, label: '爸爸' }); syncQqOwner(db, CONV);
  const sent = [];
  let asked = 0;
  const qq = service(db, {
    ask: async () => { asked += 1; return '我看了一下，最近还多了两条新评论。'; },
    planner: async () => ({ say: '我看看', steps: [{ tool: 'douyin.reply_comments', args: { limit: 8 }, write: true }], rejected: [], raw: '' }),
    sent,
  });
  const result = await qq.handle({ kind: KIND, id: CONV, messageId: 'w-1', text: '把新评论都回一下', attachments: [] });
  assert.equal(result.replied, 'text');
  // 写操作有固定回执，话术由计划 + 回执拼成，不再额外调一次脑子（避免模型自己编任务编号）。
  assert.equal(asked, 0);
  assert.match(sent[0].content, /我看看/);
  assert.match(sent[0].content, /同意/);
  const row = db.prepare("SELECT status,payload FROM external_tasks WHERE conv_id=?").get(CONV);
  assert.equal(row.status, 'awaiting_confirmation');
  assert.match(row.payload, /douyin.reply_comments/);
  assert.match(row.payload, /"plan"/);
  db.close();
});

test('服务：说「给爸爸打个电话」时电话写动作真的进任务，回执按电话说而不是抖音', async () => {
  const db = new DatabaseSync(':memory:');
  initQq(db);
  savePeer(db, { kind: KIND, id: CONV, label: '爸爸' }); syncQqOwner(db, CONV);
  const sent = [];
  const qq = service(db, {
    planner: async () => ({ say: '好，我给爸爸拨一个', steps: [{ tool: 'qq.call', args: {}, write: true }], rejected: [], raw: '' }),
    sent,
  });
  const result = await qq.handle({ kind: KIND, id: CONV, messageId: 'w-call', text: '给爸爸打个电话', attachments: [] });
  assert.equal(result.replied, 'text');
  // 电话动作必须出现在计划里（之前只有 douyin.* 三个写工具，模型根本没法规划拨号）。
  assert.ok(catalogText().includes('qq.call'));
  assert.match(sent[0].content, /拨/);
  assert.doesNotMatch(sent[0].content, /操作抖音账号/u);
  const row = db.prepare("SELECT status,payload FROM external_tasks WHERE conv_id=?").get(CONV);
  assert.equal(row.status, 'awaiting_confirmation');
  assert.match(row.payload, /qq\.call/);
  db.close();
});

test('确认「同意」后按任务里存的操作去执行，并把真实回执说清楚', async () => {
  const db = new DatabaseSync(':memory:');
  initQq(db);
  savePeer(db, { kind: KIND, id: CONV, label: '爸爸' }); syncQqOwner(db, CONV);
  const sent = [];
  const ran = [];
  const qq = service(db, {
    planner: async () => ({ say: '好，这就回', steps: [{ tool: 'douyin.reply_comments', args: { limit: 8 }, write: true }], rejected: [], raw: '' }),
    sent,
    execute: async (name, opts) => { ran.push({ name, opts }); return { ok: true, text: '回复了 3 条评论' }; },
  });
  await qq.handle({ kind: KIND, id: CONV, messageId: 'w-2', text: '把收到的评论都回一遍', attachments: [] });
  const pending = db.prepare("SELECT id FROM external_tasks WHERE status='awaiting_confirmation'").get();
  assert.ok(pending?.id);
  const result = await qq.handle({ kind: KIND, id: CONV, messageId: 'w-3', text: '同意', attachments: [] });
  assert.equal(result.status, 'succeeded');
  assert.equal(ran.length, 1);
  assert.equal(ran[0].name, 'douyin.reply_comments');
  assert.match(sent.at(-1).content, /办好了/);
  assert.match(sent.at(-1).content, /3 条评论/);
  db.close();
});

test('爸爸说「算了」就作废任务，并把这次否决算作经验', async () => {
  const db = new DatabaseSync(':memory:');
  initQq(db);
  savePeer(db, { kind: KIND, id: CONV, label: '爸爸' }); syncQqOwner(db, CONV);
  const sent = [];
  const home = mkdtempSync(join(tmpdir(), 'dafeiyu-decline-'));
  const qq = new QqService({
    db, home,
    voice: { transcribeBytes: async () => ({ text: 'v' }), synthesize: async () => ({ silk: Buffer.from('x'), duration_ms: 1 }), status: () => ({}) },
    api: { sendText: async (value) => { sent.push(value.content); }, sendVoice: async () => ({}) },
    ask: async () => '我在',
    planner: async () => ({ say: '好，这就回', steps: [{ tool: 'douyin.reply_comments', args: {}, write: true }], rejected: [], raw: '' }),
    now: () => TS,
    gateway: { start: async () => {}, close: async () => {} },
  });
  await qq.handle({ kind: KIND, id: CONV, messageId: 'd-1', text: '把收到的评论都回一遍', attachments: [] });
  const result = await qq.handle({ kind: KIND, id: CONV, messageId: 'd-2', text: '算了', attachments: [] });
  assert.equal(result.status, 'cancelled');
  const row = db.prepare("SELECT status FROM external_tasks WHERE conv_id=?").get(CONV);
  assert.equal(row.status, 'cancelled');
  assert.match(sent.at(-1), /作废/);
  const lessons = JSON.parse(readFileSync(join(home, 'lessons.json'), 'utf8'));
  assert.match(JSON.stringify(lessons), /否定|否掉/u);
  db.close();
});

test('爸爸说「拒绝」「别打」也算否掉，任务不能一直挂在待确认', async () => {
  for (const word of ['拒绝', '不同意', '别打', '不行']) {
    const db = new DatabaseSync(':memory:');
    initQq(db);
    savePeer(db, { kind: KIND, id: CONV, label: '爸爸' }); syncQqOwner(db, CONV);
    const sent = [];
    const home = mkdtempSync(join(tmpdir(), 'dafeiyu-decline2-'));
    const qq = new QqService({
      db, home,
      voice: { transcribeBytes: async () => ({ text: 'v' }), synthesize: async () => ({ silk: Buffer.from('x'), duration_ms: 1 }), status: () => ({}) },
      api: { sendText: async (value) => { sent.push(value.content); }, sendVoice: async () => ({}) },
      ask: async () => '我在',
      planner: async () => ({ say: '好', steps: [{ tool: 'qq.call', args: {}, write: true }], rejected: [], raw: '' }),
      now: () => TS,
      gateway: { start: async () => {}, close: async () => {} },
    });
    await qq.handle({ kind: KIND, id: CONV, messageId: `r-${word}-1`, text: '给爸爸打电话', attachments: [] });
    const pending = db.prepare("SELECT status FROM external_tasks WHERE conv_id=?").get(CONV);
    assert.equal(pending.status, 'awaiting_confirmation', word);
    const result = await qq.handle({ kind: KIND, id: CONV, messageId: `r-${word}-2`, text: word, attachments: [] });
    assert.equal(result.status, 'cancelled', word);
    const row = db.prepare("SELECT status FROM external_tasks WHERE conv_id=?").get(CONV);
    assert.equal(row.status, 'cancelled', word);
    db.close();
  }
});

test('天气工具直接吃 wttr 的真实结构', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    current_condition: [{ lang_zh: [{ value: '小雨' }], temp_C: '11', FeelsLikeC: '9', humidity: '70', windspeedKmph: '5' }],
    weather: [{ mintempC: '7', maxtempC: '13' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  const out = await runTool({ tool: 'weather.get', args: { city: '石家庄' } }, { fetchImpl, root: process.cwd() });
  assert.equal(out.ok, true);
  assert.match(out.text, /石家庄现在\s*小雨/);
  assert.match(out.text, /7~13/);
});

test('作品/评论工具读的是抖音库', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dafeiyu-tools-'));
  try {
    const db = openDouyinDb(root);
    saveWork(db, { id: 'profile:1', title: '屏幕光晃得我眼睛发花', caption: '正文', topics: ['#大肥鱼'], publishedAt: '2026-11-15T02:36:39Z', status: 'published', createdAt: '2026-11-15T02:36:39Z' });
    saveComment(db, { workId: 'profile:1', author: 'LP0423', text: '哈哈哈哈', commentAt: '10小时前' });
    db.close();
    const works = await runTool({ tool: 'works.list', args: {} }, { root });
    assert.equal(works.ok, true);
    assert.match(works.text, /屏幕光晃得我眼睛发花/);
    assert.match(works.text, /评论 1 条/);
    const comments = await runTool({ tool: 'comments.list', args: { limit: 5 } }, { root });
    assert.match(comments.text, /LP0423/);
    assert.match(comments.text, /还没回/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('服务：爸爸给了主题就按他的主题建任务，不再随机挑', async () => {
  const db = new DatabaseSync(':memory:');
  initQq(db);
  savePeer(db, { kind: KIND, id: CONV, label: '爸爸' }); syncQqOwner(db, CONV);
  const sent = [];
  const qq = service(db, {
    ask: async () => '不该被调用',
    planner: async () => ({ say: 'BLG 夺冠！我先报个主题给你审。', steps: [{ tool: 'douyin.publish', args: { theme: 'BLG夺冠' }, write: true }], rejected: [], raw: '' }),
    sent,
  });
  await qq.handle({ kind: KIND, id: CONV, messageId: 'th-1', text: '再发一条作品，主题为BLG夺冠。', attachments: [] });
  const row = db.prepare("SELECT payload FROM external_tasks WHERE conv_id=?").get(CONV);
  const payload = JSON.parse(row.payload);
  assert.equal(payload.theme, 'BLG夺冠');
  assert.equal(payload.plan[0].args.theme, 'BLG夺冠');
  assert.match(sent[0].content, /「BLG夺冠」/);
  db.close();
});

test('服务：模型光聊不给工具时，发作品请求也会落成任务', async () => {
  const db = new DatabaseSync(':memory:');
  initQq(db);
  savePeer(db, { kind: KIND, id: CONV, label: '爸爸' }); syncQqOwner(db, CONV);
  const sent = [];
  const qq = service(db, {
    ask: async () => '不该被调用',
    planner: async () => ({ say: '好，BLG 夺冠这条我这就写。标题走《恭喜BLG夺冠》，话题带三个。', steps: [], rejected: [], raw: '' }),
    sent,
  });
  await qq.handle({ kind: KIND, id: CONV, messageId: 'th-3', text: '再发一条作品，主题为BLG夺冠。', attachments: [] });
  const row = db.prepare("SELECT status,payload FROM external_tasks WHERE conv_id=?").get(CONV);
  assert.equal(row.status, 'awaiting_confirmation');
  assert.equal(JSON.parse(row.payload).theme, 'BLG夺冠');
  assert.match(sent[0].content, /「BLG夺冠」/);
  // 没做完的审稿结论（标题/三项设置）不能抢先冒出来。
  assert.doesNotMatch(sent[0].content, /《/);
  db.close();
});

test('服务：模型没写主题时，从爸爸的话里抠出来', async () => {
  const db = new DatabaseSync(':memory:');
  initQq(db);
  savePeer(db, { kind: KIND, id: CONV, label: '爸爸' }); syncQqOwner(db, CONV);
  const sent = [];
  const qq = service(db, {
    ask: async () => '不该被调用',
    planner: async () => ({ say: '好，那就发一条。', steps: [{ tool: 'douyin.publish', args: {}, write: true }], rejected: [], raw: '' }),
    sent,
  });
  await qq.handle({ kind: KIND, id: CONV, messageId: 'th-2', text: '发一条图文，主题：今天晒太阳', attachments: [] });
  const payload = JSON.parse(db.prepare("SELECT payload FROM external_tasks WHERE conv_id=?").get(CONV).payload);
  assert.equal(payload.theme, '今天晒太阳');
  db.close();
});

test('服务：模型给计划→执行只读工具→事实回灌给脑子', async () => {
  const db = new DatabaseSync(':memory:');
  initQq(db);
  savePeer(db, { kind: KIND, id: CONV, label: '爸爸' }); syncQqOwner(db, CONV);
  const root = mkdtempSync(join(tmpdir(), 'dafeiyu-plan-'));
  const douyinDb = openDouyinDb(root);
  saveWork(douyinDb, { id: 'profile:1', title: '一条测试作品', publishedAt: '2026-11-15T02:00:00Z', status: 'published', createdAt: '2026-11-15T02:00:00Z' });
  douyinDb.close();
  const seen = [];
  const sent = [];
  const qq = service(db, {
    ask: async (input) => { seen.push(input); return '发过一条作品呀'; },
    planner: async () => ({ say: '我查查', steps: [{ tool: 'works.list', args: {} }], rejected: [], raw: '' }),
    sent,
  });
  qq.toolCtx = { root };
  const result = await qq.handle({ kind: KIND, id: CONV, messageId: 'p-1', text: '我发过哪些作品', attachments: [] });
  assert.equal(result.replied, 'text');
  // 模型只说了句空话、没给数字时，系统会把刚查到的事实补在后面，别让爸爸看不到数据。
  assert.match(sent[0].content, /^发过一条作品呀/);
  assert.match(sent[0].content, /一条测试作品/);
  assert.match(seen[0].facts, /一条测试作品/);
  assert.ok(factsText([{ tool: 'works.list', ok: true, text: 'x' }]).includes('works.list'));
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('服务：纯聊天走计划里的话，不再多调一次模型', async () => {
  const db = new DatabaseSync(':memory:');
  initQq(db);
  savePeer(db, { kind: KIND, id: CONV, label: '爸爸' }); syncQqOwner(db, CONV);
  let asked = 0;
  const sent = [];
  const qq = service(db, {
    ask: async () => { asked += 1; return '备用'; },
    planner: async () => ({ say: '爸爸今天辛苦啦～', steps: [], rejected: [], raw: '' }),
    sent,
  });
  await qq.handle({ kind: KIND, id: CONV, messageId: 'c-1', text: '陪我聊会天', attachments: [] });
  assert.equal(asked, 0);
  assert.equal(sent[0].content, '爸爸今天辛苦啦～');
  db.close();
});

test('服务：决策脑挂了就退回原来的对话路径', async () => {
  const db = new DatabaseSync(':memory:');
  initQq(db);
  savePeer(db, { kind: KIND, id: CONV, label: '爸爸' }); syncQqOwner(db, CONV);
  const sent = [];
  const qq = service(db, {
    ask: async () => '退回的答案',
    planner: async () => { throw new Error('planner_unavailable'); },
    sent,
  });
  const result = await qq.handle({ kind: KIND, id: CONV, messageId: 'f-1', text: '在吗', attachments: [] });
  assert.equal(result.replied, 'text');
  assert.equal(sent[0].content, '退回的答案');
  db.close();
});

test('任务跑完要主动汇报，且同一任务只报一次', async () => {
  const db = new DatabaseSync(':memory:');
  initQq(db);
  savePeer(db, { kind: KIND, id: CONV, label: '爸爸' }); syncQqOwner(db, CONV);
  const sent = [];
  const qq = service(db, {
    planner: async () => ({ say: '好，这就回', steps: [{ tool: 'douyin.reply_comments', args: {}, write: true }], rejected: [], raw: '' }),
    sent,
    execute: async () => ({ ok: true, text: '回复了 2 条评论' }),
  });
  await qq.handle({ kind: KIND, id: CONV, messageId: 'r-1', text: '把评论回一下', attachments: [] });
  await qq.handle({ kind: KIND, id: CONV, messageId: 'r-2', text: '同意', attachments: [] });
  const before = sent.length;
  qq.sweep();
  qq.sweep();
  assert.equal(sent.length, before, '确认时已经报过，sweep 不该重复报');
  // 换个没有任何回复的任务（比如被别处跑完的），sweep 要补一句。
  const task = db.prepare("SELECT id FROM external_tasks WHERE status='succeeded'").get();
  db.prepare("DELETE FROM agent_events WHERE dedupe_key=?").run(`task:${task.id}:reported`);
  qq.sweep();
  assert.equal(sent.length, before + 1);
  assert.match(sent.at(-1).content, /任务办完了/);
  db.close();
});

test('服务：主题只留短词，脏主题会被截断、旧待确认自动作废', async () => {
  const db = new DatabaseSync(':memory:');
  initQq(db);
  savePeer(db, { kind: KIND, id: CONV, label: '爸爸' }); syncQqOwner(db, CONV);
  const sent = [];
  const qq = service(db, {
    ask: async () => '不该被调用',
    planner: async () => ({ say: '好。', steps: [{ tool: 'douyin.publish', args: { theme: '标题：BLG夺冠那晚我尾巴撞桌角转三圈；正文：BLG夺冠那晚，我在桌面上尾巴一甩' }, write: true }], rejected: [], raw: '' }),
    sent,
  });
  await qq.handle({ kind: KIND, id: CONV, messageId: 'th-4', text: '再发一条作品，主题为BLG夺冠。', attachments: [] });
  await qq.handle({ kind: KIND, id: CONV, messageId: 'th-5', text: '再发一条作品，主题为BLG夺冠。', attachments: [] });
  const pending = db.prepare("SELECT id,payload FROM external_tasks WHERE conv_id=? AND status='awaiting_confirmation'").all(CONV);
  assert.equal(pending.length, 1);
  const theme = JSON.parse(pending[0].payload).theme;
  assert.equal(theme, 'BLG夺冠那晚我尾巴撞桌角转三圈');
  assert.ok(theme.length <= 24);
  db.close();
});


test('草稿阶段可以逐条改：「改 2：说话，就是新的正文」', async () => {
  const db = new DatabaseSync(':memory:');
  initQq(db); initTasks(db); initAgentEvents(db);
  savePeer(db, { kind: KIND, id: CONV, label: '爸爸' }); syncQqOwner(db, CONV);
  const dir = mkdtempSync(join(tmpdir(), 'dafeiyu-revise-'));
  const draftFile = join(dir, 'draft.json');
  const draft = { status: 'draft', title: '原标题', caption: '原正文', topics: ['#大肥鱼'], imageFile: '/tmp/x.png', draftFile };
  writeFileSync(draftFile, JSON.stringify(draft, null, 2));
  const sent = [];
  // 服务构造时会跑 initTasks 的过期扫描，任务必须在服务之后建，否则固定时钟会把任务判过期
  const qq = service(db, { sent });
  const task = proposeTask(db, { kind: KIND, convId: CONV, sourceMessageId: 'revise-1', intent: { intent: 'external_action_request', operations: ['douyin.publish'], target: 'user_requested', requires_confirmation: true }, origin: 'plan', now: Date.now() });
  approvePendingTask(db, task.id, 'owner'); startTask(db, task.id);
  assert.equal(markAwaitingPublish(db, task.id, { prepared: { ...draft, stage: 'draft' } }), true);
  const result = await qq.handle({ kind: KIND, id: CONV, messageId: 'revise-2', text: '改 2：说话，就是新的正文', attachments: [] });
  assert.equal(result.status, 'revised');
  const updated = JSON.parse(readFileSync(draftFile, 'utf8'));
  assert.equal(updated.caption, '说话，就是新的正文');
  assert.match(sent[0].content, /2\. 正文：说话，就是新的正文/);
  assert.match(sent[0].content, /1\. 标题：原标题/);
  const stillPending = db.prepare('SELECT status FROM external_tasks WHERE id=?').get(task.id);
  assert.equal(stillPending.status, 'awaiting_publish');
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('只读工具失手会自动重规划一次，并把这次重规划记进事件流', async () => {
  const db = new DatabaseSync(':memory:');
  initQq(db); initAgentEvents(db);
  savePeer(db, { kind: KIND, id: CONV, label: '爸爸' }); syncQqOwner(db, CONV);
  const sent = [];
  const plannerCalls = [];
  // 第一轮查天气失败，第二轮换个城市查成功——重规划必须「换一种查法」而不是原样重试。
  let fetches = 0;
  const fetchImpl = async () => {
    fetches += 1;
    if (fetches === 1) throw new Error('network_down');
    return new Response(JSON.stringify({
      current_condition: [{ lang_zh: [{ value: '晴' }], temp_C: '6', FeelsLikeC: '4', humidity: '40', windspeedKmph: '3' }],
      weather: [{ mintempC: '2', maxtempC: '11' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const qq = service(db, {
    ask: async ({ facts } = {}) => `我查到了：${String(facts ?? '').slice(0, 40)}`,
    planner: async ({ text }) => {
      plannerCalls.push(text);
      const second = /上一轮这些查法失败了/u.test(String(text));
      return {
        say: '我看看天气',
        steps: [{ tool: 'weather.get', args: { city: second ? '保定' : '石家庄' } }],
        rejected: [],
        raw: '',
      };
    },
    sent,
  });
  qq.toolCtx = { ...qq.toolCtx, fetchImpl };

  const result = await qq.handle({ kind: KIND, id: CONV, messageId: 'w-replan', text: '保定天气怎么样', attachments: [] });
  assert.equal(result.replied, 'text');
  assert.equal(plannerCalls.length, 2, '失手之后应该且只应该重规划一次');
  assert.match(plannerCalls[1], /network_down|出错/u);
  const replan = db.prepare("SELECT COUNT(*) AS n FROM agent_events WHERE event_type='replan_requested'").get();
  assert.equal(replan.n, 1);
  assert.match(String(sent.at(-1).content), /查到了/u);
  db.close();
});
