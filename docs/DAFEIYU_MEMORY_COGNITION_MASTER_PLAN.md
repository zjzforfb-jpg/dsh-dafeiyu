# 大肥鱼记忆、认知中枢与自主学习技术实施计划

版本：V1.0  
适用项目：DSH-dafeiyu  
技术基线：Node.js 22、SQLite、Mac 桌面、荣耀 Magic5 Companion、ADB、微信 iLink、QQ、抖音适配器

## 1. 项目目标

将当前“多个渠道接入同一个模型”的桌宠系统，逐步升级为具备连续记忆、任务状态、可验证技能和受控成长能力的认知智能体。

系统最终需要回答四类问题：

1. **记忆系统**：以前发生过什么？
2. **认知系统**：现在应该做什么？
3. **技能系统**：怎样完成得更稳定、更快？
4. **人格系统**：大肥鱼是谁，如何保持连续和一致？

总体闭环：

```text
感知 → 事件标准化 → 记忆调度 → 规划 → 权限判断
→ 动作执行 → 真实回执 → 结果评价 → 经验提炼 → 技能更新
```

模型只能参与理解、规划和生成，不能自行宣布外部操作成功。

## 2. 当前项目基线

### 2.1 已有模块

- `brain/server.mjs`：人格、对话、上下文、模型调用。
- `brain/memory.mjs`：长期记忆写入、召回、修订和删除。
- `brain/migrations.mjs`：SQLite 迁移。
- `connect/daily-memory.mjs`：跨渠道每日消息流水。
- `connect/memory-hub.mjs`：统一记忆入口和活动记录。
- `connect/tasks.mjs`：外部任务、审批、幂等和过期处理。
- `connect/receipts.mjs`：操作回执状态。
- `connect/qq/`：QQ 私聊、群聊和语音。
- `connect/ilink/`：微信 Bot 和语音文件通信。
- `connect/douyin/`：抖音流程、合规规则和经验本。
- `life/manager.mjs`：每日探索、目标、日记和预算。
- `device/`：ADB、UI 树、截图和手机操作。

### 2.2 当前记忆层

```text
daily_memory_events
    ↓ 每日摘要
daily_digest
    ↓ 明确事实或高置信度提炼
memories / memory_facts
```

当前已经具备：

- 跨微信、QQ、桌面渠道的每日流水。
- 群聊和私人会话的隐私范围区分。
- 明确“请记住”才进入长期记忆。
- 记忆可信度、来源、修订和删除。
- 关键词、中文双字词、短语、时间新鲜度和可信度召回。
- 访问次数和最近访问时间统计。

当前不足：

- 每日摘要还没有完整的事实候选提炼流程。
- 记忆冲突合并仍需结构化实现。
- 普通事件和程序性经验没有统一事件 ID。
- 抖音经验本仍偏文本笔记，尚未成为可验证技能。
- 工作中任务、动作轨迹和技能运行记录尚未完全统一。

## 3. 目标架构

```text
Identity Engine
  稳定身份、性格、关系、价值观、表达边界

Memory Engine
  工作记忆、情景记忆、语义记忆、程序性记忆、反思记忆

Cognition Kernel
  感知、情境理解、记忆调度、规划、决策、恢复

Learning Engine
  轨迹分析、失败反思、技能候选、策略统计

Policy Engine
  权限、审批、频率、预算、平台规则、熔断

Action Engine
  Mac、ADB、Magic5 Companion、微信、QQ、抖音

Evaluator
  回执验证、成功率、延迟、重试和回归评价
```

初期继续使用单机 Node.js 模块化架构，不立即拆成微服务。所有模块通过结构化接口和 SQLite 关联。

## 4. 五类记忆设计

| 记忆类型 | 主要内容 | 生命周期 | 读取方式 |
|---|---|---|---|
| 工作记忆 | 当前页面、任务步骤、下一动作 | 任务结束后清理，异常时保留恢复信息 | 只供当前任务 |
| 情景记忆 | 一次完整任务的观察、动作、结果、失败 | 原始轨迹限期保留，摘要长期保留 | 按相似任务召回 |
| 语义记忆 | 爸爸的事实、偏好、关系、知识 | 长期保存，可修订和废弃 | 按问题召回 |
| 程序性记忆 | 如何完成任务、如何恢复失败 | 版本化管理 | 选中技能时召回 |
| 反思记忆 | 从多次经历总结出的规律 | 长期保存，必须有证据 | 低频、按场景召回 |

关键原则：记录量可以很大，但每次对话只能注入当前真正相关的少量记忆。

## 5. 数据模型计划

### 5.1 `agent_events`：统一事件流水

建议字段：

```text
id
event_type
channel
conversation_id
task_id
skill_run_id
actor
payload
result
evidence
privacy_scope
created_at
dedupe_key
```

事件类型：

- `message_received`
- `message_replied`
- `observation_created`
- `plan_created`
- `action_requested`
- `action_started`
- `action_finished`
- `action_failed`
- `receipt_verified`
- `user_corrected`
- `reflection_created`

### 5.2 `working_tasks`：工作状态

```text
task_id
goal
status
environment
current_step
selected_skill
last_observation_id
next_action
retry_count
deadline
updated_at
```

状态：

```text
pending → running → waiting_verification → succeeded
                         ↓
                       failed / unknown / cancelled / expired
```

### 5.3 `memory_facts`：结构化事实

字段：

```text
memory_id
subject
predicate
object_text
status
confidence
source
valid_from
valid_to
supersedes_id
```

每日摘要产生的内容先进入 `candidate`，爸爸明确确认或规则达到高置信度后才进入 `confirmed`。

### 5.4 技能相关表

```text
skill_registry
skill_versions
skill_runs
skill_proposals
strategy_trials
```

技能必须记录：

```text
skill_id
name
version
preconditions
steps
postconditions
fallback
environment
success_count
failure_count
avg_duration
confidence
status
```

技能状态：

```text
candidate → validating → enabled → deprecated
```

## 6. 长期记忆优化方案

### 6.1 写入流程

```text
消息/动作事件
→ 标准化
→ 敏感信息过滤
→ 判断事件类型
→ 提取事实候选
→ 来源和可信度验证
→ 冲突检测
→ 写入对应记忆层
```

规则：

- “请记住”明确指令可直接写入确认事实。
- 一次普通对话只能进入每日事件流水。
- 单次模型推断不能直接成为永久事实。
- 群聊内容默认不能覆盖爸爸私人记忆。
- 密码、验证码、Token、身份证和银行卡信息禁止进入长期记忆。

### 6.2 检索流程

```text
识别问题类型
→ 选择记忆层
→ 按渠道/隐私/类型/有效期过滤
→ 关键词和短语召回
→ 可信度与时间重排
→ 必要时向量重排
→ 注入有限上下文
```

建议评分因素：

- 完整短语命中。
- 关键词覆盖率。
- 记忆类型匹配。
- 来源可信度。
- 时间新鲜度。
- 当前任务环境匹配度。
- 最近访问反馈。

### 6.3 冲突与遗忘

- 新事实不覆盖旧事实，先建立版本链。
- 旧事实标记 `superseded`，保留审计记录。
- 删除后必须从召回、摘要和缓存中同时排除。
- 每日流水默认保留30天。
- 临时事件可降权，稳定事实不自动删除。
- 反思记忆需要多次同类证据才能提升权重。

## 7. 认知中枢方案

`Cognition Kernel` 负责统一控制，而不是让每个渠道自己调用模型和执行动作。

标准流程：

1. 接收目标。
2. 读取当前环境。
3. 判断任务类型和风险等级。
4. 调度相关记忆。
5. 选择已验证技能。
6. 生成有限步骤计划。
7. 交给 Policy Engine 审核。
8. 调用 Action Engine。
9. 等待真实回执。
10. 成功则结束，失败则重新观察并决定恢复或停止。
11. 记录情景和技能运行结果。

模型不得直接返回“已经完成”作为成功依据。

## 8. 技能进化方案

现有 `connect/douyin/lessons.mjs` 保留，升级为技能候选来源。

首批技能：

- `android.observe_screen`
- `android.recover_screen`
- `douyin.open_comments`
- `douyin.read_comments`
- `douyin.reply_comment`
- `douyin.verify_reply`

每次技能执行必须记录：

```json
{
  "skill_id": "douyin.reply_comment.v1",
  "environment": "Magic5:douyin",
  "success": true,
  "verified": true,
  "duration_ms": 8200,
  "retry_count": 1,
  "failure_stage": null
}
```

经验升级规则：

- 单次失败只生成候选反思。
- 同类问题重复出现至少两次，才提高经验权重。
- 新技能必须成功复现后才能启用。
- 技能版本必须可回滚。
- 技能不能修改人格核心。

## 9. 性能和设备自动化策略

不要把“毫秒级 OCR”当成全链路指标。建议采用：

```text
AccessibilityService 负责事件
局部截图负责视觉
OCR Worker 负责文字识别
规则状态机负责常见动作
本地小模型负责分类
云端模型负责复杂语义
ADB/Companion 负责执行
回执服务负责验证
```

目标指标：

- 感知 p95 < 150ms。
- 规则决策 p95 < 20ms。
- 普通动作端到端 p95 < 500ms。
- 复杂语义生成不超过2秒。
- 动作成功率 > 98%。
- 未验证动作继续率 = 0。
- 重复发送和误操作率 < 1%。

抖音自绘界面仍需保留 OCR 兜底；不要假设 AccessibilityService 能读取所有文字。

## 10. 分阶段执行计划

### P0：基线与观测

交付：耗时日志、统一 ID、脱敏轨迹、当前能力基线。  
验收：每个动作都能关联任务、回执和事件。

### P1：全渠道事件采集

交付：`agent_events` 和四类渠道接入。  
验收：微信、QQ、桌面、抖音均能生成完整轨迹，事件可去重。

### P2：工作状态与恢复

交付：`working_tasks`、恢复状态机、断线重观察。  
验收：模型中断、手机断开和服务重启不会盲目续做。

### P3：程序性记忆与技能库

交付：技能目录、版本、运行记录、候选技能审批。  
验收：至少三个抖音技能拥有成功率、失败率和回退策略。

### P4：结果评价与每日反思

交付：技能评价、失败原因提取、候选反思、每日经验整理。  
验收：失败能形成可追踪经验，但不会直接污染启用技能。

### P5：策略优化

交付：策略统计、上下文选择、Contextual Bandit 实验。  
验收：效率提升且误操作率、违规率不升高。

### P6：人格和长期成长

交付：Identity Core、Dynamic State、Acquired Traits 分层。  
验收：人格稳定、偏好有来源、跨渠道表达一致。

## 11. 核心接口

```js
recordAgentEvent(event)
createWorkingTask(input)
observeEnvironment(taskId)
selectMemory(query, scope)
selectSkill(goal, environment)
proposePlan(task, memories, skills)
checkPolicy(plan, actor)
executeAction(planStep)
verifyReceipt(actionId)
evaluateSkillRun(runId)
createLearningProposal(evaluation)
```

所有接口必须返回结构化结果，包含状态、来源、证据和错误原因。

## 12. 评价体系

### 记忆

- 召回准确率。
- 错误召回率。
- 事实冲突率。
- 删除后残留召回率，目标为0。
- p50/p95 检索延迟。

### 认知

- 任务完成率。
- 重启恢复成功率。
- 规划偏差率。
- 未验证动作继续率，目标为0。

### 技能

- 技能成功率。
- 平均耗时。
- 平均重试次数。
- 技能回归失败率。
- 不同设备和页面版本成功率。

### 人格

- 人格一致性。
- 关系记忆准确率。
- 偏好更新可解释性。
- 跨渠道表达一致性。

## 13. 安全、权限与回滚

- Policy Engine 必须独立于模型。
- 群聊不允许批准外部动作。
- 抖音评论、点赞、发布、微信发送等动作必须具备任务和回执。
- 高风险动作需要爸爸确认。
- 手机断开或回执未知时停止，不自动重试危险动作。
- 数据库迁移前执行备份。
- 新技能默认 `candidate`，启用失败可回滚到上一版本。
- 删除记忆必须同步清除召回入口、摘要和缓存。

## 14. 近期执行顺序

```text
1. P0 统一观测
2. P1 全渠道事件
3. P2 工作状态与恢复
4. P3 抖音技能库
5. P4 结果评价与反思
6. P5 策略统计优化
7. P6 人格长期成长
```

当前最应该先做 P0–P2。只有把事件、状态、回执和恢复做好，后续的技能进化和策略优化才有可靠数据基础。

## 15. 发布门槛

每个阶段必须满足：

- 旧数据库可自动迁移。
- 单元测试和回归测试通过。
- 任务可查询、取消和恢复。
- 外部动作有真实回执。
- 失败不会伪造成功。
- 不泄露密钥、验证码和敏感页面内容。
- 群聊权限边界不被破坏。
- 稳定性观察达到项目设定窗口。

在这些条件未满足前，不能把“会思考”“会学习”宣传为已经具备自主智能，只能称为候选能力或实验能力。

## 16. 执行记录

### 2026-11-15：P0 第一批完成

- 新增 `connect/agent-events.mjs`，提供统一事件初始化、写入、去重和查询。
- Connect 数据库新增 `agent_events` 表及任务/时间索引。
- 长期记忆数据库通过迁移新增同名事件表，保证后续桌面与渠道可以使用相同契约。
- 外部任务的提议、审批、开始、完成、失败和取消自动生成事件。
- Android 命令请求自动生成 `action_requested` 事件。
- 新增 `/agent-events` 查询接口，支持按任务和事件类型过滤。
- 新增事件去重、任务轨迹回归测试。
- 完整测试：73 项通过。

当前状态：P0 处于“统一事件骨架已落地、全渠道接入进行中”；下一步是把微信、QQ、桌面消息接收和统一回执验证接入 `agent_events`，然后进入 P1 完整验收。

### 2026-11-15：P1 接入进行中

- 桌面 Brain 请求已记录 `message_received` 和 `message_replied/action_failed`。
- QQ 入站消息和回复已记录统一事件，沿用群聊 `group` 与私聊 `private` 隐私范围。
- 微信 iLink 入站、发送成功和发送未知已记录统一事件；朋友会话使用 `friend` 范围。
- 事件查询接口使用 `/agent-events`，避免与原有通信通知 `/events` 路由冲突。
- 事件载荷统一脱敏并限制长度，不保存原始密钥和敏感凭据。
- 相关渠道回归测试通过；P1 还需补统一回执验证事件和跨数据库汇总视图。

### 2026-11-15：P2 工作状态第一批完成

- 新增 `connect/working-state.mjs` 和 `working_tasks` 表。
- 工作状态保存目标、环境、当前步骤、选中技能、最近观察、下一动作、重试次数和截止时间。
- 外部任务和 Android 命令创建工作状态；开始、成功、失败、取消和设备断线会同步更新。
- 服务初始化会把中断中的 `running/waiting_verification` 标记为 `unknown`。
- 新增 `/working-tasks` 和 `/working-tasks/:id` 查询接口。
- 设备回执未知时不会自动继续执行，下一动作标记为 `reobserve_before_retry`。
- 完整测试：75 项通过。

### 2026-11-15：P2 环境观察与受控恢复

- 新增 `connect/environment-observer.mjs`，从 Connect 当前设备、能力、命令和任务状态生成结构化观察快照。
- 新增 `POST /working-tasks/:id/observe`，观察结果会写入 `agent_events` 并关联工作任务。
- `POST /working-tasks/:id/recover` 仍要求观察 ID和环境快照，未知任务只能恢复为 `pending`，不会直接进入运行态。
- 恢复后下一动作固定为 `replan_after_observation`，要求重新规划。
- `/working-tasks/:id/observe` 支持传入 ADB serial，调用真实 Android 观察读取连接状态、前台 Activity 和屏幕尺寸；未提供 serial 时使用 Connect 状态快照。
- 完整测试仍为 75 项通过。

当前状态：P2 已完成工作状态持久化和中断保护的第一批；仍需接入真正的环境观察器和受控恢复流程，完成后才能宣称 P2 全部验收。

### 2026-11-15：P3 技能库第一批完成

- 新增 `connect/skills.mjs`，包含技能目录、版本、运行记录和候选提议。
- 技能状态支持 `candidate/validating/enabled/deprecated`。
- 技能运行记录成功、验证、耗时、重试次数、失败阶段和结果。
- 只有显式设置为 `enabled` 的版本才可成为当前版本；旧版本可降级为 `deprecated`。
- 新增 `/skills` 查询接口。
- 新增技能注册、候选提议、启用和统计回归测试。
- 完整测试：76 项通过。

### 2026-11-15：P4 候选反思第一批完成

- 新增 `connect/reflection.mjs` 和 `learning_proposals` 表。
- 技能运行失败或未知时自动生成候选反思。
- 同一技能、失败阶段的问题会聚合统计，不会每次重复创建无意义记录。
- 候选反思支持 `candidate/validating/validated/rejected` 状态。
- 新增 `/reflections` 查询接口。
- 反思只记录证据和改进方向，不直接修改技能版本或人格。
- 完整测试：77 项通过。

### 2026-11-15：P4 反思验证闭环完成

- 重复失败的候选反思必须达到至少两次同类证据。
- 只有同一技能版本出现成功且 `verified=1` 的运行记录后，反思才可标记 `validated`。
- 验证成功会生成 `skill_proposals` 候选，不会直接覆盖启用技能。
- 新增 `POST /reflections/:id/validate`，要求提交成功运行 ID。
- 验证失败、证据不足和技能不匹配都会拒绝升级。
- 完整测试：78 项通过。

### 2026-11-15：G5 策略选择第一批完成

- 新增 `connect/strategies.mjs` 和 `strategy_trials` 表。
- 记录策略环境、选择理由、成功/失败/未知、真实验证、耗时和重试次数。
- 支持按 App、页面状态和候选策略过滤统计。
- 选择器按已验证成功率、成功率、重试次数和耗时生成可解释排序。
- 没有验证历史时不会伪造高置信度，返回 `no_verified_history`。
- 新增 `/strategies/stats` 查询接口。
- 完整测试：79 项通过。

### 2026-11-15：G5 抖音策略运行接入

- 抖音评论和回复流程在执行前选择候选策略并记录选择理由。
- 真实发送结果会写入 `strategy_trials`，包含成功、验证、耗时和失败结果。
- 没有验证历史时默认使用安全的 `uia_smart`，不会因为统计不足启用未知策略。
- 合规拦截也会结束策略试验，避免只统计成功样本。
- 完整测试仍为 79 项通过。

### 2026-11-15：G6 认知中枢第一批完成

- 新增 `brain/cognition/kernel.mjs`，统一目标、环境、记忆 ID、技能选择和有限步骤计划。
- 计划步骤支持 `pending/running/succeeded/failed/unknown`，未知回执会进入 `needs_reobserve`。
- 高风险计划在非爸爸身份或未获批准时直接阻断。
- 计划不会绕过现有任务、回执和权限系统。
- 新增认知计划和高风险阻断测试。
- 完整测试：81 项通过。

### 2026-11-15：G6 认知计划接入工作任务

- 新增 `connect/cognition-bridge.mjs`。
- 新增 `POST /working-tasks/:id/plan`，将目标、环境、技能和步骤生成认知计划。
- 计划通过 Policy Engine 后才会更新工作任务当前步骤和下一动作。
- 计划创建会写入 `plan_created` 事件，并关联任务 ID。
- 高风险计划仍需要爸爸批准，禁止非 owner 直接执行。
- 完整测试：82 项通过。

### 2026-11-15：G6 计划执行循环

- 工作任务新增持久化 `plan_json`。
- 新增 `POST /working-tasks/:id/advance`，根据真实动作结果推进计划步骤。
- 成功回执推进下一动作；失败或未知回执将工作任务置为 `unknown`，要求重新观察。
- 步骤推进和重新观察事件写入 `agent_events`。
- 完整测试：83 项通过。

### 2026-11-15：G7 事实候选提炼第一批完成

- 新增 `connect/fact-candidates.mjs` 和 `memory_fact_candidates` 表。
- 每日用户事件中的明确偏好和“请记住”表达会生成候选事实。
- 候选保存原始事件 ID、渠道、会话类型、置信度和证据。
- 候选不会直接写入 `memories` 或确认事实层。
- 新增 `/memory/fact-candidates` 查询和提炼接口。
- 完整测试：84 项通过。

### 2026-11-15：G7 事实确认与冲突第一批完成

- 新增候选确认接口：`POST /memory/fact-candidates/:id/confirm`。
- 爸爸确认后才写入 `memories` 和 `memory_facts`。
- 同一主体和谓词的旧确认事实标记为 `superseded`，保留来源和版本关系。
- 候选确认保留原始事件关联，失败不会半写入。
- 完整测试：85 项通过。

### 2026-11-15：G7 事实生命周期与召回过滤

- 被替代或拒绝的 `memory_facts` 不再进入长期记忆召回。
- 新增事实冲突查询：`GET /memory/fact-conflicts`。
- 新增候选拒绝：`POST /memory/fact-candidates/:id/reject`。
- 新增历史事实恢复：`POST /memory/facts/:id/restore`。
- 修复召回评分在无关键词命中时因可信度返回无关记忆的问题。
- 完整测试：86 项通过。

### 2026-11-15：G8 动态人格状态第一批完成

- 新增 `brain/identity-state.mjs` 和 `identity_state` 表。
- 分离稳定人格配置与动态状态：心情、精力、好奇心、关注点。
- 动态数值统一限制在 0–1 范围，并保留更新原因和时间。
- 桌面和爸爸会话上下文可以读取动态状态；朋友会话不读取私人状态。
- 动态状态只影响表达，不直接修改人格核心或长期事实。
- 完整测试：87 项通过。

### 2026-11-15：G8 后天特征第一批完成

- 新增 `brain/identity-traits.mjs` 和 `identity_traits` 表。
- 偏好、兴趣和行为习惯必须累积多次证据才会从 `candidate` 变为 `active`。
- 后天特征与稳定人格核心、动态心情分开保存。
- 已激活特征可在爸爸和桌面会话中作为表达参考，朋友会话不读取私人特征。
- 完整测试：88 项通过。

### 2026-11-15：G9 性能观测第一批完成

- 新增 `connect/performance.mjs` 和 `performance_samples` 表。
- 支持记录 ADB、截图、UI 树、OCR、决策、动作和验证阶段耗时。
- 提供 p50、p95、p99、样本数和成功率统计。
- 新增 `/performance/stats` 查询接口。
- 在没有真实样本前不宣称毫秒级性能，先以观测数据建立基线。
- 完整测试：89 项通过。

### 2026-11-15：G9 Android 命令性能接入

- Android 命令收到 Companion 回执后自动写入 `performance_samples`。
- 记录命令动作、设备、任务 ID、总耗时和成功状态。
- 未知状态仍保留为未知，不会被统计为成功。
- 完整测试仍为 89 项通过。

### 2026-11-15：G10 发布门槛强化

- `release:check` 现在检查认知总计划是否存在。
- 发布检查会实际运行完整 `npm test`，测试失败不得通过。
- 当前检查结果：功能、测试、设备、任务和密钥扫描全部通过；唯一未通过项仍是7天稳定性窗口（当前约7.68小时）。

- 长期运行清理策略：性能样本保留30天，统一事件保留90天，避免 Connect 数据库无限增长。

### 2026-11-15：G6 技能与策略绑定

- 新增 `POST /working-tasks/:id/prepare`。
- 每个计划步骤执行前选择候选策略，并将 `selected_strategy` 持久化到工作任务。
- 选择结果、步骤动作和理由写入 `agent_events`。
- 认知计划、技能库和策略统计现在可以通过任务 ID 关联。
- 完整测试仍为 83 项通过。

当前状态：P3 的结构化技能底座已完成；下一步将把 `connect/douyin/lessons.mjs` 的经验转为候选技能，并接入真实技能运行记录和验证回滚。

### 2026-11-15：P3 抖音运行记录接入

- `scripts/douyin.mjs --comment` 自动登记 `douyin.post_comment` 候选技能并记录运行结果。
- `--reply-match` 自动登记 `douyin.reply_comment` 候选技能并记录成功、失败、合规拦截和耗时。
- 技能运行失败阶段会记录为 `compliance`、`post_comment` 或 `reply_comment`，真实发送成功才标记 `verified=1`。
- 现有经验本和合规闸门保持不变；技能记录只观察和统计，不自动放开操作权限。
- 完整测试：76 项通过。
