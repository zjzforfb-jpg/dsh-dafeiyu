# 技能与学习（skills-learning）

已有骨架：skill_registry/skill_versions（preconditions/steps/postconditions/fallback/confidence）+ skill_runs（success/verified/failure_stage）+ skill_proposals；失败按 skill:failure:stage 聚合到 learning_proposals，≥2 次且有 verified 成功 run 才能 validate；strategy_trials 给策略打分。

现状：表存在但全 0 行；只有 scripts/douyin.mjs 两处记账；steps/postconditions/fallback 都是空；无消费者把 skill_proposal 升级为版本。
改造方向：接电 + 补步骤判据/阻断处理，不要另建一套（见 P0–P5 计划）。
