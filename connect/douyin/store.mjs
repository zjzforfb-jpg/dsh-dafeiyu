/**
 * 抖音内容库：一个关系型数据库，记录「我发过的作品」和「别人在这些作品下的评论 + 我的回复」。
 *
 * - works：每个作品一行，id 就是作品 id（dy-xxxx），发出去时写入。
 * - comments：每条评论一行，work_id 指回 works.id；按作品、按时间都能排。
 * - 评论只存文字（几十字），附件/图片只记 kind=image，不落图。
 *
 * 库文件：runtime/douyin/douyin.db
 */
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { ensureColumns, migrateDouyin } from '../core/migrations.mjs';
import { runtimeDir } from '../core/paths.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS works (
  id TEXT PRIMARY KEY,
  code TEXT,
  task_id TEXT,
  title TEXT NOT NULL,
  caption TEXT NOT NULL,
  topics TEXT NOT NULL DEFAULT '',
  image_file TEXT,
  theme TEXT,
  settings TEXT,
  published_at TEXT,
  status TEXT NOT NULL DEFAULT 'published',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_works_time ON works(COALESCE(published_at, created_at) DESC);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'text',
  comment_at TEXT,
  comment_epoch INTEGER,
  first_seen_at TEXT NOT NULL,
  reply_text TEXT,
  reply_kind TEXT,
  replied_at TEXT,
  source TEXT NOT NULL DEFAULT 'inbox',
  UNIQUE(work_id, author, text, comment_at)
);
CREATE INDEX IF NOT EXISTS idx_comments_work ON comments(work_id, comment_epoch DESC);
CREATE INDEX IF NOT EXISTS idx_comments_time ON comments(comment_epoch DESC);

-- 爆款视频（从搜索里按点赞捞的别人的视频）与我们在它们下面的热评
CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT,
  likes INTEGER NOT NULL DEFAULT 0,
  likes_text TEXT,
  keyword TEXT,
  date_text TEXT,
  status TEXT NOT NULL DEFAULT 'found',
  discovered_at TEXT NOT NULL,
  last_round_at TEXT,
  comment_rounds INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_videos_time ON videos(discovered_at DESC);

CREATE TABLE IF NOT EXISTS hot_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  likes INTEGER NOT NULL DEFAULT 0,
  likes_text TEXT,
  first_seen_at TEXT NOT NULL,
  reply_text TEXT,
  replied_at TEXT,
  round_at TEXT,
  UNIQUE(video_id, author, text)
);
CREATE INDEX IF NOT EXISTS idx_hot_comments_video ON hot_comments(video_id, likes DESC);

-- 平台数据的按天快照：作品每天一行，粉丝每天一行，用来画趋势
CREATE TABLE IF NOT EXISTS work_stats_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  work_id TEXT NOT NULL,
  views INTEGER,
  likes INTEGER,
  comments INTEGER,
  favorites INTEGER,
  shares INTEGER,
  at TEXT NOT NULL,
  UNIQUE(day, work_id)
);
CREATE INDEX IF NOT EXISTS idx_stats_work ON work_stats_history(work_id, day DESC);

CREATE TABLE IF NOT EXISTS fan_snapshots (
  day TEXT PRIMARY KEY,
  fans INTEGER NOT NULL DEFAULT 0,
  interactions INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL
);
`;

/** 只有表情 / 标点 / 一两个字却没有实际含义的评论。 */
const PICTURE = /^[\p{Extended_Pictographic}\p{Emoji_Component}\s\p{P}\p{S}\d]*$/u;
const MEANINGFUL = /[\p{Script=Han}a-zA-Z]/gu;

/** 回给「没什么可回」的评论——随机可爱表情，不硬编文字。 */
export const CUTE_REPLIES = ['🐟', '🐠✨', '🐳🥹', '😆💙', '🫧🐟', '😽🐚', '🌊🐬', '✨🐡', '🥺💧', '🎐🐟'];

export function pickCuteReply(random = Math.random) {
  return CUTE_REPLIES[Math.floor(random() * CUTE_REPLIES.length) % CUTE_REPLIES.length];
}

/** 判定一条评论属于哪种：text（有真话）/ emoji（纯表情）/ image（只有图）/ empty。 */
export function classifyComment(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { kind: 'image', meaningful: false };
  if (PICTURE.test(text)) return { kind: 'emoji', meaningful: false };
  const words = [...text.matchAll(MEANINGFUL)].length;
  if (words <= 1) return { kind: 'text', meaningful: false };
  return { kind: 'text', meaningful: true };
}

/** 「10小时前 / 昨天 21:49」这类抖音时间文案 → 毫秒时间戳（估算，用于排序）。 */
export function parseRelativeTime(raw, now = Date.now()) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  if (/刚刚/u.test(text)) return now;
  const ago = text.match(/(\d+)\s*(秒|分钟|小时|天|月)前/u);
  if (ago) {
    const unit = { 秒: 1e3, 分钟: 6e4, 小时: 36e5, 天: 864e5, 月: 30 * 864e5 }[ago[2]];
    return now - Number(ago[1]) * unit;
  }
  const clock = text.match(/(昨天|今天|前天)?\s*(\d{1,2}):(\d{2})/u);
  if (clock) {
    const date = new Date(now);
    const dayShift = clock[1] === '昨天' ? -1 : clock[1] === '前天' ? -2 : 0;
    date.setDate(date.getDate() + dayShift);
    date.setHours(Number(clock[2]), Number(clock[3]), 0, 0);
    return date.getTime();
  }
  return null;
}

export function openDouyinDb(root) {
  // root 可能是服务的工作目录（<repo>/runtime/connect），不能直接拼 runtime/douyin，
  // 否则会在 <repo>/runtime/connect/runtime/douyin 里造出一个空库，读到的是假数据。
  const dir = join(runtimeDir(root), 'douyin');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'douyin.db');
  const db = new DatabaseSync(file);
  try {
    chmodSync(dir, 0o700);
    chmodSync(file, 0o600);
  } catch {}
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  // 计划 A-8：版本化迁移（升级前自动 VACUUM INTO 备份）
  try {
    const migration = migrateDouyin(db, { backupDir: join(root, 'runtime', 'backups') });
    if (migration.applied.length) console.error(JSON.stringify({ douyin_migrations: migration.applied, backup: migration.backup }));
  } catch (error) {
    console.error(JSON.stringify({ douyin_migration_failed: String(error?.message ?? error).slice(0, 200) }));
  }
  ensureColumns(db, 'comments', ['comment_epoch']);
  ensureColumns(db, 'works', ['code','views','likes','favorites','shares','comments_stat','stats_at','images','draft_file']);
  db.exec('CREATE TABLE IF NOT EXISTS fans (id TEXT PRIMARY KEY, name TEXT NOT NULL, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, interactions INTEGER NOT NULL DEFAULT 0, last_text TEXT, notes TEXT)');
  db.exec('CREATE TABLE IF NOT EXISTS hotspots (id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT NOT NULL, videos INTEGER NOT NULL DEFAULT 0, top_likes INTEGER, verdict TEXT, note TEXT, created_at TEXT NOT NULL)');
  backfillCodes(db);
  return db;
}

/** 作品编号 DFY-0001 起；老作品按发布时间顺序补齐。 */
export function nextWorkCode(db) {
  const row = db.prepare("SELECT code FROM works WHERE code LIKE 'DFY-%' ORDER BY CAST(substr(code, 5) AS INTEGER) DESC LIMIT 1").get();
  const last = row ? Number(String(row.code).slice(4)) || 0 : 0;
  return `DFY-${String(last + 1).padStart(4, '0')}`;
}

export function backfillCodes(db) {
  const rows = db.prepare("SELECT id FROM works WHERE (code IS NULL OR code = '') AND status NOT IN ('draft') ORDER BY COALESCE(published_at, created_at) ASC").all();
  for (const row of rows) db.prepare('UPDATE works SET code = ? WHERE id = ?').run(nextWorkCode(db), row.id);
  return rows.length;
}

export function saveWork(db, work) {
  const now = new Date().toISOString();
  const id = work.id ?? `dy-${Date.now().toString(36)}`;
  const code = work.code ?? (work.status === 'draft' || work.status === 'draft_ready' ? null : nextWorkCode(db));
  const images = Array.isArray(work.images) && work.images.length ? work.images : (work.imageFile ? [work.imageFile] : []);
  db.prepare(`INSERT INTO works (id, code, task_id, title, caption, topics, image_file, theme, settings, published_at, status, created_at, images, draft_file)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET code = COALESCE(works.code, excluded.code), title = excluded.title, caption = excluded.caption, topics = excluded.topics,
      image_file = excluded.image_file, theme = excluded.theme, settings = excluded.settings,
      published_at = COALESCE(excluded.published_at, works.published_at), status = excluded.status, task_id = COALESCE(excluded.task_id, works.task_id),
      images = excluded.images, draft_file = COALESCE(excluded.draft_file, works.draft_file)`)
    .run(id, code, work.taskId ?? null, String(work.title ?? ''), String(work.caption ?? ''),
      String(work.topics ?? ''), work.imageFile ?? images[0] ?? null, work.theme ?? null,
      work.settings ? JSON.stringify(work.settings) : null, work.publishedAt ?? null, work.status ?? 'published', now,
      JSON.stringify(images), work.draftFile ?? null);
  return id;
}

/** 修改草稿：标题/正文/话题/设置/图片列表。 */
export function updateDraft(db, workId, patch = {}) {
  const row = db.prepare('SELECT * FROM works WHERE id = ?').get(String(workId));
  if (!row || row.status !== 'draft') return null;
  let images = patch.images;
  if (!Array.isArray(images)) {
    try { images = JSON.parse(row.images ?? '[]'); } catch { images = []; }
    if (!images.length && row.image_file) images = [row.image_file];
  }
  db.prepare(`UPDATE works SET title=COALESCE(?,title), caption=COALESCE(?,caption), topics=COALESCE(?,topics),
      settings=COALESCE(?,settings), images=?, image_file=? WHERE id=? AND status='draft'`)
    .run(patch.title ?? null, patch.caption ?? null, patch.topics ?? null,
      patch.settings ? JSON.stringify(patch.settings) : null, JSON.stringify(images), images[0] ?? null, String(workId));
  return db.prepare('SELECT * FROM works WHERE id = ?').get(String(workId));
}

/** 草稿作品发布：沿用同一行 id，补编号、置 published。 */
export function publishDraft(db, draftId, patch = {}) {
  const row = db.prepare('SELECT * FROM works WHERE id = ?').get(String(draftId));
  if (!row) return null;
  const code = row.code || nextWorkCode(db);
  db.prepare(`UPDATE works SET code=?, title=COALESCE(?,title), caption=COALESCE(?,caption), topics=COALESCE(?,topics),
      image_file=COALESCE(?,image_file), settings=COALESCE(?,settings), published_at=COALESCE(?,published_at), status=? WHERE id=?`)
    .run(code, patch.title ?? null, patch.caption ?? null, patch.topics ?? null, patch.imageFile ?? null,
      patch.settings ? JSON.stringify(patch.settings) : null, patch.publishedAt ?? new Date().toISOString(),
      patch.status ?? 'published', String(draftId));
  return { id: row.id, code };
}

export function saveComment(db, comment) {
  const now = new Date().toISOString();
  const epoch = comment.commentEpoch ?? parseRelativeTime(comment.commentAt ?? '');
  // comment_at 为空的（作品页评论区没有时间戳）不能靠 UNIQUE 去重，先查一次。
  if (!comment.commentAt) {
    const exists = db.prepare('SELECT id FROM comments WHERE work_id = ? AND author = ? AND text = ? AND comment_at IS NULL')
      .get(String(comment.workId ?? ''), String(comment.author ?? ''), String(comment.text ?? ''));
    if (exists) return exists.id;
  }
  db.prepare(`INSERT INTO comments (work_id, author, text, kind, comment_at, comment_epoch, first_seen_at, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(work_id, author, text, comment_at) DO UPDATE SET kind = excluded.kind, source = excluded.source,
      comment_epoch = COALESCE(excluded.comment_epoch, comments.comment_epoch)`)
    .run(String(comment.workId ?? ''), String(comment.author ?? ''), String(comment.text ?? ''),
      comment.kind ?? 'text', comment.commentAt ?? null, epoch, comment.firstSeenAt ?? now, comment.source ?? 'inbox');
  return db.prepare(`SELECT id FROM comments WHERE work_id = ? AND author = ? AND text = ? AND comment_at IS ?`)
    .get(String(comment.workId ?? ''), String(comment.author ?? ''), String(comment.text ?? ''), comment.commentAt ?? null)?.id;
}

export function markReplied(db, { id, workId, author, text, reply, replyKind = 'text', at = new Date().toISOString() }) {
  if (id) {
    db.prepare('UPDATE comments SET reply_text = ?, reply_kind = ?, replied_at = ? WHERE id = ?')
      .run(reply, replyKind, at, id);
    return;
  }
  db.prepare(`UPDATE comments SET reply_text = ?, reply_kind = ?, replied_at = ?
    WHERE work_id = ? AND author = ? AND text = ? AND replied_at IS NULL`)
    .run(reply, replyKind, at, String(workId ?? ''), String(author ?? ''), String(text ?? ''));
}

/** 按作品（或全部）列评论；order = 'time' 按评论时间，'work' 按作品分组。 */
export function listComments(db, { workId = null, order = 'time', limit = 100 } = {}) {
  const where = workId ? 'WHERE c.work_id = ?' : '';
  const rank = order === 'work'
    ? 'ORDER BY c.work_id, COALESCE(c.comment_epoch, 0) DESC'
    : 'ORDER BY COALESCE(c.comment_epoch, 0) DESC';
  return db.prepare(`SELECT c.*, w.title AS work_title FROM comments c
    LEFT JOIN works w ON w.id = c.work_id ${where} ${rank} LIMIT ?`)
    .all(...(workId ? [workId, Number(limit) || 100] : [Number(limit) || 100]));
}

export function listWorks(db, { limit = 50 } = {}) {
  return db.prepare(`SELECT w.*, (SELECT COUNT(*) FROM comments c WHERE c.work_id = w.id) AS comments
    FROM works w ORDER BY COALESCE(w.published_at, w.created_at) DESC LIMIT ?`).all(Number(limit) || 50);
}

/** 平台数据：播放/点赞/收藏/转发/评论数（自己作品的详情页才有）。 */
export function shanghaiDayOf(at = new Date().toISOString()) {
  const ms = typeof at === 'number' ? at : Date.parse(at);
  const base = Number.isFinite(ms) ? ms : Date.now();
  return new Date(base + 8 * 3600_000).toISOString().slice(0, 10);
}

export function saveWorkStats(db, workId, stats = {}) {
  const at = stats.at ?? new Date().toISOString();
  const changed = db.prepare(`UPDATE works SET views = COALESCE(?, views), likes = COALESCE(?, likes), favorites = COALESCE(?, favorites),
    shares = COALESCE(?, shares), comments_stat = COALESCE(?, comments_stat), stats_at = ? WHERE id = ?`)
    .run(stats.views ?? null, stats.likes ?? null, stats.favorites ?? null, stats.shares ?? null, stats.comments ?? null, at, String(workId)).changes;
  // 顺便留一行当天快照，之后才能画「这条作品这几天涨了多少」
  db.prepare(`INSERT INTO work_stats_history (day, work_id, views, likes, comments, favorites, shares, at)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(day, work_id) DO UPDATE SET views = COALESCE(excluded.views, views), likes = COALESCE(excluded.likes, likes),
      comments = COALESCE(excluded.comments, comments), favorites = COALESCE(excluded.favorites, favorites),
      shares = COALESCE(excluded.shares, shares), at = excluded.at`)
    .run(shanghaiDayOf(at), String(workId), stats.views ?? null, stats.likes ?? null, stats.comments ?? null,
      stats.favorites ?? null, stats.shares ?? null, at);
  return changed;
}

/** 一条作品最近几天的数据快照（老的在前）。 */
export function statsHistory(db, workId, days = 14) {
  try {
    return db.prepare(`SELECT day, views, likes, comments, favorites, shares FROM work_stats_history
      WHERE work_id = ? ORDER BY day DESC LIMIT ?`).all(String(workId), Number(days) || 14).reverse();
  } catch { return []; }
}

/** 今天这条作品比上一次快照涨了多少（播放/赞）。 */
export function statsDelta(db, workId) {
  try {
    const rows = db.prepare(`SELECT day, views, likes, comments FROM work_stats_history
      WHERE work_id = ? ORDER BY day DESC LIMIT 2`).all(String(workId));
    if (rows.length < 2) return null;
    const [now, prev] = rows;
    return {
      day: now.day, prev_day: prev.day,
      views: now.views != null && prev.views != null ? now.views - prev.views : null,
      likes: now.likes != null && prev.likes != null ? now.likes - prev.likes : null,
      comments: now.comments != null && prev.comments != null ? now.comments - prev.comments : null,
    };
  } catch { return null; }
}

/** 每天记一次粉丝数，用来画增长。 */
export function saveFanSnapshot(db, { at = new Date().toISOString() } = {}) {
  const day = shanghaiDayOf(at);
  const row = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(interactions),0) c FROM fans').get();
  db.prepare(`INSERT INTO fan_snapshots (day, fans, interactions, at) VALUES (?,?,?,?)
    ON CONFLICT(day) DO UPDATE SET fans = excluded.fans, interactions = excluded.interactions, at = excluded.at`)
    .run(day, row.n, row.c, at);
  return { day, fans: row.n, interactions: row.c };
}

export function fanTrend(db, days = 30) {
  try {
    return db.prepare('SELECT day, fans, interactions FROM fan_snapshots ORDER BY day DESC LIMIT ?').all(Number(days) || 30).reverse();
  } catch { return []; }
}

export function worksMissingStats(db, limit = 10) {
  return db.prepare('SELECT id, code, title FROM works WHERE stats_at IS NULL ORDER BY COALESCE(published_at, created_at) DESC LIMIT ?').all(Number(limit) || 10);
}

/** 粉丝档案：谁来过、来过几次、最后一次说了什么。 */
export function saveFan(db, { name, text = '', at = new Date().toISOString(), note = null } = {}) {
  const key = String(name ?? '').trim();
  if (!key) return null;
  const id = `fan:${key}`;
  db.prepare(`INSERT INTO fans (id, name, first_seen_at, last_seen_at, interactions, last_text, notes)
    VALUES (?,?,?,?,1,?,?)
    ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at, interactions = fans.interactions + 1,
      last_text = COALESCE(excluded.last_text, fans.last_text), notes = COALESCE(excluded.notes, fans.notes)`)
    .run(id, key, at, at, text || null, note);
  return id;
}

/** 老评论补档案：库里已有的评论按作者聚合成粉丝。 */
export function backfillFans(db) {
  const rows = db.prepare(`SELECT author, COUNT(*) n, MIN(COALESCE(comment_epoch, 0)) first, MAX(COALESCE(comment_epoch, 0)) last
    FROM comments WHERE author <> '' GROUP BY author`).all();
  const toIso = (ms) => (ms ? new Date(ms).toISOString() : new Date().toISOString());
  for (const row of rows) {
    db.prepare(`INSERT INTO fans (id, name, first_seen_at, last_seen_at, interactions)
      VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET interactions = MAX(fans.interactions, excluded.interactions),
        first_seen_at = MIN(fans.first_seen_at, excluded.first_seen_at), last_seen_at = MAX(fans.last_seen_at, excluded.last_seen_at)`)
      .run(`fan:${row.author}`, row.author, toIso(row.first), toIso(row.last), row.n);
  }
  return rows.length;
}

export function listFans(db, limit = 50) {
  return db.prepare('SELECT id, name, first_seen_at, last_seen_at, interactions, last_text FROM fans ORDER BY interactions DESC, last_seen_at DESC LIMIT ?').all(Number(limit) || 50);
}

export function fanSummary(db) {
  const row = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(interactions),0) c FROM fans').get();
  const top = db.prepare('SELECT name, interactions FROM fans ORDER BY interactions DESC LIMIT 3').all();
  return { fans: row.n, interactions: row.c, top };
}

export function saveHotspot(db, { topic, videos = 0, topLikes = 0, verdict = 'unknown', note = '', at = new Date().toISOString() }) {
  db.prepare('INSERT INTO hotspots (topic, videos, top_likes, verdict, note, created_at) VALUES (?,?,?,?,?,?)')
    .run(String(topic), Number(videos) || 0, Number(topLikes) || 0, String(verdict), String(note), at);
}

export function listHotspots(db, limit = 20) {
  return db.prepare('SELECT * FROM hotspots ORDER BY id DESC LIMIT ?').all(Number(limit) || 20);
}

/** 把「来源是通知列表、还不知道属于哪个作品」的评论，按作者+正文并回已知作品。 */
export function bindOrphans(db) {
  const orphans = db.prepare("SELECT id, author, text, reply_text, replied_at FROM comments WHERE work_id = ''").all();
  let bound = 0;
  for (const orphan of orphans) {
    const twins = db.prepare(`SELECT id, work_id FROM comments WHERE work_id <> '' AND author = ?
      AND (text = ? OR text LIKE ? OR ? LIKE text || '%')`)
      .all(orphan.author, orphan.text, `${orphan.text.replace(/[%_]/gu, '')}%`, orphan.text);
    if (twins.length !== 1) continue;
    const twin = twins[0];
    db.prepare(`UPDATE comments SET work_id = ?, reply_text = COALESCE(reply_text, ?), replied_at = COALESCE(replied_at, ?) WHERE id = ?`)
      .run(twin.work_id, orphan.reply_text, orphan.replied_at, twin.id);
    db.prepare('DELETE FROM comments WHERE id = ?').run(orphan.id);
    bound += 1;
  }
  return bound;
}

export function contentSummary(db) {
  const works = db.prepare('SELECT COUNT(*) AS n FROM works').get().n;
  const comments = db.prepare('SELECT COUNT(*) AS n FROM comments').get().n;
  const replied = db.prepare('SELECT COUNT(*) AS n FROM comments WHERE replied_at IS NOT NULL').get().n;
  return { works, comments, replied };
}

// ---- 爆款视频 / 热评 -------------------------------------------------------

function videoId(title, author) {
  return `hot:${createHash('sha1').update(`${title}|${author ?? ''}`).digest('hex').slice(0, 16)}`;
}

export function saveVideo(db, { title, author = '', likes = 0, likesText = '', keyword = '', dateText = '', now = new Date().toISOString() }) {
  const id = videoId(title, author);
  db.prepare(`INSERT INTO videos(id,title,author,likes,likes_text,keyword,date_text,status,discovered_at)
    VALUES(?,?,?,?,?,?,?,'found',?)
    ON CONFLICT(id) DO UPDATE SET likes=excluded.likes, likes_text=excluded.likes_text, keyword=excluded.keyword, date_text=excluded.date_text`)
    .run(id, String(title).slice(0, 200), String(author ?? ''), Number(likes) || 0, String(likesText ?? ''), String(keyword ?? ''), String(dateText ?? ''), now);
  return id;
}

export function listVideos(db, { status = 'found', limit = 20 } = {}) {
  const rows = status
    ? db.prepare("SELECT * FROM videos WHERE status=? ORDER BY likes DESC LIMIT ?").all(status, limit)
    : db.prepare("SELECT * FROM videos ORDER BY discovered_at DESC LIMIT ?").all(limit);
  return rows;
}

/** 还没留过评论的视频，按点赞从高到低。 */
export function videosForRound(db, limit = 2) {
  return db.prepare("SELECT * FROM videos WHERE comment_rounds=0 ORDER BY likes DESC LIMIT ?").all(limit);
}

export function touchVideoRound(db, id, now = new Date().toISOString()) {
  db.prepare("UPDATE videos SET comment_rounds=comment_rounds+1, last_round_at=?, status=CASE WHEN comment_rounds+1 >= 2 THEN 'done' ELSE status END WHERE id=?").run(now, id);
}

export function saveHotComment(db, { videoId: video, author = '', text = '', likes = 0, likesText = '', now = new Date().toISOString() }) {
  const result = db.prepare(`INSERT INTO hot_comments(video_id,author,text,likes,likes_text,first_seen_at)
    VALUES(?,?,?,?,?,?) ON CONFLICT(video_id,author,text) DO UPDATE SET likes=excluded.likes, likes_text=excluded.likes_text`)
    .run(video, String(author ?? ''), String(text ?? ''), Number(likes) || 0, String(likesText ?? ''), now);
  return db.prepare("SELECT id FROM hot_comments WHERE video_id=? AND author=? AND text=?").get(video, String(author ?? ''), String(text ?? ''))?.id ?? result.lastInsertRowid;
}

export function hotComments(db, video, { limit = 10 } = {}) {
  return db.prepare("SELECT * FROM hot_comments WHERE video_id=? ORDER BY likes DESC LIMIT ?").all(video, limit);
}

export function markHotCommentReplied(db, id, replyText, now = new Date().toISOString()) {
  db.prepare("UPDATE hot_comments SET reply_text=?, replied_at=? WHERE id=?").run(String(replyText ?? ''), now, id);
}

export function hotStats(db) {
  const videos = db.prepare("SELECT COUNT(*) c FROM videos").get().c;
  const comments = db.prepare("SELECT COUNT(*) c FROM hot_comments").get().c;
  const replied = db.prepare("SELECT COUNT(*) c FROM hot_comments WHERE replied_at IS NOT NULL").get().c;
  return { videos, comments, replied };
}
