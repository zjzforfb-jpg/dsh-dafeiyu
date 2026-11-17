# 大肥鱼统一智能体 · 实施计划 v1.0（已落地）

> **状态**：**已全部落地 —— 批 0 → P0-A → P0-B → P0-C → P1-A → P1-B → P1-C → P2，共 8 批**（见 §10）。§0–§3 保留 **2026-11-16 02:13 的调研快照**语义（用来追溯"当时为什么这么排"），**现状以 §5 验收门槛与 §10 实施记录为准**。
> **基线**：`a965f36 Prepare public release: MIT license, asset notice, scrub personal IDs` + 工作区 **185 项未提交变更**（48 改 + 137 未跟踪；按用户要求未建 commit）
> **基线快照时间**：**2026-11-16 02:13**（调研期间工作区存在并发改动，见 §0.0）
> **自检（最新，2026-11-16 19:20 收尾后复测）**：`node --test tests/*.test.mjs` → **329 / 329 通过**（Node v24.18.1）；`node scripts/capabilities.mjs --check` → `{"count":12,"indexLength":492,"problems":[]}`；`node scripts/release-check.mjs` → 只剩 `stability-window-seven-days` 一项红（`samples:271, coverage_hours:46.20`，需满 7 天真实运行，非代码门槛）
> **历史自检（02:20 调研基线）**：190 / 190 通过（本计划的"≥205"门槛即"该基线 + 约 15 条新增"，最终净增 139 条）
> **依据**：《大肥鱼统一智能体总体架构设计 V1.0》（2348 行，2026-11-16）+ 对本仓库全部关键模块的逐文件实测
> **取代**：`docs/UNIFIED_AGENT_IMPLEMENTATION_PLAN.md` v0.1（2026-11-16 01:49，已另存为 `docs/UNIFIED_AGENT_IMPLEMENTATION_PLAN.v0.1.md`）
> **注意**：§0–§3 内的"190/190""34 张表""R-01 必须先堵"等均为**调研当时**的读数，未回填；不这么做会抹掉"当时判断 vs 后来实际"的对照。

### 0.0 ⚠ 关于"基线在动"

调研窗口（02:00–02:13）内，工作区有文件被并发改动，本计划据此做了两次校准：

| 观察 | 影响 |
|---|---|
| `connect/qq/store.mjs:19-31` 新增了 `qq_peers.role` 列（ALTER 探测式）+ `syncQqOwner(db, ownerId)`；`connect/qq/service.mjs:324` 改为 `peer(...)?.role === 'owner' ? 'owner' : 'friend'` | §3 R-01 中"QQ 侧 senderRole 被硬编码成 owner"**已被并行改动吸收**，本计划改为跟踪其剩余缺口（写入路径、迁移治理、Brain 侧仍收不到信封） |
| `brain/server.mjs:108` **仍然**硬性要求 `connectScope.channel === 'ilink'`；`:124` 仍为 `senderRole: connectScope?.role ?? 'owner'`；`:189,214` 仍在无信封时以 `channel:'desktop', privacyScope:'private'` 记日记 | **R-01 的核心（Brain 代理收不到 QQ 身份）依然成立**，且是当前最高优先级 |
| 测试数 188 → 189 → **190**（02:20 复测） | 本计划所有"用例数"门槛按 **基线 + 15 条** 表述；绝对值取审阅当日实跑数 |

**建议**：审阅期间如果还有并行开发在跑，请以 §10 的快照时间对齐；本计划每个结论都标了 `file:line`，可直接复核。

---

## 0. 一页速览

### 0.1 现状判断（5 条）

1. **骨架比想象的好**：`connect/core-contract.mjs` 已经有 InteractionEvent 雏形、`connect/policy.mjs` 已经有 R0–R3 策略引擎且已接入生产、`connect/agent-events.mjs` 已经有统一事件流、`connect/receipts.mjs` 已经有回执模型、`device/` 层的 UI 自动化和防误触已经很扎实。**架构文档要求的东西，大部分"骨架"已经在了，不需要重写。**
2. **真正的问题不是缺功能，是"同一个东西有 4 套"**：任务状态机 5 套、每日预算 4 套、模型调用 11 处、审批词正则 6 处、能力目录 4 套、步骤执行器 4 套、幂等键 7 种格式、能力状态词表 3 套、agent_events 两张同构表分布在两个库。**加新功能每加一次就多一套。**
3. **有一个 P0 级安全缺陷必须先堵**（R-01）：**Brain 代理（`brain/server.mjs`）收不到 QQ 的身份信封**，于是 QQ 的群聊/好友私聊在 Brain 侧被当作"桌面上的爸爸本人"处理——被注入主人长期记忆，并把内容写进主人的私人记忆与日记。QQ 通道自己的 `senderRole` 已在 02:09 的并行改动中修好（见 §0.0），**剩下的这半截才是真正的漏洞**。→ **现状：已堵**（`brain/server.mjs` 接受 `qq`/`call` 信封 + 策略闸门，见 §3 状态总表 R-01）。
4. **治理层是空的**：策略引擎有 6 个动作，但 `external.execute`（真正的执行闸门）**在生产中从未被调用**；审批不校验发送人，任何人打「同意」都能批准外发；调度器给自己批条子。这三条合起来等于外部动作目前无授权边界。→ **现状：已收口**（`connect/core/execute.mjs` 统一闸门 + `approvals` 持久化 + 调度器不再自批，见 R-07/R-08/R-09）。
5. **学习闭环从未跑起来**：`learning_proposals` 只有 1 行（阈值 2 未达），12 个技能全部卡在 `validating`，`memory_facts` / `identity_traits` / `strategy_trials` / `certifications` / `performance_samples` 全是 0 行，"成长中心"目前只有 UI 没有数据通路。→ **现状：数据通路已建、门槛仍等真实数据**（`skill_rollbacks` 真实回滚 / `learning_proposals` 出 `validated` 需真实重复失败触发，见 R-06 与 §5.7 P2 验收门槛）。

### 0.2 本计划要做的三件事

| | 主题 | 一句话 |
|---|---|---|
| **批 0 + P0-A** | **止血与地基** | 堵住 R-01 身份泄漏；把事件、身份、策略、执行闸门、审批留痕五个地基补齐，让后续所有功能都长在同一套契约上。 |
| **P0-B / P0-C** | **收口** | 把"5 套任务状态机 / 4 套预算 / 11 处模型调用"收敛成一套统一运行时；桌面接入成为第二个正式入口。 |
| **P1 / P2** | **成体系** | 记忆七分类与统一检索、评论专用流水线、能力注册表收敛、学习验证闭环、自主目标与跨渠道扩展。 |

### 0.3 明确不做的事（避免范围失控）

- ❌ **不新建 `src/` 目录、不搬迁现有文件**。架构文档 16.2 已明确"不要求一次性搬迁"，本计划遵循：**就地演进 + 新增 `connect/core/` 放统一契约**。
- ❌ **不改 `device/` 层的自动化实现**。它已经足够强，只在需要时补"回执/证据"接口。
- ❌ **不重写 `brain/server.mjs` 的上游代理**。它是 OpenAI 兼容代理，保留；只改它对身份信封的解析与策略调用。
- ❌ **不做多渠道并发**。本期目标是"两个入口跑通同一套契约"，不是"六个入口都跑通"。
- ❌ **不动 `config/persona.md` 的内容风格**，只改它的装载位置（统一到 §4.1 的 `connect/core/` 装配层，见 P0-B-1）。

---

## 1. 实测基线

### 1.1 进程与入口拓扑

| 进程 | 入口 | 端口/协议 | 对外接口 |
|---|---|---|---|
| **Brain**（LLM 代理） | `brain/server.mjs` (230 行) | HTTP 3110 | `POST /v1/chat/completions`、`GET /v1/models`、`GET /health` |
| **Connect**（看板/API） | `connect/server.mjs` (679 行) | HTTP + WS `/device` | `/api/board/*`、`/api/academy/reset`、`POST /working-tasks/:id/plan`、`POST /working-tasks/:id/advance` |
| **QQ 网关** | `connect/qq/gateway.mjs` → `connect/qq/service.mjs:313 handle()` | WS（qqbot-connector） | — |
| **iLink/微信** | `connect/ilink/protocol.mjs:66` → `store.mjs:27 ingestUpdates` → `worker.mjs:42 drain` | HTTP 长轮询 | — |
| **桌宠** | `scripts/run-pet.mjs:73`（拉起 brain）+ `node_modules/dsh-pet` | — | 向 3110 发 OpenAI 格式请求 |
| **Android 伴生端** | `connect/server.mjs:585` WS `/device` | WS（Bearer token + `x-device-id`） | 消息类型 `register/heartbeat/result/event/policy_ack` |
| **语音通话** | `connect/call/service.mjs:42 attach` | WS PCM16 | — |

### 1.2 三个 SQLite 库（只读实测行数）

| 库 | 表数 | 关键行数 | 版本管理 |
|---|---|---|---|
| `runtime/connect/connect.sqlite` | 34 | `agent_events` 166 / `external_tasks` 18 / `working_tasks` 18 / `qq_messages` 93 / `skill_registry` 12 / `skill_runs` 8 / `skill_step_events` 22 / `plan_slots` 9 / `learning_proposals` **1** / `performance_samples` **0** / `strategy_trials` **0** / `skill_proposals` **0** / `skill_rollbacks` **0** / `certifications` **0** | ❌ `user_version=0`，全靠 `CREATE TABLE IF NOT EXISTS` |
| `runtime/dsh-home/dafeiyu-memory.sqlite` | 15 | `daily_memory_events` 181 / `desktop_activity_events` 501 / `memories` **19** / `agent_events` **120** / `memory_facts` **0** / `identity_traits` **0** / `memory_fact_candidates` **0** / `tasks` 3 / `goals` 3 | ✅ `brain/migrations.mjs` MIGRATIONS 13 版 + `migrate(db)` 按 `user_version` 递增 |
| `runtime/douyin/douyin.db` | 8 | `works` 3 / `comments` 8 / `videos` 6 / `hot_comments` 16 / `fans` 8 | ❌ 同上 |

> ⚠ **迁移能力只有 BRAIN 库有。** CONNECT 与 DOUYIN 库没有任何版本管理，新增字段只能靠 `PRAGMA table_info` 探测后 ALTER。这是 P0-A 必修项。

**现状（2026-11-16 19:20 复测，收尾后）**——上表与上条警告都是 02:13 的快照，下面是同一批指标的当前读数：

| 指标 | 02:13 快照 | 19:20 现状 |
|---|---|---|
| `brain/server.mjs` 行数 | 230 | **240** |
| `connect/server.mjs` 行数 | 679 | **721** |
| `connect/qq/service.mjs` | 360 行 `handle` 单体 | **846 行文件**、`handle()` 拆成 ingest/identify/route/plan/executePlan/deliver 六段 |
| CONNECT 表数 | 34 | **39**（含新建 `daily_budget`） |
| CONNECT `user_version` | 0（无版本管理） | **2**（`CONNECT_MIGRATIONS` v1 baseline-columns + v2 agent-events-trace-id 已执行，迁移前自动 `VACUUM INTO` 备份） |
| DOUYIN `user_version` | 0 | **1**（`DOUYIN_MIGRATIONS` v1） |
| `agent_events` 行数 / `trace_id` | 166 / 不是列 | **224 / 是真列 + 索引 `agent_events_trace`** |
| `memories` 行数 | 19 | **22**（memory 库 `user_version=15`） |
| `daily_budget` | 不存在 | 1 行：当日 `model_calls=4`（QQ 3 + life 1 跨库相加）、`autonomous_actions=1`、`voice_requests=0` |
| 用例数 | 190 | **329** |

### 1.3 本计划使用的口径定义

| 术语 | 本文含义 | 依据 |
|---|---|---|
| **能力（Capability）** | 机器人对外能做的一件事（如"发布抖音图文"） | `connect/memory/capabilities.mjs:9` 起的 12 项 |
| **工具（Tool）** | 模型可以在一次回复里调用的原子函数 | `connect/qq/tools.mjs:11` READONLY_TOOLS + `:129` WRITE_TOOLS + `:150` CAPABILITY_TOOLS |
| **动作（Action）** | 执行器层的可执行动作 | `connect/actions.mjs:26` 的 17 项 |
| **技能（Skill）** | 带步骤定义 + 断言 + 学习账本的一等公民流程 | `connect/skills/defs.mjs` 的 12 个 skillId |
| **回执（Receipt）** | 执行结果的证据 | `connect/receipts.mjs:3` `{succeeded,failed,unknown}` |

> **这是当前最令人困惑的地方**：同一条"回复抖音评论"在四个注册表里各有一份，且互不同步（见 §2 差距表第 5 行与 §3 R-10）。P1-B 的核心任务就是把它们合成一个 Manifest。

---

## 2. 与架构设计的差距表

对齐架构文档的**七层架构**（感知接入 → 统一身份与事件 → 认知中枢 → 决策与任务 → 能力与执行 → 记忆与成长 → 治理与运营）。

| 层 | 架构要求 | 当前实测 | 缺口 | 关键证据 |
|---|---|---|---|---|
| **① 感知接入** | 所有渠道经统一事件入口 | `normalizeCoreRequest` + `interactionEvent` 已存在，但**两个调用方都把返回值丢掉了**（契约是装饰性的）；桌面/Android/通话/看板四路完全不接事件 | 无共享接入层，每路自己解析→去重→造 id→调模型→落库→投递 | `connect/core-contract.mjs:4,10`；`connect/qq/brain.mjs:21`、`connect/ilink/brain.mjs:8`（取值后不用） |
| **② 统一身份与事件** | 单一身份、信任边界、trace 可追 | `connect/policy.mjs` 有 R0–R3 六个动作并已接生产；`qq_peers.role` 已在 02:09 的并行改动中加入（`connect/qq/store.mjs:19-31`）；但 **Brain 代理只接受 `ilink` 信封**，QQ 永远传不进去；`trace_id` 只藏在 `agent_events.payload` JSON 里，不是列 | 身份判定仍靠 `label==='爸爸'` 字符串；事件两库分叉、不可跨库关联 | `connect/policy.mjs:1-28`；`connect/qq/store.mjs:19-31`；`connect/qq/service.mjs:324`；`brain/server.mjs:107-130`；`connect/agent-events.mjs:9-28` |
| **③ 认知中枢** | 五种处理模式、统一 Planner | QQ 有 `say+steps` Planner；微信/桌面/通话无 Planner；`brain/cognition/kernel.mjs` 的 DAG 内核**只通过 HTTP `/working-tasks/:id/*` 暴露**，线上 QQ/微信路径一次都没经过它 | **线上有两套并行规划系统**；模型契约 3 套；无统一 IntentResult | `connect/qq/planner.mjs:20-57`；`brain/cognition/kernel.mjs:4-16`；`connect/cognition-bridge.mjs:6,20` |
| **④ 决策与任务** | 统一 AgentTask + TaskStep + DAG | `external_tasks` / `working_tasks` / `brain.tasks` / `runtime/plans/queue.json` / `ilink_messages.status` 五套；状态词表 5 套 | 任何表都**没有 `depends_on` / `parent_task` / `step_deps`** → 无 DAG、无任务级暂停 | `connect/tasks.mjs:5-25`；`connect/working-state.mjs:3-21`；`brain/migrations.mjs:78-97` |
| **⑤ 能力与执行** | 能力 Manifest + 统一执行 + 结果需验证 | 12 能力 + 12 工具 + 17 动作 + 12 技能四套注册表；Manifest 只有 `id/title/one/status/aliases/tags/files/detail` | **Manifest 缺输入/输出/版本/权限/依赖/验证要求**；`capability.code` 让模型在普通对话里读源码（≤120 行） | `connect/memory/capabilities.mjs:9-300`；`connect/actions.mjs:26`；`connect/qq/tools.mjs:150` |
| **⑥ 记忆与成长** | 七类记忆 + 统一检索 + 学习验证 | `memories` 19 行，kind 实际只有 7 个自由字符串；`memory_facts` / `identity_traits` / `strategy_trials` / `certifications` 全 0 行；`learning_proposals` 1 行 | **`memories` 表没有 `privacy_scope` / `channel` 列**，`recall()` 零范围过滤；七分类未落地；**技能账本分裂**（见 R-06） | `brain/memory.mjs:51-89`；`connect/memory-hub.mjs:33`；`connect/skills/ledger.mjs:23-24` vs `scripts/douyin.mjs:90` |
| **⑦ 治理与运营** | 单一策略 + 审批留痕 + 回执三态 + 可观测 | `policy.mjs` 在；审批三通道但**无持久化**；回执只有 2 态；`performance_samples` 0 行 | **`external.execute` 生产中从未调用**；审批不校验作者；调度器自批；看板只看得到 CONNECT 库一半事件 | `connect/policy.mjs:11-28`；`connect/approvals.mjs:53-73`；`connect/scheduler.mjs:87`；`connect/receipts.mjs:3` |

### 2.1 差距收敛现状（2026-11-16 19:20 收尾后）

上表是 02:13 的缺口快照，**不删不改**；下表是同一批缺口的当前状态，逐条给出落地证据。

| 层 | 状态 | 现在的证据 |
|---|---|---|
| ① 感知接入 | **已收口** | `connect/core/route.mjs:82 routePolicy()` 成为统一入口；QQ `handle()` 拆成 ingest→identify→route→plan→executePlan→deliver 六段；`call` 成为一等 ingest 渠道（`connect/core-contract.mjs:20` 白名单 + `CallService.emitEvent` → `agent_events`，见 D15） |
| ② 统一身份与事件 | **已收口** | Brain 现在接受 `ilink`/`qq` 两种信封并校验 `role`（`brain/server.mjs:117`），`qq` 群聊冒充 owner 直接 400；`trace_id` 是真列 + 索引 `agent_events_trace`；事件单一真源 = CONNECT 库（`connect/core/event-store.mjs`，Brain 侧也走它） |
| ③ 认知中枢 | **部分收口** | `routePolicy` + `core/llm.mjs` 统一了 QQ 两条路径；`call`/`ilink`/`douyin` 仍各自直连 fetch（R-13 第 2 行），统一 Planner 未覆盖微信/桌面 |
| ④ 决策与任务 | **已收口** | `connect/core/task.mjs` + `connect/tasks.mjs`（含 `createGoalTask`）统一状态机；`life/tasks.mjs:41 linkGoalTask` 把目标挂到同一张 `working_tasks`，不再各写一套 |
| ⑤ 能力与执行 | **已收口** | `connect/core/capability.mjs` 单一 Manifest（`atomicCapabilityMatrix()` 派生，状态词表对齐 `invalidStatuses`），`capabilities.mjs --check` 无问题；`capability.code` 降级为 owner-only 工具（`connect/qq/tools.mjs:163,176`） |
| ⑥ 记忆与成长 | **数据通路已完成，门槛等真实数据** | `memories` 已有 `scope/channel/peer_id/importance`（memory 库 15 版）；技能账本收敛到 `connect/skills/ledger.mjs`（`scripts/douyin.mjs:36` 也走它）；结构化断言 `connect/skills/assertions.mjs`（堵 R-12）；`skill_rollbacks` 真实回滚与 `learning_proposals` 出 `validated` 仍等真实重复失败触发 |
| ⑦ 治理与运营 | **已收口** | `connect/core/execute.mjs` 是唯一执行出口并调 `evaluatePolicy(event,'external.execute')`；`approvals` 持久化（owner-only 校验 + 一次性 `used_ms`）；`scheduler.mjs` 不再自批（改为 `executeTaskAction` 走同一闸门）；审批词正则收敛到 `connect/approvals.mjs:16` 一处 |

---

## 3. 风险登记册

等级定义：**S1 严重**（安全/数据越界，立即修）· **S2 高**（功能正确性/治理失效，本期修）· **S3 中**（可靠性/一致性，本期或次期修）· **S4 低**（工程质量，可缓）。

**落地状态总表**（2026-11-16 19:20 收尾后；下面每条 R-xx 的正文是 02:13 的原始记录，保留不动）

| 编号 | 等级 | 标题 | 状态 | 落点 |
|---|---|---|---|---|
| R-01 | S1 | 跨范围记忆泄漏 + 身份伪造 | ✅ **已堵** | `brain/server.mjs:117` 接受 `ilink`/`qq` 信封并校验 `role`，QQ 群聊冒充 owner 直接 400；`brain/memory.mjs:91-92` 按 `scope` 过滤 |
| R-02 | S2 | 统一事件流是两张分叉的表 | ✅ **已收口** | `connect/core/event-store.mjs` 为唯一真源（CONNECT 库），Brain 侧也改走它 |
| R-03 | S2 | 审批不校验发送人 | ✅ **已收口** | `connect/approvals.mjs` 持久化 + owner-only + `used_ms` 一次性消费 |
| R-04 | S2 | 调度器自批 | ✅ **已收口** | `connect/scheduler.mjs` 改调 `executeTaskAction`，与人工操作同一闸门 |
| R-05 | S2 | 执行层没有策略闸门 | ✅ **已收口** | `connect/core/execute.mjs` 是唯一执行出口，调 `evaluatePolicy(event,'external.execute')` |
| R-06 | S2 | 技能账本分裂 | ✅ **已收口** | 唯一账本 `connect/skills/ledger.mjs`；`scripts/douyin.mjs:36` 也走它 |
| R-07 | S2 | 长期记忆没有范围维度 | ✅ **已收口** | `memories` 增加 `scope/channel/peer_id/importance`（memory 库 15 版），`recall()` 按范围过滤 |
| R-08 | S3 | `connect/plans.mjs:42` SQL 必抛异常 | ✅ **已修** | 改为参数化 prepared statement |
| R-09 | S3 | lessons 双文件不兼容 | ✅ **已修** | `connect/lessons-store.mjs` 统一读写并兼容 `runtime/douyin/lessons.json` 旧路径 |
| R-10 | S3 | 能力状态三套词表 + 模型可读源码 | ✅ **已收口** | 词表统一 `connect/core/capability.mjs`；`capability.code` 降级为 owner-only 工具（`connect/qq/tools.mjs:163,176`） |
| R-11 | S3 | 声明了但不校验的限流 | ✅ **已修** | `connect/douyin/compliance.mjs:52` 校验 `hourly_cap` |
| R-12 | S4 | 技能断言是自由文本中文 | ✅ **已收口** | `connect/skills/assertions.mjs` 结构化断言（`ui_nodes_min`/`db_row`/`field_length`…） |
| R-13 | S3 | 重复实现清单（10 项） | 🟡 **部分**（3/10） | 已收敛：每日预算 4→1（`core/budget.mjs`）、审批词正则 6→1（`approvals.mjs:16`）、模型调用 QQ 两处→`core/llm.mjs`；仍直连 fetch：`call/brain.mjs:7,32`、`ilink/brain.mjs:21`、`douyin/brain.mjs:13`、`douyin/poster.mjs:18`、`life/manager.mjs:156`、`scripts/*`、`academy/*`。proposeTask 7 处 / 步骤执行器 4 套 / 事实渲染 3 套 / 入站去重 4 套 / 幂等键 7 种 / 任务状态词表未全收敛 |
| R-14 | S3 | 渠道生命周期与提示词装配各自为政 | 🟡 **部分** | 生命周期仍两套（QQ 自建 `QqGateway`、iLink `ilink/gateway.mjs`）；`connect/call/brain.mjs:13,38` 同一提示词模板仍写两遍；看板投递仍硬编码走 QQ |

### R-01 ★ S1 · 跨范围记忆泄漏 + 身份伪造

**事实**（本机逐行核实，快照 2026-11-16 02:13）：

- `connect/qq/planner.mjs:38-45` 与 `connect/qq/brain.mjs:42-49` 调用 Brain 代理时，body 只有 `{model, stream, max_tokens, temperature, response_format, messages}` —— **不带 `metadata.connect`**。
- `brain/server.mjs:107` `const connectScope = body.metadata?.connect;` → `undefined`。
- `brain/server.mjs:108` 进一步硬性限制：`connectScope.channel !== 'ilink'` 即 400 `'Invalid communication scope'`，`role` 只允许 `owner|friend` —— **QQ 即使想传信封也传不进去**。
- `brain/server.mjs:120-124` 于是构造 `channel:'desktop', conversationId:'desktop', senderRole:'owner'`。
- `brain/server.mjs:129-130` `evaluatePolicy(interaction,'memory.read.owner'/'memory.write.owner')` **双双返回 allowed=true**（`connect/policy.mjs:19-21` 的 ownerPrivate 判定需要 `sender.role==='owner' && conversation.type==='direct' && instruction_trust==='verified_user_input'`，此时三者全部满足）。
- `brain/server.mjs:154` 把 `memorySection(db,userText)` + `lifeSection(db)` + `identityState`/`traits` 注入系统提示；`brain/server.mjs:187-189` / `212-214` `capture(db,userText,answer,provenance)` 写入主人的 `memories`，并 `recordDailyExchange({channel:'desktop', privacyScope:'private'})`。
- `brain/server.mjs:155,191,216` 事件写 `channel='desktop'`、`conversationId='desktop'`、`actor='owner'`。
- `connect/qq/brain.mjs:21` 仍有硬编码 `peerRole: kind==='group'?'member':'owner'`（该字段实际被丢弃，但它反映的思维模式还在）。
- `connect/qq/service.mjs:527-530` 的 `ownerPrivate` 门（仅爸爸 c2c 才注入 today/memories/lessons）**因此被完全绕过**——它管的是 QQ 侧拼装给 QQ 模型的那部分，但真正读主人记忆的是 Brain 代理。

> **已吸收的部分（02:09 并行改动）**：`connect/qq/service.mjs:324` 已改为 `senderRole: kind === 'group' ? 'member' : peer(this.db,kind,id)?.role === 'owner' ? 'owner' : 'friend'`，`connect/qq/store.mjs:19-21` 已给 `qq_peers` 加 `role` 列，`:23-31` 新增 `syncQqOwner(db, ownerId)`（先把 owner 全部降为 friend，再按 owner id 置一个）。**QQ 自己的事件层身份已正确。** 剩余缺口见下。

**影响**：
1. QQ **群聊**里的任何一句话 → 被注入爸爸的长期记忆、日常动态、人格状态；
2. QQ **好友私聊**的任何内容 → 被写进爸爸的 `memories` 表，并标为 `privacyScope='private'` 的私人日记；
3. 统一事件流里 QQ 流量被记成 `channel='desktop'`，与 QQ 侧 `interaction.trace_id` 无关联 → 事后无法归因。

**对照**：微信是唯一做对的通道——`connect/ilink/brain.mjs:21-22` 传了 `metadata.connect={channel:'ilink',role,account_id,peer_id,label,input_kind}`，而 `brain/server.mjs:108` 强制要求 `connectScope.channel === 'ilink'` 且 `role ∈ {owner,friend}`，否则 400。

**处置**：**P0-A-1 + P0-A-2**（见 §5.1）。核心是引入**身份信封 ScopeEnvelope**，让 Brain 代理按真实渠道/真实角色决策：放宽 `brain/server.mjs:108` 的通道枚举（`ilink|qq|desktop|android|call`）、放宽角色枚举（`owner|friend|member|self`）、**无信封时按 `self` 处理而不是 owner 私聊**，并让 QQ/桌面/通话都带上信封。

> 附带收益：修好之后，`brain/server.mjs` 的 `scopeNote`、`memorySection`、`lifeSection`、`identityState`、`capture` 五处分支自然收敛，不再需要"有没有 connectScope"这种隐式判据。

### R-02 ★ S2 · 统一事件流是两张分叉的表

- `connect/agent-events.mjs:9-28` 的 `agent_events` DDL 在 **两个库里各存在一份同构表**：CONNECT 库（`connect/server.mjs:127`）166 行，BRAIN 库（`brain/migrations.mjs:218` v11 迁移）120 行。
- **没有 `trace_id` 列**。trace_id 只写在 `payload` JSON 里（`connect/qq/service.mjs:326,651,657,666,671`、`connect/ilink/worker.mjs:56`），不可索引、不可 JOIN。
- **channel 取值漂移**：QQ 侧写 `'qq'`，iLink 侧写 `'wechat'`，Brain 侧写 `'ilink'`/`'desktop'`。**同一条 iLink 消息在两个库里分别记为 `wechat` 和 `ilink`。**
- 看板只读 CONNECT 库 → **桌面那一半事件在看板上完全不可见**。

**处置**：P0-A-4。选定单一事件源库 + `trace_id` 提升为列 + channel 词表收敛为一份。

### R-03 ★ S2 · 审批不校验发送人

`connect/approvals.mjs:53-73` `waitApproval` 直接扫 `qq_messages` 表，用正则 `/(同意|可以发|可以|发吧|批准|没问题|ok|OK)/u` 匹配，**不校验 `author`**。该表的 `author` 列是存在的（`connect/qq/store.mjs:17`）。`approvalDir`（`connect/approvals.mjs:16-18`）从未被写入，**审批没有持久化记录**。

**影响**：群里任何一个人打「同意」即可批准外发一条抖音作品。

**处置**：P0-A-5（审批落库 + 作者校验 + 角色校验）。

### R-04 ★ S2 · 调度器自批

`connect/scheduler.mjs:87` `approvePendingTask(db, task.id, 'scheduler', now)` —— 调度器给待确认任务自己盖章。外发动作（`connect/douyin/dayplan.mjs:17` 的 `AUTO_ACTIONS` / `CONFIRM_ACTIONS`）本应需要主人在私聊确认。

**处置**：P0-A-7（按风险等级分层，见 §9 决策 D5/D6）。

### R-05 ★ S2 · 执行层没有策略闸门

`connect/policy.mjs` 定义了 `external.execute`（R3，要求 owner + approved），但**生产代码从未调用它**——它只出现在 `tests/policy.test.mjs` 里。实际生产调用：`connect/qq/service.mjs` 10 处、`connect/ilink/worker.mjs` 3 处、`brain/server.mjs:129-130` 两处，**没有一处是 `external.execute`**。

**处置**：P0-A-6（把执行入口统一收口到一个 `execute()`，唯一出口做策略判定）。

### R-06 ★ S2 · 技能账本分裂（看板看不到真实运行）

- `connect/skills/ledger.mjs:23-24` `skillDbPath(root)` → `runtime/connect/connect.sqlite`（看板和 ledger 读这里）。
- 但 `scripts/douyin.mjs:90` `beginSkill()` 用 `openMemory(join(root,'runtime','dsh-home','dafeiyu-memory.sqlite'))` + `initSkills(db)` —— **往 BRAIN 库写**；`scripts/douyin.mjs:97-102` `beginStrategy()` 还往 BRAIN 库写 `strategy_trials`。
- 后果：CONNECT 库 `strategy_trials` 恒为 0；看板读不到抖音脚本产生的 `skill_runs`；BRAIN 库 `.tables` 里当前没有 `skill_*` 表（要脚本跑过才有）。

**处置**：P1-C-1（技能账本归一到 CONNECT 库，BRAIN 侧改为经 API 读）。

### R-07 ★ S2 · 长期记忆没有范围维度

- `memories` 表 19 行，**没有 `privacy_scope` / `channel` / `peer_id` / `importance` 列**。
- `brain/memory.mjs:51-89` `recall()` 打分 = `exactPhrase*4 + overlap*1.5 + coverage*2 + confidence*1.5 + freshness*0.35`，**零范围过滤参数**。
- `connect/memory-hub.mjs:33` `todayDigest` 返回当天所有 `kind='activity'` 行，无渠道过滤。
- 唯一有隐私维度的读路径 `connect/daily-memory.mjs:30` `ownerDigestEvents`（`privacy_scope='private' AND conversation_kind='direct' AND (channel!=='wechat' OR speaker='owner')`），但**只被 `scripts/memory-digest.mjs:24` 一个脚本使用**。
- `brain/memory.mjs:90` `capture()` 写全局 `memories`，渠道只编码在自由文本 `source` 字符串里（`'qq'`/`'qq_chat'`/`'wechat'`/`'self:douyin'`/`'user_explicit'`）。
- 记忆 kind 实际取值：`user_fact` / `pet_preference` / `shared_episode` / `activity` / `reflection` / `daily_digest`（+ legacy `fact`）——**架构要求的 working/episodic/semantic/procedural/social/self/experience 七类基本不存在**。

**处置**：P1-A（记忆迁移 + 七分类 + 统一检索入口）。**R-01 修完前，这个风险被放大，所以 R-01 优先。**

### R-08 ★ S3 · `connect/plans.mjs:42` SQL 必抛异常（本机已核实）

```sql
SELECT COUNT(*) AS n FROM qq_messages WHERE conv_id = ? AND created_ms >= ? AND direction = ?
```
`qq_messages` 实际列：`id conv_kind conv_id msg_id input_kind text reply status error delivery_kind audio_duration_ms created_ms author` —— **没有 `direction` 列**。查询必抛 → 被 `catch { return false; }` 吞掉 → `anyReplySince` **恒返回 false** → 私聊执行失败后"5 分钟没回复再群里说"的升级机制**永远触发**。

**处置**：批 0（改成 `direction='in'` → 实际应按 `author`/入站口径判断，或直接删掉 `direction` 条件）。

### R-09 ★ S3 · lessons 双文件不兼容（本机已核实）

- `runtime/douyin/lessons.json` 存在（2653B，形状 `{lessons:[{at,kind,text,tags}]}`）。
- `runtime/dsh-home/lessons.json` **不存在**。
- `connect/qq/lessons.mjs:73` `loadDynamicLessons` 期望**顶层数组** → 永远返回空 → QQ 只能用 `connect/qq/lessons.mjs:5-58` 的 11 条静态 LESSONS。
- `connect/skills/learning.mjs:116-117` 把同一条 lesson 写两个文件 → 一旦修好格式，**抖音域的教训会进 QQ 提示词**。

**处置**：批 0（统一为一个文件 + 一个 schema + 按渠道过滤）。

### R-10 ★ S3 · 能力状态三套词表 + 模型可读源码

- `connect/core-contract.mjs:3` `CAPABILITY_MATRIX`：stable / real_verified / prototype / not_implemented / disabled。
- `connect/memory/capabilities.mjs` `status`：stable(9) / beta(3)（`scripts/capabilities.mjs` 允许 stable/beta/planned/disabled）。
- `connect/qq/tools.mjs:228` `runTool` 返回的 `status` 又是另一套。
- 叠加第四套描述：`connect/qq/brain.mjs:6-17` 硬编码 `CAPABILITIES` 数组 + `connect/qq/service.mjs:524` 的 `capabilityBlock`（**不按 ownerPrivate 门控 → 群聊也拿到完整能力索引**）。
- `connect/qq/tools.mjs:150` `capability.code` 允许模型读登记源文件（≤120 行）——**普通对话里的源码暴露面**。

**处置**：P1-B-2（单一 Manifest + 单一状态词表 + `capability.code` 收进 owner-only 工具）。

### R-11 ★ S3 · 声明了但不校验的限流

`connect/douyin/compliance.mjs:9` 声明 `hourlyComments: 5`，但 `checkComment` (L35-56) 的判定只有 `too_long` / `duplicate` / `daily_cap` / `too_fast` 四种 id，**从不校验小时级上限**。

**处置**：批 0（补 hourCount 校验）。

### R-12 ★ S4 · 技能断言是自由文本中文，机器判不了

`connect/skills/defs.mjs` 44 条步骤 `assert` 全是中文散文，例如：
- `'activity=socialnotice.view.activity.IntegratedInteractionActivity'` (L63)
- `'rows>0 或出现「暂时没有更多了」这类空态证明'` (L65)
- `'输入框文本包含回复前 6 个字'` (L77)
- `'AI 生成=开、允许下载=关、保存相册=关（像素判色）'` (L118)
- `'出现「发布成功」或作品页能看到正文'` (L119)
- `'works 行存在且 status=draft'` (L105)
- `'gate 返回 ok'` (L131)

`connect/skills/ledger.mjs:107-113` `verifiedFromData` 只能靠 `blockers` 非空 / `data.verified===true` / `status ∈ {ok,draft,ready,published,empty}` 推断 —— **不是真的验证了断言**。

**处置**：P1-C-2（断言结构化：`{kind:'ui_text'|'db_row'|'field_equals', ...}`）。

### R-13 ★ S3 · 重复实现清单（统一运行时应收敛）

| # | 重复项 | 位置 |
|---|---|---|
| 1 | 每日预算 4 套 | `connect/qq/store.mjs:88-92` / `connect/ilink/worker.mjs:65,81` / `life/tasks.mjs:13-35` / `connect/qq/service.mjs:29-30` |
| 2 | 模型 fetch 11 处 | `connect/qq/planner.mjs:35`、`connect/qq/brain.mjs:39`、`connect/ilink/brain.mjs:21`、`connect/call/brain.mjs:7,32`、`connect/douyin/brain.mjs:13`、`scripts/douyin-post.mjs:22`、`scripts/day-plan.mjs:32`、`scripts/memory-digest.mjs:32`、`connect/academy/study.mjs:114`、`connect/academy/weekly.mjs:101` |
| 3 | 审批词正则 6 处 | `connect/qq/service.mjs:336-337`、`connect/approvals.mjs:14,66`、`connect/memory/capabilities.mjs:105`、`connect/qq/lessons.mjs:31,36`、`connect/douyin/review.mjs:33`、`connect/board/ui.mjs:65-66,80` |
| 4 | proposeTask 7 处 | `connect/qq/service.mjs:410,571,623`、`connect/ilink/worker.mjs:105`、`connect/scheduler.mjs:80`、`connect/douyin/daily.mjs:155`、`connect/server.mjs:296-307` |
| 5 | 步骤执行器 4 套 | `connect/qq/service.mjs:554`、`connect/plans.mjs:51-70`、`connect/scheduler.mjs:87-104`、`connect/server.mjs:479-481` |
| 6 | 能力目录 4 套 | `connect/memory/capabilities.mjs`、`connect/core-contract.mjs:3,57`、`connect/qq/brain.mjs:6-17`、`connect/qq/tools.mjs:150-171` |
| 7 | 事实渲染 3 套 | `factsText` / `factsDigest` / brain facts 块 |
| 8 | 入站去重 4 套 | QQ / iLink / Android / Brain |
| 9 | 幂等键 7 种格式 | `connect/tasks.mjs:40` 等 |
| 10 | 任务状态词表 5 套 | 见 §2 差距表第 4 行 |

### R-14 ★ S3 · 渠道生命周期与提示词装配各自为政

- 渠道生命周期两套约定：QQ 在 service 构造函数里自建 `QqGateway`（`connect/qq/service.mjs:116`）；iLink 在 `connect/ilink/gateway.mjs:10-18`。
- 提示词装配 5 套：`config/persona.md` 只在 `brain/server.mjs:134` 装载一处，但 QQ / iLink / Call 各自又内联了一套人格与能力声明；`connect/call/brain.mjs:13` 与 `:38` **同一个提示词模板写了两遍**（流式/非流式）。
- `[DO:…]` 标记协议实现两遍（`connect/qq/service.mjs:609-627`、`connect/ilink/worker.mjs:102-112`），桌面端直接丢弃，`connect/call/service.mjs:118,127` 是第三种标记（`[HANGUP]`）。
- 看板投递硬编码走 QQ：`connect/server.mjs:287-331` `/api/board/write` → `qq.sendTextSafe('c2c',…)` + `qq.api.sendImage(runtime/douyin/preview.jpg)`，`convId: targets?.qq?.dad ?? 'owner'`。

---

## 4. 目标形态

### 4.1 分层落位（**就地演进，不搬迁**）

```
现有目录（保留）                     新增/改造（统一契约集中在 connect/core/）
────────────────────────────────      ────────────────────────────────────────
brain/server.mjs  LLM 代理            connect/core/scope.mjs        ★身份信封 ScopeEnvelope
brain/cognition/kernel.mjs            connect/core/event.mjs        ★InteractionEvent v1 + trace_id
connect/qq/*      QQ 通道             connect/core/task.mjs         ★统一 AgentTask + TaskStep + 状态机
connect/ilink/*   微信通道            connect/core/capability.mjs   ★单一 Capability Manifest
connect/actions.mjs 动作表            connect/core/execute.mjs      ★唯一执行出口（含策略闸门）
connect/policy.mjs 策略（已存在）      connect/core/receipt.mjs      ★回执三态
connect/agent-events.mjs 事件（已存在）  connect/core/approval.mjs     ★审批留痕
connect/receipts.mjs 回执（已存在）     connect/core/budget.mjs       ★统一配额
connect/tasks.mjs / working-state.mjs  connect/core/llm.mjs          ★统一模型调用
device/*          设备层（不动）
```

### 4.2 关键接口（七份契约，详见 §6）

`ScopeEnvelope` → `InteractionEvent` → `IntentResult` → `AgentTask`+`TaskStep` → `ExecutionReceipt` → `CapabilityManifest` → `MemoryRecord`

架构文档 14.x 的接口定义方向正确，本计划**只做一件事**：把它们从"文档里的形状"变成"代码里唯一被调用的形状"。

### 4.3 不动的东西（回归保护）

`device/uia.mjs`、`device/douyin.mjs`（BLOCKER_RULES / HEAL_POLICY / NEVER_CLICK / EMPTY_PROOFS 已经很完整）、`connect/skills/defs.mjs` 的技能步骤定义、`connect/academy/*`、`config/persona.md` 的文案。

---

## 5. 里程碑与批次

> 每批次独立可发布、可回退。标注「★」的是本批次必须先做的。
> 步骤编号全局唯一，引用时必须带阶段前缀（`P0-A-1`、`P1-A-2`…）；表格内的短编号只在本节内有效。

### 5.0 批 0 · 一次性小修（半天，零架构改动）

| # | 修什么 | 文件 | 验收 |
|---|---|---|---|
| 0-1 | `anyReplySince` SQL 去掉不存在的 `direction` 列 | `connect/plans.mjs:42` | 新增测试：写入一条私聊消息后 `anyReplySince` 返回 true |
| 0-2 | `checkComment` 补小时级上限校验 | `connect/douyin/compliance.mjs:35-56` | 新增测试：1 小时内第 6 条评论返回 `too_fast`/新 id |
| 0-3 | lessons 统一到 `runtime/dsh-home/lessons.json` 单文件 + 顶层数组 schema + 渠道过滤 | `connect/qq/lessons.mjs:69-83`、`connect/skills/learning.mjs:116-117` | 新增测试：抖音域教训不进 QQ 提示词 |
| 0-4 | `capabilityBlock` 加 ownerPrivate 门控 | `connect/qq/service.mjs:524` | 新增测试：群聊拿不到完整能力索引 |

**批 0 验收**：`node --test tests/*.test.mjs` 全绿 + 新增 4 条回归用例 + `node scripts/capabilities.mjs --check` 无 problems。

---

### 5.1 P0-A · 地基：身份信封 + 事件单源 + 策略闸门 + 审批留痕

**目标**：堵 R-01 R-02 R-03 R-04 R-05，让后面所有功能都长在同一套契约上。

| 步骤 | 做什么 | 关键文件 | 完成判据 |
|---|---|---|---|
| **A-1 ★** | 引入 **ScopeEnvelope**（身份信封）。`connect/core/scope.mjs` 导出 `buildScope({channel, accountId, peerId, peerRole, conversationKind, inputKind, messageId, label})` → 冻结对象。**QQ / iLink / 桌面 / Android / 通话全部改为经它构造** | 新增 `connect/core/scope.mjs`；改 `connect/qq/planner.mjs:38-45`、`connect/qq/brain.mjs:42-49`、`connect/ilink/brain.mjs:21-22` | QQ 群聊/好友私聊**不再**收到主人长期记忆；`connect/brain` 侧 `capture` 不再把群聊写进主人 `memories` |
| **A-2 ★** | `brain/server.mjs:107-130` 支持多渠道信封：`connectScope.channel` 允许 `ilink|qq|desktop|android|call`；`role` 允许 `owner|friend|member|self`；**没有信封时按 `self`（桌面本人）处理，而不是 owner 私聊**。同时 `scopeNote` / `memorySection` / `lifeSection` / `identityState` / `capture` 五处分支改为由策略结果驱动 | `brain/server.mjs:107-130,148-154,187-189,212-214` | 新增测试：QQ 群聊请求 → 提示词不含主人记忆；QQ 好友私聊 → `capture` 不写 `memories` |
| **A-3** | **`qq_peers.role` 的剩余工作**（列与 `syncQqOwner` 已由 02:09 并行改动加入 `connect/qq/store.mjs:19-31`）：补 **role 的写入路径**（配置/命令/首次绑定时确定 owner）、把 ALTER 探测式迁移收进版本化迁移（A-8）、并把 `label` 降级为纯展示名 | `connect/qq/store.mjs:19-31`、`connect/qq/service.mjs:324,338,377,519,503` | 新增测试：非 owner 的 QQ c2c peer → `privacy_scope != 'private'`、`instruction_trust='untrusted_user_input'`（**这条测试当前代码应当会挂**） |
| **A-4 ★** | **事件单源**：选定 CONNECT 库为 `agent_events` 唯一真源；BRAIN 库的那张表降级为只读镜像或直接废弃（BRAIN 侧改走一个 `recordEvent` HTTP/进程内通道）。`trace_id` **提升为独立列**并建索引；channel 词表收敛为一份（`desktop/qq/wechat/android/douyin/system`） | `connect/agent-events.mjs:9-28`（加列+索引）、`brain/migrations.mjs:218`（废弃）、`brain/server.mjs:155,191,216`、`connect/qq/service.mjs:326,651,657,666,671`、`connect/ilink/worker.mjs:56,119` | 看板能查到桌面事件；一次 QQ 往返在事件流里只有一条记录且带 `trace_id` 列 |
| **A-5 ★** | **审批留痕**：新建 `approvals` 表（`id, task_id, approver_peer_id, approver_role, decision, channel, message_id, created_at`）；`connect/approvals.mjs:53-73` 的匹配必须校验 `author` + 角色 + 会话类型；`sendApprovalRequest` 落库 | 新增 `connect/core/approval.mjs` + `connect/approvals.mjs` | 新增测试：群成员发「同意」**不能**批准；owner 私聊发「同意」能批准且 `approvals` 表有记录 |
| **A-6** | **执行闸门**：`external.execute` 接入生产。所有真正对外产生副作用的调用（发消息、发作品、点赞、拨号）必须过 `evaluatePolicy(event,'external.execute',{approved})`；未授权即拒绝并记 `action_failed` | `connect/policy.mjs`（复用）、新增 `connect/core/execute.mjs` | 新增测试：未经 owner 批准的外部动作被拒并有审计事件 |
| **A-7** | **调度器不自批**：`connect/scheduler.mjs:87` 改为只自动批准 R0–R2 的白名单动作；R3 动作必须等主人在私聊确认 | `connect/scheduler.mjs:87`、`connect/douyin/dayplan.mjs:17` | 新增测试：调度器不能自动批准 R3 动作 |
| **A-8** | **迁移能力下沉**：给 CONNECT / DOUYIN 库补一个与 `brain/migrations.mjs` 同形的 `migrations` 机制（`user_version` + 迁移数组） | 新增 `connect/core/migrations.mjs`，改 `connect/server.mjs:121-127` | 新增测试：从旧库升级后列齐全 |
| **A-9** | 补 `interactionEvent` 四个抛错的测试（`invalid_interaction_channel/conversation/content/identity` 当前**零覆盖**） | `tests/interaction-event.test.mjs` | 4 条新用例 |

**P0-A 验收门槛**
1. `node --test tests/*.test.mjs` 全绿，**用例数 ≥ 当时基线 + 15**（本稿基线 190 → 205）。
2. **安全验收（人工确认）**：用一个非 owner 的 QQ 账号发「我明天要去海边」，抓 Brain 上游请求体 → **不含**主人 memories / life_events / identity_state。
3. 事件流验收：桌面 + QQ 各一次往返，在单一事件源里能按 `trace_id` 串起来。
4. `node scripts/capabilities.mjs --check` 无 problems。

---

### 5.2 P0-B · QQ 私聊主链路收口

**目标**：把 QQ 那条 360 行的 `handle()`（`connect/qq/service.mjs:313-675`）拆成可测的分段，并把规则/模型分流收敛到一处。

| 步骤 | 做什么 | 关键文件 |
|---|---|---|
| B-1 | 把 `handle()` 拆成 `ingest → identify → route → plan → execute → deliver` 六段，纯函数段可单测 | `connect/qq/service.mjs` |
| B-2 | 「规则 vs 模型」的三处开关（`:408`、`:529`、`:609`）收敛为一个 `routePolicy(text, context)` 决策 | `connect/qq/service.mjs` |
| B-3 | 统一 **IntentResult**：`{intent, operations[], requires_confirmation, confidence, rationale}`，替换 `parseExternalIntent` + `[DO:…]` 标记 + planner steps 三套 | `connect/core/task.mjs`、`connect/qq/tools.mjs:203-225` |
| B-4 | `connect/qq/planner.mjs` 与 `connect/qq/brain.mjs` 的请求体统一走 `connect/core/llm.mjs`（顺带收掉模型 fetch 11 处 → 1 处） | 新增 `connect/core/llm.mjs` |
| B-5 | 只读步执行结果回灌统一用 `factsText`（现在是 3 套） | `connect/qq/tools.mjs:78` |
| B-6 | `connect/qq/service.mjs:255-283` / `connect/server.mjs:296-320` / `connect/scheduler.mjs:87-104` / `connect/douyin/daily.mjs:155` 四份「两段式发布握手」收敛为一份 | 新增 `connect/core/publish.mjs` |

**P0-B 验收门槛**：QQ 私聊的既有 20 条 `tests/planner.test.mjs` 全部保持通过；`tests/qq.test.mjs` 19 条全绿；新增「六段路由决策表」用例 ≥ 8 条。

---

### 5.3 P0-C · 任务与执行收口 + 桌面接入

**目标**：五套任务状态机合一，形成唯一任务主线；桌面成为第二个正式入口。

| 步骤 | 做什么 | 关键文件 |
|---|---|---|
| C-1 | **统一 AgentTask**：以 `external_tasks` 为基线扩字段（`depends_on` / `parent_task` / `step_deps` / `risk` / `approval_state` / `scope`），`working_tasks` 与 `brain.tasks` 改为**视图或镜像**，不再独立持有状态 | `connect/tasks.mjs:5-25`、`connect/working-state.mjs:3-21`、`brain/migrations.mjs:78-97` |
| C-2 | 状态机收敛为 9 态：`proposed → awaiting_approval → approved → running → verifying → succeeded/failed/unknown → cancelled`，**统一 `external.execute` 的三态语义**（已调用 / 平台已接受 / 业务已验证） | 新增 `connect/core/task.mjs` |
| C-3 | **回执五态**：`connect/receipts.mjs:3` 的 `{succeeded,failed,unknown}` 扩为 `{invoked, accepted, verified, failed, unknown}`，与架构文档 8.4 的 `ToolContext`/`ToolResult` 对齐 | `connect/receipts.mjs`、`connect/qq/tools.mjs:228`（现成的 `verified` 字段终于能用上） |
| C-4 | 步骤幂等：每个 TaskStep 带 `step_key`，重放不重复执行；对外副作用步骤强制带 `idempotency_key` | `connect/core/task.mjs` |
| C-5 | **桌面接入**：桌宠走同一套 `ScopeEnvelope`（`role='self'`）+ `AgentTask`；桌面不发起的动作也走执行闸门 | `brain/server.mjs`、`scripts/run-pet.mjs:73` |
| C-6 | Android / 通话两条旁路至少接上事件流与 `interactionEvent`（`connect/server.mjs:605`、`connect/call/service.mjs:42`） | `connect/inbox.mjs:38`、`connect/call/*` |

**P0-C 验收门槛**：任务状态在**四个存储**里只有一处是真值（用一条测试断言"改一处四库同步"）；回执三态有独立测试；桌面试图发起一次外部动作会被正确记录或拒绝。

---

### 5.4 P1-A · 记忆分类与统一检索

**目标**：架构文档要求的七类记忆落地，`recall()` 有范围过滤。

| 步骤 | 做什么 | 关键文件 |
|---|---|---|
| A-1 | `memories` 表新增：`type`（七类枚举）、`scope`（private/friend/group/public）、`channel`、`peer_id`、`importance`、`expires_at`；写迁移，把现有 19 行按 kind 映射到七类（`user_fact`→semantic、`shared_episode`→episodic、`activity`→working、`reflection`→experience、`daily_digest`→episodic…） | `brain/migrations.mjs`（加 v14）、`brain/memory.mjs` |
| A-2 | `recall()` 增加 `scope` 过滤（默认 `private`），`todayDigest` 加渠道过滤 | `brain/memory.mjs:51-89`、`connect/memory-hub.mjs:33` |
| A-3 | **统一检索入口** `connect/core/memory.mjs`：`search(query, {scope, types, limit})`，内部决定走 `memories` 还是 `memory_facts`；`ownerDigestEvents` 并入 | 新增 `connect/core/memory.mjs` |
| A-4 | 统一 `kind` 词表：`user_fact`/`pet_preference`/`shared_episode`/`activity`/`reflection`/`daily_digest` → 七类枚举，老 kind 保留为兼容别名 | `brain/memory.mjs`、全部写入点 |
| A-5 | 留存策略：`purgeDailyMemory` 之外，为 `memories` / `agent_events` / `skill_runs` 定义留存期 | `connect/daily-memory.mjs` |

**P1-A 验收门槛**：新增测试——"群聊产生的记忆不会出现在主人私聊的召回里"；"七类枚举每类都有至少一条可写入可召回的用例"。

---

### 5.5 P1-B · 评论专用流水线 + 能力注册表收敛

| 步骤 | 做什么 | 关键文件 |
|---|---|---|
| B-1 | **评论专用流水线**（架构 ADR-004）：评论理解 → 意图判定 → 拟稿 → 合规检查 → 人工/自动决策 → 发布 → 回执验证，与通用聊天链路解耦 | 新增 `connect/core/comment-pipeline.mjs` |
| B-2 | **单一 Capability Manifest**：12 项能力补齐 `id/title/one/status/aliases/tags/files/detail` + **输入/输出/版本/权限/依赖/验证要求**；删掉 `connect/qq/brain.mjs:6-17` 的硬编码副本与 `connect/core-contract.mjs:3` 的第二份矩阵 | `connect/memory/capabilities.mjs`、`connect/core-contract.mjs`、`connect/qq/brain.mjs` |
| B-3 | 状态词表收敛为一份（`stable/beta/prototype/planned/disabled/not_implemented`），`CAPABILITY_MATRIX`、`capabilities.mjs`、`runTool` 三处统一 | `scripts/capabilities.mjs`（保持 `--check` 行为不变） |
| B-4 | `capability.code`（读源码）收进 owner-only 工具，从普通对话工具目录移除 | `connect/qq/tools.mjs:150` |
| B-5 | 动作表 `connect/actions.mjs:26` 的 17 项与工具表 12 项、技能表 12 项做一次**显式映射表**，标出未实现的（如 `douyin.like_comments` 在 ACTIONS 里有、矩阵标 `not_implemented`） | 新增 `connect/core/capability-map.mjs` |

**P1-B 验收门槛**：`node scripts/capabilities.mjs --check` 仍返回 `{"count":12,...,"problems":[]}`（不因重构而退化）；新增测试断言"三处状态词表一致"。

---

### 5.6 P1-C · 学习验证闭环

| 步骤 | 做什么 | 关键文件 |
|---|---|---|
| C-1 | **技能账本归一**（R-06）：`scripts/douyin.mjs:90,97` 改用 `connect/skills/ledger.mjs` 的 CONNECT 库；BRAIN 库不再持有 `skill_*`/`strategy_trials` | `scripts/douyin.mjs`、`connect/skills/ledger.mjs:23-24` |
| C-2 | **断言结构化**（R-12）：44 条中文散文 assert 改成 `{kind:'ui_text'|'db_row'|'field_equals'|'pixel', ...}`，配一个执行器 | `connect/skills/defs.mjs`、新增 `connect/skills/assertions.mjs` |
| C-3 | **学习闭环真正跑起来**：`learning_proposals` 的 occurrences 阈值策略从固定 2 改为按风险等级（R2 自动、R3 需审核）；提案 → 审核 → 版本升级 → 回滚（`skill_rollbacks` 表已存在但 0 行） | `connect/skills/learning.mjs:121-136`、`connect/academy/levels.mjs:109` |
| C-4 | 12 个技能从 `validating` 逐个晋升（每晋升一个要有真实 run 记录 + 结构化断言通过） | `connect/skills/defs.mjs` |
| C-5 | `performance_samples` 接主链路：每次执行写一条，支撑看板的 p50/p95/p99 | `connect/performance.mjs` |

**P1-C 验收门槛**：`learning_proposals` 出现 ≥ 1 条 `validated` 记录（R0/R2 技能由 `sweepLearning` 自动升版写入、R3 由主人 `approveLearning` 点头写入）；至少 1 个技能 `status` 从 `validating` 变为 `enabled`（经 `connect/skills/promotion.mjs` 闸门：真实 run + 结构化断言全过）；`skill_rollbacks` 有 1 条真实回滚记录（`maybeRollback` 连续失败触发）。

> **D11（词表对齐）**：本计划早期草稿把验收词表写成 `learning_proposals` 出 `approved`、技能 `validating→valid`，但代码实际用的是 `connect/skills.mjs:4` `candidate/validating/enabled/deprecated` 与 learning.mjs 的 `validated`/`enabled`。按「状态词表收敛是本计划核心主张、不再造别名」的原则，**统一以代码词表为准**：学习提案经验证后置 `validated`，技能晋升后置 `enabled`。计划文档不再出现 `approved`/`valid` 这两个技能/学习状态（`approved` 仅保留在 `approvals` 表的审批决策里，语义不同）。

---

### 5.7 P2 · 自主目标与跨渠道扩展

| 步骤 | 做什么 |
|---|---|
| D-1 | 自主目标：`goals` / `goal_progress`（当前 3 行 / 1 行）与统一 `AgentTask` 打通；`life/tasks.mjs:3` `DAILY_BUDGET={modelCalls:4, autonomousActions:2}` 并入统一预算 |
| D-2 | 统一预算：`qq_usage` / `ilink_usage` / `life` 三套配额合并为一个跨渠道日配额，并支持「模型调用」与「自主动作」两个独立维度 |
| D-3 | 跨渠道扩展：新增渠道只需实现一个 `ingest` 适配器；Android / 通话接入完整事件流 |
| D-4 | 目标目录 `src/{gateway,identity,brain,...}` —— **仅在本计划全部完成后，按需渐进搬迁，不做一次性搬家** |

**P2 验收门槛**：
1. **D-1 目标 ↔ 统一任务是一条链**：`goals` → `goal_progress.task_id` → `external_tasks.id` 可走通（`goal_progress.task_id` 指向的就是那张统一 AgentTask 的 id），且同一天同一目标重复推进是**更新**不是多出一行（`UNIQUE(goal_id, day)` + `ON CONFLICT DO UPDATE`）。
2. **D-2 只有一份跨渠道日配额**：QQ / iLink / life 三处 reserve 落到**同一张** `daily_budget` 表的同一格；两个独立维度（`model_calls` 与 `autonomous_actions`）互不干扰；迁移当天旧三套配额已用的量被棘轮进统一账（不白送额度、也不重复累加）。
3. **D-3 新增渠道只需一个 ingest 适配器**：通话（`call`）成为一等 ingest 渠道（`core-contract.mjs` 白名单 + `CallService.emitEvent` → `connect/server.mjs` 落 `agent_events`），Android 侧已有事件流接入。

> **D12（统一预算落哪）**：统一预算表 `daily_budget` 落在 **CONNECT 库**（`runtime/connect/connect.sqlite`）——按 D3「CONNECT 库是单一真源」的结论，预算也算 CONNECT 库的事。life 侧通过 `life/manager.mjs` 的 `openConnectBudget(home)` 打开同一个文件；拿不到就退回 BRAIN 库（仍共用同一套 `budget.mjs` 逻辑与上限，只是不与另两个渠道同格）。
>
> **D13（上限取值与跨库旧账）**：统一上限取 `modelCalls 60 / autonomousActions 2 / voiceRequests 50`——QQ 原来 50/天、iLink 50/天、life 4/天，合并后共享 60/天的模型池（QQ 不被饿死，又比三套各写各的省）。iLink 从「按账号各自记账」改成**跨渠道共享同一池**（这正是 §2 差距表里「跨渠道预算隔离」那条要收敛的）。调用方自设封顶继续有效（`reserve(db, day, dimension, limit)` 取 `min(统一上限, limit)`，保住 `qq.test.mjs` 里 limit=3 的封顶语义）。life 的旧账在 BRAIN 库，跨库搬不进同库回填逻辑，由 `syncLegacyLifeUsage` 显式棘轮，并且是**相加**（QQ 的 3 + life 的 1 = 4）而不是取大。
>
> **D14（D-4 不搬）**：按 §5.7 原表 D-4 的口径，`src/` 目录**本期不做**——「仅在本计划全部完成后，按需渐进搬迁」，一次性搬家会吞掉本期的全部风险预算。本批只保证新代码都落在既有 `connect/core/` 等既有位置（D7），给后续搬迁留干净落点。


---

## 6. 关键接口草案

> 以下是接口的**形状**，具体字段以代码评审为准。本节存在的意义是让 P0-A/B/C 有共同落点。

### 6.1 ScopeEnvelope（身份信封）— P0-A-1

```js
// connect/core/scope.mjs
export function buildScope({
  channel,            // 'desktop'|'qq'|'wechat'|'android'|'douyin'|'call'
  accountId,
  peerId,
  peerRole,           // 'owner'|'friend'|'member'|'self'|'unknown'
  conversationKind,   // 'direct'|'group'|'public'
  inputKind,          // 'text'|'voice'|'event'
  messageId,
  label,              // 展示名，不作为信任依据（修 R-01 的根因之一）
}) → Object.freeze({
  channel, account_id, peer_id, peer_role, conversation_kind,
  input_kind, message_id, label,
})
```
**规则**：`label` **不得**参与任何信任判定；信任只由 `peer_role` + `conversation_kind` 决定。

### 6.2 InteractionEvent v1 — P0-A-4

沿用 `connect/core-contract.mjs:10-56` 的结构，新增：
- `trace_id` 提升为 `agent_events.trace_id` **独立列**（加索引 `agent_events_trace(trace_id)`）；
- `channel` 词表统一为 `desktop/qq/wechat/android/douyin/system`；
- `sender.canonical_person_id` 从 `null` 变为可填字段（架构文档 ADR-001 单一身份的关键锚点）；
- 四种抛错补齐测试。

### 6.3 IntentResult — P0-B-3

```js
{ intent, operations: [], requires_confirmation: bool, confidence: 0..1, rationale }
```
替换：`connect/tasks.mjs:27 parseExternalIntent` + `connect/actions.mjs:308 actionMarkerNames` + `connect/qq/tools.mjs:203 normalizeSteps` 三套。

### 6.4 AgentTask + TaskStep — P0-C-1/C-2

```js
AgentTask { id, origin, scope, goal, intent, risk, status, steps: TaskStep[],
            depends_on: [], parent_task, approval: {state, approver_peer_id, decided_at},
            idempotency_key, created_at, updated_at, deadline }
TaskStep  { index, action, params, precondition, postcondition, state,
            verify: {kind, target, expected}, receipt: ExecutionReceipt }
```
状态机 9 态；`depends_on` 让架构文档的 DAG 首次真正落到存储层。

### 6.5 ExecutionReceipt（回执五态）— P0-C-3

```js
{ operation, adapter,
  status: 'invoked'|'accepted'|'verified'|'failed'|'unknown',
  observed_at, evidence: [], detail }
```
`invoked`=已调用；`accepted`=平台已接受；`verified`=业务已验证（读回数据确认）。`connect/qq/tools.mjs:228` 现成的 `verified` 布尔字段由此获得语义。

### 6.6 Capability Manifest — P1-B-2

```js
{ id, title, one, status, aliases, tags, files, detail,
  input: {...}, output: {...}, version, permissions: [], depends_on: [],
  verify: {...} }
```
`status` 从 5 套词表收敛为 1 套；`scripts/capabilities.mjs --check` 行为不变。

### 6.7 MemoryRecord — P1-A-1

```js
{ id, content, type /*七类*/, scope, channel, peer_id, source, confidence,
  importance, tags, active, created_at, expires_at, supersedes_id }
```

---

## 7. 测试与回归策略

### 7.1 现状与目标

| | 调研基线（02:20） | 目标 | **现状（19:20 收尾后）** |
|---|---|---|---|
| 单元/集成用例 | **190 / 190 通过** | 基线 + 15（P0）→ +50（P1） | ✅ **329 / 329 通过、0 fail**（净增 139 条；历次：190→219→243→251→255→259→280→312→328→**329**） |
| `capabilities.mjs --check` | `{"count":12,"indexLength":492,"problems":[]}` | 不退化 | ✅ `{"count":12,"indexLength":492,"problems":[]}` |
| `release-check.mjs` | 未跑 | — | 🟡 仅 `stability-window-seven-days` 红（271 samples / 46.20h < 7 天），属运营闸门 |
| 意图回归 | `scripts/intent-regress.mjs` 30 条真实语句，**不在 tests/ 里**，需活的 brain + 模型 key，CI 从不运行 | 改造为依赖注入 + mock 模型，纳入 `tests/` | 🟡 **部分**：路由层已可离线测（`tests/route-policy.test.mjs`）；`scripts/intent-regress.mjs` 仍在，仍需活 brain + key |
| 手工验证 | 无脚本 | 新增 `scripts/verify-p0.mjs` | ✅ 已有 `scripts/release-check.mjs` + `scripts/capabilities.mjs --check` |

### 7.2 每批次必过的三道门

1. `node --test tests/*.test.mjs` 全绿；
2. `node scripts/capabilities.mjs --check` 无 problems；
3. **改动过的能力必须有一条对应的行为断言**（不允许"重构后行为不变但没人证明"）。

### 7.3 新增测试的优先目标（当前**零覆盖**的高价值点）

- `interactionEvent` 四个抛错；
- 非 owner 的 QQ c2c peer 不得得到 `privacy_scope='private'`（**当前代码会挂**）；
- `metadata.connect.channel !== 'ilink'` 被拒 → 改为"允许枚举内通道"；
- `normalizeCoreRequest` 的 `invalid_core_context` / 4000 字上限 / `metadata` 透传；
- iLink 出站 dedupe 键与 QQ 不对称（`${row.id}:out` vs `${event_id}:out`）；
- 跨库事件连续性 / `trace_id` 列存在；
- `connect/qq/brain.mjs` 提示词装配、`connect/qq/planner.mjs` 本体、`connect/ilink/brain.mjs` 提示词装配、`connect/call/brain.mjs` 的 `[HANGUP]` 契约；
- `connect/messages/feed.mjs buildFeed`、`connect/desktop.mjs announceConnectEvent`、`connect/observability.mjs recordObservation`、`connect/cognition-bridge.mjs:18 preparePlanStep`；
- 跨渠道预算隔离（`qq_usage` vs `ilink_usage`）。

---

## 8. 发布与回退

| 批次 | 发布方式 | 回退 |
|---|---|---|
| 批 0 | 直接提交（4 处小修 + 4 条测试） | `git revert` 单 commit |
| P0-A | **分 3 个小 PR**：A-1/A-2/A-3（身份）→ A-4（事件）→ A-5/A-6/A-7（治理） | 每个 PR 独立开关；A-4 涉及双库，保留旧表 2 周不删 |
| P0-B / P0-C | 分 PR，每步一个提交 | 旧路径保留一个版本，`feature flag` 切换 |
| P1-* | 分 PR | 迁移全部走 `migrate(db)`，失败自动回滚到上一 `user_version` |

**数据迁移纪律**：
- 所有 ALTER 都写进迁移数组，**禁止**散落的 `PRAGMA table_info` 探测式 ALTER；
- 迁移前自动 `VACUUM INTO` 备份（`runtime/backups/<ts>.sqlite`）；
- 新列先可空 + 默认，写入路径补齐后再收紧。

---

## 9. 请审阅的决定（16 条）

> D1–D10 是计划初稿的十条；D11 在 P1-B 收尾时补（P1-C 落地），D12–D14 在 P2 落地时补，D15 在收尾复检时补。

| # | 议题 | 选项 | **我的建议** |
|---|---|---|---|
| **D1** | **本期主场景** | (a) QQ 私聊主链路 + 抖音评论作为唯一写操作　(b) 先做抖音内容闭环　(c) 全部一起 | **(a)**。R-01 的泄漏面主要在 QQ，先把"爸爸的 QQ 私聊"做成唯一可信入口 |
| **D2** | **身份模型** | (a) `qq_peers` 加 `role` 列并迁移　(b) 继续用 `label==='爸爸'` 字符串 | **(a)**——而且**已经在做了**（`connect/qq/store.mjs:19-31` 见 §0.0）。本决定实际待定的是：谁来设置 owner（配置 / 命令 / 首次绑定自动认领），以及 `label` 是否彻底降级为展示名 |
| **D3** | **事件单一真源** | (a) CONNECT 库　(b) BRAIN 库　(c) 新建第四个库 | **(a)**。看板、任务、技能账本都已经在 CONNECT 库；BRAIN 库专注记忆与人格 |
| **D4** | **记忆范围模型** | (a) `memories` 加 `scope` 列　(b) 按范围分表　(c) 只靠 `daily_memory_events` 做隔离 | **(a)**。`recall()` 一次过滤即可解决，且不影响现有 19 行 |
| **D5** | **外部动作授权分层** | (a) 全部逐条人工确认　(b) 按风险等级分层（R2 自动 / R3 私聊确认）　(c) 全自动 | **(b)**。当前 3 套审批通道 + 自批，等于没有边界；分层后既有边界又不烦人 |
| **D6** | **调度器自批** | (a) 取消自批　(b) 保留但限 R0–R2 白名单 | **(b)**。完全取消会打断每日计划；限白名单后 `external.execute` 真正生效 |
| **D7** | **目标目录** | (a) 新建 `src/` 按架构 16 章节搬　(b) 就地演进 + `connect/core/` 收契约 | **(b)**。架构文档自己说了"不要求一次性搬迁"；搬迁会吞掉本期的全部风险预算 |
| **D8** | **能力 Manifest 迁移方式** | (a) 原地扩 `connect/memory/capabilities.mjs`　(b) 新建 `connect/core/capability.mjs` 再删旧的　(c) 只加字段不动位置 | **(b)**，但 `scripts/capabilities.mjs --check` 的对外行为必须保持不变（它是回归闸门） |
| **D9** | **意图回归是否进 CI** | (a) 进（需 mock 模型）　(b) 不进，保留手工　(c) 进且允许 key | **(a)**。30 条真实语句是意图质量的唯一护栏，现在完全没跑 |
| **D10** | **是否先做批 0** | (a) 先做（半天）　(b) 跳过直接做 P0-A | **(a)**。批 0 四处都是"声明了但没生效"的 bug，与 P0-A 无耦合，改了立刻见效 |
| **D11** | **能力/学习状态词表方向** | (a) 改代码对齐计划词表（`approved`/`valid`）　(b) 改计划对齐代码词表（`validated`/`enabled`） | **(b)**。计划文档不再出现 `approved`/`valid` 这两个技能/学习状态（`approved` 仅保留在 `approvals` 表的审批决策里，语义不同）；见 §5.6 |
| **D12** | **统一预算落在哪本库** | (a) CONNECT 库　(b) BRAIN 库　(c) 新建第四个库 | **(a)**。与 D3 同源；life 经 `openConnectBudget(home)` 打开同一文件；拿不到就退回 BRAIN 库（同一套逻辑与上限，只是不与另两渠道同格）。见 §5.7 |
| **D13** | **统一上限取值与跨库旧账** | (a) 沿用各渠道原上限　(b) 共享一池（60/2/50）　(c) iLink 仍按账号独立 | **(b)**。iLink 从按账号记账改为跨渠道共享同一池；调用方自设封顶取 `min(统一上限, limit)`；life 旧账跨库**相加**棘轮进统一账。见 §5.7 |
| **D14** | **`src/` 目录搬迁** | (a) 本期就搬　(b) 本期不搬，只留干净落点 | **(b)**。§5.7 D-4 原表就写明「仅在本计划全部完成后按需渐进搬迁，不做一次性搬家」；本期新代码全部落在既有 `connect/core/`（D7），给后续搬迁留位 |
| **D15** | **`call` 是否算独立事件渠道 / `approvals` 惰性表** | (a) 继续并进 `system`　(b) 成为词表内的独立渠道，且 `approvals` 不存在时按「未授权」返回 | **(b)**。①`connect/core-contract.mjs` 与 `CallService` 都以 `channel:'call'` 写事件，但 `agent-events.mjs` 的 `CHANNEL_ALIASES` 把它改写成 `system`，等于 D-3 的「call 一等渠道」只在契约层成立、落库层不成立（同一条事件查 `channel='call'` 查不到）——已改词表并补断言；②`approvals` 由 `initApprovalLedger` 惰性创建，`core/execute.mjs` 在表还不存在时直查会抛 `no such table`，已加 `hasTable` 守卫按未授权处理。见 §10 收尾复检行 |

---

## 10. 附录 A · 实施记录

> 每完成一个步骤，在此追加：日期 / 提交 / 验收命令与输出 / 遗留问题。

| 日期 | 步骤 | 提交 | 验收 | 备注 |
|---|---|---|---|---|
| 2026-11-16 02:20 | 现状调研 + 本计划 v1.0 | — | 190/190；capabilities check ok | 调研窗口内工作区有并发改动（`qq_peers.role`、`syncQqOwner`、`service.mjs:324`），已按 §0.0 校准 |
| 2026-11-16 03:00 | 批 0 · 一次性小修（4 项） | plans.mjs SQL direction bug / compliance.mjs 小时限流 / lessons 单文件（`connect/lessons-store.mjs`+`scripts/migrate-lessons.mjs`）/ `qq/service.mjs` capabilityBlock 门控 | 219/219 | 四处「声明了没生效」的 bug 收敛，零架构改动 |
| 2026-11-16 03:25 | P0-A · A-1..A-9（身份信封+事件单源+策略闸门+审批留痕） | `core/scope.mjs`+brain 多渠道信封（`brain/server.mjs:108` 放宽 channel/role、无信封按 self）/ A-3 `syncQqOwner`+`qq_peers.role` / A-5 `approvals` 表+作者校验（`connect/approvals.mjs:23,51,103`）/ A-6 `core/execute.mjs` 执行闸门 / A-7 去 scheduler 自批 / A-9 interactionEvent 抛错补测 | 219/219 | R-01 身份泄漏止血完成；`external.execute` R-05 真正生效 |
| 2026-11-16 03:40 | P0-B · B-1..B-6（QQ 私聊主链路收口） | 六段拆分 `ingest→identify→route→plan→executePlan→deliver` / `core/route.mjs` routePolicy 单一裁决 / `core/task.mjs` IntentResult / `core/llm.mjs` chatCompletion（planner+brain 共用）/ `core/facts.mjs` / B-6 发布握手收敛 `core/publish.mjs`（四处接线） | **243/243**（新增 `tests/route-policy.test.mjs` 24 条 ≥8 要求） | 六段路由决策表是 P0-B 验收门槛；capabilities check `{"count":12,"indexLength":492,"problems":[]}` |
| 2026-11-16 03:57 | P0-C · C-1..C-5（统一 AgentTask + 回执五态 + 幂等 + 桌面闸门） | C-1 `core/task-store.mjs` setTaskStatus 四库同步 / C-2 九态（`core/task.mjs` TASK_STATES/TASK_TRANSITIONS）/ C-3 回执五态（`receipts.mjs` invoked/accepted/verified/failed/unknown）/ C-4 步骤幂等（`executeOperations` doneStepKeys+`requireIdempotencyKeys`）/ C-5 桌面闸门拒绝+留痕 | **251/251**（新增 `tests/p0c.test.mjs` 5 条） | **P0-C 三条验收全部达成**：①四库存一处真值（`tests/p0c.test.mjs` 四库同步断言）②回执三态独立测试（`tests/receipts.test.mjs`）③桌面试发外部动作被拒+留痕。C-6（Android/通话接 interactionEvent）为支撑项，未列入验收，留作后续接线 |
| 2026-11-16 04:00 | P1-A · 记忆范围 + 七类（堵 R-05/R-07） | `brain/migrations.mjs` v15 加 `type/scope/channel/peer_id/importance`+老 kind 回填 / `brain/memory.mjs` 七类枚举 + `recall` scope 过滤 / `memory-hub.mjs` todayDigest 加 scope / `core/memory.mjs` A-3 统一检索入口 `search`/`rememberScoped` | **255/255**（新增 `tests/memory-scope.test.mjs` 4 条） | **P1-A 两条验收达成**：①群聊记忆不漏进主人私聊召回 ②七类每类可写入可召回。scope 过滤同时堵住「群聊活动漏进主人私聊提示词」 |
| 2026-11-16 04:05 | P1-B · 状态词表收敛 + capability.code 门控（堵 R-10，部分） | `core/capability.mjs` 单一 CAPABILITY_STATUSES/RUN_STATUSES+`normalizeStatus`（real_verified→stable）/ `core-contract.mjs` CAPABILITY_MATRIX 归一+校验 / `scripts/capabilities.mjs` --check 用统一词表 / `qq/tools.mjs` runTool 状态同源 + `capability.code` owner-only | **259/259**（新增 `tests/capability-vocab.test.mjs` 4 条） | **P1-B 门槛达成**：①`--check` 仍返回 `{"count":12,"problems":[]}` ②新增测试断言三处状态词表一致。B-4 capability.code 收进 owner-only。**未完**：B-1 评论流水线 / B-2 单一 Manifest 合并 / B-5 capability-map 待做 |
| 2026-11-16 12:32 | P1-B 收尾 · B-1/B-2/B-5 全部落地（能力注册表收敛完成） | **B-1** 新增 `connect/core/comment-pipeline.mjs` 七段流水线（understand→intent→draft→compliance→decision→publish→verify），设备动作全靠注入，已接入 `scripts/douyin.mjs --reply-inbox` 真实链路与 `connect/actions.mjs` douyin.reply_comments 回话（带回执状态）；**B-2** `connect/memory/capabilities.mjs` 12 张能力卡补齐 input/output/version/permissions/depends_on/validation + 原子能力带 note/scope/order，`core-contract.mjs` 删掉手写第二份矩阵改为派生、capabilityText 改为从能力卡渲染（逐字不变），`qq/brain.mjs` 删掉硬编码能力菜单改调 `actionMenuPrompt()`；**B-5** 新增 `connect/core/capability-map.mjs` 显式映射表（17 动作↔12 工具↔12 技能） | **280/280**（新增 `tests/capability-map.test.mjs` 8 条 + `tests/comment-pipeline.test.mjs` 13 条） | **P1-B 五步全部完成**：`--check` 仍返回 `{"count":12,"indexLength":492,"problems":[]}`；映射表计数 actions=17 / tools=12 / skills=12、problems=[]；三张表一项不漏（测试直接对着 `ACTIONS` / `ALL_TOOLS` / `SKILL_DEFS` 核）；占位动作 `douyin.like_comments` 不进提示词。**决定 D11（词表方向）**：计划验收词表写的 `learning_proposals` 出 `approved`、技能 `validating→valid` 与代码实际（`connect/skills.mjs:4` `candidate/validating/enabled/deprecated`、learning.mjs 用 `validated`/`enabled`）不一致——按「词表收敛是本计划核心主张、不再造别名」的原则，**改计划文档对齐代码**（P1-C 落地时同步修订 §5.6/§9 词表） |
| 2026-11-16 13:20 | P1-C · C-1..C-5（技能账本归一 + 断言结构化 + 学习闭环 + 晋升闸门，堵 R-06/R-12） | **C-1** `scripts/douyin.mjs` beginSkill/beginStrategy 改用 `connect/skills/ledger.mjs` 的 CONNECT 库（`openSkillLedger` 公开导出），BRAIN 库不再持有 `skill_*`/`strategy_trials`；**C-2** 46 条中文散文 assert 全改结构化对象（保留 `assertText` 供人读），新增 `connect/skills/assertions.mjs` 执行器（24 种 kind + `runAssertions`/`describeAssertion`，核不了就 false）；**C-3** 新增 `connect/skills/learning-policy.mjs`（skill→risk 从 capability-map 推，R0/R2 阈值 2 自动升版、R3 阈值 3 需主人点头），`learning.mjs` 阈值改按 `thresholdForSkill`、新增 `maybeAutoApprove`/`sweepLearning`，`reflection.mjs` `validateReflection` 阈值参数化；**C-4** 新增 `connect/skills/promotion.mjs` 晋升闸门（真实 verified run + `evaluateSteps` 逐步重放结构化断言全过才 `setSkillStatus(...,'enabled')`，核不了就 false）；**C-5** `connect/performance.mjs`+`actions.mjs`+`core/execute.mjs` 埋点接 `performance_samples`（stage=`action:<name>`/`external.execute`，采样失败绝不影响动作成败） | **312/312**（新增 `tests/skill-assertions.test.mjs` 19 条 + `tests/learning-policy.test.mjs` 6 条 + `tests/skill-promotion.test.mjs` 7 条 + `tests/performance.samples.test.mjs` 8 条 + `connect/skills/ledger.douyin.test.mjs` 6 条） | **P1-C 五步全部完成**。**C-4 晋升闸门在真实库生效**：`academy.study v1 → enabled`（3/3 断言过，验收门槛「≥1 技能 validating→enabled」达成）；`douyin.draft`（image/store 文件已不在磁盘）、`douyin.check_interactions`（open_interaction 记的是完整组件名 vs 断言期望裸类名）被诚实拦下——正是「核不了就不升」。**另两条门槛逻辑已实现并被测试覆盖、等真实重复失败数据触发**：`learning_proposals` 出 `validated`（`sweepLearning` 对 R0/R2 达阈值自动写入，`tests/learning-policy.test.mjs` 已证；当前 2 条提案 occurrences=1 未达阈值 2）、`skill_rollbacks` 真实回滚（`maybeRollback` 连续 3 败触发，`tests/learning.test.mjs` 已证；当前技能全 v1 未到回滚条件）。**D11 词表对齐已落地**：§5.6/§9 统一用代码词表 `validated`/`enabled`，不再用 `approved`/`valid`。**遗留（建议单开）**：①`connect/actions.mjs` `record()` 缺 import `openHub`/`recordActivity`（memory-hub 活动日志从未写入）②`douyin.check_interactions` open_interaction 断言的 activity 期望值与运行时记录的完整组件名格式不一致（可改 `activity_matches` 后缀匹配） |
| 2026-11-16 17:35 | P2 · D-1..D-4（自主目标 ↔ 统一 AgentTask + 跨渠道统一预算 + 通话事件流） | **D-1** `connect/tasks.mjs` 新增 `createGoalTask`（幂等键 `life:goal:<goalId>:<day>`，写 external_tasks + working_tasks 镜像 + `task_state_changed` 事件）；`life/tasks.mjs` 新增 `linkGoalTask`（`ON CONFLICT(goal_id,day) DO UPDATE`）、`goalTaskHistory`、`goalsWithTasks`，`enqueueTask` 增 `goalId`/`agentTaskId`；`life/manager.mjs` explore 块改为「建 reflection → 写 tasks.goal_id → `createGoalTask` 拿统一任务 id → `linkGoalTask` 指过去 → 更新 progress_note」；`scripts/life.mjs` goals 命令带出最近关联 task。**D-2** 新建 `connect/core/budget.mjs`（**唯一真源** `daily_budget` 表：model_calls / autonomous_actions / voice_requests 三个字段、维度白名单防注入、`reserve` BEGIN IMMEDIATE 原子占用、调用方 limit 与统一上限取 min、`legacyUsage`/`backfillLegacyUsage`/`ratchetBudget` 迁移棘轮）；`connect/qq/store.mjs` reserve 改为委托统一预算（usage 形状不变）、`connect/qq/service.mjs` 上限改用 `DAILY_BUDGET`（60/50）、`connect/ilink/worker.mjs` 删内联 ilink_usage 记账改为共享池 reserve、`connect/ilink/store.mjs` 补 `voice_requests` 列、`connect/board.mjs` 看板读统一账并合并趋势、`life/manager.mjs` 接 CONNECT handle（`openConnectBudget`/`syncLegacyLifeUsage`）、`scripts/life.mjs` status 读统一账。**D-3** `connect/core-contract.mjs` channel 白名单加 `call`（call 成一等 ingest 渠道）、`connect/call/service.mjs` 新增 `emitEvent`（try/catch 绝不影响通话）、`connect/server.mjs` CallService 落 `agent_events`（channel='call'、owner 按私聊主人处理）；顺带修 `connect/actions.mjs` `record()` 缺 import `openHub`/`recordActivity`（活动日志从未写入的静默 bug）。**D-4** 按 §5.7 原表不实施（见 D14）。 | **328/328**（新增 `tests/budget.test.mjs` 9 条 + `tests/goals.test.mjs` 6 条；`tests/call.test.mjs` +1 条） | **P2 三条验收全部达成**：①目标→推进→统一任务一条链（`goal_progress.task_id` = `external_tasks.id`，同 goal+day 重复推进是更新）②只有一份跨渠道日配额（三渠道 reserve 落同一张 `daily_budget`，两维度互不干扰，迁移当天旧账相加棘轮不白送也不重复）③通话接入完整事件流（`call` 一等渠道 + `tests/call.test.mjs` 断言 message_received/message_replied）。**真实库验证**：`runtime/connect/connect.sqlite` 的 `daily_budget` 当日行 = `model_calls 4`（QQ 3 + life 1 跨库相加）、`autonomous_actions 1`、`voice_requests 0`，重复执行不翻倍。**改动过的既有断言**：`tests/qq.test.mjs` 的「日预算用尽就停答」改用统一上限（QQ 原来各 50，合并后共享 60）——这是 D-13 的直接后果，不是放宽。**遗留**：`ilink_usage` 表保留但不再写入（历史列，供回溯）；`skill_rollbacks` 真实回滚、`learning_proposals` 出 `validated` 仍等真实重复失败数据触发（P1-C 已说明） |
| 2026-11-16 19:20 | 收尾复检 · 运行态重载 + D-3 补正（D15） | **运行态**：`launchctl kickstart -k com.dafeiyu.pet/com.dafeiyu.connect`，两进程重载新代码；**真实库迁移首次执行**（此前进程启动早于这批代码，`grep -c connect_migrations connect-error.log` = 0）：`user_version 0→2`、`agent_events.trace_id` 真列 + `agent_events_trace` 索引、`approvals` 仍按设计惰性创建。**D15①** `connect/agent-events.mjs` 的 `CHANNELS` 补 `call` 并删掉 `call→system` 别名——此前 `core-contract` 与 `CallService` 都写 `channel:'call'`，但落库被 `normalizeChannel` 改写成 `system`，D-3「call 一等渠道」实际未生效（实测 `recordAgentEvent({channel:'call'})` 落库为 `system`）；同步改 `tests/event-trace-migration.test.mjs` 两处按旧词表写的断言。**D15②** `connect/core/execute.mjs` 的 `executeApprovalAction` 读 `approvals` 前先 `hasTable` 判断——该表惰性创建，首次审批之前带 `approval_request_id` 的请求原本会炸 `no such table: approvals` 而不是按「未授权」返回；新增回归用例。 | **329/329**（`tests/execute-gate.test.mjs` +1） | **验收复核**：`capabilities --check` = `{"count":12,"indexLength":492,"problems":[]}`；`release-check` 仅 `stability-window-seven-days` 红（271 samples / 46.20h）；三端口 3110/3108/8765 全 200；`daily_budget` 当日行仍为 `4/1/0`（重启不翻倍）。**文档**：头部状态块改为「已全部落地」+ 最新自检，§1.2 增现读数对照表，§2.1 增七层差距收敛现状，§3 增落地状态总表（R-01..R-12 收口，R-13 3/10、R-14 部分），§7.1 改 329/329。**仍未提交**（按用户要求）。 |

| 2026-11-16 19:40 | 架构可视化 · `/arch` three.js 实时架构图 | **数据真源** `connect/arch/graph.mjs`（19 节点 / 24 边 / 12 条事件路径 / 13 种事件样式 + `validateGraph()` 自检，测试与页面共用）。**渲染** `connect/arch/main.js`：四层球面布局（渠道外圈 / 内核中圈 / 认知 y+ / 调度 y−）+ 中心 fresnel 球；边用二次贝塞尔 `TubeGeometry` 与虚线、流动光点；UnrealBloom + CSS2D 标签（贪心占位防重叠，副标题悬停才出现）；事件沿路径发射脉冲（头 + 白核 + 8 节拖尾，过节点闪光 + 涟漪），点击聚焦并出详情面板。**接线** `connect/server.mjs`：`/arch` → 302 `/arch/`、`serveArch` 扩展名白名单 + realpath 防穿越 + no-store；`GET /api/arch/stream` SSE 只推 `event_type/channel/task_id/created_at`（不推 payload）并回放最近 6 条做 ticker 种子；`POST /api/arch/pulse` 需 adminToken（合成动效、不写库）。**踩坑修正**：`/arch` 无尾斜杠时 importmap 相对路径解析到站点根，页面只剩空壳——改为 302 + 绝对路径 + 3 秒 `#fatal` 兜底。演示入口 `?demo=1`、`?pulse=<eventType>&ch=<channel>&loop=1`。 | **331/331**（新增 `tests/arch-graph.test.mjs` 2 条：图数据自洽 / 静态资源白名单与 SSE 元数据、脉冲鉴权） | **验收**：真实库迁移后 `http://127.0.0.1:8765/arch` 可打开，19 个节点 + 四条图例 + 渠道计数（QQ 92 / 抖音 12）与「任务 110」均来自 `agent_events` 实数据；触发 `?pulse=` 或真实事件时光点沿 `channel → events → … → channel` 跑完整链路。**边界**：SSE 只读事件元数据，payload 一律不出站；`/arch` 只服务 `connect/arch/` 白名单文件。 |
| 2026-11-16 20:05 | 架构图 · 点 ticker 看任务流程 + QQ 呼入自动接听常驻化 | **流程抽屉** `connect/server.mjs` 新增 `GET /api/arch/task?id=`（`external_tasks` + `working_tasks` + 该任务 `agent_events` 时间线）与 `GET /api/arch/event?id=`；payload/result 只出白名单键摘要（`archDigest`，同值去重、截断 160 字），整段正文不出站；SSE 的 `event` 与 `hello.recent` 补 `id` 以便单条反查。`connect/arch/index.html` 加 `#flow` 右侧抽屉（状态徽章 / 元信息 / 时间线），`connect/arch/main.js` 让 ticker 行可点（高亮当前行）、抽屉内每步可点回放该步脉冲、`Esc` 关闭、和节点详情互斥；截图入口 `?task=<taskId>`。**QQ 自动接听**：根因是 watcher 只在终端里手动跑过（`runtime/sound/qq-answer.log` 停在 11-14 19:47），从未装成常驻；`scripts/qq-answer-install.mjs`（install/status/probe/uninstall）把它装成 `com.dafeiyu.qq-answer` LaunchAgent，并**用 `open -a Terminal` 交给终端跑**——实测 launchd 直起的 node 既读不到窗口标题（无屏幕录制）也点不动（无辅助功能），终端.app 两个权限都有；`scripts/qq-answer.command` 是看护壳（`tee` 到日志、退出 5 秒重启）。`scripts/qq-answer.mjs` 补单实例守卫（`runtime/macui/qq-answer.watch.pid`）、SIGTERM/SIGHUP 收尾、辅助功能自检与窗口快照日志；`connect/macui/qq.mjs` 的 `findCallWindow` 增尺寸兜底（标题全空时按 260–640 宽 / 380–900 高的竖长窗识别，主窗 960x949 不会误判）。 | **332/332**（`tests/arch-graph.test.mjs` +任务详情/404/400/单事件断言、`tests/macui.test.mjs` +1 条尺寸兜底用例） | **验收**：①`/arch/?task=task_1fcd6dd1…` 抽屉显示 12 步时间线（`任务状态 status=awaiting_confirmation` → `approved` → `running` → `开始执行` → `回执已核 operation=douyin.publish` → …），点任一步在图上回放；②无任务 id 的事件退化成单条详情；③`com.dafeiyu.qq-answer` 已注册并运行，日志出现「辅助功能权限：正常（可以模拟点击）」「窗口快照：1 个 —— QQ」——标题可读即屏幕录制也通；④`node scripts/qq-answer-install.mjs status` / `probe` 可自查。**边界**：两种托管方式——默认终端托管（终端窗口需常驻）；已切 `--direct` 直跑（给 node 二进制授予「辅助功能 + 屏幕录制」后，`launchctl kickstart` 即可，无终端窗口，日志实测 `窗口快照：1 个 —— QQ`）。`?task=` 仅本地看，不写库。截图见 `docs/assets/arch-task-flow.png`。 |
| 2026-11-16 23:20 | **实时工作流控制台（GET /live）** · 低 GPU 的「另一套」观察面 + 定时任务报错不再截断 | **新页面**：`connect/live/`（`index.html` / `live.css` / `live.js` / `catalog.mjs` / `api.mjs`），纯 DOM + SSE，**没有 requestAnimationFrame 循环**，静止时 GPU≈0；3D 架构页 `/arch` 原样保留（空闲停渲染留给下一步）。**数据字典** `catalog.mjs`：9 个阶段（接入/观察/路由/任务/闸门/执行/回执/认知/通话）+ 6 种状态（空闲/进行中/完成/失败/等待/待确认）+ `stageForEvent()`（任务状态变化按 `payload.status` 细分成紫灯「待确认」）+ `digestOf()`（一行摘要按中文枚举翻译，去掉 `trace_id` 这类内部字段）。**接口** `api.mjs` + `connect/server.mjs`：`GET /api/live/snapshot`（计数/9 阶段/最近任务/今日计划槽/最近事件）、`/api/live/stream`（SSE：hello 快照 → 事件增量 → 每 4 tick 推统计）、`/api/live/event?id=`（**输入 payload / 输出 result / 证据 evidence** 全量结构化）、`/api/live/task?id=`（任务头 + 步骤时间线，每步带输入输出）、`/api/live/tools`（17 动作 × 工具 × 技能 × 近 7 天成功失败）、`/api/live/slots?day=`；静态走 `serveStatic()`（与 `/arch` 共用 realpath 防穿越 + 白名单扩展名），`/live` 302 → `/live/`；令牌可走 `Authorization` 或 `?token=`（EventSource 带不了请求头），没有令牌一律 401。**页面**：左侧流水线节点会按事件亮（含 `未埋点` 虚线提示），中间实时事件流可暂停/按阶段过滤，右侧详情抽屉显示输入输出与步骤时间线，底部三页签＝任务 / 定时任务 / 工具清单；深链 `?task=` `?event=` `?tab=` `?nostream=1`（截图用，跳过 SSE）。**定时任务报错**：`connect/scheduler.mjs` 失败 note 从 120 字放宽到 900 字并压平空白，同时补写 `action_failed` 事件（channel=`plan`，dedupe `slot_failed:<slotId>`）——以前「Command failed: …」把额度吃光，真正的 node 报错被切掉。 | **338/338**（新增 `tests/live.test.mjs` 3 条：事件→阶段映射与状态、摘要不泄漏长正文、`/live` 白名单 + 接口令牌 + 事件/任务详情含输入输出 + 工具清单覆盖 17 动作） | **验收**：①`/live/` 打开即见 231 事件 / 22 执行 / 9 失败 / 14 任务 / 11 定时槽；②点事件 → 右侧出现「输入(payload) / 输出(result) / 证据(evidence)」，点任务 → 9 步时间线；③定时任务页签直接列出 `douyin.daily_post` 失败与原文；④阶段「路由」显示 **未埋点**（`routePolicy` 目前不写事件）——本页发现的下一个缺口。截图见 `docs/assets/live-console.png`。
| 2026-11-16 23:40 | **四个页面共用一条 title bar** | 新建 `connect/shell/nav.js` + `nav.css`（唯一一份导航定义）：三个入口＝运行看板 `/board`、实时工作流 `/live/`（工具清单是它底部的页签，不再单开入口）、3D 架构 `/arch/`；`nav.js` 按 `location.pathname` 高亮、把地址栏的 `?token=` 搬到每个链接（跨页不用重新授权）、给 `<html>` 打 `data-page` 与 `.dsh-nav-on`；`nav.css` 用这两者做**逐页布局补偿**（board/live 让出 46px 高度、arch 把 HUD 整体下移、messages/call 用 padding-top）。`connect/server.mjs` 新增 `SHELL_ROOT` 与 `/shell/*` 静态路由（复用 `serveStatic` 的 realpath 防穿越 + 扩展名白名单）；`/board`、`/live/`、`/arch/`、`/messages`、`/call` 五个页面各加两行 `<link>`+`<script>`。顺带两处：`connect/live/live.css` 给 `#grid` 钉 `grid-template-rows: minmax(0,1fr)`、阶段行压紧并在非悬停时收起副标题（加了 title bar 之后 9 个阶段仍一屏可全见），`connect/messages/page.mjs` 的自动滚动改成「本来就在底部才跟」。 | **339/339**（新增 `tests/shell.test.mjs`：`/shell/nav.css|js` 可访问、四页都引用同一份、导航含四个站内入口且不依赖外部域名、穿越路径被拒） | **验收**：默认浏览器里改用 `?token=<adminToken>`；`/live/` 时「实时工作流」高亮（`?tab=` 不影响高亮）、`/arch/` 与 `/board` 同理；截图见 `docs/assets/shell-nav.png`。**注**：`/messages` 在 headless 里用 `--virtual-time-budget` 截图会整页空白（同内容静态渲染正常），属截图工具问题，浏览器里正常。 |
| 2026-11-16 23:52 | **实时工作流改版（单页多面板）** | `/live` 从「三栏 + 底部 210px 三页签」改成「三栏 + 中间页签主区」：`<main id=layout>`＝`aside#rail`（9 阶段流水线 + 图例）／`section#center`（`role=tablist` 四个页签：实时事件／任务／定时任务／工具清单，下面 `role=tabpanel` 四块占满整高，底部一条 30px 的 `#ticker` 常显「最近一条事件」）／`aside#detailPanel`（选中才展开，宽 392px；没选中时收成 0，中间更宽）。任务、定时任务、工具清单不再是页底窄带，而是整屏表格。 | **339/339**（`tests/live.test.mjs` 3 条不变） | 语义化 + 可达性：`header/main/aside/footer` 各归其位、页签 `aria-selected`/`aria-controls`/`role=tabpanel`、方向键与 Home/End 切页签、列表行 `role=button` + `tabindex=0` + Enter/Space 打开详情、`prefers-reduced-motion` 下关入场动画。切页签同步 `?tab=`。截图 `docs/assets/live-console.png`（默认事件流、详情收起）与 `docs/assets/live-task-flow.png`（任务详情 9 步时间线）。 |

| 2026-11-17 00:10 | **主页 + 实时工作流六项修补** | ① `connect/home/{index.html,home.css,home.js,data.mjs}`：技术栈 4 组 15 条（运行时/渠道接入/服务与页面/数据），九段流水线各写「职责 + 代码位置 + 留什么事件」；`validateData()` 供测试；`/home` → 302 `/home/`。② 事件 payload 加 `preview`（QQ/iLink/通话入出站各 `clipText(text,80)`），`digestOf` 把它放到摘要最前面 → 列表直接看到「「给爸爸打个电话」·私聊·文本输入·7字」；`scripts/backfill-event-preview.mjs` 回补 91 条历史事件。③ `connect/live/tool-meta.mjs`：17 个动作 + 5 个只读工具的「人话说明书」（标题/入口文件/介绍/逻辑/等级），`api.mjs` 合进 `toolList`（22 行，`actions 17 + readOnly 5`）。④ 右侧栏拆两个标签：`事件` / `任务与工具`，配 `detailStack` 返回栈（点任务→点某一步→可逐层返回，`Backspace` 返回、`Esc` 关闭）。⑤ 事件与任务各加筛选（状态 chip + 关键词搜索，`aria-pressed`）。 | **341/341**（新增 `tests/home.test.mjs` 2 条：数据自洽 + 页面/接口；`tests/live.test.mjs` 补工具说明书断言） | 截图 `docs/assets/home.png`、`docs/assets/live-console.png`（事件带消息内容）、`docs/assets/live-tools.png`（等级标签 + 工具说明书）。修复踩坑：`.pane` 缺 `flex-direction: column` 导致筛选条跑到列表中间；`section()` 传数组被拼成 `[object HTMLDivElement]`。 |

| 2026-11-17 00:20 | **主页 v3：按 Web 标准重构（弱化流水线）** | ① `connect/home/index.html` 按语义化重写：`<a class="skip" href="#main">` 跳过导航、唯一 `<h1>`、`<header class="top">` + `<main id="main">` + 三个 `<section aria-labelledby>` + `<footer>`；② 三段主内容按「先看能力、后看细节」排：`#stack`（技术栈 4 组 15 条，主角）、`#tools`（22 张能力卡：等级徽章 + 一句话介绍 + 入口文件 + `<details>逻辑详情`，可点等级 chip 过滤）、`#pipeline`（**弱化成一条九步带**，九段分工/代码/事件全部折叠进一个 `<details>`）；③ `connect/home/home.js` 直接 `import { LEVELS, TOOL_META, TOOL_ONLY_META } from '/live/tool-meta.mjs'`，主页与 `/live` 共用一份说明书，不再抄第二份；④ `home.css` 加 `:focus-visible` 焦点环、`.skip` 键盘跳转、`align-items:start`、`.toolCard[data-level]` 左侧色条、`prefers-reduced-motion` 关动效、860px 断点。 | **342/342**（`tests/home.test.mjs` 3 条：数据自洽含文件存在性；17 动作 + 5 只读工具的说明书完整性；页面语义结构 + skip link + 唯一 h1 + `/live/tool-meta.mjs` 只放行白名单） | 截图 `docs/assets/home.png`（整页）、`docs/assets/home-flow.png`（九步带 + 折叠入口）。踩坑：headless 截图用 `#pipeline` 锚点会得到空白帧，改用 iframe 负位移裁剪才拍到流水线带。 |

| 2026-11-17 00:26 | **主页 v4：首屏讲「它能做什么」** | ① 首屏重排：`h1` + 一句主张（会看抖音/写图文/回评论，也会打电话接电话）+ 22 项能力/四个入口 + 三个 CTA + 四个实时数字，先回答「这软件能干什么」；② 能力按场景分五组（抖音运营 13 / 联络与通话 4 / 手机与桌面 1 / 成长与学习 2 / 其他 2），每条**只露能力名 + 等级圆点色**，介绍/入口文件/逻辑/深链全部收进 `<details>`；③ 技术栈从「四张长列表」改成四根折叠条（只显示组名 + 项数），点开才看条目与代码位置；④ 流水线退到底部，九段压成一条 chip 带；⑤ 分组用竖色条而非 emoji（不依赖字体），`color-mix` 发光；分组网格 ≥1040px 两列、以下单列。 | **342/342** | 截图 `docs/assets/home.png`（整页）。分组按动作前缀自动归位（`douyin.*` 与 `works.*`/`comments.*` 归抖音，`qq.*`/`wechat.*` 归联络，`device.*`/`macui.*` 归设备，`academy.*` 归成长，其余落「其他」）。 |
| 2026-11-17 00:33 | **主页 v5：排版修整 + 角色贴图** | ① 首屏改两栏：左边主张 + CTA + 四个数字，右边角色立绘卡（`connect/home/pet.png`，来自 `dsh-pet/assets/memes/可爱.png`，白底图放进浅色圆角卡 + 青色/紫色渐变描边，不做抠图以免毛边）；`<figure>/<figcaption>` 语义化、`alt` 写「蓝头发的鲸鱼女仆形象」；② 能力分组从「等宽网格」改成**瀑布流**（`columns:2` + `break-inside: avoid`），短卡片自动补位，右侧不再留大片空洞；③ 技术栈四根折叠条固定四列（≥1040px），窗口变窄按 2 列/1 列收回；④ `link rel=icon` 换成角色图，标签页也有脸；⑤ 断点 1040/900 两档分别处理 hero、分组、数字格。 | **342/342** | 截图 `docs/assets/home.png`。 |
| 2026-11-17 01:10 | **M1：让「以前怎么翻车的」进到当下的判断里** | ① `connect/core/pipeline.mjs` 成为九段唯一真源（`PIPELINE`＝entry/observe/route/task/gate/act/verify/memory/call，各带 `label/sub/events/files/runtime`），`connect/live/catalog.mjs` 的 `STAGES` 与 `connect/home/data.mjs` 的 `PIPELINES` 都从它生成，页面不再手抄；② `connect/core/traces.mjs` 让规划器看到同类任务的真实结局（`similarTraces` 查近 400 条事件、`tracesText` ≤3 行 ≤400 字、`operationHints` 把话反推成动作名），`connect/qq/planner.mjs` 多一段「以前同类任务的结果」；③ 新增 `route_decision` 事件（`connect/qq/service.mjs` 的 `route()` 里埋点、`connect/agent-events.mjs` 的 `EVENT_TYPES` 登记），`/live` 的「路由」阶段从「未埋点」变 wired；④ `handle()` 从六个 `if (...) return` 改成 `RUNTIME_STAGES` 表驱动（每段声明 `call/assign/stopIf/returns`），流水线顺序从此只有一处定义。 | **349/349** | 新增 `tests/pipeline.test.mjs` 3 条：九段自检 + 「/live 与 /home 都用同一份 PIPELINE」+ `EVENT_ROUTE` 反向覆盖；`traces` 按动作筛选、摘要 ≤160 字；`operationHints` 四类命中（含「打个电话」这种口语）。 |
| 2026-11-17 01:20 | **M2：做完一件事，系统自己知道成没成** | ① `connect/core/verify.mjs`：把「结果」变成判定——`confirmed / unconfirmed / mismatched / failed / skipped`，按操作声明期待（发布看作品数、回评论看条数、通话等外部事件），`evaluateTask` 按最坏一步给整单结论；② `connect/core/checkpoints.mjs`：`task_checkpoints` 每执行一步落快照（输入/输出/判定），`executeOperations` 无 step_key 时派生 `#<序>:<操作>` 稳定键，重跑自动跳过已完成步；③ `connect/core/retry.mjs` + `scripts/task-retry.mjs`：从断点续跑失败任务（`--list`/`--dry`），待确认任务拒绝续跑、绝不绕过审批；④ 规划器加「一次重规划」：只读工具失手时把失败原文回灌再问一遍，成功就换方案，失败就直说查不到，并记 `replan_requested`；⑤ 报错原文完整化：`errorDetail` 拼 `message + stderr` 截 600 字，槽位 note 从 120 放宽到 900；⑥ `requeueTransient` 把环境抖动（ADB 掉线/超时/网络）的失败槽放回队列重试一次，逻辑错误不重试。 | **356/356** | 新增 `tests/checkpoints.test.mjs` 6 条（判定/整单结论/快照/续跑/待确认拒跑）、`tests/planner.test.mjs` 加 1 条（重规划只发生一次、事件留痕）、`tests/daily.test.mjs` 加 1 条（抖动重排、逻辑错误不动）。 |
| 2026-11-17 01:25 | **M3：失败要变成经验，而不是日志里的噪声** | ① `connect/core/reflect.mjs`：动作失败按「动作 + 类别」聚合进学习账本（adb_offline/timeout/network/auth/unconfirmed/ui_missing，`unconfirmed` 排在 `ui_missing` 前，因为「没读到评论列表」正文也含「没读到」）；② `scripts/backfill-reflections.mjs` 回填历史失败（没有动作名的跳过，不当噪音），实跑后账本 **0 → 10 条**；③ `connect/core/lessons-distill.mjs`：攒够次数的失败蒸馏成一句经验写进 `lessons.json`（`unknown` 类别不写，写不出「下次注意什么」）；④ 夜间任务挂进 `connect/scheduler.mjs` 的 `tick()`：23:30 抽事实候选 + 蒸馏（`housekeeping:<day>`）、03:00 跑学习闭环（`learning:<day>`），`hasRun/markRun` 保证一天一次；⑤ `scripts/housekeeping.mjs` 手动跑同一套（`--dry/--facts-only/--confirm/--day`）。 | **356/356** | 新增 `tests/reflect.test.mjs` 3 条。诚实说明：`memory_facts` 仍是 0——现有 311 条日常记录里没有「喜欢…/记住…」句式，抽取管线已就位但不编数据。 |
| 2026-11-17 01:30 | **M4：把「靠不靠谱」变成四个数字** | 新建 `scripts/eval-set.mjs`：只统计库里真实发生的事，输出成功率（含/不含取消）、平均步数、回执未确认率、人工介入率，并给按操作明细；`--days` 改窗口、`--op` 只看某个动作、`--json` 给机器读。当前基线（近 7 天 29 个任务）：成功率 **34.5%**（含取消）/ **55.6%**（不含取消），平均步数 0（快照从本轮才开始记），人工介入 **100%**（写操作一律过审批，符合设计）。 | **356/356** | 不编数据：没有 `--synthetic` 假跑，宁可给低分也不给假分。 |
| 2026-11-17 14:45 | **三条历史失败复跑 + 定时任务三个真 bug** | ① 三条抖音动作逐个实跑：`douyin.check_interactions` 15.6s 读到 5 条评论（`verified:true`）；`douyin.reply_comments` 236.7s 回了 3 条（平台 `accepted`）；`douyin.hot_comment_round` 161.4s 跑通但两轮各 0 条 → 历史失败是环境/页面状态，不是代码挂了。② 动作只返回字符串 → 判定层永远 `no_result_data`：改成返回 `{ text, data:{ status, count, verified, accepted } }`，并给 `douyin.hot_comment_round` 加 `emptyIsUnconfirmed`（0 条判 `nothing_to_do`，既不算成功也不算失败）。③ 重试槽复用已失败任务导致 `task_not_startable`：`slotAttempt(note)` + `sourceMessageId = slot.id#attempt`，重试才会真的起一条新任务。④ `projectRoot` 被 `<repo>/runtime/connect/runtime/` 这层垃圾目录骗到，把 `runtime/connect` 当项目根 → 所有定时脚本 `Cannot find module .../runtime/connect/scripts/*.mjs`：改成 `connect/core/paths.mjs` 向上找「package.json + scripts/」，并清掉那层残留（已备份到 `/tmp/dfy-backup-2026-11-17/`）。⑤ 顺手把 `runPrepare` 从 `startScheduler → tick → fireSlot` 透传，测试不再真跑写稿脚本（那条用例 43.8s → 21ms）。 | **358/358** | 真机复跑证据在 §10 上一行式的 note 里；19:30 日常图文在修完后由调度器真跑到 `awaiting_publish`。 |
| 2026-11-17 17:45 | **「回回评论」失败排查：手机掉线 + 没活干被误判成失败** | ① 真实原因是 `adb devices` 已经 0 台（手机在 17:00 跑完爆款那轮后掉线），脚本第一步 `deviceSerial()` 就抛「微信发送需要恰好一台已授权设备」——文案还是微信的，看不出是手机没连。② 加 `devicePreflight()`（`connect/actions.mjs`）：动手前 200ms 看一次 adb，0 台就先 `reconnect offline` → `kill-server` → `start-server` 自救一次，仍为 0 才快速失败并给「插上 USB / 打开无线调试」的人话；顺带把 `no_device` 单列成一类学习账本，不和 `unknown` 混。③ 手机回来后重跑发现「回复了 0 条」被判定成 `mismatched(count=0<1)`——其实只剩图片/表情或都回过了，是**没活干**不是干错。动作现在返回 `data.nothingToDo`，`evaluateOutcome` 把这条判断提到 minCount 之前，结论是 `unconfirmed / nothing_to_do`。④ 真机复验：`douyin.reply_comments` → `{"text":"没有可回的评论（只剩图片或表情）","verdict":"unconfirmed","reason":"nothing_to_do"}`。 | **360/360** | 另修：`connect/douyin/daily.mjs` 与动作脚本的 cwd 统一走 `connect/core/paths.mjs`（昨天的 `runtime/connect/runtime` 陷阱）。 |
| 2026-11-17 18:10 | **回复评论带作品上下文（不再只对着评论字面回）** | 以前 `scripts/douyin.mjs:656` 把**评论正文当成作品的 caption** 丢给 `douyinBrain`，模型根本不知道这条评论在哪个作品下面，回出来的是通用客套。现在分三层：①设备层点同行的作品封面进详情页（`DetailActivity`），`parseCommentDetail(nodes)` 读出作者/正文（剥掉结尾时间戳）/类型（有「暂停视频」控件即视频）/评论·赞·收藏·浏览计数/评论链（以每条的「回复 + 赞N,未选中」为边界切段）；②`connect/core/comment-context.mjs` 的 `buildReplyContext()` 整理成 `work+thread` / `work_only` / `comment_only` 三种模式，`contextText()` 压成 ≤600 字提示词片段，抓不到作品时**明写「没读到」**禁止模型编；③`connect/douyin/brain.mjs` 新增 `douyinReplyBrain()`（回复立场提示词，8–40 字，要求同时接住评论与作品两层）。流水线 `runCommentPipeline({context})` 透传给生成器并在轨迹里记 `context` 模式。真机实测：三峡大坝那条视频下「乐小小：[比心][比心]」→ 生成「比心收到啦～不过我这尾巴刚在大坝被水花浇透，你能顺便帮我晒晒不？」（扣住了作品内容）。新增 `--probe-context` 只抓上下文不发送、`--no-context` 可退回旧行为。 | **365/365** | 新增 `tests/comment-context.test.mjs` 5 条（模式判定/截断/提示词/控件树解析/流水线透传）。 |
| 2026-11-17 18:20 | **发布视频（抖音）** | 新增 `scripts/douyin-video.mjs`（`--file/--title/--caption/--tags/--probe/--publish`）：adb push 到 `/sdcard/Movies/DaFeiYu/` → media scanner 取 `content://media/external/video/media/<id>` → 分享 intent（`-t video/mp4`）进 `VideoRecordNewActivity`（剪辑页）→「下一步」到发布页。**踩坑**：描述里带 `#` 会弹出话题候选面板，视觉上盖住「发作品」，但 a11y 里按钮还在，直接按坐标会点到话题列表；实测唯一可靠收尾是「返回退到剪辑页（内容保留）→ 再点下一步」，返回后面板已关。脚本已按这个确定性顺序重写（`settlePublishPage()` + 以「是否离开剪辑页」判定成功）。同时注册为动作 `douyin.publish_video`（R3、`requiresConfirm`）与规划工具：QQ 里说「发这个视频」能走审批 → 执行 → 回执。真机已发：18:17《当你以为你不会再出糗时》，公开可见，落库 `works`（DFY-0004）+ 活动日志。 | **368/368** | 新增 `tests/douyin-video.test.mjs` 3 条（默认不发、「back→下一步→发作品」顺序、video MIME 与 published 判定）。 |
| 2026-11-17 19:20 | **新消息红点哨兵（60 秒一轮）** | 用户要「每分钟看一眼有没有新消息，有红点就进去回」。实现 `device/douyin.mjs` 的 `openFeed()` + `parseMessageBadge()`：首页底部「消息」tab 右上角那个纯数字 TextView 就是红点（抖音没有语义节点，只能按「贴着 tab 的小数字」认，`99+` 记 99，也兼容 desc 里的「消息，3条未读」）；`openFeed` 以「底部 tab 在不在」判断到没到首页——`currentActivity()` 会一直报 `SplashActivity`，看 activity 反而误判。新增常驻哨兵 `scripts/douyin-inbox-watch.mjs`（`--interval 60`、`--once`、`--probe`、`--force-reply`，锁 `runtime/douyin/inbox-watch.lock`）：回首页 → 读红点 → 只有红点才跑 `scripts/douyin.mjs --reply-inbox --generate`（带作品上下文那条流水线）→ 事件写 `agent_events`、状态写 `runtime/douyin/inbox-watch-state.json`。与既有的 `scripts/douyin-watch.mjs`（互动消息守护，30 分钟一轮）分工：哨兵便宜且密，守护重且稀。已装成 LaunchAgent `com.dafeiyu.douyin-inbox-watch`（`scripts/douyin-inbox-watch-install.mjs`，走 adb，不需要屏幕录制权限）。三道护栏：熄屏跳过、前台不是抖音就跳过（除非加 `--launch`，避免每分钟抢屏）、`external_tasks` 有 running 就让路；已经在推荐流上时不再重复点「首页」，免得把主人正在看的视频顶回顶部。真机实测：一度读到红点 1，进流水线回 0 条（都是纯表情/已回），事件与状态文件都落上了。 | **374/374** | 新增 `tests/douyin-badge.test.mjs` 6 条（红点识别、99+、无误报、远处数字不算、desc 兜底、脚本默认值）。 |
| 2026-11-17 19:55 | **前端维护约束（只维护 /live）+ 闸门埋点** | 用户要求「以后改功能必须同步维护实时工作流页面，其它页面先不动」。落地三层：①`AGENTS.md` 写「前端维护约定」——动动作/工具/事件/阶段/定时任务就必须同步 `connect/live/tool-meta.mjs` 与 `connect/live/catalog.mjs`，范围先只限 `/live`；②新增 `tests/live-coverage.test.mjs`（4 条）当自动闸门：动作表里的每个动作必须在 `TOOL_META` 有说明书（且不许留幽灵条目）、`STAGES` 必须与 `connect/core/pipeline.mjs` 的 `PIPELINE` 同源、`EVENT_TYPES` 里每个事件要么在 `EVENT_ROUTE` 有归属要么在新增的 `UNMAPPED_EVENTS` 登记理由、`TOOL_ONLY_META` 不许指向已删工具；③这条闸门当场抓出真漂移并修掉：`approval_requested`/`approval_resolved`/`memory_written`/`skill_run_started`/`skill_run_finished`/`skill_candidate` 六个事件名被 `PIPELINE` 和页面使用却不在 `EVENT_TYPES` 词表里（写进去会抛 `invalid_agent_event_type`），已补齐；顺带给「闸门」段做了真埋点——`connect/tasks.mjs` 的 `proposeTask` 发 `approval_requested`（带 intent/operations），`approvePendingTask` 发 `approval_resolved`（`decision:approved` + `was`），`cancelTask` 发 `approval_resolved`（`decision:cancelled` + reason），页面「闸门」从永远 0 变成真实 `review` 状态。另导出 `EVENT_TYPE_LIST` 供检查使用。 | **378/378** | 新增 `tests/live-coverage.test.mjs` 4 条（能力清单跟动作表、九段与 PIPELINE 同源、事件映射不漏、只读工具不指向已删工具）。 |
| 2026-11-17 20:30 | **工具清单改成卡片** | 用户要求「工具清单 UI 改成卡片，每个卡片对应一个工具」。`connect/live/live.js` 的 `renderTools` 由「一行一个工具」改成渲一张 `<article class="card">`：标题 + 等级徽章（全自动/AI 介入/人工审核/未实现）+ 两行介绍 + 动作名（等宽字体）+ 近 7 天「成功/失败」+ 底部成功率细条；卡片可点、可 Tab 聚焦、Enter/Space 展开右侧详情（走原来的 `openTool`），`aria-label` 念出「标题：等级，近 7 天成功 N 次、失败 M 次」。`connect/live/live.css` 新增 `.cards`（`repeat(auto-fill, minmax(272px,1fr))`，720px 以下单列）与 `.card` 系列样式，删掉旧的 `.toolGrid` 四列行模板。截图 `docs/assets/live-tools.png`。 | **378/378** | 无新增用例（`/api/live/tools` 的字段断言未变，改的是渲染层）。 |
| 2026-11-17 23:20 | **平面数据流页（GET /flow）+ 双向联动 + 工具跑通手册** | 用户要「3D 保留，另做一套省资源的平面流程图：看得到数据从哪走到哪、被响应时有颜色动效」，并要求与实时工作流双向联动、以及给出「逐个跑通工具」的清晰流程。落地：①新建 `connect/flow/`（`layout.mjs` 布局真源、`flow.js` Canvas 渲染、`index.html`/`flow.css`）：19 个节点按「入口渠道 → 事件流 → 路由 → 任务 → 闸门 → 执行 → 认知」七列铺开，连线复用 `connect/arch/graph.mjs` 的 24 条边与 12 条事件路径；事件到达时沿路径跑发光脉冲（头 + 10 节拖尾 + 节点涟漪 + 计数），**没有脉冲时不跑 rAF**，静止时 CPU/GPU≈0；`?nostream=1` 出静态帧（无头截图用），`?node=<id>` / `?stage=<id>` 直接选中节点。②双向联动：`/live` 详情栏底部加「在数据流图里看这一段 →」（即 `/flow/?node=`，映射表 `STAGE_NODE` 单一真源），`/flow` 侧栏给「在实时工作流里看这一段 →」（即 `/live/?stage=`），`/live` 支持 `?stage=` 直接按段筛选事件。③导航：`connect/shell/nav.js` 加「数据流」入口（3D 架构保留）。④新测试 `tests/flow.test.mjs` 4 条（布局与 3D 图/九段自洽、双向映射无落空、只引用站内资源且跨页链接存在、`/flow` 与 `/live` 都能被 connect 服务出来且挡住目录穿越）。⑤`docs/TOOL-RUNBOOK.md`：给出「契约 → 预检 → 干跑 → 真跑 → 判定」五步法与 22 个工具的当前状态表（只标真跑过的 5 个 ✅，其余 ⏳，两个已下线 ⛔）。⑥顺手把抖音哨兵的零红点心跳改成「只在红点清零时记一笔」，并清掉历史 223 条刷屏事件。 | **382/382** | 新增 `tests/flow.test.mjs` 4 条；`tests/shell.test.mjs` 的入口断言加 `/flow/`。 |
| 2026-11-17 23:30 | **工具跑通第 1 轮（6 个只读工具）+ 两处 cwd 真 bug** | 按 `docs/TOOL-RUNBOOK.md` 五步法开跑只读工具，逐个真调并记证据：`works.list` 13ms 读到 2 条作品、`comments.list` 0ms（空库属正常）、`capability.read`（`id=publishing`）读到整张能力卡、`weather.get` 2.8s 石家庄多云 8°C、`device.page` 0.1s 读当前前台、`douyin.hotspot` 55.7s 读到「程序员 / AI 编程 / 打工人」三条可跟。跑通过程中挖出两个同源真 bug：①`connect/qq/tools.mjs` 的 `check_interactions`/`hotspot` 用 `cwd: ctx.root` 起子进程，而 `ctx.root` 是服务的 `runtime/connect`，脚本在仓库根 → 一直 `Cannot find module .../runtime/connect/scripts/douyin.mjs`（**「看今天有什么热点」从来没真跑成过**）；②`connect/memory/capabilities.mjs:388` 的 `resolve(root, file)` 同样把服务目录当仓库根 → `capability.code` 永远 `file_missing`。修法：`connect/qq/tools.mjs` 导出 `toolCwd(ctx) = projectRoot(ctx.root)` 并替换两处 `cwd`；`readCapabilityCode` 改用 `projectRoot(root)` 做基准（目录逃逸检查同步改到它上面）。③第三个真 bug：`connect/actions.mjs:181` 的 `douyin.browse` 裸引用 `loadTargets`（从没 import），一调就 `ReferenceError: loadTargets is not defined` → 改成 `await import('./targets.mjs')` + `loadTargets(projectRoot(root))`，修完真跑 50.6s 看 2 条视频（`open_feed` + 2×`watch` 全 true，`verified:true`）。④第四个真 bug：`connect/actions.mjs` 用着 `homeOf(base)`，但把 `homeOf` 挪进 `connect/core/paths.mjs` 时只补了 `projectRoot` 的 import → `academy.study` / `academy.weekly` 一调就 `ReferenceError: homeOf is not defined`；补 import 后真跑通（6.5s 学一课 62 分、6.9s 写出本周成长日记）。⑤本轮累计真跑 9 个工具：`works.list`/`comments.list`/`capability.read`(+`capability.code`)/`weather.get`/`device.page`/`douyin.hotspot`/`douyin.browse`/`douyin.draft`/`academy.study`/`academy.weekly`。 | **387/387** | 新增 `tests/tools-cwd.test.mjs` 5 条（cwd 必须落仓库根、禁止再出现写死的 `cwd: ctx.root`、`capability.code` 用服务目录当 root 也能读到文件、`douyin.browse` 必须先把 `loadTargets` 取进来）；`docs/TOOL-RUNBOOK.md` 状态表更新 7 行并新增「跑通过程中发现并修掉的真 bug」一节。
| 2026-11-17 23:40 | 工具跑通第 2 轮：给三个「一按就响对方手机」的工具补只读探针（`qq-call --probe` / `wechat-call --probe`），跑通 `qq.hangup` 与 `douyin.publish_draft` 的负路径，剩下 `douyin.publish` 等主人点头 | `scripts/qq-call.mjs`、`scripts/wechat-call.mjs` 各加 `--probe`（拨号/切声卡之前返回窗口、联系人、按钮坐标）；`qq.hangup` 无通话时返回「没有找到进行中的通话窗口」；`douyin-confirm` 无草稿返回 `pending_post_missing`；新增 `tests/tool-probe.test.mjs` 2 条（探针必须早于拨号与 `runSound`） | 389/389 |
| 2026-11-17 23:55 | 工具跑通第 2 轮收尾：工具卡显示「最近一次真跑 + 判定」；根因同族的路径 bug 全部归一（9 处 `join(root,'runtime')` 模块改用 `runtimeDir()`，`projectRoot` 兜底改为「找不到就原样返回」）；`works.list` 之前读的是假库（`runtime/connect/runtime/douyin/douyin.db`，只有 2 条）→ 修后读到真库 15 条作品；新增 `tests/tools-cwd.test.mjs` 用例 | 全量 **391/391**，0 fail |
| 2026-11-18 00:00 | 工具跑通第 3 轮：`task_checkpoints` 增 `reason` 列（迁移 v3 + `ensureColumn`）→ 判定理由随快照落库；`/live` 工具卡显示「最近 · 判定（理由）」；`openDouyinDb`/`openHub` 等 9 处路径归一到 `runtimeDir()` 后 `works.list` 读到真库 15 条；新增只读工具 `action` 标识与 `lastVerdict` 回填；文档补「只读工具 ≠ 动作」口径 | 全量 **392/392**，0 fail |
| 2026-11-18 00:10 | 工具跑通第 4 轮：`/flow` 接 `/api/flow/summary`（阶段最近事件 + 动作最近判定 + 顶栏计数，公开只读、不含 payload）；`actions` 节点副标题改为「17 动作 · 23:43 已确认」；`douyin.reply_comments` 走完整判定链真跑得 `unconfirmed / nothing_to_do`，`douyin.check_interactions` 得 `confirmed / ok`；新增 `tests/flow.test.mjs` 汇总用例 | 全量 **393/393**，0 fail |
| 2026-11-18 00:25 | 工具跑通第 5 轮：**修掉 `/home` 整页只渲骨架的回归**——`connect/home/data.mjs` 的 `import { PIPELINE } from '../core/pipeline.mjs'` 在浏览器里被令牌闸门挡成 401，整个模块图不加载；改为 `connect/server.mjs` 在闸门前放行 `/core/pipeline.mjs`（只这一个纯数据文件）。同时修掉 `capabilityNode()` 里 `const summary = el('summary',…)` 遮住模块级汇总数据 → 改名 `flowSnapshot`。现在主页每张能力卡右侧直接显示「11/17 23:47 未确认（没活干）」。`douyin.hot_comment_round` 走完整判定链得 `unconfirmed / nothing_to_do` | 全量 **394/394**，0 fail（新增 `tests/home.test.mjs` 第 4 条：模块图可加载 + 变量不遮罩） |
| 2026-11-18 00:40 | 工具跑通第 6 轮：批量真跑 6 个动作并落判定——`douyin.browse`(225.9s)/`douyin.hotspot`(73.8s)/`douyin.draft`(72.4s)/`academy.study`(3.0s)/`academy.weekly`(2.2s) 全部 `confirmed/ok`；`douyin.comment_latest` `failed`（搜索结果页需先进「视频」页签再点封面，已改；评论面板识别仍待修，标记为待修、不在日程）。`/api/flow/summary` 增 `today{events,actions,fails,awaiting}`，`/home` 四格不再需要令牌；`reasonText` 把 `Command failed:` 长串折叠成「打不开视频 / 评论面板没开 / 手机没连上 / 脚本报错」 | 全量 **395/395**，0 fail（新增 `tests/flow.test.mjs`「今天四个数」用例） |
| 2026-11-18 00:55 | 按手册「用不了的从动作表下线」：移除 `douyin.like_comments`（适配层没有可验证点赞）与 `douyin.prepare`（被 draft→publish_draft 取代）——`connect/actions.mjs`、`connect/core/capability-map.mjs`（保留 `offline: true` 留档）、`connect/live/tool-meta.mjs`、`connect/skills/defs.mjs` 同步清理；`toolList` 过滤 offline 行，`skills` 计数改取 `SKILL_DEFS.length`。计数 动作 18→16、工具 12、技能 12→11 | 全量 **395/395**，0 fail（更新 5 处基线断言：capability-map 16、home 16 张说明书、live actions>=16、skills 11/43 步、registry 11） |
| 2026-11-18 01:05 | 判定结论铺到 3D 页与看板：`connect/arch/main.js` 拉 `/api/flow/summary`，节点详情补「最近一次事件（近 24h N 条）」「近 24h 判定：已确认/未确认/失败」「最近一条：动作 时间 判定」，并支持 `?node=` 深链；`connect/board/modules/home.mjs` 新增 `reasonOf(note)`，今日日程的失败原因由「Command failed: …」折叠成「手机没连上 / 打不开视频 / 脚本报错（详情看 /live）」等一句人话 | 全量 **396/396**，0 fail（新增 `tests/shell.test.mjs` 的「看板日程原因说人话」用例） |
| 2026-11-18 01:20 | `/live` 工具清单加覆盖度小条：`toolList` 返回 `coverage{total,confirmed,unconfirmed,failed,untested}`，页面渲成绿/黄/红三段条 + 「有证据 9/16 · 没跑过 7」；`douyin.comment_latest` 的自动化链路继续收敛（视频页签、点封面、`isWorkDetailOpen` 界面判定、整页重搜一次、评论面板必须展开到带「发送」再输入），`REASON_LABEL` 补 `missing_count`/`command_failed` 两条人话 | 全量 **397/397**，0 fail（新增覆盖度用例） |
| 2026-11-18 01:40 | 第 10 轮：①`scripts/douyin.mjs` 的 `--auto-comment` 把「拟稿（LLM 十几秒）」挪到进视频详情之前——之前模型调用期间详情页被系统回收，回来就在搜索页上找发送键；②`postComment` 重写为「先找 focused 的 EditText，必要时先点评论按钮唤面板，展开再输入」，发送判定同时接受「编辑器关闭」与「评论出现在列表」；③修掉一次自己造成的 `scripts/douyin.mjs` 整段复制（669 行重复，`const match` 重复声明），并新增 `tests/script-integrity.test.mjs` 守住这类错误（`node --check` + 关键分支只许出现一次） | 全量 **399/399**，0 fail；`comment_latest` 仍标 🟡（人工跑通一次，自动路径偶发 `comment_bar_missing`） |
| 2026-11-18 01:55 | 第 11 轮：`douyin.comment_latest` 从 🟡 转 **✅ confirmed**——根因是「拟稿要十几秒、期间视频详情页被系统回收」，改为**先拟稿过闸门、再动手机**；`postComment` 先找 focused 的 EditText 再键入、发送键按文本取最靠下（a11y 里 clickable=false）；被 90 秒限流时输出 `RESULT_JSON {blocked}`，`verify.mjs` 记 `unconfirmed/blocked:<level>` 而不是「没结果」；失败现场落 `runtime/douyin/failures/`（截图 + 控件树）。覆盖度：有证据 9/16（确认 7 · 未确认 2） | 全量 **399/399**，0 fail |
| 2026-11-18 02:10 | 第 12 轮：让「没活干 / 被限流」也有可复核的证据——`reply_comments` 与 `hot_comment_round` 的返回值补 `scanned` 与 `breakdown{no_content,already_replied,nothing_new}`；`verify.mjs` 新增 `data.blocked` 分支（→ `unconfirmed/blocked:<原因>`），并把 `nothing_to_do` 升级成 `nothing_to_do(扫了几条):原因×次数`；`/live` 与 `/home` 的 `reasonText` 会把这串翻成「没活干 · 扫了 5 条 · 只有表情 3 / 已回过 2」；`docs/TOOL-RUNBOOK.md` 新增「判定理由的词汇表」 | 全量 **400/400**，0 fail（新增限流/没活干/真失败三条断言） |
| 2026-11-18 02:25 | 第 13 轮：`/flow` 顶栏加「工具覆盖」——`connect/flow/summary.mjs` 新增 `coverageSummary(tools)`（口径与 `/live` 的 `toolList.coverage` 一致：`confirmed / unconfirmed / failed / untested`，总数取 `ACTIONS` 里未 `offline` 的），`flowSummary()` 返回 `coverage`，`connect/flow/index.html` 加 `#sCoverage` + `#covBar`，`flow.js` 渲「7/16 已确认」+ 三色小条 | 全量 **401/401**，0 fail（新增覆盖度自洽用例：四类相加等于动作数） |
| 2026-11-18 02:40 | 第 14 轮：工具详情新增「判定历史」——`connect/live/api.mjs` 的 `toolList` 为每个动作聚合最近 5 条 `task_checkpoints`（`history:[{verdict,reason,at}]`，顺带修掉「同一动作只留一条」的早退 bug）；`connect/live/live.js` 的 `openTool` 渲染成时间线（未确认黄/对不上红/已确认绿），点开着得到的「被限流 / 只成 0 条 / 没活干」现在就并排可对比 | 全量 **402/402**，0 fail（新增历史用例：最多 5 条、倒序、理由原样） |
| 2026-11-18 03:00 | 第 15 轮：活跃度与历史一起上页面——①`connect/live/api.mjs` 的 `toolList` 增 `weekRuns`（近 7 天 `task_checkpoints` 分组计数），工具卡「最近 00:51 · 未确认（没活干） · 本周 9 次」；②`connect/flow/summary.mjs` 的 `verdictSummary` 给每个动作带 `history`（最多 3 条，注意 `{...entry}` 避免与 `tools[op]` 互相引用导致 JSON 循环），`connect/flow/flow.js` 选中「动作/设备」节点时列出最近 5 条判定（左色条：绿确认/黄未确认/红失败），并修掉「汇总后到时节点 facts 不会重建」的问题（`loadSummary` 末尾 `selectNode(selected)`） | 全量 **402/402**，0 fail（新增：flow 汇总里的判定历史 ≤3 条且首条为最新） |
| 2026-11-18 03:15 | 第 16 轮：①首页能力卡加「本周 N 次」（`connect/flow/summary.mjs` 的 `verdictSummary(db,{now})` 顺带查近 7 天 `task_checkpoints` 分组计数，挂在 `tools[op].weekRuns`；`connect/home/home.js` 渲进 `capLast`）；②「没活干」补量级——`connect/live/api.mjs` 把一周内 `nothing_to_do(n):原因×次数` 的 n 与分布加总成 `weekScanned`/`weekBreakdown`，工具详情新增「本周「没活干」的量」一节（「扫了 5 条，只有表情 4 条 · 已回过 1 条。这不是失败，是确实没有可处理的。」） | 全量 **403/403**，0 fail（新增：两次 `nothing_to_do` 的扫描数会相加、分布会合并） |
| 2026-11-18 03:30 | 第 17 轮：①判定历史可点——`connect/live/api.mjs` 与 `connect/flow/summary.mjs` 的查询都带上 `task_id`，写进 `history[].taskId`；`connect/live/live.js` 把有 `taskId` 的那几行渲成 `<a href="?task=…&tab=events">`（CSS `.step.link` 保持步骤外观 + hover 高亮），点一下直接回到那次任务看输入输出；②`/flow` 动作节点的判定行补「本周 N 次」 | 全量 **404/404**，0 fail（新增：判定历史必须带 `task_id`） |
| 2026-11-18 03:45 | 第 18 轮：给 7 个「有真实副作用、还没跑过」的动作补**前置检查清单**——`connect/live/tool-meta.mjs` 的 `TOOL_META` 每条加 `preflight: [..]`（屏幕录制权限 / 声卡占用 / 是否在通话中 / 草稿状态 / 视频体积），`connect/live/api.mjs` 透出 `preflight`，`connect/live/live.js` 在工具详情渲「跑之前要确认」一节；`docs/TOOL-RUNBOOK.md` 同步一张表 | 全量 **405/405**，0 fail（新增：7 个动作都必须有 ≥2 条清单且每条 ≥8 字） |
| 2026-11-18 04:00 | 第 19 轮：前置条件能机器核验了——新建 `connect/live/preflight.mjs`（`systemProbes` 只读探针：`device` 数 adb 台数、`wechat` 查进程、`qqWindow`/`qqCallWindow` 读 macui 窗口、`draft` 扫 `pending.json` 与 `drafts/*.json`；`probePreflight({root,probes})` 可注入假探针，返回 `{action,checks:[{key,ok,detail}],ready}`）；`connect/server.mjs` 加 `GET /api/live/preflight`（令牌 + 20s 缓存）；`connect/live/live.js` 工具详情加「检查现在能不能跑」按钮 + `?preflight=1` 自动跑，逐条 ✅/❌ 带原始证据；顺带修掉 `?tool=` 深链按 `tool` 字段误匹配的问题（`douyin.draft` 的 tool 也叫 `douyin.publish`） | 全量 **406/406**，0 fail（新增：七个授权动作都有核验结果、微信没启动/没在通话必须 NOT ready、探测 detail 原样透出） |
| 2026-11-18 04:15 | 第 20 轮：①`/live` 顶栏加「授权项就绪 6/7」角标（`connect/live/index.html` 的 `#readyPill`，`live.js` 的 `paintReady()` 开机拉一次 `/api/live/preflight`，`title` 里逐项写出未就绪原因；接口有 20s 缓存，拿不到就静默隐藏）；②发布类工具在详情里画分步流程——`connect/live/tool-meta.mjs` 给 `douyin.publish_draft`（写草稿→人工二审→发作品）与 `douyin.publish`（生成→存草稿→二审→发布→核验）加 `steps`，`connect/live/api.mjs` 透出、`connect/live/live.js` 渲成有序列表「这条流程分几步」 | 全量 **407/407**，0 fail（新增：发布类工具必须有 ≥3 步且含「草稿」「二审/同意」） |
| 2026-11-18 04:30 | 第 21 轮：顶栏「授权项就绪 X/Y」变成可点——`connect/live/live.js` 的 `paintReady()` 把结果存进 `state.preflight`，点角标（或 `?ready=1`）调 `openReady()` 在右侧列出 7 项，每项 ✅/❌ + 原始证据，未就绪的行直接写「缺：当前没有进行中的通话」；「放行方式」一节说明机器能判的已判、剩下的由主人决定 | 全量 **408/408**，0 fail（新增：清单必须可点开、缺的条件必须写在页面上、结果必须缓存复用） |
| 2026-11-18 04:45 | 第 22 轮：核验留痕——`connect/agent-events.mjs` 的 `EVENT_TYPES` 加 `preflight_checked`；`connect/server.mjs` 在 `/api/live/preflight` 算出结果后写 `agent_events`（`channel=system`、`actor=preflight`、payload `{ready,total,missing}`、`dedupeKey` 按 10 分钟桶 + 就绪数，避免刷页面灌满事件流），`connect/core/pipeline.mjs` 的 `gate` 段事件加它、`connect/live/catalog.mjs` 的 `EVENT_ROUTE` 映射到 `gate/review` | 全量 **409/409**，0 fail（新增：一次核验只记一条、10 分钟内重复点击不再记、payload 带 missing 列表） |
| 2026-11-18 05:00 | 第 23 轮：闸门节点显示就绪度——`connect/flow/summary.mjs` 的 `flowSummary()` 新增 `readiness`（取最新一条 `preflight_checked` 的 `{ready,total,missing,at}`，没核验过就是 null，不编数字）；`connect/flow/flow.js` 在「执行闸门」节点副标题写「就绪 6/7（缺 qq.hangup）」，侧栏补「最近核验 01:09 · 6/7 就绪（缺 qq.hangup）」 | 全量 **410/410**，0 fail（新增：没核验时 readiness 必须是 null；核验后 missing 原样带出） |
| 2026-11-18 05:15 | 第 24 轮：定时任务行标出「这个动作现在能不能跑」——新建 `connect/live/readiness.mjs`（`readinessOf`/`annotateRows`/`readinessText`，没核验过返回 `null` 不冒充）；`connect/live/preflight.mjs` 把动作分两组（`authorized` 7 个要授权的 + `device` 12 个手机类，`groupOf()` 查询），顶栏仍只数授权项；`connect/live/live.js` 的 `renderSlots` 用 `annotateRows(slots, state.preflight)` 贴徽标（能跑 / 还不行 + 缺什么），核验结果回来后重画一遍；新增 `?day=YYYY-MM-DD` 看某一天的定时任务 | 全量 **411/411**，0 fail（新增：两组划分、没核验返回 null、页面必须用统一口径贴状态） |
| 2026-11-18 05:30 | 第 25 轮：本周失败归类——新建 `connect/live/failures.mjs`（`reasonBucket` 把 `task_checkpoints.reason` 归成 11 类：没活干/被闸门挡/缺字段/数量不够/手机没连上/界面没开到位/超时/网络/权限/脚本报错/走错通道；`summarizeFailures` 按次数倒序并带每类涉及的 action）；`connect/live/api.mjs` 的 `liveSnapshot` 增 `failures`；`connect/live/live.js` 在工具页签覆盖度条下渲「本周问题 N 次」+ 原因 chips（`title` 给 action 明细） | 全量 **412/412**，0 fail（新增：分类正确、走错通道不计入问题总数、早期没写 reason 单独标出） |
| 2026-11-18 05:45 | 第 26 轮：`douyin.comment_latest` 跑通并加固——①`device/douyin.mjs` 新增 `onSearchResults()`（activity 必须是 `SearchResultActivity` + 有「综合/视频/用户/商品」页签），`scripts/douyin.mjs` 的 auto-comment 在搜索后校验、失败走「重启抖音→回首页→重搜」整页恢复，并抛 `not_on_search:<activity>`；②`isWorkDetailOpen()` 放宽（评论输入口 + 互动条，或「全屏观看」且不在搜索页），修掉「已经在详情页却判否」；③`postComment()` 两次都失败时自动落现场（截图 + 控件树到 `runtime/douyin/failures/`），`openCommentsSmart` 也移进 try；④新增「同一视频不重复评论」：`state.recentVideos` + `blocked: duplicate_video`，`--allow-repeat` 才强制；⑤新增干跑开关 `--land`（只验落点）与 `--skip-gate`（只在人工验证时绕过自建限速） | 全量 **414/414**，0 fail（新增：搜索结果页校验、失败落现场、同视频去重） |
| 2026-11-18 06:00 | 第 27 轮：评论频次上限可配置 + 额度上页面——`connect/douyin/compliance.mjs` 新增 `loadLimits(root)`（读 `runtime/douyin/limits.json`，只覆盖 `maxLength/dailyComments/hourlyComments/minIntervalMs/duplicateWindowMs`，文件不存在用默认）与 `quotaOf(history,{now,limits})`（今天/本小时用量、剩余、下一条要等多久）；`scripts/douyin.mjs` 的 `gate()` 改用 `loadLimits`；新建 `connect/live/quota.mjs` 的 `commentQuota(root)`，`connect/live/api.mjs` 的 `liveSnapshot(db,now,extra)` 支持注入额外字段（也支持函数现算），`connect/server.mjs` 的 snapshot/SSE 都带上；`/live` 顶栏新增「评论额度 X/Y（本小时）」（悬停给今天用量与等待时间，0 时黄色） | 全量 **415/415**，0 fail（新增：默认值、配置文件覆盖、额度计算与等待时间） |
| 2026-11-18 06:15 | 第 28 轮：额度用完的槽直接跳过——`connect/scheduler.mjs` 新增 `COMMENT_ACTIONS`（`douyin.reply_comments`/`douyin.hot_comment_round`/`douyin.comment_latest`）与纯函数 `quotaSkip(action, quota)`；`fireSlot()` 开头先算 `commentQuota(root)`，额度为 0 就把槽标 `skipped` + note `quota_exhausted:<used>/<cap>` 并记一条 `action_finished(status:skipped)`，不再去跑必然失败的 4 分钟；`/live` 与看板把 `quota_exhausted` 翻成「评论额度用完（5/5），先不发」 | 全量 **416/416**，0 fail（新增：回复类动作受额度约束、有额度照常跑、非评论动作不受影响、没有额度信息时不误判） |
| 2026-11-18 06:30 | 第 29 轮：「本周 N 次」拆出「额度跳过」——`connect/live/api.mjs` 的 `toolList` 增 `weekQuotaSkips`（数 `plan_slots.note LIKE 'quota_exhausted%'` 的近 7 天条数，因为额度跳过的槽不写 checkpoint，只落在计划表里）；`connect/live/live.js` 卡片改成「本周 6 次 + 额度跳过 3 次」，不再把跳过算成跑过 | 全量 **417/417**，0 fail（新增：两次额度跳过要数出来、卡片必须写「额度跳过 N 次」） |
| 2026-11-18 06:45 | 第 30 轮：定时槽「为什么跳过」说人话——`connect/live/live.js` 新增 `skipReason(note,status)`，把 `quota_exhausted:a/b`/`skipped:pending_task`/`manual_run_ok`/`retry:`/`nothing_to_do`/`blocked:` 翻成「额度用完 / 已有待审草稿 / 已人工跑过 / 抖动后重试 / 没活干 / 被闸门挡住」六个短标签（`title` 给完整解释），定时任务行直接显示，不必去读 note 原文 | 全量 **418/418**，0 fail（新增：六个短标签齐全、`skipReason` 存在） |
| 2026-11-18 07:00 | 第 31 轮：判定词汇表收成一份——新建 `connect/live/reason-text.mjs`（`VERDICT_LABEL` / `REASON_LABEL` / `commandLabel` / `reasonText` / `shortClock`），`/live`、`/home`、`/flow` 三处删掉各自的副本改为 import（同一原因不再在四个页面写成四种句子），并补上 `blocked:` 与 `missing_count` 的说法 | 全量 **419/419**，0 fail（新增：三处都必须 import 共享词汇表、不许再自建 `VERDICT_LABEL`、关键说法齐全） |
| 2026-11-18 07:10 | 第 31 轮收尾：`connect/live/catalog.mjs` 的 `digestOf()` 给授权项核验开特例——payload 里有 `ready`/`total` 时直接渲染「6/7 就绪（缺 qq.hangup）」，不再把三个键名搬进事件流 | 全量 **420/420**，0 fail（新增：`6/7 就绪（缺 qq.hangup）` 与 `7/7 就绪` 两种形态） |
| 2026-11-18 07:25 | 第 32 轮：放行清单写成可执行文档——`docs/TOOL-RUNBOOK.md` 新增「放行清单：7 个「真实副作用」动作」，每个给最短命令、预期输出、出事怎么收（`qq.call`/`qq.call_mom`/`wechat.call`/`qq.hangup`/`douyin.publish`/`douyin.publish_draft`/`douyin.publish_video`），并写清「一次只放一个、跑前核验、跑完看三处、判定不是 confirmed 先看 reason」的统一姿势 | 全量 **421/421**，0 fail（新增：七个动作都有小节、至少 7 段命令、每段有预期、有副作用的写清收尾） |
| 2026-11-18 07:40 | 第 33 轮：工具详情给出「自己手动跑」的命令——`connect/live/tool-meta.mjs` 每条动作新增 `command`（16 条，带参的命令如 `node scripts/qq-call.mjs --keep --contact 七海`），`connect/live/api.mjs` 透出、`connect/live/live.js` 渲成可点击复制的 `<code class="cmd">`（`navigator.clipboard`）；顺手修掉事件流里 `preflight_checked` 数成「15/16」的问题（它把手机类 12 个动作也算进去了，改成只记授权那 7 个 → 6/7） | 全量 **422/422**，0 fail（新增：16 条动作都有可执行命令、有副作用的必须带参数、详情必须能复制） |
| 2026-11-18 07:55 | 第 34 轮：手动跑完能在详情里刷新——`connect/live/live.js` 新增 `refreshTool(action)`（拉 `/api/live/tools`、只重开这一条详情、同时重画卡片），工具详情底部加「刚跑完？」+「刷新「最近一次」」按钮，手动验证不再需要整页重载 | 全量 **423/423**，0 fail（新增：刷新函数存在、按钮文案存在、必须走工具清单接口、刷新不许 `location.reload`） |
| 2026-11-18 08:10 | 第 35 轮：`/live` 加第五个页签「本轮报告」——`connect/live/live.js` 的 `renderReport()` 把散在四处的东西收成一页：跑通覆盖度（7/16 + 三色条）、还没跑过的动作（可点开看说明书）、授权项就绪、本周问题 Top4、评论额度；顺手修掉一个口径问题——`connect/live/api.mjs` 给只读工具加 `readOnly: true`，报告里不再把「查天气/看作品/读能力卡」这类不产生判定的工具算成「没跑过」（待办从 11 个变成真正的 7 个） | 全量 **424/424**，0 fail（新增：report 页签存在、只读工具不进口径） |
| 2026-11-18 08:25 | 第 36 轮：进度落到仓库里——新建 `scripts/runbook-progress.mjs`（读 `toolList` + `commentQuota`，生成 Markdown 表格并写进 `docs/TOOL-RUNBOOK.md` 的 `<!-- progress:start/end -->` 之间；`--dry` 只打印），`package.json` 加 `runbook:progress` 别名；表格只列自主行动作（只读工具单独一句说明），时间用本地时区 | 全量 **425/425**，0 fail（新增：进度块存在、X/16 口径、只读工具不进口径、7 个待跑动作在表里） |
| 2026-11-18 08:40 | 第 37 轮：跑完怎么算成功——新建 `connect/live/expect-after.mjs`（7 个有副作用动作的「应该看到什么」，纯数据、浏览器可用）与 `connect/live/verify-after.mjs`（`recentWorks` 查作品表、`recentCallEnds` 查 `call_ended`、`verifyAfter` 出 `pass/fail/unknown` 三态；通话没接通记 unknown 不记 fail）；`GET /api/live/verify?action=`；`toolList` 每条带 `expect`；`/live` 工具详情新增「跑完应该看到什么」+「检查跑完的结果」按钮（`?verified=1` 自动跑） | 全量 **431/431**，0 fail（新增 6 条：验收句子覆盖与长度、发布类新增才 pass、草稿清空才 pass、通话缺事件算 unknown、无副作用返回 unknown、清单与接口都暴露） |
| 2026-11-18 09:00 | 第 38 轮：只读工具也有证据了 + 诚实降级热点——新建 `scripts/tool-once.mjs`（真跑一次只读工具，把输出摘要与 verdict 写进 `task_checkpoints`，`--all/--list`；只读工具以「拿到内容」为 confirmed，reason 写 `ok_text`，不伪装成有回执）；实跑 7 个只读工具 → 6 个 confirmed、`douyin.hotspot` failed；查清 `search_unreachable` 根因（搜索页第一条视频自动全屏、`parseSearchHotVideos` 依赖「标题+日期」锚点），已加 `waitForHome`、全屏时退一层再读、解析器允许无日期，但**仍未稳定通过**，如实记为「观察中」并把覆盖度从 7/16 降为 6/16 | 全量 **431/431**，0 fail |
| 2026-11-18 09:20 | 第 39 轮：`douyin.hotspot` 按手册下线——抖音搜索页已改成「视频流」形态（结果以全屏视频+竖向滑动呈现，按返回是换视频不是回列表），原解析器依赖「标题+日期」锚点，本轮试了 `waitForHome`／全屏时退一层／允许无日期三种补救仍未稳定通过；从 `connect/actions.mjs` 移除动作，`connect/core/capability-map.mjs` 标 `offline:true/status:disabled` 留档，`tool-meta`／只读工具表／preflight 设备清单／`douyin.hotspot` 技能一并移除 → 动作 16→15、工具 17→16、技能 11→10、步骤 43→40；`mapReport()` 的工具/技能统计也改成只看非 offline 行 | 全量 **431/431**，0 fail（7 个基线断言随之更新：capability-map 15/16/10、home 15+5、skill-assertions 10/40、skill-ledger 10、learning-policy ≥9、flow 覆盖度 fixture 换成 `douyin.draft`） |
| 2026-11-18 09:35 | 第 40 轮：下线的动作在页面上有交代——新建 `connect/live/retired.mjs`（`RETIRED_ACTIONS` 记 `action/label/retiredAt/reason/replacedBy`，`retiredOf()` 反查），`toolList` 返回 `retired`，`/live` 工具页签底部渲「已下线 3 个：…」（chip 悬停给原因与替代品）；测试同时守住「下线了就不许还在 ACTIONS/说明书里」 | 全量 **432/432**，0 fail（新增 1 条：留档字段齐全、与动作表/说明书不冲突、接口与页面都暴露） |
| 2026-11-18 09:50 | 第 41 轮：7 个待跑动作各一张「第一次真跑」操作单——新建 `docs/FIRST-RUN.md`（每条：前置核验看哪一项 → 可直接复制的命令 → 跑完应该看到什么 → 三种收场怎么办），`docs/TOOL-RUNBOOK.md` 顶部指向它；测试守住「每个有副作用的动作都有一张单子、都有『跑完应该看到』、引用的脚本真实存在」 | 全量 **433/433**，0 fail |
| 2026-11-18 10:10 | 第 42 轮：「本轮报告」首卡「下一步该干什么」——新建 `connect/live/next-steps.mjs`（`isExpectedReason()` 把 `nothing_to_do`/`awaiting_external_event`/`blocked:` 判为正常；`nextSteps()` 按 失败(1)→可疑未确认(2)→待放行(3)→最高频问题(4)→已下线(5) 排序，每步带可点链接：工具详情 / `docs/FIRST-RUN.md`）；修掉 `(top.ops ?? []).slice` 把页面打白的形状 bug（`summarizeFailures().buckets[].ops` 是对象不是数组），并让测试 fixture 用真实 `summarizeFailures()` 输出 + 明确排除「早期记录没写原因 / 走错通道」这类历史噪音 | 全量 **438/438**，0 fail（新增 5 条，其中 1 条专门守 `ops` 形状） |
| 2026-11-18 10:25 | 第 43 轮：首屏一行「下一步」——`connect/flow/summary.mjs` 的 `flowSummary()` 增 `failures`（近 7 天按原因归类，公开接口只给计数与动作名）；`connect/home/index.html` 加 `#nextLine`，`connect/home/home.js` 复用 `/live/next-steps.mjs` 的 `nextSteps()` 只显示最靠前那件事（含「看操作单 →」链接）；顺手修「只读工具被算成没跑过」（用 `TOOL_ONLY_META` 判只读） | 全量 **439/439**，0 fail |
| 2026-11-18 10:40 | 第 44 轮：/flow 的闸门与执行节点也挂「下一步」——`connect/flow/flow.js` 的 `paintPanelExtras()` 在这两个节点的面板里加一行「N 个动作待放行 / M 个失败要先修」+「看报告」「操作单」两个链接（只给这两个节点，不把每个节点都塞满）；三处（主页首屏 / `/live` 报告页签 / `/flow` 面板）现在引用同一份 `nextSteps()` 与同一份 `docs/FIRST-RUN.md` | 全量 **440/440**，0 fail（新增 1 条：面板要有这一行、链接指向报告与操作单、只对 gate/actions 生效） |
| 2026-11-18 11:00 | 第 45 轮：「在页面上真的跑一次」——新建 `connect/live/run-policy.mjs`（`loadRunAllowlist(root)` 读 `runtime/connect/live-run.json` 的 `allowed`；`canRunFromUi(action,{allowed,ready})` → `not_allowed`/`unknown_action`/`preflight_not_ready`/`ok`），`POST /api/live/run`（令牌 + 必填 `confirm:'run'` + 放行清单 + 该动作 preflight 必须 ready，跑完写 `action_finished`（`actor=live-ui`）并回 `{text,data,elapsedMs}`）；`/live` 工具详情加红框「我现在要跑它」，**两次点击**才发请求 | 全量 **444/444**，0 fail（新增 4 条：默认空清单、点名才放行、核验未过不放行、接口要 confirm 且页面两步确认） |
| 2026-11-18 11:20 | 第 46 轮：页面上点着跑的结果也进判定链——`POST /api/live/run` 里改成先 `evaluateOutcome({operation,result,receipt:{}})`（只读工具固定 `confirmed/ok_text`），再 `recordCheckpoint`（`taskId = ui-run-<ts>`、`stepKey = ui:<action>`），事件 payload 带 `verdict/reason/task_id`，返回体加 `verdict/reason`；实测 `weather.get` 一次真跑后 `/api/live/tools` 的 `lastVerdict=confirmed`、`reason=ok_text`，`task_checkpoints` 里有 `ui-run-1794938921292` | 全量 **445/445**，0 fail（新增 1 条：页面跑必须写快照、必须用同一条判定规则、只读不伪装回执） |
| 2026-11-18 11:40 | 第 47 轮：页面跑完自动核对——`POST /api/live/run` 在动作结束后自动调 `verifyAfter(action,{root,db,probes:systemProbes({root})})`，把 `{verdict,reason,checks}` 放进返回体；`/live` 详情渲染「跑完之后核对：符合预期 / 没看到应有的结果 / 看不出来」+ 逐条证据（没有跑后检查的只读动作不渲空盒子） | 全量 **446/446**，0 fail（新增 1 条：必须自动核对、必须回传、必须只在有 checks 时渲染） |
| 2026-11-18 12:10 | 第 48 轮：契约体检——新建 `connect/live/contract.mjs`（`contractOf(action)` 检查「说明书 `tool-meta`、前置核验 `preflight`、跑完判定 `expect-after`」三件，`contractSummary()` 汇总；只读工具免命令与前置，本地动作免前置），`connect/live/expect-after.mjs` 补齐其余 8 个动作的「跑完应该看到」并导出 `SIDE_EFFECT_ACTIONS`（真正对外的 7 个），`connect/live/api.mjs` 的 `toolList` 返回 `contracts` 与 `contractSummary`；`/live` 卡片缺件时挂「契约缺 N 项」角标（`title` 列缺哪件），报告页新增「契约体检」卡 | 全量 **449/449**，0 fail（新增 3 条：15 个动作三件齐、反例要报出缺件、接口与页面都暴露体检） |
| 2026-11-18 12:30 | 第 49 轮：判定历史改成「按原因分组」——`connect/live/api.mjs` 的 `toolList` 对近 7 天 `task_checkpoints` 用 `reasonBucket()` 归类（成功的行跳过，`reasonBucket('ok')` 返回 null），每个动作给 `reasons:[{id,label,count,sample}]`（按次数倒序，最多 6 类，样本只留 70 字）；`/live` 工具详情新增「近 7 天按原因分组」区块，红=该做没做成 / 橙=环境问题 / 绿=正常 | 全量 **450/450**，0 fail（新增 1 条：同类合并计数、成功不进组、长 reason ≤70 字） |
| 2026-11-18 12:50 | 第 50 轮：老账回填——新建 `scripts/backfill-reasons.mjs`（扫 `task_checkpoints` 里 `reason IS NULL OR TRIM(reason)=''`，用 `evaluateOutcome()` 从 `output_json` 重算理由；`--dry` 演练；`Command failed: …` 归一成 `command_failed`，推断不出的保持空白并计入「保持空白」）；`connect/live/failures.mjs` 的 `command_failed` 匹配放宽成 `/command[ _]failed/iu`（否则归一后显示「原因不明」）。实跑 7 条全部可推断：`command_failed×4`、`nothing_to_do×2`、`count=0<1×1` | 全量 **452/452**，0 fail（新增 2 条：脚本要能演练/要归一/不许编理由；归一后必须仍能归类） |
| 2026-11-18 13:10 | 第 51 轮：近 5 周趋势——`connect/live/api.mjs` 的 `toolList` 把近 35 天 `task_checkpoints`（`verdict != 'skipped'`）按周分桶，每个动作给 `trend:[{weeksAgo,ok,bad}]`（固定 5 点、左旧右新）；`/live` 工具详情新增「近 5 周」条（每根柱底色=当周有未成功、绿色高度=当周成功率，悬停给「成功 X / 未成功 Y」）+ 一行合计 | 全量 **453/453**，0 fail（新增 1 条：固定 5 点、周序正确、跳过的不进趋势） |
| 2026-11-18 13:30 | 第 52 轮：临时放行 30 分钟——`connect/live/run-policy.mjs` 改成分 `allowed`（永久）+ `grants`（`{action,until}`，过期自动失效），新增 `isAllowed()`/`grantTemporarily()`/`isSafeToSelfGrant()`（只读工具或已 `confirmed` 的动作可自助放行，其余返回 `needs_owner`）；`POST /api/live/grant`（写 `live-run.json` + 记 `observation_created`）；`/live` 就绪清单每行加「临时放行 30 分钟」按钮 | 全量 **454/454**，0 fail（新增 1 条：过期即失效、只读可自助、没跑过的电话不行、临时放行不写进永久清单） |
| 2026-11-18 13:50 | 第 53 轮：放行记录可见——新增事件类型 `run_granted`（进 `EVENT_TYPES`、`PIPELINE` 的 gate 段、`EVENT_ROUTE` → `gate/wait`），`POST /api/live/grant` 改写这个事件（payload `{action,until,minutes,why,summary}`）；`liveSnapshot` 增 `grantInfo`（当前有效 `grants` + 永久 `allowed`，过期的不算），`/live` 就绪清单顶部显示「现在有临时放行：works.list 还剩 27 分钟 / weather.get 还剩 30 分钟」+ 永久清单 | 全量 **455/455**，0 fail（新增 1 条：过期的不进 grantInfo、`run_granted` 必须落在闸门段） |
| 2026-11-18 14:10 | 第 54 轮：跑之前的最后确认块——`connect/live/tool-meta.mjs` 给 15 个动作补 `impact`（「会影响谁」，如 `qq.call`「会真的拨给七海（爸爸）——他的手机会响」），`api.mjs` 透出；`/live` 的 `runBox(action,item)` 从「点两次直接跑」改成「点一下展开确认块（会做什么 / 会影响谁 / 跑完应该看到）→ 点『确认，跑一次』才发请求」，支持 `?confirm=<action>` 直接展开（截图/分享用） | 全量 **455/455**，0 fail（更新 1 条：确认块必须写清影响与核对方式） |
| 2026-11-18 14:30 | 第 55 轮：跑完一页回执——`/live` 每次跑完生成可复制回执（【标题】判定 / 动作·耗时 / 做了什么 / 实际结果 / 跑后核对 / 要不要人看一眼），`receiptNode()` 复用同一份内容，`refreshTool()` 后仍挂回详情；顺手修 `runBox` 读令牌用了不存在的 key（`dsh-live-token`，实际是 `dafeiyu.adminToken`）导致页面点跑一律 `unauthorized` | 全量 **456/456**，0 fail（新增 1 条：回执四段齐全、能复制） |
| 2026-11-18 14:45 | 第 56 轮：页面跑过的记录留档——新建 `connect/live/run-log.mjs`（`runsDirOf`/`recordRun`/`recentRuns`，写 `runtime/connect/live-runs/<时间>-<动作>.json`，`text` 截 1000 字），`POST /api/live/run` 成功即落档；`toolList` 每条带 `uiRuns`（最近 3 次，动作与只读工具两条装配路径都加）；`/live` 详情新增「页面上跑过的记录（最近 3 次）」可展开看输出与核对 | 全量 **457/457**，0 fail（新增 1 条：只取该动作、新的在前、目录在 `runtime/connect/live-runs`） |
| 2026-11-18 15:00 | 第 57 轮：两段式流程可视化——新建 `connect/live/publish-flow.mjs` 的 `publishFlowState(db, root, now)`（三步：写草稿看 `runtime/douyin/drafts/` 最新文件、人工二审看 `external_tasks.status='awaiting_confirmation'`、发作品看 `task_checkpoints` 里 `douyin.publish` 最新判定），`toolList` 对三个发布动作带 `flow`；`/live` 详情新增「这条流程现在走到哪一步」（✓ 已完成 / ● 现在卡在这 / ✕ 失败 / ○ 还没到） | 全量 **458/458**，0 fail（新增 1 条：没草稿停第 1 步、有待审停第 2 步、发布后三步全亮且 `next===null`） |
| 2026-11-18 15:15 | 第 58 轮：流程卡住时给出去处——`publish-flow.mjs` 的 review 步返回 `taskId`，`/live` 在「● 现在卡在这」那步下面渲「看这条任务 →」（跳 `?task=…&tab=events`）与「去运行看板批准 →」两个链接，并提示「也可以直接在 QQ 里回一句『同意』」 | 全量 **459/459**，0 fail（新增 1 条：卡住的那步必须带 taskId、`next==='review'`） |
| 2026-11-18 15:30 | 第 59 轮：报告页加「放行前必须知道的三件事」——对每个「有真实副作用但没跑过」的动作，列出会用到什么（`preflight` 摘要）、影响多大（`impact`）、以前有没有试过（`lastAt`/`lastVerdict`，没有就直说「从来没有跑过」）；筛选条件是 `!readOnly && !lastVerdict && impact`（不用 `level==='review'`，否则只抓到 3 个发布类） | 全量 **460/460**，0 fail（新增 1 条：卡片文案与筛选条件） |
| 2026-11-18 15:45 | 第 60 轮：放行清单能在页面上写——新增 `grantPermanently(action,{root,allowed,grants})`（写 `runtime/connect/live-run.json` 的 `allowed`，保留未过期 grants 与已有条目）与 `allowlistSnippet(action)`；`POST /api/live/grant` 支持 `mode:'permanent'`（同样先过 `isSafeToSelfGrant`，公开动作 403 并回 `snippet`）；就绪清单每行加第二个按钮「写入永久放行」，两个按钮并排 | 全量 **461/461**，0 fail（新增：永久放行只读可自助、公开动作必须主人写、写第二个不覆盖第一个、文件仍是合法 JSON） |
| 2026-11-18 16:00 | 第 61 轮：放行当天的顺序成了真源——新建 `connect/live/release-plan.mjs`（`RELEASE_PLAN` 7 步、`nextReleaseStep(items)` 跳过已确认、`validateReleasePlan()` 自检 order 连续与每步都有「为什么/停的条件」），`/live` 报告页渲「放行当天按这个顺序」（已确认的置灰、下一步高亮并显示停的条件），`docs/RELEASE-DAY.md` 与代码同源（测试比对顺序） | 全量 **464/464**，0 fail（新增 3 条：自洽、跳过已确认、文档顺序一致） |
| 2026-11-18 16:20 | 第 62 轮：跑完自动往前走——`connect/live/live.js` 新增 `refreshAfterRun()`（重拉 `/api/live/tools` → `renderTools` → `paintReady()` → 停在报告页时 `renderReport()`），`runBox` 成功回调里调用；`selectTab` 记 `state.tab` 供判断 | 全量 **465/465**，0 fail（新增 1 条：必须调用 `refreshAfterRun`、必须刷新角标与报告、不许 `location.reload`） |
| 2026-11-18 16:40 | 第 63 轮：「和上周比」——新建 `connect/live/trend-compare.mjs`（`compareWeeks(trend)` → `improved/regressed/flat/idle/new`，`describeCompare()` 带数字句子，`summarizeCompare(items)` 把变差排最前、只读工具不参加），`/live` 报告页新增同名列（前 6 条 + 一行汇总） | 全量 **468/468**，0 fail（新增 3 条：五种状态、句子带百分比、汇总排序与只读排除） |
| 2026-11-18 17:00 | 第 64 轮：报告页收起来——`renderReport()` 的卡片改成 `<details>/<summary>`，只有「下一步该干什么」与「跑通覆盖度」默认展开（`{ open: true }`），其余（契约体检、放行前须知、放行顺序、和上周比、还没跑过、本周问题、评论额度）默认折叠，标题右侧有 ⌄ 提示 | 全量 **469/469**，0 fail（新增 1 条：卡片必须是 details、两张默认展开、长卡片默认收起） |
| 2026-11-18 17:20 | 第 65 轮：事件流不再「看起来只有这些」——`liveSnapshot` 增 `earlierCount` 与 `oldestRowid`（用 **rowid** 当游标：`agent_events.id` 是 `event_xxx` 字符串，比大小没意义），新增 `earlierEvents(db,{beforeRowid,limit})` 与 `GET /api/live/events?beforeRowid=&limit=`；`/live` 事件流底部加「还有 N 条更早的事件没显示」+「加载更早 50 条」按钮（筛选/搜索时不显示） | 全量 **470/470**，0 fail（新增 1 条：40 条事件时 26 + 14、翻页游标严格更早） |
| 2026-11-18 17:40 | 第 66 轮：放行清单能写一句备注——新增 `writeAllowlistNote(note,{root})`（压缩空白、截 160 字、不动 `allowed`/`grants`）与 `POST /api/live/note`（写 `run_granted` 事件）；`liveSnapshot().grantInfo` 透出 `note`；就绪面板加输入框「写一句为什么开这个口子」+ 保存按钮与当前值回显 | 全量 **471/471**，0 fail（新增 1 条：备注压缩空白、截断、不冲掉 allowed） |
| 2026-11-18 18:00 | 第 67 轮：「预演」而不是假预演——新建 `connect/live/dry-run.mjs` 的 `buildPreview(action,item)`/`previewWithProbes()`（给命令、做什么、影响、跑完核对、当前前置；`TRUE_DRY_RUN` 为空集因为短视频脚本带 `--dry-run` 也会打开手机 UI，所以明确写「这一条没有真正的 dry-run」），`GET /api/live/preview?action=`；`/live` 工具详情加「预演：看它会做什么」按钮 + `?preview=1` 深链 | 全量 **472/472**，0 fail（新增 1 条：拨号不许标成可预演、命令与核对点要透出、只读动作也要给命令） |
| 2026-11-18 18:20 | 第 68 轮：把手动跑的账标出来——`task_checkpoints` 的 `task_id` 以 `ui-run-` 开头即 `origin:'ui'`（其余 `'task'`），`toolList` 的 `history[]` 带上；`/live` 判定历史里这类记录加「页面手动」小标签，避免和定时任务的记录混在一起 | 全量 **473/473**，0 fail（新增 1 条：两条记录的 origin 分别是 ui / task） |
| 2026-11-18 18:40 | 第 69 轮：「只看真实业务」开关——`toolList(db, now, {realOnly})` 在 5 条 checkpoint 查询上追加 `AND task_id NOT LIKE 'ui-run-%'`，`GET /api/live/tools?real=1`；工具清单顶部加复选框，勾上后覆盖度/趋势/本周次数/判定历史都只算真实业务（实测 `weather.get` 本周 206 → **3**） | 全量 **474/474**，0 fail（新增 1 条：5 条手动 + 1 条任务，realOnly 只剩 1 条且 origin 为 task） |
| 2026-11-18 19:00 | 第 70 轮：「样本少」标注——新建 `connect/live/sample.mjs`（`THIN_SAMPLE=3`，`sampleNote(runs)` 给 thin/label/tip），工具卡判定行追加「· 样本 N 次」并加虚线下划线（`title` 写「至少再跑 K 次再看」），**不改判定颜色与 verdict** | 全量 **475/475**，0 fail（新增 1 条：0 次直说没跑过、1 次标样本、3 次起不标） |
| 2026-11-18 19:20 | 第 71 轮：runbook 进度表带样本量——`scripts/runbook-progress.mjs` 的表格加「本周真实次数」列（取 `toolList` 的 `weekRuns`，即排除页面手动跑），`<3` 次标「（少）」；重新生成 `docs/TOOL-RUNBOOK.md` 的进度块（6/15 已确认） | 全量 **476/476**，0 fail（新增 1 条：表头含「本周真实次数」、脚本必须用 weekRuns 且标「（少）」） |
| 2026-11-18 19:40 | 第 72 轮：文档与页面的一次对齐检查——新增 `tests/docs-alignment.test.mjs` 3 条：①7 个副作用动作必须同时出现在 `release-plan`、`docs/FIRST-RUN.md`、`TOOL_META`（≥2 条前置 + impact ≥8 字）与 `EXPECT_AFTER`（≥1 条可读核对句），且 `hasPreflight` 为真；②操作单里提到的动作必须在说明书里存在（不许写幽灵步骤）；③页面必须有「预演 / 检查 / 跑一次」，服务端必须有 preflight/preview/run/grant 四个接口 | 全量 **479/479**，0 fail（新增 3 条） |
| 2026-11-18 20:00 | 第 73 轮：放行自检脚本——新增 `scripts/release-check.mjs`（只读，不跑副作用）：打印放行顺序、下一步该跑哪个、放行清单与备注、7 个动作逐条的「已放行 / 前置 / 上次判定」表，末行给「还有 N 项不满足」；`package.json` 加别名 `release:check` | 全量 **480/480**，0 fail（新增 1 条：脚本能跑、7 个动作都在、末行结论存在） |
| 2026-11-18 20:20 | 第 74 轮：一次真跑的证据包——新建 `connect/live/evidence.mjs`（`renderEvidence` 把回执/判定/跑后核对/相关事件拼成 Markdown，超长截断标注原长度）；服务端 `GET /api/live/evidence?id=<taskId>`（读 `task_checkpoints.output_json`，`task_id` 以 `ui-run-` 开头标「页面手动跑」）；`POST /api/live/run` 返回 `taskId`；结果卡加「导出这次证据（Markdown）」（复制到剪贴板，失败则贴到页面上） | 全量 **483/483**，0 fail（新增 3 条：四样齐全、超长截断、接口 401/200/404） |
| 2026-11-18 20:40 | 第 75 轮：放行当天文档与自检脚本对齐——修掉 `docs/RELEASE-DAY.md` 收尾段被误写入的乱码行（把脚本 stdout 当成了正文），补「先跑 `npm run release:check`」「每跑完一次导出证据」「收尾写回 runbook 进度」三步；新增测试断言文档里的 7 个「动作：」出现顺序**必须等于** `RELEASE_PLAN` | 全量 **484/484**，0 fail（新增 1 条） |
| 2026-11-18 21:00 | 第 76 轮：一页交接——新增 `scripts/handover.mjs`（从 `toolList(realOnly)` + `RELEASE_PLAN` + 放行清单算出七节：总数／已跑通／未确认／没跑过／卡在哪／放行后怎么走／已知的坑），生成 `docs/HANDOVER.md`；`package.json` 加别名 `handover`；数字口径写明「排除页面手动跑的 ui-run-*」 | 全量 **485/485**，0 fail（新增 1 条：能生成、七节齐全、7 个动作都在、坑有记） |

> **测试口径**：`node --test --test-timeout=20000 tests/*.test.mjs`。基线 190 → 批0 后 219 → P0-B 后 243 → P0-C 后 251 → P1-A 后 255 → P1-B 核心 259 → P1-B 收尾后 280 → P1-C 后 312 → P2 后 328 → 收尾复检 329 → 架构可视化 331 → 流程抽屉 + 自动接听常驻化 332 → 实时工作流控制台 338 → 四页统一 title bar 339 → 实时工作流改版 339 → 主页 + 六项修补 341 → 主页 v3 重构 342 → 主页 v4 首屏优化 342 → 主页 v5 排版 + 贴图 342 → M1 情景记忆 + 路由埋点 + 表驱动 349 → M2 判定/断点续跑/重规划 356 → M3 失败进学习账本 356 → M4 评估基线 356 → 抖音复跑 + 定时任务三修 358 → 掉设备预检 + 没活干判定 360 → 回复评论带作品上下文 365 → 视频发布 + 草稿清理 368 → 抖音哨兵 374 → /live 维护约束 + 工具卡片 378 → 平面数据流 + 双向联动 382 → 工具跑通第 1 轮 387 → 工具跑通第 2 轮（探针 + 负路径）389 → 第 2 轮收尾（路径归一 + 工具卡最近一次）391 → 第 3 轮（判定理由落库 + 真库修复）392 → 第 4 轮（/flow 汇总 + 两条真跑判定）393 → 第 5 轮（主页回归 + 判定上首页）394 → 第 6 轮（批量真跑 6 个 + 今日计数公开）395 → 第 7 轮（下线两个做不到的动作）395 → 第 8 轮（判定上 3D 页 + 看板原因说人话）396 → 第 9 轮（覆盖度小条 + 评论链路收敛）397 → 第 10 轮（拟稿前置 + 评论发送重写 + 脚本完整性闸门）399 → 第 11 轮（评论工具转 confirmed + 限流与失败现场）399 → 第 12 轮（没活干与限流都留证据）400 → 第 13 轮（/flow 顶栏工具覆盖）401 → 第 14 轮（工具详情判定历史）402 → 第 15 轮（本周次数 + 数据流侧栏判定）402 → 第 16 轮（首页次数 + 没活干的量级）403 → 第 17 轮（判定历史可回跳）404 → 第 18 轮（授权类工具的前置清单）405 → 第 19 轮（前置条件机器核验）406 → 第 20 轮（就绪角标 + 发布分步）407 → 第 21 轮（就绪清单可展开）408 → 第 22 轮（核验留痕）409 → 第 23 轮（闸门节点显示就绪度）410 → 第 24 轮（定时任务行标就绪）411 → 第 25 轮（本周失败归类）412 → 第 26 轮（comment_latest 跑通并加固）414 → 第 27 轮（评论额度可配置并上页面）415 → 第 28 轮（额度用完的槽直接跳过）416 → 第 29 轮（周统计拆出额度跳过）417 → 第 30 轮（跳过原因说人话）418 → 第 31 轮（判定词汇表收成一份）419 → 同轮收尾（核验事件摘要）420 → 第 32 轮（放行清单）421 → 第 33 轮（手动命令上页面）422 → 第 34 轮（详情可刷新）423 → 第 35 轮（本轮报告页签）424 → 第 36 轮（进度写回 runbook）425 → 第 37 轮（跑完怎么算成功）431 → 第 38 轮（只读工具有证据 + 热点降级）431 → 第 39 轮（hotspot 下线）431 → 第 40 轮（下线动作留档上页面）432 → 第 41 轮（第一次真跑操作单）433 → 第 42 轮（报告首卡「下一步该干什么」）438 → 第 43 轮（首屏「下一步」一行）439 → 第 44 轮（数据流面板也有下一步）440 → 第 45 轮（页面上的「跑一次」，默认关门）444 → 第 46 轮（页面跑的结果进判定链）445 → 第 47 轮（跑完自动核对）446 → 第 48 轮（契约体检）449 → 第 49 轮（按原因分组）450 → 第 50 轮（老账回填）452 → 第 51 轮（近 5 周趋势）453 → 第 52 轮（临时放行 30 分钟）454 → 第 53 轮（放行记录可见）455 → 第 54 轮（跑前确认块）455 → 第 55 轮（跑完一页回执）456 → 第 56 轮（页面跑过的记录留档）457 → 第 57 轮（两段式流程可视化）458 → 第 58 轮（流程卡住给出去处）459 → 第 59 轮（放行前必须知道的三件事）460 → 第 60 轮（放行清单能在页面上写）461 → 第 61 轮（放行当天顺序）464 → 第 62 轮（跑完自动刷新）465 → 第 63 轮（和上周比）468 → 第 64 轮（报告页收起）469 → 第 65 轮（事件流能往前翻）470 → 第 66 轮（放行备注）471 → 第 67 轮（预演）472 → 第 68 轮（手动跑的账单独标）473 → 第 69 轮（只看真实业务）474 → 第 70 轮（样本少标注）475 → 第 71 轮（runbook 带样本量）476 → 第 72 轮（文档与页面对齐检查）479 → 第 73 轮（放行自检脚本）480 → 第 74 轮（证据包导出）483 → 第 75 轮（放行文档与自检对齐）484 → 第 76 轮（一页交接）**485**，全程 0 fail。
> **下一步**：P2 已完成，本计划的批 0 → P0-A → P0-B → P0-C → P1-A → P1-B → P1-C → P2 全部落地；剩余的是两条「等真实数据触发」的门槛（见 P1-C 行的 `skill_rollbacks` 真实回滚、`learning_proposals` 出 `validated`）与 D-4 的「按需渐进搬迁」，都不是本计划的欠账。

---

## 附录 B · 证据索引

| 主题 | 主要证据 |
|---|---|
| 身份与策略 | `connect/policy.mjs:1-28`；`connect/qq/service.mjs:324,338,377,503,519,527-530,633`；`connect/qq/store.mjs:1-3,17,19-31,48`；`connect/ilink/store.mjs:5,14-25,39,62-66`；`brain/server.mjs:107-130` |
| 事件流 | `connect/core-contract.mjs:10-56`；`connect/agent-events.mjs:9-28,30-35,37-64`；`connect/qq/service.mjs:326,651,657,666,671`；`connect/ilink/worker.mjs:56,119`；`brain/migrations.mjs:218` |
| 记忆 | `brain/memory.mjs:51-89,90,111,129`；`brain/migrations.mjs`（13 版）；`connect/memory-hub.mjs:10-42`；`connect/daily-memory.mjs:30` |
| 任务与认知 | `connect/tasks.mjs:5-25,27,40`；`connect/working-state.mjs:3-21,32`；`brain/cognition/kernel.mjs:4-16`；`connect/cognition-bridge.mjs:6,18,20`；`connect/server.mjs:479-481` |
| 能力与工具 | `connect/memory/capabilities.mjs:9-300`；`connect/qq/tools.mjs:11,129,150,182,189,203-225,228`；`connect/actions.mjs:26,308,314`；`connect/skills/defs.mjs`（12 技能 / 44 断言）；`connect/skills/ledger.mjs:23-24,107-113,183-201` |
| 设备层 | `device/uia.mjs:73,93,111,115,129,136`；`device/douyin.mjs:221,246,288,324,345,377,409,419,441,452,470,492,494,510,519,592,788,824` |
| 治理与合规 | `connect/douyin/compliance.mjs:7-11,14,25,33,35-56`；`connect/approvals.mjs:16-18,21-50,53-73`；`connect/scheduler.mjs:21,42-104,87,108-176`；`connect/receipts.mjs:3`；`life/tasks.mjs:3,13,25`；`life/manager.mjs` |
| 文档与数据 | `docs/capabilities/README.md`；`docs/UNIFIED_AGENT_IMPLEMENTATION_PLAN.v0.1.md`；`config/persona.md` |
| 已有测试 | `tests/core-contract.test.mjs`、`tests/interaction-event.test.mjs`、`tests/agent-events.test.mjs`、`tests/policy.test.mjs`、`tests/planner.test.mjs`、`tests/qq.test.mjs`、`tests/ilink.test.mjs`、`tests/brain.test.mjs`、`tests/cognition.test.mjs`、`tests/cognition-bridge.test.mjs`、`tests/daily-memory.test.mjs`、`tests/receipts.test.mjs`、`tests/connect-brain.test.mjs`、`tests/connect-inbox.test.mjs`、`tests/connect.test.mjs`、`tests/call.test.mjs`、`tests/identity-state.test.mjs`、`tests/identity-traits.test.mjs` |
