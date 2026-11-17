# 决策脑与工具（planner-tools）

每条 QQ 消息先给 planner：输出 {say, steps:[{tool,args}]}；只读工具立即执行，结果作为事实回灌给模型；写工具只建任务等爸爸确认。

入口：
- qqPlanner（connect/qq/planner.mjs），prompt 在 PERSONA/SCHEMA
- READONLY_TOOLS / WRITE_TOOLS / normalizeSteps / runTool（connect/qq/tools.mjs）
- service.handle 的顺序：审批 → planner → 读工具 → 事实 → 回复 → 写任务

状态：纯聊天不调工具；写操作必须落任务；有 50 次/天模型预算。
已知坑：工具 ok 只代表命令没崩，不代表事情做成（步骤校验缺口，P0 待做）。
