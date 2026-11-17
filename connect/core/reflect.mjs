// M3 / C1：把「动作失败」也喂进学习闭环。
//
// 在此之前 learning_proposals 只有一条来源：技能运行失败（skill_runs）。
// 但真正天天在失败的，是「动作」这一层——定时任务里的 daily_post、check_interactions。
// 结果就是：事件流里失败一堆，学习账本里 0 条提案，学习回路空转。
//
// 这里把失败按「动作 + 失败类别」聚合，同一类反复出现才会升级成提案，
// 免得每次报错都变成一条新噪音。
import { randomUUID } from 'node:crypto';
import { initReflections } from '../reflection.mjs';

/** 失败原文 → 类别。分不出就 unknown，不做过度猜测。 */
const CATEGORIES = Object.freeze([
  // 只认「adb 里一台都没有」这种明确的掉设备；其它 device 相关报错留给 adb_offline。
  { id: 'no_device', label: '手机没连上', match: /adb 看到 0 台|no_device|手机没连上/iu },
  { id: 'adb_offline', match: /device offline|no devices|adb: device|not found.*device/iu, label: '手机离线/ADB 掉线' },
  { id: 'timeout', match: /timed?\s?out|etimedout|超时/iu, label: '超时' },
  { id: 'network', match: /econnreset|econnrefused|enotfound|socket hang up|network/iu, label: '网络不通' },
  { id: 'auth', match: /login|未登录|登录失效|unauthor/iu, label: '登录态失效' },
  // 「做完了但没法确认」要排在「页面找不到」之前：这类报错正文里也常带「没读到」，
  // 但它的问题不是界面缺失，而是结果没法证实，修法完全不同。
  { id: 'unconfirmed', match: /unconfirmed|没看到|不确定|没法确认/iu, label: '做完了但没法确认' },
  { id: 'ui_missing', match: /没读到|找不到|missing|no such|未找到|not found/iu, label: '页面上没找到要点的东西' },
]);

export function classifyFailure(text) {
  const value = String(text ?? '');
  for (const item of CATEGORIES) if (item.match.test(value)) return item.id;
  return 'unknown';
}

export function labelForCategory(id) {
  return CATEGORIES.find((item) => item.id === id)?.label ?? '原因不明';
}

/**
 * 记一次动作失败。
 * @returns {{id,pattern_key,occurrences,isNew}} 同类别第 N 次。
 */
export function reflectOnActionFailure(db, { operation, reason = '', taskId = null, now = Date.now(), evidence = {} } = {}) {
  initReflections(db);
  const op = String(operation ?? 'unknown.operation');
  const category = classifyFailure(reason);
  const patternKey = `action:failure:${op}:${category}`;
  const head = String(reason ?? '').replace(/\s+/gu, ' ').trim().slice(0, 200);
  const previous = db.prepare('SELECT * FROM learning_proposals WHERE pattern_key=?').get(patternKey);
  if (previous) {
    db.prepare('UPDATE learning_proposals SET occurrences=occurrences+1,evidence=?,updated_at=? WHERE id=?')
      .run(JSON.stringify({ last_task: taskId, last_reason: head, category, ...evidence }), new Date(now).toISOString(), previous.id);
    const row = db.prepare('SELECT * FROM learning_proposals WHERE id=?').get(previous.id);
    return { id: row.id, patternKey, occurrences: Number(row.occurrences ?? 1), isNew: false, category };
  }
  const summary = `${op} 连续出现「${labelForCategory(category)}」：${head || '没有更多信息'}`;
  const id = `reflection_${randomUUID()}`;
  db.prepare('INSERT INTO learning_proposals(id,kind,skill_id,pattern_key,summary,evidence) VALUES(?,?,?,?,?,?)')
    .run(id, 'action_reflection', null, patternKey, summary.slice(0, 400), JSON.stringify({ first_task: taskId, first_reason: head, category, ...evidence }));
  return { id, patternKey, occurrences: 1, isNew: true, category };
}

/** 按动作汇总失败，给「哪些动作最需要修」排序（看板与夜间复盘用）。 */
export function failureSummary(db, { limit = 10 } = {}) {
  initReflections(db);
  return db.prepare(
    `SELECT pattern_key, occurrences, summary, status, updated_at FROM learning_proposals
      WHERE kind='action_reflection' AND status IN ('candidate','validating')
      ORDER BY occurrences DESC, updated_at DESC LIMIT ?`,
  ).all(Math.max(1, Math.min(100, Number(limit) || 10)));
}
