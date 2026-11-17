// 能力记忆：渐进式披露。索引常驻提示词（很小），需要细节时用 capability.read(id)，
// 需要看实现时用 capability.code(id, path) 只读该能力登记过的文件。
// 新增功能时：往 CAPABILITIES 加一条 + 在 scripts/capabilities.mjs --check 里过一遍。
import { existsSync, readFileSync } from 'node:fs';
import { projectRoot } from '../core/paths.mjs';
import { join, resolve, sep } from 'node:path';
import { normalizeStatus } from '../core/capability.mjs';

export const CAPABILITIES = [
  {
    id: "publishing",
    title: "发图文",
    one: "生成→编号审核→填页→发布",
    status: "stable",
    aliases: ["发图文", "发作品", "发一条", "发布", "图文", "prepare", "publish", "draft"],
    tags: ["douyin", "发布", "审批"],
    files: ["connect/actions.mjs", "scripts/douyin-post.mjs", "scripts/douyin-confirm.mjs", "connect/douyin/store.mjs", "connect/qq/service.mjs"],

    input: "主人一句话要求写图文（可带主题）",
    output: "草稿（标题/正文/话题/配图）→ 编号发主人过一审 → 点头后发布",
    version: "1.0",
    permissions: ["conversation.reply", "task.propose", "task.approve"],
    dependencies: ["planner-tools", "device-layer"],
    validation: "草稿必须带 draftFile；发布回执要含作品编号 DFY-xxxx",
    atomic: [{ id: "douyin_publish", label: "抖音发布", status: "prototype" , note: "原型能力，必须经过审批和真实回执。", scope: "always", order: 80}],
    detail: `# 发图文（publishing）

两次审核的发布链路：先生成内容存草稿（不碰手机），编号发给爸爸审；同意后才填抖音发布页并发出去。

入口：
- 动作：douyin.draft（scripts/douyin-post.mjs --plan）、douyin.publish_draft（--draft + douyin-confirm.mjs）
- 任务：proposeTask → approvePendingTask → startTask → markAwaitingPublish（stage=draft）
- 作品库：works 表；草稿 status='draft' 不占编号，发布时 publishDraft 补 DFY-xxxx
- 看板：内容页可编辑草稿（标题/正文/话题/设置/单图），点「发布到抖音」走 /api/board/draft/publish

状态：单图可发；多图补选未做通（DAFEIYU_MULTI_IMAGE=1 关着）。
已知坑：发布页「继续编辑作品」弹窗会让后续坐标点击落空。`,
  },
  {
    id: "reply-inbox",
    title: "回评论",
    one: "互动消息→收到的评论→内联回复",
    status: "stable",
    aliases: ["回评论", "回复评论", "互动消息", "收件箱", "reply", "inbox"],
    tags: ["douyin", "评论", "互动"],
    files: ["device/douyin.mjs", "scripts/douyin.mjs", "connect/douyin/compliance.mjs", "connect/actions.mjs", "connect/douyin/store.mjs"],

    input: "收到的评论列表（消息 → 互动消息 → 收到的评论）",
    output: "逐条回复并写回 comments 表",
    version: "1.0",
    permissions: ["conversation.reply", "external.execute:r2"],
    dependencies: ["device-layer", "compliance"],
    validation: "发送后要么文本可见、要么回复框收起；两条间隔 ≥90 秒、每天 ≤30 条",
    atomic: [{ id: "douyin_read_interactions", label: "抖音读取互动", status: "prototype" , note: "原型能力，必须经过任务确认。", scope: "always", order: 50}, { id: "douyin_reply_comments", label: "抖音回复评论", status: "prototype" , note: "原型能力，必须经过任务确认和真实回执。", scope: "always", order: 60}, { id: "douyin_like_comments", label: "抖音点赞", status: "not_implemented" , note: "尚未实现。", scope: "always", order: 70}],
    detail: `# 回评论（reply-inbox）

路径：消息 tab → 互动消息行 → 顶部「互动消息」筛选 → 「收到的评论」→ 行内「回复评论」→ 内联输入框 → 发送。

入口：
- openCommentInbox / parseCommentInbox（device/douyin.mjs）
- scripts/douyin.mjs --reply-inbox --generate [--limit N]
- 动作 douyin.reply_comments；合规闸门 checkComment（90 秒/条，30 条/天，24h 去重）
- 发送校验：文本可见 或 回复框收起；回复写 comments 表 + replied.json 去重

已知坑：回复完 App 常停在横屏流，回列表前要 backToFeed；too_fast 要等 96 秒重试而不是记失败。`,
  },
  {
    id: "hot-comments",
    title: "爆款热评",
    one: "搜索热视频→评论区取高赞→回复",
    status: "beta",
    aliases: ["热评", "爆款", "hot", "热门评论"],
    tags: ["douyin", "评论", "发现"],
    files: ["connect/douyin/discover.mjs", "device/douyin.mjs", "scripts/douyin.mjs", "connect/douyin/store.mjs"],

    input: "关键词（默认大肥鱼）",
    output: "热视频高赞评论的可爱回复",
    version: "1.0",
    permissions: ["conversation.reply", "external.execute:r2"],
    dependencies: ["reply-inbox", "device-layer"],
    validation: "每轮最多 2 视频 × 2 条；仍受 90 秒限速",
    atomic: [],
    detail: `# 爆款热评（hot-comments）

搜索关键词 → 按点赞筛热视频 → 点封面进详情 → 开评论区 → 按赞数取前 N 条 → 生成可爱回复 → 合规闸门 → 发送。

入口：
- runHotCommentRound（connect/douyin/discover.mjs）
- scripts/douyin.mjs --hot-comment-round --videos 2 --per-video 2 --generate
- 动作 douyin.hot_comment_round；每日 5 轮 × 4 条（日程 12:00/14:00/16:00/18:30/21:00）
- 落库 videos / hot_comments；粉丝记入 fans

状态：真机跑通过，偶发 comments_empty / card_missing（时序问题）。
安全：SKIP_TOPIC 过滤沉重题材；评论仍受 90 秒限速。`,
  },
  {
    id: "planner-tools",
    title: "决策脑与工具",
    one: "模型规划 steps→执行→事实回灌",
    status: "stable",
    aliases: ["决策", "规划", "工具", "planner", "steps", "意图"],
    tags: ["qq", "模型", "核心"],
    files: ["connect/qq/planner.mjs", "connect/qq/tools.mjs", "connect/qq/service.mjs", "connect/qq/lessons.mjs"],

    input: "一条消息 + 历史 + 记忆 + 能力索引",
    output: "{say, steps[]} 计划；只读工具结果作为事实回灌",
    version: "1.0",
    permissions: ["conversation.reply", "memory.read.owner"],
    dependencies: ["memory-hub"],
    validation: "写工具只能建任务不能直接执行；空承诺要重规划；50 次/天模型预算",
    atomic: [{ id: "chat_text", label: "文字聊天", status: "stable" , note: "可用。", scope: "always", order: 10}, { id: "chat_voice_in", label: "语音输入", status: "stable" , note: "可用；回复默认使用音频文件。", scope: "always", order: 20}],
    detail: `# 决策脑与工具（planner-tools）

每条 QQ 消息先给 planner：输出 {say, steps:[{tool,args}]}；只读工具立即执行，结果作为事实回灌给模型；写工具只建任务等爸爸确认。

入口：
- qqPlanner（connect/qq/planner.mjs），prompt 在 PERSONA/SCHEMA
- READONLY_TOOLS / WRITE_TOOLS / normalizeSteps / runTool（connect/qq/tools.mjs）
- service.handle 的顺序：审批 → planner → 读工具 → 事实 → 回复 → 写任务

状态：纯聊天不调工具；写操作必须落任务；有 50 次/天模型预算。
已知坑：工具 ok 只代表命令没崩，不代表事情做成（步骤校验缺口，P0 待做）。`,
  },
  {
    id: "qq-bridge",
    title: "QQ 通道",
    one: "收发消息/审批/发件箱",
    status: "stable",
    aliases: ["QQ", "消息", "审批", "网关", "outbox", "私聊", "群聊"],
    tags: ["qq", "渠道"],
    files: ["connect/qq/service.mjs", "connect/qq/gateway.mjs", "connect/qq/api.mjs", "connect/qq/outbox.mjs", "connect/server.mjs"],

    input: "QQ 消息 / 审批词",
    output: "回复文本或语音、审批结果、动作回执",
    version: "1.0",
    permissions: ["conversation.reply", "task.approve"],
    dependencies: ["planner-tools"],
    validation: "外部动作一律落任务；未收到确认不执行",
    atomic: [{ id: "voice_file_out", label: "语音文件回复", status: "stable" , note: null, scope: "none", order: 95}, { id: "native_voice_out", label: "微信原生语音气泡", status: "disabled" , note: "已关闭。", scope: "always", order: 30}, { id: "external_actions", label: "外部动作", status: "disabled" , note: "当前统一停在任务确认层，未收到确认和真实回执不会执行。", scope: "always", order: 40}, { id: "group_external_actions", label: "群聊外部动作", status: "disabled" , note: "已冻结，不能执行抖音、电话、发布或点赞。", scope: "group", order: 90}],
    detail: `# QQ 通道（qq-bridge）

WebSocket 网关收发；service.handle 做审批、规划、回复；active/被动消息规则下群主动消息会被拒（40034105），用 qq_outbox 排队借被动窗口补发。

入口：
- QqService.handle；approveTask / approveFromBoard / cancelFromBoard
- api.sendText / sendImage / sendVoice；POST /qq/send、/qq/image
- 审批词：同意/确认/执行/可以/好的/好/发/发布/发吧/发咯/发出去

已知坑：网关半死连接会一直显示 online（缺心跳看门狗，建议补）。`,
  },
  {
    id: "scheduler-mood",
    title: "日程与情绪",
    one: "每日计划/定时执行/心情状态",
    status: "stable",
    aliases: ["日程", "定时", "心情", "情绪", "scheduler", "mood", "计划"],
    tags: ["调度", "成长"],
    files: ["connect/scheduler.mjs", "connect/douyin/dayplan.mjs", "connect/douyin/mood.mjs", "runtime/persona/mood.json"],

    input: "日程槽位 / 定时器",
    output: "到点执行任务 + 心情状态",
    version: "1.0",
    permissions: ["task.propose", "external.execute:r2"],
    dependencies: ["academy", "publishing", "reply-inbox"],
    validation: "只跑白名单 R0–R2；失败原因要落到事件里",
    atomic: [],
    detail: `# 日程与情绪（scheduler-mood）

每天生成日程槽（查互动/回评论/5 轮热评/学习/三篇日常图文），调度器每 60 秒跑到期槽位；心情由规则决定（失败多→低能量，久不发→好奇），写入 mood.json 与 mood_history。

入口：
- startScheduler（connect/scheduler.mjs）；fireSlot 对 douyin.daily_post 特判
- buildPlan / dueSlots / markSlot（connect/douyin/dayplan.mjs）
- ensureMood / nextMood（connect/douyin/mood.mjs）

状态：日程执行会写任务；到点执行失败原因目前只有文字。`,
  },
  {
    id: "board",
    title: "运行看板",
    one: "概览/内容/互动/成长/系统 五页",
    status: "stable",
    aliases: ["看板", "网页", "board", "dashboard", "界面"],
    tags: ["前端", "观测"],
    files: ["connect/board.mjs", "connect/board/shell.mjs", "connect/board/modules/home.mjs", "connect/board/modules/content.mjs", "connect/board/modules/interact.mjs", "connect/board/modules/growth.mjs", "connect/board/modules/system.mjs", "connect/server.mjs"],

    input: "HTTP 请求",
    output: "五页看板 + JSON API",
    version: "1.0",
    permissions: ["conversation.reply"],
    dependencies: ["stores"],
    validation: "boardList 的 root 必须是项目根",
    atomic: [],
    detail: `# 运行看板（board）

http://127.0.0.1:8765/board ；M3 深色，hash 路由五页。

入口：
- boardSnapshot / boardList（connect/board.mjs）；路由 /api/board、/api/board/list、/board/cover、/api/board/activity、/api/board/draft*、/api/board/mood
- 前端 shell + modules（connect/board/modules/*.mjs）；模块契约 meta + mount(host, ctx)
- 新增页面：modules/index.mjs 加一行；新增数据：board.mjs 加 section

风格来源：docs/prototype/board-m3.html（1:1 移植的蓝本）。`,
  },
  {
    id: "academy",
    title: "成长学院",
    one: "12 门课/七步学习/认证/周记",
    status: "stable",
    aliases: ["学院", "学习", "课程", "认证", "周记", "academy", "毕业"],
    tags: ["成长", "学习"],
    files: ["connect/academy/courses.mjs", "connect/academy/study.mjs", "connect/academy/levels.mjs", "connect/academy/graduation.mjs", "connect/academy/weekly.mjs", "connect/actions.mjs"],

    input: "日程块 / 主人要求学一课",
    output: "课程步骤记录 + 成长档案 + 周记",
    version: "1.0",
    permissions: ["conversation.reply", "external.execute:r2"],
    dependencies: ["stores"],
    validation: "每门课 7 步；考核分数要能从模型输出解析",
    atomic: [],
    detail: `# 成长学院（academy）

12 门课 / 四阶段 / 每门 7 步（导入→知识→案例→模仿→实践→考核→总结）；Lv1–Lv4 认证按真实战绩；毕业项目 12 项；周日周记。

入口：
- COURSES / LESSON_STEPS（courses.mjs）
- runStudyStep（study.mjs）写 study_sessions + growth_archive；resetAcademy 保档案
- certify（levels.mjs）、graduationState、writeWeekly
- 动作 academy.study / academy.weekly

状态：已跑真 LLM；考核分数解析与降级兜底可用。`,
  },
  {
    id: "stores",
    title: "数据层",
    one: "connect.sqlite + douyin.db 表结构",
    status: "stable",
    aliases: ["数据库", "表", "sqlite", "store", "数据"],
    tags: ["数据", "基础设施"],
    files: ["connect/douyin/store.mjs", "connect/tasks.mjs", "connect/agent-events.mjs", "connect/scheduler.mjs", "runtime/connect/connect.sqlite", "runtime/douyin/douyin.db"],

    input: "各模块的读写请求",
    output: "connect.sqlite / douyin.db 的行",
    version: "1.0",
    permissions: [],
    dependencies: [],
    validation: "任务状态机在 tasks.mjs；事件类型走白名单",
    atomic: [],
    detail: `# 数据层（stores）

- connect.sqlite：external_tasks/working_tasks、qq_messages、agent_events、plan_slots、mood_history、growth_archive/study_sessions、skill_*、strategy_trials、learning_proposals
- douyin.db：works、comments、videos、hot_comments、fans、hotspots、work_stats_history
- 任务状态机在 connect/tasks.mjs；事件在 connect/agent-events.mjs（EVENT_TYPES 白名单）

注意：boardList 的 root 必须是项目根（resolve(root,'..','..')）。`,
  },
  {
    id: "skills-learning",
    title: "技能与学习",
    one: "技能版本/反思聚合/策略试验",
    status: "beta",
    aliases: ["技能", "学习机制", "经验", "反思", "策略", "skill", "reflection", "strategy"],
    tags: ["学习", "基础设施"],
    files: ["connect/skills.mjs", "connect/reflection.mjs", "connect/strategies.mjs", "connect/qq/lessons.mjs", "connect/douyin/lessons.mjs"],

    input: "技能执行结果（成功/失败/失败阶段）",
    output: "skill_runs + learning_proposals + 版本升级/回滚",
    version: "1.0",
    permissions: [],
    dependencies: ["stores"],
    validation: "同一失败 ≥2 次才进提案；升级要有 verified 成功 run；连续失败自动回滚",
    atomic: [],
    detail: `# 技能与学习（skills-learning）

已有骨架：skill_registry/skill_versions（preconditions/steps/postconditions/fallback/confidence）+ skill_runs（success/verified/failure_stage）+ skill_proposals；失败按 skill:failure:stage 聚合到 learning_proposals，≥2 次且有 verified 成功 run 才能 validate；strategy_trials 给策略打分。

现状：表存在但全 0 行；只有 scripts/douyin.mjs 两处记账；steps/postconditions/fallback 都是空；无消费者把 skill_proposal 升级为版本。
改造方向：接电 + 补步骤判据/阻断处理，不要另建一套（见 P0–P5 计划）。`,
  },
  {
    id: "device-layer",
    title: "手机自动化",
    one: "ADB/UI dump/坐标点击/断言",
    status: "beta",
    aliases: ["手机", "ADB", "点击", "坐标", "uia", "device", "自动化"],
    tags: ["android", "基础设施"],
    files: ["device/douyin.mjs", "device/uia.mjs", "device/wechat.mjs"],

    input: "UI dump / 坐标指令",
    output: "解析出的控件树与点击结果",
    version: "1.0",
    permissions: ["external.execute:r2"],
    dependencies: [],
    validation: "点击后要有后置断言；弹窗/阻断要显式识别",
    atomic: [{ id: "android_observe", label: "安卓观测", status: "stable" , note: null, scope: "none", order: 96}, { id: "android_control", label: "安卓操控", status: "prototype" , note: null, scope: "none", order: 97}],
    detail: `# 手机自动化（device-layer）

设备 uiautomator2 服务（127.0.0.1:19008 → 设备 9008）+ adb 输入/截图；device/douyin.mjs 封装导航、解析、点击。

入口：resetDouyin、backToFeed、openCommentInbox、openVideoComments、parseComments、parseCommentsWithLikes、sendInCurrentComposer、parseOwnWorkStats、dumpXml（uia.mjs）

已知缺口：没有弹窗/阻断检测；点击后无后置断言（P0 要补）。`,
  },
  {
    id: "memory-hub",
    title: "记忆与活动",
    one: "长期记忆/活动流/经验注入",
    status: "stable",
    aliases: ["记忆", "回忆", "活动", "memory", "recall", "lessons"],
    tags: ["记忆", "基础设施"],
    files: ["brain/memory.mjs", "connect/memory-hub.mjs", "connect/daily-memory.mjs", "connect/qq/lessons.mjs", "runtime/dsh-home/lessons.json"],

    input: "对话内容 / 活动记录",
    output: "统一长期记忆（可按范围召回）",
    version: "1.0",
    permissions: ["memory.read.owner", "memory.write.owner"],
    dependencies: [],
    validation: "群聊记忆不能漏进主人私聊召回；七类各自可写可召回",
    atomic: [],
    detail: `# 记忆与活动（memory-hub）

brain/memory.mjs：turns/memories/修订；recall 按词重叠取相关记忆；connect/memory-hub.mjs 记录活动流；lessons 文本经验注入 planner/brain。

注意：这里是「用户记忆」，能力记忆在 connect/memory/capabilities.mjs（本文件所在一套）。`,
  },
];

const BY_ID = new Map(CAPABILITIES.map((c) => [c.id, c]));

export function capabilityById(id) { return BY_ID.get(String(id ?? '')) ?? null; }

/** 索引：常驻提示词，尽量短（目标 < 1200 字符）。 */
export function capabilityIndex() {
  const lines = CAPABILITIES.map((c) => `- ${c.id}｜${c.title}：${c.one}${c.status === 'disabled' ? '（停用）' : ''}`);
  return ['能力索引（要细节：capability.read(id)；要看实现：capability.code(id, path)）：', ...lines].join('\n');
}

function scoreOf(cap, text) {
  const q = String(text ?? '').toLowerCase();
  if (!q) return 0;
  let score = 0;
  for (const alias of cap.aliases) if (alias && q.includes(String(alias).toLowerCase())) score += 3;
  for (const tag of cap.tags) if (tag && q.includes(String(tag).toLowerCase())) score += 2;
  if (q.includes(cap.title.toLowerCase())) score += 2;
  if (q.includes(cap.id.toLowerCase())) score += 3;
  return score;
}

/** 按当前这句话挑最相关的能力（中文按子串即可，不引入向量）。 */
export function matchCapabilities(text, { limit = 3 } = {}) {
  return CAPABILITIES
    .map((cap) => ({ cap, score: scoreOf(cap, text) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(5, limit)))
    .map((row) => row.cap);
}

/** 给提示词的「可能是这几块」提示。 */
export function capabilityHints(text, { limit = 2 } = {}) {
  const matched = matchCapabilities(text, { limit });
  if (!matched.length) return '';
  return ['可能是这几块能力（需要细节再读）：', ...matched.map((c) => `- ${c.id}：${c.title} — ${c.one}`)].join('\n');
}

export function readCapability(id) {
  const cap = capabilityById(id);
  if (!cap) return { ok: false, error: `unknown_capability:${id}`, choices: CAPABILITIES.map((c) => c.id) };
  const files = cap.files.filter((f) => !f.includes('runtime/'));
  return { ok: true, id: cap.id, title: cap.title, text: `${cap.detail}\n\n关键文件：\n${files.map((f) => `- ${f}`).join('\n')}` };
}

function allowed(cap, file) {
  const target = String(file ?? '').replace(/^[/.]+/, '');
  return cap.files.some((entry) => {
    if (!entry.includes('/')) return false;
    if (entry.includes('*')) { const base = entry.slice(0, entry.indexOf('*')); return target.startsWith(base); }
    if (entry.startsWith('runtime/')) return false;
    return target === entry;
  });
}

/** 只读能力登记过的文件片段；默认前 80 行，最多 120 行。 */
export function readCapabilityCode(root, id, { path = null, from = 1, lines = 80 } = {}) {
  const cap = capabilityById(id);
  if (!cap) return { ok: false, error: `unknown_capability:${id}` };
  const file = String(path ?? cap.files.find((f) => !f.startsWith('runtime/')) ?? '');
  if (!allowed(cap, file)) return { ok: false, error: `file_not_registered:${file}`, files: cap.files.filter((f) => !f.startsWith('runtime/')) };
  // root 可能是服务的工作目录（<repo>/runtime/connect），而登记的文件都是仓库相对路径：
  // 先向上找到真正带 package.json + scripts/ 的那层，否则永远报 file_missing。
  const base = projectRoot(root);
  const abs = resolve(base, file);
  if (!abs.startsWith(resolve(base) + sep) || !existsSync(abs)) return { ok: false, error: `file_missing:${file}` };
  const all = readFileSync(abs, 'utf8').split('\n');
  const start = Math.max(1, Math.trunc(Number(from) || 1));
  const count = Math.max(1, Math.min(120, Math.trunc(Number(lines) || 80)));
  const slice = all.slice(start - 1, start - 1 + count);
  return { ok: true, file, from: start, total: all.length, text: slice.map((line, i) => `${String(start + i).padStart(4, ' ')}| ${line}`).join('\n') };
}

export function capabilityFiles(id) { const cap = capabilityById(id); return cap ? cap.files.filter((f) => !f.startsWith('runtime/')) : []; }

export const CAPABILITIES_DIR = 'docs/capabilities';

/**
 * 原子能力矩阵：从上面 12 张能力卡的 `atomic` 派生，**不再手写第二份矩阵**
 * （原来 connect/core-contract.mjs 里另有一份，两边能各说各话）。
 */
export function atomicCapabilityMatrix() {
  const matrix = {};
  for (const cap of CAPABILITIES) {
    for (const item of cap.atomic ?? []) matrix[item.id] = normalizeStatus(item.status);
  }
  return matrix;
}

/** 原子能力卡（带中文说明与渲染顺序），供渠道能力文案与看板渲染。 */
export function atomicCapabilityCards() {
  const cards = [];
  for (const cap of CAPABILITIES) {
    for (const item of cap.atomic ?? []) {
      cards.push({ ...item, status: normalizeStatus(item.status), capability: cap.id, order: item.order ?? 999 });
    }
  }
  return cards.sort((a, b) => a.order - b.order);
}
