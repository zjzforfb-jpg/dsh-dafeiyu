/**
 * 周成长日记：把最近 7 天的真实战绩写成一篇第一人称的日记，并落进成长档案。
 */
import { existsSync, readFileSync } from 'node:fs';
import { runtimeDir } from '../core/paths.mjs';
import { join } from 'node:path';
import { fanSummary, hotStats } from '../../connect/douyin/store.mjs';
import { DatabaseSync } from 'node:sqlite';

const DAY_MS = 24 * 3600_000;
const shanghaiDay = (ms) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);

function readSettings(home) {
  try {
    return JSON.parse(readFileSync(join(home, 'dsh-pet', 'standalone-ai.json'), 'utf8'));
  } catch {
    return {};
  }
}

function openReadOnly(dbPath, fn, fallback) {
  if (!existsSync(dbPath)) return fallback;
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    return fn(db);
  } catch {
    return fallback;
  } finally {
    try { db?.close(); } catch {}
  }
}

export function weekStats(db, root, now = Date.now()) {
  const since = now - 7 * DAY_MS;
  const tasks = db.prepare('SELECT status, created_ms FROM external_tasks WHERE created_ms >= ?').all(since);
  const succeeded = tasks.filter((task) => task.status === 'succeeded').length;
  const failed = tasks.filter((task) => task.status === 'failed').length;
  let courses = 0;
  let steps = 0;
  try {
    courses = db.prepare("SELECT COUNT(DISTINCT course_id) n FROM study_sessions WHERE created_at >= ?").get(new Date(since).toISOString()).n;
    steps = db.prepare('SELECT COUNT(*) n FROM study_sessions WHERE created_at >= ?').get(new Date(since).toISOString()).n;
  } catch {}
  const douyin = openReadOnly(join(runtimeDir(root), 'douyin', 'douyin.db'), (dy) => {
    const works = dy.prepare('SELECT code, title, views, likes FROM works WHERE COALESCE(published_at, created_at) >= ? ORDER BY COALESCE(published_at, created_at) DESC').all(new Date(since).toISOString());
    const received = dy.prepare('SELECT COUNT(*) n FROM comments WHERE COALESCE(comment_epoch, 0) >= ?').get(since).n;
    const replied = dy.prepare('SELECT COUNT(*) n FROM comments WHERE replied_at >= ?').get(new Date(since).toISOString()).n;
    return { works, received, replied, hot: hotStats(dy), fans: fanSummary(dy) };
  }, { works: [], received: 0, replied: 0, hot: { videos: 0, comments: 0, replied: 0 }, fans: { fans: 0, interactions: 0, top: [] } });
  return {
    from: shanghaiDay(since),
    to: shanghaiDay(now),
    tasks: { total: tasks.length, succeeded, failed, rate: tasks.length ? Math.round((succeeded / tasks.length) * 100) : null },
    courses,
    steps,
    works: douyin.works,
    received: douyin.received,
    replied: douyin.replied,
    hot: douyin.hot,
    fans: douyin.fans,
  };
}

const pct = (value) => (value == null ? '还没数据' : `${value}%`);

export function weeklyFallback(stats) {
  const lines = [
    `这一周（${stats.from}–${stats.to}）我干了这些事：`,
    `- 任务 ${stats.tasks.total} 个，成了 ${stats.tasks.succeeded} 个（成功率 ${pct(stats.tasks.rate)}）`,
    `- 发了 ${stats.works.length} 篇作品${stats.works.length ? `：${stats.works.map((work) => `${work.code ?? ''}《${work.title}》`).join('、')}` : ''}`,
    `- 收到 ${stats.received} 条评论，回了 ${stats.replied} 条`,
    `- 在爆款下回了 ${stats.hot.replied} 条热评，认识了 ${stats.fans.fans} 个粉丝`,
    `- 上了 ${stats.steps} 步课，涉及 ${stats.courses} 门课`,
    '',
    '下礼拜我要做得更好一点。',
  ];
  return lines.join('\n');
}

export async function writeWeekly(db, root, home, now = Date.now(), { ask, fetchImpl = fetch } = {}) {
  // 档案表由学习块建；周记可能在没学过任何课时先跑，这里补一次。
  const { initAcademy } = await import('./study.mjs');
  initAcademy(db);
  const stats = weekStats(db, root, now);
  const prompt = [
    `用第一人称写一篇 200 字以内的「大肥鱼周记」，语气可爱、具体、别喊口号。这周的真实数据：`,
    `任务 ${stats.tasks.total} 个，成功 ${stats.tasks.succeeded}，失败 ${stats.tasks.failed}；`,
    `作品 ${stats.works.length} 篇（${stats.works.map((work) => work.title).join('；') || '无'}）；`,
    `收到评论 ${stats.received} 条，回复 ${stats.replied} 条；爆款下回 ${stats.hot.replied} 条；`,
    `粉丝 ${stats.fans.fans} 个；学习 ${stats.steps} 步、${stats.courses} 门课。`,
    `写清：做过什么、哪里没做好、下周想改什么。数字要跟上面一致，不要编。`,
  ].join('\n');
  let body = weeklyFallback(stats);
  let degraded = false;
  try {
    if (ask) {
      const text = String(await ask(prompt, '你是大肥鱼，写自己的周记。') ?? '').trim();
      if (text) body = text;
    } else {
      const settings = readSettings(home);
      const baseUrl = String(settings.baseUrl ?? 'http://127.0.0.1:3110/v1').replace(/\/+$/u, '');
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.apiKey ?? 'local'}` },
        body: JSON.stringify({
          model: settings.model ?? 'deepseek-flash',
          messages: [{ role: 'system', content: '你是大肥鱼，一只住在桌面的蓝发小鲸鱼，用第一人称写周记。' }, { role: 'user', content: prompt }],
          max_tokens: 2200,
          temperature: 0.7,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`llm_${response.status}`);
      const data = await response.json();
      const text = String(data?.choices?.[0]?.message?.content ?? '').trim();
      if (text) body = text;
      else degraded = true;
    }
  } catch (error) {
    degraded = true;
    body = `${weeklyFallback(stats)}\n\n（模型这次没接上：${String(error?.message ?? error)}）`;
  }
  const title = `成长日记 · ${stats.from} ~ ${stats.to}`;
  const at = new Date(now).toISOString();
  db.prepare("INSERT INTO growth_archive (section, title, body, source, level, created_at) VALUES ('growth', ?, ?, 'weekly', 'mastered', ?)")
    .run(title, body, at);
  return { status: 'weekly', title, body, stats, degraded };
}
