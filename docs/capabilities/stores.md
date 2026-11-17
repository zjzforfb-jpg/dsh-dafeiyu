# 数据层（stores）

- connect.sqlite：external_tasks/working_tasks、qq_messages、agent_events、plan_slots、mood_history、growth_archive/study_sessions、skill_*、strategy_trials、learning_proposals
- douyin.db：works、comments、videos、hot_comments、fans、hotspots、work_stats_history
- 任务状态机在 connect/tasks.mjs；事件在 connect/agent-events.mjs（EVENT_TYPES 白名单）

注意：boardList 的 root 必须是项目根（resolve(root,'..','..')）。
