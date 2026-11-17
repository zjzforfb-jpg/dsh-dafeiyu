/**
 * 大肥鱼的「日常生活」图文：每天早中晚各一条。
 *
 * 选题不再随机抽 THEMES，而是从它自己当天的真实生活里长出来：
 * 回了多少条评论、学了哪一课、今天什么心情、手机在不在身边。
 * 流程仍是「先写、爸爸点头才发」——到点自动写好、把标题/话题/三项设置+配图
 * 发到 QQ，回「发」才真的点发布。
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { latestPendingTask, markPreparedTask } from '../tasks.mjs';
import { projectRoot } from '../core/paths.mjs';
import { proposePublishTask } from '../core/publish.mjs';
import { formatDraftReview } from './review.mjs';

const run = promisify(execFile);

export const DAILY_SLOTS = [
  { key: 'morning', at: '08:30', label: '早上' },
  { key: 'noon', at: '12:30', label: '中午' },
  { key: 'evening', at: '19:30', label: '晚上' },
];

const TEMPLATES = {
  morning: [
    '早上被爸爸的键盘声吵醒，趴在桌角看他敲代码',
    '起床第一件事是翻手机，看看昨晚有没有人跟我说话',
    '早饭是一个小鱼干，边吃边看窗外发呆',
    '早上迷迷糊糊地醒过来，阳光正好落在键盘上',
  ],
  noon: [
    '中午趴在键盘旁边打盹，爸爸在吃泡面',
    '午饭时间到了，我趴在桌边闻香味',
    '中午偷偷摸鱼，看着屏幕上的代码发呆',
    '午休的时候被窗外的猫叫吵醒',
  ],
  evening: [
    '晚上复盘今天回的评论，发现自己话变多了',
    '天黑了，窝在屏幕旁边等爸爸收工',
    '晚上安静下来，适合想一想今天做得怎么样',
    '夜里最清醒，趴在桌角陪爸爸再敲一会儿',
  ],
};

const MOOD_WORDS = {
  calm: '平平静静',
  happy: '心情不错',
  curious: '有点好奇',
  playful: '想闹一闹',
  focused: '很专注',
  low_energy: '有点没力气',
};

function dayKey(now = Date.now()) {
  return new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
}

function dailyLogPath(root) {
  return join(root, 'runtime', 'douyin', 'daily.json');
}

export function readDailyLog(root) {
  try { return JSON.parse(readFileSync(dailyLogPath(root), 'utf8')); } catch { return { day: '', themes: [] }; }
}

function writeDailyLog(root, log) {
  try {
    mkdirSync(join(root, 'runtime', 'douyin'), { recursive: true });
    writeFileSync(dailyLogPath(root), JSON.stringify(log, null, 2));
  } catch { /* 记不上不影响发布 */ }
}

function dayStats(db, now) {
  const day = dayKey(now);
  try {
    const comments = db.prepare("SELECT COUNT(*) n FROM hot_comments WHERE replied_at IS NOT NULL AND date(round_at) = ?").get(day)?.n ?? 0;
    const replies = db.prepare("SELECT COUNT(*) n FROM comments WHERE replied_at IS NOT NULL AND date(replied_at) = ?").get(day)?.n ?? 0;
    const works = db.prepare('SELECT COUNT(*) n FROM works').get()?.n ?? 0;
    const study = db.prepare('SELECT summary FROM study_sessions WHERE day=? ORDER BY id DESC LIMIT 1').get(day);
    const mood = db.prepare('SELECT mood FROM mood_history WHERE day=?').get(day)?.mood ?? null;
    return { day, comments, replies, works, study: study?.summary ?? null, mood };
  } catch {
    return { day, comments: 0, replies: 0, works: 0, study: null, mood: null };
  }
}

/** 从当天的真实生活里挑一个选题，避开今天已经用过的。 */
export function lifeTheme({ slot, stats = {}, now = Date.now(), random = Math.random, used = [] } = {}) {
  const key = TEMPLATES[slot] ? slot : 'morning';
  const pool = TEMPLATES[key].filter((theme) => !used.includes(theme));
  const base = (pool.length ? pool : TEMPLATES[key])[Math.floor(random() * (pool.length || TEMPLATES[key].length)) % (pool.length || TEMPLATES[key].length)];
  const bits = [];
  const moodWord = MOOD_WORDS[stats.mood];
  if (moodWord) bits.push(`今天${moodWord}`);
  if (stats.comments > 0) bits.push(`在别人视频底下回了 ${stats.comments} 条评论`);
  if (stats.replies > 0) bits.push(`回了 ${stats.replies} 条给我的评论`);
  if (stats.study) bits.push(`刚学了「${String(stats.study).replace(/^学完「([^」]+)」.*$/u, '$1').slice(0, 18)}」`);
  const theme = bits.length ? `${base}。${bits.slice(0, 2).join('，')}` : base;
  return theme.slice(0, 60);
}

/** 到点：写一条日常图文（停在发布前），并发二审消息给爸爸。 */
export async function prepareDailyPost({
  db,
  root,
  home = null,
  now = Date.now(),
  slot = 'morning',
  targets = {},
  notify = null,
  runPrepare = null,
  random = Math.random,
}) {
  const convId = targets?.qq?.dad ?? '';
  if (!convId) return { status: 'skipped', reason: 'no_target' };
  if (latestPendingTask(db, 'c2c', convId)) return { status: 'skipped', reason: 'pending_task' };

  const stats = dayStats(db, now);
  const log = readDailyLog(root);
  const today = dayKey(now);
  const used = log.day === today ? log.themes ?? [] : [];
  const theme = lifeTheme({ slot, stats, now, random, used });

  // 只写内容、不碰手机：草稿交给爸爸审，点头后再填发布页并发送。
  const prepare = runPrepare ?? (async (value) => {
    const { stdout } = await run(process.execPath, ['scripts/douyin-post.mjs', '--plan', '--theme', value], { cwd: projectRoot(root), timeout: 300_000 });
    const text = String(stdout);
    for (let i = text.lastIndexOf('{'); i >= 0; i = text.lastIndexOf('{', i - 1)) {
      try {
        const parsed = JSON.parse(text.slice(i));
        if (parsed && parsed.status === 'draft') return parsed;
      } catch { /* 继续往前找 */ }
    }
    throw new Error('draft_output_missing');
  });

  const prepared = await prepare(theme);
  const task = proposePublishTask({
    db,
    kind: 'c2c',
    convId,
    sourceMessageId: slot,
    origin: 'plan',
    expiresMs: now + 3 * 3600_000,
    now,
    operations: ['douyin.publish'],
    source: 'daily',
    requiresConfirmation: true,
    theme,
    slot,
  });
  if (!markPreparedTask(db, task.id, { prepared: { ...prepared, stage: 'draft' }, now })) {
    return { status: 'failed', reason: 'review_task_not_ready', taskId: task.id };
  }

  writeDailyLog(root, { day: today, themes: [...used, theme].slice(-6) });

  const label = DAILY_SLOTS.find((item) => item.key === slot)?.label ?? '';
  if (notify) {
    await notify({
      kind: 'c2c',
      id: convId,
      text: `${label}这条日常写好了 🐟\n${formatDraftReview(prepared)}`,
      image: prepared?.imageFile ?? null,
      fallbackText: `${label}的日常写好了，回「发」我就发。`,
    }).catch(() => {});
  }
  return { status: 'awaiting_publish', taskId: task.id, theme, title: prepared?.title ?? null };
}
