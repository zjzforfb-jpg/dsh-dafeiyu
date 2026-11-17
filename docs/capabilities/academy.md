# 成长学院（academy）

12 门课 / 四阶段 / 每门 7 步（导入→知识→案例→模仿→实践→考核→总结）；Lv1–Lv4 认证按真实战绩；毕业项目 12 项；周日周记。

入口：
- COURSES / LESSON_STEPS（courses.mjs）
- runStudyStep（study.mjs）写 study_sessions + growth_archive；resetAcademy 保档案
- certify（levels.mjs）、graduationState、writeWeekly
- 动作 academy.study / academy.weekly

状态：已跑真 LLM；考核分数解析与降级兜底可用。
