# 声卡桥：让大肥鱼接进微信语音通话（2026-11-14）

大肥鱼没有"打电话"的接口，但 macOS 可以把声音路由到虚拟声卡：微信的通话声音给大肥鱼听，
大肥鱼合成的声音再送进微信的麦克风。微信那边看起来就是一次普通语音通话。

## 链路

```
爸爸 ──说话──> 微信 ──扬声器──> BlackHole 16ch ─┐
                                                ├─> connect/sound/audio.py ─> 16k PCM
                                                │        │
                                                │        v
                                                │   VAD 断句 + whisper.cpp 转写
                                                │        │
                                                │        v
                                                │   大脑（3110 /v1/chat/completions）
                                                │        │
                                                │        v
                                                │   MiniMax 流式 TTS（音色不变）
                                                │        │
                                                └────────┴─> BlackHole 2ch ──> 微信麦克风 ──> 爸爸
```

- 采集设备默认 `BlackHole 16ch`（微信的扬声器输出到这里）
- 播放设备默认 `BlackHole 2ch`（微信的麦克风从这里收音）
- 你本人要听到对方：系统输出选「多输出设备」（BlackHole 16ch + Mac mini 扬声器/耳机），
  在「音频 MIDI 设置」里建一次即可；否则声音只会进 BlackHole，你听不到。

## 前置条件

| 项 | 检查方式 |
| --- | --- |
| BlackHole 2ch / 16ch | `node scripts/sound.mjs --list` |
| Python + sounddevice | `runtime/voice/neural-venv/bin/python`（已装 sounddevice） |
| 转写模型 | `runtime/voice/models/ggml-small.bin` |
| 语音合成 | MiniMax key 在钥匙串，`node scripts/connect.mjs ilink voice status` |
| 大脑 | `curl 127.0.0.1:3110/health` |

## 微信里的设置（每次通话前）

微信 → 设置 → 通用设置 → 音视频通话（不同版本路径略有差异）：

- 麦克风：`BlackHole 2ch`
- 扬声器：`BlackHole 16ch`

系统「声音」输出改为多输出设备，保证你自己也能听到对方。

## 启动

```bash
cd /Volumes/macOS/tools/DSH-dafeiyu
node scripts/sound.mjs --check          # 检查设备与语音能力
node scripts/sound.mjs --say "测试一下"  # 把一句话注入 BlackHole 2ch（验证注入）
node scripts/sound.mjs --bridge         # 开始监听并自动应答（Ctrl+C 结束）
```

启动后拨通微信语音：对方说话 → 终端出现「爸爸说：…」→「大肥鱼：…」→ 微信里听到回复。

## 行为

- 半双工 + 打断：大肥鱼说话时你开口，会立刻掐掉当前回复，听你说完。
- VAD：能量阈值 0.015，静音 700ms 断句，最短 350ms，最长 12s。
- 回复限制 30 字以内（由 callBrain 的系统提示约束），保证通话节奏。
- 整条链路实测：转写 1–2s、思考 0.5–1s、首包 0.5s，端到端约 2–4s。

## 限制

- 微信只认一个输入设备：大肥鱼占着麦克风时，你的声音不会被微信采集（你只能旁听）。
- 不能主动拨号：拨出/接听仍由你在微信里操作；QQ 桌面版未安装，暂不适用。
- 延迟仍是级联式（whisper 整段 + MiniMax 整句），不如豆包那种端到端 S2S；流式 ASR 是下一步。
- 音量：若对方听不清，调 BlackHole 2ch 的输出音量或 MiniMax vol。

## 排障

| 现象 | 处理 |
| --- | --- |
| `device_not_found` | 用 `--list` 确认设备名；装了 BlackHole 但名称带后缀时改 `--input/--output` |
| 终端没有「爸爸说」 | 微信扬声器没指到 BlackHole 16ch，或系统输出不是多输出设备 |
| 有「爸爸说」但对方听不到 | 微信麦克风没指到 BlackHole 2ch；或 `--say` 测试确认注入链路 |
| 声音断续 | 调大 blocksize（audio.py `--block-ms`）或降低其它音频 App 占用 |
| 大肥鱼听不清 | 把 VAD 阈值/静音时长做环境变量化前的临时办法：改 `connect/sound/vad.mjs` 参数 |

## 后续

- 流式 ASR（whisper-stream 滑动窗口）把转写从 1–2s 压到 0.3s 级。
- 按 App 路由（Loopback）可只取微信进程的声音，避免系统提示音干扰。
- LiveKit/WebRTC 是另一条「App 内通话」路线，接不了微信来电，两条可以并行。
