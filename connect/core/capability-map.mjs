// P1-B · B-5：动作表 ↔ 工具表 ↔ 技能表 的**显式**映射。
//
// 以前这三张表各说各的：connect/actions.mjs 17 项、connect/qq/tools.mjs 12 项、
// connect/skills/defs.mjs 12 项。对不上的时候只能人肉数，比如 douyin.like_comments
// 在动作表里、矩阵里标 not_implemented，模型却能"假装"自己会给评论点赞。
//
// 现在一张表说清：每个动作对应哪个工具、哪个技能、属于哪个产品能力、什么状态、
// 有没有实现、风险等级多少。校验脚本与测试都拿这张表当准绳，
// 任何一边偷偷加了新动作/新工具/新技能而没登记，这里就会报出来。
import { CAPABILITIES, capabilityById } from '../memory/capabilities.mjs';
import { isCapabilityStatus, normalizeStatus } from './capability.mjs';

/**
 * 17 项自主动作的映射。
 * - action: connect/actions.mjs 的键（null = 只有工具/技能、没有自主动作）
 * - tool: connect/qq/tools.mjs 的工具名（null = 没有对应工具）
 * - skill: connect/skills/defs.mjs 的技能 id（null = 没有对应技能）
 * - capability: 产品能力卡 id（connect/memory/capabilities.mjs）
 * - status: 统一词表（connect/core/capability.mjs）
 * - implemented: 真做了还是只占位（false 的动作不允许在提示词里承诺）
 * - risk: R0 只读 / R2 可自动 / R3 需人工确认
 * - prompt: 给决策脑看的「你能做的事」那一行（null = 不进提示词）
 */
export const CAPABILITY_MAP = Object.freeze([
  {
    action: 'academy.study', label: '去成长学院学一课', capability: 'academy',
    tool: null, skill: 'academy.study', status: 'stable', implemented: true, risk: 'R2',
    prompt: '去成长学院学一课（动作 academy.study）',
  },
  {
    action: 'academy.weekly', label: '写成长周记', capability: 'academy',
    tool: 'academy.weekly', skill: 'academy.weekly', status: 'stable', implemented: true, risk: 'R2',
    prompt: '写一周的成长周记（动作 academy.weekly）',
  },
  {
    action: 'douyin.hotspot', label: '看今天有什么热点', capability: 'hot-comments',
    // 2026-11-18 下线：抖音搜索页改成「视频流」形态，结果列表读不到，见 docs/TOOL-RUNBOOK.md。
    offline: true, status: 'disabled', tool: 'douyin.hotspot', skill: 'douyin.hotspot', implemented: false, risk: 'R0',
    prompt: null,
  },
  {
    action: 'douyin.reply_comments', label: '回复收到的评论', capability: 'reply-inbox',
    tool: 'douyin.reply_comments', skill: 'douyin.reply_comments', status: 'stable', implemented: true, risk: 'R2',
    prompt: '回复抖音评论/互动消息（动作 douyin.reply_comments）',
  },
  {
    action: 'douyin.hot_comment_round', label: '去爆款视频底下回热评', capability: 'hot-comments',
    tool: 'douyin.hot_comment_round', skill: 'douyin.hot_comment_round', status: 'stable', implemented: true, risk: 'R2',
    prompt: null,
  },
  {
    action: 'douyin.like_comments', label: '给抖音相关评论点赞', capability: 'reply-inbox',
    tool: null, skill: 'douyin.like_comments', status: 'disabled', implemented: false, risk: 'R3',
    prompt: null, offline: true,
    note: '2026-11-18 下线：抖音适配层没有可验证的点赞动作，留在动作表里只会让规划器以为「能点赞」',
  },
  {
    action: 'douyin.check_interactions', label: '看抖音有没有新互动', capability: 'reply-inbox',
    tool: 'douyin.check_interactions', skill: 'douyin.check_interactions', status: 'prototype', implemented: true, risk: 'R0',
    prompt: '想去看抖音有没有新互动时，直接说想去看；真正去看由系统调用工具，你不要输出 [DO:...] 标记。',
  },
  {
    action: 'douyin.comment_latest', label: '给对标账号最新作品评论', capability: 'hot-comments',
    tool: null, skill: 'douyin.comment_latest', status: 'prototype', implemented: true, risk: 'R2',
    prompt: '给对标账号最新作品发一条可爱评论（动作 douyin.comment_latest）',
  },
  {
    action: 'douyin.browse', label: '刷一会儿抖音', capability: 'device-layer',
    tool: 'device.page', skill: 'douyin.browse', status: 'stable', implemented: true, risk: 'R0',
    prompt: null,
  },
  {
    action: 'douyin.prepare', label: '准备一条抖音图文（写好先给爸爸审）', capability: 'publishing',
    tool: null, skill: null, status: 'disabled', implemented: false, risk: 'R3',
    prompt: null, offline: true,
    note: '2026-11-18 下线：旧一审流程，已被 douyin.draft → douyin.publish_draft 的两段式握手取代',
  },
  {
    action: 'douyin.draft', label: '写一条抖音图文草稿（先审内容）', capability: 'publishing',
    tool: 'douyin.publish', skill: 'douyin.draft', status: 'stable', implemented: true, risk: 'R2',
    prompt: '写并发布一条抖音图文（动作 douyin.publish）：先答应「我这就去写」，系统会生成图片+文案并发布',
  },
  {
    action: 'douyin.publish_draft', label: '按审过的内容发一条抖音图文', capability: 'publishing',
    tool: null, skill: 'douyin.publish_draft', status: 'stable', implemented: true, risk: 'R3',
    prompt: null,
  },
  {
    action: 'douyin.publish', label: '发布审核过的抖音图文', capability: 'publishing',
    tool: 'douyin.publish', skill: null, status: 'prototype', implemented: true, risk: 'R3',
    prompt: null,
  },
  {
    action: 'douyin.publish_video', label: '发布一条本地视频到抖音', capability: 'publishing',
    tool: 'douyin.publish_video', skill: null, status: 'prototype', implemented: true, risk: 'R3',
    prompt: null,
  },
  {
    action: 'qq.call', label: '给爸爸打电话', capability: 'qq-bridge',
    tool: 'qq.call', skill: null, status: 'stable', implemented: true, risk: 'R2',
    prompt: '给爸爸打电话：QQ 拨七海 [DO:qq.call]',
  },
  {
    action: 'qq.call_mom', label: '给妈妈打电话', capability: 'qq-bridge',
    tool: 'qq.call_mom', skill: null, status: 'stable', implemented: true, risk: 'R2',
    prompt: '给妈妈打电话：QQ 拨小朋友 [DO:qq.call_mom]',
  },
  {
    action: 'wechat.call', label: '用微信给妈妈打电话', capability: 'qq-bridge',
    tool: 'wechat.call', skill: null, status: 'stable', implemented: true, risk: 'R2',
    prompt: '给妈妈打电话：微信拨敢敢不憨了 [DO:wechat.call]',
  },
  {
    action: 'qq.hangup', label: '挂断 QQ 通话', capability: 'qq-bridge',
    tool: 'qq.hangup', skill: null, status: 'stable', implemented: true, risk: 'R0',
    prompt: '挂断：QQ 通话 [DO:qq.hangup]',
  },
]);

/** 只有工具、没有自主动作的（只读/元信息工具，不需要任务审批）。 */
export const TOOL_ONLY = Object.freeze([
  { action: null, label: '查天气', capability: 'planner-tools', tool: 'weather.get', skill: null, status: 'stable', implemented: true, risk: 'R0',
    prompt: '查天气（系统已自动提供当天天气数据）' },
  { action: null, label: '看自己的作品', capability: 'publishing', tool: 'works.list', skill: null, status: 'stable', implemented: true, risk: 'R0' },
  { action: null, label: '看评论表', capability: 'reply-inbox', tool: 'comments.list', skill: null, status: 'stable', implemented: true, risk: 'R0' },
  { action: null, label: '读能力卡', capability: 'stores', tool: 'capability.read', skill: null, status: 'stable', implemented: true, risk: 'R0' },
  { action: null, label: '读能力源码', capability: 'stores', tool: 'capability.code', skill: null, status: 'stable', implemented: true, risk: 'R0', ownerOnly: true },
]);

/** 只有技能、没有自主动作的（技能账本里的记账项）。 */
export const SKILL_ONLY = Object.freeze([
  { action: null, label: '抓作品数据', capability: 'board', tool: null, skill: 'douyin.crawl_stats', status: 'stable', implemented: true, risk: 'R0' },
]);

export const ALL_ROWS = Object.freeze([...CAPABILITY_MAP, ...TOOL_ONLY, ...SKILL_ONLY]);

export function actionEntry(action) {
  return CAPABILITY_MAP.find((row) => row.action === action) ?? null;
}

export function toolEntry(tool) {
  return ALL_ROWS.find((row) => row.tool === tool) ?? null;
}

export function skillEntry(skill) {
  return ALL_ROWS.find((row) => row.skill === skill) ?? null;
}

/** 没实现的动作（提示词不许承诺，测试不许当成已完成）。 */
export function unimplementedActions() {
  return CAPABILITY_MAP.filter((row) => !row.implemented).map((row) => row.action);
}

/** 映射表自身的一致性体检：状态词表、capability 卡是否真实存在。 */
export function mapProblems() {
  const problems = [];
  for (const row of ALL_ROWS) {
    if (!isCapabilityStatus(row.status)) problems.push(`${row.action ?? row.tool ?? row.skill}: 状态非法 ${row.status}`);
    if (row.capability && !capabilityById(row.capability)) problems.push(`${row.action ?? row.tool ?? row.skill}: 未知能力卡 ${row.capability}`);
  }
  const seenAction = new Set();
  for (const row of ALL_ROWS) {
    if (!row.action) continue;
    if (seenAction.has(row.action)) problems.push(`动作重复登记 ${row.action}`);
    seenAction.add(row.action);
  }
  return problems;
}

/** 三张表对齐情况：动作（不含已下线）/ 工具 / 技能 是否都登记进来了。 */
export function mapReport() {
  // offline 的行只留档，不算进「现在能做的动作」
  const actions = CAPABILITY_MAP.filter((row) => row.action && !row.offline).map((row) => row.action);
  // offline 的行只留档：工具与技能也不该再算进「现在能用」的清单
  const live = ALL_ROWS.filter((row) => !row.offline);
  const tools = [...new Set(live.map((row) => row.tool).filter(Boolean))];
  const skills = [...new Set(live.map((row) => row.skill).filter(Boolean))];
  return {
    actions: actions.length,
    tools: tools.length,
    skills: skills.length,
    actionNames: actions,
    toolNames: tools,
    skillNames: skills,
    problems: mapProblems(),
  };
}

/** 反向索引：一个工具/技能背后有哪几个动作（douyin.publish 工具同时服务 draft 与 publish 两个动作）。 */
export function actionsForTool(tool) {
  return ALL_ROWS.filter((row) => row.tool === tool && row.action).map((row) => row.action);
}

export function actionsForSkill(skill) {
  return ALL_ROWS.filter((row) => row.skill === skill && row.action).map((row) => row.action);
}

// ── 决策脑的动作菜单（原来硬编码在 connect/qq/brain.mjs 里，现在从这张表渲染）──

export const BRAIN_RULES = Object.freeze({
  identity: '谁是谁：QQ 里「七海」=爸爸，「小朋友」=妈妈；微信里「敢敢不憨了」=妈妈。有人打电话进来时按这个判断是谁，称呼要对。',
  footer: '当爸爸让你做上述事情时：先答应（「好，我马上去做」或「现在在忙，过一会儿就去做」），并在回复末尾加上对应动作标签，例如 [DO:douyin.reply_comments]，系统会真的去执行。绝对不要回答「没有权限」「做不了」。',
});

/** 渲染「你能做的事」提示词：只渲染已实现的动作，别把占位动作承诺出去。 */
export function actionMenuPrompt({ include = null } = {}) {
  const rows = [
    ...CAPABILITY_MAP.filter((row) => row.prompt && row.implemented),
    // 只读工具里那些「主人会直接口头提」的也要留在菜单里，否则提示词会丢信息
    // （例：查天气由系统自动提供当天数据，brain 不说主人就不知道有这回事）。
    ...TOOL_ONLY.filter((row) => row.prompt && row.implemented),
  ].filter((row) => !include || include.includes(row.action ?? row.tool));
  const lines = [
    '你能做的事（不要说自己没权限）：',
    ...rows.map((row) => `- ${row.prompt}`),
    BRAIN_RULES.identity,
    BRAIN_RULES.footer,
  ];
  return lines.join('\n');
}

export { normalizeStatus, CAPABILITIES };
