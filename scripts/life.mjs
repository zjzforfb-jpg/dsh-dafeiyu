import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { askBrain, broadcastPet, localClock, openConnectBudget, openLife, runLifeJob, syncLegacyLifeUsage } from '../life/manager.mjs';
import { DAILY_BUDGET, goalsWithTasks, taskList } from '../life/tasks.mjs';
import { budgetUsage } from '../connect/core/budget.mjs';

process.umask(0o077);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const home = join(root, 'runtime', 'dsh-home');
const db = openLife(home);
// D-2：统一预算在 CONNECT 库；拿不到就退回 BRAIN 库（同一套逻辑与上限）。
const connectDb = openConnectBudget(home);
const budgetDb = connectDb ?? db;
const command = process.argv[2];
try {
  if (command === 'status') {
    const { date } = localClock();
    const rows = db.prepare('SELECT day, kind, status, content FROM life_events ORDER BY day DESC, kind DESC LIMIT 10').all();
    // D-2：读数前先把 life 旧账棘轮进统一账，别让当天白送额度。
    if (connectDb) syncLegacyLifeUsage(connectDb, db, date);
    const usage = budgetUsage(budgetDb, date);
    const serviceRuns = db.prepare('SELECT id, pid, started_at, heartbeat_at, ended_at, exit_code, recovery_reason FROM service_runs ORDER BY started_at DESC LIMIT 10').all();
    console.log(JSON.stringify({
      today: date,
      budget: { model_calls: usage.model_calls, autonomous_actions: usage.autonomous_actions, voice_requests: usage.voice_requests, limits: DAILY_BUDGET, shared_with: connectDb ? 'connect' : 'brain' },
      serviceRuns,
      tasks: taskList(db, 10),
      records: rows.map((row) => ({ ...row, content: row.content ? JSON.parse(row.content) : null })),
    }, null, 2));
  } else if (command === 'run') {
    const { date } = localClock();
    const kind = process.argv[3] === 'journal' ? 'journal' : 'explore';
    const settings = JSON.parse(readFileSync(join(home, 'dsh-pet', 'standalone-ai.json'), 'utf8'));
    const result = await runLifeJob({
      db, connectDb, kind, day: date,
      ask: (text) => askBrain({ port: 3110, token: settings.apiKey, text }),
      broadcast: (text) => broadcastPet({ port: 3108, stateFile: join(home, 'dsh-pet', 'standalone-runtime.json'), text }),
    });
    console.log(JSON.stringify(result, null, 2));
  } else if (command === 'tasks') {
    console.log(JSON.stringify(taskList(db, 50), null, 2));
  } else if (command === 'goals') {
    // D-1：每个目标带上最近关联的 task（goal_progress.task_id 即统一 AgentTask id）。
    console.log(JSON.stringify(goalsWithTasks(db, { taskLimit: 5 }), null, 2));
  } else {
    console.error('用法：npm run life:status；npm run life:tasks；npm run life:goals；npm run life:run [-- journal]');
    process.exitCode = 1;
  }
} finally {
  db.close();
  try { connectDb?.close(); } catch { /* 关不掉就算了。 */ }
}
