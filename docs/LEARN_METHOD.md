# 大肥鱼学东西的方法（v1）

这套方法目前只覆盖抖音，但流程本身和平台无关：换平台只换「录一遍」和选择器。

## 一句话

**看一遍 → 固化成脚本 → 收成工具 → 拿回归集守住 → 把踩过的坑写进经验库。**
四步循环，每加一个新本事都走一遍。

## 一、整套流程的名字

抖音这一整套操作，内部叫 **抖音动作闭环（Douyin Action Loop）**，四段：

| 段 | 干什么 | 代码 |
| --- | --- | --- |
| 感知 | 读手机：当前页面、列表条目、按钮位置 | `device/uia.mjs`（uiautomator2 常驻服务 19008）、`device/douyin.mjs`（选择器解析） |
| 决策 | 判断「这句话要不要动手、动哪几个工具」 | `connect/qq/planner.mjs`（输出 `{say, steps}`） |
| 执行 | 只读工具直接跑；写工具建任务、等爸爸「同意」 | `connect/qq/tools.mjs`（工具注册表）、`connect/tasks.mjs`（状态机）、`connect/actions.mjs`（动作实现） |
| 回执 | 跑完必须汇报，成败都要说，带真实明细 | `connect/receipts.mjs`、`service.reportFinishedTasks()` |

对外只暴露「工具」，不暴露「脚本参数」，这样爸爸说什么话，模型都能自己拼出调用。

## 二、学一个新本事：五步

1. **人肉走一遍，录下来**
   在真机上手动做一遍，同时用 `adb_ui`/截图记下每一步的坐标、文案、`content-desc`。
   注意：录的时候别同时开别的自动化，uiautomator 会被抢。

2. **写成脚本，先 dry-run**
   放 `scripts/` 下，默认**不产生副作用**（发布停在发布页、回复只到输入框）。
   每一步都要有「成功判据」，比如正文前 6 字能读到、开关像素是绿色。

3. **收成工具**
   在 `connect/qq/tools.mjs` 注册：
   - 只读的进 `READONLY_TOOLS`，模型能直接调；
   - 会改账号的进 `WRITE_TOOLS` 并打 `requiresConfirm: true`，模型只能「规划」，由系统建任务等爸爸确认。
   参数要少而稳（`limit`、`theme` 这种），不要把坐标、包名暴露给模型。

4. **补回归集**
   往 `scripts/intent-regress.mjs` 的 `CASES` 里加几句爸爸真会说的话，标注期望分类。
   跑 `node scripts/intent-regress.mjs`，低于 85% 算没学成。

5. **把坑写进经验库**
   静态规则写 `connect/qq/lessons.mjs`（带 `when` 正则，按需注入）；
   运行中发现的教训用 `learnLesson(home, text)` 落到 `runtime/dsh-home/lessons.json`，
   下次规划时会自动带上。

## 三、为什么这样学得快

- 脚本是「事实」，模型只是「嘴」：坐标、限速、页面跳转这些硬知识不靠模型记，靠脚本。
- 工具是「接口」：新本事接进来，模型不用重训，规划器看到新工具名就会用。
- 回归集是「刹车」：改 prompt、换模型、加工具，跑一遍 30 句就知道有没有学坏。
- 经验库是「肌肉记忆」：同一个坑踩过两次就变成一条规则，不再靠爸爸重复提醒。

## 四、验收一个本事算不算学会

- [ ] 爸爸用日常说法（不用术语）能触发；
- [ ] 问句不会误触发写操作；
- [ ] 写操作一定经过确认，且确认前不上手机；
- [ ] 失败有明细，不是「执行失败」四个字；
- [ ] 跑完主动汇报；
- [ ] 回归集 + `npm test` 全绿；
- [ ] 踩过的坑已进 `lessons`。

## 五、当前已会的抖音本事

| 本事 | 入口 | 状态 |
| --- | --- | --- |
| 发图文（两次审核） | `douyin.publish` / `scripts/douyin-post.mjs` + `douyin-confirm.mjs` | 已跑通 |
| 回复收到的评论 | `douyin.reply_comments` / `scripts/douyin.mjs --reply-inbox` | 已跑通（90 秒限速） |
| 查作品/评论/回复记录 | `works.list` / `comments.list`（读库） | 已跑通 |
| 上手机看互动消息 | `douyin.check_interactions` / `scripts/douyin.mjs --interactions` | 只读，已接 |
| 看手机当前页面 | `device.page` | 已接 |
| 点赞、给对标账号评论 | `douyin.like` / `douyin.comment_latest` | 未验证，暂不给模型用 |
