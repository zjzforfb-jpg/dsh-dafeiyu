# 外部任务编排层

2026-11-14 起，QQ 群和私聊中的抖音操作不再依赖模型输出 `[DO:...]` 才能识别。

自然语言先经过确定性意图解析，写入 `external_tasks`：

```text
awaiting_confirmation → approved → succeeded / failed
```

涉及评论区的请求会拆成独立操作，例如：

```json
{
  "intent": "douyin.manage_comments",
  "operations": ["douyin.reply_comments", "douyin.like_comments"],
  "target": "my_latest_work",
  "requires_confirmation": true
}
```

收到“同意”“确认”“执行”等明确确认后才会运行任务。单纯回复“好”“我去做”不会批准任务，也不会触碰抖音账号。

当前 `douyin.reply_comments` 复用已有抖音互动脚本；`douyin.like_comments` 已作为独立能力登记，但底层适配器尚未实现，因此会明确失败，不会把点赞错误地当成回复。任务执行后的消息只能依据执行器返回的结果描述成功或失败。

旧的 `[DO:...]` 机制仍兼容于已存在的 QQ 动作路径，但新评论区任务优先走 `external_tasks`。后续应为任务增加管理 API、任务详情页和每一步截图/控件回执。
