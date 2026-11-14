# DaFeiYu Connect · M2 文字通信版

交付日期：2026-11-14（北京时间）。Mac Connect API 升级为0.3，手机 Companion 继续使用0.2.1。此次完成 iLink 独立 Bot 的扫码绑定、文字接收、AI 回复、联系人隔离、跨渠道主人记忆和服务恢复；图片、文件、原生语音发送与通话尚未实现，因此不将整个 M2 媒体能力标为完成。

## 现在怎么聊天

进入微信中刚绑定的 Bot/OpenClaw 会话，直接发送文字。大肥鱼通过现有 DeepSeek 记忆桥回复；首次对话说明自己是 AI 伙伴。扫码绑定的微信账号被登记为“爸爸”，允许自动文字回复。Magic5 上的个人号通知入口与 Bot 为两个独立渠道；Bot 绑定不会让系统读到个人微信全部好友和历史。

爸爸在 Bot 里明确说“请记住：……”可保存到与桌面共用的记忆库。其他联系人使用独立的联系人对话上下文，不能召回、保存、修改或删除爸爸的私人记忆。其他账号默认不自动回复；M1 的个人微信通知始终只进入通知收件箱，不会因本次升级自动回复通知里的昵称。

## 运行命令

```sh
npm run connect:ilink -- status
npm run connect:ilink -- messages
npm run connect:ilink -- message <消息编号>
npm run connect:ilink -- peers
npm run connect:ilink -- pause <Bot账号ID>
npm run connect:ilink -- resume <Bot账号ID>
```

消息列表只显示编号、联系人编号、状态、时间和错误码。显式读取某条消息才显示正文与回复；接口始终不会返回 Bot token、context token 或账号凭证。`sent` 表示 iLink 服务端已接受发送请求，不代表对方已读。

授权已经出现过的新联系人：

```sh
npm run connect:ilink -- peer <Bot账号ID> <联系人ID> <显示标签> auto
npm run connect:ilink -- peer <Bot账号ID> <联系人ID> <显示标签> hold
npm run connect:ilink -- peer <Bot账号ID> <联系人ID> <显示标签> off
```

`auto` 仅对该联系人的后续新文字自动回复；`hold` 保存获准联系人的新文字但不自动回复；`off` 停止接入。手工联系人设置不能授予主人角色。历史被阻止或暂停的消息不会在启用后自动重放。对未知联系人仅保存必要的待授权元数据，不保存正文或上下文凭证。

## 再次绑定与 PIN

```sh
npm run connect:ilink -- login
```

命令会打开本机 `127.0.0.1:8765` 的专用绑定页面，同时返回本地二维码文件路径。用希望与大肥鱼聊天的微信扫码并确认。该页面的临时随机能力只允许查看此次绑定状态和提交 PIN，不提供其他管理员 API；使用 no-store、no-referrer、CSP 和同源检查。

微信服务端可能要求输入手机显示的数字。本版在本机页面接收 PIN，不放进聊天、命令行参数、凭证文件或运行日志。PIN 流程已通过模拟协议测试；本次真实绑定没有触发 PIN。二维码过期、验证受限、外部域名跳转或已有绑定状态都明确显示，需重新发起绑定，不自动规避校验。二维码窗口有效期最长5分钟。

## 通信与持久化

腾讯 iLink HTTPS 长轮询由 Connect 服务运行，不要求手机一直停在 Companion 页面。Mac 仍需联网并保持服务运行；电脑休眠期间不保证即时回复。重启服务后从保存的游标继续接收，Bot 凭证无需重新扫码。

接收批次与游标在同一个 SQLite 事务中保存，uint64 消息编号无损解析；账号、绑定代次和上游消息编号一起构成去重键。对话历史按账号、绑定代次和联系人分别查询，只加入该联系人最近6轮已发送对话。重绑定后旧绑定的历史不会带入新会话。

发送前先提交 `sending` 状态。网络失败、进程崩溃或服务端结果不明确时标记 `unknown`，不会自动重发，以免重复回复。生成期间撤销联系人授权或暂停账号，系统在发送前再次检查权限。每账号每天（北京时间）最多50次自动模型调用；超过预算进入 `held` 状态。

长轮询超时是正常等待状态；持续网络错误会退避重连。认证过期标记 `login_required`，需要重新绑定。`pause` 停止该账号的接收与新回复调度；已提交给服务器的发送不能撤回。

凭证保存于 `runtime/connect/ilink/accounts.json`（0600），目录0700，原子替换写入。短期 context token 不进入 API 响应或普通日志，发送确认后立即清空，其余超过10分钟清空。消息正文保留7天，服务运行期间定期清理；爸爸明确要求保存到长期记忆的内容继续遵守原来的记忆管理方式。所有 runtime 文件已被 Git 忽略。

## 实机验收

- 用户扫码确认，iLink 账号绑定成功。
- 用户在 Bot 发来“你好”，DeepSeek 生成大肥鱼 AI 身份回复；服务端返回无损保存的消息编号，用户确认收到。
- 服务重启后继续收到新消息并回复，已有 `sent` 消息未再次发送。
- 用户在微信要求“请记住：爸爸已通过微信Bot和大肥鱼完成M2通信测试。”，事实进入共用记忆库。
- 桌面侧实际调用同一脑服务，正确召回“通过微信 Bot 完成测试”；记忆显示时间已统一为北京时间。
- 18项 Node 测试通过，覆盖身份隔离、私人记忆保护、授权撤销、重复消息、未知发送结果、uint64编号、绑定PIN、本机页面权限与原有桌宠/手机功能。

本节记录文字版的验收范围。后续已部署语音处理扩展，最新能力、限制与实机验收进度见 [CONNECT_VOICE.md](CONNECT_VOICE.md)。图片、微信语音通话、SIM电话和独立AI电话仍未验收。未支持的媒体不会假装已听懂或看懂。

## 协议来源

参考腾讯官方 `Tencent/openclaw-weixin`，核对的提交为 `0ad1ae91347a938f52f1e4e2abd6dcda51e05f9e`，协议版本 `3.0.0-beta-0`。本项目使用独立 Node 适配器，复用当前项目的模型与记忆服务，没有安装另一个 OpenClaw 运行时。无损编号解析器的 MIT 来源与版权说明见根目录 `THIRD_PARTY_LICENSES.md`。

- https://github.com/Tencent/openclaw-weixin
- https://github.com/Tencent/openclaw-weixin/blob/main/docs/release-notes-bot-realname-auth_zh_CN.md
