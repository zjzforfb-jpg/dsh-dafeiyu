# 大肥鱼：悬浮模式第一版

使用 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 的大肥鱼形象与透明动画，以独立模式在 Mac 或 Windows 桌面显示。当前提供悬浮、拖拽、随机动作、右键菜单、模型对话和明确保存的长期记忆。

## 启动

需要 Node.js 22.16 或更新版本。

```sh
npm install
npm run check
npm start
```

首次启动可能下载 Electron。桌宠默认位于桌面右下角。按 `Ctrl+C`，或在托盘菜单中选择「退出」。默认本地端口为 `3108`，可运行 `npm start -- --port 3110` 修改。

首次运行时，`config/pet.jsonc` 会复制到 `runtime/dsh-home/dsh-pet/main-config.jsonc`。以后以运行目录中的配置为准，方便在桌宠设置中修改；删除运行配置后重启，可重新应用模板。

## 配置与数据分层

`config/` 保存可提交的公开模板；`runtime/` 保存本机运行配置、SQLite 数据、日志和备份，已整体排除在 Git 之外。不要把 API Key、桌宠本地令牌或用户数据写进模板。运行配置只在首次启动时从模板复制，之后不会覆盖你在桌宠设置页的修改。

## 开启对话

当前默认使用 DeepSeek 的 `deepseek-flash` 模型。Mac 上运行以下脚本，把 API Key 存入钥匙串：

```sh
npm run key:setup
npm run key:check
```

脚本固定钥匙串条目的名称，并在交互提示中接收密钥，避免把密钥写进命令或终端历史。如果密钥曾出现在聊天记录或命令文字中，请先在 DeepSeek 控制台撤销它并生成新密钥。退出正在运行的大肥鱼，再执行 `npm start`。Windows 可在启动前设置 `DEEPSEEK_API_KEY` 环境变量。密钥只用于本地记忆桥向 DeepSeek 发起请求，不写入项目配置。右键大肥鱼打开「对话」即可聊天。

对话时说「请记住：我喜欢草莓」，成功回复后会写入 SQLite。以后问「我喜欢什么水果？」时，本地记忆桥会把相关记录加入模型上下文。查看与删除记忆：

```sh
npm run memory:list
npm run memory:forget -- 1
```

说「这是我们的回忆：今天一起给大肥鱼起了名字」可保存一条有来源的共同经历。事实和共同回忆会分开标记；目前都需爸爸明确要求保存。

在对话里可按编号纠正或删除记忆：`更正记忆 3：正确内容`、`忘记记忆 3`。纠正会保留旧版本供审计，删除会清除该条及其修订文本。查看来源、类型和编号：`npm run memory:list`；查看修订：`npm run memory:history -- 3`。偏好可以用「请记住：你最喜欢海边」保存为大肥鱼偏好。

## 日常生命循环

模型就绪时，大肥鱼按北京时间每天 09:00 做一次关联长期目标的小探索，21:30 写一篇短日记。任务、状态、重试次数、结果和每日预算保存在 SQLite；每天最多执行 2 项自主任务、调用模型 4 次。失败最多尝试两次，重启后可恢复中断任务。安静时段为 22:30–08:30。探索只根据已有记忆思考，不会自行上网或操作设备。开始和完成时显示桌面气泡。服务每分钟记录心跳，可用 `npm run life:status` 查看近期运行实例。Mac 休眠时不会准时执行。

查看状态、长期目标和持久任务队列，或手动触发当天的小探索：

```sh
npm run life:status
npm run life:goals
npm run life:tasks
npm run life:run
```

手动写今天的日记可用 `npm run life:run -- journal`。手动触发同样遵守每天一次的限制，需大肥鱼进程正在运行。日记会引用保存的记忆和当天的探索记录；没有记录时会如实写安静的一天。最近的小探索和日记也会进入后续聊天的上下文，让它能延续当时的心情与想法。

## 安卓设备接入

荣耀 Magic5 当前可通过 USB ADB 识别。只读查看设备、系统和抖音/微信安装状态：

```sh
npm run device:status
npm run device:screenshot
```

截图保存在权限受限且被 Git 忽略的 `runtime/device/` 中，可能含个人信息。设备接入方案与两款 App 的官方能力边界见 [`docs/ANDROID_DEVICE_BRIDGE.md`](docs/ANDROID_DEVICE_BRIDGE.md)。目前还没有自动发送微信消息、评论或发布内容。

## Mac 登录后自动启动

在 Mac 上退出手动运行的 `npm start`，然后安装当前用户的 LaunchAgent：

```sh
npm run service:install
npm run service:status
```

服务会在用户登录后启动；异常退出时由 macOS 重启。它以当前用户身份运行，密钥仍从钥匙串读取，日志写入 `~/Library/Logs/DaFeiYu/`。正常退出桌宠不会立即重启。管理命令：

```sh
npm run service:stop       # 停止本次登录中的服务
npm run service:start      # 启动或重启
npm run service:uninstall  # 移除登录自启配置
```

`service:stop` 保留登录自启配置，下次登录仍会启动；要长期关闭用 `service:uninstall`。Mac 休眠时日常任务不会准时执行。

## 本地数据备份与恢复

SQLite 记忆库可在线备份到被 Git 忽略的 `runtime/backups/`：

```sh
npm run data:backup
```

恢复前先停止后台服务。恢复会先检查备份完整性，并为当前数据库自动留一份 `before-restore-*.sqlite` 安全副本；必须显式提供 `--confirm`：

```sh
npm run service:stop
npm run data:restore -- "/完整路径/备份.sqlite" --confirm
npm run service:start
```

密钥和桌宠访问令牌不包含在备份中，它们继续留在系统钥匙串和运行配置中。

性格规则在 `config/persona.md`。记忆数据库位于 `runtime/dsh-home/dafeiyu-memory.sqlite`；桌宠自身的近期对话历史另存在其运行目录。进入模型上下文的消息与召回记忆会发送到 DeepSeek API。

## 当前边界

桌宠自身默认关闭随机碎碎念、余额查询和语音。微信 Bot 的语音能力单独管理，见下方 Connect 说明。启用日常生命循环后，计划时间会主动请求模型，最多两项任务、每项最多两次尝试。事实和共同回忆需要爸爸明确要求保存；每日小探索会作为低置信度的自我反思另存。密码、验证码和密钥等常见秘密不会写入长期记忆。安卓与微信已接入下述受限能力；开放网页探索、其他社交平台和购物仍待实施。

## 授权与素材

- **代码**：MIT，见 [LICENSE](LICENSE)；
- **「大肥鱼」形象/动画/插图**：来自上游 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)，按 **CC BY-NC-SA 4.0**（署名、非商业、相同方式共享）使用；
- 仓库不包含运行期数据、模型文件、个人配置或第三方平台内容，细节见 [NOTICE.md](NOTICE.md)。

上游代码与素材见 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)。其代码采用 MIT 许可；动画素材和“大肥鱼”形象有单独的授权条件，形象说明为 CC BY-NC-SA 4.0（署名、非商业、相同方式共享）。若计划公开发布或商业化，先核对上游最新授权与形象权利人的许可。

## DaFeiYu Connect（M0）

已安装 Companion 0.1 并完成 Magic5 注册、WebSocket、心跳、打开指定应用和回执闭环。使用 `npm run connect:status`、`npm run connect:ping`、`npm run connect:launch -- settings`。完整构建、配对、权限和验收范围见 [CONNECT_M0.md](docs/CONNECT_M0.md)。

### Companion 0.2 / M1

新增经系统授权的微信通知入口、Mac/手机同步的联系人白名单、本地收件箱和打开通知会话入口。可运行 `npm run connect:contacts -- list`、`npm run connect:events`。具体范围与通知限制见 [CONNECT_M1.md](docs/CONNECT_M1.md)。

### Connect 0.3 / M2 文字通信

已绑定腾讯 iLink Bot，支持微信文字自动回复，以及爸爸在微信与桌面之间共用记忆。可在刚绑定的 Bot/OpenClaw 会话直接聊天。状态、暂停和联系人策略命令见 [CONNECT_M2.md](docs/CONNECT_M2.md)。

新增语音处理：本机 whisper.cpp 中文识别、DeepSeek 回复和音频发送。微信语音接收、识别、AI 回复、音频附件送达与播放均已实机验收，用户确认收到 M4A 文件且能播放。后续按“可爱软萌的女孩”要求启用本地 Qwen3-TTS / Vivian，替换首版 Tingting；本机试听、合成封装与28项测试通过，新音色的微信听感待后续确认。原生语音气泡因未收到而关闭，当前默认语音输入回复音频文件，文字输入回复文字。命令、验收记录与限制见 [CONNECT_VOICE.md](docs/CONNECT_VOICE.md)。图片与电话能力仍待实施。

最新音色反馈：用户认为 Vivian 不合格，已重新生成 MiniMax Speech 2.8 HD 的“软软女孩 / 俏皮萌妹”两份短试听。云端适配与完整封装测试通过，全套30项测试通过；候选尚未设为默认，等待用户按实际听感选择。启用后合成回复文字将发给 MiniMax 并按量计费，详见上述语音文档。

缺陷治理和稳定化标准见 [BUG_REMEDIATION_PLAN.md](docs/BUG_REMEDIATION_PLAN.md)。该计划规定任务、权限、回执、测试、实机验收和观察窗口；`FEATURES.md` 中的能力在没有实机回执和稳定性观察前，不视为稳定产品能力。

当前能力状态以 [CAPABILITY_MATRIX.md](docs/CAPABILITY_MATRIX.md) 为准。

记忆分层说明见 [MEMORY_MODEL.md](docs/MEMORY_MODEL.md)：每日渠道消息进入短期日记忆，凌晨整理为当天摘要，长期记忆仍需符合来源、隐私和重要度规则。

长期记忆与搜索优化路线见 [MEMORY_OPTIMIZATION_PLAN.md](docs/MEMORY_OPTIMIZATION_PLAN.md)。
