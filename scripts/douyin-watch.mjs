#!/usr/bin/env node
/**
 * 抖音互动守护：定时看「消息 → 互动消息」，有新互动就点进去回一句。
 *   node scripts/douyin-watch.mjs --once            # 跑一轮
 *   node scripts/douyin-watch.mjs --interval 1800   # 每 30 分钟一轮（一直跑）
 * 回什么由大肥鱼自己写，发送前过合规闸门；L2/L3 只记录不发。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { deviceSerial } from '../device/wechat.mjs';
import { resetDouyin, readInteractions, parseInteractions, openInteraction, sendInCurrentComposer } from '../device/douyin.mjs';
import { checkComment } from '../connect/douyin/compliance.mjs';
import { douyinBrain } from '../connect/douyin/brain.mjs';

const root = process.cwd();
const home = join(root, 'runtime', 'dsh-home');
const seenFile = join(root, 'runtime', 'douyin', 'interactions.json');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const args = process.argv.slice(2);
const option = (name, fallback = '') => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
};
const has = (name) => args.includes(`--${name}`);

function loadSeen() {
  try {
    return JSON.parse(readFileSync(seenFile, 'utf8'));
  } catch {
    return { seen: [] };
  }
}

function saveSeen(data) {
  mkdirSync(join(root, 'runtime', 'douyin'), { recursive: true, mode: 0o700 });
  writeFileSync(seenFile, JSON.stringify(data, null, 2), { mode: 0o600 });
}

async function round(serial) {
  await resetDouyin(serial);
  const nodes = await readInteractions(serial);
  const rows = parseInteractions(nodes);
  const data = loadSeen();
  const fresh = rows.filter((row) => !data.seen.includes(row.text));
  console.log(`[watch] 互动 ${rows.length} 条，新 ${fresh.length} 条`);
  if (!fresh.length) return;

  const brain = douyinBrain(home);
  for (const row of fresh) {
    const reply = await brain({ caption: row.text, keyword: '互动消息' }).catch(() => '');
    if (!reply) {
      console.log(`[watch] 跳过（生成失败）：${row.text}`);
      continue;
    }
    const decision = checkComment(reply, { recentTexts: [], lastCommentAt: 0, todayCount: 0 });
    if (!decision.ok) {
      console.log(`[watch] 不自动发（${decision.level}/${decision.id}）：${reply}`);
      continue;
    }
    try {
      const index = rows.findIndex((item) => item.text === row.text);
      await openInteraction(serial, index);
      const result = await sendInCurrentComposer(serial, reply);
      console.log(`[watch] 回复「${row.text}」→ ${reply}｜${result.sent ? '已发送' : '未确认'}`);
    } catch (error) {
      console.log(`[watch] 回复失败：${error.message}`);
    }
    data.seen.push(row.text);
    saveSeen(data);
  }
}

const serial = await deviceSerial();
if (has('once')) {
  await round(serial);
} else {
  const interval = Math.max(60, Number(option('interval', '1800'))) * 1000;
  console.log(`[watch] 每 ${interval / 60000} 分钟检查一次互动消息；Ctrl+C 结束`);
  for (;;) {
    await round(serial).catch((error) => console.log(`[watch] 本轮失败：${error.message}`));
    await sleep(interval);
  }
}
