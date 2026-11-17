// 工具清单的「人话说明书」：每个动作叫什么、跑哪个文件、干什么、谁来干。
//
// 之前工具清单只有一列 `douyin.hot_comment_round` 这种内部名字，看不出
// 它是脚本自动跑的，还是要大模型写内容，还是得爸爸点头才能发。
// 这里给每个动作补上：标题（不是文件名）、入口文件、一句话介绍、逻辑详情、
// 以及「谁在干活」——auto 全自动 / ai 大模型介入 / review 人工审核 / missing 没做。
//
// level 的判定口径：
// - auto：脚本按固定流程跑，不调模型（抓数据、点界面、读库）
// - ai：中间要让模型生成内容或说话（写文案、回评论、通话对聊）
// - review：产物会公开或不可撤销，必须人工点头（发布、二次确认）
// - missing：还没实现，模型不许承诺

import { EXPECT_AFTER } from './expect-after.mjs';

export const LEVELS = Object.freeze({
  auto: { label: '全自动', hint: '脚本按固定流程跑，没有模型参与', color: '#22d3ee' },
  ai: { label: 'AI 介入', hint: '中途由模型生成内容或对话', color: '#a78bfa' },
  review: { label: '人工审核', hint: '产物会公开或不可撤销，需要人确认', color: '#fbbf24' },
  missing: { label: '未实现', hint: '占位，模型不允许承诺', color: '#94a3b8' },
});

export const TOOL_META = Object.freeze({
  'academy.study': {
    impact: '只写本地成长档案，不对外。',
    title: '去成长学院学一课',
    file: 'connect/academy/study.mjs',
    command: 'node scripts/academy.mjs --study',
    level: 'ai',
    intro: '在十二门成长课里挑一门没学完的，读一节、写一句收获，记进成长档案。',
    logic: '挑课（按 levels 顺序找未完成）→ 取一节课程内容 → 让模型写「收获 + 练习」→ 落 academy 库并记 event。',
  },
  'academy.weekly': {
    impact: '只写本地周记，不对外。',
    title: '写成长周记',
    file: 'connect/academy/weekly.mjs',
    command: 'node scripts/academy.mjs --weekly',
    level: 'ai',
    intro: '把这一周学过的课、做过的事串成一篇周记。',
    logic: '汇总本周课程进度与活动记录 → 模型生成周记 → 写 academy 周记表。',
  },
  'douyin.browse': {
    impact: '只读：打开抖音刷两条，不点赞不评论。',
    title: '刷一会儿抖音',
    file: 'device/uia.mjs（手机 UI 自动化）',
    command: 'node scripts/douyin.mjs --browse --count 2',
    level: 'auto',
    intro: '在手机上滑一会儿抖音，记录看到了什么，不产生任何写操作。',
    logic: '唤醒设备 → 打开抖音 → 滑动 N 次 → 读页面文字 → 落观察事件。',
  },
  'douyin.check_interactions': {
    impact: '只读：打开互动消息并数一数，不发送任何内容。',
    title: '看抖音有没有新互动',
    file: 'scripts/douyin.mjs --interactions',
    level: 'auto',
    intro: '打开互动消息页，数一数有没有新评论 / 新点赞，不调模型。',
    logic: '打开互动消息 → 数未读 → 读评论与点赞 → 写回执（empty 也算看过）。',
    command: 'node scripts/douyin.mjs --interactions',
  },
  'douyin.reply_comments': {
    impact: '会在别人的视频下发公开回复，作者与访客都能看到。',
    title: '回复收到的评论',
    file: 'scripts/douyin.mjs --reply-inbox --generate',
    level: 'ai',
    intro: '把收到的评论读出来，逐条让模型写回复，再按节奏发出去。',
    logic: '读评论表（未回复）→ 模型逐条生成回复 → 校验合规 → 通过 UI 自动发送 → 写回执与事件。',
    command: 'node scripts/douyin.mjs --reply-inbox --generate',
  },
  'douyin.hot_comment_round': {
    impact: '会在爆款视频下发公开评论（默认每轮 2 条）。',
    title: '去爆款视频底下回热评',
    file: 'scripts/douyin.mjs --hot-comment-round',
    level: 'ai',
    intro: '找 2 条爆款视频，每条挑第 2 个热评，让模型写一条不油腻的回复。',
    logic: '选爆款 → 读热评 → 拟稿过闸门 → 发送 → 回执（0 条记 nothing_to_do）。',
    command: 'node scripts/douyin.mjs --hot-comment-round',
  },
  'douyin.comment_latest': {
    impact: '会在对标账号最新作品下发公开评论。',
    title: '给对标账号最新作品评论',
    file: 'scripts/douyin.mjs --auto-comment --generate',
    level: 'ai',
    intro: '找对标账号最新一条作品，让模型写一条可爱评论发上去。',
    logic: '搜索 → 切视频页签 → 进详情 → 拟稿过闸门 → 发送 → 核验（RESULT_JSON）。',
    command: 'node scripts/douyin.mjs --auto-comment --generate',
  },
  'douyin.draft': {
    impact: '只写本地草稿，不动手机、不发出去。',
    title: '写一条抖音图文草稿',
    file: 'scripts/douyin-post.mjs --plan',
    command: 'node scripts/douyin-post.mjs --plan --theme "今天的主题"',
    level: 'ai',
    intro: '生成一条图文的配图与文案，先存成草稿给爸爸看。',
    logic: '选题 → 模型写文案 → 生成图片（模板/绘图）→ 落 drafts 表 → 等确认。',
  },
  'douyin.publish_draft': {
    impact: '会把已审过的那份草稿公开发布到抖音。',
    title: '按审过的内容发一条抖音图文',
    file: 'scripts/douyin-confirm.mjs',
    command: 'node scripts/douyin-confirm.mjs',
    level: 'review',
    intro: '爸爸点头之后，把审过的那份草稿真的发出去。',
    logic: '读已确认草稿 → 走手机 UI 发布 → 读作品页确认正文出现 → 写回执（publish_unconfirmed 表示点了发但没看到）。',
    preflight: [
      '手机在线且只有一台',
      'runtime/douyin/ 里有一条 status=pending 的草稿（douyin-confirm 会读它）',
      '点「发布」就是公开——草稿内容要你现在认可',
    ],
    steps: [
      '写草稿：douyin.draft 生成图文与文案，落 runtime/douyin/drafts',
      '人工二审：主人在 QQ 里看草稿并回「同意」',
      '发作品：本工具点「发作品」，核验后写回执与作品表',
    ],
  },
  'douyin.publish': {
    impact: '会真的公开一条抖音图文作品，删掉也可能已被别人看到。',
    title: '发布审核过的抖音图文',
    file: 'scripts/douyin-post.mjs',
    command: 'node scripts/douyin-post.mjs --plan --theme "今天的主题"',
    level: 'review',
    intro: '一条到底的发布（含生成），风险 R3，必须 owner 批准。',
    logic: '生成图文 → 存草稿 → 等审批 → 发布 → 校验回执。',
    preflight: [
      '手机在线且只有一台（adb devices 恰好 1 台）',
      '有一条已审过的草稿（否则会走 douyin.publish_draft 的两段式，先起草）',
      '真发会公开可见——确认要发的内容与时间',
    ],
    steps: [
      '生成：选题 → 模型写图文与文案（douyin-post.mjs --plan）',
      '存草稿：落 runtime/douyin/pending.json，等二审',
      '二审：主人在 QQ 里回「同意」',
      '发布：点「发作品」，等 9 秒看作品页',
      '核验：receipt_verified 写回执，失败则记原因',
    ],
  },
  'douyin.publish_video': {
    impact: '会真的公开一条抖音视频。',
    title: '发布一条本地视频到抖音',
    file: 'scripts/douyin-video.mjs',
    command: 'node scripts/douyin-video.mjs --file /path/to.mp4 --title "标题" --publish',
    level: 'review',
    intro: '把本地视频（mp4）发到抖音：给标题、正文和标签，风险 R3，必须 owner 批准。',
    logic: '推视频到手机 → media scanner 取 content URI → 分享 intent 进剪辑页 → 下一步到发布页 → 收话题面板 → 点发作品 → 落库记活动。',
    preflight: [
      '手机在线且只有一台，视频已在本机（adb push + media scanner 要几百 MB 的空间）',
      '标题/正文/标签准备好（脚本默认沿用 #大肥鱼 #deepseek #claude #token）',
      '真发会公开——视频内容要你现在认可',
    ],
  },
  'qq.call': {
    impact: '会真的拨给七海（爸爸）——他的手机会响。',
    title: '给爸爸打电话',
    file: 'scripts/qq-call.mjs --keep --contact 七海',
    command: 'node scripts/qq-call.mjs --keep --contact 七海',
    level: 'ai',
    intro: '用 QQ 语音拨给爸爸，接通后自己说话、自己听，挂断后记通话结局。',
    logic: '打开聊天 → 点拨号 → 等接通（watchCall 每秒读窗口判断 接通/拒接/无人接）→ 语音桥对话 → 挂断后写 call_ended 事件。',
    preflight: [
      'QQ 主窗口在屏上（脚本会按 960x949 认窗，标题必须读得到 → 需要屏幕录制权限）',
      'voice-bridge 声卡没被别的程序占着（通话时会把系统输入输出切到 BlackHole）',
      '真拨会响对方手机——确认这个时间点合适',
    ],
  },
  'qq.call_mom': {
    impact: '会真的拨给小朋友（妈妈）——她的手机会响。',
    title: '给妈妈打电话',
    file: 'scripts/qq-call.mjs --keep --contact 小朋友',
    command: 'node scripts/qq-call.mjs --keep --contact 小朋友',
    level: 'ai',
    intro: '同上，拨给妈妈（QQ 里的「小朋友」）。',
    logic: '同 qq.call，只换联系人。',
    preflight: [
      'QQ 已登录「小朋友」这个联系人可见（脚本按昵称搜聊天）',
      '声卡未被占用（同上，会切 BlackHole）',
      '真拨会响妈妈手机——确认这个时间点合适',
    ],
  },
  'wechat.call': {
    impact: '会真的用微信拨给敢敢不憨了——对方微信会响。',
    title: '用微信给妈妈打电话',
    file: 'scripts/wechat-call.mjs --keep --contact 敢敢不憨了',
    command: 'node scripts/wechat-call.mjs --keep --contact 敢敢不憨了',
    level: 'ai',
    intro: '微信语音拨给妈妈，接通后自己说话。',
    logic: '打开微信会话 → 语音通话 → 语音桥对话 → 挂断。',
    preflight: [
      '微信桌面端已启动（owner 名「微信」或「WeChat」都能认）',
      '窗口在屏上（探针实测 1383x1063），且已登录',
      '真拨会响对方微信——确认这个时间点合适',
    ],
  },
  'qq.hangup': {
    impact: '会挂断当前正在进行的 QQ 通话（没有通话时不会做任何事）。',
    title: '挂断 QQ 通话',
    file: 'connect/macui/qq.mjs',
    command: 'node scripts/qq-call.mjs --hangup',
    level: 'auto',
    intro: '点通话窗口里的红色挂断键，不涉模型。',
    logic: '找通话窗口 → 点挂断 → 关语音桥 → 恢复系统音频设备。',
    preflight: [
      '必须先有正在进行的 QQ 语音通话窗口（没有时脚本会干净返回「没有找到进行中的通话窗口」）',
      '不切声卡、不发消息——只点红色挂断',
    ],
  },
});

/** 只读工具（没有自主动作的）也有说明书。 */
export const TOOL_ONLY_META = Object.freeze({
  'weather.get': { title: '查天气', file: 'brain/server.mjs（上游代理注入当天天气）', level: 'auto', intro: '把当天天气塞进提示词，模型不用调接口。', logic: '定时拉天气 → 缓存 → 组提示词时带上。' },
  'works.list': { title: '看自己的作品', file: 'connect/qq/tools.mjs', level: 'auto', intro: '列出自己发过的抖音作品与数据。', logic: 'tools.mjs 的 works.list → store.listWorks 读 douyin.db 的 works 表。' },
  'comments.list': { title: '看评论表', file: 'connect/qq/tools.mjs', level: 'auto', intro: '列出收到的评论及回复状态。', logic: 'tools.mjs 的 comments.list → store.listComments 读 comments 表，按时间倒序。' },
  'capability.read': { title: '读能力卡', file: 'connect/memory/capabilities.mjs', level: 'auto', intro: '读自己的能力说明，避免瞎承诺。', logic: '读 capabilities 表，按 id 取。' },
  'device.page': { title: '看设备当前页面', file: 'device/uia.mjs', level: 'auto', intro: '读手机当前界面的文字，用于判断在哪一屏。', logic: 'adb dump → 解析控件树 → 返回文字与坐标。' },
});

export function metaOf(action, tool = null) {
  return TOOL_META[action] ?? TOOL_META[tool] ?? TOOL_ONLY_META[tool] ?? null;
}

export function levelOf(action, tool = null, risk = 'R0', implemented = true) {
  const meta = metaOf(action, tool);
  if (meta?.level) return meta.level;
  if (!implemented) return 'missing';
  if (risk === 'R3') return 'review';
  return 'auto';
}


/**
 * 「跑完之后应该看到什么」：给 7 个有副作用的动作各一条可读的验收句子。
 * 数据来自 expect-after.mjs（纯数据，浏览器可用），页面与 /api/live/verify 共用同一份。
 */
export function expectOf(action) {
  return EXPECT_AFTER[action] ?? [];
}
