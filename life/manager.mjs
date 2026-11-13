import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openMemory } from '../brain/memory.mjs';

export const LIFE_CONFIG = Object.freeze({ timeZone: 'Asia/Shanghai', exploreAt: '09:00', journalAt: '21:30' });

export function localClock(now = new Date(), timeZone = LIFE_CONFIG.timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(({ type, value }) => [type, value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

export function openLife(home) {
  return openMemory(join(home, 'dafeiyu-memory.sqlite'));
}

function context(db, day) {
  const memories = db.prepare('SELECT content, kind FROM memories ORDER BY id DESC LIMIT 5').all();
  const recent = db.prepare("SELECT day, kind, content FROM life_events WHERE status = 'done' ORDER BY day DESC, kind DESC LIMIT 3").all();
  const todayFacts = db.prepare("SELECT content, kind FROM memories WHERE date(created_at, '+8 hours') = ? ORDER BY id DESC LIMIT 5").all(day);
  return JSON.stringify({ memories, recent, todayFacts });
}

function prompt(kind, day, facts) {
  if (kind === 'explore') return `今天是 ${day}。请完成你今天唯一的一件小探索：从已有信息中选择一个真正好奇的问题，独立想一想，给出具体而诚实的初步想法。只根据提供的资料，不声称浏览了网页、操作了设备或完成了外部任务。资料：${facts}\n只输出一个 JSON 对象，字段：mood（可爱但自然的当前心情，8字内）、question（好奇的问题，80字内）、thought（你的思考，180字内）、say（给爸爸的简短气泡，60字内）。不要输出 Markdown。`;
  return `今天是 ${day}。请根据资料写一篇大肥鱼的短日记。只写实际有记录的经历；如果今天没有互动或探索，就坦白说今天很安静。资料：${facts}\n只输出一个 JSON 对象，字段：mood（8字内）、diary（第一人称短日记，220字内）、say（给爸爸的简短气泡，60字内）。不要输出 Markdown。`;
}

function parseAnswer(answer, kind) {
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型没有返回日常记录');
  const value = JSON.parse(answer.slice(start, end + 1));
  const fields = kind === 'explore' ? ['mood', 'question', 'thought', 'say'] : ['mood', 'diary', 'say'];
  if (fields.some((field) => typeof value[field] !== 'string' || !value[field].trim())) throw new Error('日常记录缺少字段');
  const limits = { mood: 16, question: 120, thought: 300, diary: 350, say: 100 };
  return Object.fromEntries(fields.map((field) => [field, value[field].trim().slice(0, limits[field])]));
}

export async function runLifeJob({ db, kind, day, ask, broadcast = async () => {} }) {
  if (!['explore', 'journal'].includes(kind) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('无效的日常任务');
  db.prepare('INSERT OR IGNORE INTO life_events (day, kind) VALUES (?, ?)').run(day, kind);
  const row = db.prepare('SELECT status, attempts, updated_at FROM life_events WHERE day = ? AND kind = ?').get(day, kind);
  if (row.status === 'done') return { skipped: 'already-done' };
  if (row.attempts >= 2) return { skipped: 'retry-limit' };
  if (row.status === 'running' && Date.now() - Date.parse(`${row.updated_at.replace(' ', 'T')}Z`) < 10 * 60_000) return { skipped: 'already-running' };
  db.prepare("UPDATE life_events SET status = 'running', attempts = attempts + 1, updated_at = datetime('now') WHERE day = ? AND kind = ?").run(day, kind);
  try {
    try { await broadcast(kind === 'explore' ? '大肥鱼正在想今天的小问题…' : '大肥鱼在写今天的日记…'); } catch { /* 桌面暂不可用不影响日常记录。 */ }
    const answer = await ask(prompt(kind, day, context(db, day)));
    const content = parseAnswer(answer, kind);
    db.prepare("UPDATE life_events SET status = 'done', content = ?, updated_at = datetime('now') WHERE day = ? AND kind = ?").run(JSON.stringify(content), day, kind);
    try { await broadcast(content.say); } catch { /* 桌面暂不可用不影响日常记录。 */ }
    return { done: true, content };
  } catch (error) {
    db.prepare("UPDATE life_events SET status = 'failed', updated_at = datetime('now') WHERE day = ? AND kind = ?").run(day, kind);
    throw error;
  }
}

export async function askBrain({ port, token, text }) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: 'deepseek-flash', stream: false, max_tokens: 650, messages: [{ role: 'user', content: text }] }),
    signal: AbortSignal.timeout(65_000),
  });
  if (!response.ok) throw new Error(`模型请求失败：HTTP ${response.status}`);
  const body = await response.json();
  const answer = body.choices?.[0]?.message?.content;
  if (typeof answer !== 'string' || !answer.trim()) throw new Error('模型没有返回正文');
  return answer;
}

export async function broadcastPet({ port, stateFile, text }) {
  try {
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    const response = await fetch(`http://127.0.0.1:${port}/dsh-pet-7340/broadcast?pet=main&surface=any`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-pet-token': state.token },
      body: JSON.stringify({ text, duration: 8000 }),
      signal: AbortSignal.timeout(5000),
    });
    return response.ok && (await response.json()).ok === true;
  } catch { return false; }
}

export function startLifeSchedule({ home, brainPort, token, petPort = 3108, config = LIFE_CONFIG }) {
  const db = openLife(home);
  const stateFile = join(home, 'dsh-pet', 'standalone-runtime.json');
  let busy = false;
  const tick = async () => {
    if (busy) return;
    const { date, time } = localClock(new Date(), config.timeZone);
    const kind = time >= config.journalAt ? 'journal' : time >= config.exploreAt && time < config.journalAt ? 'explore' : null;
    if (!kind) return;
    busy = true;
    try {
      await runLifeJob({ db, kind, day: date, ask: (text) => askBrain({ port: brainPort, token, text }), broadcast: (text) => broadcastPet({ port: petPort, stateFile, text }) });
    } catch (error) { console.error('[大肥鱼] 日常任务失败：', error.message); }
    finally { busy = false; }
  };
  const timer = setInterval(tick, 60_000);
  timer.unref();
  setTimeout(tick, 15_000).unref();
  return { close: () => { clearInterval(timer); db.close(); } };
}
