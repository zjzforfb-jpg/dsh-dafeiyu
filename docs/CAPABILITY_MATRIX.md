# 大肥鱼能力状态矩阵

状态含义：

- `stable`：有自动测试、真实端到端验收和观察记录。
- `real_verified`：真实设备/平台通过，但观察窗口尚未完成。
- `prototype`：代码或脚本存在，边界和失败回执仍不完整。
- `disabled`：为稳定性或权限原因暂时关闭。
- `not_implemented`：没有可执行适配器。

| 渠道 | 能力 | 状态 | 当前边界 |
| --- | --- | --- | --- |
| 桌面 | 悬浮宠物、基础对话 | stable | Mac 主路径 |
| 桌面 | 情绪/任务真实联动 | prototype | 需 task_id 和真实回执 |
| 记忆 | 事实、共同经历、修订、删除 | real_verified | 多渠道统一传播仍在治理 |
| 生活 | 探索、日记、目标、预算 | real_verified | 尚未完成 7 天观察 |
| 微信 iLink | 文字问答 | real_verified | 账号/联系人策略有效 |
| 微信 iLink | 语音识别 | real_verified | 本机 Whisper，受音频质量影响 |
| 微信 iLink | M4A 音频回复 | real_verified | 用户已确认可播放 |
| 微信 iLink | 原生语音气泡 | disabled | 接口接受但客户端未显示 |
| QQ | 私聊/群聊文字 | real_verified | 群聊外部动作冻结 |
| QQ | 语音条/对讲 | prototype | 音频桥与长时间稳定性待观察 |
| QQ | 群聊抖音/电话/发布动作 | disabled | Phase 0 安全冻结 |
| 抖音 | 读取互动 | prototype | UI/账号状态可能变化 |
| 抖音 | 回复评论 | prototype | 需统一任务回执和幂等 |
| 抖音 | 点赞评论 | not_implemented | 不得进入可用能力提示 |
| 抖音 | 图文发布 | prototype | 有审批脚本，需正式任务回执 |
| Android | Magic5 配对、在线、通知 | real_verified | 休眠/重启观察不足 |
| Android | 跨 App 自动操作 | prototype | ADB/UI 变化会导致失败 |
| 电话 | QQ/微信拨号和音频桥 | prototype | 非官方机器人能力，风险高 |
| 小红书 | 读取/发布/评论 | not_implemented | 未接入 |
| 哔哩哔哩 | 读取/发布/评论 | not_implemented | 未接入 |
| Windows | 桌面部署 | not_implemented | 延后 |
| 购物/付款 | 全部 | not_implemented | 不进入自动动作提示 |

任何状态变化都必须同时更新本表、自动测试记录、实机验收记录和版本号。
