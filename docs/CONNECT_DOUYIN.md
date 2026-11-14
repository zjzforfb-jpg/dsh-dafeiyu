# 抖音（手机 ADB）评论研究版

用荣耀 Magic5 上的抖音 App 做评论互动：读评论、发评论、回复别人的评论。只做文本，发图/发视频留到后续。

## 命令

```bash
node scripts/douyin.mjs --comments                       # 只读：列出当前视频评论区
node scripts/douyin.mjs --comment "文案" --dry-run        # 演练：输入到输入框但不发送
node scripts/douyin.mjs --comment "文案"                  # 真发一条评论
node scripts/douyin.mjs --reply-match "关键词" --reply "文案" --dry-run
node scripts/douyin.mjs --reply-match "关键词" --reply "文案"
```

前提：手机停在抖音某个视频上（首页信息流或详情页），抖音账号已登录。

## 实现要点

| 能力 | 做法 |
| --- | --- |
| 读界面 | 走设备端 uiautomator2 的 JSON-RPC：`adb forward tcp:19008 tcp:9008`，POST `/jsonrpc/0` 调 `dumpWindowHierarchy [false]`。**不要**直接用 `uiautomator dump`，会和常驻服务抢 UiAutomation 被杀。 |
| 点按钮 | `input tap`，坐标从 dump 的 bounds 算（`device/uia.mjs`）。 |
| 输入中文 | 临时切 ADBKeyboard，`am broadcast -a ADB_INPUT_B64 --es msg <base64>`，结束后切回原输入法。 |
| 打开评论 | 点右侧评论图标（1312×2848 下约 1136,1859）。 |
| 发评论 | 点底部输入条（约 610,2735）→ 输入 → dump 里找 `Text "发送"` → 点它。 |
| 回复 | dump 里每条评论后面有一个可点的 `Text "回复"`；点它进入「回复 @某某」输入框，再同发送流程。 |

## 已验证

- 2026-11-14：在一条真实视频下发了「这个视频看着真不错，收藏了」，评论区顶部出现自己的评论（刚刚）；
- 同一视频下回复「呆呆ོ..」的评论「这个说法有点戳我，缘分有时候真像躲不掉的」，回复成功挂在原评论下；
- `--dry-run` 能定位到发送按钮且不发送；退出时会自动清掉草稿。

## 限制与待办

- 抖音界面大量文字可被 uiautomator 读到，但视频画面/字幕需要视觉模型（当前靠大肥鱼截图理解）；
- 评论内容审核：真实账号发评论前应由大肥鱼自己判断语气，必要时先让爸爸过目；
- 尚未做：点赞/收藏、私信、发布作品（图文/视频）、视频号（微信「发现」）。
