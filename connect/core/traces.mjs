// M1 / B1：把「情景记忆」接回决策回路。
//
// agent_events 里已经有几百条真实轨迹（谁、什么时候、哪个任务、成没成），
// 但它们只被 /live 和看板读，planner 一次都没见过——等于每次都在盲猜。
//
// 这里做一个最小的检索动作：给定这次要做的动作，找出「同类的最近几次」，
// 压成一两行塞进规划上下文。原则：
//   - 只读，不写库，不改任何状态；
//   - 只取「结论」，不搬正文（省 token，也不把隐私内容喂回模型）；
//   - 没有同类记录就返回空数组，让上层决定要不要加这几行。

const LOOKBACK_MS = Object.freeze({
  default: 14 * 24 * 60 * 60 * 1000,
});

/** 从事件里抽一句「这一步的结论」，优先用判定而不是动作名。 */
function conclude(row) {
  const type = String(row.event_type ?? '');
  let payload = null;
  try { payload = row.payload ? JSON.parse(row.payload) : null; } catch { payload = null; }
  const verdict = payload?.verdict ?? payload?.status ?? null;
  const detail = payload?.detail ?? payload?.summary ?? payload?.error ?? null;
  const operation = payload?.operation ?? payload?.actions ?? null;
  const when = String(row.created_at ?? '').slice(5, 16);
  const head = type === 'action_failed' ? '失败' : type === 'receipt_verified' ? '回执' : '汇报';
  const bits = [head];
  if (operation) bits.push(Array.isArray(operation) ? operation.join('+') : String(operation));
  if (verdict) bits.push(String(verdict));
  const text = `${when} ${bits.join(' · ')}${detail ? `：${String(detail).slice(0, 80)}` : ''}`;
  return { type, verdict: verdict ? String(verdict) : null, text };
}

/**
 * 找同类任务的最近几条结论。
 * @param {object} db   connect.sqlite
 * @param {object} options
 *  operations  这次要做的动作名（['douyin.publish']），空数组表示不筛
 *  limit       最多返回几条，默认 3
 *  now         当前时间（毫秒），测试可注入
 * @returns {Array<{taskId,status,verdict,when,summary}>}
 */
export function similarTraces(db, { operations = [], limit = 3, now = Date.now(), lookbackMs = LOOKBACK_MS.default } = {}) {
  if (!db) return [];
  const wanted = (Array.isArray(operations) ? operations : []).map(String).filter(Boolean);
  const since = new Date(now - lookbackMs).toISOString();
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT id, event_type, task_id, payload, created_at FROM agent_events
        WHERE created_at >= ? AND task_id IS NOT NULL
          AND event_type IN ('task_reported','action_failed','action_finished','receipt_verified','call_ended')
        ORDER BY id DESC LIMIT 400`,
    ).all(since);
  } catch { return []; }

  const byTask = new Map();
  for (const row of rows) { // 已按 id DESC，第一次见到某个任务时就是它最新的一条
    const taskId = String(row.task_id ?? '');
    if (!taskId) continue;
    if (!byTask.has(taskId)) byTask.set(taskId, []);
    byTask.get(taskId).push(row);
  }

  const traces = [];
  for (const [taskId, events] of byTask) {
    // 动作名匹配：只认「这条任务确实做过这个动作」，避免把无关任务当经验。
    const matched = wanted.length === 0 || events.some((row) => {
      const text = String(row.payload ?? '');
      return wanted.some((name) => text.includes(name));
    });
    if (!matched) continue;
    const latest = events[0];
    const concluded = conclude(latest);
    traces.push({
      taskId,
      verdict: concluded.verdict,
      when: String(latest.created_at ?? '').slice(0, 16),
      summary: concluded.text,
      failed: events.some((row) => row.event_type === 'action_failed'),
    });
    if (traces.length >= limit) break;
  }
  return traces;
}

/** 把检索结果压成给 planner 的几行（≤200 字，避免 prompt 变胖）。 */
export function tracesText(traces = []) {
  const rows = (Array.isArray(traces) ? traces : []).filter((row) => row?.summary);
  if (!rows.length) return '';
  return rows.slice(0, 3).map((row) => `- ${row.summary}`).join('\n').slice(0, 400);
}

/**
 * 从一句话里猜这次可能碰到的动作，用来筛「同类任务」。
 * 猜不中就返回空数组——检索退化成「最近三条」，也比完全不给强。
 */
const TEXT_HINTS = Object.freeze([
  { match: /(发|发布|写|再发).{0,4}(图文|作品|日常)|发一条|再发一条/u, operations: ['douyin.publish'] },
  { match: /评论|回一条|回复/u, operations: ['douyin.reply_comments', 'douyin.hot_comment_round'] },
  { match: /热点|热榜|热搜/u, operations: ['douyin.hotspot'] },
  { match: /互动|新评论|有没有新/u, operations: ['douyin.check_interactions'] },
  { match: /打电话|打个电话|拨号|拨过去|通话|拨过去/u, operations: ['qq.call', 'qq.call_mom', 'wechat.call'] },
  { match: /挂断|挂了/u, operations: ['qq.hangup'] },
  { match: /学习|成长|周刊|上一课/u, operations: ['academy.study', 'academy.weekly'] },
]);

export function operationHints(text) {
  const value = String(text ?? '');
  const found = new Set();
  for (const hint of TEXT_HINTS) {
    if (hint.match.test(value)) for (const name of hint.operations) found.add(name);
  }
  return [...found];
}
