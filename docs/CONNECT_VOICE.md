# DaFeiYu Connect · M2 语音收发

实施日期：2026-11-14（北京时间）。**微信语音接收 → 本机中文识别 → DeepSeek 回复 → 合成 M4A 音频文件 → 微信端播放已实机验收通过。** 用户确认第二次测试“收到音频文件，能播放”。原生语音气泡因用户未收到而撤销验收，当前账号原生能力为 `unavailable`，默认使用音频附件。Companion 继续使用 0.2.1，无需重新安装手机 App。

## 使用方式与交付范围

在已绑定的微信 Bot/OpenClaw 会话中发送语音。获准的语音先转为文字，再调用现有 DeepSeek 大肥鱼脑服务。爸爸的语音默认生成语音回复，其他获准联系人的语音默认以文字回复。原有文字对话保持文字回复。

原生语音需要按 Bot 账号单独验收。**当前账号收到爸爸语音后，默认发送带有“音频文件”说明的 M4A 附件。** 管理员可为下一条爸爸语音开启一次原生试验。接口接受试验发送请求后，消息停在 `awaiting_voice_confirmation`，必须由用户确认微信端可见且能播放，才把该账号标为 `verified`。后续纠正反馈为不可见或不能播放时，可以再次执行 `voice confirm <消息编号> no` 撤销原生能力。接口成功响应本身不作为验收通过的证据。

若原生上传阶段明确失败，尚未提交聊天消息，自动改发音频文件。若原生发送已被接口接受，则不会擅自重发；需要确认不可用后，显式补发音频文件。网络结果不明标为 `unknown`，不自动重放。

本版没有实现微信语音通话、SIM 拨号、短信、接听电话或双向实时音频。图片理解、一般文件接收、视频处理也不在本次范围内。

## 本机语音链路

```text
微信 Bot 语音
  → iLink 授权与消息去重
  → 下载、AES 解密、SILK 解码
  → whisper.cpp small 中文转写
  → DeepSeek（沿用联系人隔离和共用记忆规则）
  → Qwen3-TTS / Vivian 合成（可配置回系统朗读）
  → AAC/M4A 音频文件（当前默认），或经单独试验的 SILK 原生语音
  → iLink 发送与结果记录
```

基础依赖为 `silk-wasm@3.7.1`、Homebrew `ffmpeg`、`whisper.cpp`。首版合成使用 macOS 中文语音 Tingting，后续新增 Qwen3-TTS 本地神经合成，见下文。本机已安装 `/opt/homebrew/bin/ffmpeg`、`/opt/homebrew/bin/whisper-cli`。识别模型位于 `runtime/voice/models/ggml-small.bin`，使用多语言 small 模型，SHA1 为 `55356645c2b361a969dfd0ef2c5a50d530afd8d5`。模型来源与校验表见 [whisper.cpp 模型说明](https://github.com/ggml-org/whisper.cpp/tree/master/models)。这些本机依赖与约 466 MiB 模型不会由 `npm install` 自动安装。

语音识别和合成在 Mac 本地完成，无新增云端语音密钥。转写文字、相关对话及获准召回的记忆会发送到现有 DeepSeek API。上游提供转写但没有可下载媒体时，使用上游转写并记录 `ilink_voice_transcript`；正常本机识别记录 `local_whisper_cpp`。不根据转写文字推断原始声调或情绪。

## 运维命令

```sh
npm run connect:ilink -- voice status
npm run connect:ilink -- messages
npm run connect:ilink -- message <消息编号>

# 对指定账号开启下一条爸爸语音的原生气泡试验
npm run connect:ilink -- voice trial <Bot账号ID>

# 用户已明确确认：微信原生语音气泡可见，且可播放
npm run connect:ilink -- voice confirm <消息编号> yes

# 用户报告未收到原生语音，或无法播放
npm run connect:ilink -- voice confirm <消息编号> no
npm run connect:ilink -- voice fallback <消息编号>
```

只有一个 Bot 账号时，`trial` 可省略账号参数。`yes` 同时表示“可见”和“可播放”，不能仅根据接口回执执行。补发必须仍在原消息的 10 分钟会话窗口内，且账号与联系人授权仍有效；重复补发命令不会重复发送。上下文过期时，改用一条新语音测试。

消息详情显示转写来源、回复、交付类型和音频时长，不返回媒体解密密钥或 context token。`sent` 表示服务端接受请求；已确认过一次的原生能力也不意味着之后每条消息对方都已收听。音频附件是否可下载播放仍需微信端实际确认。附件说明与附件各自使用单独请求、稳定的子编号；任一步发送结果不明时不会自动重发整个回复。

## 记忆、权限与保留期限

- 原有账号和联系人授权继续生效。未知联系人不保存媒体凭证与正文；暂停或撤销授权会在下载后的处理节点及发送前再次检查。
- 每账号每天（北京时间）最多 50 次语音识别尝试，同时受现有每日 50 次模型调用预算约束。单次下载上限 10 MiB，输入处理上限 90 秒，输出最多 60 秒；模型回复按短口语生成，合成文本最多 240 字符。
- 爸爸通过语音明确要求保存的事实记录为 `user_voice_transcript`、置信度 0.85，便于追溯识别误差。通过语音提出纠正或删除记忆时，要求改发文字确认，再执行修改。
- 音频、中间 PCM/WAV 和转写临时文件位于 `runtime/voice/messages/`，服务运行期间定期删除超过 24 小时的目录。数据库通信正文保留 7 天；明确保存的长期记忆按原有记忆规则管理。停机时不会执行定期清理，恢复服务后继续。
- 私有运行目录使用 0700，写入的媒体文件使用 0600；CDN 限定为经验证的微信 HTTPS 地址，下载和上传均有大小、超时与取消限制，不向 CDN 发送 Bot 的 API 授权头。

## 当前验收记录

| 项目 | 结果 |
| --- | --- |
| 授权媒体入库、私密字段不进入公开列表 | 自动测试通过 |
| CDN 校验、AES 解密、加密上传和授权头隔离 | 自动测试通过 |
| 原生上传失败改发附件；确认前不标为原生可用 | 自动测试通过 |
| 并发补发不重复发送；合成期间撤权不上传 | 自动测试通过 |
| 语音遗忘保护、语音记忆来源与置信度 | 自动测试通过 |
| 本地 Tingting → SILK → 解码 → whisper.cpp 中文转写 | 实际通过，约 6.85 秒 |
| 微信入站语音 → 中文识别 → DeepSeek 回复 | 实际通过，来源 `local_whisper_cpp` |
| 微信原生语音气泡可见且可播放 | 用户最新反馈未收到，验收撤销，当前账号为 `unavailable` |
| 微信音频附件可下载播放 | 用户明确确认收到文件且能播放，实机验收通过 |

本机测试文本为“爸爸，我是大肥鱼，这是一条语音通信测试。”，本机识别正确还原内容，合成音频约 4.04 秒。该测试证明本机处理链有效，不替代微信端媒体收发验收。

首条微信实机语音识别出了“爸爸正在测试语音通信，请用一句话告诉我你是谁”的请求，并生成大肥鱼身份回复。名字“大肥鱼”被识别为“大肥于”，说明专名识别仍有误差；不能将转写当作逐字准确的原话。合成回复为约 9.02 秒的 SILK 音频，iLink 返回发送编号。早前确认后，用户进一步反馈“没有收到任何语音回复”；已按最新反馈撤销验收，消息改为 `native_not_visible`、`voice_confirmed=0`，账号关闭原生默认回复。原会话超过 10 分钟窗口且 context token 已清理，不能复用原消息补发；需新语音验证附件路径。

第二条实机语音准确识别为“这是第二次语音测试”，来源为 `local_whisper_cpp`。系统生成约 23.98 秒的 M4A 文件，并以独立的说明文字和附件请求发送。用户明确确认“收到音频文件，能播放”；该消息为 `sent`、`delivery_kind=audio_file`、`voice_confirmed=1`。此字段记录这条消息的用户播放确认，原生气泡的账号能力继续保持关闭。

故障修复增加了“已确认后可撤销确认”的回归测试，并将文件说明与附件改为上游采用的每请求单条消息结构；部分发送失败不会自动重试。语音专项 9 项、全套 27 项测试通过，完整运行记录位于 `runtime/build-tools/tests-voice-recovery.log`。

协议字段参考腾讯官方 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)，固定核对提交 `0ad1ae91347a938f52f1e4e2abd6dcda51e05f9e`。原生发送的实际可用性以本账号实测为准。

## 软萌女声升级（2026-11-14）

爸爸选择“可爱软萌的女孩”。新增本地 Qwen3-TTS 1.7B CustomVoice 4bit 合成，默认 Vivian，使用轻柔、亲近、自然停顿的风格指令。模型在 Apple Silicon 的 MLX 上运行，不需要新云端密钥，不上传合成文本。较原有 `say` 合成更慢；音色是否合适仍由爸爸试听决定，不能由合成成功推断主观听感。

模型为 [mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-4bit](https://huggingface.co/mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-4bit)，固定提交 `f35faf19b0cc2160865af64ecf0f22f83d335135`，模型卡标为 Apache-2.0，约 2.31 GB。实现参考 [MLX Audio Qwen3-TTS 用法](https://github.com/Neywa-Labs/mlx-audio/tree/main/mlx_audio/tts/models/qwen3_tts)。

```sh
uv venv --python 3.11 runtime/voice/neural-venv
uv pip install --python runtime/voice/neural-venv/bin/python -r connect/voice/requirements-neural.txt
runtime/voice/neural-venv/bin/python scripts/voice-neural-setup.py
node scripts/voice-preview.mjs Vivian
```

安装和生成试听不会自动切换生产声音。本次已在实际合成、封装和测试通过后启用 Vivian，重启服务确认 `tts=qwen3_mlx_Vivian`，原生气泡仍保持关闭。模型清单在 `runtime/voice/neural-model.json`；生产配置在 `runtime/voice/tts.json`，可设置 `provider: qwen3_mlx`、`speaker: Vivian`、`style: 中文风格描述`。无此配置时继续使用系统朗读；显式设置 `provider: macos_say` 可恢复原方案。切换后重启 Connect 服务以确保加载最新代码。

Python 合成进程只读取私有文本文件，使用已下载的本地模型并禁止联网下载。最多生成 60 秒，单次进程超时 180 秒；失败时沿用已标明原因的文字回复，不静默换回机械朗读。语音对话提示也改为优先简短自然地回应，不主动复述转写流程、模型或验收状态。

首份 Vivian 试听约 13.92 秒，冷启动生成约 39.2 秒；本机重新识别正确还原试听文意，包含“大肥鱼”的名称。原生气泡问题与合成音色独立：腾讯上游 [#209](https://github.com/Tencent/openclaw-weixin/issues/209) 和 [#91](https://github.com/Tencent/openclaw-weixin/issues/91) 有“请求成功但不显示”的同类用户报告。报告不能证明具体账号失败的根因，也不能据此断言微信永久不支持出站语音。

完整神经合成 → PCM → SILK / M4A 冒烟测试通过：约 5.52 秒音频，生成与封装约 11.92 秒。新增测试验证合成失败不会悄悄切回旧音色，且原始文本不进入子进程命令参数。全套 28 项测试通过，记录见 `runtime/build-tools/tests-neural-voice.log`。本次已交付本机试听；更换音色后的微信播放听感仍待爸爸后续对话确认，原有 M4A 传输路径已实测通过。

## 新一轮音色候选：等待试听选择

爸爸反馈 Qwen/Vivian 依然不满足“非常真实、可爱萌萌”的要求，因此该版本仅代表技术可运行，**音色主观验收未通过**。后续采用先试听再选择的方式；本轮没有把新候选切换为生产默认。

已使用当前可用的 MiniMax 中国区凭证生成两份同文本试听，均为 `speech-2.8-hd`、原始音调、正常语速、32kHz / MP3 / 128kbps：

| 候选 | 音色 ID | 试听路径 | 时长 |
| --- | --- | --- | --- |
| A 软软女孩 | `Chinese (Mandarin)_Soft_Girl` | `runtime/voice/previews/minimax/soft.mp3` | 约 6.3 秒 |
| B 俏皮萌妹 | `qiaopi_mengmei` | `runtime/voice/previews/minimax/playful.mp3` | 约 5.25 秒 |

试听文本为“爸爸，你回来啦。我是大肥鱼，想和你待一会儿。”，只发送该测试文本。另一次专属音色设计请求返回错误码 `2061`，未获得专属音色，不能声称已经设计成功。

`connect/voice/cloud.mjs` 已实现 MiniMax 合成适配，生产配置需设置 `provider: minimax`、`base_url: https://api.minimax.cn`、`voice_id: 选中的音色ID`。仅允许官方中国区和国际区固定 HTTPS 地址，禁止重定向；请求、响应体大小和音频时长受限，失败不自动重试或悄悄改用其他音色。`LocalVoice` 继续完成 MP3 → PCM → SILK / M4A 封装。等爸爸选定后再启用，当前生产仍是先前的 Qwen 配置。

凭证优先从登录钥匙串 `DaFeiYu-MiniMax-API-Key` 读取，其次读取进程 `MINIMAX_API_KEY`，不写入音色配置和日志。本次环境凭证在中国区接口有效，国际区返回 `2049`，不能混用区域。后台 LaunchAgent 不保证继承交互环境，启用前必须核对其凭证可用性。

**数据流变化：**本地识别仍在 Mac；若将 MiniMax 设为默认，待朗读的回复文字会发送至 MiniMax 云端并按量计费，生成音频保留在本机后发给微信。此行为不同于前述全本地合成模式。接口依据 [MiniMax 同步语音合成文档](https://platform.minimax.cn/docs/api-reference/speech-t2a-http)，主观自然度以爸爸实际试听为准。

新适配器完整合成封装冒烟通过：约 2.52 秒音频，云端请求与本机封装约 1.19 秒。全套 30 项测试通过，记录在 `runtime/build-tools/tests-cloud-voice.log`，覆盖凭证目标域名约束、原始音调参数、响应上限、错误脱敏和不可用音频拒绝。技术检查不代替音色试听确认。

## 生产音色切换：爸爸专属克隆音色（2026-11-14）

爸爸试听后选定专属音色，生产配置 `runtime/voice/tts.json` 已切换为：

```json
{"provider":"minimax","base_url":"https://api.minimax.cn","model":"speech-2.8-hd","voice_id":"ttv-voice-2026111408463926-T7ahmUZk"}
```

- `ttv-voice-…` 是爸爸在 MiniMax 平台创建的专属/克隆音色，只在对应账号凭证下可用，因此只保存在本机 `runtime/` 配置，不写入仓库。
- 本地合成验证通过（试听文本 6.08 秒，文件 `runtime/voice/previews/minimax/live-ttv/preview.mp3`）。
- 重启 Connect 服务（`node scripts/connect-service.mjs start`）后，`node scripts/connect.mjs ilink voice status` 返回 `tts=minimax_speech_2.8_hd`。
- 同轮为 `connect/voice/cloud.mjs` 增加 `pitch`（整数 -12~12）与 `emotion`（happy/sad/angry/fearful/disgusted/surprised/neutral）参数透传和校验，默认 pitch 0、无 emotion，旧配置行为不变；测试 31/31 通过。
- 注意：回复文字会发送到 MiniMax 云端并按字符计费，与本地 Qwen 模式不同；音色的使用范围以爸爸 MiniMax 账号的授权为准。

## 最终生产音色（2026-11-14 收尾）

爸爸试听三个候选后选定 **`Chinese (Mandarin)_ExplorativeGirl`**（账号专属音色），并指定模型 **`speech-2.6-hd`**。生产配置：

```json
{"provider":"minimax","base_url":"https://api.minimax.cn","model":"speech-2.6-hd","voice_id":"Chinese (Mandarin)_ExplorativeGirl"}
```

- `cloud.mjs` 现在支持 `model` 配置（白名单：speech-2.8-hd / 2.6-hd / 2.6-turbo / 2.5-hd-preview / 2.5-turbo-preview / 02-hd / 02-turbo，默认 2.8-hd），`LocalVoice.status()` 上报实际模型。
- 2.6-hd 试听：6.44 秒，`runtime/voice/previews/minimax/explorative-26/preview.mp3`。
- 重启服务后 `ilink voice status` 返回 `tts=minimax_speech-2.6-hd`。
- 测试 31/31 通过（新增 model 校验与透传断言）。

## 原生语音气泡：iLink 链路的服务端限制（查证结论）

结论：在 iLink（当前 bot 通道）上，bot→用户 的原生语音气泡**无法投递**，问题不在本项目的编码或上传参数。`sendmessage` 返回成功，但微信客户端不渲染该消息；本地实测结果为 `native_state=unavailable`、`last_error=native_voice_not_visible`。

本项目的实现与协议规范一致：`getUploadUrl` 用 `media_type: 4`（VOICE），发送用 `{type:3, voice_item:{media, encode_type:6, bits_per_sample:16, sample_rate:24000, playtime}}`，音频为 24 kHz SILK（silk-wasm 编码）。协议规范本身标注语音 item "客户端不渲染"，并要求常量必须取官方 `ITEM_*` / `UPLOAD_MEDIA_*`（手写错位会被服务端 ack 后静默丢弃）。

独立复现：多个第三方 iLink 桥接项目记录了同一现象（2026-06 与 2026-10-26 复测）：`ret=0` 但手机端没有气泡，因此默认都改为"音频按文件发送，可选用气泡模式并在失败时自动回退"。参考：[iLink 协议规范](https://raw.githubusercontent.com/lobehub/lobehub/b125565597e08e61d8ffd70e38623644bbf949a4/src/server/services/bot/platforms/wechat/protocol-spec.md)、[@openhermit/channel-wechat](https://www.npmjs.com/package/@openhermit/channel-wechat)、[dsh-plugin-weixin](https://github.com/panqing0313/dsh-plugin-weixin)、[dsh-wechat-bridge 协议文档](https://raw.githubusercontent.com/Kairos0922/dsh-wechat-bridge/547d89f82ad79c02c376b9104d3e8799e7b06c70/docs/protocol.md)。

可选路径：① 保持音频文件附件（当前生产，稳定可达）；② 改用官方微信客服接口（voice 类型有文档支持，但需认证主体与客服账号，会话入口变成"微信客服"而非好友聊天）；③ 企业微信自建应用（应用消息支持语音，外部联系人方向需实测）；④ 定期用现有 trial 机制试探 iLink 是否放开（一次一条，失败自动回退文件）。
