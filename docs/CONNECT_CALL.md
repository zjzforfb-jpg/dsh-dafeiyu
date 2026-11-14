# 实时连麦（Connect 阶段三）

2026-11-14。目标：在 Mac 上和爸爸实时对讲语音，自动检测说话停顿，转写、回答、合成语音、自动播放。

## 能力

| 能力 | 状态 |
| --- | --- |
| 麦克风采集 + 自动断句（VAD） | ✅ 页面内，700ms 停顿结束一句 |
| 本机语音识别 | ✅ whisper.cpp small（`runtime/voice/models/ggml-small.bin`） |
| 回复生成 | ✅ 127.0.0.1:3110（deepseek-flash） |
| 语音合成 | ✅ MiniMax（`runtime/voice/tts.json`，当前 `speech-2.8-hd` + `ExploreGirl`） |
| 语音回放 | ✅ 浏览器播放 M4A（AAC） |
| 边转写边显示 | ✅ 先出你的文字，再出回复文字，最后出语音 |
| 双工 | ⚠️ 半双工：大肥鱼说话时不收音，等语音播完再说 |
| 手机接入 | ⚠️ 尚未：`getUserMedia` 需要 HTTPS，目前只监听 127.0.0.1 |

## 打开方式

```bash
npm run connect:start          # 已在运行就跳过
npm run connect:call           # 打印带 token 的地址
```

输出形如 `http://127.0.0.1:8765/call?token=…`，用 Mac 上的 Safari/Chrome 打开，点「开始通话」并允许麦克风。

页面不需要登录态：`/call` 本身是静态页，WebSocket 握手必须带 `token`（等于 `runtime/connect/credentials.json` 的 `adminToken`），错误 token 直接 401。

## 交互流程

1. 说话 → 页面用 RMS 判断语音，停顿 700ms 后把这段音频（16kHz PCM16）发给服务。
2. 服务包成 WAV → `LocalVoice.transcribeBytes` → whisper 文本，先回显「你：…」。
3. 文本进 `callBrain`（短回复，≤30 字）→ 先回显「大肥鱼：…」。
4. TTS 合成 M4A（跳过 silk 编码）→ 回传 base64 音频 → 页面自动播放。
5. 播放结束恢复收音；同一会话保留最近 16 条上下文。

等待时状态栏会依次显示「正在转写…」「大肥鱼在想…」「正在合成语音…」。

## 实测延迟（本机，预热后）

| 阶段 | 时间 |
| --- | --- |
| 说话结束 → 转写文字出现 | 0.8–1.2s |
| 转写 → 回复文字出现 | +0.5–1s |
| 回复文字 → 语音开始播放 | +1.5–3s（MiniMax 云端合成） |

第一次调用会慢 2–4s（whisper 模型加载 + TTS 冷启动）。

## 安全与隐私

- 服务只监听 `127.0.0.1`，不对外网开放。
- 语音识别在本机完成；音频不会发到第三方 ASR，但合成会发文本到 MiniMax（和现有微信语音回复一致）。
- 会话历史只存在 `CallService` 内存里，断开即丢弃；音频临时文件在 `runtime/voice/messages/<sha256>/`，24 小时清理。
- 录音只由页面在用户点击「开始通话」后启动，离开页面即停止。

## 排障

| 现象 | 处理 |
| --- | --- |
| 页面提示连不上 | `npm run connect:start`；确认 8765 在跑 |
| 401 | URL 里的 token 过期，重新跑 `npm run connect:call` |
| 麦克风打不开 | 给浏览器麦克风权限；Safari 需在「设置 → 网站 → 麦克风」允许 |
| 没反应 | 说话声音太小（阈值 RMS 0.015）；或上一句语音还在播（半双工） |
| `voice_not_understood` | 没识别出文字，再说一次 |
| `brain_unavailable` | 3110 的 dsh-pet AI 桥没启动 |
| 语音播不出 | 浏览器拦了自动播放，点一下页面再试 |

注意：brain 桥只接受 `metadata.connect.channel === 'ilink'` 的调用者范围声明，实时/QQ 通道不带 `metadata.connect`。

## 下一步

- 手机接入：本地 HTTPS（自签证书）或 Tailscale，绑定 `0.0.0.0` 后让手机信任证书。
- 更低延迟：MiniMax 流式 TTS 边合成边播放（MediaSource），或降低回复长度。
- 打断（barge-in）：大肥鱼说话时检测到用户开口就停止播放。
- 全双工回声消除：把播放音频接入 AEC 参考信号。
