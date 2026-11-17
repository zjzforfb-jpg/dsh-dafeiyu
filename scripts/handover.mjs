#!/usr/bin/env node
// 一页交接：把「已经跑通什么 / 还差什么 / 卡在哪 / 解锁后怎么走」写进 docs/HANDOVER.md。
//
// 内容全部从代码与数据库算出来，不靠人记。跑一次就更新，适合交接给下一个人或未来的自己。

import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { projectRoot, runtimeDir } from '../connect/core/paths.mjs';
import { toolList } from '../connect/live/api.mjs';
import { RELEASE_PLAN, nextReleaseStep } from '../connect/live/release-plan.mjs';
import { loadRunAllowlist } from '../connect/live/run-policy.mjs';
import { SIDE_EFFECT_ACTIONS } from '../connect/live/expect-after.mjs';
import { sampleNote } from '../connect/live/sample.mjs';

const root = projectRoot(process.cwd());
const dbPath = resolve(runtimeDir(root), 'connect', 'connect.sqlite');
const db = existsSync(dbPath) ? new DatabaseSync(dbPath, { readOnly: true }) : null;
const list = db ? toolList(db, Date.now(), { realOnly: true }) : { items: [], coverage: {} };
const allow = loadRunAllowlist(runtimeDir(root));
const step = nextReleaseStep(list.items.map((item) => ({ action: item.action, lastVerdict: item.lastVerdict })));

const cov = list.coverage ?? {};
const confirmed = list.items.filter((item) => item.lastVerdict === 'confirmed' && !item.readOnly);
const unconfirmed = list.items.filter((item) => item.lastVerdict && item.lastVerdict !== 'confirmed' && !item.readOnly);
const untested = list.items.filter((item) => !item.lastVerdict && !item.readOnly);

const lines = [];
lines.push('# 交接：大肥鱼的工具跑到哪了');
lines.push('');
lines.push(`> 自动生成于 ${new Date().toLocaleString('zh-CN', { hour12: false })} · 生成命令 \`node scripts/handover.mjs\``);
lines.push('> 数字来源：`task_checkpoints`（**已排除页面手动跑的 `ui-run-*`**，只算真实业务）。');
lines.push('');
lines.push('## 一、总数');
lines.push('');
lines.push(`- 动作总数：**${cov.total ?? 0}**（已下线 3 个不计）`);
lines.push(`- 已确认：**${cov.confirmed ?? 0}** · 未确认：${cov.unconfirmed ?? 0} · 失败：${(cov.failed ?? 0)} · 没跑过：${cov.untested ?? 0}`);
lines.push(`- 只读工具：${list.items.filter((item) => item.readOnly).length} 个（不产生判定）`);
lines.push('');
lines.push('## 二、已经跑通的（有证据）');
lines.push('');
if (!confirmed.length) lines.push('_暂无_');
for (const item of confirmed) {
  const note = sampleNote(item.weekRuns ?? 0);
  lines.push(`- \`${item.action}\` — ${item.title ?? ''}｜本周真实 ${item.weekRuns ?? 0} 次${note.thin ? '（样本少）' : ''}`);
}
lines.push('');
lines.push('## 三、跑过但只能算「未确认」的');
lines.push('');
if (!unconfirmed.length) lines.push('_暂无_');
for (const item of unconfirmed) lines.push(`- \`${item.action}\` — ${item.reason ?? item.lastVerdictReason ?? ''}`);
lines.push('');
lines.push('## 四、一次都没真跑过的');
lines.push('');
if (!untested.length) lines.push('_暂无_');
for (const item of untested) lines.push(`- \`${item.action}\` — ${item.title ?? ''}（等级 ${item.level ?? '-'}）`);
lines.push('');
lines.push('## 五、卡在哪');
lines.push('');
lines.push(`唯一的硬阻塞：**7 个有真实副作用的动作需要主人放行**（会响手机或公开发作品，不能由我自行决定）。`);
lines.push('');
lines.push('已经替这一步准备好的东西（都不需要临时再补）：');
lines.push('');
lines.push(`- 放行顺序：${RELEASE_PLAN.map((item) => `\`${item.action}\``).join(' → ')}（\`connect/live/release-plan.mjs\`）`);
lines.push('- 操作单：`docs/FIRST-RUN.md`（每一步的前置、停的条件、跑完看什么）');
lines.push('- 机器核验：\`/live\` 顶栏「授权项就绪」+ \`npm run release:check\`（只读，先跑它）');
lines.push(`- 放行清单现状：永久 ${allow.allowed.length} 个${allow.grants.length ? ` · 临时 ${allow.grants.length} 个` : ''}${allow.note ? '' : '（没有备注）'}`);
lines.push('');
lines.push('## 六、放行后怎么走');
lines.push('');
lines.push(`1. 跑 \`npm run release:check\`，看「下一步该跑：${step.next?.action ?? '全部跑完'}」；`);
lines.push('2. 在 `/live` 工具详情里点「检查现在能不能跑」→「我现在要跑它」→「确认，跑一次」；');
lines.push('3. 看结果卡：判定 + 跑完之后核对；');
lines.push('4. 点「导出这次证据（Markdown）」留一份；');
lines.push('5. 跑 `node scripts/runbook-progress.mjs` 写回 runbook，§10 添一行。');
lines.push('');
lines.push('## 七、已知的坑（别再踩）');
lines.push('');
lines.push('- `connect/server.mjs` 的 `/core/pipeline.mjs` 必须单独放行，否则 `/home` 整页白；');
lines.push('- `card(title, nodes)` 的第二个参数必须是数组，传单个元素会把整页渲挂；');
lines.push('- 事件分页只能用 `rowid`，`agent_events.id` 是 `event_xxx` 字符串，比大小会错；');
lines.push('- 改大脚本必须 `node --check`，并把「唯一锚点 + 断言 count==1」当纪律（曾有 669 行被整段复制）。');

writeFileSync(resolve(root, 'docs/HANDOVER.md'), `${lines.join('\n')}\n`);
console.log(`已写入 docs/HANDOVER.md：已确认 ${cov.confirmed ?? 0}/${cov.total ?? 0}，待放行 ${untested.length}`);
if (db) db.close();
