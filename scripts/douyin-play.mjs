#!/usr/bin/env node
/**
 * 抖音「刷一刷」一轮：搜话题 → 看若干条视频（读标题）→ 挑几条发可爱评论。
 *   node scripts/douyin-play.mjs --topic "大肥鱼" --look 10 --comment 2 [--dry-run]
 */
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { deviceSerial } from '../device/wechat.mjs';
import { dumpUi, sleep, tapPoint } from '../device/uia.mjs';
import {
  resetDouyin, openSearch, searchKeyword, parseSearchCards,
  openCommentsSmart, postComment, adbShell,
} from '../device/douyin.mjs';
import { checkComment, LIMITS } from '../connect/douyin/compliance.mjs';
import { douyinBrain } from '../connect/douyin/brain.mjs';

const root = process.cwd();
const stateFile = join(root, 'runtime', 'douyin', 'state.json');
const sleepMs = sleep;
const dayKey = (now = Date.now()) => new Date(now + 8 * 3600_000).toISOString().slice(0, 10);

const args = process.argv.slice(2);
const option = (name, fallback = '') => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
};
const has = (name) => args.includes(`--${name}`);

function loadState() {
  try { return JSON.parse(readFileSync(stateFile, 'utf8')); } catch { return { history: [] }; }
}
function record(text, video) {
  const state = loadState();
  const now = Date.now();
  state.history = [...(state.history ?? []).filter((item) => now - item.at < LIMITS.duplicateWindowMs), { text, at: now, video }];
  mkdirSync(join(root, 'runtime', 'douyin'), { recursive: true, mode: 0o700 });
  writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
}
function gate(text) {
  const state = loadState();
  const now = Date.now();
  const history = (state.history ?? []).filter((item) => now - item.at < LIMITS.duplicateWindowMs);
  return checkComment(text, {
    recentTexts: history.map((item) => item.text),
    lastCommentAt: history.at(-1)?.at ?? 0,
    todayCount: history.filter((item) => dayKey(item.at) === dayKey(now)).length,
    now,
  });
}

const topic = option('topic', '大肥鱼');
const look = Math.max(1, Math.min(12, Number(option('look', '10'))));
const toComment = Math.max(0, Math.min(3, Number(option('comment', '2'))));
const dryRun = has('dry-run');

const serial = await deviceSerial();
await resetDouyin(serial);
await openSearch(serial);
const cards = parseSearchCards(await searchKeyword(serial, topic)).slice(0, look);
console.log(`话题「${topic}」取到 ${cards.length} 条视频`);

const picked = [];
for (const [index, card] of cards.entries()) {
  if (picked.length >= toComment) break;
  if (index % 3 !== 1) continue; // 跳过两条、挑一条，避免连续密集评论
  picked.push({ card, index });
}

const results = [];
for (const { card, index } of picked) {
  await tapPoint(serial, card.point);
  await sleepMs(2800);
  try {
    await openCommentsSmart(serial);
    const text = await douyinBrain(join(root, 'runtime', 'dsh-home'))({ caption: card.title, keyword: topic });
    const decision = gate(text);
    let action = 'draft';
    if (decision.ok && !dryRun) {
      const sent = await postComment(serial, text);
      action = sent.sent ? 'sent' : 'unconfirmed';
      if (sent.sent) record(text, card.title);
    } else if (decision.ok) {
      action = 'dry-run';
    } else {
      action = `blocked:${decision.level}/${decision.id}`;
    }
    results.push({ index: index + 1, author: card.author, title: card.title.slice(0, 28), text, action });
  } catch (error) {
    results.push({ index: index + 1, author: card.author, title: card.title.slice(0, 28), error: error.message });
  }
  await adbShell(serial, 'input keyevent 4');
  await sleepMs(1200);
  await adbShell(serial, 'input keyevent 4');
  await sleepMs(1000);
}

console.log(JSON.stringify(results, null, 2));
