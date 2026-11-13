# 安卓设备接入调查（荣耀 Magic5）

调查日期：2026-11-14。当前设备通过 USB ADB 连接到 Mac：HONOR PGT-AN20，Android 16 / API 36。使用 `/opt/homebrew/bin/adb`，Android Debug Bridge 1.0.41（platform-tools 36.0.2）。抖音 `com.ss.android.ugc.aweme` 与微信 `com.tencent.mm` 已安装。当前只完成设备识别，没有读取通知、聊天记录，也没有发送、评论、发布或支付。

## 连接与控制方案

### 控制基线：USB ADB 命令行

Mac 已安装 `/opt/homebrew/bin/adb` 并获得设备 USB 调试授权。使用 ADB 命令作为项目的唯一设备控制通路，不依赖 Appium、Airtest、辅助 App 或 root。项目提供 `npm run device:status` 只读显示设备型号、Android 版本与目标 App 安装状态；不输出设备序列号。Mac 上也有 `scrcpy`，但它只是可选的人工镜像窗口，不作为自动化控制依赖。

ADB 控制循环为“dump → 按文字/testTag 定位 bounds → 计算中心点 → 点击或输入 → 再 dump”；常用命令是 `adb shell uiautomator dump`、`adb shell input tap/swipe/text/keyevent`、`adb exec-out screencap -p`、`adb shell am start` 和 `adb shell dumpsys activity`。应用安装只针对自有 Android 伴侣 App：`adb push`、`adb shell pm install -r` 后，通过 `dumpsys package` 的 `lastUpdateTime` 核对安装结果。

项目的 `npm run device:screenshot` 使用 `adb exec-out screencap -p` 保存私有截图到 Git 忽略的 `runtime/device/`，限制目录为 `0700`、PNG 文件为 `0600`；它不会自动打开图片或读取画面内容。

有两个明确的恢复分支：荣耀安装风险提示若在独立窗口导致 `uiautomator dump` 看不到节点，采用受屏幕尺寸约束的比例坐标并在每步截图核对；Compose 内嵌 WebView 不进入控件树时，以截图为观察来源，不依赖 UI dump 或 logcat。`uiautomator dump` 若超时或报 `UiAutomationService already registered`，停止本轮自动化并切换截图观察，不自动重启手机。所有 dump 和截图都是本地潜在敏感数据，不输出聊天内容到普通日志。

坐标操作依赖当前屏幕布局，应用弹窗、广告、MagicOS 权限页和版本更新都可能令流程失效。P4 自动动作必须先确认屏幕状态，并保存请求、动作和结果回执；状态不确定时停止，不重放发送或发布动作。

### 后续自动化：Android 伴侣 App

如需要长期后台连接、通知入口和稳定的语义化交互，再实现一个自有 Android 伴侣 App：通过用户可见的 AccessibilityService 做界面观察/受控点击，通过 MediaProjection 在用户授权会话中共享屏幕，通过配对密钥与 Mac 本地网关加密通信。ADB 作为调试和恢复通道保留。UI Automator 是 Android 官方提供的跨 App UI 测试框架，适合先验证控件树和流程；不把测试框架本身当作常驻控制服务。

## 抖音

优先评估官方开放平台授权能力：官方文档列出视频/图片发布、已授权账号作品管理与数据查询；评论读取/回复需要对应互动管理权限，评论管理的部分能力依账号类型和获批权限而异。先确认这个账号可以给开发应用授权，并按“草稿→爸爸审阅→官方接口发布→读取回执”接入。若权限不覆盖账号需要的动作，再考虑在手机官方 App 内可见地操作；避免私有协议、注入或绕过平台风控。

## 微信

微信开放平台官方入口列出的移动应用能力主要是微信登录、分享、支付等 SDK 能力。当前查到的官方公开材料没有表明个人微信号提供通用的聊天读取/发送 API；这是基于公开开放能力范围的判断，不是对所有未公开能力的断言。微信个人聊天原型因此优先走荣耀手机上的官方微信 UI，通过屏幕状态确认收件人和文本；每次发送由爸爸确认。禁止抓取或解密本地聊天数据库，也不使用非官方个人号协议。

### 微信发消息（2026-11-14 已跑通）

微信 8.0.79 的聊天列表和聊天页都不向 `uiautomator` 暴露控件（`uiautomator dump` 只返回状态栏节点，`dumpsys window` 里窗口是 `0×0` 的空树），所以微信链路完全靠“截图核对 + 固定坐标”驱动：

1. `am start --user 0 -n com.tencent.mm/.ui.LauncherUI` 把微信拉到前台。
2. 两次 `input keyevent BACK`：先收键盘、再退出可能停留的聊天页（微信聊天是 `LauncherUI` 内部页面，没有独立 Activity）。
3. 再次 `am start` 并点底部“微信”tab，回到聊天列表。
4. 点置顶联系人所在行，再点输入框。
5. 文字输入走 ADBKeyboard 广播：`am broadcast -a ADB_INPUT_B64 --es msg '<base64>'`（UTF-8 base64，避免引号和中文转义问题；`ADB_INPUT_TEXT` 对纯中文也可用）。
6. 发送走 `am broadcast -a ADB_EDITOR_CODE --ei code 4`（`IME_ACTION_SEND`）；ADBKeyboard 不显示键盘，所以不依赖搜狗输入法的“发送”键坐标。
7. 每步前后用 `screencap` 截图核对收件人、输入框内容和绿色气泡。

`adb shell input text` 不支持非 ASCII（会抛 `InputShellCommand.sendText` 的 `NullPointerException`），中文一律用 ADBKeyboard。前置安装（开源 ADBKeyboard，包名 `com.android.adbkeyboard`）：

```bash
curl -sSL -o /tmp/ADBKeyboard.apk https://github.com/senzhk/ADBKeyBoard/raw/master/ADBKeyboard.apk
adb install -r /tmp/ADBKeyboard.apk
adb shell ime enable com.android.adbkeyboard/.AdbIME
```

已固化命令：

```bash
npm run device:wechat -- --list                        # 列出配置里的联系人
npm run device:wechat -- --to 爸爸 --message "内容" --dry-run   # 只填草稿并截图，不发送
npm run device:wechat -- --to 爸爸 --message "内容"             # 真正发送
```

坐标与联系人放在 `config/wechat.json`（当前：爸爸第 1 行 `600,380`、妈妈第 2 行 `600,611`、输入框 `545,2730`、微信 tab `181,2760`）。修改置顶顺序、换手机或换分辨率后必须重新标定。脚本会把原输入法记下来并在 `finally` 中切回；截图存 `runtime/device/wechat/`（目录 `0700`、文件 `0600`，Git 忽略）。双开分身空间把 `user` 改成 `128` 即可，但分身里的联系人坐标需要单独标定。


## 下一步实施顺序

1. 用 `npm run device:status` 确认连接、系统版本和 App 版本。
2. 先通过 ADB 做只读观察和打开 App；需要人工看屏幕时可用 scrcpy 镜像，确认 MagicOS 的权限/锁屏/分辨率限制。
3. 建立本地设备会话：设备配对、屏幕观察、前台 App 识别、动作回执和一键断开。
4. 抖音先验证授权应用发布能力和评论权限；微信发消息链路已跑通（`npm run device:wechat`，先 `--dry-run` 预览再发送）。
5. 添加评论、私信或发布前，先提供逐次预览、目标确认、去重键和可回查结果。

官方参考：

- [Android Debug Bridge](https://developer.android.com/tools/adb)
- [Android 开发者选项与 USB 调试](https://developer.android.com/studio/debug/dev-options)
- [UI Automator](https://developer.android.com/training/testing/other-components/ui-automator)
- [scrcpy 官方仓库](https://github.com/Genymobile/scrcpy)
- [抖音内容发布接入方案](https://open.douyin.com/platform/resource/docs/ability/content-management/douyin-publish-solution/)
- [抖音视频评论管理接入方案](https://open.douyin.com/platform/resource/docs/ability/interaction-management/video-comment-management-solution)
- [腾讯开放平台](https://open.tencent.com/)
