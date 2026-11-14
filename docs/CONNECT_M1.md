# DaFeiYu Connect · M1 / Companion 0.2

当前推进《通信系统2.0》的 M1：联系人白名单、系统授权的微信通知入口、离线通知队列、Mac 收件箱和打开通知对应微信会话。M0 的注册、心跳、启动 App 和命令回执继续保留。

## 使用

手机已升级 `com.dafeiyu.companion` 0.2.1。手机 App 提供“授权读取白名单微信通知”按钮，进入 Android 系统授权页面；系统通知使用权由用户开启。界面显示当前授权状态和白名单人数。“断开连接”会停止新的通知采集、清空待转发事件并断开通信；撤销系统通知权限后也会停止待转发微信事件与通知会话打开能力。

联系人由 Mac 配置并立即同步到手机，用户已指定的首位联系人是 `dad` / 显示名称“爸爸”。此配置只在本机 Connect 数据库和手机应用沙箱保存，不写进代码模板。

```sh
npm run connect:contacts -- list
npm run connect:contacts -- set dad 爸爸 爸爸
npm run connect:contacts -- disable dad
npm run connect:capabilities
npm run connect:events
npm run connect:scan
npm run connect:event -- <事件编号>
npm run connect:open-event -- <事件编号> dad
```

`set` 的三个参数依次是联系人编号、用户可见标签、微信通知上显示的完整标题。每台设备最多100个启用联系人，同一设备的启用通知标题不能重复。联系人禁用后，Mac 会拒绝新的通知和会话打开请求；策略在在线设备立即下发，离线设备重新注册时收到最新策略。版本未同步的通知由 Mac 拒绝。

`connect:scan` 是显式读取当前仍在通知栏里的白名单微信通知；不会遍历历史聊天。刚升级或进程重启后，系统通知监听服务需要重绑定，`connect:capabilities` 的 `listener_connected` 可查状态；未就绪会返回明确原因。安装脚本会等待新版本会话和已授权监听服务就绪后再返回。

`connect:events` 仅列出事件编号、渠道、联系人编号和时间；显式调用 `connect:event` 才显示通知预览正文。所有接口沿用独立管理员 Bearer token。系统与普通运行日志不输出通知正文。

`connect:open-event` 使用微信原始通知提供的 PendingIntent，手机 Companion 须处于前台；并再次检查通知权限、白名单和通知有效期。通知被系统取消、进程重启或超过30分钟时可能无法打开，回传明确原因。`open_requested` 仅表示打开请求已提交，不能当作微信收发成功的证据。此版本没有 `wechat.send_text` 或自动回复入口。

## 通知接收范围

手机只处理当前 Android 用户中 `com.tencent.mm` 发出的、与白名单完整标题匹配的新通知。已知群组、系统群组汇总、消息发送者与标题不一致、缺少文本或过期通知会被跳过。针对实机遇到的“[2条]爸爸: M1通信测试”格式，只有汇总前缀中的发送者也精确匹配白名单标题时才接收，并记录 `aggregate_count=2`；这仍是一条通知预览，不是两条完整聊天消息。微信在前台不产生系统通知时，没有事件可接收；消息预览隐私设置也可能使标题变成“微信”或使正文为空。

通知是一个有损的预览渠道，不代表微信完整历史、消息送达状态或完整联系人身份。显示名可能重名、变更或由应用不同版本改变，因此接收数据固定标注 `source=android_notification`、`identity_verified=false`。白名单匹配不能作为高权限行为的身份认证，不自动触发回复、拨号或其他外部动作。

图片和语音如果只显示“[图片]”“[语音]”，此版本仅保存这些预览文字，不会取得图片或原生语音媒体。群聊、历史聊天、微信数据库和联系人数据库尚未接入。

## 队列与回执

手机先将通知事件存到应用私有 SharedPreferences 队列，最多200条，最长24小时；网络恢复后重新发送。事件编号是通知标识、原始消息时间与预览文字的 SHA256，Mac 接收去重；明文通知标识不上传。Mac 写入收件箱后确认，手机删除待传内容，只保留24小时内的去重哈希。联系人撤销、权限撤销或显式断开时清除不再允许传输的待传项。

Mac 收件箱持久保存在 `runtime/connect/connect.sqlite`，服务启动时和运行期间定期清理超过7天的通知事件。拒绝的旧策略/非白名单通知不会进入收件箱。新接收且未重复的微信通知会让 Mac 桌宠显示不含正文的通用提示；通知正文不会进入桌宠活动日志或模型上下文。桌宠离线时不影响收件箱。设备诊断事件 `device.diagnostic` 与真实 `wechat.notification` 分别标注；诊断成功只证明事件传输链路，不能代替微信通知实测。

## 验证与后续

已完成 APK 构建和实机安装；设备报告通知授权开启、白名单策略版本同步；手机生成的诊断事件经 WebSocket 进入 Mac 收件箱并得到回执。自动测试覆盖联系人冲突/撤销、其他设备拒绝、群组拒绝、过期拒绝、策略版本检查、通知去重、收件箱正文访问及会话打开授权。

实机已接收“爸爸”发送的“M1通信测试”，识别并修正了微信的“[2条]爸爸:”汇总预览格式，已写入 Mac 收件箱，事件类型为 `wechat.notification`。从该通知发起会话打开后，系统前台为微信 ChattingMainUI；Mac 本地 Vision OCR 独立核对会话标题包含“爸爸”、聊天中包含“M1通信测试”，不输出其他聊天内容。补充的2项 Kotlin/JUnit 回归测试覆盖此格式及发送者不匹配/畸形汇总拒绝，均通过。最终实机验收已通过：用户发送“M1自动接收测试”后，在没有执行手动扫描的情况下自动进入 Mac 收件箱，联系人为dad、aggregate_count=1；对应桌宠通用提示的投递状态为delivered=1，且提示内容不含通知正文。长时间熄屏、手机重启、MagicOS 后台限制仍需后续观察。

M2 将接入腾讯 iLink Bot 独立通信渠道和有联系人范围的 AI 路由；不能把通知预览当作 iLink Bot 消息，也不能把收件箱已到达当作已经回复。

## 官方资料

- Android NotificationListenerService：https://developer.android.com/reference/android/service/notification/NotificationListenerService
- Android PendingIntent：https://developer.android.com/reference/android/app/PendingIntent
- Tencent/openclaw-weixin：https://github.com/Tencent/openclaw-weixin

本轮核对的腾讯仓库提交为 `0ad1ae91347a938f52f1e4e2abd6dcda51e05f9e`，包版本 `3.0.0-beta-0`。M2 需要研究其当前扫码绑定与验证流程、会话隔离和媒体能力，不能用 README 的功能列表替代实际收发验证。本轮未引入该项目代码或运行其账号绑定。

## 后续版本

M2文字通信版已接入腾讯iLink Bot，并完成实机收发和跨渠道记忆。M1通知入口保留为独立渠道；详细说明见 [CONNECT_M2.md](CONNECT_M2.md)。
