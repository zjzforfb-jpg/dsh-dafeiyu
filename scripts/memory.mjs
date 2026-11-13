import { join, resolve } from 'node:path';
import { forgetMemory, openMemory, reviseMemory } from '../brain/memory.mjs';

const db = openMemory(join(resolve(import.meta.dirname, '..'), 'runtime', 'dsh-home', 'dafeiyu-memory.sqlite'));
const [action, rawId, ...rest] = process.argv.slice(2);
if (action === 'list') {
  const rows = db.prepare('SELECT id, content, kind, source, confidence, created_at, active FROM memories ORDER BY id DESC').all();
  for (const row of rows) console.log(`${row.id}\t${row.created_at}\t${row.active ? '有效' : '已停用'}\t${row.kind}\t${row.source}\t${row.confidence}\t${row.content}`);
  if (!rows.length) console.log('还没有长期记忆。');
} else if (action === 'forget' && /^\d+$/.test(rawId ?? '')) {
  console.log(forgetMemory(db, Number(rawId)) ? `已删除记忆 ${rawId} 及其修订记录` : `没有编号为 ${rawId} 的记忆`);
} else if (action === 'update' && /^\d+$/.test(rawId ?? '') && rest.join(' ').trim()) {
  const result = reviseMemory(db, Number(rawId), rest.join(' '));
  console.log(result.changed ? `已更正记忆 ${rawId}，旧版本保存在修订记录中` : `记忆 ${rawId} 内容未变化`);
} else if (action === 'history' && /^\d+$/.test(rawId ?? '')) {
  const rows = db.prepare('SELECT id, memory_id, old_content, new_content, reason, created_at FROM memory_revisions WHERE memory_id = ? ORDER BY id').all(Number(rawId));
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.error('用法：npm run memory:list；npm run memory:update -- <编号> <新内容>；npm run memory:history -- <编号>；npm run memory:forget -- <编号>');
  process.exitCode = 2;
}
db.close();
