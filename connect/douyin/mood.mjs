/**
 * 大肥鱼的情绪：每天给自己一个心情，心情决定今天干多少活、怎么说人话。
 * 先规则、后 LLM（LLM 只负责把 why 说成人话，不改结果，保证可测、每天不会乱跳）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const MOODS = ['calm', 'happy', 'curious', 'playful', 'focused', 'low_energy'];

const TZ = 'Asia/Shanghai';
const MOOD_TEXT = {
  calm: '平静，语气轻一点，句子短一点',
  happy: '心情不错，语气亮一点，可以多用「～」',
  curious: '好奇，想多问一句、多看一眼',
  playful: '调皮，爱接梗、爱自嘲',
  focused: '专注，少玩梗，把事办利落',
  low_energy: '没什么电，短句，别硬撑场面',
};

const DAY_MS = 86_400_000;

export function shanghaiDay(now = Date.now()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(new Date(now));
}

export function shanghaiClock(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(now));
  const get = (type) => parts.find((part) => part.type === type)?.value ?? '00';
  return `${get('hour')}:${get('minute')}`;
}

export function dayStartMs(day) {
  return Date.parse(`${day}T00:00:00+08:00`);
}

export function moodPath(root) {
  return join(root, '..', 'persona', 'mood.json');
}

export function initMood(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS mood_history(
    day TEXT PRIMARY KEY, mood TEXT NOT NULL, energy REAL NOT NULL, valence REAL NOT NULL,
    why TEXT, created_at INTEGER NOT NULL);`);
}

export function readMood(root) {
  const path = moodPath(root);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export function writeMood(root, mood, now = Date.now()) {
  const path = moodPath(root);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ ...mood, updatedAt: new Date(now).toISOString() }, null, 2)}\n`);
  } catch {}
  return mood;
}

/** 昨天的战绩：任务总数/成功/失败/距上次发布多少天。 */
export function moodInputs(db, now = Date.now()) {
  const yesterday = shanghaiDay(now - DAY_MS);
  const start = dayStartMs(yesterday);
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM external_tasks WHERE created_ms>=? AND created_ms<? GROUP BY status').all(start, start + DAY_MS);
  const counts = Object.fromEntries(rows.map((row) => [row.status, Number(row.n)]));
  const total = rows.reduce((sum, row) => sum + Number(row.n), 0);
  const succeeded = counts.succeeded ?? 0;
  const failed = counts.failed ?? 0;
  const lastPublish = Number(db.prepare("SELECT MAX(updated_ms) AS t FROM external_tasks WHERE status='succeeded' AND payload LIKE '%douyin.publish%'").get()?.t ?? 0);
  const daysSincePublish = lastPublish ? Math.floor((now - lastPublish) / DAY_MS) : 99;
  return { day: yesterday, total, succeeded, failed, counts, daysSincePublish };
}

function pick(list, random) {
  return list[Math.min(list.length - 1, Math.floor(random() * list.length))];
}

/** 规则版心情：跑得多 → 高兴/好奇；连挂两次 → 没电；久不发作品 → 好奇想搞事。 */
export function nextMood(inputs, random = Math.random) {
  const { total = 0, succeeded = 0, failed = 0, daysSincePublish = 99 } = inputs ?? {};
  if (failed >= 2) return { mood: 'low_energy', energy: 0.35, valence: 0.4, why: `昨天有 ${failed} 件事没办成，今天慢一点。` };
  if (!total) return daysSincePublish >= 3
    ? { mood: 'curious', energy: 0.7, valence: 0.62, why: '好几天没发作品了，想搞点新东西。' }
    : { mood: pick(['calm', 'playful'], random), energy: 0.55, valence: 0.55, why: '昨天挺安静，今天随便转转。' };
  const rate = succeeded / Math.max(1, succeeded + failed);
  if (rate >= 0.8 && succeeded >= 2) {
    return pick(['happy', 'curious'], random) === 'happy'
      ? { mood: 'happy', energy: 0.78, valence: 0.75, why: `昨天办成 ${succeeded} 件事，挺顺。` }
      : { mood: 'curious', energy: 0.72, valence: 0.66, why: `昨天办成 ${succeeded} 件事，想再试试新的。` };
  }
  if (daysSincePublish >= 3) return { mood: 'curious', energy: 0.7, valence: 0.62, why: '好几天没发作品了，想找点灵感。' };
  return { mood: pick(['calm', 'focused'], random), energy: 0.6, valence: 0.55, why: `昨天办了 ${total} 件事，有成功也有卡壳。` };
}

export function describeMood(mood) {
  return MOOD_TEXT[mood] ?? MOOD_TEXT.calm;
}

/** 今天的心情：有历史就用历史（并补写 mood.json），没有就算一个。 */
export function ensureMood(db, root, now = Date.now(), random = Math.random) {
  const day = shanghaiDay(now);
  const row = db.prepare('SELECT * FROM mood_history WHERE day=?').get(day);
  if (row) {
    const existing = readMood(root);
    if (!existing || existing.date !== day) writeMood(root, { date: day, mood: row.mood, energy: row.energy, valence: row.valence, why: row.why ?? '' }, now);
    return { date: day, mood: row.mood, energy: row.energy, valence: row.valence, why: row.why ?? '', created_at: row.created_at };
  }
  const inputs = moodInputs(db, now);
  const next = nextMood(inputs, random);
  const record = { date: day, ...next };
  writeMood(root, record, now);
  db.prepare('INSERT OR REPLACE INTO mood_history(day,mood,energy,valence,why,created_at) VALUES(?,?,?,?,?,?)')
    .run(day, next.mood, next.energy, next.valence, next.why, now);
  return { ...record, created_at: now };
}

export function moodHistory(db, limit = 14) {
  return db.prepare('SELECT day, mood, energy, valence, why FROM mood_history ORDER BY day DESC LIMIT ?').all(Math.max(1, Math.min(90, Number(limit) || 14)));
}
