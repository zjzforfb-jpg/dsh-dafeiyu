// 「放行当天按什么顺序跑」——单一真源，/live 报告页与 docs/RELEASE-DAY.md 都从它来。
//
// 排序不是随意的：先把「最容易失败、但失败也不伤钱/不伤脸」的放前面，
// 让声卡、窗口识别、手机在线这些公共前置条件是逐个被验证过的，
// 而不是等跑到「公开发作品」时才发现声卡没切。

/** @type {{order:number, action:string, title:string, why:string, requires:string[], abortIf:string}[]} */
export const RELEASE_PLAN = [
  {
    order: 1,
    action: 'qq.call',
    title: '先给自己/家人打一通 QQ 语音',
    why: '验证三件公共前置一次到位：QQ 主窗标题读得到（屏幕录制）、voice-bridge 切得动声卡、语音桥能说话。后面所有通话类动作都靠这一条。',
    requires: ['qqWindow', 'qqBridgeSound', 'ownerTiming'],
    abortIf: '拨出去对方没响 / 响了但接起来听不到声音 / 挂断后声卡没恢复 → 先修声卡，别急着跑后面的。',
  },
  {
    order: 2,
    action: 'qq.hangup',
    title: '通话中试一次挂断',
    why: '同上一条同一通电话里就能验完，成本最低；它同时验证「能找到通话窗口」这件事。',
    requires: ['qqCallWindow'],
    abortIf: '挂断后窗口不消失 / 误挂到别的东西 → 说明窗口识别在漂，停。',
  },
  {
    order: 3,
    action: 'qq.call_mom',
    title: '再拨妈妈（不同联系人）',
    why: '验证「换联系人」这条路径（搜索→点人→拨号），而不是只对一个人有效。',
    requires: ['qqWindow', 'ownerTiming'],
    abortIf: '拨错人 → 立刻停，先修联系人匹配。',
  },
  {
    order: 4,
    action: 'wechat.call',
    title: '微信语音（换一个客户端）',
    why: '微信走的是另一套窗口识别（owner 名有「微信」与「WeChat」两种写法），单独验一次。',
    requires: ['wechatRunning', 'ownerTiming'],
    abortIf: '微信没启动 / 找不到窗口 → 先打开微信再重试一次；两次都不行才停。',
  },
  {
    order: 5,
    action: 'douyin.publish_draft',
    title: '发一条「已经审过」的草稿',
    why: '这是发布链路里风险最低的一段：草稿是现成的，人已经看过内容，只是把「点发作品」这条路走通。',
    requires: ['device', 'pendingDraft', 'ownerApproval'],
    abortIf: '点了发作品但作品页没新作品（publish_unconfirmed）→ 先人工看一眼手机，别重复发。',
  },
  {
    order: 6,
    action: 'douyin.publish_video',
    title: '发一条本地视频',
    why: '视频比图文多两步（media scanner + 剪辑页「下一步」），单独验，避免和图文混在一起排错。',
    requires: ['device', 'videoFile', 'ownerApproval'],
    abortIf: '卡在剪辑页（找不到「下一步」）→ 停，说明这个抖音版本的页面又变了。',
  },
  {
    order: 7,
    action: 'douyin.publish',
    title: '最后才跑「一条到底」的生成式发布',
    why: '它同时依赖「模型产出」和「发布链路」，两条都不可控；放最后，前面都稳了再跑。',
    requires: ['device', 'modelOk', 'ownerApproval'],
    abortIf: '生成内容不满意 → 用 douyin.draft 走两段式，不要硬发。',
  },
];

/** 按顺序给出「现在这一步该做什么」，已确认的动作自动跳过。 */
export function nextReleaseStep(items = []) {
  const confirmed = new Set(items.filter((item) => item.lastVerdict === 'confirmed').map((item) => item.action));
  const pending = RELEASE_PLAN.filter((step) => !confirmed.has(step.action));
  return {
    done: RELEASE_PLAN.filter((step) => confirmed.has(step.action)).map((step) => step.action),
    remaining: pending.map((step) => step.action),
    next: pending[0] ?? null,
    total: RELEASE_PLAN.length,
  };
}

/** 自检：7 个副作用动作必须都在计划里、order 连续、每条都写了中止条件。 */
export function validateReleasePlan(sideEffectActions = []) {
  const problems = [];
  const orders = RELEASE_PLAN.map((step) => step.order);
  if (orders.join(',') !== RELEASE_PLAN.map((_, index) => index + 1).join(',')) problems.push('order 必须从 1 连续');
  const planned = new Set(RELEASE_PLAN.map((step) => step.action));
  for (const action of sideEffectActions) if (!planned.has(action)) problems.push(`缺少动作：${action}`);
  for (const step of RELEASE_PLAN) {
    if (!step.why || step.why.length < 10) problems.push(`${step.action} 没写清为什么排这个位置`);
    if (!step.abortIf || step.abortIf.length < 10) problems.push(`${step.action} 没写清什么情况下停`);
    if (!Array.isArray(step.requires) || step.requires.length === 0) problems.push(`${step.action} 没写前置`);
  }
  return problems;
}
