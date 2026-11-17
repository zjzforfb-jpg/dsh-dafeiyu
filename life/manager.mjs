import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openMemory } from '../brain/memory.mjs';
import { claimTask, completeTask, DAILY_BUDGET, enqueueTask, failTask, goalTaskHistory, goalsWithTasks, linkGoalTask, recoverStaleTasks, reserveAutonomousAction, reserveModelCall } from './tasks.mjs';
import { publishDesktopActivity } from '../desktop/activity.mjs';
import { createGoalTask } from '../connect/tasks.mjs';
import { initBudget, legacyUsage, ratchetBudget } from '../connect/core/budget.mjs';

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

/**
 * D-2：统一预算落在 CONNECT 库（runtime/connect/connect.sqlite），
 * 这样 life、QQ、iLink 占用的是同一格累计。拿不到就退回 BRAIN 库
 * （life 仍然共用同一套 budget.mjs 逻辑与上限，只是不与另两个渠道同格）。
 */
export function openConnectBudget(home) {
  try {
    // home = <root>/runtime/dsh-home → CONNECT 库 = <root>/runtime/connect/connect.sqlite
    const file = join(home, '..', 'connect', 'connect.sqlite');
    // 只认已经存在的库：路径写错时宁可没有统一账，也不要凭空造一个空库。
    if (!existsSync(file)) return null;
    const db = new DatabaseSync(file);
    db.exec('PRAGMA busy_timeout = 3000');
    initBudget(db);
    return db;
  } catch { return null; }
}

/**
 * D-2：life 的旧日配额记在 BRAIN 库的 daily_usage 里，跨库搬不进 CONNECT 库的
 * 同库回填逻辑，所以由这里显式棘轮一次——迁移当天不白送额度。
 * 只增不减，重复调用安全。
 */
export function syncLegacyLifeUsage(connectDb, brainDb, day) {
  if (!connectDb || !brainDb) return null;
  try {
    const legacy = brainDb.prepare('SELECT model_calls, autonomous_actions FROM daily_usage WHERE day = ?').get(day);
    if (!legacy) return null;
    // 旧账是各渠道各记各的，所以要把 CONNECT 库里同库的旧账（QQ/iLink）与
    // BRAIN 库里的 life 旧账**相加**再棘轮，不能取 max——否则少算另一路的用量。
    const sameDb = legacyUsage(connectDb, day);
    return ratchetBudget(connectDb, day, {
      model_calls: (sameDb.model_calls ?? 0) + Number(legacy.model_calls ?? 0),
      autonomous_actions: (sameDb.autonomous_actions ?? 0) + Number(legacy.autonomous_actions ?? 0),
      voice_requests: sameDb.voice_requests ?? 0,
    });
  } catch { return null; }
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

export async function runLifeJob({ db, kind, day, ask, broadcast = async () => {}, activity = null, connectDb = null }) {
  if (!['explore', 'journal'].includes(kind) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('无效的日常任务');
  // D-2：配额占用统一预算（CONNECT 库 daily_budget），拿不到 CONNECT 就退回 BRAIN 库。
  const budgetDb = connectDb ?? db;
  if (connectDb) syncLegacyLifeUsage(connectDb, db, day);
  db.prepare('INSERT OR IGNORE INTO life_events (day, kind) VALUES (?, ?)').run(day, kind);
  const event = db.prepare('SELECT status FROM life_events WHERE day = ? AND kind = ?').get(day, kind);
  if (event.status === 'done') return { skipped: 'already-done' };
  const task = enqueueTask(db, { idempotencyKey: `life:${day}:${kind}`, kind: `daily_${kind}`, title: kind === 'explore' ? '完成今日小探索' : '写今日短日记', payload: { day, kind }, maxAttempts: 2 });
  if (task.status === 'succeeded') return { skipped: 'already-done' };
  if (!task) return { skipped: 'task-unavailable' };
  const claimed = claimTask(db, task.id);
  if (!claimed) return { skipped: task.attempts >= task.max_attempts ? 'retry-limit' : task.status };
  if (claimed.attempts === 1 && !reserveAutonomousAction(budgetDb, day)) {
    const error = new Error(`今日自主行动预算已用完（上限 ${DAILY_BUDGET.autonomousActions}）`);
    failTask(db, claimed, error);
    return { skipped: 'action-budget' };
  }
  db.prepare("UPDATE life_events SET status = 'running', attempts = attempts + 1, updated_at = datetime('now') WHERE day = ? AND kind = ?").run(day, kind);
  const activityName = kind === 'explore' ? 'explore' : 'journal';
  try {
    if (activity) {
      try { await activity({ source: 'life', activity: activityName, phase: 'start' }); } catch { /* 桌面状态不影响日常任务。 */ }
    } else {
      try { await broadcast(kind === 'explore' ? '大肥鱼正在想今天的小问题…' : '大肥鱼在写今天的日记…'); } catch { /* 桌面暂不可用不影响日常记录。 */ }
    }
    if (!reserveModelCall(budgetDb, day)) throw new Error(`今日自主模型调用预算已用完（上限 ${DAILY_BUDGET.modelCalls}）`);
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
        // D-1：这次推进登记成统一 AgentTask（CONNECT 库 external_tasks），
        // goal_progress.task_id 指向它——目标、推进、统一任务串成一条链。
        let agentTaskId = claimed.id;
        if (connectDb) {
          try {
            agentTaskId = createGoalTask(connectDb, { goalId: content.goalId, day, goal: content.question, result: content }).id;
          } catch { /* 拿不到 CONNECT 库就退回 brain task id。 */ }
        }
        linkGoalTask(db, { goalId: content.goalId, taskId: agentTaskId, day, summary: `${content.question} ${content.thought}`, nextStep: content.nextStep });
        db.prepare("UPDATE goals SET progress_note = ?, updated_at = datetime('now') WHERE id = ?").run(content.nextStep, content.goalId);
      }
      completeTask(db, claimed.id, { ...content, completedDay: day });
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    if (activity) {
      try { await activity({ source: 'life', activity: activityName, phase: 'done', message: content.say }); } catch { /* 桌面状态不影响日常任务。 */ }
    } else {
      try { await broadcast(content.say); } catch { /* 桌面暂不可用不影响日常记录。 */ }
    }
    return { done: true, content };
  } catch (error) {
    db.prepare("UPDATE life_events SET status = 'failed', updated_at = datetime('now') WHERE day = ? AND kind = ?").run(day, kind);
    failTask(db, claimed, error);
    if (activity) try { await activity({ source: 'life', activity: 'error', phase: 'error' }); } catch { /* 桌面状态不影响错误记录。 */ }
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
  // D-2：统一预算与统一 AgentTask 都住在 CONNECT 库，这里开一个只用来读写的句柄。
  const connectDb = openConnectBudget(home);
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
      await runLifeJob({
        db,
        connectDb,
        kind,
        day: date,
        ask: (text) => askBrain({ port: brainPort, token, text }),
        broadcast: (text) => broadcastPet({ port: petPort, stateFile, text }),
        activity: (event) => publishDesktopActivity({ db, home, port: petPort, event }),
      });
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
    try { connectDb?.close(); } catch { /* 关不掉的句柄不影响收尾。 */ }
  } };
}
