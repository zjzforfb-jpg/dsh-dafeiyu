# 大肥鱼的大脑架构

## 一句话

一个大脑（DeepSeek）+ 一套长期记忆 + 每个渠道一层「提示词/上下文适配」；语音在两侧，动作在手脚（手机/桌面）。

```
                        ┌──────────────────────────────┐
   桌宠 / 消息中心 ─────▶ │ brain/server.mjs              │
   QQ 群 / 私聊   ─────▶ │ connect/qq/brain.mjs          │──▶ 本机 OpenAI 兼容桥
   微信 iLink     ─────▶ │ connect/ilink（经同一桥）      │    http://127.0.0.1:3110/v1/chat/completions
   语音通话       ─────▶ │ connect/call/brain.mjs        │    model=deepseek-flash
   抖音评论/文案  ─────▶ │ connect/douyin/brain.mjs      │    key: runtime/dsh-home/dsh-pet/standalone-ai.json
                        └──────────────┬───────────────┘
                                       │
                    ┌──────────────────┴──────────────────┐
                    │  统一长期记忆 SQLite                 │
                    │  runtime/dsh-home/dafeiyu-memory.sqlite
                    │  turns / memories / memory_revisions │
                    └──────────────────┬──────────────────┘
                                       │
         ┌─────────────┬───────────────┼────────────────┬──────────────┐
      whisper.cpp   MiniMax TTS    BlackHole 声卡桥    ADB 手机桥     macui 桌面 UI
       (ASR)        (ExplorativeGirl)  (微信/QQ 通话)    (抖音/微信)     (QQ 拨号/审批)
```

## 分层

| 层 | 位置 | 职责 |
| --- | --- | --- |
| 模型网关 | 3110 端口（dsh-pet 独立 AI 配置） | 只做一件事：把 OpenAI 格式请求转给 DeepSeek，带 key 与超时 |
| 渠道大脑 | `brain/server.mjs`、`connect/qq/brain.mjs`、`connect/call/brain.mjs`、`connect/douyin/brain.mjs` | 每个渠道自己的系统提示词、历史上下文、记忆注入；同一模型，不同人格侧面 |
| 记忆 | `brain/memory.mjs` + `connect/memory-hub.mjs` | 统一库；`kind`（user_fact / shared_episode / pet_preference / reflection / activity）；来源与置信度；`recall()` 按词重叠 + 「今天」活动摘要 |
| 调度 | `life/manager.mjs`、`life/tasks.mjs` | 探索/日记任务、每日预算、安静时段、失败重试、服务心跳 |
| 语音 | `connect/voice/*`、`connect/call/*`、`connect/sound/*` | whisper 转写、MiniMax 流式合成、VAD、打断、BlackHole 声卡桥 |
| 手脚 | `device/*`（ADB）、`connect/macui/*`（macOS UI 点击） | 抖音/微信操作、QQ 拨号/接听/挂断、审批发图 |

## 记忆怎么进提示词

1. 渠道收到消息 → `recall(db, text, limit)` 取相关记忆（含当天 `activity`）；
2. 拼进 system prompt（QQ 是「你记得这些事 #编号…」，通话是短上下文）；
3. 回复发出后 → `captureExchange()` 写回统一库；
4. 产生外部动作（发图文、评论）→ `recordActivity()` 写 `kind=activity`，这样「今天干了什么」能答。

## 成长

- 操作经验：`connect/douyin/lessons.mjs`（`runtime/douyin/lessons.json`），每次踩坑记一条，注入抖音提示词；失败自动记录。
- 人格/情绪：`docs/大肥鱼性格` 设计已就绪（三层人格、情绪状态机、成长复盘），代码侧尚未全部落地，属于下一步。

## 不做什么

- 不在提示词里硬编码密钥；记忆不存密码/token；
- 公开内容（抖音发布、评论）先过合规闸门，发布前人工审批（QQ 群回复「同意」）；
- 模型不直接执行 shell，动作全部由渠道代码里的白名单函数完成。
