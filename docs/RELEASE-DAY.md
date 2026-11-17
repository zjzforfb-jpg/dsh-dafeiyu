# 放行当天：按这个顺序跑

> 这张表与 `connect/live/release-plan.mjs` 同源（`tests/release-plan.test.mjs` 会比对顺序）。改顺序先改代码，再回来改这里。

前一步稳了再跑下一步——不是为了好看：后面每一条都依赖前面验过的公共前置。

## 1. 先给自己/家人打一通 QQ 语音

- 动作：`qq.call`
- 为什么排这里：验证三件公共前置一次到位：QQ 主窗标题读得到（屏幕录制）、voice-bridge 切得动声卡、语音桥能说话。后面所有通话类动作都靠这一条。
- 前置：qqWindow / qqBridgeSound / ownerTiming
- 停的条件：拨出去对方没响 / 响了但接起来听不到声音 / 挂断后声卡没恢复 → 先修声卡，别急着跑后面的。

## 2. 通话中试一次挂断

- 动作：`qq.hangup`
- 为什么排这里：同上一条同一通电话里就能验完，成本最低；它同时验证「能找到通话窗口」这件事。
- 前置：qqCallWindow
- 停的条件：挂断后窗口不消失 / 误挂到别的东西 → 说明窗口识别在漂，停。

## 3. 再拨妈妈（不同联系人）

- 动作：`qq.call_mom`
- 为什么排这里：验证「换联系人」这条路径（搜索→点人→拨号），而不是只对一个人有效。
- 前置：qqWindow / ownerTiming
- 停的条件：拨错人 → 立刻停，先修联系人匹配。

## 4. 微信语音（换一个客户端）

- 动作：`wechat.call`
- 为什么排这里：微信走的是另一套窗口识别（owner 名有「微信」与「WeChat」两种写法），单独验一次。
- 前置：wechatRunning / ownerTiming
- 停的条件：微信没启动 / 找不到窗口 → 先打开微信再重试一次；两次都不行才停。

## 5. 发一条「已经审过」的草稿

- 动作：`douyin.publish_draft`
- 为什么排这里：这是发布链路里风险最低的一段：草稿是现成的，人已经看过内容，只是把「点发作品」这条路走通。
- 前置：device / pendingDraft / ownerApproval
- 停的条件：点了发作品但作品页没新作品（publish_unconfirmed）→ 先人工看一眼手机，别重复发。

## 6. 发一条本地视频

- 动作：`douyin.publish_video`
- 为什么排这里：视频比图文多两步（media scanner + 剪辑页「下一步」），单独验，避免和图文混在一起排错。
- 前置：device / videoFile / ownerApproval
- 停的条件：卡在剪辑页（找不到「下一步」）→ 停，说明这个抖音版本的页面又变了。

## 7. 最后才跑「一条到底」的生成式发布

- 动作：`douyin.publish`
- 为什么排这里：它同时依赖「模型产出」和「发布链路」，两条都不可控；放最后，前面都稳了再跑。
- 前置：device / modelOk / ownerApproval
- 停的条件：生成内容不满意 → 用 douyin.draft 走两段式，不要硬发。

## 收尾

每一步开始前和结束后，都可以敲一次自检（只读，不会跑任何副作用动作）：

```bash
npm run release:check      # 等价于 node scripts/release-check.mjs
```

它会打印：放行顺序、下一步该跑哪个、放行清单与备注、7 个动作逐条的「已放行 / 前置 / 上次判定」。输出里出现 `还有 N 项不满足` 就是还没到能跑的状态，先按它的提示补。

全部跑完后：

1. 跑 `node scripts/runbook-progress.mjs`，把最新判定写回 `docs/TOOL-RUNBOOK.md` 的进度块；
2. 在 `/live` 的「本轮报告」确认覆盖度数字变了（`6/15 → 7/15 …`）；
3. 每跑完一个，用结果卡上的「导出这次证据（Markdown）」留一份，贴到当日记录里；
4. 在 `docs/UNIFIED_AGENT_IMPLEMENTATION_PLAN.md` §10 添一行，写清哪几个动作转了 confirmed。
