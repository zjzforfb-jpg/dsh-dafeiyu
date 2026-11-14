# QQ 接入（Connect M3）

2026-11-14。目标：让大肥鱼在 QQ 里收文字/语音，回文字/原生语音条，并支持 `/通话` 对讲模式。代码已完成并通过单元测试，**尚未在真实机器人上联调**。

## 为什么走 QQ

微信 iLink 的机器人外发语音在服务端被丢弃（见 `docs/CONNECT_VOICE.md`「原生语音气泡」），只落成文件附件。QQ 官方机器人支持富媒体消息：`msg_type=7` + `file_type=3`（silk）发送后客户端展示原生语音条，群聊和单聊都支持。

能力边界：

| 能力 | QQ 官方机器人 |
| --- | --- |
| 文字消息 | ✅ 单聊/群聊 |
| 原生语音条 | ✅ 单聊/群聊 |
| 语音输入（语音条→文字） | ✅ 附件下载 + 本机 whisper |
| 对讲模式（`/通话`） | ✅ 本项目实现：静默 60s 自动挂断 |
| 实时语音电话（拨号、SDP、音频流） | ❌ 官方机器人 API 没有 RTC |
| 频道上麦 | ⚠️ 仅频道、需申请音频类机器人权限 |

## 准备

1. 到 [QQ 开放平台](https://q.qq.com/#/apps) 点「创建机器人」（扫码登录即可，个人开发者能建；一键创建，立即有一条机器人发来的 QQ 消息）。
2. 跑 `npm run connect:qq-bind` 扫码，凭据自动写入（不用手抄 Secret）。
3. 在机器人后台开启事件订阅：**群聊 @ 机器人**、**单聊消息**（本项目只订阅 `GROUP_AND_C2C_EVENT`，intents `1<<25`）。
4. 若后台要求 IP 白名单，把本机出口 IP 加进去。

## 配置（扫码绑定，推荐）

QQ 开放平台官方的「Agent 接入」流程就是扫码：手机 QQ 扫码后会在页面上让你选择/创建机器人，并**自动返回 AppID 与 AppSecret**（`@tencent-connect/qqbot-connector`）。本项目已封装：

```bash
npm run connect:qq-bind
```

终端会打印二维码和一个 `https://q.qq.com/qqbot/openclaw/connect.html?task_id=…` 链接；用手机 QQ 扫（或点链接打开）→ 选择要接入的机器人 → 凭据自动写入 `runtime/connect/qq.json`（0600，已 gitignore）。重绑加 `--force`。

前置：如果还没有机器人，先在 [QQ 开放平台](https://q.qq.com/#/apps) 点「创建机器人」（一键即成，会给你 QQ 发条消息，头像昵称可改）。

也可以手动配置：

```bash
mkdir -p runtime/connect
cat > runtime/connect/qq.json <<'JSON'
{ "appId": "你的AppID", "secret": "你的AppSecret" }   # 扫码写入的是 "appSecret"，两种字段都认
JSON
chmod 600 runtime/connect/qq.json
```

也支持环境变量 `QQ_BOT_APP_ID` / `QQ_BOT_SECRET`（优先级低于文件）。`runtime/` 已被 `.gitignore` 排除，secret 不会进仓库。

## 启动与首次绑定

```bash
npm run connect:start      # 服务在 127.0.0.1:8765 上同时开启微信 iLink 与 QQ 两条通道
npm run connect:qq status  # { peers, calls, usage }
```

陌生会话默认**不回复**，消息落库为 `held`。绑定流程：

1. 在 QQ 里给机器人发一条消息（单聊直接发，群聊需要 @ 机器人）。
2. `npm run connect:qq messages` 查看最新记录，找到 `kind`（`c2c`/`group`）和 `conv_id`。
3. 放行：
   ```bash
   npm run connect:qq allow c2c <openid> 爸爸
   npm run connect:qq allow group <group_openid> 家庭群
   ```
4. 再发消息即正常回复。

管控命令：

```bash
npm run connect:qq hold  c2c <openid>   # 只入库不回复
npm run connect:qq block c2c <openid>   # 完全忽略
npm run connect:qq peers                # 当前名单
```

## 聊天内的命令

- `/通话` 或 `/打电话`：开启对讲模式，之后每条回复都发语音条；静默 60s 自动挂断（会发一句文字提示）。
- `/挂断` 或 `/结束通话`：手动结束。
- `/语音 开`、`/语音 关`：开关「语音输入→语音回复」（默认开）。
- 其他文本正常聊天；语音条会被本机 whisper 转写后再回复。

## 与官方「智能体接入」的关系

QQ 开放平台的 Agent 接入页面（https://bot.q.qq.com/wiki/agent-qqbot/ ）把 QQ Bot 定义成「一站式 Agent 入口」：机器人本身是空壳，真正回答问题的是接入的 Agent。官方列出 DeepSeek Harness、Workbuddy、OpenClaw、Hermes、LightVela 等接法，其中 DSH 用 `@tencent-connect/dsh-qqbot` 插件，首次启动扫码绑定。

本项目走的是同一条官方链路，只是没用 DSH 插件，而是用 `@tencent-connect/qqbot-connector` 的扫码 SDK 拿凭据，再接自己写的 `connect/qq/*` 通道。好处是保留微信那套语音条、`/通话` 对讲、预算和记忆；代价是事件与消息格式由我们自己维护。

两条路对比：

| | 官方 dsh-qqbot 插件 | 本项目 connect/qq |
| --- | --- | --- |
| 接入步骤 | `npx @deepseek-ai/dsh plugin --profile qqbot add @tencent-connect/dsh-qqbot` 后启动扫码 | `npm run connect:qq-bind` 扫码 |
| 大脑 | DSH profile 里的 agent（可配人设/技能） | 大肥鱼 brain（3110）+ 共享记忆库 |
| 语音条 | 取决于插件与模型配置 | ✅ 已实现（MiniMax→silk→msg_type 7） |
| `/通话` 对讲 | 需自己配 | ✅ 已实现 |
| 微信通道复用 | ❌ 另起一套 | ✅ 同一个服务、同一份语音配置 |

## 实现与数据

- `connect/qq/api.mjs`：QQ 开放平台 REST（`bots.qq.com/app/getAppAccessToken` 换 token，`api.sgroup.qq.com` 发消息/传文件）。
- `connect/qq/gateway.mjs`：WebSocket 网关（op10 hello → op2 identify / op6 resume、心跳 op1、op7/op9 重连、C2C/GROUP_AT 事件归一化）。
- `connect/qq/service.mjs`：去重（按 `message_id` sha256）、权限、命令、转写、预算、语音条合成与发送、失败回退文字。
- `connect/qq/brain.mjs`：调本机 `127.0.0.1:3110/v1/chat/completions`（deepseek-flash），系统提示里写明「不能打 QQ 电话、支持 /通话 对讲」。
- `connect/qq/store.mjs`：`qq_peers` / `qq_messages` / `qq_usage` 三张表（`runtime/connect/connect.sqlite`）。
- 每日预算：50 次模型调用、50 次语音条（`qq_usage`），耗尽后回一句「今天已经说了好多话」。

语音链路与微信一致：MiniMax TTS（`runtime/voice/tts.json`，当前 `speech-2.8-hd` + `Chinese (Mandarin)_ExplorativeGirl`）→ 24kHz silk → 上传 `file_type=3` → 发 `msg_type=7`。

## 排障

| 现象 | 处理 |
| --- | --- |
| `qq_token_rejected` | AppID/Secret 错误，或后台把应用停用 |
| `qq_api_401` / `11241` | token 过期，客户端会自动刷新一次；仍失败检查系统时间 |
| `qq_upload_rejected` | 文件类型或大小被拒；语音条上限约 20MB |
| `voice_reply_failed:*` | TTS/编码失败，已自动回退文字；看 `qq_messages.error` |
| `qq_gateway_invalid` | `/gateway` 返回异常，通常是机器人未上线或 IP 白名单 |
| 收到消息但 `held` | 会话不在名单里，按上文 `allow` |
| `daily_model_budget` | 当天预算用完，次日恢复（Asia/Shanghai 00:00） |

## 未做 / 下一步

- 真实机器人联调：扫码绑定后跑通单聊、群聊 @、语音条往返（代码已就绪，等真实机器人）。
- 实时连麦（阶段三）：QQ 官方不给 RTC，需要自建 TRTC/WebRTC 房间 + 信令 + H5 页面，复用现有 ASR/TTS。
- 图片/文件消息、主动消息（需申请权限）、频道场景。
