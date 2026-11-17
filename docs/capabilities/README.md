# 能力索引（渐进式披露）

模型每次只带下面这张表（很小）；需要细节时调用 `capability.read(id)`，需要看实现时调用 `capability.code(id, path)`。

| id | 能力 | 一句话 | 状态 | 关键文件 |
| --- | --- | --- | --- | --- |
| `publishing` | 发图文 | 生成→编号审核→填页→发布 | stable | `connect/actions.mjs` `scripts/douyin-post.mjs` `scripts/douyin-confirm.mjs` |
| `reply-inbox` | 回评论 | 互动消息→收到的评论→内联回复 | stable | `device/douyin.mjs` `scripts/douyin.mjs` `connect/douyin/compliance.mjs` |
| `hot-comments` | 爆款热评 | 搜索热视频→评论区取高赞→回复 | beta | `connect/douyin/discover.mjs` `device/douyin.mjs` `scripts/douyin.mjs` |
| `planner-tools` | 决策脑与工具 | 模型规划 steps→执行→事实回灌 | stable | `connect/qq/planner.mjs` `connect/qq/tools.mjs` `connect/qq/service.mjs` |
| `qq-bridge` | QQ 通道 | 收发消息/审批/发件箱 | stable | `connect/qq/service.mjs` `connect/qq/gateway.mjs` `connect/qq/api.mjs` |
| `scheduler-mood` | 日程与情绪 | 每日计划/定时执行/心情状态 | stable | `connect/scheduler.mjs` `connect/douyin/dayplan.mjs` `connect/douyin/mood.mjs` |
| `board` | 运行看板 | 概览/内容/互动/成长/系统 五页 | stable | `connect/board.mjs` `connect/board/shell.mjs` `connect/board/modules/home.mjs` |
| `academy` | 成长学院 | 12 门课/七步学习/认证/周记 | stable | `connect/academy/courses.mjs` `connect/academy/study.mjs` `connect/academy/levels.mjs` |
| `stores` | 数据层 | connect.sqlite + douyin.db 表结构 | stable | `connect/douyin/store.mjs` `connect/tasks.mjs` `connect/agent-events.mjs` |
| `skills-learning` | 技能与学习 | 技能版本/反思聚合/策略试验 | beta | `connect/skills.mjs` `connect/reflection.mjs` `connect/strategies.mjs` |
| `device-layer` | 手机自动化 | ADB/UI dump/坐标点击/断言 | beta | `device/douyin.mjs` `device/uia.mjs` `device/wechat.mjs` |
| `memory-hub` | 记忆与活动 | 长期记忆/活动流/经验注入 | stable | `brain/memory.mjs` `connect/memory-hub.mjs` `connect/daily-memory.mjs` |

改完代码记得跑 `node scripts/capabilities.mjs --check`（测试里也会跑）。
