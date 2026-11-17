# 工具跑通手册（TOOL-RUNBOOK）

五步法：**契约 → 预检 → 干跑 → 真跑一次 → 判定**。每个动作都要走到第 5 步，否则不算"跑通"。

## 状态一览

| 状态 | 含义 | 怎么改 |
|---|---|---|
| ✅ 已确认 | 真跑过，判定 `confirmed`（有回执或证据） | —— |
| 🟡 未确认 | 真跑过，但只能证明"做了"，证不了"成了"（或确实没活干） | 在 `reason` 里写清为什么 |
| ⏳ 待跑 | 一次都没真跑过 | 照 `docs/FIRST-RUN.md` 跑一次 |
| ⛔ 已下线 | 从动作表移除（`offline: true` 留档） | 见 `connect/live/retired.mjs` |

当前进度块（自动生成）：

<!-- progress:start -->

_生成于 2026-11-18 02:54_

- 覆盖度：**6/15 已确认**（未确认 2 · 失败 0 · 没跑过 7）
- 评论额度：本小时还剩 **5/5**，今天已发 8 条（上限 30）
- 生成命令：`node scripts/runbook-progress.mjs`

| 动作 | 最近判定 | 理由 | 本周真实次数 | 时间 |
|---|---|---|---|---|
| `academy.study` | 已确认 | — | 2（少） | 00:00 |
| `academy.weekly` | 已确认 | — | 3 | 01:45 |
| `douyin.reply_comments` | 未确认 | 没活干 | 9 | 00:51 |
| `douyin.hot_comment_round` | 未确认 | 没活干 | 3 | 11/17 23:52 |
| `douyin.check_interactions` | 已确认 | ok_text | 4 | 01:45 |
| `douyin.comment_latest` | 已确认 | — | 11 | 00:45 |
| `douyin.browse` | 已确认 | — | 2（少） | 11/17 23:57 |
| `douyin.draft` | 已确认 | — | 2（少） | 00:00 |
| `douyin.publish_draft` | 没跑过 | — | — | — |
| `douyin.publish` | 没跑过 | — | — | — |
| `douyin.publish_video` | 没跑过 | — | — | — |
| `qq.call` | 没跑过 | — | — | — |
| `qq.call_mom` | 没跑过 | — | — | — |
| `wechat.call` | 没跑过 | — | — | — |
| `qq.hangup` | 没跑过 | — | — | — |

> 只读工具（5 个：查天气 / 看作品 / 看评论表 / 读能力卡 / 看设备当前页面）不产生判定，未列在此表。

<!-- progress:end -->

## 契约（每个动作都要写清）

一个动作的契约 = **它能做什么 + 需要什么前置 + 成功后世界该变成什么样**。三样缺一，判定层就只能猜。

- 在 `connect/live/tool-meta.mjs` 写 `title/file/level/intro/logic`（人看的说明书）；
- 有副作用的再写 `preflight`（跑之前要确认什么）与 `command`（想手动跑怎么敲）；
- 在 `connect/live/expect-after.mjs` 写"跑完应该看到什么"，`verifyAfter()` 会照着核。

## 预检

- 通用：`node scripts/capabilities.mjs --check`
- 单条：`/live` 工具详情 →「检查现在能不能跑」（走 `GET /api/live/preflight`）
- 跑前想看全局：`/live` 顶栏「授权项就绪 6/7」点开有清单

## 干跑

凡是有副作用的动作，先跑不带副作用的开关：

| 动作 | 干跑命令 |
|---|---|
| `qq.call` / `qq.call_mom` / `wechat.call` | `--probe`（只看窗口在不在，不拨号） |
| `douyin.publish_video` | 不带 `--publish`（只上传+打开编辑页，不发） |
| `douyin.comment_latest` | `--land`（只验能不能进详情页，不发送） |

## 真跑一次

照 `docs/FIRST-RUN.md` 那 7 张单子做。要点：

1. 一次只放一个（别同时放三个通话）；
2. 跑前核验必须 ✅；
3. 跑完看三处：`/live` 事件流、工具卡「最近一次」、`task_checkpoints`；
4. 判定不是 `confirmed` 时**先看 reason**，`unknown`/`blocked:` 往往不是坏了。

## 判定

`confirmed` / `unconfirmed` / `mismatched` / `failed` / `skipped` 五态，规则在 `connect/core/verify.mjs`。
"没活干"（`nothing_to_do`）与"被自己的闸门挡住"（`blocked:`）都算 `unconfirmed`，不算失败。

## 三种归宿

| 情况 | 归宿 |
|---|---|
| 好用，能稳定跑 | 补 `expect-after` 断言，标 ✅ |
| 能用但流程长（要人工二审等） | 固化成固定流程：写进 `steps`，页面显示"分几步" |
| 用不了（页面改版/接口没了） | 从动作表下线，写进 `connect/live/retired.mjs`（原因 + 替代品） |

## 已知边界

- `douyin.hotspot` 已下线：抖音搜索页改成视频流形态，结果列表读不到。
- `douyin.comment_latest` 每次最多 90 秒间隔、每小时 5 条（自建限速，`runtime/douyin/limits.json` 可改）。
- 通话类判定只能是 `unknown`（接通与否由对方决定），`call_ended` 会写清 outcome。

## 放行清单：7 个「真实副作用」动作

这 7 个动作会真的响手机、真的公开发作品。**一次只放一个**，跑完立刻看证据。
详细的前置与收场见 `docs/FIRST-RUN.md`，这里是速查。

### 1. `qq.call` · 给爸爸打 QQ 语音

```bash
node scripts/qq-call.mjs --keep --contact 七海
```

预期：QQ 通话窗口出现并计时；挂断后事件流有 `call_ended`，带「接通/时长」。

出事怎么收：窗口没出现 → `--probe` 看窗口在不在（不在多半是权限或最小化）；对方没接 → 判定 `unknown`，属正常，不用重试。

### 2. `qq.call_mom` · 给妈妈打 QQ 语音

```bash
node scripts/qq-call.mjs --keep --contact 小朋友
```

预期：同 1，对端是「小朋友」。

出事怎么收：同上；备注名改过就会找不到人，先手动搜一次。

### 3. `wechat.call` · 用微信给妈妈打语音

```bash
node scripts/wechat-call.mjs --keep --contact 敢敢不憨了
```

预期：微信出现通话界面；挂断后事件流有 `call_ended`。

出事怎么收：核验显示「微信桌面端没启动」→ `open -a WeChat` 后再试；找不到联系人 → 先手动搜一次确认备注名。

### 4. `qq.hangup` · 挂断当前 QQ 通话

```bash
node scripts/qq-call.mjs --hangup
```

预期：通话窗口消失；事件流出现 `call_ended`。

出事怎么收：没有通话时跑会打印「没有找到进行中的通话窗口。」并判定 `unknown`——这是正确行为；真在通话却没挂断 → 手动点红色挂断键。

### 5. `douyin.publish_draft` · 把二审过的草稿发出去

```bash
node scripts/douyin-confirm.mjs
```

预期：作品页第一格出现该作品；`runtime/douyin/pending.json` 消失。

出事怎么收：`publish_unconfirmed` = 点了发作品但没看到作品，**别重复发**，先手动打开看是不是审核延迟；`pending_post_missing` = 没有待审草稿，先跑 `douyin.draft`。

### 6. `douyin.publish` · 一条到底发布

```bash
node scripts/douyin-post.mjs --plan --theme "今天想说的话"
```

预期：作品表新增一条 `status=published`；作品页出现新作品。

出事怎么收：卡在二审是设计（R3 人工确认），去 QQ 回「同意」或改跑 5；内容发错就立刻在抖音里删（自己的账号内容）。

### 7. `douyin.publish_video` · 发布一条本地视频

```bash
node scripts/douyin-video.mjs --file "/Volumes/macOS/MovieMaker/09 大肥鱼/3.mp4" --title "标题" --caption "正文" --publish
```

预期：作品页出现新视频，时长与源文件一致（±1s）。

出事怎么收：描述里带 `#` 会弹话题面板盖住「发作品」——脚本会自动 back→下一步→确认 chips 数再点；点了没反应看 `/tmp/douyin-video-publish.json` 的 dump。

## 一次真跑的证据包（可直接粘贴复核）

页面上跑完一次，结果卡右上角有「导出这次证据（Markdown）」。导出的是这样一段：

```markdown
### weather.get（weather.get）

- 时间：2026/11/18 02:54:23
- 来源：页面手动跑
- 耗时：0 ms
- 判定：**confirmed**（ok_text）

做了什么 / 实际结果：

```
石家庄现在 Clear ，6°C（体感 2°C），今天 3~8°C，湿度 34%，风速 24km/h。
```

> 这段可以直接贴给任何人复核：判定是机器给的，核对项是真去查过的，事件是库里查得到的。
```

四样东西齐全才算「有证据」：**回执**（何时、谁跑、耗时）、**判定**（机器给的 verdict + reason）、**跑后核对**（真去查库/查系统看到了什么）、**相关事件**（库里能查到的痕迹）。缺哪一样，都别把这次当成「跑通了」。

## 判定理由的词汇表

| reason | 页面说法 | 是不是问题 |
|---|---|---|
| `ok` / `ok_text` | 已确认 | 不是 |
| `nothing_to_do(n):原因×次数` | 没活干 · 扫了 n 条 · 明细 | 不是（确实没得处理） |
| `blocked:<原因>` | 被自己的闸门挡住 | 不是（限速/去重） |
| `missing_count` | 动作没带回需要的字段 | **是**（要补 data） |
| `count=0<1` | 只成 0 条（要求 ≥1） | **是**（该做没做成） |
| `Command failed` | 脚本报错 | **是**（看 detail） |
| `unknown_action:<tool>` | 走错通道（只读工具当动作跑） | **是**（调用方弄错了） |

## 在页面上跑一次（默认关着）

工具详情底部有红框「我现在要跑它」。默认点不动：服务端只认 `runtime/connect/live-run.json` 里点名的动作。

```bash
cat > runtime/connect/live-run.json <<'JSON'
{ "allowed": ["qq.call"], "note": "2026-11-18 主人放行" }
JSON
```

规则：不在清单 → `not_allowed`；有核验的动作核验不过 → `preflight_not_ready`；页面上**点两次**才发请求；跑完自动走 `evaluateOutcome()` 写 `task_checkpoints` 并自动 `verifyAfter()` 核对副作用。收回：`{"allowed": []}`。

## 已下线

| 动作 | 时间 | 原因 | 替代 |
|---|---|---|---|
| `douyin.like_comments` | 2026-11-18 | 适配层没有可验证的点赞结果 | 无 |
| `douyin.prepare` | 2026-11-18 | 旧的一审流程，已被草稿→二审→发布取代 | `douyin.draft` → `douyin.publish_draft` |
| `douyin.hotspot` | 2026-11-18 | 抖音搜索页改成视频流形态（全屏竖向滑动，按返回是换视频），结果列表读不到；原解析器依赖「标题+日期」锚点 | `douyin.browse`（刷推荐流记录看到什么） |

## 真 bug 台账（跑通过程中修掉的）

| 现象 | 根因 | 修法 |
|---|---|---|
| 定时任务全报 `Cannot find module .../runtime/connect/scripts/*.mjs` | `projectRoot` 把服务目录当仓库根 | `connect/core/paths.mjs` 向上找 `package.json`+`scripts/` |
| `works.list` 只有 2 条（真库 15 条） | 9 个模块 `join(root,'runtime',…)` 落进假的 `runtime/connect/runtime/` | 统一 `runtimeDir(root)` |
| 重试槽全挂 `task_not_startable` | 重试复用已失败任务的幂等键 | `slotAttempt()` + `sourceMessageId = <slot>#<attempt>` |
| 判定永远 `no_result_data` | 动作只返回字符串，没有 `data` | 返回 `{text,data:{status,count,…}}` |
| 页面 `/home` 整页白 | `data.mjs` import `../core/pipeline.mjs` 被令牌闸门挡成 401 | 只放行 `/core/pipeline.mjs` 这一个纯数据文件 |
| 报告页签整页白 | `summarizeFailures().buckets[].ops` 是对象，被当数组 `.slice()` | `Object.entries()` + 用真实输出做测试 fixture |

## 临时放行 30 分钟（不用改文件）

`/live` → 顶栏「授权项就绪」点开 → 每行一个按钮。规则：

| 动作类型 | 能不能点 |
|---|---|
| 只读工具（查天气、看作品、读能力卡…） | ✅ 可以，点了就能跑一次 |
| 已经 `confirmed` 过的动作 | ✅ 可以（再跑一次不会更糟） |
| 没跑过 / 只跑出 `unconfirmed` / 会响手机发布作品 | ❌ `needs_owner`，必须主人在 `runtime/connect/live-run.json` 里点名 |

到点自动失效，不用记得收回。文件长这样：

```json
{ "allowed": ["weather.get"], "grants": [{ "action": "works.list", "until": 1794941320669 }], "note": "…" }
```
