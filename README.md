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

默认关闭随机碎碎念、余额查询和语音。启用日常生命循环后，计划时间会主动请求模型，最多两项任务、每项最多两次尝试。事实和共同回忆需要爸爸明确要求保存；每日小探索会作为低置信度的自我反思另存。密码、验证码和密钥等常见秘密不会写入长期记忆。开放网页探索、手机控制和社交接口尚未接入。

上游代码与素材见 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)。其代码采用 MIT 许可；动画素材和“大肥鱼”形象有单独的授权条件，形象说明为 CC BY-NC-SA 4.0（署名、非商业、相同方式共享）。若计划公开发布或商业化，先核对上游最新授权与形象权利人的许可。
