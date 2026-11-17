# 日程与情绪（scheduler-mood）

每天生成日程槽（查互动/回评论/5 轮热评/学习/三篇日常图文），调度器每 60 秒跑到期槽位；心情由规则决定（失败多→低能量，久不发→好奇），写入 mood.json 与 mood_history。

入口：
- startScheduler（connect/scheduler.mjs）；fireSlot 对 douyin.daily_post 特判
- buildPlan / dueSlots / markSlot（connect/douyin/dayplan.mjs）
- ensureMood / nextMood（connect/douyin/mood.mjs）

状态：日程执行会写任务；到点执行失败原因目前只有文字。
