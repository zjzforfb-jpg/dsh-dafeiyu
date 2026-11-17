// 技能定义（v2）：把「手机上的每一步」写成可检查的步骤 + **结构化**后置条件。
// 这些定义会注册进 skill_registry / skill_versions，执行时由 skill_runs 记账。
//
// P1-C / C-2（堵 R-12）：断言不再写中文散文。原散文保留在 `assertText` 里给人读，
// `assert` 是 connect/skills/assertions.mjs 认识的结构化对象——机器能核，核不了就 false。
// 断言上下文 ctx：{ nodes:[{text,desc,cls}], activity, db, data:{...}, files, root, pixels }。
//
// ── 字段名必须对齐 action **真实返回的 data**（2026-11-16 对齐） ────────────────
// 下面这张表是「断言里能写的字段」的唯一依据，写错就核不了（核不了 = false，不是 true）：
//
//   academy.study            connect/academy/study.mjs runStudyStep()
//     → status, courseId, courseTitle, step(=序号+1), stepKey, stepLabel, total,
//       summary, score, passed, degraded, error（外加 verified / steps）
//   academy.weekly           connect/academy/weekly.mjs writeWeekly()
//     → status, title, body, stats{from,to,tasks,courses,steps,works,received,replied,hot,fans}, degraded
//   douyin.check_interactions scripts/douyin.mjs --interactions
//     → status, verified, activity, count, emptyProof, blockers, steps, rows[{author,text}]
//   douyin.draft             scripts/douyin-post.mjs --plan
//     → status, draftId, title, caption, topics[], imageFile(绝对路径), theme, draftFile, at, steps
//   douyin.publish_draft     scripts/douyin-confirm.mjs
//     → status, verified, workId, workCode, title, topics[], visible(bool), toast, steps（**没有 caption**）
//   douyin.hotspot           scripts/douyin.mjs --hotspot
//     → status, topics[{topic,videos,topLikes,topTitle,verdict,note}]
//   douyin.browse            → verified, steps
//   douyin.reply_comments / douyin.hot_comment_round / douyin.comment_latest
//     → action 只回一句摘要文字（**没有 data**），所以这些技能的断言只能核界面；
//       douyin.like_comments 的 action 直接抛 douyin_like_not_implemented，同样没有 data。
//
// ── 跨库提醒 ──────────────────────────────────────────────────────────────────
// 断言的 ctx.db 是 **CONNECT 库**（runtime/connect/connect.sqlite：study_sessions /
// growth_archive / course_state / skill_step_events …）。
// douyin 的 works / hotspots / work_stats_history 在 **抖音库** runtime/douyin/douyin.db，
// 跨库核不到，所以那几条 db_row 断言换成了「回执 data 里能核的等价事实」，
// 并在 assertText 里写清行落在哪个库。
export const SKILL_DEFS = [
  {
    skillId: 'academy.study',
    name: '成长学院学一步',
    description: '挑下一门课，走七步里的一步，写学习记录和成长档案。',
    confidence: 0.5,
    environment: { app: 'academy', needs_phone: false },
    steps: [
      { id: 'pick_course', action: '选下一门没学完的课', assertText: '拿到课程名 courseTitle、课程 id courseId，且这一步的序号 step > 0', assert: { kind: 'all', of: [
        { kind: 'field_not_empty', field: 'courseTitle' },
        { kind: 'field_not_empty', field: 'courseId' },
        { kind: 'field_gt', field: 'step', value: 0 },
      ] } },
      { id: 'digest', action: '按当前步骤生成内容', assertText: '生成的内容 summary 长度 > 60 字，或这一步明确降级 degraded', assert: { kind: 'any', of: [
        { kind: 'field_length', field: 'summary', min: 60 },
        { kind: 'field_equals', field: 'degraded', value: true },
      ] } },
      { id: 'save', action: '写 study_sessions 与成长档案', assertText: 'CONNECT 库里 study_sessions 有新行，且课程步数 step 前进', assert: { kind: 'all', of: [
        { kind: 'db_row', table: 'study_sessions' },
        { kind: 'field_gt', field: 'step', value: 0 },
      ] } },
    ],
  },
  {
    skillId: 'academy.weekly',
    name: '写每周成长日记',
    description: '汇总本周真实战绩，写一篇第一人称周记存进档案。',
    confidence: 0.5,
    environment: { app: 'academy', needs_phone: false },
    steps: [
      { id: 'collect', action: '汇总近 7 天任务/作品/评论/粉丝', assertText: '拿到 stats 且含 from/to', assert: { kind: 'all', of: [
        { kind: 'field_not_empty', field: 'stats' },
        { kind: 'field_not_empty', field: 'stats.from' },
        { kind: 'field_not_empty', field: 'stats.to' },
      ] } },
      { id: 'compose', action: '生成周记正文', assertText: '正文长度 > 120 或降级模板', assert: { kind: 'any', of: [
        { kind: 'field_length', field: 'body', min: 120 },
        { kind: 'field_equals', field: 'degraded', value: true },
      ] } },
      { id: 'archive', action: '写入 growth_archive', assertText: 'CONNECT 库里 growth_archive 有 source=weekly 的档案行', assert: { kind: 'db_row', table: 'growth_archive', where: { source: 'weekly' } } },
    ],
  },
  {
    skillId: 'douyin.browse',
    name: '刷一会儿抖音',
    description: '打开抖音首页刷几条，像人一样看看最近大家在聊什么。',
    confidence: 0.4,
    environment: { app: 'douyin', needs_phone: true },
    steps: [
      { id: 'open_app', action: '启动抖音并回到首页', assertText: '前台是 MainActivity/Splash', assert: { kind: 'activity_matches', pattern: '/(MainActivity|SplashActivity)/' } },
      { id: 'open_feed', action: '切到首页信息流', assertText: '能看到视频卡片', assert: { kind: 'any', of: [
        { kind: 'ui_nodes_min', min: 1, where: { clsEndsWith: 'RecyclerView' } },
        { kind: 'ui_nodes_min', min: 1, where: { textContains: '视频' } },
      ] } },
      { id: 'watch', action: '滑动看几条', assertText: '滑动后仍有卡片', assert: { kind: 'any', of: [
        { kind: 'ui_nodes_min', min: 1, where: { clsEndsWith: 'RecyclerView' } },
        { kind: 'ui_nodes_min', min: 1, where: { textContains: '视频' } },
      ] } },
    ],
  },
  {
    skillId: 'douyin.check_interactions',
    name: '看抖音互动消息',
    description: '打开抖音 → 消息 → 互动消息 → 收到的评论，读出最近的评论通知；只读',
    confidence: 0.4,
    environment: { app: 'douyin', screen: 'messages' },
    steps: [
      { id: 'reset_app', action: 'force-stop 后重新打开抖音', assertText: 'activity 以 com.ss.android.ugc.aweme 开头', assert: { kind: 'activity_prefix', prefix: 'com.ss.android.ugc.aweme' } },
      // P1-C / C-4：步骤名要和脚本真跑出来的步骤对齐（scripts/douyin.mjs --interactions 记的是
      // reset_app / open_interaction / filter_comments / read_rows / clear_screen），
      // 没有对应步骤事件的步骤永远核不了 → 技能就永远升不了版。
      // 「点消息 tab」这件事脚本没单独记事件，但它已经被 open_interaction 覆盖
      // （进到互动页比进到消息页更强），所以并进 open_interaction 的断言里。
      { id: 'open_interaction', action: '点底部「消息」tab → 点「互动消息」行', assertText: 'activity=socialnotice.view.activity.IntegratedInteractionActivity，且能看到「互动消息」', assert: { kind: 'all', of: [
        { kind: 'activity_equals', value: 'socialnotice.view.activity.IntegratedInteractionActivity' },
        { kind: 'ui_nodes_min', min: 1, where: { textContains: '互动消息' } },
      ] } },
      { id: 'filter_comments', action: '点顶部「互动消息」→「收到的评论」', assertText: '顶部出现「收到的评论」且列表出现评论行或空态文案', assert: { kind: 'all', of: [
        { kind: 'ui_text', contains: '收到的评论' },
        { kind: 'any', of: [
          { kind: 'ui_nodes_min', min: 1, where: { text: '回复' } },
          { kind: 'ui_text', pattern: '/(暂无|没有更多|没有评论)/' },
        ] },
      ] } },
      { id: 'read_rows', action: 'dump 并解析评论通知', assertText: 'rows 至少 1 条，或给出 emptyProof 空态证明，或界面出现「暂时没有更多了」', assert: { kind: 'any', of: [
        { kind: 'field_count_min', field: 'rows', min: 1 },
        { kind: 'field_not_empty', field: 'emptyProof' },
        { kind: 'ui_text', contains: '暂时没有更多' },
      ] } },
      { id: 'clear_screen', action: '清掉筛选、回到干净的列表', assertText: '清完还能看到列表（没卡在弹窗/广告上）', assert: { kind: 'any', of: [
        { kind: 'ui_nodes_min', min: 1, where: { clsEndsWith: 'RecyclerView' } },
        { kind: 'ui_nodes_min', min: 1, where: { textContains: '评论' } },
      ] } },
    ],
  },
  {
    skillId: 'douyin.reply_comments',
    name: '回抖音评论',
    description: '在「互动消息 → 收到的评论」里逐条点回复、输入、发送，并验证已发出',
    confidence: 0.4,
    environment: { app: 'douyin', screen: 'messages' },
    steps: [
      { id: 'open_inbox', action: '进入收到的评论列表', assertText: '同 check_interactions 的 4-5 步', assert: { kind: 'all', of: [
        { kind: 'activity_matches', pattern: '/(SplashActivity|MainActivity)/' },
        { kind: 'ui_nodes_min', min: 1, where: { text: '互动消息' } },
      ] } },
      { id: 'tap_reply', action: '点行内「回复评论」', assertText: '出现 Input，提示文案含「回复 @」', assert: { kind: 'all', of: [
        { kind: 'ui_nodes_min', min: 1, where: { clsEndsWith: 'EditText' } },
        { kind: 'ui_text', contains: '回复 @' },
      ] } },
      { id: 'compose', action: '点输入框并输入回复', assertText: '输入框里已经落下字（回复动作只回摘要文字，回复正文拿不到，只能核输入框）', assert: { kind: 'ui_input_nonempty' } },
      { id: 'send', action: '点「发送」', assertText: '回复框收起（「发送」按钮不见了，或输入框不见了——跟设备层判 composer_closed 一个口径）', assert: { kind: 'any', of: [
        { kind: 'ui_nodes_max', max: 0, where: { clsEndsWith: 'EditText' } },
        { kind: 'ui_nodes_max', max: 0, where: { text: '发送' } },
      ] } },
    ],
  },
  {
    skillId: 'douyin.hot_comment_round',
    name: '去爆款下回热评',
    description: '搜索热视频 → 点封面进详情 → 开评论区 → 按赞数取前 N 条 → 生成回复并发送',
    confidence: 0.35,
    environment: { app: 'douyin', screen: 'search' },
    steps: [
      { id: 'search', action: '打开搜索并输入关键词', assertText: 'activity 含 SearchResultActivity', assert: { kind: 'activity_contains', contains: 'SearchResultActivity' } },
      { id: 'open_card', action: '点搜索结果里认可视频的封面容器', assertText: 'activity 含 DetailActivity / UltraDetailActivity / FlowPageActivity', assert: { kind: 'activity_matches', pattern: '/(DetailActivity|UltraDetailActivity|FlowPageActivity)/' } },
      { id: 'open_comments', action: '点右侧「评论 N」按钮', assertText: '节点里出现至少 1 个文本为「回复」的行（代表评论区已开）', assert: { kind: 'ui_nodes_min', min: 1, where: { text: '回复' } } },
      { id: 'pick_top', action: '按点赞数排序取前 N 条', assertText: '评论区里至少有一个能解析成数字的点赞数（跟设备层 parseCommentsWithLikes 一个口径）', assert: { kind: 'ui_nodes_min', min: 1, where: { textMatches: '/^\\d+(\\.\\d+)?\\s*(万|w|W)?$/' } } },
      { id: 'reply', action: '对选中的评论点回复、输入、发送', assertText: '同 reply_comments 的 send 断言：回复框收起（「发送」按钮或输入框不见了）', assert: { kind: 'any', of: [
        { kind: 'ui_nodes_max', max: 0, where: { clsEndsWith: 'EditText' } },
        { kind: 'ui_nodes_max', max: 0, where: { text: '发送' } },
      ] } },
    ],
  },
  {
    skillId: 'douyin.draft',
    name: '生成图文草稿（不碰手机）',
    description: '按主题生成配图 / 标题 / 正文 / 话题，写入 works 表为待发布草稿',
    confidence: 0.5,
    environment: { app: 'none', screen: 'offline' },
    steps: [
      { id: 'theme', action: '确定主题（用户给的优先）', assertText: 'theme 非空且 ≤24 字', assert: { kind: 'field_not_empty', field: 'theme', maxLength: 24 } },
      { id: 'image', action: '生成配图并落盘', assertText: '图片文件存在且可读（真实路径在 imageFile）', assert: { kind: 'file_exists', path: 'imageFile' } },
      { id: 'copy', action: '生成标题 / 正文 / 话题', assertText: '标题非空、正文 caption ≤ 1000 字、话题 topics 至少 1 条且带 #', assert: { kind: 'all', of: [
        { kind: 'field_not_empty', field: 'title' },
        { kind: 'field_length_max', field: 'caption', max: 1000 },
        { kind: 'field_count_min', field: 'topics', min: 1 },
        { kind: 'field_contains', field: 'topics', value: '#' },
      ] } },
      { id: 'store', action: '写 works(status=draft) 与草稿 JSON', assertText: '回执 status=draft、有 draftId，草稿 JSON 也在盘上（works 行落在抖音库 runtime/douyin/douyin.db，跨库核不了）', assert: { kind: 'all', of: [
        { kind: 'field_equals', field: 'status', value: 'draft' },
        { kind: 'field_not_empty', field: 'draftId' },
        { kind: 'file_exists', path: 'draftFile' },
      ] } },
    ],
  },
  {
    skillId: 'douyin.publish_draft',
    name: '把草稿发到抖音',
    description: '按已审核的草稿填抖音发布页（标题/正文/话题/三项设置/单图）并点「发作品」',
    confidence: 0.35,
    environment: { app: 'douyin', screen: 'publish' },
    steps: [
      { id: 'open_publish', action: 'SEND intent 进发布页', assertText: '发布页出现「发作品」可点', assert: { kind: 'ui_text', contains: '发作品' } },
      { id: 'fill_title', action: '按 EditText 定位填标题', assertText: '标题输入框包含标题前 6 字', assert: { kind: 'ui_input_contains', prefixOf: 'title', length: 6 } },
      { id: 'fill_body', action: '按 EditText 定位填正文', assertText: '正文输入框包含话题词前 6 字（发布回执里只有 title/topics，没有 caption 正文）', assert: { kind: 'ui_input_contains', prefixOf: 'topics.0', length: 6 } },
      { id: 'settings', action: '开高级设置并核对三项', assertText: 'AI 生成=开、允许下载=关、保存相册=关（像素判色）', assert: { kind: 'all', of: [
        { kind: 'pixel', target: 'ai_generate', expect: 'on' },
        { kind: 'pixel', target: 'allow_download', expect: 'off' },
        { kind: 'pixel', target: 'save_album', expect: 'off' },
      ] } },
      { id: 'publish', action: '点「发作品」并等待', assertText: '回执 status=published 且 visible=true（作品页能看到正文）', assert: { kind: 'all', of: [
        { kind: 'field_equals', field: 'status', value: 'published' },
        { kind: 'field_equals', field: 'visible', value: true },
      ] } },
    ],
  },
  {
    skillId: 'douyin.comment_latest',
    name: '给对标账号最新作品评论',
    description: '搜索对标账号 → 进最新作品 → 开评论区 → 生成并发送一条评论',
    confidence: 0.3,
    environment: { app: 'douyin', screen: 'search' },
    steps: [
      { id: 'search', action: '搜索对标账号', assertText: 'activity 含 SearchResultActivity', assert: { kind: 'activity_contains', contains: 'SearchResultActivity' } },
      { id: 'open_detail', action: '点最新作品', assertText: 'activity 含 DetailActivity', assert: { kind: 'activity_contains', contains: 'DetailActivity' } },
      { id: 'generate', action: '生成评论并通过合规闸门', assertText: '评论文本已经落进评论输入框（脚本没过合规闸门就不会往下走）', assert: { kind: 'ui_input_nonempty' } },
      { id: 'post', action: '打开评论输入框并发送', assertText: '发送后评论框收起（「发送」按钮或输入框不见了）', assert: { kind: 'any', of: [
        { kind: 'ui_nodes_max', max: 0, where: { clsEndsWith: 'EditText' } },
        { kind: 'ui_nodes_max', max: 0, where: { text: '发送' } },
      ] } },
    ],
  },
  {
    skillId: 'douyin.crawl_stats',
    name: '抓自己作品的数据',
    description: '打开自己主页 → 逐个作品详情 → 解析播放/点赞/评论 → 写回 works',
    confidence: 0.45,
    environment: { app: 'douyin', screen: 'profile' },
    steps: [
      { id: 'open_profile', action: '点「我」进主页', assertText: '主页出现作品网格', assert: { kind: 'ui_nodes_min', min: 1, where: { clsEndsWith: 'RecyclerView' } } },
      { id: 'open_tile', action: '按序点作品封面', assertText: 'activity 含 DetailActivity', assert: { kind: 'activity_contains', contains: 'DetailActivity' } },
      { id: 'parse_stats', action: '解析播放/点赞/评论数', assertText: '作品详情页上能读到浏览数（文本「N 浏览」）或点赞数（描述「喜欢 N」）', assert: { kind: 'any', of: [
        { kind: 'ui_nodes_min', min: 1, where: { textMatches: '/^[\\d.]+\\s*万?\\s*浏览$/' } },
        { kind: 'ui_nodes_min', min: 1, where: { descContains: '喜欢' } },
      ] } },
      { id: 'save', action: '写回 works 并记录快照', assertText: '抓完回到主页，作品网格还在（数据写回的是抖音库 runtime/douyin/douyin.db，跨库核不了，这一步靠真机步骤事件佐证）', assert: { kind: 'ui_nodes_min', min: 1, where: { clsEndsWith: 'RecyclerView' } } },
    ],
  },
];

export const SKILL_BY_ACTION = {
  'douyin.check_interactions': 'douyin.check_interactions',
  'douyin.reply_comments': 'douyin.reply_comments',
  'douyin.hot_comment_round': 'douyin.hot_comment_round',
  'douyin.draft': 'douyin.draft',
  'douyin.prepare': 'douyin.draft',
  'douyin.publish_draft': 'douyin.publish_draft',
  'douyin.publish': 'douyin.publish_draft',
  'douyin.comment_latest': 'douyin.comment_latest',
  'academy.study': 'academy.study',
  'academy.weekly': 'academy.weekly',
  'douyin.browse': 'douyin.browse',
};

export function skillDef(skillId) {
  return SKILL_DEFS.find((def) => def.skillId === skillId) ?? null;
}

/** 失败信息 → 步骤名（用来聚合 learning_proposals 与看板展示）。 */
export function classifyFailure(message, fallbackStage = 'unknown') {
  const text = String(message ?? '');
  const blocked = text.match(/blocked_by_dialog:([a-z_]+)/u);
  if (blocked) return `blocked:${blocked[1]}`;
  const rules = [
    [/need_text/u, 'generate'],
    [/spawn .*ENOENT|ENOENT/u, 'spawn'],
    [/comment_button_missing/u, 'open_comments'],
    [/comments_empty|interactions_unconfirmed|评论没加载/u, 'read_comments'],
    [/search_unreachable|SearchResultActivity/u, 'search'],
    [/detail_not_opened|card_missing/u, 'open_card'],
    [/uia_dump_failed|SocketError|fetch failed|ECONNREFUSED|EPIPE/u, 'device_io'],
    [/too_fast|限频|不足 90 秒/u, 'rate_limit'],
    [/timeout|ETIMEDOUT/u, 'timeout'],
    [/photo_post/u, 'photo_post'],
  ];
  for (const [re, stage] of rules) if (re.test(text)) return stage;
  return fallbackStage;
}
