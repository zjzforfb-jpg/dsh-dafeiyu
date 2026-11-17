#!/usr/bin/env node
/**
 * 把「跑通进度」写成 Markdown 落进 docs/TOOL-RUNBOOK.md。
 *
 * 页面上的报告是「此刻的状态」，仓库里这份是「隔几天还能对照的记录」。
 * 只统计库里真实发生的事；没跑过就写没跑过，不编。
 *
 *   node scripts/runbook-progress.mjs          # 直接更新 runbook 里的进度块
 *   node scripts/runbook-progress.mjs --dry    # 只打印，不写文件
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { projectRoot, runtimeDir } from '../connect/core/paths.mjs';
import { toolList } from '../connect/live/api.mjs';
import { commentQuota } from '../connect/live/quota.mjs';
import { VERDICT_LABEL, reasonText, shortClock } from '../connect/live/reason-text.mjs';

const START = '<!-- progress:start -->';

/** 本地时间戳（YYYY-MM-DD HH:MM），别用 UTC 给人看。 */
function stampOf(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const END = '<!-- progress:end -->';

const root = projectRoot(process.cwd());
const db = new DatabaseSync(join(runtimeDir(root), 'connect', 'connect.sqlite'));
const now = Date.now();

const list = toolList(db, now);
const cov = list.coverage ?? { total: 0, confirmed: 0, unconfirmed: 0, failed: 0, mismatched: 0, untested: 0 };
const quota = commentQuota(root, { now });

const rows = [];
const push = (action, verdict, reason, at, weekRuns = 0, thin = false) => {
  const label = verdict ? (VERDICT_LABEL[verdict] ?? verdict) : '没跑过';
  const why = reason ? reasonText(reason) : '';
  // 样本次数只算「真实业务」（页面手动跑的 ui-run-* 不算），少了就标出来
  const sample = weekRuns <= 0 ? '—' : `${weekRuns}${thin ? '（少）' : ''}`;
  rows.push(`| \`${action}\` | ${label} | ${why || '—'} | ${sample} | ${at ? shortClock(at) : '—'} |`);
};

for (const item of list.items) {
  // 只读工具不走判定链，单独归一段，别混进「没跑过」
  if (item.readOnly) continue;
  push(item.action, item.lastVerdict, item.lastVerdictReason, item.lastVerdictAt, item.weekRuns ?? 0, item.weekRuns > 0 && item.weekRuns < 3);
}

const lines = [
  START,
  '',
  `_生成于 ${stampOf(now)}_`,
  '',
  `- 覆盖度：**${cov.confirmed}/${cov.total} 已确认**（未确认 ${cov.unconfirmed ?? 0} · 失败 ${(cov.failed ?? 0) + (cov.mismatched ?? 0)} · 没跑过 ${cov.untested ?? 0}）`,
  `- 评论额度：本小时还剩 **${quota.hourlyLeft}/${quota.hourlyCap}**，今天已发 ${quota.dailyUsed} 条（上限 ${quota.dailyCap}）`,
  `- 生成命令：\`node scripts/runbook-progress.mjs\``,
  '',
  '| 动作 | 最近判定 | 理由 | 本周真实次数 | 时间 |',
  '|---|---|---|---|---|',
  ...rows,
  '',
  `> 只读工具（${list.items.filter((item) => item.readOnly).length} 个：查天气 / 看作品 / 看评论表 / 读能力卡 / 看设备当前页面）不产生判定，未列在此表。`,
  '',
  END,
].join('\n');

const docPath = join(root, 'docs', 'TOOL-RUNBOOK.md');
const doc = readFileSync(docPath, 'utf8');
const block = doc.includes(START) && doc.includes(END)
  ? doc.slice(0, doc.indexOf(START)) + lines + doc.slice(doc.indexOf(END) + END.length)
  : `${doc.trimEnd()}\n\n## 当前进度\n\n${lines}\n`;

if (process.argv.includes('--dry')) {
  console.log(lines);
} else {
  writeFileSync(docPath, block);
  console.log(`已更新 ${docPath}：${cov.confirmed}/${cov.total} 已确认，没跑过 ${cov.untested ?? 0}`);
}
db.close();
