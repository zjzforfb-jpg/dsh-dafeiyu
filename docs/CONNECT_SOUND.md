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

## 微信里的设置

微信 **Mac 4.2.54 每通电话有独立设备菜单**（通话中点「麦克风」/「扬声器」图标）：
选项为 SG27QC、STUDIO M PRO、BlackHole 16ch、BlackHole 2ch、Mac mini 扬声器、DAW 多声道、关闭。

**推荐（已实测跑通，2026-11-14 12:00）**：

| 微信通话设置 | 选 |
| --- | --- |
| 麦克风 | **BlackHole 2ch**（大肥鱼把声音写这时，微信当它是指麦克风） |
| 扬声器 | **BlackHole 16ch**（对方声音从这里出来，桥才能采集） |

选完直接说话即可。若某次无效（微信回到默认设备），再做系统级切换：

```bash
node scripts/sound.mjs --enable    # 系统输入 → BlackHole 2ch，系统输出 → BlackHole 16ch
node scripts/sound.mjs --status    # 检查是否就绪
```

切换后**重启一次微信**（⌘Q 再打开），让它重新读取设备；`--enable` 会记住切换前的设备，
通话结束 `node scripts/sound.mjs --restore` 恢复。

你自己听对方：`--bridge` 会把从 BlackHole 16ch 听到的声音同时转放到一个物理输出（默认
`STUDIO M PRO`，可用 `SOUND_MONITOR=...` 指定）——所以通话期间必须让 `--bridge` 一直开着。

> **不要用「DAW 多声道」当微信扬声器。** 实测聚合设备只有在按 18 路写入时才会把 ch1-16
> 映射回 BlackHole 16ch；微信是 2 路输出，声音会落到聚合设备的 ch17-18（物理 STUDIO 扬声器），
> 桥完全采不到（ch1-16 全 0，ch17-18 只有 0.0007 的串音）。
> 直接用「系统输出 = BlackHole 16ch + 软件监听到物理声卡」最稳。

## 启动

```bash
cd /Volumes/macOS/tools/DSH-dafeiyu
node scripts/sound.mjs --status         # 检查系统默认设备是否指向声卡
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
- 下行是否真的收到声音，看微信自己的日志最准：

```bash
log show --last 2m --predicate 'process == "WeChat"' --style compact | \
  grep -E "node=(dlfev|dlout)" | grep "report_type=RMS" | tail -4
```

`node=dlfev`（对端声音）连续 `rms:-120` 表示微信根本没收到手机的声音——那是电话本身的问题
（手机静音/权限/蓝牙），不是声卡接法的问题，别在 BlackHole 上折腾。

## 已修问题（2026-11-14）

- **播放截断**：audio.py 的 `output_thread.join(timeout=2)` 在只播放时 2 秒就退出，导致对方
  只听到半句（实测「爸爸，能听到我说话吗」只剩「爸爸」）。改为 `join()` + `select` 非阻塞
  写循环，SIGTERM 可干净退出，5.3s 的 TTS 包络连续。
- **弱信号**：微信输出电平偏低时 VAD 抓不到，新增 `normalizePcm()` 峰值归一（最多 20 倍）
  和 `SOUND_VAD_THRESHOLD`（默认 0.015）、`SOUND_LEVEL_LOG=1` 每秒打印电平。
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

## 一键通话模式与呼入检测（2026-11-14 下午）

```bash
node scripts/sound.mjs --call      # 立刻进入通话模式：切设备 + 起桥；通话窗口消失后自动退出并恢复
node scripts/sound.mjs --watch     # 待机守护：检测到微信/QQ 通话窗口才自动进入，结束后自动恢复
node scripts/sound.mjs --invite    # 让大肥鱼发微信"给我打个电话"（走手机 ADB，需连数据线）
node scripts/sound.mjs --contacts wechat=爸爸 qq=爸爸   # 记住以后呼叫谁（存 runtime/sound/contacts.json）
```

- 检测方式：`connect/sound/callwatch.swift` 编译成 `runtime/sound/bin/callwatch`，每秒用
  CGWindowList 读一次微信/QQ 的窗口标题；出现「语音聊天 / 视频聊天 / 语音通话 / 视频通话」
  即判定通话开始，消失即结束。不需要辅助功能权限。
- `--watch` 只在通话窗口出现时切设备、起桥，通话结束自动 `--restore`，平时不影响 Mac 音频。
- `--invite` 是"大肥鱼主动呼叫"的落地方式：个人微信/QQ 没有呼叫 API（官方 iLink 机器人只有
  语音条，QQ 机器人没有 RTC），所以做成"大肥鱼发消息请你打电话过来 + 它自动接听"。

### 为什么不能让大肥鱼直接拨出去

| 通道 | 主动拨号可行性 |
| --- | --- |
| 微信 Mac App | 没有开放接口；辅助功能只能拿到窗口按钮（聊天区是自绘，拿不到联系人和呼叫按钮） |
| 微信 iLink 机器人 | 只能发文字/语音条，没有呼叫能力 |
| QQ 官方机器人 | 发送语音条可以，拨打 QQ 语音电话不行（无 RTC/拨号接口） |
| 自建入口 | 可以做 WebRTC/LiveKit 的"App 内通话"，但接不到微信来电（另一条路） |
