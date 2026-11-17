#!/usr/bin/env node
/**
 * 抖音互动（手机 ADB）：
 *   node scripts/douyin.mjs --comments                     读当前视频评论
 *   node scripts/douyin.mjs --comment "文案" [--dry-run]     给当前视频发评论（走合规闸门）
 *   node scripts/douyin.mjs --reply-match "关键词" --reply "文案"
 *   node scripts/douyin.mjs --search "关键词"                搜索并列出结果
 *   node scripts/douyin.mjs --auto-comment --keyword "关键词" [--pick 1] [--text "文案"|--generate]
 *   node scripts/douyin.mjs --reply-own [--generate] [--max 6] [--limit 20] [--work N] [--dry-run]
 *                                                          逐个打开主页作品，回复评论区里没回过的评论
 *   node scripts/douyin.mjs --interactions                  列出「消息 → 互动消息」条目
 *   node scripts/douyin.mjs --open-interaction 0            打开第 N 条互动消息
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { deviceSerial } from '../device/wechat.mjs';
import { likeBackComments } from '../device/douyin.mjs';
import {
  openCommentsSmart, parseComments, postComment, replyToComment, resetDouyin,
  openSearch, onSearchResults, waitForHome, searchKeyword, parseResults, currentActivity,
  parseSearchCards, openUserProfile, parseProfileWorks, worksTiles, sendInCurrentComposer,
  readInteractions, parseInteractions, openInteraction,
  openInteractions, openProfile, openWorkComments, backToProfile, panelOwner,
  openCommentInbox, parseCommentInbox, parseCommentDetail, formatLikes, findBlockers, emptyProof, ensureClear,
} from '../device/douyin.mjs';
import { dumpUi, sleep } from '../device/uia.mjs';
import { openHub, recordActivity } from '../connect/memory-hub.mjs';
import { addLesson, loadLessons } from '../connect/douyin/lessons.mjs';
import { join as joinPath } from 'node:path';
import { checkComment, describeRules, LIMITS, loadLimits } from '../connect/douyin/compliance.mjs';
import { loadAccounts, saveAccounts, upsertAccounts } from '../connect/douyin/accounts.mjs';
import { douyinBrain, douyinReplyBrain } from '../connect/douyin/brain.mjs';
import { buildReplyContext, contextText } from '../connect/core/comment-context.mjs';
import { openDouyinDb, saveWork, saveComment, bindOrphans, markReplied, listComments, listWorks, contentSummary, classifyComment, saveVideo, videosForRound, saveHotComment, markHotCommentReplied, touchVideoRound, hotStats, saveFan, listFans, fanSummary, backfillFans, saveWorkStats, worksMissingStats, saveHotspot, listHotspots } from '../connect/douyin/store.mjs';
import { finishSkillRun, registerSkill, startSkillRun } from '../connect/skills.mjs';
import { chooseStrategy, finishStrategyTrial, startStrategyTrial } from '../connect/strategies.mjs';
import { openSkillLedger } from '../connect/skills/ledger.mjs';
import { runCommentPipeline } from '../connect/core/comment-pipeline.mjs';

const root = process.cwd();
const home = join(root, 'runtime', 'dsh-home');
const stateFile = join(root, 'runtime', 'douyin', 'state.json');
const accountsFile = join(root, 'runtime', 'douyin', 'accounts.json');

function parseLikes(raw) {
  const text = String(raw ?? '').trim();
  const m = text.match(/([\d.]+)\s*(万|w|W)?/u);
  if (!m) return 0;
  const n = Number(m[1]);
  return Math.round(n * (m[2] ? 10000 : 1));
}

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

// 频次上限允许用 runtime/douyin/limits.json 覆盖（主人想放宽/收紧时改文件，不改代码）
const LIMITS_NOW = loadLimits(root);
LIMITS.hourlyComments = LIMITS_NOW.hourlyComments;
LIMITS.dailyComments = LIMITS_NOW.dailyComments;
LIMITS.minIntervalMs = LIMITS_NOW.minIntervalMs;
LIMITS.maxLength = LIMITS_NOW.maxLength;

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

// 技能/策略账本统一落在 CONNECT 库（runtime/connect/connect.sqlite），BRAIN 库不再持有 skill_* / strategy_trials。
function beginSkill(skillId, environment = {}) {
  try {
    const db = openSkillLedger(root);
    if (!db.prepare('SELECT 1 FROM skill_registry WHERE skill_id=?').get(skillId)) registerSkill(db, { skillId, name: skillId, description: '由抖音操作流程自动登记的候选技能', environment });
    const runId = startSkillRun(db, { skillId, version: 1, environment });
    return { db, runId, startedAt: Date.now() };
  } catch { return null; }
}
function beginStrategy(skillId, environment) {
  try {
    const db = openSkillLedger(root);
    const selected = chooseStrategy(db, { strategyIds: ['uia_smart', 'coordinate_fallback'], environment, requireVerified: true });
    const trial = startStrategyTrial(db, { strategyId: selected.strategy ?? 'uia_smart', skillId, environment, reason: selected.reason });
    return { db, trial, strategy: selected.strategy ?? 'uia_smart', startedAt: Date.now() };
  } catch { return null; }
}
function endStrategy(run, outcome) { if (!run) return; try { finishStrategyTrial(run.db, run.trial, { ...outcome, durationMs: Date.now() - run.startedAt }); run.db.close(); } catch {} }
function endSkill(run, outcome) {
  if (!run) return;
  try { finishSkillRun(run.db, run.runId, { ...outcome, durationMs: Date.now() - run.startedAt }); run.db.close(); } catch {}
}

function remember(text, video) {
  const state = loadState();
  const now = Date.now();
  state.history = [...(state.history ?? []).filter((item) => now - item.at < LIMITS.duplicateWindowMs), { text, at: now, video: video ?? '' }];
  // 记下「哪些视频已经回过」，跨天也保留（同一视频重复评论很像刷屏）
  state.recentVideos = [...(state.recentVideos ?? []).filter((item) => item.video !== video), { video: video ?? '', at: now }].slice(-200);
  saveState(state);
}

/** 已经回过的评论记在 runtime/douyin/replied.json，重跑不会重复回复。 */
function repliedStore() {
  const file = join(root, 'runtime', 'douyin', 'replied.json');
  let data = {};
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    data = {};
  }
  return {
    has: (key) => Boolean(data[key]),
    hasLike: (fragment) => Boolean(fragment) && Object.keys(data).some((key) => key.includes(fragment)),
    add: (key) => {
      data[key] = new Date().toISOString();
      mkdirSync(join(root, 'runtime', 'douyin'), { recursive: true });
      writeFileSync(file, JSON.stringify(data, null, 2));
    },
  };
}

const lessonsFile = joinPath(process.cwd(), 'runtime', 'dsh-home', 'lessons.json');
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
    const skillRun = beginSkill('douyin.post_comment', { device: serial, app: 'douyin' });
    const strategyRun = beginStrategy('douyin.post_comment', { device: serial, app: 'douyin', screen: 'comments' });
    const { decision } = gate(comment);
    if (!decision.ok) {
      endSkill(skillRun, { success: false, verified: false, failureStage: 'compliance' });
      endStrategy(strategyRun, { success: false, verified: false, result: { error: 'compliance' } });
      console.log(JSON.stringify({ level: decision.level, id: decision.id, reason: decision.reason, text: comment }, null, 2));
      process.exitCode = decision.level === 'block' ? 2 : 3;
      return;
    }
    await openCommentsSmart(serial);
    let result;
    try { result = await postComment(serial, comment, { dryRun: has('dry-run') }); }
    catch (error) { endSkill(skillRun, { success: false, verified: false, failureStage: 'post_comment', result: { error: error.message } }); throw error; }
    endSkill(skillRun, { success: result.sent === true, verified: result.sent === true, failureStage: result.sent ? null : 'post_comment', result });
    endStrategy(strategyRun, { success: result.sent === true, verified: result.sent === true, result });
    if (result.sent) { remember(comment, option('video')); noteActivity(`在抖音评论了：${comment}`); }
    console.log(JSON.stringify({ ...result, compliance: decision.level }, null, 2));
    return;
  }

  const match = option('reply-match');
  const reply = option('reply');
  if (match && reply) {
    const skillRun = beginSkill('douyin.reply_comment', { device: serial, app: 'douyin' });
    const strategyRun = beginStrategy('douyin.reply_comment', { device: serial, app: 'douyin', screen: 'comments' });
    const { decision } = gate(reply);
    if (!decision.ok) {
      endSkill(skillRun, { success: false, verified: false, failureStage: 'compliance' });
      endStrategy(strategyRun, { success: false, verified: false, result: { error: 'compliance' } });
      console.log(JSON.stringify({ level: decision.level, id: decision.id, reason: decision.reason, text: reply }, null, 2));
      process.exitCode = decision.level === 'block' ? 2 : 3;
      return;
    }
    await openCommentsSmart(serial);
    let result;
    try { result = await replyToComment(serial, { match, reply, dryRun: has('dry-run') }); }
    catch (error) { endSkill(skillRun, { success: false, verified: false, failureStage: 'reply_comment', result: { error: error.message } }); throw error; }
    endSkill(skillRun, { success: result.sent === true, verified: result.sent === true, failureStage: result.sent ? null : 'reply_comment', result });
    endStrategy(strategyRun, { success: result.sent === true, verified: result.sent === true, result });
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
    const { watchDelayMs, sleep: humanSleep } = await import('../connect/douyin/humanize.mjs');
    const watchMs = Number(option('watch-ms', '0')) || watchDelayMs();
    console.log(JSON.stringify({ watching_ms: watchMs }, null, 0));
    await humanSleep(watchMs);
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

  if (has('benchmark-round')) {
    const dryRun = has('dry-run');
    const keyword = option('keyword', '大肥鱼');
    const store = loadAccounts(accountsFile);
    const names = new Set(Object.keys(store.accounts ?? {}));
    await resetDouyin(serial);
    await openSearch(serial);
    await searchKeyword(serial, keyword);
    const nodes = await dumpUi(serial);
    const cards = parseSearchCards(nodes)
      .map((card) => ({ ...card, likes: parseLikes(card.likes) }))
      .sort((a, b) => b.likes - a.likes);
    const benchmark = cards.filter((card) => names.has(card.author));
    const pick = (benchmark.length ? benchmark : cards)[0];
    if (!pick) { console.log(JSON.stringify({ cards: cards.length, picked: null }, null, 2)); return; }
    console.log(JSON.stringify({ keyword, cards: cards.length, benchmarkHits: benchmark.length, pick: { title: pick.title.slice(0, 30), author: pick.author, likes: pick.likes } }, null, 2));
    const { tapPoint: tap, sleep: nap } = await import('../device/uia.mjs');
    let opened = '';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await tap(serial, pick.point);
      await nap(2600);
      opened = await currentActivity(serial);
      if (/DetailActivity/u.test(opened)) break;
    }
    if (!/DetailActivity/u.test(opened)) { console.log(JSON.stringify({ opened, error: 'detail_not_opened' })); return; }
    const { watchDelayMs, sleep: humanSleep } = await import('../connect/douyin/humanize.mjs');
    const watchMs = Number(option('watch-ms', '0')) || watchDelayMs();
    console.log(JSON.stringify({ watching_ms: watchMs }));
    await humanSleep(watchMs);
    const text = await douyinBrain(home)({ caption: pick.title, keyword });
    const { decision } = gate(text);
    console.log(JSON.stringify({ drafted: text, level: decision.level, reason: decision.reason }, null, 2));
    if (!decision.ok || dryRun) return;
    const result = await postComment(serial, text);
    if (result.sent) {
      remember(text, pick.author);
      noteActivity(`在抖音搜「${keyword}」后给 ${pick.author} 的爆款评论了：${text}`);
      store.accounts[pick.author] = { ...(store.accounts[pick.author] ?? {}), name: pick.author, lastWork: pick.title, lastLikes: pick.likes, lastSeenAt: Date.now() };
      saveAccounts(accountsFile, store);
    }
    console.log(JSON.stringify({ sent: result.sent }, null, 2));
    return;
  }

  if (has('interactions')) {
    // 走「消息 → 互动消息 → 收到的评论」这条实测路径（readInteractions 抓的是首页信息流，会读到视频文案）。
    // 输出结构化 JSON：调用方按 status + verified 决定能不能说「看过了」，别把弹窗/没加载当成没有新评论。
    await resetDouyin(serial);
    await openCommentInbox(serial);
    // 自愈：如果停在「继续编辑作品 / 权限 / 升级」这类弹窗上，先把能安全关掉的关掉，再判断结果。
    const clear = await ensureClear(serial);
    let nodes = await dumpUi(serial);
    const activity = await currentActivity(serial);
    let blockers = findBlockers(nodes);
    let rows = blockers.length ? [] : parseCommentInbox(nodes);
    let proof = emptyProof(nodes);
    // 评论列表偶尔还没渲染完：等两轮再看看，别急着报「没有新评论」。
    for (let attempt = 0; attempt < 2 && !rows.length && !proof.ok && !blockers.length; attempt += 1) {
      await sleep(1600);
      nodes = await dumpUi(serial);
      blockers = findBlockers(nodes);
      rows = blockers.length ? [] : parseCommentInbox(nodes);
      proof = emptyProof(nodes);
    }
    const status = blockers.length ? 'blocked' : rows.length ? 'ok' : proof.ok ? 'empty' : 'unconfirmed';
    const steps = [
      { id: 'reset_app', ok: /^com\.ss\.android\.ugc\.aweme/u.test(activity), evidence: activity || 'no_activity' },
      { id: 'open_interaction', ok: /IntegratedInteractionActivity/u.test(activity) && !blockers.length, evidence: activity || 'no_activity' },
      { id: 'filter_comments', ok: !blockers.length && (rows.length > 0 || proof.ok), evidence: blockers.length ? `blocked:${blockers[0].kind}` : (proof.text ?? `rows=${rows.length}`) },
      { id: 'read_rows', ok: rows.length > 0 || proof.ok, evidence: `count=${rows.length}` },
      ...clear.healed.map((item) => ({ id: `heal:${item.kind}`, ok: true, evidence: `点了「${item.clicked}」` })),
      { id: 'clear_screen', ok: clear.ok && !blockers.length, evidence: clear.ok ? 'ok' : `left:${clear.blockers.map((b) => b.kind).join(',')}` },
    ];
    console.log(JSON.stringify({
      status,
      verified: status === 'ok' || status === 'empty',
      activity,
      count: rows.length,
      emptyProof: proof.text ?? null,
      blockers,
      steps,
      rows: rows.slice(0, 10).map((row) => ({ author: row.author || '某人', text: row.text || '（只有图片或表情）' })),
    }));
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

  const INBOX_AGO = /(刚刚|\d+\s*(?:秒|分钟|小时|天|月)前|(?:昨天|今天|前天)\s*\d{1,2}:\d{2})/u;
  const commentAt = (raw) => {
    const hit = String(raw ?? '').match(INBOX_AGO);
    return hit ? hit[1].replace(/\s+/gu, ' ') : null;
  };

  if (has('crawl-stats')) {
    // 自己作品详情页的播放/点赞/收藏/转发，回填到 works 表（课程 11 的数据复盘要用）。
    const serial = await deviceSerial();
    const limit = Math.max(1, Number(option('limit', '5')) || 5);
    const { parseOwnWorkStats } = await import('../device/douyin.mjs');
    const { tapPoint: tap, sleep: nap } = await import('../device/uia.mjs');
    const db = openDouyinDb(root);
    const works = db.prepare('SELECT id, code, title FROM works ORDER BY COALESCE(published_at, created_at) DESC').all();
    const matchWork = (text) => {
      const needle = String(text || '').slice(0, 8);
      if (!needle) return null;
      return works.find((work) => work.title && (work.title.includes(needle) || needle.includes(work.title.slice(0, 8)))) ?? null;
    };
    await openProfile(serial);
    const tiles = worksTiles(await dumpUi(serial));
    const results = [];
    for (let index = 0; index < Math.min(tiles.length, limit); index += 1) {
      await tap(serial, tiles[index].point);
      await nap(2800);
      let stats = parseOwnWorkStats(await dumpUi(serial));
      // 详情页右侧按钮有时比画面晚一拍，补两次机会再判定。
      for (let retry = 0; retry < 2 && (stats.likes == null || stats.comments == null); retry += 1) {
        await nap(1800);
        const again = parseOwnWorkStats(await dumpUi(serial));
        stats = { ...stats, ...Object.fromEntries(Object.entries(again).filter(([, value]) => value != null)) };
      }
      const work = matchWork(stats.title) ?? works[index] ?? null;
      if (work) saveWorkStats(db, work.id, stats);
      // 早期抓回来的作品标题是「主页第 N 个作品」这种占位名，顺便用详情页的真实标题补上。
      if (work && /^主页第 \d+ 个作品$/u.test(work.title) && stats.title && stats.title.length >= 6) {
        db.prepare('UPDATE works SET title = ? WHERE id = ?').run(stats.title.replace(/[.…]+$/u, ''), work.id);
      }
      results.push({ index, work: work?.code ?? null, title: (work?.title ?? stats.title).slice(0, 24), views: stats.views, likes: stats.likes, comments: stats.comments, favorites: stats.favorites, shares: stats.shares });
      const { execFile } = await import('node:child_process');
      await new Promise((resolve) => execFile(process.env.ADB_PATH || 'adb', ['-s', serial, 'shell', 'input keyevent', '4'], () => resolve()));
      await nap(1400);
    }
    console.log(JSON.stringify({ status: 'stats', results }, null, 1));
    db.close();
    return;
  }

  if (has('fans')) {
    const db = openDouyinDb(root);
    backfillFans(db);
    const summary = fanSummary(db);
    const list = listFans(db, Number(option('limit', '20')) || 20);
    console.log(JSON.stringify({ status: 'fans', ...summary, list }, null, 1));
    db.close();
    return;
  }

  if (has('hotspot')) {
    // 热点观察：扫一遍候选关键词，看哪些值得跟、哪些不能碰。
    const serial = await deviceSerial();
    const { discoverHotVideos, HOT_KEYWORDS, SKIP_TOPIC } = await import('../connect/douyin/discover.mjs');
    const keywordArg = option('keyword', '');
    const keywords = keywordArg ? keywordArg.split(/[,，]/u).map((item) => item.trim()).filter(Boolean) : HOT_KEYWORDS;
    const db = openDouyinDb(root);
    const found = await discoverHotVideos({ serial, keywords, limit: Number(option('limit', '10')) || 10 });
    const topics = [];
    for (const keyword of keywords) {
      const videos = found.filter((video) => video.keyword === keyword);
      if (!videos.length) { topics.push({ topic: keyword, videos: 0, topLikes: 0, verdict: 'empty', note: '没搜到（可能搜索没打开成功）' }); continue; }
      const top = videos[0];
      const skip = SKIP_TOPIC.test(top.title);
      const verdict = skip ? 'avoid' : (top.likes >= 10000 ? 'join' : 'watch');
      const note = skip ? '题材太沉重，不凑热闹' : verdict === 'join' ? `最高 ${formatLikes(top.likes)} 赞，可以跟` : '热度还差点，先观察';
      topics.push({ topic: keyword, videos: videos.length, topLikes: top.likes, topTitle: top.title, verdict, note });
      saveHotspot(db, { topic: keyword, videos: videos.length, topLikes: top.likes, verdict, note });
    }
    console.log(JSON.stringify({ status: 'hotspot', topics }, null, 1));
    db.close();
    return;
  }

  if (has('db-works')) {
    const db = openDouyinDb(root);
    console.log(JSON.stringify({ summary: contentSummary(db), works: listWorks(db, { limit: Number(option('limit', '50')) }) }, null, 2));
    db.close();
    return;
  }

  if (has('db-comments')) {
    const db = openDouyinDb(root);
    const workId = option('work') ?? null;
    console.log(JSON.stringify(listComments(db, { workId, order: option('order', 'time'), limit: Number(option('limit', '100')) }), null, 2));
    db.close();
    return;
  }

  if (has('db-crawl')) {
    // 逐个作品翻评论区，把每条评论按 work_id 存进库（含历史作品）。
    const db = openDouyinDb(root);
    await resetDouyin(serial);
    await openProfile(serial);
    const tiles = worksTiles(await dumpUi(serial));
    const works = listWorks(db);
    const out = [];
    for (let index = 0; index < tiles.length; index += 1) {
      const label = String(tiles[index].desc ?? tiles[index].text ?? '').trim();
      try {
        const nodes = await openWorkComments(serial, index);
        const comments = parseComments(nodes);
        const owner = panelOwner(nodes);
        const match = works.find((work) => work.title && label && label.includes(work.title.slice(0, 6)));
        const workId = match?.id ?? `profile:${index + 1}`;
        if (!match) {
          saveWork(db, { id: workId, title: label.slice(0, 60) || `主页第 ${index + 1} 个作品`, caption: '', topics: '', status: 'discovered' });
        }
        let saved = 0;
        for (const row of comments) {
          if (!row.text || row.author === owner || row.isAuthorReply) continue;
          saveComment(db, { workId, author: row.author, text: row.text, kind: classifyComment(row.text).kind, source: 'panel' });
          saved += 1;
        }
        out.push({ index, workId, comments: saved });
      } catch (error) {
        out.push({ index, error: String(error?.message ?? error).slice(0, 120) });
      }
      await resetDouyin(serial);
      await openProfile(serial);
    }
    const bound = bindOrphans(db);
    console.log(JSON.stringify({ status: 'crawled', works: out, bound, summary: contentSummary(db) }, null, 2));
    db.close();
    return;
  }

  if (has('db-sync')) {
    // 只同步「收到的评论」列表进库（不发送），用于补历史。
    const db = openDouyinDb(root);
    const store = repliedStore();
    await resetDouyin(serial);
    await openCommentInbox(serial);
    const rows = parseCommentInbox(await dumpUi(serial));
    let saved = 0;
    for (const row of rows) {
      const { kind } = classifyComment(row.text);
      const at = commentAt(row.raw);
      const key = `inbox|${row.author}|${(row.text || row.raw).slice(0, 40)}`;
      const replied = store.has(key) || store.hasLike((row.text || row.raw).slice(0, 20));
      saveComment(db, { workId: '', author: row.author, text: row.text, kind, commentAt: at, source: 'inbox' });
      saveFan(db, { name: row.author, text: row.text, at: new Date().toISOString() });
      if (replied) {
        markReplied(db, { workId: '', author: row.author, text: row.text, reply: '（历史回复，未记录正文）', at: new Date().toISOString() });
      }
      saved += 1;
    }
    console.log(JSON.stringify({ status: 'synced', rows: saved, summary: contentSummary(db) }, null, 2));
    db.close();
    return;
  }

  if (has('hot-videos') || has('hot-comment-round')) {
    const serial = await deviceSerial();
    const { discoverHotVideos, runHotCommentRound, HOT_KEYWORDS } = await import('../connect/douyin/discover.mjs');
    const storeDb = openDouyinDb(root);
    const keywordArg = option('keyword', '');
    const keywords = keywordArg ? keywordArg.split(/[,，]/u).map((item) => item.trim()).filter(Boolean) : HOT_KEYWORDS;
    if (has('hot-videos')) {
      const found = await discoverHotVideos({ serial, keywords, limit: Number(option('limit', 10)) || 10 });
      for (const video of found) video.id = saveVideo(storeDb, { title: video.title, author: video.author ?? '', likes: video.likes, likesText: video.likesText, keyword: video.keyword, dateText: video.date });
      storeDb.close();
      console.log(JSON.stringify({ status: 'found', count: found.length, videos: found }, null, 1));
      return;
    }
    const videosPerRound = Number(option('videos', 2)) || 2;
    const perVideo = Number(option('per-video', 2)) || 2;
    const dryRun = has('dry-run');
    const generate = has('generate');
    const videoIds = new Map();
    const commentIds = new Map();
    let sent = 0;
    const { rounds } = await runHotCommentRound({
      serial, keywords, videosPerRound, perVideo, generate, dryRun,
      gate: (text) => { const { decision } = gate(text); return decision; },
      generateText: generate ? async ({ caption, keyword }) => douyinBrain(home)({ caption, keyword }) : null,
      onVideo: (video, rows) => {
        const id = saveVideo(storeDb, { title: video.title, author: '', likes: video.likes, likesText: video.likesText, keyword: video.keyword, dateText: video.date });
        videoIds.set(video.title, id);
        for (const row of rows.slice(0, 8)) {
          const commentId = saveHotComment(storeDb, { videoId: id, author: row.author, text: row.text, likes: row.likes, likesText: row.likesText });
          commentIds.set(`${id}|${row.text}`, commentId);
        }
      },
      onComment: (video, entry) => {
        const vid = videoIds.get(video.title);
        const id = commentIds.get(`${vid}|${entry.text}`);
        if (entry.sent) {
          sent += 1;
          saveFan(storeDb, { name: entry.author, text: entry.text, at: new Date().toISOString() });
          if (id && !dryRun) markHotCommentReplied(storeDb, id, entry.reply);
          remember(entry.reply, `hot:${video.title}`);
          noteActivity(`在爆款视频下回 ${entry.author}：${entry.reply}`);
        }
      },
    });
    for (const round of rounds) {
      const vid = videoIds.get(round.video.title);
      if (vid && !round.error && round.comments.some((item) => item.sent)) touchVideoRound(storeDb, vid);
    }
    const stats = hotStats(storeDb);
    storeDb.close();
    console.log(JSON.stringify({ status: dryRun ? 'dry-run' : 'done', sent, stats, rounds: rounds.map((round) => ({ video: round.video.title.slice(0, 40), error: round.error, comments: round.comments.map((item) => ({ author: item.author, likes: item.likes, text: String(item.text).slice(0, 30), reply: item.reply, sent: item.sent, error: item.error })) })) }, null, 1));
    return;
  }

  if (has('probe-context')) {
    // 抓「这条评论在哪个作品下面」：点同一行的作品封面进详情页，把 UI 全量落盘，
    // 用来校验 parseCommentDetail 的字段位置（只读，不发任何东西）。
    const { tapPoint: tap } = await import('../device/uia.mjs');
    await resetDouyin(serial);
    await openCommentInbox(serial);
    const rows = parseCommentInbox(await dumpUi(serial));
    console.log(JSON.stringify({ rows: rows.length, first: rows[0] ?? null }, null, 1));
    if (!rows[0]) return;
    const target = rows[0].thumbPoint ?? { x: rows[0].replyPoint.x - 210, y: rows[0].replyPoint.y - 40 };
    await tap(serial, target);
    await sleep(2600);
    const nodes = await dumpUi(serial);
    writeFileSync('/tmp/douyin-detail.json', JSON.stringify(nodes, null, 1));
    console.log(JSON.stringify({
      activity: await currentActivity(serial),
      nodes: nodes.length,
      texts: nodes.filter((node) => node.text).slice(0, 50).map((node) => node.text),
    }, null, 1));
    return;
  }

  if (has('reply-inbox')) {
    const limit = Math.max(1, Number(option('limit', '20')));
    const dryRun = has('dry-run');
    const store = repliedStore();
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const adbKey = async (code) => {
      const { execFile } = await import('node:child_process');
      await new Promise((resolve) => execFile(process.env.ADB_PATH || 'adb', ['-s', serial, 'shell', 'input keyevent', code], () => resolve()));
    };
    const keyOf = (row) => `inbox|${row.author}|${(row.text || row.raw).slice(0, 40)}`;
    const done = (row) => store.has(keyOf(row)) || store.hasLike((row.text || row.raw).slice(0, 20));
    const backToInbox = async () => {
      const activity = await currentActivity(serial);
      if (/IntegratedInteraction/u.test(activity)) return parseCommentInbox(await dumpUi(serial));
      await openCommentInbox(serial);
      return parseCommentInbox(await dumpUi(serial));
    };
    await resetDouyin(serial);
    await openCommentInbox(serial);
    const results = [];
    const skipped = new Set();
    let sentCount = 0;
    for (let round = 0; round < limit * 2 && sentCount < limit; round += 1) {
      const rows = await backToInbox();
      const row = rows.find((item) => !done(item) && !skipped.has(keyOf(item)));
      if (!row) break;
      // 评论专用流水线（ADR-004 / 计划 P1-B B-1）：
      //   评论理解 → 意图判定 → 拟稿 → 合规检查 → 人工/自动决策 → 发布 → 回执验证
      // 设备动作（点哪一行、敲字、发出去）全部靠注入，所以决策链与手机解耦、可单测。
      // 先弄清「这条评论在哪个作品下面」：点同行封面进作品详情页读文案与评论链，
      // 读完退回通知列表。读不到就降级成只看评论本身，绝不替模型编作品内容。
      let context = null;
      if (has('context', 'with-context') || !has('no-context')) {
        try {
          if (row.thumbPoint) {
            const { tapPoint: tapCover } = await import('../device/uia.mjs');
            await tapCover(serial, row.thumbPoint);
            await pause(2400);
            const detail = parseCommentDetail(await dumpUi(serial));
            context = buildReplyContext({
              work: detail?.work,
              comment: { author: row.author, text: row.text },
              thread: detail?.thread ?? [],
            });
            await adbKey('4');
            await pause(1100);
          }
        } catch (error) {
          context = null;
        }
      }
      if (!context) context = buildReplyContext({ comment: { author: row.author, text: row.text } });
      const pipeline = await runCommentPipeline({
        comment: { author: row.author, text: row.text },
        draftText: option('text'),
        risk: 'R2',
        context,
        generate: async () => {
          if (!has('generate')) throw new Error('need_text_or_generate');
          return (douyinReplyBrain(home))({ context: contextText(context), comment: { author: row.author, text: row.text } });
        },
        check: (text) => gate(text).decision,
        publish: async ({ text }) => {
          // 列表会随回复刷新挪位置（刚进过详情页也会），点之前重新抓一遍按「作者 + 正文」定位。
          const current = await backToInbox().catch(() => rows);
          const fresh = current.find((item) => item.author === row.author && item.text === row.text);
          if (!fresh) return { sent: false, ok: false, error: 'row_moved' };
          const { tapPoint: tap } = await import('../device/uia.mjs');
          await tap(serial, fresh.replyPoint);
          await pause(1600);
          const result = await sendInCurrentComposer(serial, text, { dryRun });
          if (!result.sent && !dryRun) {
            // 发没发出去都先退回通知列表，避免卡在回复框里。
            await adbKey('4');
            await pause(900);
          }
          return result;
        },
      });
      const draft = pipeline.draft?.text ?? '';
      const level = pipeline.compliance?.level ?? '';
      const trace = pipeline.stages.map((item) => `${item.stage}:${item.status}`).join(',');
      if (pipeline.skipped) {
        results.push({ author: row.author, comment: row.text, context: context.mode, work: context.work?.title ?? '', skipped: pipeline.reason, stages: trace });
        skipped.add(keyOf(row));
        continue;
      }
      if (pipeline.retry) {
        // 只是「发太快」：等够间隔，同一行重来，不算失败。
        await pause(96_000);
        continue;
      }
      if (pipeline.decision?.decision === 'skip' || pipeline.needsReview) {
        results.push({
          author: row.author, comment: row.text, drafted: draft, blocked: pipeline.decision?.reason,
          level, needsReview: Boolean(pipeline.needsReview), stages: trace,
        });
        skipped.add(keyOf(row));
        continue;
      }
      if (!pipeline.ok) {
        const error = pipeline.published?.error ?? pipeline.error ?? pipeline.reason ?? 'unknown';
        results.push({ author: row.author, comment: row.text, drafted: draft, error, level, stages: trace });
        if (error === 'row_moved') break;
        skipped.add(keyOf(row));
        continue;
      }
      sentCount += 1;
      const replyKind = pipeline.draft.kind === 'emoji' ? 'emoji' : 'text';
      store.add(keyOf(row));
      remember(draft, `inbox:${row.author}`);
      noteActivity(`在抖音评论通知里回复了 ${row.author}：${draft}`);
      try {
        const db = openDouyinDb(root);
        saveComment(db, { workId: '', author: row.author, text: row.text, kind: pipeline.understood.kind, commentAt: commentAt(row.raw), source: 'inbox' });
        saveFan(db, { name: row.author, text: row.text, at: new Date().toISOString() });
        markReplied(db, { workId: '', author: row.author, text: row.text, reply: draft, replyKind, at: new Date().toISOString() });
        db.close();
      } catch {}
      results.push({
        author: row.author, comment: row.text, kind: pipeline.understood.kind, reply: draft,
        ...(pipeline.published ?? {}), compliance: level, receipt: pipeline.receipt?.status, stages: trace,
      });
    }
    console.log(JSON.stringify({ status: 'done', replied: sentCount, results }, null, 2));
    return;
  }

  if (has('reply-own') || has('reply-comments')) {
    const maxWorks = Math.max(1, Number(option('max', '10')));
    const perRun = Math.max(1, Number(option('limit', '20')));
    const dryRun = has('dry-run');
    const store = repliedStore();
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    await resetDouyin(serial);
    await openProfile(serial);
    const results = [];
    const skipped = new Set();
    let sentCount = 0;
    const onlyWork = option('work');
    for (let index = 0; index < maxWorks && sentCount < perRun; index += 1) {
      if (onlyWork !== undefined && index !== Number(onlyWork)) continue;
      let panel;
      try {
        panel = await openWorkComments(serial, index);
      } catch (error) {
        results.push({ work: index, error: error.message });
        if (onlyWork !== undefined) break;
        await backToProfile(serial).catch(() => {});
        continue;
      }
      const rows = parseComments(panel);
      const owner = panelOwner(panel);
      results.push({ work: index, comments: rows.length, owner });
      for (const row of rows) {
        if (sentCount >= perRun) break;
        const key = `${index}|${row.author}|${row.text.slice(0, 40)}`;
        if (row.isAuthorReply || (owner && row.author === owner)) {
          results.push({ work: index, comment: row.text, skipped: 'own_reply' });
          continue;
        }
        if ((store.has(key) || store.hasLike(row.text.slice(0, 20))) && !dryRun) {
          results.push({ work: index, comment: row.text, skipped: 'already_replied' });
          continue;
        }
        let text = option('text');
        if (!text) {
          if (!has('generate')) throw new Error('need_text_or_generate');
          text = await (douyinBrain(home))({ caption: row.text, keyword: '回复评论' });
        }
        const { decision } = gate(text);
        if (!decision.ok) {
          results.push({ work: index, comment: row.text, drafted: text, blocked: decision.reason, level: decision.level });
          continue;
        }
        try {
          const result = await replyToComment(serial, { match: row.text.slice(0, 12), reply: text, dryRun });
          results.push({ work: index, comment: row.text, reply: text, ...result, compliance: decision.level });
          if (result.sent) {
            sentCount += 1;
            store.add(key);
            remember(text, row.text);
            noteActivity(`在抖音回复了 ${row.author} 的评论：${text}`);
          }
        } catch (error) {
          results.push({ work: index, comment: row.text, reply: text, error: error.message });
        }
        await pause(1400);
      }
      await backToProfile(serial);
      await pause(1200);
    }
    console.log(JSON.stringify({ status: 'done', replied: sentCount, results }, null, 2));
    return;
  }

  if (has('reply-interaction')) {
    const index = Number(option('reply-interaction', '0'));
    await resetDouyin(serial);
    await openInteractions(serial);
    const { opened, nodes } = await openInteraction(serial, index);
    const rows = parseComments(nodes);
    let text = option('text');
    if (!text) {
      if (!has('generate')) throw new Error('need_text_or_generate');
      text = await (douyinBrain(home))({ caption: rows[0]?.text ?? opened, keyword: '回复评论' });
    }
    const { decision } = gate(text);
    if (!decision.ok) {
      console.log(JSON.stringify({ level: decision.level, id: decision.id, reason: decision.reason }, null, 2));
      process.exitCode = decision.level === 'block' ? 2 : 3;
      return;
    }
    const result = await sendInCurrentComposer(serial, text, { dryRun: has('dry-run') });
    if (result.sent) remember(text, `interaction:${opened}`);
    console.log(JSON.stringify({ opened, comment: rows[0]?.text ?? '', reply: text, ...result, compliance: decision.level }, null, 2));
    return;
  }

  if (has('auto-comment')) {
    const keyword = option('keyword');
    const pick = Math.max(1, Number(option('pick', '1')));
    const pickText = option('pick-text');
    // 先确认在首页，再进搜索：抖音停在别的页时，坐标点击会打空
    if (!(await onSearchResults(serial))) {
      await waitForHome(serial).catch(() => false);
      await openSearch(serial);
    }
    const searched = await searchKeyword(serial, keyword);
    if (!(await onSearchResults(serial))) {
      // 一次整页恢复：重新拉起抖音、回首页、再搜一次
      await resetDouyin(serial);
      await waitForHome(serial).catch(() => false);
      await openSearch(serial);
      await searchKeyword(serial, keyword);
    }
    // 「综合」页第一条往往是话题/用户，不是视频：先切到「视频」页签，再只认像标题的结果（≥12 字）
    const videoTab = searched.find((node) => node.text?.trim() === '视频' && node.bounds.cy < 700);
    if (videoTab) {
      const { tapPoint: tapTab } = await import('../device/uia.mjs');
      await tapTab(serial, { x: videoTab.bounds.cx, y: videoTab.bounds.cy });
      const { sleep: napToVideo } = await import('../device/uia.mjs');
      await napToVideo(2400);
    }
    const results = parseResults(await dumpUi(serial))
      .filter((item) => item.text.length >= 12)
      .slice(0, 12);
    const target = pickText ? results.find((item) => item.text.includes(pickText)) : results[pick - 1];
    if (!target) throw new Error(`result_not_found:${pick}`);
    // 同一个视频别回第二次：把自己发过的 video 标题记在 state.recentVideos 里（--allow-repeat 可强制）
    if (!has('allow-repeat')) {
      const st = loadState();
      const seen = (st.recentVideos ?? []).find((item) => item.video === target.text);
      if (seen) {
        const minutes = Math.round((Date.now() - seen.at) / 60000);
        console.log(`RESULT_JSON ${JSON.stringify({ sent: false, verified: null, blocked: 'duplicate_video', reason: `这个视频 ${minutes} 分钟前已经回过：${target.text.slice(0, 24)}` })}`);
        return;
      }
    }
    // 必须确认真的在搜索结果页：否则点下去可能打在「互动消息」的评论行上，永远进不了详情
    if (!(await onSearchResults(serial))) throw new Error(`not_on_search:${await currentActivity(serial)}`);
    // 先拟稿、过闸门，再动手机：模型要十几秒，期间详情页会被系统回收（之前就是在这里丢页面）
    const caption = target.text;
    let text = option('text');
    if (!text) {
      if (!has('generate')) throw new Error('need_text_or_generate');
      text = await (douyinBrain(home))({ caption, keyword });
    }
    const { decision } = gate(text);
    console.log(JSON.stringify({ video: caption, drafted: text, level: decision.level, reason: decision.reason }, null, 2));
    // --land 只验证「能不能落到视频详情页」，不发表评论（干跑用：闸门挡着也能测落点）
    const landOnly = has('land');
    // --skip-gate 只给「人工验证一次」用：绕过本项目自己的限速（90 秒 / 每小时 5 条），
    // 绝不进定时任务，也不改 gate() 本身
    const skipGate = has('skip-gate');
    if (skipGate && !decision.ok) console.log(JSON.stringify({ gate_bypassed: true, reason: decision.reason }));
    if (!decision.ok && !landOnly && !skipGate) {
      // 被闸门挡住（比如 90 秒内发过一条）也要给调用方一个结构化结论，别让它只看到「没有结果」
      console.log(`RESULT_JSON ${JSON.stringify({ sent: false, verified: null, blocked: decision.level, reason: decision.reason })}`);
      return;
    }
    if (has('dry-run') && !landOnly) return;
    const { tapPoint } = await import('../device/uia.mjs');
    const { sleep } = await import('../device/uia.mjs');
    // 搜索结果页里，标题文字的坐标不一定是「能点开视频」的那块（封面在左边、标题在右边），
    // 所以连试三种落点：标题 → 同一张卡的封面 → 卡片左侧留白。三次都不动才算真失败。
    let activity = '';
    const attempts = [
      // 视频卡在「视频」页签里：标题下面那行文字，封面在标题上方约 300px
      () => ({ x: target.point.x, y: Math.max(700, target.point.y - 300) }),
      () => ({ x: target.point.x, y: Math.max(700, target.point.y - 180) }),
      () => target.point,
    ];
    const { isWorkDetailOpen } = await import('../device/douyin.mjs');
    // 搜索结果页的卡片位置偶尔会变（有时是单列大卡、有时是双列），失败就整页重搜一次再试
    for (let round = 0; round < 2; round += 1) {
      for (const pickPoint of attempts) {
        await tapPoint(serial, pickPoint());
        await sleep(2600);
        activity = await currentActivity(serial);
        if (await isWorkDetailOpen(serial)) break;
      }
      if (await isWorkDetailOpen(serial)) break;
      if (round === 0) {
        await openSearch(serial);
        await searchKeyword(serial, keyword);
        await sleep(1800);
        const tab2 = await dumpUi(serial);
        const videoTab = tab2.find((node) => node.text?.trim() === '视频' && node.bounds.cy < 700);
        if (videoTab) { await tapPoint(serial, { x: videoTab.bounds.cx, y: videoTab.bounds.cy }); await sleep(2200); }
      }
    }
    if (landOnly) {
      const landed = await isWorkDetailOpen(serial);
      console.log(`RESULT_JSON ${JSON.stringify({ landed, video: caption.slice(0, 40), activity })}`);
      return;
    }
    if (!(await isWorkDetailOpen(serial))) throw new Error(`detail_not_opened:${activity}`);
    // 先拟稿再动手机：模型调用要十几秒，期间详情页会被系统回收（之前就是在这里丢掉页面的）
    if (!(await isWorkDetailOpen(serial))) {
      let reopened = false;
      for (const pickPoint of attempts) {
        await tapPoint(serial, pickPoint());
        await sleep(2400);
        if (await isWorkDetailOpen(serial)) { reopened = true; break; }
      }
      if (!reopened) throw new Error('detail_not_reopened');
    }
    let result;
    try {
      // 打开评论面板也要包进 try：打不开同样要落现场（之前这类失败没有截图可看）
      await openCommentsSmart(serial);
      result = await postComment(serial, text);
    } catch (error) {
      // 失败现场落盘：下次直接看截图和控件树，不用再猜页面停在哪
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { execFileSync } = await import('node:child_process');
      const dir = join(home, '..', 'douyin', 'failures');
      mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
      const shot = join(dir, `comment-${stamp}.png`);
      const tree = join(dir, `comment-${stamp}.json`);
      try { writeFileSync(shot, execFileSync('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], { maxBuffer: 32 * 1024 * 1024 })); } catch { /* 截图失败不影响结论 */ }
      try { writeFileSync(tree, JSON.stringify(await dumpUi(serial), null, 1)); } catch { /* 同上 */ }
      throw new Error(`${error.message}|failure_captured:${shot}`);
    }
    if (result.sent) remember(text, caption);
    console.log(JSON.stringify({ ...result, compliance: decision.level }, null, 2));
    // 机器可读的结论行：调用方（actions.mjs 的判定链）只认这一行，别去解析上面的多行 JSON
    console.log(`RESULT_JSON ${JSON.stringify({ sent: result.sent === true, verified: result.verified ?? null, video: caption })}`);
    return;
  }

  console.log('用法：--comments | --comment "文案" | --reply-match "关键词" --reply "文案" | --search "关键词" | --auto-comment --keyword "关键词" [--pick N] [--generate] | --interactions | --open-interaction N | --hot-videos [--keyword 词] | --hot-comment-round [--videos 2] [--per-video 2] [--generate] [--dry-run] | --rules');
}

main().catch((error) => {
  console.error(`抖音操作失败：${error.message}`);
  process.exit(1);
});
