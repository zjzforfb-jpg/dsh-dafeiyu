// C-1：任务状态只有一处是真值。external_tasks 是真值，
// working_tasks / brain_tasks / ilink_messages.status 都是镜像——
// 改状态只许走 setTaskStatus，它一次性把四处刷齐，别再让四处各自为政、彼此漂移。
//
// 状态词表在 core/task.mjs（C-2 九态）定死；这里只负责「一次写、四处同步」。

const MIRROR_TABLES = [
  { table: 'working_tasks', idColumn: 'task_id', statusColumn: 'status' },
  { table: 'brain_tasks', idColumn: 'task_id', statusColumn: 'status' },
];

/** 建镜像表（brain_tasks 可能还不存在）。ilink_messages 有自己的生命周期，不在这建。 */
export function ensureTaskMirrorTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS brain_tasks(
    task_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'proposed',
    goal TEXT NOT NULL DEFAULT '',
    updated_ms INTEGER NOT NULL DEFAULT 0
  );`);
}

/**
 * 唯一的状态写入口：改一处，四库同步。
 * external_tasks.status 是真值；working_tasks / brain_tasks / ilink_messages.status 是镜像。
 * 返回是否真的改了真值（true=有更新）。
 */
export function setTaskStatus(db, taskId, status, { result = undefined, evidence = undefined, now = Date.now() } = {}) {
  ensureTaskMirrorTables(db);
  const ts = Number(now);
  const iso = new Date(ts).toISOString();

  // 1) 真值 external_tasks
  const changed = db.prepare(
    `UPDATE external_tasks SET status=?, result=COALESCE(?,result), evidence=COALESCE(?,evidence), updated_ms=? WHERE id=?`,
  ).run(status, result ?? null, evidence ?? null, ts, taskId).changes === 1;

  // 2+3) 结构镜像表：working_tasks / brain_tasks
  for (const mirror of MIRROR_TABLES) {
    db.prepare(`UPDATE ${mirror.table} SET ${mirror.statusColumn}=? WHERE ${mirror.idColumn}=?`).run(status, taskId);
  }

  // 4) ilink_messages.status（按任务的 source_message_id 回溯到那条消息）
  const task = db.prepare('SELECT source_message_id FROM external_tasks WHERE id=?').get(taskId);
  if (task?.source_message_id) {
    db.prepare('UPDATE ilink_messages SET status=?, updated_at=? WHERE id=?').run(status, iso, String(task.source_message_id));
  }

  return changed;
}

/** 读四处，断言它们一致（给测试和巡检用）。 */
export function readTaskStatusEverywhere(db, taskId) {
  ensureTaskMirrorTables(db);
  const truth = db.prepare('SELECT status, source_message_id FROM external_tasks WHERE id=?').get(taskId);
  const out = { external_tasks: truth?.status ?? null, ilink_messages: null, working_tasks: null, brain_tasks: null };
  out.working_tasks = db.prepare('SELECT status FROM working_tasks WHERE task_id=?').get(taskId)?.status ?? null;
  out.brain_tasks = db.prepare('SELECT status FROM brain_tasks WHERE task_id=?').get(taskId)?.status ?? null;
  if (truth?.source_message_id) out.ilink_messages = db.prepare('SELECT status FROM ilink_messages WHERE id=?').get(String(truth.source_message_id))?.status ?? null;
  return out;
}
