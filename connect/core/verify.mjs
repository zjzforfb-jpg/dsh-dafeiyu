// M2 / A1：执行结果判定（evaluate）。
//
// 现在的链路是「动作返回 ok 就算办好了」，但 ok 的语义很弱：
//   - qq.call 的 ok 只代表「指令发出去了」，通没通要等 call_ended；
//   - douyin.publish 的 ok 只代表「点到了发布」，作品到底出没出来要看回执里的 data；
//   - 有的动作 ok 但 text 是空的，等于没有可核对的东西。
//
// 所以补一层判定：拿「这一步应该产生什么」对「实际拿到了什么、证据是什么」，
// 输出 confirmed / unconfirmed / mismatched / failed / skipped。
// 判定纯规则、不调模型、不加延迟，结论写进 checkpoint 与回执，供 /live 与回执文案使用。

/** 判定结论。 */
export const VERDICTS = Object.freeze({
  confirmed: 'confirmed',       // 结果 + 证据都对得上
  unconfirmed: 'unconfirmed',   // 跑了，但没有足够证据说到做到了
  mismatched: 'mismatched',     // 有回执，但内容和预期相反
  failed: 'failed',             // 动作本身失败
  skipped: 'skipped',           // 幂等跳过，不做判定
});

/**
 * 每个动作「什么才算真的成了」。
 *
 * dataKeys：回执 data 里必须至少出现一个，否则只能算 unconfirmed（点到了，但没看到结果）。
 * minCount：data 里某个计数字段至少要到多少，否则算 mismatched（说做了 3 条，实际 0 条）。
 * needsExternal：ok 只代表「发出去了」，还得等外部事件（通话结局）才算完 —— 永远不给 confirmed。
 */
export const EXPECTATIONS = Object.freeze({
  'douyin.publish': { dataKeys: ['worksCount', 'count', 'workId', 'draftFile'], minCount: null },
  'douyin.publish_draft': { dataKeys: ['worksCount', 'count', 'workId'], minCount: null },
  'douyin.reply_comments': { dataKeys: ['count', 'replied', 'comments'], minCount: { key: 'count', min: 1 } },
  // 爆款评论这一轮「0 条」常常是真的没得回（视频评论区空），不该判成「对不上」，
  // 但也绝不能算 confirmed —— 它确实什么都没发生。
  'douyin.hot_comment_round': { dataKeys: ['count', 'replied', 'comments'], minCount: null, emptyIsUnconfirmed: true },
  'douyin.check_interactions': { dataKeys: ['count', 'items', 'unread'], minCount: null },
  // 评论是否真的发出去了：脚本回 sent/verified，一条也算成
  'douyin.comment_latest': { dataKeys: ['sent', 'verified', 'count'], minCount: { key: 'count', min: 1 } },
  'qq.call': { dataKeys: [], needsExternal: true },
  'qq.call_mom': { dataKeys: [], needsExternal: true },
  'wechat.call': { dataKeys: [], needsExternal: true },
  'qq.hangup': { dataKeys: [], needsExternal: true },
});

const DEFAULT_EXPECTATION = Object.freeze({ dataKeys: [], minCount: null, needsExternal: false });

export function expectationOf(operation) {
  return EXPECTATIONS[String(operation ?? '')] ?? DEFAULT_EXPECTATION;
}

function pickData(result) {
  const data = result?.data;
  if (!data || typeof data !== 'object') return {};
  return data;
}

/**
 * 判定一步的结果。
 * @param {object} args
 *  operation  动作名
 *  result     { ok, text, data, error }
 *  receipt    可选，createReceipt 的产物（有它就用 receipt.detail 当证据文本）
 * @returns {{ verdict, reason, evidence }}
 */
export function evaluateOutcome({ operation = '', result = null, receipt = null } = {}) {
  const expectation = expectationOf(operation);
  const ok = result?.ok === true;
  if (!ok) {
    return {
      verdict: VERDICTS.failed,
      reason: String(result?.error ?? receipt?.detail ?? 'action_failed').slice(0, 160),
      evidence: [],
    };
  }
  const data = pickData(result);
  const text = String(result?.text ?? receipt?.detail ?? '').trim();
  const evidence = [];
  if (text) evidence.push(`text:${text.slice(0, 120)}`);
  for (const key of Object.keys(data).slice(0, 6)) {
    const value = data[key];
    if (value === undefined || value === null || value === '') continue;
    evidence.push(`${key}=${typeof value === 'object' ? JSON.stringify(value).slice(0, 80) : String(value).slice(0, 80)}`);
  }

  // 1) 通话类：指令送达 ≠ 通话成功，结局由 call_ended 事件决定。
  if (expectation.needsExternal) {
    return { verdict: VERDICTS.unconfirmed, reason: 'awaiting_external_event', evidence };
  }

  // 1.4) 被闸门挡住（每小时条数上限、合规拦截）：不是故障，也不是「没活干」
  if (data.blocked) {
    return { verdict: VERDICTS.unconfirmed, reason: `blocked:${String(data.blocked).slice(0, 60)}`, evidence };
  }

  // 1.5) 「本轮什么都没做」必须先判：动作成功但 count=0，不能报成办好了，
  // 也不能因为「要求至少 1 条」就判成 mismatched——那是把「没活干」当成「干错了」。
  // 动作可以自己举手（data.nothingToDo）：评论只剩图片/都回过了、爆款下没人可回。
  if ((expectation.emptyIsUnconfirmed || data.nothingToDo === true) && Number(data.count) === 0) {
    // 把「扫了几条 / 为什么跳过」带进 reason，页面和回执都能复核
    const scanned = Number(data.scanned ?? 0);
    const parts = Object.entries(data.breakdown ?? {}).map(([key, n]) => `${key}×${n}`);
    const detail = parts.length ? `:${parts.join(',')}` : '';
    return { verdict: VERDICTS.unconfirmed, reason: `nothing_to_do${scanned ? `(${scanned})` : ''}${detail}`, evidence };
  }

  // 2) 有明确计数要求的：达成了才算 confirmed，反向达成算 mismatched。
  if (expectation.minCount) {
    const { key, min } = expectation.minCount;
    const raw = data[key];
    const value = Number(raw);
    if (Number.isFinite(value) && value < min) {
      return { verdict: VERDICTS.mismatched, reason: `${key}=${value}<${min}`, evidence };
    }
    if (raw === undefined || raw === null) {
      return { verdict: VERDICTS.unconfirmed, reason: `missing_${key}`, evidence };
    }
  }

  // 3) 期待有结果字段：一个都没有就说明「点到了但没看到结果」。
  const dataKeys = expectation.dataKeys ?? [];
  if (dataKeys.length && !dataKeys.some((key) => data[key] !== undefined && data[key] !== null)) {
    return { verdict: VERDICTS.unconfirmed, reason: 'no_result_data', evidence };
  }

  // 4) 既没数据也没文本：等于什么都没证据。
  if (!evidence.length) {
    return { verdict: VERDICTS.unconfirmed, reason: 'no_evidence', evidence };
  }

  return { verdict: VERDICTS.confirmed, reason: 'ok', evidence };
}

/** 整个任务的判定：任何一步 failed → failed；有 mismatched → mismatched；有 unconfirmed → unconfirmed；全 confirmed → confirmed。 */
export function evaluateTask({ steps = [] } = {}) {
  const verdicts = steps.map((step) => step?.verdict ?? VERDICTS.failed);
  const count = (name) => verdicts.filter((value) => value === name).length;
  const failed = count(VERDICTS.failed);
  const mismatched = count(VERDICTS.mismatched);
  const unconfirmed = count(VERDICTS.unconfirmed);
  const confirmed = count(VERDICTS.confirmed);
  let verdict = VERDICTS.confirmed;
  if (failed) verdict = VERDICTS.failed;
  else if (mismatched) verdict = VERDICTS.mismatched;
  else if (unconfirmed || confirmed === 0) verdict = VERDICTS.unconfirmed;
  return { verdict, counts: { confirmed, unconfirmed, mismatched, failed }, total: steps.length };
}

/** 给人看的一句话，回执与 /live 都用它，避免各处自己编措辞。 */
export function describeVerdict(verdict, reason = '') {
  switch (verdict) {
    case VERDICTS.confirmed: return '已核对：结果和预期一致';
    case VERDICTS.unconfirmed: return `未核对：${reason || '没拿到可核对的结果'}`;
    case VERDICTS.mismatched: return `对不上：${reason || '结果和预期相反'}`;
    case VERDICTS.failed: return `失败：${reason || '动作报错'}`;
    case VERDICTS.skipped: return '跳过：这一步之前已经做过';
    default: return `未知判定${reason ? `：${reason}` : ''}`;
  }
}
