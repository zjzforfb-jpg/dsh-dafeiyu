# 大肥鱼成长系统 · 设计与实现方案

> 目标：把「天天等人给它下命令」变成「每天早上自己有个心情，自己排今天要干的事，干完自己复盘」。
> 本文覆盖三块新能力：**每日情绪 + 自主日程（定时）**、**爆款视频/爆款评论互动**、**成长学院（12 门课 + 能力认证 + 成长档案）**，并给出落库、模块、接口与实施顺序。

---

## 0. 现状盘点（能复用的都别重写）

| 能力 | 现有实现 | 状态 |
|---|---|---|
| 动作执行器 + 任务表 | `connect/actions.mjs`（11 个动作）、`connect/tasks.mjs`（external_tasks 状态机、审批、过期、汇报） | ✅ 可直接复用 |
| 定时 tick | `connect/qq/service.mjs` 的 `sweep()` 每 15s；`connect/server.mjs` 有 2 个 setInterval | ✅ 有循环，但没有「日程」概念 |
| 情绪雏形 | `scripts/day-plan.mjs` 读 `runtime/persona/mood.json`，6 种心情随机挑 2–3 件事 | ⚠️ 只打印/问人，没有落库、没有定时、没有延续 |
| 合规闸门 | `connect/douyin/compliance.mjs`：30 条/天、5 条/小时、90s 间隔、24h 去重、L1/L2/L3 | ✅ 但要为 20 条/天重新排期 |
| 搜索（找视频） | `scripts/douyin.mjs --search`、`device/douyin.mjs parseSearchCards()`（标题/作者/日期/**点赞**） | ✅ 爆款判定有数据源 |
| 评论解析 | `device/douyin.mjs parseComments()`：作者/正文/回复点 | ⚠️ **没有点赞数、没有排序切换** |
| 评论生成 | `connect/douyin/brain.mjs` + `postComment()` + `replied.json` 去重 | ✅ |
| 内容库 | `connect/douyin/store.mjs`（works + comments，node:sqlite） | ✅ 可扩展 videos / moods / plans |
| 看板 | `connect/board.mjs` + `board-page.mjs`（首页/作品/评论/活动，分页） | ✅ 加页即可 |
| 学习系统 | 无 | ❌ 全新 |

---

## 1. 情绪系统（mood）

**设计**：情绪不是装饰，是**日程的输入**和**说话风格的开关**。

### 1.1 状态模型
`runtime/persona/mood.json`（延续已有路径，day-plan 已经在读）

```json
{
  "date": "2026-11-16",
  "mood": "curious",
  "energy": 0.72,
  "valence": 0.61,
  "why": "昨天回了 6 条评论，被点了 12 个赞",
  "updatedAt": "2026-11-16T08:00:00+08:00"
}
```

- `mood ∈ {calm, happy, curious, playful, focused, low_energy}`（沿用现有 6 种，先不加新词，靠 `why` 和语气扩散表达细腻）
- `energy/valence` 为 0–1，决定当天做的事**数量**和**强度**
- 每天 08:00 生成一次；当天中途可被事件修正（被赞多 → +valence；发布失败 → -energy）

### 1.2 生成逻辑（`connect/douyin/mood.mjs`）

```js
export function readMood(root, now = Date.now())
export function moodInputs(db, root, now)      // 昨日任务成功率、被赞/被评数、发布数、失败数
export function nextMood(inputs, rng = Math.random)  // 规则版（可离线、可测）
export function describeMood(mood)             // 注入 prompt 的一句话
export function writeMood(root, mood, now)
```

- **先用规则版**：成功率 ≥0.8 → happy/curious；失败 ≥2 → low_energy；连续 3 天没发布 → curious（想搞事）；被赞 >10 → happy。
- LLM 只负责把规则结果**说成人话**（`why`），不做决定 → 稳定、可测、不会每天乱跳。
- 新表 `mood_history(day PK, mood, energy, valence, why, created_at)`，看板画情绪曲线。

### 1.3 情绪的影响面
| 消费方 | 怎么用 |
|---|---|
| 日程生成 | 决定今天做几件事（energy）、偏好哪类事（curious→刷爆款/学新课；low_energy→只回评论） |
| 评论生成 | 语气 modifier：playful 多调侃、happy 多感叹号、low_energy 短句、focused 少玩梗 |
| 发布选题 | 主题偏好在 prompt 里加权 |
| 看板 | 首页顶部「今日心情」+ 7 天曲线 |

---

## 2. 日程系统（daily plan）+ 定时

**一句话**：早上生成一份「今天想干嘛」，落库成 **slots（时间点 + 动作）**，到点由 scheduler 变成任务执行。

### 2.1 数据模型（`connect/db/migrations` 新增，沿用 external_tasks 的写法）

```sql
CREATE TABLE daily_plans (
  day TEXT PRIMARY KEY,              -- 2026-11-16
  mood TEXT, energy REAL,
  summary TEXT,                      -- 一句话：今天想干嘛
  created_at INTEGER, updated_at INTEGER
);
CREATE TABLE plan_slots (
  id TEXT PRIMARY KEY,
  day TEXT, at_ms INTEGER,           -- 计划执行时刻
  action TEXT,                       -- douyin.hot_comment_round / douyin.reply_comments / academy.study / douyin.prepare ...
  args TEXT,                         -- JSON
  status TEXT,                       -- planned / fired / skipped / done / failed
  task_id TEXT, fired_at INTEGER,
  UNIQUE(day, at_ms, action)
);
CREATE TABLE scheduled_runs (        -- 幂等：同一 slot 只跑一次
  key TEXT PRIMARY KEY,              -- plan:<slot_id> / sweep:daily-mood:2026-11-16
  ran_at INTEGER, result TEXT
);
```

### 2.2 生成（`connect/douyin/dayplan2.mjs`，避免和旧脚本混）

```js
export function buildPlan(db, root, { day, mood, quotas })  // 规则骨架
export async function planWithLLM(plan, { home, mood })     // LLM 填 why/summary，不改时间与配额
export function savePlan(db, plan)
export function dueSlots(db, now)                            // status='planned' AND at_ms<=now
export function markSlot(db, id, patch)
```

**规则骨架（先定死，LLM 只能微调顺序/理由）**：
- 时间窗 09:00–23:00；相邻 slot ≥ 20 分钟
- 每日固定项：08:00 生成心情与计划、22:30 复盘
- 任务项按配额与心情抽：
  - `douyin.hot_comment_round`：**10 个爆款视频 × 2 条评论 = 20 条/天**，拆成 5 轮，每轮 2 视频 4 评论，间隔约 2h（受 5 条/小时、90s 间隔约束）
  - `douyin.reply_comments`（收件箱）：1 轮，能量低时保留
  - `academy.study`：1 个 25 分钟学习块（见 §4）
  - `douyin.prepare`/`douyin.publish`：≤1 次/天，**仍走两次审核**（主题 → 标题话题图片设置）
- 兜底：当天没跑完的 slot 在 23:30 前补跑或标 skipped，不跨天堆

### 2.3 定时（`connect/scheduler.mjs`）

```js
export function startScheduler({ db, root, home, logger }) {
  return setInterval(() => tick({ db, root, home }), 60_000);  // unref()
}
```

`tick()` 的职责（每 60s，全部幂等）：
1. **daily-mood**：今天没有 mood → 生成 + 落库 + 写 mood.json
2. **daily-plan**：今天没有 plan → 生成 + 落库（生成后可选 QQ 播报「今天心情 X，计划 …」）
3. **due slots**：`dueSlots()` 里每一条 → `proposeTask(origin='plan')` + 立即 `approve`（**只读和评论类自动执行**；发布类仍停在 awaiting_confirmation 等人）
4. **nightly review**：22:30 汇总当日（发布数/评论数/被赞数/失败原因）→ 写 `lessons.json` 与成长档案
5. **missed recovery**：服务重启后，当天窗口内未触发的 slot 补触发

启动挂载点：`connect/server.mjs` 的 `startConnect()` 里 `startScheduler(...)`，和现有 sweep 并存（sweep 管过期/汇报，scheduler 管日程）。

---

## 3. 爆款视频 + 爆款评论

### 3.1 目标拆解
- 每天 **10 个爆款视频**
- 每个视频挑 **2 条爆款评论**（按点赞数）+ 回复
- 回复角度：**可爱、萌**，短句，80 字以内
- 总量 **20 条/天**，必须落在合规闸门内（当前 30/天、5/小时、90s 间隔）

### 3.2 发现爆款视频（`connect/douyin/discover.mjs`）

```js
export const HOT_LIKES_MIN = 10_000;         // 抖音列表显示「1.2万」，按万折算
export function parseLikes(text)             // "1.2万" → 12000
export async function findHotVideos(serial, { keywords, limit = 10, minLikes })
```

流程：
1. 关键词池：`THEMES` 主题词 + 热榜词 + 最近作品的关联词（先静态 `keywords.json`，后续接热榜）
2. 对每个词：`openSearch(keyword)` → `searchKeyword` → `parseSearchCards()`
3. 过滤：`parseLikes(card.likes) >= HOT_LIKES_MIN`、日期在 7 天内、标题去重、**已评论过的不再选**（`videos` 表 + replied 去重）
4. 汇总排序取前 10 → 写 `videos` 表（status='candidate'）

新表（`connect/douyin/store.mjs` 扩展）：

```sql
CREATE TABLE videos (
  id TEXT PRIMARY KEY,              -- md5(标题+作者)
  title TEXT, author TEXT, likes INTEGER, keyword TEXT,
  url_hint TEXT, discovered_at TEXT, status TEXT,   -- candidate / commented / skipped
  comment_rounds INTEGER DEFAULT 0
);
CREATE TABLE hot_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT, author TEXT, text TEXT, likes INTEGER,
  comment_at TEXT, reply_text TEXT, replied_at TEXT,
  UNIQUE(video_id, author, text)
);
```

### 3.3 取爆款评论（`device/douyin.mjs` 扩展）

```js
export function parseCommentsWithLikes(nodes)   // 在现有 parseComments 上补 likes（评论区每行右侧的数字）
export async function sortCommentsByHot(serial) // 评论区若有「热度/最热」切换就点，没有就按解析出的 likes 自己排
```

- 取 `likes ≥ 1_000` 且 `classifyComment().meaningful === true` 的前 2 条
- 纯表情/纯图评论（`kind=emoji/image`）→ 回复固定可爱表情（复用 `CUTE_REPLIES`），不调 LLM
- 评论区如果没有排序控件，就**自行按点赞数排序**（解析时把数字捕获下来）——这点需要真机确认一次

### 3.4 生成与发送（`scripts/douyin.mjs` 新增 `--hot-comment-round`）

```
node scripts/douyin.mjs --hot-comment-round --videos 2 --per-video 2 --generate [--dry-run]
```

- 每轮：从 `videos` 取 2 条 candidate → 进详情 → 开评论 → 取 top2 热评 → 每条生成回复 → `gate()` → 发送 → 写 `hot_comments` + `replied.json` + `remember()`
- 生成 prompt 增加：目标评论原文 + 视频标题 + 当前 mood + 「可爱萌、短、不硬蹭、不评价视频好坏」
- 频控：每发一条前查 `checkComment()`；`too_fast` → 等 96s 重试（沿用现有策略）；`daily_cap` → 当天停止并记 lesson
- 失败分类：`comment_bar_missing` / `reply_point_missing` / `detail_not_opened` → 记 videos.status='skipped' 并换下一条，不卡死

### 3.5 配额调整（需要你点头）
| 项 | 现值 | 新值 | 理由 |
|---|---|---|---|
| dailyComments | 30 | 30（不变） | 20 条目标留余量 |
| hourlyComments | 5 | 5（不变） | 20 条分散在 5 个轮次 |
| minIntervalMs | 90s | 90s（不变） | 每轮 4 条需要约 6 分钟 |

> 结论：**不需要改闸门数字**，只需要把 20 条分散到 5 个时间轮次（§2.2）。

### 3.6 风险（必须提前说）
- 10 个爆款视频下都留评论 = 营销号特征，**最容易触发限流/评论折叠**。建议上线第一周 **4 条/天**（2 视频×2），观察 3 天再爬到 20 条。
- 恢复策略：一旦发现评论不可见（发送后本人可见、别人看不到），立刻暂停并记 lesson。

---

## 4. 成长学院（12 门课）

### 4.1 数据模型（`connect/academy/`）

```sql
CREATE TABLE courses (id TEXT PK, stage INTEGER, title TEXT, goal TEXT, modules TEXT, exams TEXT);
CREATE TABLE course_state (
  course_id TEXT PRIMARY KEY, level INTEGER DEFAULT 0,      -- Lv0 未学 / Lv1–4
  progress REAL DEFAULT 0, started_at INTEGER, updated_at INTEGER,
  evidence TEXT                                             -- JSON：支撑等级的真实战绩
);
CREATE TABLE study_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, course_id TEXT, day TEXT,
  step TEXT, output TEXT, created_at INTEGER                  -- 7 步学习流的每一步产出
);
CREATE TABLE growth_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT, section TEXT,         -- knowledge/skill/experience/opinion/growth/todo
  title TEXT, body TEXT, source TEXT, created_at INTEGER
);
```

### 4.2 12 门课（数据，不是代码）
`connect/academy/courses.mjs` 里写成数组：`id, stage, title, goal, modules[], practice[], exam, graduation`。
四阶段：认识自己（01–03）/ 成为创作者（04–06）/ 认识人类社会（07–09）/ 学会独立成长（10–12）。
一份 `courses.mjs` ≈ 200 行，纯数据、可测、可在看板里渲染。

### 4.3 学习闭环（7 步 → 一个学习 block）
```js
export async function studyBlock({ db, root, home, courseId, mood })
```
1. 课程导入（为什么学）→ 2. 知识（模块要点）→ 3. 案例（课本案例 + 我们账号真实案例）→ 4. 模仿练习 → 5. 独立实践（**必须落成真实动作**，例如课程 07 就是去分析今天收到的评论）→ 6. 考核（用真实数据打分）→ 7. 总结（写 `study_sessions` + `growth_archive` + `lessons.json`）

### 4.4 能力认证（Lv1–4，用真实战绩判定，不靠考试分数）
```js
export function certify(db, courseId)  // 返回 {level, evidence, missing}
```
- Lv1 知识理解：能用自己的话解释（LLM 评分 ≥ 阈值）+ 通过 5 道概念题
- Lv2 独立实践：**真实任务成功 ≥ 3 次**（对应动作的成功回执）
- Lv3 熟练应用：连续 7 天任务成功率 ≥ 80%，且至少 1 次异常情况处理
- Lv4 自主成长：自己提出假设 → 执行 → 复盘 → 认知更新（有 `lessons` 来源标记 `self-discovered`）

### 4.5 毕业项目跟踪
12 项任务（认识自己/确定定位/观察热点/…/自主学习）映射到真实数据：`academy.project_status()` 从 works/comments/videos/lessons 汇总每个里程碑完成度，看板显示 0–12。

### 4.6 与「八卦/粉丝关系」的关系
课程 09（粉丝关系与社交记忆）→ 复用 `brain/memory.mjs` 的 facts + 新建 `fans(id, name, first_seen, last_seen, notes, interactions)`，在回复评论时注入「这个人之前来过 X 次，聊过 Y」。

---

## 5. 看板扩展

| 页面 | 内容 |
|---|---|
| 首页（改） | 顶部加「今日心情」卡片（mood + why + 7 天小曲线）、「今日日程」时间线（planned/fired/done） |
| 爆款（新） | 今日候选视频（点赞数、关键词）、已评论视频、每条热评 + 我们的回复 + 点赞数 |
| 成长（新） | 12 门课进度（阶段分组）、Lv 徽标、四项重点课（01/07/08/12）冲刺进度、成长档案六栏、每周成长日记 |
| 活动（改） | 加筛选：scheduler / mood / plan / hot-comment |

---

## 6. 实施顺序（建议）

| 期 | 内容 | 产出 | 预估 |
|---|---|---|---|
| **P1** | 情绪模块 + 日程生成 + scheduler tick（先只跑 `reply_comments`/`check_interactions`/`browse` 三个已有动作） | 每天早上自己排 3 件事并落库执行，看板能看心情和日程 | 1 天 |
| **P2** | 爆款发现（videos 表 + discover）+ 热评解析（likes/排序）+ `--hot-comment-round` | 每日 4 条灰度跑通，再爬 20 条 | 1–1.5 天 |
| **P3** | 学院：courses.mjs + studyBlock + course_state + 成长档案 | 课程 01 完整走完一遍（含真实考核） | 1 天 |
| **P4** | 认证（Lv1–4）+ 毕业项目跟踪 + 看板新页 | 12 门课可点开、有等级、有档案 | 1 天 |
| **P5** | 粉丝关系（fans 表 + 社交记忆注入）+ 周报 | 回复带「老朋友记忆」 | 0.5 天 |

**验证方式**：每期都要求 `npm test` 全绿 + 一次真机跑通 + 看板可见；涉及手机的操作一律先 `--dry-run` 再真跑。

---

## 7. 需要你拍板的 4 件事
1. **20 条/天是否先灰度 4 条/天**（我建议灰度 3 天）
2. 日程生成的「每日计划」是否要在 QQ 里播报（顺手也能当打卡）
3. 学习 block 放在晚上（22:00 前）还是白天（跟评论轮次错开）
4. 课程 07/09 需要「评论分析」的真实样本——是否允许大肥鱼读取自己评论区历史做训练（只读，不外传）
