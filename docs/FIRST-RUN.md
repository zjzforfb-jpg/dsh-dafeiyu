# 第一次真跑 · 操作单

给 7 个「有真实副作用」的动作各写一张单子。**不需要读完全部文档**，照着对应那一节从上往下做就行。

每条都长一样：

1. **跑前**：先看 `/live` 顶栏的「授权项就绪」，确认那一条是 ✅（不是 ✅ 就先别跑）。
2. **命令**：复制粘贴即可（`/live` 工具详情里也能一键复制）。
3. **跑完**：点 `/live` 工具详情的「检查跑完的结果」，或者直接请求 `GET /api/live/verify?action=<动作>`。
4. **收场**：三种结局分别怎么办，见每节末尾。

所有命令都在仓库根目录执行（`cd /Volumes/macOS/tools/DSH-dafeiyu`）。

---

## 1. `qq.call` · 给爸爸打 QQ 语音

**前置**：`授权项就绪` 里 `qq.call` 为 ✅（需要 QQ 主窗口在屏、标题可读 → 屏幕录制权限）。

```bash
node scripts/qq-call.mjs --keep --contact 七海
```

**跑完应该看到**：QQ 通话窗口出现并计时；挂断后事件流出现 `call_ended`，带「接通/时长」。

**三种收场**：

- **接通并聊完** → 判定 `confirmed`；`runtime/sound/call-outcome.json` 里 `outcome: "ended"`。
- **对方没接** → 判定 `unknown`（不是失败）。`call_ended` 里 `outcome: "no_answer"`；不用重试，等下次。
- **完全没动静**（窗口都没出现）→ 先跑 `node scripts/qq-call.mjs --probe --contact 七海` 看窗口在不在；不在就是 QQ 窗口被最小化了或权限掉了。

---

## 2. `qq.call_mom` · 给妈妈打 QQ 语音

同 1，只是对端换成「小朋友」：

```bash
node scripts/qq-call.mjs --keep --contact 小朋友
```

**跑完应该看到**：和 `qq.call` 一样——通话窗口计时、挂断后有 `call_ended`，只是对端是「小朋友」。

---

## 3. `wechat.call` · 用微信给妈妈打语音

**前置**：`wechat.call` 为 ✅（微信桌面端必须**已启动**；没启动时核验会显示「微信桌面端没启动」）。

```bash
node scripts/wechat-call.mjs --keep --contact 敢敢不憨了
```

**跑完应该看到**：微信窗口出现通话界面；挂断后事件流出现 `call_ended`。

**收场**：

- 微信没开 → `open -a WeChat` 等它起来，再核验一次。
- 微信在但找不到联系人 → 先手动搜一次这个名字，确认备注名没变。

---

## 4. `qq.hangup` · 挂断当前 QQ 通话

**前置**：这一项只有**正在通话中**才会 ✅。所以顺序是：先让别人打进来（或先拨出去），趁通话中再跑。

```bash
node scripts/qq-call.mjs --hangup
```

**跑完应该看到**：通话窗口消失；事件流出现 `call_ended`（结局 `ended` / `cancelled`）。

**收场**：

- 没有通话时跑 → 脚本会干净退出并打印「没有找到进行中的通话窗口。」，判定 `unknown`。这是**正确行为**，不是 bug。
- 通话在但挂断没生效 → 看 `/live` 事件流里有没有 `call_ended`；没有就手动点红色挂断键，再核验一次。

---

## 5. `douyin.publish_draft` · 把二审过的草稿发出去

**前置**：`douyin.publish_draft` 为 ✅（手机在线 + 恰好 1 台）；且 `runtime/douyin/pending.json` 里有一份 `status: pending` 的草稿。

```bash
node scripts/douyin-confirm.mjs
```

**跑完应该看到**：作品页第一格出现该作品；`pending.json` 消失。

**收场**：

- **发出去了** → 判定 `confirmed`；`receipt_verified` 事件里 `operation: douyin.publish`。
- **点了发作品但没看到作品** → 判定 `unconfirmed`，reason 是 `publish_unconfirmed`。**别重复发**：先手动打开抖音看作品页，确认是不是审核延迟。
- **没有待审草稿** → 返回 `pending_post_missing`。先跑 `douyin.draft` 生成一份。

---

## 6. `douyin.publish` · 一条到底发布（生成 + 存草稿 + 二审 + 发布 + 核验）

**前置**：`douyin.publish` 为 ✅；这一条会**真的公开**，所以确认内容与时间都合适。

```bash
node scripts/douyin-post.mjs --plan --theme "今天想说的话"
```

**跑完应该看到**：作品表新增一条 `status=published`；作品页出现新作品。

**收场**：

- 卡在二审 → 这是设计（R3 人工确认）。去 QQ 回「同意」，或直接跑 5。
- 发出去但内容不对 → 立刻在抖音里删（可以删，属于你自己账号内容）。

---

## 7. `douyin.publish_video` · 发布一条本地视频

**前置**：`douyin.publish_video` 为 ✅；视频文件存在且是 `mp4`（h264 + aac）。

```bash
node scripts/douyin-video.mjs --file "/Volumes/macOS/MovieMaker/09 大肥鱼/3.mp4" \
  --title "标题" --caption "你想写的正文" --publish
```

**跑完应该看到**：作品页出现新视频，时长与源文件一致（±1s）。

**收场**：

- 描述里带 `#` 会弹出话题候选面板盖住「发作品」→ 脚本会自动 back → 下一步 → 再确认 chips 数量才点，这是已验证的序列。
- 点了没反应 → 看 `/tmp/douyin-video-publish.json` 的 dump，确认当前在不在发布页。
- 发出去但封面难看 → 抖音里可以「编辑封面」，不影响判定。

---

## 通用：跑完怎么记账

每次真跑完，我希望你（或我）做三件事，这套已经自动化了：

1. `/live` 工具详情点「刷新『最近一次』」——判定与理由进卡片。
2. `node scripts/runbook-progress.mjs`——进度表写回 `docs/TOOL-RUNBOOK.md`。
3. 如果是第一次跑通，把 `docs/TOOL-RUNBOOK.md` 状态表的 ⏳ 改成 ✅，并在 §10 记一行。

## 放行姿势（别一次全开）

- **一次只放一个**：说「现在可以打给爸爸」，我只跑 `qq.call`，跑完立刻汇报证据。
- 判定不是 `confirmed` 时**先看 reason**，别急着说「坏了」——`unknown` 往往只是「没接通」「没活干」。
