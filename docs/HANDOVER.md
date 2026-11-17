# 交接：大肥鱼的工具跑到哪了

> 自动生成于 2026/11/18 04:17:27 · 生成命令 `node scripts/handover.mjs`
> 数字来源：`task_checkpoints`（**已排除页面手动跑的 `ui-run-*`**，只算真实业务）。

## 一、总数

- 动作总数：**15**（已下线 3 个不计）
- 已确认：**6** · 未确认：2 · 失败：0 · 没跑过：7
- 只读工具：5 个（不产生判定）

## 二、已经跑通的（有证据）

- `academy.study` — 去成长学院学一课｜本周真实 2 次（样本少）
- `academy.weekly` — 写成长周记｜本周真实 3 次
- `douyin.check_interactions` — 看抖音有没有新互动｜本周真实 4 次
- `douyin.comment_latest` — 给对标账号最新作品评论｜本周真实 11 次
- `douyin.browse` — 刷一会儿抖音｜本周真实 2 次（样本少）
- `douyin.draft` — 写一条抖音图文草稿｜本周真实 2 次（样本少）

## 三、跑过但只能算「未确认」的

- `douyin.reply_comments` — nothing_to_do
- `douyin.hot_comment_round` — nothing_to_do

## 四、一次都没真跑过的

- `douyin.publish_draft` — 按审过的内容发一条抖音图文（等级 review）
- `douyin.publish` — 发布审核过的抖音图文（等级 review）
- `douyin.publish_video` — 发布一条本地视频到抖音（等级 review）
- `qq.call` — 给爸爸打电话（等级 ai）
- `qq.call_mom` — 给妈妈打电话（等级 ai）
- `wechat.call` — 用微信给妈妈打电话（等级 ai）
- `qq.hangup` — 挂断 QQ 通话（等级 auto）

## 五、卡在哪

唯一的硬阻塞：**7 个有真实副作用的动作需要主人放行**（会响手机或公开发作品，不能由我自行决定）。

已经替这一步准备好的东西（都不需要临时再补）：

- 放行顺序：`qq.call` → `qq.hangup` → `qq.call_mom` → `wechat.call` → `douyin.publish_draft` → `douyin.publish_video` → `douyin.publish`（`connect/live/release-plan.mjs`）
- 操作单：`docs/FIRST-RUN.md`（每一步的前置、停的条件、跑完看什么）
- 机器核验：`/live` 顶栏「授权项就绪」+ `npm run release:check`（只读，先跑它）
- 放行清单现状：永久 2 个 · 临时 2 个

## 六、放行后怎么走

1. 跑 `npm run release:check`，看「下一步该跑：qq.call」；
2. 在 `/live` 工具详情里点「检查现在能不能跑」→「我现在要跑它」→「确认，跑一次」；
3. 看结果卡：判定 + 跑完之后核对；
4. 点「导出这次证据（Markdown）」留一份；
5. 跑 `node scripts/runbook-progress.mjs` 写回 runbook，§10 添一行。

## 七、已知的坑（别再踩）

- `connect/server.mjs` 的 `/core/pipeline.mjs` 必须单独放行，否则 `/home` 整页白；
- `card(title, nodes)` 的第二个参数必须是数组，传单个元素会把整页渲挂；
- 事件分页只能用 `rowid`，`agent_events.id` 是 `event_xxx` 字符串，比大小会错；
- 改大脚本必须 `node --check`，并把「唯一锚点 + 断言 count==1」当纪律（曾有 669 行被整段复制）。
