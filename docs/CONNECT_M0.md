# DaFeiYu Connect · M0 / Companion 0.1

2026-11-14，当前交付范围为用户《大肥鱼通信系统 2.0》最后明确的五项 M0 功能。

- [x] Magic5 设备注册，独立设备凭证。
- [x] Mac 与 Companion 的双向 WebSocket。
- [x] 心跳、在线状态、断线退避重连。
- [x] Mac 请求打开白名单应用，由手机 Companion 执行。
- [x] 命令执行结果回传、持久保存、幂等处理。

## 已部署与实机证据

手机已安装 `com.dafeiyu.companion` 0.1.0（调试 APK）。Mac 通过 `com.dafeiyu.connect` 独立 LaunchAgent 运行服务，不影响桌宠进程。

实机：HONOR PGT-AN20 / Android 16 / MagicOS 10。已成功注册，ping 返回 `pong`。`app.launch {app:settings}` 返回 `launch_requested`，并通过只读 `dumpsys activity` 独立确认前台为 `com.android.settings/.HWSettings`。重启 Mac Connect 服务后，手机自动重连，第二次 ping 成功。前台服务状态由系统确认 `isForeground=true`。后台打开应用在未授权时会返回 `needs_foreground_or_overlay_permission`，不会报告已经打开。

Node 测试覆盖未授权 API/WS、离线设备、过期命令、应用白名单、命令去重/冲突、回执持久化与断线未知状态；当前项目全部 8 项测试通过。APK 已用 JDK17 / Gradle8.11.1 / AGP8.9.2 / SDK35 构建。

未验收：长时间熄屏/跨网络保活、真实注销登录、重启手机后的自启、后台悬浮窗授权后的远程打开。用户在手机上主动断开后，需要重新打开 App 并连接。

## 运行

```sh
npm run connect:status
npm run connect:ping
npm run connect:launch -- settings
```

启动应用别名限于 `settings`、`companion`、`wechat`、`douyin`。保持 Companion 页面在前台即可远程打开应用。若需要从其他 App 或后台持续打开，可在手机 Companion 内点击“允许后台打开应用（可选）”，在系统设置中由用户授权；锁屏与系统后台限制仍以设备实际行为为准。成功回执的 `launch_requested` 只说明 Intent 已提交，不是屏幕内容或微信登录成功的证明。

```sh
npm run connect:service:install   # 安装并启动 Mac 登录服务
npm run connect:service:start
npm run connect:service:stop
npm run connect:service:uninstall
npm run connect:start             # 手动前台运行，需先停止登录服务
```

手机 App 提供连接、断开与授权入口。Mac 服务每 10 秒恢复已配对 USB 设备的反向端口映射；手机每 10 秒发心跳，连接中断以 1～30 秒退避重连；超过 45 秒无心跳，Mac 将会话断开。Mac/手机休眠与断网不会保证按时工作。

## 构建和安装

需要 JDK17、Android SDK `platforms;android-35` 与 `build-tools;35.0.0`。当前机器的构建工具安装在被 Git 忽略的 `runtime/build-tools/`。Gradle Wrapper 已包含在 Android 工程中。其他机器可设置 `JAVA_HOME` 和 `ANDROID_HOME` 后：

```sh
npm install
npm run connect:build
npm run connect:service:install
npm run connect:pair
```

`connect:pair` 要求恰好一台已授权 USB 设备，安装 APK，向应用私有目录写入配对凭证，建立 `adb reverse tcp:8765 tcp:8765`，打开 Companion。它会使该手机的 Companion 使用本项目配对配置。开发安装通过 `run-as` 写入调试应用沙箱；正式版需另做用户可见的配对流程和正式签名。APK 路径：`android/DaFeiYuCompanion/app/build/outputs/apk/debug/app-debug.apk`。安装后检查 `dumpsys package` 的版本与更新时间。

## 技术选择

Mac 端沿用 Node.js，减少与现有 Node/SQLite 项目并行维护第二个 Python/FastAPI 服务的成本。手机端使用 Kotlin、原生轻量设置页、OkHttp WebSocket 和 Android connectedDevice 前台服务；Compose、Room、联系人、通知监听等属于后续里程碑。M0 不需要这些组件即可完成五项交付。

API 与 WebSocket 共用 `127.0.0.1:8765`，手机经 USB 反向隧道连接手机本机 `127.0.0.1:8765`。Android 明文连接仅允许此回环地址，不允许任意局域网地址。此版本依赖 USB 隧道；Tailscale/TLS 无线连接尚未实现。手机由 Companion 执行动作，ADB 负责安装、配对与隧道恢复；原有 ADB 微信工具继续作为独立备用适配器。

Android 14+ 前台服务须声明相应服务类型与权限，应用可见性须显式声明目标包。工程按官方要求声明了 connectedDevice 类型、所需网络权限和四个目标包：

- https://developer.android.com/develop/background-work/services/fgs/service-types#connected-device
- https://developer.android.com/training/package-visibility/declaring

## 协议与数据

HTTP `/health` 为基本健康状态，`GET /devices`、`POST /commands`、`GET /commands/{id}` 要求管理员 Bearer token。WebSocket `/device` 使用独立设备 Bearer token 和 `X-Device-Id`，两种凭证不能互用。请求体/WS 帧限制 16KB。

```json
{"id":"cmd_001","type":"command","device_id":"honor_magic5","action":"app.launch","payload":{"app":"settings"},"expires_at":"使用未来120秒以内的ISO时间"}
```

手机上行类型为 `register`、`heartbeat`、`result`，Mac 回传 `ack`、`result_ack`。命令过期后不执行；同一命令编号重复提交只返回原状态，内容不同返回 409。手机在执行前同步记录执行标记，完成后同步记录回执；重连重发回执，不重做动作。进程崩溃或连接中断期间无法判定结果时标记 `unknown`，需要检查实际状态；不会自动再次打开应用。所有时间输出为 UTC/ISO 或明确的 SQLite UTC 时间。

凭证和 SQLite 都在 `runtime/connect/`（目录0700、凭证/数据库0600）；配对信息在手机应用沙箱；凭证不放在 Intent extras、命令行参数或普通日志中。日志在 `~/Library/Logs/DaFeiYu/connect*.log`。通话、联系人、微信消息、语音媒体不在 M0 协议白名单内。

M1～M5（通知、微信/iLink、SIM 电话、VoIP 和双向音频）尚未实施。后续分别验证渠道能力；M0 成功不代表已经具备电话或微信收发能力。

## 后续版本

Companion 已继续升级至0.2 / M1。M0 的验收记录保留，当前使用与白名单、通知设置见 [CONNECT_M1.md](CONNECT_M1.md)。
