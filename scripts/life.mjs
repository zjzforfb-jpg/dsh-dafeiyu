import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { askBrain, broadcastPet, localClock, openLife, runLifeJob } from '../life/manager.mjs';
import { DAILY_BUDGET, taskList } from '../life/tasks.mjs';

process.umask(0o077);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const home = join(root, 'runtime', 'dsh-home');
const db = openLife(home);
const command = process.argv[2];
try {
  if (command === 'status') {
    const { date } = localClock();
    const rows = db.prepare('SELECT day, kind, status, content FROM life_events ORDER BY day DESC, kind DESC LIMIT 10').all();
    const usage = db.prepare('SELECT model_calls, autonomous_actions FROM daily_usage WHERE day = ?').get(date) ?? { model_calls: 0, autonomous_actions: 0 };
    const serviceRuns = db.prepare('SELECT id, pid, started_at, heartbeat_at, ended_at, exit_code, recovery_reason FROM service_runs ORDER BY started_at DESC LIMIT 10').all();
    console.log(JSON.stringify({ today: date, budget: { ...usage, limits: DAILY_BUDGET }, serviceRuns, tasks: taskList(db, 10), records: rows.map((row) => ({ ...row, content: row.content ? JSON.parse(row.content) : null })) }, null, 2));
  } else if (command === 'run') {
    const { date } = localClock();
    const kind = process.argv[3] === 'journal' ? 'journal' : 'explore';
    const settings = JSON.parse(readFileSync(join(home, 'dsh-pet', 'standalone-ai.json'), 'utf8'));
    const result = await runLifeJob({
      db, kind, day: date,
      ask: (text) => askBrain({ port: 3110, token: settings.apiKey, text }),
      broadcast: (text) => broadcastPet({ port: 3108, stateFile: join(home, 'dsh-pet', 'standalone-runtime.json'), text }),
    });
    console.log(JSON.stringify(result, null, 2));
  } else if (command === 'tasks') {
    console.log(JSON.stringify(taskList(db, 50), null, 2));
  } else if (command === 'goals') {
    console.log(JSON.stringify(db.prepare('SELECT id, title, description, status, progress_note, updated_at FROM goals ORDER BY created_at').all(), null, 2));
  } else {
    console.error('用法：npm run life:status；npm run life:tasks；npm run life:goals；npm run life:run [-- journal]');
    process.exitCode = 1;
  }
} finally { db.close(); }
