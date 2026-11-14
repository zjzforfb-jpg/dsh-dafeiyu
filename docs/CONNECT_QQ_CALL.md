# QQ 语音通话（Mac 本机，一条命令）

把 Mac 上的 QQ 变成大肥鱼的"电话"：它主动拨号，你说话它就能听见并回话。

## 一条命令

```bash
npm run connect:qq-call            # 默认拨给 runtime/sound/contacts.json 里的 qq
node scripts/qq-call.mjs --contact 七海 --row 1
```

脚本按顺序做四件事：

1. `node scripts/sound.mjs --enable`：系统默认输入切 BlackHole 2ch、输出切 BlackHole 16ch（并保存原设备）；
2. 起声卡桥：监听 BlackHole 16ch（QQ 扬声器）→ whisper → 大肥鱼 → TTS 写回 BlackHole 2ch（QQ 麦克风），同时把对方声音转放给你；
3. 坐标点击 QQ：打开联系人会话 → 点右上角电话图标 → 等语音通话窗口出现；
4. 通话窗口消失后自动停桥并 `--restore` 恢复原设备（`--keep` 可保留）。

辅助命令：

```bash
node scripts/qq-call.mjs --hangup   # 挂断当前通话
node scripts/qq-call.mjs --stop     # 停桥 + 恢复设备
```

## 为什么用坐标点击

QQ 桌面版是 Electron 应用，聊天区是 Chromium 自绘画布，辅助功能只暴露窗口按钮（关闭/全屏/最小化），拿不到联系人和呼叫键。所以走"截图定位 + CGEvent 点击"：

- `connect/macui/windows.swift`：用 CGWindowList 列出 QQ 窗口（含全局 bounds），首次运行自动 `swiftc` 编译到 `runtime/macui/bin/`；
- `connect/macui/click.swift`：先 `mouseMoved` 再按下/抬起（只发 down/up 时点击常被吞）；
- `connect/macui/qq.mjs`：窗口定位与坐标常量（会话行、电话图标、挂断键）。

快捷键位置是在"无阴影窗口截图"（`screencapture -o -x -l <id>`）里量出来的，图片坐标 + 窗口原点 = 全局坐标；带阴影截图会偏移 20–60px，不可用。

## 设备选择（QQ 里怎么点）

QQ 通话界面有每通电话的「麦克风 / 扬声器」菜单，但列表里没有 BlackHole，只有「系统默认」。所以：

- 先切系统默认（`--enable`），再拨号；
- QQ 在通话启动时解析「系统默认」，通话中途再切系统设备不生效；
- 若菜单显示 `系统默认 (STUDIO M PRO)` / `系统默认 (DAW 多声道)`，说明拨号时系统默认还是旧设备 → 挂断重拨。

## 已知限制

- 依赖 Mac 已登录 QQ，且目标联系人在会话列表里（`--row` 是列表行号，0 开始）；
- 通话音频不经过手机：手机端微信/QQ 通话无法接入声卡桥；
- 免打扰、多显示器、窗口缩放都会影响坐标；脚本每次运行都重新读取窗口 bounds，窗口尺寸变化时需重新标定常量；
- 首次运行需要编译两个 Swift 小工具（约 1–2 秒）。
