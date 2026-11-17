# 回评论（reply-inbox）

路径：消息 tab → 互动消息行 → 顶部「互动消息」筛选 → 「收到的评论」→ 行内「回复评论」→ 内联输入框 → 发送。

入口：
- openCommentInbox / parseCommentInbox（device/douyin.mjs）
- scripts/douyin.mjs --reply-inbox --generate [--limit N]
- 动作 douyin.reply_comments；合规闸门 checkComment（90 秒/条，30 条/天，24h 去重）
- 发送校验：文本可见 或 回复框收起；回复写 comments 表 + replied.json 去重

已知坑：回复完 App 常停在横屏流，回列表前要 backToFeed；too_fast 要等 96 秒重试而不是记失败。
