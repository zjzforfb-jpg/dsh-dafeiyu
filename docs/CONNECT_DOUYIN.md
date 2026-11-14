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

## 搜索 / 对标账号 / 互动消息（2026-11-14 增强）

```bash
node scripts/douyin.mjs --search "deepseek harness"          # 搜索并列出视频结果
node scripts/douyin.mjs --save-accounts --keyword "大肥鱼"    # 存对标账号到 runtime/douyin/accounts.json
node scripts/douyin.mjs --accounts                           # 看已存的对标账号
node scripts/douyin.mjs --account-works "这个刀子真甜"        # 搜账号 → 打开主页 → 列最近作品
node scripts/douyin.mjs --interactions                       # 消息 → 互动消息 列表
node scripts/douyin.mjs --reply-interaction 0 --text "…"      # 打开第 N 条互动并回复
npm run douyin:watch -- --once                               # 互动守护跑一轮
npm run douyin:watch -- --interval 1800                      # 每 30 分钟一轮
node scripts/douyin.mjs --auto-comment --keyword "…" --pick-text "标题片段" --generate [--dry-run]
```

要点：

- 流程开头会 `am force-stop` + 重启抖音，避免上次页面状态串味；
- 搜索结果默认切到「视频」Tab 再解析，卡片结构 = 标题 / 作者 / 日期 / 点赞；
- 对标账号存 `runtime/douyin/accounts.json`（名字、话题、最近作品、首次/最近看到时间）；
- 所有评论/回复先过 `connect/douyin/compliance.mjs` 的合规闸门：L3 阻止、L2 转人工、L1 才自动发；另有每日 10 条上限、90 秒最小间隔、24 小时去重；
- 互动消息列表目前为空时显示「你还没有收到互动消息」，解析会过滤这类空态与时间噪声。

## 受众定位（写进人设用）

大肥鱼的目标粉丝：20–30 岁、喜欢萌宠的大学生，以及对 AI / DeepSeek Harness 感兴趣的技术宅。评论语气参考：「你们在说什么啊，大肥鱼才不知道呢🐟」这类装傻+可爱、带表情的短句。
