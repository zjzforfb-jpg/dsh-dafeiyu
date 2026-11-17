import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APPROVE_WORDS, DECLINE_WORDS, REVISE_PATTERN,
  LEARNING_LIST_WORDS, LEARNING_APPROVE_PATTERN, LEARNING_REJECT_PATTERN,
  MEMORY_COMMANDS, ROUTES, parseSlashCommand, routePolicy,
} from '../connect/core/route.mjs';

// P0-B 验收：六段路由决策表。routePolicy() 是「这句话归谁管」的唯一裁决，
// 这里逐条钉住 6 段（审批响应 / 学习命令 / 规则意图 / peer 门 / 群聊忽略 / 斜杠命令 / 聊天）。

const ownerCtx = {
  kind: 'c2c', hasPlanner: true, pendingTask: { id: 't1' },
  canApprove: true, canPropose: true, canReadMemory: true,
  allowed: { enabled: true, autoReply: true, voiceReply: true },
};

test('① 待确认任务 + 拒绝词 → decline', () => {
  const r = routePolicy('算了', ownerCtx);
  assert.equal(r.route, ROUTES.decline);
});

test('① 待确认任务 + 同意词 → approve', () => {
  const r = routePolicy('同意', ownerCtx);
  assert.equal(r.route, ROUTES.approve);
});

test('① 待确认任务 + 改稿「改2：新正文」→ revise 且抓到字段', () => {
  const r = routePolicy('改 2：今天说话就是新的正文', ownerCtx);
  assert.equal(r.route, ROUTES.revise);
  assert.equal(r.args.field, 'caption');
  assert.equal(r.args.value, '今天说话就是新的正文');
});

test('② 学习提案列表 → learning_list', () => {
  const r = routePolicy('提案', ownerCtx);
  assert.equal(r.route, ROUTES.learning_list);
});

test('② 批准学习提案 → learning_approve 且带 token', () => {
  const r = routePolicy('批准R12', ownerCtx);
  assert.equal(r.route, ROUTES.learning_approve);
  assert.equal(r.token, '12');
});

test('② 驳回学习提案 → learning_reject 且带 token', () => {
  const r = routePolicy('驳回R12', ownerCtx);
  assert.equal(r.route, ROUTES.learning_reject);
  assert.equal(r.token, '12');
});

test('③ 无决策脑 + 外部动作意图 → external_intent（带需确认）', () => {
  const r = routePolicy('回复抖音评论', { ...ownerCtx, hasPlanner: false, pendingTask: null });
  assert.equal(r.route, ROUTES.external_intent);
  assert.equal(r.requires_confirmation, true);
  assert.ok(r.intent);
});

test('③ 有决策脑 + 私聊时意图交给模型（不走正则）→ chat', () => {
  // 同一句话在「有 planner 的私聊」里不该被正则劫持成 external_intent。
  const r = routePolicy('回复抖音评论', { ...ownerCtx, pendingTask: null });
  assert.equal(r.route, ROUTES.chat);
});

test('④ 记忆命令但无读记忆权 → hold/memory_scope_denied', () => {
  const r = routePolicy('/记忆', { ...ownerCtx, canReadMemory: false, pendingTask: null });
  assert.equal(r.route, ROUTES.hold);
  assert.equal(r.reason, 'memory_scope_denied');
});

test('④ 记忆命令且有权 → command/memory_list', () => {
  const r = routePolicy('/记忆', ownerCtx);
  assert.equal(r.route, ROUTES.command);
  assert.equal(r.command, 'memory_list');
});

test('④ peer 未开自动回复 → hold', () => {
  const r = routePolicy('你好', {
    ...ownerCtx, pendingTask: null,
    allowed: { enabled: true, autoReply: false },
  });
  assert.equal(r.route, ROUTES.hold);
});

test('⑤ 群聊 @ 别人 → ignore/addressed_to_others', () => {
  const r = routePolicy('小张你看看', {
    ...ownerCtx, kind: 'group', pendingTask: null,
    atMe: false, mentionOthers: true,
  });
  assert.equal(r.route, ROUTES.ignore);
  assert.equal(r.reason, 'addressed_to_others');
});

test('⑤ 群聊没被点名 → ignore/ambient_skip', () => {
  const r = routePolicy('今天天气真好', {
    ...ownerCtx, kind: 'group', pendingTask: null,
    atMe: false, mentionOthers: false, mentionAll: false,
  });
  assert.equal(r.route, ROUTES.ignore);
  assert.equal(r.reason, 'ambient_skip');
});

test('⑤ 群聊 @全体 但没提大肥鱼 → ignore/mention_all_skip', () => {
  const r = routePolicy('大家注意一下', {
    ...ownerCtx, kind: 'group', pendingTask: null,
    atMe: false, mentionOthers: false, mentionAll: true,
  });
  assert.equal(r.route, ROUTES.ignore);
  assert.equal(r.reason, 'mention_all_skip');
});

test('⑤ 群聊 @全体 且提到大肥鱼 → 仍是 ignore/ambient_skip（是否插话由上层 shouldJoinAmbient 裁）', () => {
  const r = routePolicy('大肥鱼你在吗', {
    ...ownerCtx, kind: 'group', pendingTask: null,
    atMe: false, mentionOthers: false, mentionAll: true,
  });
  assert.equal(r.route, ROUTES.ignore);
  assert.equal(r.reason, 'ambient_skip');
});

test('⑤ 群聊 @全体 且提到大肥鱼时不会落 mention_all_skip', () => {
  const r = routePolicy('大肥鱼你在吗', {
    ...ownerCtx, kind: 'group', pendingTask: null,
    atMe: false, mentionOthers: false, mentionAll: true,
  });
  assert.notEqual(r.reason, 'mention_all_skip');
});

test('⑥ 非记忆斜杠命令「/语音开」→ command/voice_toggle 且解析出 enabled', () => {
  const r = routePolicy('/语音 开', ownerCtx);
  assert.equal(r.route, ROUTES.command);
  assert.equal(r.command, 'voice_toggle');
  assert.equal(r.args.enabled, true);
});

test('⑥ 「/记住：xxx」有读记忆权 → command/memory_save', () => {
  const r = routePolicy('/记住：爸爸喜欢喝咖啡', ownerCtx);
  assert.equal(r.route, ROUTES.command);
  assert.equal(r.command, 'memory_save');
  assert.equal(r.args.content, '爸爸喜欢喝咖啡');
});

test('⑦ 普通聊天 → chat', () => {
  const r = routePolicy('你好呀', { ...ownerCtx, pendingTask: null });
  assert.equal(r.route, ROUTES.chat);
});

test('⑦ 空消息 + 无待办 → chat（交给上层判空）', () => {
  const r = routePolicy('', { ...ownerCtx, pendingTask: null });
  assert.equal(r.route, ROUTES.chat);
});

test('没有待确认任务时，同意词不会被误判成 approve → chat', () => {
  const r = routePolicy('同意', { ...ownerCtx, pendingTask: null });
  assert.notEqual(r.route, ROUTES.approve);
});

test('parseSlashCommand 解析记忆更正', () => {
  const cmd = parseSlashCommand('/更正记忆 #3：他喜欢喝茶');
  assert.equal(cmd.command, 'memory_revise');
  assert.equal(cmd.args.id, '3');
  assert.equal(cmd.args.content, '他喜欢喝茶');
});

test('MEMORY_COMMANDS 覆盖四类记忆命令', () => {
  assert.deepEqual([...MEMORY_COMMANDS].sort(), ['memory_forget', 'memory_list', 'memory_revise', 'memory_save']);
});

test('正则常量：拒绝/同意词边界锚定', () => {
  assert.ok(DECLINE_WORDS.test('算了'));
  assert.ok(!DECLINE_WORDS.test('算了吧这个'));
  assert.ok(APPROVE_WORDS.test('发'));
  assert.ok(!APPROVE_WORDS.test('发发发'));
  assert.ok(REVISE_PATTERN.test('改1：新标题'));
  assert.ok(!REVISE_PATTERN.test('改4：越界'));
  assert.ok(LEARNING_APPROVE_PATTERN.test('采纳R7'));
  assert.ok(LEARNING_REJECT_PATTERN.test('跳过R7'));
});
