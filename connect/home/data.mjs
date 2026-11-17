// 「主页」的数据：这个项目到底用了什么、每个环节谁在干活。
//
// 写成一数据表而不是散在 HTML 里，理由有两个：
// 1) 测试可以校验（每条流水线都得有职责说明和代码位置，不许留空）；
// 2) 以后加一层、换个文件，只改这里，页面自动跟着变。
//
// 注意：`files` 里写的是「真实存在的入口」，不是猜测的路径 ——
// tests/home.test.mjs 会去 repo 里逐个确认文件存在。

export const STACK = Object.freeze([
  {
    group: '运行时',
    items: [
      { name: 'Node.js 24', note: '全部服务与脚本的运行时（/opt/homebrew/opt/node@24）', where: 'package.json · engines', paths: ['package.json'] },
      { name: 'node:sqlite (DatabaseSync)', note: '三库直连，不引第三方 ORM：connect / douyin / memory', where: 'connect/server.mjs · connect/douyin/store.mjs', paths: ['connect/server.mjs', 'connect/douyin/store.mjs'] },
      { name: 'launchd', note: '三个常驻服务：pet(3108) / connect(8765) / qq-answer 自动接听', where: 'scripts/service.mjs', paths: ['scripts/service.mjs'] },
    ],
  },
  {
    group: '渠道接入',
    items: [
      { name: 'QQ 官方机器人', note: 'WebSocket 网关收发消息，主人私聊带审批', where: 'connect/qq/gateway.mjs · connect/qq/service.mjs', paths: ['connect/qq/gateway.mjs', 'connect/qq/service.mjs'] },
      { name: 'iLink（微信）', note: '长轮询拉消息 + 主动推送，跨渠道共享预算', where: 'connect/ilink/store.mjs · connect/ilink/worker.mjs', paths: ['connect/ilink/store.mjs', 'connect/ilink/worker.mjs'] },
      { name: '语音通话', note: 'QQ/微信语音，macui 点界面接听，本地语音桥对聊', where: 'connect/call/service.mjs · scripts/qq-call.mjs', paths: ['connect/call/service.mjs', 'scripts/qq-call.mjs'] },
      { name: 'Android 设备', note: 'ADB 驱动手机：打开抖音、滑动、读界面文字', where: 'device/uia.mjs · connect/server.mjs（WS /device）', paths: ['device/uia.mjs', 'connect/server.mjs'] },
      { name: 'macOS UI 自动化', note: 'Swift 辅助程序读窗口、模拟点击（屏幕录制 + 辅助功能）', where: 'connect/macui/windows.swift · connect/macui/click.swift', paths: ['connect/macui/windows.swift', 'connect/macui/click.swift'] },
    ],
  },
  {
    group: '服务与页面',
    items: [
      { name: 'HTTP 服务（无框架）', note: '一个 createServer 路由全部页面与接口，令牌走 Bearer/query', where: 'connect/server.mjs', paths: ['connect/server.mjs'] },
      { name: 'SSE 实时推送', note: '/api/live/stream 增量推事件，前端不轮询、不跑 rAF', where: 'connect/live/api.mjs', paths: ['connect/live/api.mjs'] },
      { name: 'three.js 0.170（本地化）', note: '3D 架构图，只有打开且前台时才渲染', where: 'connect/arch/vendor/three.module.js', paths: ['connect/arch/vendor/three.module.js'] },
      { name: 'Brain 模型代理', note: 'DeepSeek 模型入口，负责提示词、记忆、工具规划', where: 'brain/server.mjs（:3110）', paths: ['brain/server.mjs'] },
      { name: 'dsh-pet 桌宠', note: '桌面常驻形象与语音入口（第三方包 + 本地壳）', where: 'scripts/run-pet.mjs（:3108）', paths: ['scripts/run-pet.mjs'] },
    ],
  },
  {
    group: '数据',
    items: [
      { name: 'connect.sqlite', note: '事件、任务、审批、预算、计划槽（user_version=2）', where: 'runtime/connect/connect.sqlite', paths: ['runtime/connect/connect.sqlite'] },
      { name: 'douyin.db', note: '作品、评论、热点、草稿（user_version=1）', where: 'runtime/douyin/douyin.db', paths: ['runtime/douyin/douyin.db'] },
      { name: 'memory.sqlite', note: '记忆、能力卡、技能账本（user_version=15）', where: 'runtime/dsh-home/dafeiyu-memory.sqlite', paths: ['runtime/dsh-home/dafeiyu-memory.sqlite'] },
    ],
  },
]);

import { PIPELINE } from '../core/pipeline.mjs';

/**
 * 九段流水线的展示文案。
 * 结构与代码位置**直接来自 connect/core/pipeline.mjs**，这里只写「给人看的职责」，
 * 所以加阶段、换文件时不用再改这个文件，页面也不会写着写着就过期。
 */
const DUTIES = Object.freeze({
  entry: '收消息：QQ / 微信 / 通话 / 桌宠 / 安卓 / 看板，统一落成一条入站事件。',
  observe: '看世界：读手机当前页面、抓抖音数据、看评论与作品，产出观察事件。',
  route: '判意图：这句话是要聊天、要任务，还是要拒绝/确认；规则先过、模型兜底，结论落 route_decision。',
  task: '建任务：外部动作落 external_tasks，自主任务落 working_tasks，同一意图只建一个（幂等键）。',
  gate: '把关：策略判定 + 人工确认。R3 发布类必须 owner 点头，拒绝也要记事件。',
  act: '干活：17 个动作一个出口，跑脚本或点界面，开始/结束/失败都留痕。',
  verify: '验收：动作说完了不算数。拿期望对实际，落 confirmed / unconfirmed / mismatched，每步快照可续跑。',
  memory: '记住：把发生过的事写进记忆，把同类任务的教训带进下一次规划。',
  call: '打电话：拨号 → 等接通（每秒读窗口判接通/拒接/无人接）→ 语音对聊 → 记结局。',
});

export const PIPELINES = Object.freeze(PIPELINE.map((stage) => ({
  id: stage.id,
  label: stage.label,
  duty: DUTIES[stage.id] ?? stage.sub,
  files: stage.files,
  events: stage.events,
})));

/** 校验数据完整：每条流水线都要有职责、文件、事件；id 不重复。 */
export function validateData(data = { stack: STACK, pipelines: PIPELINES }) {
  const problems = [];
  const seen = new Set();
  for (const line of data.pipelines) {
    if (!line.id) problems.push('流水线缺 id');
    if (seen.has(line.id)) problems.push(`流水线 id 重复：${line.id}`);
    seen.add(line.id);
    if (!line.label) problems.push(`流水线 ${line.id} 缺 label`);
    if (!line.duty || line.duty.length < 10) problems.push(`流水线 ${line.id} 缺职责说明`);
    if (!Array.isArray(line.files) || !line.files.length) problems.push(`流水线 ${line.id} 缺代码位置`);
    if (!Array.isArray(line.events) || !line.events.length) problems.push(`流水线 ${line.id} 缺事件`);
  }
  for (const group of data.stack) {
    if (!group.group) problems.push('技术栈缺分组名');
    if (!Array.isArray(group.items) || !group.items.length) problems.push(`技术栈「${group.group}」为空`);
    for (const item of group.items ?? []) {
      if (!item.name || !item.note) problems.push(`技术栈「${group.group}」有条目缺名字或说明`);
      if (!Array.isArray(item.paths) || !item.paths.length) problems.push(`技术栈「${item.name}」缺可核对的代码位置`);
    }
  }
  return problems;
}
