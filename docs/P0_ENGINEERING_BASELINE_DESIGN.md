# P0 工程基线：审查后的设计与执行记录

版本：2026-11-14。范围：Git 基线、SQLite 迁移、备份与恢复、配置与运行数据分层。

本文重审原 P0 方案，并记录本次实施选择。目标是先保护现有运行数据，再给后续记忆、任务和设备功能提供可升级的底座。

## 1. 审查结论与调整

| 原方案 | 结论 | 调整理由与本版决定 |
| --- | --- | --- |
| 用 `PRAGMA user_version` 集中管理 schema | 采纳 | 当前 `kind` 列和 `life_events` 表分散在两个入口。统一迁移避免新模块各自建表、数据库版本漂移。迁移使用 `BEGIN IMMEDIATE` 和 JS `up(db)`，兼容“当前库已含表但 `user_version=0`”。 |
| 用 `VACUUM INTO` 做一致性备份 | 改为 Node SQLite Backup API | 项目已使用 Node 22.16+ 的 `node:sqlite`；`backup(db, path)` 直接提供 SQLite 在线备份接口，避免手工拼 SQL 路径，也适合现有 WAL 数据库。产物仍需完整性检查。 |
| 把备份放仓库根目录 `backups/` | 改到 `runtime/backups/` | `runtime/` 已是明确的本机运行数据根目录，整个目录已被 Git 忽略。这样数据库、令牌、备份和桌宠运行数据保持同一保护边界。 |
| 恢复前删除数据库、WAL、SHM，再复制备份 | 加强为“先验证、先留安全副本、同目录替换、失败回滚” | 删除后再复制存在中断时失去原库的风险。恢复文件先做完整性和表结构检查；活库先生成安全快照；旧主库及 sidecar 暂存，替换失败时恢复原文件。 |
| 恢复前检查固定的 3110 健康接口 | 采纳并说明边界 | 当前记忆桥固定在 loopback 3110。探测成功时拒绝恢复，避免覆盖活库。连接失败不能代替停止服务，因此文档仍要求先停止 LaunchAgent。 |
| 增加秘密扫描测试 | 本轮不加入自动测试 | 仓库边界先通过 `.gitignore` 和 staged file 检查建立。后续可补独立的卫生扫描，但 P0 不把密钥正则当作完整防泄漏保障。 |

## 2. 当前数据与运行边界

- 数据库：`runtime/dsh-home/dafeiyu-memory.sqlite`，SQLite WAL 模式，含 `turns`、`memories`、`life_events`。
- 运行配置：`runtime/dsh-home/dsh-pet/main-config.jsonc` 和 `standalone-ai.json`。其中本地桥接令牌只用于本机服务，不是 DeepSeek API Key。
- API Key：macOS 钥匙串；不会放入 Git、数据库或备份。
- 桌宠近期聊天文件、运行日志和 Electron 文件也在 `runtime/`；本版数据库备份只涵盖大肥鱼的 SQLite 记忆/日常记录，不涵盖桌宠聊天历史或用户界面配置。
- 项目模板：根目录 `config/` 可入库；运行时第一次启动把模板复制到 `runtime/`，之后运行态配置以 `runtime/` 为准。

## 3. SQLite 迁移策略

`brain/migrations.mjs` 是唯一 schema 版本来源。所有数据库打开入口调用 `migrate(db)`，不要在业务模块自行 `CREATE TABLE`。

| `user_version` | 迁移名 | 内容 |
| --- | --- | --- |
| 1 | `baseline-memory` | 创建 `turns`、`memories` 基础表；使用 `IF NOT EXISTS` 接纳已存在的同名表 |
| 2 | `memory-kind-column` | 检查 `memories.kind`；缺少时添加 `TEXT NOT NULL DEFAULT 'fact'` |
| 3 | `life-events` | 创建日常任务表；已有表保持原样 |
| 4 | `memory-provenance-revisions` | 记忆类型、来源、可信度、上下文开关与修订历史 |
| 5 | `durable-task-queue-and-budget` | 持久任务队列、状态、幂等键和每日预算 |
| 6 | `long-term-goals` | 长期目标、进度记录和任务目标关联 |
| 7 | `service-run-heartbeats` | 服务实例、心跳、正常停止与异常恢复记录 |

升级顺序必须兼容三种输入：全新数据库；旧库中已有记忆但没有 `kind`；当前运行库已含 `kind` 和 `life_events`、版本号仍为 0。每个版本在一个 `BEGIN IMMEDIATE` 事务中执行，成功后更新 `user_version` 并提交；失败则回滚并抛出包含版本号的错误。迁移应可重复运行，不删除或重建已有业务数据。

未来 schema 变更只追加迁移，不修改已发布迁移的行为。迁移失败时服务启动失败并写错误日志；不能降级成空库继续运行。

## 4. 备份与恢复

### 备份

- 命令：`npm run data:backup`；可选 `--keep N`，默认保留最近 7 份普通快照。
- 默认目录：`runtime/backups/`，文件名带 UTC 时间；目录权限 `0700`，数据库文件权限 `0600`。
- 通过 `node:sqlite` `backup()` 从打开的源库生成单文件快照；不直接拷贝 WAL 数据库文件。
- 备份后打开快照运行 `PRAGMA integrity_check`，并输出记忆条数。校验失败时该文件不得报告为成功备份。
- 轮换只删除按 `dafeiyu-*.sqlite` 命名的普通快照，保留 `before-restore-*.sqlite` 安全副本。

### 恢复

- 命令：`npm run data:restore -- <备份路径> --confirm`。必须明确提供路径和 `--confirm`。
- 先验证来源文件可读、`integrity_check` 为 `ok`、包含 `memories` 表；再检测 `127.0.0.1:3110/health`。若记忆桥仍运行则拒绝替换。
- 对现有数据库先用同一 Backup API 生成 `before-restore-*.sqlite` 安全副本。将恢复文件复制到目标目录的临时文件，再暂存原数据库及 `-wal`、`-shm` 文件，最后原子重命名。
- 替换失败时恢复旧文件；成功后保留安全副本供人工回退。恢复后启动服务，由 schema 迁移负责把备份升级到最新版本。
- 标准流程是先 `npm run service:stop`，恢复后 `npm run service:start`。工具层的 3110 探测只是第二道保护。

## 5. Git 与配置卫生

- 当前仓库在 P0 前未初始化；默认分支为 `main`。
- `.gitignore` 忽略 `node_modules/`、整个 `runtime/`、SQLite/DB 文件及 sidecar、日志、`.env` 和桌宠本地运行令牌。
- Git 首次提交只包含源代码、锁文件、公开配置模板、文档和预览图。不能提交 `runtime/`、备份、钥匙串导出或任何用户日志。
- 不把忽略规则当作加密：备份仍是可读取的 SQLite 文件。需要异地备份时，应另行采用用户控制的加密存储。
- `config/` 是公开模板；`runtime/` 是用户运行态；`runtime/backups/` 是本地备份。不要让模板覆盖已存在的运行配置。

## 6. 本次执行状态

- [x] 初始化 Git `main`，检查 staged 文件；`runtime/`、SQLite、桌宠运行配置和备份均被忽略。
- [x] 扩展忽略规则，增加 SQLite sidecar、`.env`、日志和本地 token 文件规则。
- [x] 创建 `brain/migrations.mjs`，迁移编号为 1–7；所有模块统一经 `openMemory()` 升级。
- [x] 实现 `npm run data:backup` 和 `npm run data:restore -- <path> --confirm`，默认快照保留 7 份。
- [x] 生成迁移前快照和迁移后快照，均位于 `runtime/backups/`；备份校验成功，最新快照记录 0 条长期记忆。
- [x] 将 Node 最低版本设为 22.16，以匹配 SQLite Backup API。
- [x] README 记录分层、备份/恢复流程和 Node 最低版本。
- [x] 重启 LaunchAgent，让当前运行库经过迁移；`PRAGMA user_version=7`，记忆、目标、任务和心跳表均存在。
- [x] 建立首次基线提交：`83d7e5c`（Establish DaFeiYu engineering baseline）。
- [x] 通过 GUI 用户域执行卸载/重新注册，验证服务可重新启动；真实注销/登录尚未实测。
- [x] 备份当前快照、停服、恢复同一快照并重新启动；恢复脚本留下安全副本。

## 7. 执行顺序与限制

1. Git 基线与数据边界已建立，运行数据仍被忽略。
2. 现有数据库已迁移到版本 7；只检查了 schema 和行数，没有输出私人记忆。
3. 快照恢复往返完成，服务恢复后健康检查通过。
4. 真实注销/重新登录仍需之后做一次实机验收。

本轮未运行自动化测试。服务重启、schema 元数据和备份恢复往返通过直接运行态操作确认。
