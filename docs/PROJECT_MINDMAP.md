# 大肥鱼项目思维导图

```mermaid
mindmap
  root((大肥鱼 DaFeiYu))
    桌面宠物
      dsh-pet
      Mac 悬浮窗口
      拖拽与动画
      桌面活动
      对话入口
    Brain 大脑
      Brain HTTP API
      DeepSeek
      persona.md
      记忆召回
      动态人格状态
      后天特征
      生命循环
    记忆系统
      每日事件
        微信
        QQ
        桌面
        语音转写
      长期事实
        memories
        memory_facts
        修订
        删除
        冲突替换
      事实候选
        candidate
        confirmed
        superseded
        rejected
      事件流水
        agent_events
        去重
        来源
        隐私范围
    认知中枢
      工作任务
        working_tasks
        当前步骤
        下一动作
        环境快照
      认知计划
        目标
        环境
        记忆
        技能
        步骤
      权限检查
        爸爸确认
        群聊冻结
        风险等级
      失败恢复
        unknown
        重新观察
        replan
    技能学习
      技能库
        skill_registry
        skill_versions
        skill_runs
      抖音技能
        打开评论
        读取评论
        回复评论
        验证回复
      策略试验
        strategy_trials
        成功率
        耗时
        重试
      反思
        learning_proposals
        失败阶段
        重复问题
        验证升级
    Connect 中枢
      HTTP API
      WebSocket
      任务队列
      统一回执
      稳定性观察
      性能统计
    渠道
      微信 iLink
        文字
        语音识别
        音频文件回复
      QQ
        私聊
        群聊
        语音
        通话
      抖音
        读取互动
        回复评论
        图文发布
      Android
        Magic5
        Companion
        ADB
        UI 树
        截图
        Activity
    技术栈
      Node.js 22
      SQLite
      JavaScript ES Modules
      Kotlin Android
      WebSocket
      ADB
      DeepSeek API
      Whisper
      Silk 音频
      macOS LaunchAgent
    发布与运维
      npm test
      release:check
      稳定性窗口
      数据备份
      密钥扫描
      能力矩阵
```

## 核心逻辑

大肥鱼由桌面宠物、Brain 和 Connect 三个主要部分组成。

桌面宠物负责显示形象、接收桌面对话和展示状态动画。Brain 负责人格、记忆、模型调用和生命循环。Connect 负责微信、QQ、Android、抖音以及任务、权限、回执和稳定性管理。

## 一次桌面对话的流程

```text
爸爸输入消息
    ↓
dsh-pet
    ↓ HTTP
brain/server.mjs
    ↓
读取 persona.md
    ↓
读取动态人格状态和后天特征
    ↓
召回相关长期记忆
    ↓
读取近期生活记录
    ↓
调用 DeepSeek
    ↓
返回大肥鱼回复
    ↓
写入每日记忆、事件流水和必要的长期记忆
    ↓
桌面显示回复和活动动画
```

## 一次手机操作的流程

```text
爸爸提出目标
    ↓
Connect 创建任务
    ↓
working_tasks 保存当前状态
    ↓
环境观察
    ↓
认知中枢生成计划
    ↓
选择技能和策略
    ↓
Policy Engine 检查权限
    ↓
ADB / Companion 执行动作
    ↓
设备返回真实回执
    ↓
推进下一步骤或进入 unknown
    ↓
失败时重新观察和规划
    ↓
写入 skill_runs、strategy_trials 和 agent_events
```

## 记忆流程

```text
微信 / QQ / 桌面消息
    ↓
daily_memory_events
    ↓ 每日整理
daily_digest
    ↓
事实候选
    ↓ 爸爸确认
memory_facts
    ↓
长期记忆召回
```

普通消息只进入每日记忆。明确要求记住的内容，或者经过确认的事实，才进入长期记忆。被替代的旧事实保留历史，但不会继续参与上下文召回。

## 技术栈分工

| 层 | 技术 | 主要职责 |
|---|---|---|
| 桌面 | dsh-pet、Node.js | 悬浮形象、拖拽、动画、对话入口 |
| 大脑 | Node.js、DeepSeek API | 人格、记忆召回、对话、认知计划 |
| 数据 | SQLite、WAL | 记忆、任务、技能、事件和回执 |
| 手机 | Kotlin、WebSocket | Companion、通知、Overlay、手机状态 |
| 自动化 | ADB、UIAutomator、截图 | Magic5 观察和动作执行 |
| 通信 | 微信 iLink、QQ Bot、WebSocket | 多渠道收发消息和语音 |
| 音频 | Whisper、Silk、TTS | 语音识别、合成和传输 |
| 运维 | LaunchAgent、npm scripts | 自动启动、测试、备份、稳定性检查 |

## 当前能力边界

当前系统已经具备多渠道对话、记忆、任务、认知计划、技能统计和 Android 接入。抖音互动属于实验能力，Windows、小红书、哔哩哔哩和购物支付尚未接入。正式发布还需要完成168小时稳定性窗口。
