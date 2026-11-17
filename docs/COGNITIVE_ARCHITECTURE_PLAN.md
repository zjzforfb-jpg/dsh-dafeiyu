# 大肥鱼认知架构与自主学习引擎计划 V1.0

## 1. 计划目标

在不推翻现有 Node.js、SQLite、Connect、ADB 和桌宠架构的前提下，把大肥鱼从“多个渠道各自接入模型”升级为可追踪、可恢复、可学习的认知智能体。

目标不是让模型自行获得无限权限，而是建立以下闭环：

```text
感知 → 记忆调度 → 规划 → 权限判断 → 执行 → 真实回执 → 评价 → 经验与技能更新
```

大肥鱼的成长必须由可验证的经历驱动，不能通过随机修改人格提示词实现。

## 2. 当前基线与边界

### 已有能力

- `daily_memory_events`：跨微信、QQ、桌面渠道的每日事件流水。
- `memories`、`memory_facts`：明确确认的长期事实、偏好和共同经历。
- `memory_revisions`：记忆修订和删除审计。
- `brain/server.mjs`：人格、记忆召回、模型调用和桌面活动桥。
- `life/manager.mjs`：目标、每日探索、日记和预算。
- `connect/tasks.mjs`：外部任务、审批、幂等和过期处理。
- `connect/douyin/lessons.mjs`：抖音经验本雏形。
- ADB、Magic5 Companion、QQ、微信 iLink 和抖音适配器。

### 当前缺口

- 没有统一的全渠道事件模型。
- 当前任务状态和“已经发生的经历”仍然部分分散。
- 工作中任务缺少统一持久化状态和恢复策略。
- 抖音经验主要是文本笔记，不是可验证技能。
- 动作结果虽然已有回执基础，但尚未形成统一的轨迹评价和技能统计。
- 还没有自动事实候选、冲突合并和程序性记忆提炼流水线。

### 明确不做

- 暂不在线训练 DeepSeek 或直接修改模型权重。
- 暂不让模型绕过 Policy Engine 直接操控真实账号。
- 暂不把群聊内容自动升级为爸爸的私人事实。
- 暂不将强化学习直接接入真实抖音、微信或 QQ 账号。

## 3. 目标架构

```text
Identity Engine
  人格、身份、关系、价值观、表达风格

Memory Engine
  工作记忆、情景记忆、语义记忆、程序性记忆、反思记忆

Cognition Kernel
  情境理解、记忆调度、计划、决策、恢复

Learning Engine
  轨迹分析、反思、技能候选、策略统计

Policy Engine
  权限、审批、预算、风控、平台规则、熔断

Action Engine
  Mac、ADB、Companion、微信、QQ、抖音适配器

Evaluator
  回执验证、成功率、延迟、重试、回归结果
```

初期仍采用单机模块化架构，所有模块通过明确接口通信；只有出现真实负载或稳定性需求时才拆分进程。

## 4. 五类记忆模型

| 类型 | 记录内容 | 生命周期 | 是否直接进入上下文 |
|---|---|---|---|
| 工作记忆 | 当前页面、任务步骤、下一动作 | 任务结束或恢复后清理 | 仅当前任务 |
| 情景记忆 | 一次任务的观察、动作、结果和失败 | 长期保留摘要，原始轨迹按策略保留 | 按任务召回 |
| 语义记忆 | 爸爸的事实、偏好、关系和知识 | 长期，可修订 | 相关时召回 |
| 程序性记忆 | 可复用的操作流程和恢复方法 | 版本化管理 | 选中技能时召回 |
| 反思记忆 | 从多次经历形成的规律和注意事项 | 长期，需证据支持 | 低频召回 |

原有 `memories`、`memory_facts` 和 `daily_memory_events` 保留；新增表通过事件、任务和来源 ID 关联，不迁移破坏旧数据。

## 5. 分阶段开发计划

### P0：基线与观测（1–2天）

目标：在改行为前先知道系统当前表现。

工作：

- 建立统一事件 ID、任务 ID、技能运行 ID 的命名规则。
- 记录感知、决策、执行、验证各阶段耗时。
- 为抖音、QQ、微信和桌面定义成功、失败、未知三态。
- 建立操作轨迹脱敏策略，不保存密码、验证码、Token 和完整敏感页面。
- 固定当前真实能力矩阵和稳定性门槛。

验收：每次外部动作都能从事件 ID 追踪到任务、回执和记忆；现有 71 项测试继续通过。

### P1：统一事件采集（3–5天）

新增 `agent_events`，建议字段：

```text
id, event_type, channel, conversation_id, task_id, skill_run_id,
actor, payload, result, evidence, privacy_scope, created_at
```

事件类型至少包括：

- message_received
- message_replied
- observation_created
- plan_created
- action_requested
- action_started
- action_finished
- action_failed
- receipt_verified
- user_corrected
- reflection_created

所有渠道接入 `recordAgentEvent()`，不能各自写私有格式。

验收：微信、QQ、桌面和抖音各完成一条完整轨迹；事件可去重，重启后不会重复写入。

### P2：认知中枢与工作状态（5–7天）

新增 `working_tasks` 或在现有任务表中扩展：

```json
{
  "task_id": "...",
  "goal": "处理抖音互动消息",
  "status": "running",
  "environment": { "device": "Magic5", "app": "douyin", "screen": "comments" },
  "current_step": "open_reply",
  "selected_skill": "douyin.reply_comment.v1",
  "retry_count": 0,
  "last_observation_id": "...",
  "next_action": "tap_reply"
}
```

`Cognition Kernel` 负责：

1. 接收目标。
2. 读取当前环境。
3. 调度相关记忆和技能。
4. 生成有限步骤计划。
5. 交给 Policy Engine 检查。
6. 调用 Action Engine。
7. 根据回执决定完成、重试、重新观察或停止。

验收：模型中断、手机断开、服务重启后，任务不会盲目续做；恢复时必须先重新观察环境。

### P3：程序性记忆与技能库（1–2周）

新增：

- `skill_registry`
- `skill_versions`
- `skill_runs`
- `skill_proposals`

技能对象必须包含：

```text
skill_id, name, version, preconditions, steps, postconditions,
fallback, environment, success_count, failure_count,
avg_duration, confidence, status, created_at, updated_at
```

技能状态：

```text
candidate → validating → enabled → deprecated
```

现有 `connect/douyin/lessons.mjs` 继续保留，作为经验输入；经验只有经过至少一次独立验证，才可生成候选技能。技能升级必须可回滚。

首批技能范围：

- `android.observe_screen`
- `android.recover_screen`
- `douyin.open_comments`
- `douyin.read_comments`
- `douyin.reply_comment`
- `douyin.verify_reply`

验收：同一技能至少有成功和失败记录；技能选择依据成功率、环境匹配度和最近验证时间，而不是模型主观描述。

### P4：结果评价和经验反思（1周）

每次技能运行生成评价：

```json
{
  "success": true,
  "verified": true,
  "duration_ms": 8200,
  "retry_count": 1,
  "failure_stage": null,
  "lessons": ["点击后先确认评论面板可见"]
}
```

经验提炼规则：

- 单次失败只生成候选反思。
- 同类问题重复出现至少两次，才提高经验权重。
- 经过成功复现后，才允许升级技能。
- 反思不能直接改变人格核心。

验收：失败会形成可追踪的候选经验，但不会污染当前已启用技能。

### P5：策略优化（2周以上）

先做统计和 Contextual Bandit，再考虑离线微调：

- 比较 UI 树、文本定位、坐标回退的成功率。
- 根据页面状态选择策略。
- 奖励同时考虑成功、验证、延迟、重试和合规。
- 重复操作、误点击、未确认发送给予强负反馈。

暂不做在线 RL。没有足够轨迹、隔离测试环境和稳定奖励模型前，不允许策略自动控制真实账号。

验收：策略优化后成功率提升，且误操作率、违规率和重复发送率不升高。

### P6：人格与长期成长（持续阶段）

人格分为：

- `Identity Core`：稳定身份、性格、价值观和行为边界。
- `Dynamic State`：当前情绪、精力、兴趣和关注点。
- `Acquired Traits`：经过证据积累形成的偏好、技能和知识。

人格核心只能由明确配置或爸爸明确指令修改；后天成长只影响知识、偏好、技能和反思，不直接改写核心人格。

验收：跨渠道表达一致；一次失败不会导致人格漂移；兴趣和偏好变化有来源和时间依据。

## 6. 核心接口约定

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

所有接口必须返回结构化结果，不允许用自然语言“已完成”代替真实回执。

## 7. 关键评价指标

### 记忆

- 召回准确率。
- 错误召回率。
- 冲突率。
- 删除后残留召回率，目标为 0。
- 检索 p50/p95 延迟。

### 认知

- 任务完成率。
- 重启恢复成功率。
- 计划执行偏差。
- 未验证动作继续率，目标为 0。

### 技能

- 技能成功率。
- 平均耗时。
- 平均重试次数。
- 技能回归失败率。
- 不同设备和页面版本下的成功率。

### 人格

- 人格一致性。
- 关系记忆准确率。
- 偏好更新可解释性。
- 跨渠道表达一致性。

## 8. 发布门槛

每个阶段必须满足：

- 单元测试和回归测试通过。
- 旧数据库可以自动迁移。
- 可恢复、可取消、可回滚。
- 真实动作具备可验证回执。
- 失败不会伪造成功。
- 不泄露密钥和敏感页面内容。
- 群聊权限边界保持有效。
- 观测窗口达到项目设定的稳定性要求。

## 9. 推荐近期执行顺序

当前最合理的执行顺序是：

```text
P0 统一观测
→ P1 全渠道事件
→ P2 工作状态与恢复
→ P3 抖音技能库
→ P4 结果评价与反思
→ P5 策略统计优化
→ P6 人格成长
```

先完成 P0–P2，才能知道后续技能到底是否真的变快、变稳、变聪明。直接跳到强化学习或自动人格成长，会让错误、噪音和未验证动作一起被放大。
