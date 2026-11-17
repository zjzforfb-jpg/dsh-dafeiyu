#!/usr/bin/env node
// 手动跑一次夜间整理：事实候选抽取 + 失败经验蒸馏 + 学习闭环扫一遍。
//
// 用法：
//   node scripts/housekeeping.mjs                 # 全跑
//   node scripts/housekeeping.mjs --dry           # 只看会做什么
//   node scripts/housekeeping.mjs --facts-only    # 只抽事实
//   node scripts/housekeeping.mjs --confirm       # 抽完把「爸爸明确说过记住」的候选直接确认
import { DatabaseSync } from 'node:sqlite';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFactCandidates, listFactCandidates, confirmFactCandidate } from '../connect/fact-candidates.mjs';
import { distillLessons } from '../connect/core/lessons-distill.mjs';
import { initReflections, listReflections } from '../connect/reflection.mjs';
import { migrate } from '../brain/migrations.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dry = args.includes('--dry');
const factsOnly = args.includes('--facts-only');
const confirm = args.includes('--confirm');
const day = (args[args.indexOf('--day') + 1]) || new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

const connect = new DatabaseSync(resolve(root, 'runtime/connect/connect.sqlite'));
connect.exec('PRAGMA busy_timeout=3000');
initReflections(connect);
const memory = new DatabaseSync(resolve(root, 'runtime/dsh-home/dafeiyu-memory.sqlite'));
memory.exec('PRAGMA busy_timeout=3000');
migrate(memory);

let facts = 0;
const ids = dry ? [] : extractFactCandidates(memory, day);
facts = ids.length;
console.log(`${dry ? '[dry] ' : ''}事实候选：新增 ${facts} 条（${day}）`);

if (confirm && !dry) {
  const candidates = listFactCandidates(memory, { status: 'candidate', limit: 200 });
  let confirmed = 0;
  for (const row of candidates) {
    // 只自动确认「爸爸明确让我记住」的事实；偏好类留给他自己点头。
    if (row.predicate !== 'fact' || Number(row.confidence) < 0.85) continue;
    if (confirmFactCandidate(memory, row.id, { reason: 'housekeeping_auto' })) confirmed += 1;
  }
  console.log(`自动确认事实：${confirmed} 条（只认 predicate=fact 且置信度≥0.85）`);
}

if (!factsOnly) {
  const distilled = dry ? { added: [] } : distillLessons(connect, { home: join(root, 'runtime/dsh-home'), minOccurrences: 2 });
  console.log(`失败经验：写入 ${distilled.added?.length ?? 0} 条${dry ? '（dry 不写）' : ''}`);
  for (const item of distilled.added ?? []) console.log(`  · ${item.text}`);
  const pending = listReflections(connect).filter((row) => row.status === 'candidate');
  console.log(`学习账本：${pending.length} 条候选待处理`);
}

const factCount = memory.prepare("SELECT COUNT(*) AS n FROM memory_facts WHERE status='confirmed'").get().n;
console.log(`长期事实：${factCount} 条`);
