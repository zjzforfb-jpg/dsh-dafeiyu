#!/usr/bin/env node
/**
 * 抖音新消息红点监测：每隔一段时间回首页看一眼「消息」tab 有没有红点。
 *
 * 和 scripts/douyin-watch.mjs（互动消息守护，默认 30 分钟一轮）的分工：
 * 这个只做「便宜的哨兵」——首页红点一秒可判，有红点才去跑重活。
 *
 * 为什么这么做：抖音没有给我们任何推送接口，但首页底部「消息」的红点就是
 * 最便宜的信号——有红点才值得进消息 → 互动 → 评论列表，再决定回不回。
 *
 * 用法：
 *   node scripts/douyin-inbox-watch.mjs --probe        # 只看一眼，打印有没有红点
 *   node scripts/douyin-inbox-watch.mjs --once --reply # 检查一次，有消息就去回
 *   node scripts/douyin-inbox-watch.mjs --interval 60  # 常驻，每 60 秒查一次
 *
 * 状态写在 runtime/douyin/inbox-watch-state.json，事件写进 agent_events。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { parseMessageBadge, openFeed, currentActivity } from '../device/douyin.mjs';
import { deviceSerial } from '../device/wechat.mjs';
import { dumpUi, sleep as sleepMs } from '../device/uia.mjs';
import { projectRoot, homeOf } from '../connect/core/paths.mjs';
import { recordAgentEvent } from '../connect/agent-events.mjs';

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : fallback;
};

const root = projectRoot(process.cwd());
const stateDir = join(root, 'runtime', 'douyin');
const stateFile = join(stateDir, 'inbox-watch-state.json');
const lockFile = join(stateDir, 'inbox-watch.lock');
const intervalSec = Math.max(20, Number(option('interval', 60)) || 60);
const limit = Math.max(1, Number(option('limit', 8)) || 8);
const once = has('once') || has('probe');
const probe = has('probe');
const reply = !has('no-reply') && !probe;
const forceReply = has('force-reply');
// 默认不主动把抖音拉到前台：手机是主人在用，哨兵只「顺手看一眼」，不抢屏。
const mayLaunch = has('launch');
const serialArg = option('serial', '');

mkdirSync(stateDir, { recursive: true });

function readState() {
  try { return JSON.parse(readFileSync(stateFile, 'utf8')); } catch { return {}; }
}
function writeState(patch) {
  const next = { ...readState(), ...patch, at: new Date().toISOString() };
  writeFileSync(stateFile, JSON.stringify(next, null, 1));
  return next;
}
function takeLock() {
  if (existsSync(lockFile)) {
    const holder = Number(readFileSync(lockFile, 'utf8').trim());
    // 进程还在就退让；锁是上一轮崩掉留下的就抢过来
    if (holder && holder !== process.pid) {
      try { process.kill(holder, 0); return false; } catch { rmSync(lockFile, { force: true }); }
    }
  }
  writeFileSync(lockFile, String(process.pid));
  return true;
}
function releaseLock() {
  try {
    if (Number(readFileSync(lockFile, 'utf8').trim()) === process.pid) unlinkSync(lockFile);
  } catch { /* 锁已不在，无所谓 */ }
}

/** 跑一条只读的 adb 命令并把 stdout 带回来（device/douyin.mjs 的 adbShell 只负责跑、不返回输出）。 */
async function adbText(serial, command) {
  const { execFile } = await import('node:child_process');
  return await new Promise((resolve) => {
    execFile(process.env.ADB_PATH || 'adb', ['-s', serial, 'shell', command], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? '' : String(stdout ?? ''));
    });
  });
}

function openDb() {
  const dbPath = join(root, 'runtime', 'connect', 'connect.sqlite');
  return existsSync(dbPath) ? new DatabaseSync(dbPath) : null;
}
function record(eventType, payload) {
  const db = openDb();
  if (!db) return;
  try {
    recordAgentEvent(db, {
      eventType,
      channel: 'douyin',
      actor: 'douyin-inbox-watch',
      payload,
      dedupeKey: `${eventType}:${payload.key ?? Date.now()}`,
    });
  } catch { /* 记账失败不影响主流程 */ } finally { db.close(); }
}

/**
 * 脚本最后会打印一段（可能被缩进、可能不止一行的）JSON 摘要。
 * 逐行 parse 会失败，这里从最后一个「顶格 {」开始整段 parse，取最靠后的成功块。
 */
function parseTailJson(text) {
  const source = String(text ?? '').trim();
  if (!source) return null;
  const starts = [];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '{' && (i === 0 || source[i - 1] === '\n')) starts.push(i);
  }
  for (let i = starts.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(source.slice(starts[i])); } catch { /* 试前一个 */ }
  }
  try { return JSON.parse(source); } catch { return null; }
}

/**
 * 手机只有一台：定时任务正在跑（external_tasks 有 running）时先让路，
 * 免得哨兵把正在操作抖音的任务顶掉。
 */
function busyWithTask() {
  const db = openDb();
  if (!db) return false;
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM external_tasks WHERE status = 'running'").get();
    return Number(row?.n ?? 0) > 0;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

/** 有红点才值得进去：调一次现成的评论流水线（带作品上下文）。 */
async function replyOnce() {
  const started = Date.now();
  const args = ['scripts/douyin.mjs', '--reply-inbox', '--generate', '--limit', String(limit)];
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    const timer = setTimeout(() => child.kill('SIGTERM'), 12 * 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, parsed: parseTailJson(out) });
    });
  });
  const ms = Date.now() - started;
  if (result.code !== 0 || !result.parsed) {
    record('action_failed', { key: `reply:${started}`, operation: 'douyin.reply_comments', ms, error: (result.err || result.out).slice(-400) });
    return { ok: false, ms, error: (result.err || result.out).slice(-200) };
  }
  const replied = Number(result.parsed.count ?? result.parsed.replied ?? 0);
  const rows = Array.isArray(result.parsed.results) ? result.parsed.results : [];
  const skippedAll = rows.length > 0 && rows.every((row) => ['no_content', 'already_replied', 'nothing_new'].includes(row.skipped));
  const nothingToDo = result.parsed.nothingToDo === true || result.parsed.reason === 'nothing_to_do'
    || (replied === 0 && skippedAll);
  record(nothingToDo ? 'observation_created' : 'action_finished', {
    key: `reply:${started}`,
    operation: 'douyin.reply_comments',
    ms,
    status: result.parsed.status ?? 'ok',
    detail: nothingToDo ? '没有可回的评论' : `回了 ${replied} 条`,
  });
  return { ok: true, ms, replied, nothingToDo, results: result.parsed.results ?? [] };
}

async function tick() {
  if (!takeLock()) return { skipped: 'locked' };
  try {
    const serial = serialArg || (await deviceSerial());
    // 熄屏就不折腾：点亮屏幕会打断主人
    // 别用 `dumpsys power | grep -m1`：grep 提前关管道会让 adb 以非 0 退出，读出来是空串。
    const power = await adbText(serial, 'dumpsys power').catch(() => '');
    if (!/Awake/u.test(power)) {
      writeState({ lastCheck: new Date().toISOString(), lastSkip: 'screen_off' });
      return { skipped: 'screen_off' };
    }
    // 前台不是抖音就别抢：等主人自己回到抖音，或者显式加 --launch
    const top = await currentActivity(serial).catch(() => '');
    if (!/com\.ss\.android\.ugc\.aweme/u.test(top) && !mayLaunch) {
      writeState({ lastCheck: new Date().toISOString(), lastSkip: 'not_in_douyin', top });
      return { skipped: 'not_in_douyin', top };
    }
    const nodes = await openFeed(serial);
    const badge = parseMessageBadge(nodes);
    const activity = await currentActivity(serial).catch(() => '');
    const snapshot = { activity, badge, checkedAt: new Date().toISOString() };
    if (probe) return { ...snapshot, replied: null };
    if (!badge.has) {
      const had = Number(state.lastBadge ?? 0) > 0;
      writeState({ lastCheck: snapshot.checkedAt, lastBadge: 0, activity });
      // 没有红点：只在「刚清零」时记一笔，否则每分钟一条心跳会把事件流刷满
      if (had) record('observation_created', { key: `watch:${Date.now()}`, badge: 0, activity, summary: '首页消息 tab 红点清零了' });
      if (!forceReply || !reply) return { ...snapshot, replied: null };
      const forced = await replyOnce();
      writeState({ lastReplyAt: new Date().toISOString(), lastReply: forced });
      return { ...snapshot, replied: forced, forced: true };
    }
    writeState({ lastCheck: snapshot.checkedAt, lastBadge: badge.count ?? 1, activity });
    record('observation_created', { key: `watch:${Date.now()}`, badge: badge.count ?? 1, activity, summary: `首页消息 tab 有 ${badge.label || '未读'} 条` });
    if (!reply) return { ...snapshot, replied: null };
    if (busyWithTask()) {
      writeState({ lastSkip: new Date().toISOString(), lastSkipReason: 'task_running' });
      record('observation_created', { key: `skip:${Date.now()}`, badge: badge.count ?? 1, summary: '有红点，但有任务在跑，等下一轮' });
      return { ...snapshot, replied: null, skipped: 'task_running' };
    }
    const outcome = await replyOnce();
    writeState({ lastReplyAt: new Date().toISOString(), lastReply: outcome });
    return { ...snapshot, replied: outcome };
  } finally {
    releaseLock();
  }
}

process.on('SIGTERM', () => { releaseLock(); process.exit(0); });
process.on('SIGINT', () => { releaseLock(); process.exit(0); });
process.on('exit', releaseLock);

let stopping = false;
async function main() {
  const first = await tick();
  console.log(JSON.stringify({ event: 'tick', ...first }, null, 1));
  if (once) return;
  while (!stopping) {
    await sleepMs(intervalSec * 1000);
    try {
      const result = await tick();
      console.log(JSON.stringify({ event: 'tick', ...result }));
    } catch (error) {
      console.error(JSON.stringify({ event: 'error', message: String(error?.message ?? error) }));
    }
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(JSON.stringify({ event: 'fatal', message: String(error?.message ?? error) }, null, 1));
  releaseLock();
  process.exit(1);
});
