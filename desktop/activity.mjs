import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PET_ID = 'main';
const SURFACE = 'any';
const ANIMATIONS = Object.freeze({
  chat: '点击回应-开心跃动',
  thinking: '深度思考碎碎念',
  phone: '轻快记录',
  computer: '写代码',
  play: '玩游戏气急败坏',
  journal: '轻快记录',
  explore: '深度思考碎碎念',
  success: '工作状态-雀跃庆祝',
  error: '工作状态-垂头叹气冒汗',
});

const MESSAGES = Object.freeze({
  chat: { start: '大肥鱼正在认真听爸爸说话…', done: '爸爸，大肥鱼回应好啦～' },
  thinking: { start: '大肥鱼抱着脑袋认真想一想…', done: '大肥鱼想好啦，来跟爸爸说说～' },
  phone: { start: '大肥鱼切换到看手机情境啦 📱', done: '手机情境结束，大肥鱼回来陪爸爸～' },
  computer: { start: '大肥鱼打开电脑开始忙碌啦 💻', done: '电脑上的小任务告一段落啦～' },
  play: { start: '大肥鱼开始玩耍啦 🎮', done: '玩了一小会儿，大肥鱼回来啦～' },
  journal: { start: '大肥鱼在写今天的小日记…', done: '今天的日记写好啦～' },
  explore: { start: '大肥鱼开始今天的小探索…', done: '大肥鱼完成今天的小探索啦～' },
  success: { start: '大肥鱼完成一件小事啦！', done: '大肥鱼完成一件小事啦！' },
  error: { start: '刚才的小任务遇到问题了，大肥鱼正在整理…', error: '大肥鱼这次没能完成，已经记下遇到的问题。' },
});

const VALID_SOURCES = new Set(['conversation', 'life', 'system']);
const VALID_PHASES = new Set(['start', 'done', 'error']);

export function classifyConversation(text) {
  const value = String(text ?? '').slice(0, 4000);
  if (/(?:玩|刷|看|逛|打开|用|拿起|拿着).{0,6}(?:手机|抖音|小红书|哔哩哔哩|视频)|(?:手机|抖音|小红书|哔哩哔哩).{0,8}(?:玩|刷|看|逛)/u.test(value)) return 'phone';
  if (/(?:玩|打|启动).{0,5}(?:游戏|游戏机)|(?:游戏|游戏机).{0,5}(?:玩|打)/u.test(value)) return 'play';
  if (/(?:用|开|打开|玩|看|写|敲).{0,6}(?:电脑|代码|编程)|(?:电脑|代码|编程).{0,8}(?:用|开|打开|玩|写|敲)/u.test(value)) return 'computer';
  if (/(?:想一想|思考一下|分析一下|帮我想|认真想)/u.test(value)) return 'thinking';
  return 'chat';
}

function normalizeEvent(event) {
  const source = VALID_SOURCES.has(event?.source) ? event.source : 'system';
  const activity = Object.hasOwn(ANIMATIONS, event?.activity) ? event.activity : 'chat';
  const phase = VALID_PHASES.has(event?.phase) ? event.phase : 'done';
  const copy = MESSAGES[activity];
  const message = typeof event?.message === 'string' && event.message.trim()
    ? event.message.trim().slice(0, 120)
    : (phase === 'error' ? copy.error : copy[phase]) ?? copy.done;
  const url = typeof event?.url === 'string' && /^https?:\/\//u.test(event.url.trim()) ? event.url.trim().slice(0, 500) : undefined;
  return { source, activity, phase, message, animation: ANIMATIONS[activity], url };
}

async function postPet({ port, token, endpoint, body }) {
  const response = await fetch(`http://127.0.0.1:${port}/dsh-pet-7340/${endpoint}?pet=${PET_ID}&surface=${SURFACE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-pet-token': token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(2500),
  });
  let result;
  try { result = await response.json(); } catch { throw new Error(`桌宠 ${endpoint} 返回无效响应`); }
  if (!response.ok || result.ok !== true) throw new Error(result.message ?? `桌宠 ${endpoint} 请求失败`);
  return result;
}

/**
 * Save only normalized activity metadata (never the user's message) and reflect it in dsh-pet.
 * A missing pet or a declined animation is recorded as undelivered, without blocking chat/life work.
 */
export async function publishDesktopActivity({ db, home, port = 3108, event, eventKey = randomUUID() }) {
  const normalized = normalizeEvent(event);
  db.prepare("DELETE FROM desktop_activity_events WHERE created_at < datetime('now', '-30 days')").run();
  db.prepare(`DELETE FROM desktop_activity_events WHERE id NOT IN
    (SELECT id FROM desktop_activity_events ORDER BY id DESC LIMIT 500)`).run();
  db.prepare(`INSERT OR IGNORE INTO desktop_activity_events
    (event_key, source, activity, phase, message, animation)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(eventKey, normalized.source, normalized.activity, normalized.phase, normalized.message, normalized.animation);
  const row = db.prepare('SELECT id, delivered FROM desktop_activity_events WHERE event_key = ?').get(eventKey);
  if (!row || row.delivered) return { ok: Boolean(row?.delivered), duplicate: true };

  try {
    const state = JSON.parse(readFileSync(join(home, 'dsh-pet', 'standalone-runtime.json'), 'utf8'));
    await postPet({ port, token: state.token, endpoint: 'anim', body: { name: normalized.animation } });
    if (event?.bubble !== false) {
      await postPet({ port, token: state.token, endpoint: 'broadcast', body: { text: normalized.message, duration: 6500, anim: false, ...(normalized.url ? { url: normalized.url } : {}) } });
    }
    db.prepare("UPDATE desktop_activity_events SET delivered = 1, delivery_error = NULL, delivered_at = datetime('now') WHERE id = ?").run(row.id);
    return { ok: true, activity: normalized.activity, phase: normalized.phase };
  } catch (error) {
    db.prepare('UPDATE desktop_activity_events SET delivery_error = ? WHERE id = ?').run(error.message.slice(0, 300), row.id);
    return { ok: false, activity: normalized.activity, phase: normalized.phase, reason: error.message };
  }
}

export function desktopActivityStatus(db, limit = 12) {
  const bounded = Math.max(1, Math.min(50, Number(limit) || 12));
  const latest = db.prepare(`SELECT source, activity, phase, message, animation, delivered, delivery_error, created_at, delivered_at
    FROM desktop_activity_events ORDER BY id DESC LIMIT ?`).all(bounded);
  const delivered = db.prepare('SELECT COUNT(*) AS count FROM desktop_activity_events WHERE delivered = 1').get().count;
  const failed = db.prepare('SELECT COUNT(*) AS count FROM desktop_activity_events WHERE delivered = 0 AND delivery_error IS NOT NULL').get().count;
  const total = db.prepare('SELECT COUNT(*) AS count FROM desktop_activity_events').get().count;
  return { total, delivered, failed, pending: total - delivered - failed, latest };
}
