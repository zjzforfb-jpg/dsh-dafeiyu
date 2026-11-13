import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openMemory } from '../brain/memory.mjs';
import { desktopActivityStatus } from '../desktop/activity.mjs';

const projectRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const home = join(projectRoot, 'runtime', 'dsh-home');
const command = process.argv[2] ?? 'status';

if (command !== 'status') {
  console.error('用法：npm run desktop:status');
  process.exit(2);
}

const db = openMemory(join(home, 'dafeiyu-memory.sqlite'));
try {
  console.log(JSON.stringify(desktopActivityStatus(db), null, 2));
} finally {
  db.close();
}
