import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { openMemory } from '../brain/memory.mjs';
import { claimTask, completeTask, DAILY_BUDGET, enqueueTask, failTask, recoverStaleTasks, reserveAutonomousAction, reserveModelCall } from './tasks.mjs';

export const LIFE_CONFIG = Object.freeze({ timeZone: 'Asia/Shanghai', exploreAt: '09:00', journalAt: '21:30', quietStart: '22:30', quietEnd: '08:30' });

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
  const goals = db.prepare("SELECT id, title, description, progress_note FROM goals WHERE status = 'active' ORDER BY created_at ASC").all();
  return JSON.stringify({ memories, recent, todayFacts, goals });
}

function prompt(kind, day, facts) {
  if (kind === 'explore') return `今天是 ${day}。请完成你今天唯一的一件小探索：从资料里的 active goals 中选一个，提出一个和目标相关的小问题，认真思考，并给出能在以后继续的一步。只根据资料，不声称浏览网页或操作设备。资料：${facts}\n只输出一个 JSON 对象，字段：goalId（必须是资料中某个 active goal 的 id）、mood（8字内）、question（80字内）、thought（180字内）、nextStep（60字内）、say（给爸爸的简短气泡，60字内）。不要输出 Markdown。`;
  return `今天是 ${day}。请根据资料写一篇大肥鱼的短日记。只写实际有记录的经历；如果今天没有互动或探索，就坦白说今天很安静。资料：${facts}\n只输出一个 JSON 对象，字段：mood（8字内）、diary（第一人称短日记，220字内）、say（给爸爸的简短气泡，60字内）。不要输出 Markdown。`;
}

function parseAnswer(answer, kind, goals = []) {
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型没有返回日常记录');
  const value = JSON.parse(answer.slice(start, end + 1));
  const fields = kind === 'explore' ? ['goalId', 'mood', 'question', 'thought', 'nextStep', 'say'] : ['mood', 'diary', 'say'];
  if (fields.some((field) => typeof value[field] !== 'string' || !value[field].trim())) throw new Error('日常记录缺少字段');
  const limits = { goalId: 40, mood: 16, question: 120, thought: 300, nextStep: 100, diary: 350, say: 100 };
  const output = Object.fromEntries(fields.map((field) => [field, value[field].trim().slice(0, limits[field])]));
  if (kind === 'explore' && !goals.some((goal) => goal.id === output.goalId)) throw new Error('日常记录选择了不存在或未启用的目标');
  return output;
}

export async function runLifeJob({ db, kind, day, ask, broadcast = async () => {} }) {
  if (!['explore', 'journal'].includes(kind) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('无效的日常任务');
  db.prepare('INSERT OR IGNORE INTO life_events (day, kind) VALUES (?, ?)').run(day, kind);
  const event = db.prepare('SELECT status FROM life_events WHERE day = ? AND kind = ?').get(day, kind);
  if (event.status === 'done') return { skipped: 'already-done' };
  const task = enqueueTask(db, { idempotencyKey: `life:${day}:${kind}`, kind: `daily_${kind}`, title: kind === 'explore' ? '完成今日小探索' : '写今日短日记', payload: { day, kind }, maxAttempts: 2 });
  if (task.status === 'succeeded') return { skipped: 'already-done' };
  if (!task) return { skipped: 'task-unavailable' };
  const claimed = claimTask(db, task.id);
  if (!claimed) return { skipped: task.attempts >= task.max_attempts ? 'retry-limit' : task.status };
  if (claimed.attempts === 1 && !reserveAutonomousAction(db, day)) {
    const error = new Error(`今日自主行动预算已用完（上限 ${DAILY_BUDGET.autonomousActions}）`);
    failTask(db, claimed, error);
    return { skipped: 'action-budget' };
  }
  db.prepare("UPDATE life_events SET status = 'running', attempts = attempts + 1, updated_at = datetime('now') WHERE day = ? AND kind = ?").run(day, kind);
  try {
    try { await broadcast(kind === 'explore' ? '大肥鱼正在想今天的小问题…' : '大肥鱼在写今天的日记…'); } catch { /* 桌面暂不可用不影响日常记录。 */ }
    if (!reserveModelCall(db, day)) throw new Error(`今日自主模型调用预算已用完（上限 ${DAILY_BUDGET.modelCalls}）`);
    const jobContext = JSON.parse(context(db, day));
    if (kind === 'explore' && jobContext.goals.length === 0) throw new Error('没有启用的长期目标，无法安排小探索');
    const answer = await ask(prompt(kind, day, JSON.stringify(jobContext)));
    const content = parseAnswer(answer, kind, jobContext.goals);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare("UPDATE life_events SET status = 'done', content = ?, updated_at = datetime('now') WHERE day = ? AND kind = ?").run(JSON.stringify(content), day, kind);
      if (kind === 'explore') {
        const reflection = `我今天好奇：${content.question} 我的初步想法是：${content.thought}`;
        db.prepare("INSERT OR IGNORE INTO memories (content, kind, source, confidence, include_context) VALUES (?, 'reflection', 'self_reflection', 0.6, 1)").run(reflection);
        db.prepare('UPDATE tasks SET goal_id = ? WHERE id = ?').run(content.goalId, claimed.id);
        db.prepare('INSERT OR IGNORE INTO goal_progress (goal_id, task_id, day, summary, next_step) VALUES (?, ?, ?, ?, ?)').run(content.goalId, claimed.id, day, `${content.question} ${content.thought}`, content.nextStep);
        db.prepare("UPDATE goals SET progress_note = ?, updated_at = datetime('now') WHERE id = ?").run(content.nextStep, content.goalId);
      }
      completeTask(db, claimed.id, { ...content, completedDay: day });
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    try { await broadcast(content.say); } catch { /* 桌面暂不可用不影响日常记录。 */ }
    return { done: true, content };
  } catch (error) {
    db.prepare("UPDATE life_events SET status = 'failed', updated_at = datetime('now') WHERE day = ? AND kind = ?").run(day, kind);
    failTask(db, claimed, error);
    throw error;
  }
}

export async function askBrain({ port, token, text }) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: 'deepseek-flash', stream: false, max_tokens: 900, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: text }] }),
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
  db.prepare("UPDATE service_runs SET ended_at = COALESCE(ended_at, datetime('now')), recovery_reason = COALESCE(recovery_reason, 'previous process ended without a clean shutdown') WHERE heartbeat_at < datetime('now', '-2 minutes')").run();
  const runId = randomUUID();
  db.prepare('INSERT INTO service_runs (id, pid) VALUES (?, ?)').run(runId, process.pid);
  let busy = false;
  const tick = async () => {
    if (busy) return;
    db.prepare("UPDATE service_runs SET heartbeat_at = datetime('now') WHERE id = ? AND ended_at IS NULL").run(runId);
    recoverStaleTasks(db);
    const { date, time } = localClock(new Date(), config.timeZone);
    if (time >= config.quietStart || time < config.quietEnd) return;
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
  return { close: (exitCode = 0) => {
    clearInterval(timer);
    db.prepare("UPDATE service_runs SET ended_at = datetime('now'), exit_code = ?, heartbeat_at = datetime('now') WHERE id = ?").run(exitCode, runId);
    db.close();
  } };
}
