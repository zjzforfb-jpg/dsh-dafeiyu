#!/usr/bin/env node
// 决策脑回归集：30 句真实说法，跑一遍真 planner，看它分类对不对。
// 用法：node scripts/intent-regress.mjs [--json]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { qqPlanner } from '../connect/qq/planner.mjs';
import { lessonsFor } from '../connect/qq/lessons.mjs';
import { loadTargets } from '../connect/targets.mjs';

const home = join(process.cwd(), 'runtime', 'dsh-home');
const ownerPeerId = loadTargets().qq.dad || 'local-regression';
const WRITE_REPLY = 'douyin.reply_comments';
const WRITE_PUBLISH = 'douyin.publish';

export const CASES = [
  ['今天天气咋样啊', ['weather']],
  ['明天会下雨吗', ['weather']],
  ['石家庄冷不冷，要不要加衣服', ['weather']],
  ['家里空调开26度合适吗', ['weather', 'chat']],
  ['现在有新增的未回复评论吗？我们发布的作品数据咋样？', ['read']],
  ['我们发过哪些作品', ['read']],
  ['最近回的评论都回了些啥', ['read']],
  ['手机现在停在哪', ['device', 'read']],
  ['帮我把收到的评论都回一遍', ['write-reply']],
  ['去回复一下新评论', ['write-reply']],
  ['发个抖音图文去', ['write-publish']],
  ['发一条图文，主题你挑', ['write-publish']],
  ['给我讲个三打白骨精', ['chat']],
  ['你是谁呀', ['chat']],
  ['今天我好累', ['chat']],
  ['库里一共多少条评论', ['read']],
  ['昨天那条作品有几条评论', ['read']],
  ['评论都回完了吗', ['read']],
  ['把没回的评论都回一下', ['write-reply']],
  ['你帮我看看抖音现在什么情况', ['read', 'device']],
  ['今天几号了', ['chat']],
  ['我们发过的作品里哪条评论最多', ['read']],
  ['回复一下 LP0423 那条评论', ['write-reply']],
  ['发布一篇关于熬夜的图文', ['write-publish']],
  ['评论数据咋样了', ['read']],
  ['这几个评论你打算怎么回', ['read', 'chat']],
  ['把评论回复记录给我看看', ['read']],
  ['手机现在在抖音哪个页面', ['device', 'read']],
  ['哪些作品还没人评论', ['read']],
  ['算了，先别回评论了，陪我说说话', ['chat']],
];

export function categoryOf(steps = []) {
  const tools = steps.map((step) => step.tool);
  if (tools.includes(WRITE_PUBLISH)) return 'write-publish';
  if (tools.includes(WRITE_REPLY)) return 'write-reply';
  if (tools.includes('weather.get')) return 'weather';
  if (tools.includes('device.page')) return 'device';
  if (tools.length) return 'read';
  return 'chat';
}

// 问句不允许出现写工具：这是之前「问一句就建任务」那个 bug 的护栏。
export function forbidsWrite(text) {
  return /[?？]|吗|呢|咋样|多少|哪些|有没有|是不是/u.test(text);
}

async function main() {
  const planner = qqPlanner(home);
  const rows = [];
  for (const [text, expected] of CASES) {
    let got = 'error';
    let steps = [];
    try {
      const plan = await planner({ text, peerId: ownerPeerId, history: [], memories: [], today: '', lessons: lessonsFor(home, text) });
      steps = plan.steps ?? [];
      got = categoryOf(steps);
    } catch (error) {
      got = `error:${String(error?.message ?? error).slice(0, 40)}`;
    }
    const writeLeak = forbidsWrite(text) && steps.some((step) => String(step.tool).startsWith('douyin.'));
    const pass = expected.includes(got) && !writeLeak;
    rows.push({ text, expected: expected.join('|'), got, steps: steps.map((step) => step.tool), pass, writeLeak });
  }
  const passed = rows.filter((row) => row.pass).length;
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ passed, total: rows.length, rows }, null, 1));
  } else {
    for (const row of rows) {
      console.log(`${row.pass ? '✅' : '❌'} ${row.text.padEnd(28, ' ')} → ${row.got}${row.writeLeak ? '（问句里混进写工具）' : ''} [${row.steps.join(',') || '-'}]`);
    }
    console.log(`\n通过 ${passed}/${rows.length}（${Math.round((passed / rows.length) * 100)}%）`);
  }
  if (passed / rows.length < 0.85) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
