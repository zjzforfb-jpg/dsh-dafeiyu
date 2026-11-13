import { join, resolve } from 'node:path';
import { openMemory } from '../brain/memory.mjs';

const db = openMemory(join(resolve(import.meta.dirname, '..'), 'runtime', 'dsh-home', 'dafeiyu-memory.sqlite'));
const [action, rawId] = process.argv.slice(2);
if (action === 'list') {
  const rows = db.prepare('SELECT id, content, kind, created_at FROM memories ORDER BY id DESC').all();
  for (const row of rows) console.log(`${row.id}\t${row.created_at}\t${row.kind === 'experience' ? '共同回忆' : '事实'}\t${row.content}`);
  if (!rows.length) console.log('还没有长期记忆。');
} else if (action === 'forget' && /^\d+$/.test(rawId ?? '')) {
  const source = db.prepare('SELECT source_turn_id FROM memories WHERE id = ?').get(Number(rawId));
  const result = db.prepare('DELETE FROM memories WHERE id = ?').run(Number(rawId));
  if (source?.source_turn_id) db.prepare('DELETE FROM turns WHERE id = ?').run(source.source_turn_id);
  console.log(result.changes ? `已删除记忆 ${rawId}` : `没有编号为 ${rawId} 的记忆`);
} else {
  console.error('用法：npm run memory:list；npm run memory:forget -- <编号>');
  process.exitCode = 2;
}
db.close();
