import { join } from 'node:path';
import { capture, openMemory, recall } from '../../brain/memory.mjs';

/** QQ 通道与桌面/微信共用同一个长期记忆库（WAL 模式，可多进程同时打开）。 */
export function openQqMemory(home) {
  return openMemory(join(home, 'dafeiyu-memory.sqlite'));
}

/** 取与当前对话相关的记忆，供 brain 注入提示词。 */
export function memoryNotes(db, text, limit = 8) {
  return recall(db, text, limit).map(({ id, content, kind }) => ({ id, content, kind }));
}

/** 明确说的“记住/记下”落库；口语里常带“你现在记下…”这类前缀，做一次兜底提取。 */
export function rememberExchange(db, userText, assistantText) {
  const direct = capture(db, userText, assistantText, { source: 'qq_chat' });
  if (direct.remembered) return direct;
  const match = String(userText ?? '').match(/(?:記住|记住|記下|记下)[：:，,、\s]*(.{2,200})/u);
  if (!match) return direct;
  return capture(db, `记住${match[1]}`, assistantText, { source: 'qq_chat' });
}

export function rememberText(db, text) {
  const value = String(text ?? '').trim();
  if (!value) return null;
  const result = capture(db, `记住${value}`, '', { source: 'qq_chat' });
  if (!result.remembered) return null;
  return db.prepare('SELECT id, content FROM memories WHERE content = ? ORDER BY id DESC LIMIT 1').get(result.remembered) ?? null;
}

export function listMemories(db, limit = 10) {
  return db.prepare('SELECT id, content, kind, created_at FROM memories WHERE active = 1 ORDER BY id DESC LIMIT ?').all(Math.max(1, Math.min(30, Number(limit) || 10)));
}

export function formatMemoryList(rows) {
  if (!rows.length) return '我还没有记住什么。说“记住…”我就会记下来。';
  return `我记得这些：\n${rows.map((row) => `#${row.id} ${row.content}`).join('\n')}\n\n要改就说“更正记忆 #编号 新内容”，要删就说“忘记记忆 #编号”。`;
}
