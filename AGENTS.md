# 大肥鱼 · 工作区约定

给所有在这个仓库里改代码的 agent（包括我自己）。

## 前端维护约定（最重要的一条）

**只要动了功能，就必须同步维护「实时工作流」页面。**

- 页面：`http://127.0.0.1:8765/live/`，代码在 `connect/live/`（`catalog.mjs` 阶段与事件映射、`tool-meta.mjs` 工具说明书、`api.mjs` 数据接口、`index.html`/`live.css`/`live.js` 界面）。
- 触发条件：新增 / 修改 / 删除以下任何一样——
  - 一个动作（`connect/actions.mjs` 的 `ACTIONS`）或一个工具（`connect/qq/tools.mjs`）
  - 一个事件类型（`connect/agent-events.mjs` 的 `EVENT_TYPES`）
  - 一个流水线阶段（`connect/core/pipeline.mjs` 的 `PIPELINE`）
  - 一项定时任务（`connect/scheduler.mjs` 的槽位类型）
- 要做到的事：
  1. 动作新增 → 在 `connect/live/tool-meta.mjs` 的 `TOOL_META` 补 `{title,file,level,intro,logic}`（用户看的标题、入口文件、自动化等级、能做啥、内部怎么走）。
  2. 事件新增 → 在 `connect/live/catalog.mjs` 的 `EVENT_ROUTE` 里给它一个阶段与状态；暂时不打算上页面的，写进 `UNMAPPED_EVENTS` 并说明原因（别让它默默消失）。
  3. 阶段变化 → 只改 `connect/core/pipeline.mjs`，`catalog.mjs` 的 `STAGES` 与 `/home` 的九步带都从它派生。
  4. 改完在本地跑一遍 `node --test tests/live-coverage.test.mjs`（以及全量 `node --test tests/*.test.mjs`）。
- 这条约定有自动检查兜底：`tests/live-coverage.test.mjs` 会失败并指名道姓告诉你漏了哪个动作 / 哪个事件 / 哪个阶段。**不要改测试来让它变绿**——那等于把约束删了。
- 范围：现在**只维护 `/live`**。`/home`、`/board`、`/arch` 的同步放到之后，等 `/live` 这套办法跑顺了再照抄过去。

## 其它既有约定（简述）

- 改完功能：跑全量测试；重启受影响的服务（`launchctl kickstart -k gui/501/com.dafeiyu.connect` 等）；在 `docs/UNIFIED_AGENT_IMPLEMENTATION_PLAN.md` 的 §10 实施记录表里加一行，并把测试口径更新成最新数字。
- 手机相关动作（抖音、微信）只走 adb；不要为了「看一眼」把手机点亮或把抖音抢到前台。
- 不擅自提交：工作区改动默认留在本地，等主人明确要求再 commit。
