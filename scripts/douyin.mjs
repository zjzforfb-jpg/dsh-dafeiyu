#!/usr/bin/env node
/**
 * 抖音互动（手机 ADB）：
 *   node scripts/douyin.mjs --comments                     读当前视频评论
 *   node scripts/douyin.mjs --comment "文案" [--dry-run]     给当前视频发评论（走合规闸门）
 *   node scripts/douyin.mjs --reply-match "关键词" --reply "文案"
 *   node scripts/douyin.mjs --search "关键词"                搜索并列出结果
 *   node scripts/douyin.mjs --auto-comment --keyword "关键词" [--pick 1] [--text "文案"|--generate]
 *   node scripts/douyin.mjs --interactions                  列出「消息 → 互动消息」条目
 *   node scripts/douyin.mjs --open-interaction 0            打开第 N 条互动消息
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { deviceSerial } from '../device/wechat.mjs';
import { likeBackComments } from '../device/douyin.mjs';
import {
  openCommentsSmart, parseComments, postComment, replyToComment, resetDouyin,
  openSearch, searchKeyword, parseResults, currentActivity,
  parseSearchCards, openUserProfile, parseProfileWorks, worksTiles, sendInCurrentComposer,
  readInteractions, parseInteractions, openInteraction,
} from '../device/douyin.mjs';
import { dumpUi } from '../device/uia.mjs';
import { openHub, recordActivity } from '../connect/memory-hub.mjs';
import { addLesson, formatLessons, loadLessons } from '../connect/douyin/lessons.mjs';
import { join as joinPath } from 'node:path';
import { checkComment, describeRules, LIMITS } from '../connect/douyin/compliance.mjs';
import { loadAccounts, saveAccounts, upsertAccounts } from '../connect/douyin/accounts.mjs';
import { douyinBrain } from '../connect/douyin/brain.mjs';

const root = process.cwd();
const home = join(root, 'runtime', 'dsh-home');
const stateFile = join(root, 'runtime', 'douyin', 'state.json');
const accountsFile = join(root, 'runtime', 'douyin', 'accounts.json');

function loadState() {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    return { history: [] };
  }
}

function saveState(state) {
  mkdirSync(join(root, 'runtime', 'douyin'), { recursive: true, mode: 0o700 });
  writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
}

const dayKey = (now = Date.now()) => new Date(now + 8 * 3600_000).toISOString().slice(0, 10);

function gate(text) {
  const state = loadState();
  const now = Date.now();
  const today = dayKey(now);
  const history = (state.history ?? []).filter((item) => now - item.at < LIMITS.duplicateWindowMs);
  const decision = checkComment(text, {
    recentTexts: history.map((item) => item.text),
    lastCommentAt: history.at(-1)?.at ?? 0,
    todayCount: history.filter((item) => dayKey(item.at) === today).length,
    hourCount: history.filter((item) => now - item.at < 3600_000).length,
    now,
  });
  return { decision, state, history };
}

function noteActivity(text) {
  try {
    const hub = openHub(process.cwd());
    recordActivity(hub, text, { channel: 'douyin' });
    hub.close();
  } catch {}
}

function remember(text, video) {
  const state = loadState();
  const now = Date.now();
  state.history = [...(state.history ?? []).filter((item) => now - item.at < LIMITS.duplicateWindowMs), { text, at: now, video: video ?? '' }];
  saveState(state);
}

const lessonsFile = joinPath(process.cwd(), 'runtime', 'douyin', 'lessons.json');
const args = process.argv.slice(2);
const option = (name, fallback = '') => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
};
const has = (name) => args.includes(`--${name}`);

async function main() {
  if (has('lessons')) { const { lessons } = loadLessons(lessonsFile); console.log(JSON.stringify(lessons.slice(-20), null, 2)); return; }
  if (has('lesson')) { const data = addLesson(lessonsFile, { kind: option('kind', 'note'), text: option('lesson'), tags: option('tags').split(',').filter(Boolean) }); console.log(JSON.stringify({ saved: true, total: data.lessons.length }, null, 2)); return; }
  const serial = await deviceSerial();
  if (has('reset')) {
    await resetDouyin(serial);
    console.log('抖音已重启到首页。');
    return;
  }
  if (has('search') || has('auto-comment')) await resetDouyin(serial);

  if (has('rules')) {
    console.log(JSON.stringify(describeRules(), null, 2));
    return;
  }

  if (has('comments')) {
    const nodes = await openCommentsSmart(serial);
    const rows = parseComments(nodes);
    console.log(`当前评论区共识别 ${rows.length} 条可回复评论：`);
    rows.slice(0, 12).forEach((row, index) => console.log(`${index + 1}. [${row.author}] ${row.text}`));
    return;
  }

  const comment = option('comment');
  if (comment) {
    const { decision } = gate(comment);
    if (!decision.ok) {
      console.log(JSON.stringify({ level: decision.level, id: decision.id, reason: decision.reason, text: comment }, null, 2));
      process.exitCode = decision.level === 'block' ? 2 : 3;
      return;
    }
    await openCommentsSmart(serial);
    const result = await postComment(serial, comment, { dryRun: has('dry-run') });
    if (result.sent) { remember(comment, option('video')); noteActivity(`在抖音评论了：${comment}`); }
    console.log(JSON.stringify({ ...result, compliance: decision.level }, null, 2));
    return;
  }

  const match = option('reply-match');
  const reply = option('reply');
  if (match && reply) {
    const { decision } = gate(reply);
    if (!decision.ok) {
      console.log(JSON.stringify({ level: decision.level, id: decision.id, reason: decision.reason, text: reply }, null, 2));
      process.exitCode = decision.level === 'block' ? 2 : 3;
      return;
    }
    await openCommentsSmart(serial);
    const result = await replyToComment(serial, { match, reply, dryRun: has('dry-run') });
    if (result.sent) { remember(reply, match); noteActivity(`在抖音回复了评论：${reply}`); }
    console.log(JSON.stringify({ ...result, compliance: decision.level }, null, 2));
    return;
  }

  if (has('search')) {
    const keyword = option('search');
    await openSearch(serial);
    const nodes = await searchKeyword(serial, keyword);
    const rows = parseResults(nodes).slice(0, 10);
    console.log(`「${keyword}」搜索结果 ${rows.length} 条：`);
    rows.forEach((row, index) => console.log(`${index + 1}. ${row.text}`));
    return;
  }

  if (has('save-accounts')) {
    const keyword = option('keyword');
    if (!keyword) throw new Error('need_keyword');
    await resetDouyin(serial);
    await openSearch(serial);
    const nodes = await searchKeyword(serial, keyword);
    const cards = parseSearchCards(nodes);
    const next = upsertAccounts(loadAccounts(accountsFile), cards, keyword);
    saveAccounts(accountsFile, next);
    console.log(`保存对标账号 ${cards.length} 条视频 / 共 ${next.accounts.length} 个账号（话题：${keyword}）`);
    cards.forEach((card) => console.log(`- ${card.author}｜${card.title.slice(0, 30)}｜${card.likes}`));
    return;
  }

  if (has('accounts')) {
    const data = loadAccounts(accountsFile);
    console.log(`已存对标账号 ${data.accounts.length} 个：`);
    data.accounts.forEach((item, index) => console.log(`${index + 1}. ${item.name}｜话题 ${(item.topics ?? []).join('/')}｜最近作品：${item.lastWork ?? ''}`));
    return;
  }

  if (has('account-works')) {
    const name = option('account-works');
    await resetDouyin(serial);
    await openSearch(serial);
    await searchKeyword(serial, name);
    const profile = await openUserProfile(serial, name);
    const works = parseProfileWorks(profile);
    console.log(`「${name}」主页最近作品 ${works.length} 条：`);
    works.slice(0, 12).forEach((work, index) => console.log(`${index + 1}. ${work.text}`));
    return;
  }

  if (has('like-back')) {
    const result = await likeBackComments(serial, { max: Number(option('max', '12')), dryRun: !has('confirm') });
    console.log(JSON.stringify(result));
    return;
  }

  if (has('work-comment')) {
    const account = option('account');
    if (!account) throw new Error('need_account');
    const workText = option('work-text');
    await resetDouyin(serial);
    await openSearch(serial);
    await searchKeyword(serial, account);
    await openUserProfile(serial, account);
    const nodes = await dumpUi(serial);
    const tiles = worksTiles(nodes);
    const works = parseProfileWorks(nodes);
    const work = workText ? works.find((item) => item.text.includes(workText)) : works[0];
    if (workText && !work) throw new Error('work_not_found');
    if (!tiles.length) throw new Error('work_tile_missing');
    const tile = (work && tiles.find((item) => work.point.x >= item.bounds.x && work.point.x <= item.bounds.x + item.bounds.w
      && work.point.y >= item.bounds.y - 90 && work.point.y <= item.bounds.y + item.bounds.h + 90)) ?? tiles[0];
    const { tapPoint: tap, sleep: nap } = await import('../device/uia.mjs');
    let opened = '';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await tap(serial, attempt === 0 ? tile.point : { x: tile.bounds.cx, y: tile.bounds.y + 60 });
      await nap(2600);
      opened = await currentActivity(serial);
      if (/DetailActivity/u.test(opened)) break;
    }
    if (!/DetailActivity/u.test(opened)) throw new Error(`detail_not_opened:${opened}`);
    let text = option('text');
    if (!text) {
      if (!has('generate')) throw new Error('need_text_or_generate');
      text = await douyinBrain(home)({ caption: option('caption-hint', ''), keyword: account });
    }
    const { decision } = gate(text);
    console.log(JSON.stringify({ account, drafted: text, level: decision.level, reason: decision.reason }, null, 2));
    if (!decision.ok || has('dry-run')) return;
    const result = await postComment(serial, text);
    if (result.sent) { remember(text, workText ?? account); noteActivity(`在抖音给 ${account} 的作品评论了：${text}`); }
    console.log(JSON.stringify({ ...result, compliance: decision.level }, null, 2));
    return;
  }

  if (has('interactions')) {
    await resetDouyin(serial);
    const nodes = await readInteractions(serial);
    const rows = parseInteractions(nodes);
    console.log(rows.length ? `互动消息 ${rows.length} 条：` : '暂时没有互动消息。');
    rows.forEach((row, index) => console.log(`${index + 1}. ${row.text}`));
    return;
  }

  if (has('open-interaction')) {
    const index = Number(option('open-interaction', '0'));
    const { opened, nodes } = await openInteraction(serial, index);
    console.log(`已打开：${opened}`);
    const rows = parseComments(nodes);
    if (rows.length) {
      console.log('该条目下的评论：');
      rows.slice(0, 10).forEach((row, i) => console.log(`${i + 1}. [${row.author}] ${row.text}`));
    }
    return;
  }

  if (has('reply-interaction')) {
    const index = Number(option('reply-interaction', '0'));
    const text = option('text');
    if (!text) throw new Error('need_text');
    const { decision } = gate(text);
    if (!decision.ok) {
      console.log(JSON.stringify({ level: decision.level, id: decision.id, reason: decision.reason }, null, 2));
      process.exitCode = decision.level === 'block' ? 2 : 3;
      return;
    }
    await resetDouyin(serial);
    await tapPoint(serial, (await import('../device/douyin.mjs')).DOUYIN_NAV.messagesTab);
    await sleepMs(1800);
    await tapPoint(serial, (await import('../device/douyin.mjs')).DOUYIN_NAV.interactions);
    await sleepMs(2200);
    const { opened } = await openInteraction(serial, index);
    const result = await sendInCurrentComposer(serial, text, { dryRun: has('dry-run') });
    if (result.sent) remember(text, `interaction:${opened}`);
    console.log(JSON.stringify({ opened, ...result, compliance: decision.level }, null, 2));
    return;
  }

  if (has('auto-comment')) {
    const keyword = option('keyword');
    const pick = Math.max(1, Number(option('pick', '1')));
    const pickText = option('pick-text');
    await openSearch(serial);
    const results = parseResults(await searchKeyword(serial, keyword)).slice(0, 12);
    const target = pickText ? results.find((item) => item.text.includes(pickText)) : results[pick - 1];
    if (!target) throw new Error(`result_not_found:${pick}`);
    const { tapPoint } = await import('../device/uia.mjs');
    const { sleep } = await import('../device/uia.mjs');
    await tapPoint(serial, target.point);
    await sleep(2800);
    const activity = await currentActivity(serial);
    if (!/DetailActivity/u.test(activity)) throw new Error(`detail_not_opened:${activity}`);
    const comments = await openCommentsSmart(serial);
    const rows = parseComments(comments);
    const caption = target.text;
    let text = option('text');
    if (!text) {
      if (!has('generate')) throw new Error('need_text_or_generate');
      text = await (douyinBrain(home))({ caption, keyword });
    }
    const { decision } = gate(text);
    console.log(JSON.stringify({ video: caption, drafted: text, level: decision.level, reason: decision.reason }, null, 2));
    if (!decision.ok || has('dry-run')) return;
    const result = await postComment(serial, text);
    if (result.sent) remember(text, caption);
    console.log(JSON.stringify({ ...result, compliance: decision.level }, null, 2));
    return;
  }

  console.log('用法：--comments | --comment "文案" | --reply-match "关键词" --reply "文案" | --search "关键词" | --auto-comment --keyword "关键词" [--pick N] [--generate] | --interactions | --open-interaction N | --rules');
}

main().catch((error) => {
  console.error(`抖音操作失败：${error.message}`);
  process.exit(1);
});
