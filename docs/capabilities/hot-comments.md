# 爆款热评（hot-comments）

搜索关键词 → 按点赞筛热视频 → 点封面进详情 → 开评论区 → 按赞数取前 N 条 → 生成可爱回复 → 合规闸门 → 发送。

入口：
- runHotCommentRound（connect/douyin/discover.mjs）
- scripts/douyin.mjs --hot-comment-round --videos 2 --per-video 2 --generate
- 动作 douyin.hot_comment_round；每日 5 轮 × 4 条（日程 12:00/14:00/16:00/18:30/21:00）
- 落库 videos / hot_comments；粉丝记入 fans

状态：真机跑通过，偶发 comments_empty / card_missing（时序问题）。
安全：SKIP_TOPIC 过滤沉重题材；评论仍受 90 秒限速。
