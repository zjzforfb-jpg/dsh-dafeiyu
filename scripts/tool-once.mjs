#!/usr/bin/env node
/**
 * 跑一次**只读工具**并把证据写进账本。
 *
 * 只读工具（查天气 / 看作品 / 看评论表 / 读能力卡 / 看设备页面）走的是 runTool，
 * 不经过任务与判定链，所以账本里永远「没跑过」。这个脚本补上证据：
 * 真跑一次 → 把输出摘要与 verdict 记进 task_checkpoints（operation = 工具名）。
 *
 *   node scripts/tool-once.mjs weather.get
 *   node scripts/tool-once.mjs --all          # 5 个只读工具全跑一遍
 *   node scripts/tool-once.mjs --list         # 看有哪些只读工具
 */
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { projectRoot, runtimeDir } from '../connect/core/paths.mjs';
import { READONLY_TOOLS, runTool } from '../connect/qq/tools.mjs';
import { openDouyinDb } from '../connect/douyin/store.mjs';
import { initCheckpoints, recordCheckpoint } from '../connect/core/checkpoints.mjs';

const root = projectRoot(process.cwd());
const db = new DatabaseSync(join(runtimeDir(root), 'connect', 'connect.sqlite'));
initCheckpoints(db);

const names = READONLY_TOOLS.map((tool) => tool.name);
if (process.argv.includes('--list')) {
  console.log(names.join('\n'));
  process.exit(0);
}
const targets = process.argv.includes('--all') ? names : process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
if (!targets.length) {
  console.error('用法：node scripts/tool-once.mjs <工具名> | --all | --list');
  process.exit(1);
}

const douyinDb = openDouyinDb(root);
let failed = 0;
for (const name of targets) {
  if (!names.includes(name)) {
    console.error(`✗ ${name}：不是只读工具（写操作要走任务 + 确认）`);
    failed += 1;
    continue;
  }
  const started = Date.now();
  const result = await runTool({ tool: name, args: {} }, { root, douyinDb });
  const ms = Date.now() - started;
  // 只读工具没有「副作用」可核，它返回的那段文字本身就是证据：
  // 拿得到内容 = confirmed（reason 写 ok_text，别伪装成「有回执」），抛错 = failed。
  const empty = !String(result.text ?? '').trim();
  const judged = result.ok && !empty
    ? { verdict: 'confirmed', reason: 'ok_text' }
    : { verdict: 'failed', reason: result.ok ? 'empty_output' : 'action_failed' };
  recordCheckpoint(db, {
    taskId: `tool-once-${name}`,
    stage: 'act',
    stepKey: `${name}:${started}`,
    operation: name,
    input: {},
    output: { ok: result.ok, ms, text: String(result.text ?? '').slice(0, 400) },
    verdict: judged.verdict,
    reason: judged.reason ?? '',
    ok: judged.verdict === 'confirmed',
    now: started,
  });
  console.log(`${result.ok ? '✓' : '✗'} ${name} ${ms}ms ${judged.verdict}${judged.reason ? ` / ${judged.reason}` : ''}`);
  console.log(`  ${String(result.text ?? '').replace(/\s+/gu, ' ').slice(0, 160)}`);
  if (!result.ok) failed += 1;
}
douyinDb?.close?.();
db.close();
process.exit(failed ? 1 : 0);
