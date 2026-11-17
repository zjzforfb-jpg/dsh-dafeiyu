// P1-B · B-1：评论专用流水线（架构 ADR-004）。
//
// 以前「回评论」这件事散在 scripts/douyin.mjs 的大 if 里，跟通用聊天链路混成一团：
// 理解、拟稿、合规、发出去、记一笔，全挤在一个函数里，出问题只能看日志。
// 更要命的是：模型一句话说「我去回评论」，到底回没回、回的是哪条、平台收没收，
// 事后没有一条统一的证据链（就是 R-12 那类「断言写在中文散文里」的病根）。
//
// 现在拆成七段，每段单独可测、单独留痕：
//
//   understand → intent → draft → compliance → decision → publish → verify
//
// 关键约定：
//   * 本模块**不依赖**任何聊天链路（qq/service、brain、planner），只依赖评论域的东西：
//     抖音评论分类（connect/douyin/store.mjs）、合规闸门（connect/douyin/compliance.mjs）、
//     回执五态（connect/receipts.mjs）。
//   * 设备动作全部靠注入（generate/publish/check），所以整条流水线可以在没有手机的情况下测。
//   * 决策段按风险分层（D5）：R2 自动、R3 必人工确认；合规 level=draft 也转人工。
//   * 回执段用 P0-C 的五态语义：invoked < accepted < verified，failed/unknown 是「没成」。
import { classifyComment, pickCuteReply } from '../douyin/store.mjs';
import { checkComment } from '../douyin/compliance.mjs';
import { classifyResult, createReceipt, receiptOk, receiptVerified } from '../receipts.mjs';

export const COMMENT_STAGES = Object.freeze([
  'understand', 'intent', 'draft', 'compliance', 'decision', 'publish', 'verify',
]);

/** 决策段的三种出路。 */
export const DECISIONS = Object.freeze(['auto', 'review', 'skip', 'retry']);

/** 流水线结果里每段的记法。 */
const STAGE_STATUS = Object.freeze(['done', 'skipped', 'blocked', 'failed']);

// ── 1. 评论理解 ────────────────────────────────────────────────────────────

/**
 * 读懂一条评论：它是真话、纯表情，还是只有图。
 * 复用 connect/douyin/store.mjs 的 classifyComment，别在这里另写一套。
 */
export function understandComment(raw) {
  const text = String(raw ?? '').trim();
  const { kind, meaningful } = classifyComment(text);
  return { kind, meaningful, text };
}

// ── 2. 意图判定 ────────────────────────────────────────────────────────────

/**
 * 看到这条评论，要不要回、怎么回。
 *  - skip     ：空评论/只有图，没什么可回，也不该硬凑。
 *  - emoji    ：纯表情或一两个字，回一个可爱表情就够了，不硬编文字。
 *  - reply    ：有真话，值得认真回一句。
 */
export function decideIntent({ kind, meaningful }) {
  if (kind === 'image' && !meaningful) return { intent: 'skip', reason: 'no_content' };
  if (!meaningful) return { intent: 'emoji', reason: 'low_signal' };
  return { intent: 'reply', reason: 'has_content' };
}

// ── 3. 拟稿 ────────────────────────────────────────────────────────────────

/**
 * 拟一句回复。generate 没给就回可爱表情（不硬编）。
 * generate 抛错时不静默吞掉——拟稿失败就是失败，记 failed。
 */
export async function draftReply({ intent, comment, generate, context = null, random = Math.random }) {
  // intent 既可以是字符串（'reply'/'emoji'/'skip'），也可以是 decideIntent 的返回对象。
  const mode = typeof intent === 'string' ? intent : intent?.intent;
  if (mode === 'skip') return { text: '', kind: 'none' };
  if (mode === 'emoji') return { text: pickCuteReply(random), kind: 'emoji' };
  if (typeof generate !== 'function') throw new Error('missing_generator');
  // context 是「这条评论在哪个作品下面、那一串对话是什么」，没有就是 null：
  // 生成为空时降级，绝不替模型编作品内容。
  const text = String((await generate({ comment, intent: mode, context })) ?? '').trim();
  if (!text) throw new Error('empty_draft');
  return { text, kind: 'text' };
}

// ── 4. 合规检查 ────────────────────────────────────────────────────────────

/**
 * 过合规闸门。默认用 connect/douyin/compliance.mjs 的 checkComment，
 * 也可以注入（测的时候用假的，或者接不同的平台规则）。
 */
export function checkCompliance({ text, check = checkComment, context = {} }) {
  const decision = check(text, context);
  return {
    ok: decision?.ok === true,
    level: decision?.level ?? 'block',
    id: decision?.id ?? 'unknown',
    reason: decision?.reason ?? 'unknown',
  };
}

// ── 5. 人工/自动决策 ───────────────────────────────────────────────────────

/**
 * 风险分层（D5）：
 *  - 合规 block        → skip（不许发）
 *  - 合规 draft        → review（要人看一眼）
 *  - risk R3           → review（对外写操作，必须人确认）
 *  - risk R2 且合规 ok → auto
 *  - 合规 id=too_fast  → retry（等间隔再来，不是失败）
 */
export function decideAction({ compliance, risk = 'R2', reviewRequired = false }) {
  if (compliance.id === 'too_fast') {
    return { decision: 'retry', reason: 'too_fast', risk };
  }
  if (!compliance.ok && compliance.level === 'block') {
    return { decision: 'skip', reason: compliance.reason, risk };
  }
  if (!compliance.ok) {
    return { decision: 'review', reason: compliance.reason, risk };
  }
  if (reviewRequired || risk === 'R3') {
    return { decision: 'review', reason: 'risk_requires_confirmation', risk };
  }
  return { decision: 'auto', reason: 'r2_auto', risk };
}

// ── 6+7. 发布与回执验证 ────────────────────────────────────────────────────

/**
 * 发布结果 → 回执五态。平台说"发了"只是 accepted；
 * 业务上真看见这条评论出现在自己作品下面才是 verified。
 */
export function verifyPublish({ result, operation = 'douyin.reply_comments', adapter = 'douyin', observedAt = new Date().toISOString() }) {
  const raw = result ?? {};
  // 抖音适配器的原生返回是 { sent: true }，而回执分类看的是 ok/verified/invoked。
  // 这里对齐一次，别让「确实发出去了」在回执里掉成 unknown。
  const normalized = raw.ok === undefined && raw.sent === true ? { ...raw, ok: true } : raw;
  const receipt = createReceipt({ operation, adapter, result: normalized, observedAt });
  return {
    ...receipt,
    sent: raw.sent === true,
    verified: receiptVerified(receipt.status),
    wentThrough: receiptOk(receipt.status),
  };
}

// ── 编排 ────────────────────────────────────────────────────────────────────

/**
 * 跑一条评论的完整流水线。
 *
 * @param {object}   options
 * @param {object}   options.comment   { author, text } 评论本身
 * @param {Function} options.generate  拟稿函数（intent==='reply' 时才会调）
 * @param {Function} options.publish   发布函数，返回 { sent, verified?, accepted?, ok? }
 * @param {Function} options.check      合规检查（默认 checkComment）
 * @param {string}   options.risk       R0/R2/R3，默认 R2（评论回复是 R2 自动）
 * @param {boolean}  options.reviewRequired  强制人工确认
 * @param {boolean}  options.dryRun     只拟稿不发布
 * @param {Function} options.onStage    每段回调 (stage, detail) => void
 */
export async function runCommentPipeline({
  comment = {},
  generate,
  publish,
  check = checkComment,
  complianceContext = {},
  risk = 'R2',
  reviewRequired = false,
  dryRun = false,
  random = Math.random,
  onStage = null,
  operation = 'douyin.reply_comments',
  draftText = '',
  context = null,
} = {}) {
  const stages = [];
  const trace = (stage, status, detail = {}) => {
    stages.push({ stage, status, ...detail });
    if (typeof onStage === 'function') onStage(stage, { status, ...detail });
  };

  // 1. 评论理解
  const understood = understandComment(comment.text ?? comment.comment ?? '');
  trace('understand', 'done', { kind: understood.kind, meaningful: understood.meaningful });

  // 2. 意图判定
  const intent = decideIntent(understood);
  trace('intent', 'done', { intent: intent.intent, reason: intent.reason });
  if (intent.intent === 'skip') {
    trace('draft', 'skipped', { reason: intent.reason });
    trace('compliance', 'skipped', { reason: intent.reason });
    trace('decision', 'skipped', { reason: intent.reason });
    trace('publish', 'skipped', { reason: intent.reason });
    trace('verify', 'skipped', { reason: intent.reason });
    return { ok: false, stage: 'intent', skipped: true, reason: intent.reason, understood, intent, stages };
  }

  // 3. 拟稿
  let draft;
  try {
    // draftText 是「人已经给好文案」的情况（比如命令行走 --text 指定）：
    // 直接用它，不再让模型重拟，但仍走后面的合规与决策。
    const fixed = String(draftText ?? '').trim();
    draft = fixed ? { text: fixed, kind: 'text' } : await draftReply({ intent, comment, generate, context, random });
  } catch (error) {
    trace('draft', 'failed', { error: String(error?.message ?? error) });
    return { ok: false, stage: 'draft', error: String(error?.message ?? error), understood, intent, stages };
  }
  trace('draft', 'done', { kind: draft.kind, length: draft.text.length, context: context?.mode ?? 'none' });

  // 4. 合规检查
  const compliance = checkCompliance({ text: draft.text, check, context: complianceContext });
  trace('compliance', 'done', { ok: compliance.ok, level: compliance.level, id: compliance.id });

  // 5. 人工/自动决策
  const action = decideAction({ compliance, risk, reviewRequired });
  trace('decision', 'done', { decision: action.decision, reason: action.reason, risk: action.risk });
  if (action.decision === 'skip' || action.decision === 'review') {
    trace('publish', 'skipped', { reason: action.reason });
    trace('verify', 'skipped', { reason: action.reason });
    return {
      ok: false,
      stage: 'decision',
      needsReview: action.decision === 'review',
      reason: action.reason,
      understood,
      intent,
      draft,
      compliance,
      decision: action,
      stages,
    };
  }
  if (action.decision === 'retry') {
    trace('publish', 'skipped', { reason: 'too_fast' });
    trace('verify', 'skipped', { reason: 'too_fast' });
    return { ok: false, stage: 'decision', retry: true, reason: 'too_fast', understood, intent, draft, compliance, decision: action, stages };
  }

  // 6. 发布
  if (dryRun) {
    trace('publish', 'skipped', { reason: 'dry_run' });
    trace('verify', 'skipped', { reason: 'dry_run' });
    return { ok: true, stage: 'publish', dryRun: true, understood, intent, draft, compliance, decision: action, stages };
  }
  if (typeof publish !== 'function') {
    trace('publish', 'failed', { error: 'missing_publisher' });
    return { ok: false, stage: 'publish', error: 'missing_publisher', understood, intent, draft, compliance, decision: action, stages };
  }
  let published;
  try {
    published = await publish({ comment, text: draft.text, kind: draft.kind });
  } catch (error) {
    trace('publish', 'failed', { error: String(error?.message ?? error) });
    return { ok: false, stage: 'publish', error: String(error?.message ?? error), understood, intent, draft, compliance, decision: action, stages };
  }
  trace('publish', 'done', { sent: published?.sent === true });

  // 7. 回执验证
  const receipt = verifyPublish({ result: published, operation });
  trace('verify', receipt.wentThrough ? 'done' : 'blocked', { status: receipt.status, verified: receipt.verified });

  return {
    ok: receipt.wentThrough,
    stage: 'verify',
    understood,
    intent,
    draft,
    compliance,
    decision: action,
    published,
    receipt,
    stages,
  };
}

/** 流水线结果的紧凑摘要（给动作层回话用）。 */
export function summarizePipeline(result) {
  if (!result) return '';
  const parts = [];
  if (result.skipped) return '这条没什么可回的，跳过。';
  if (result.needsReview) return `这条得你点个头才发：${result.draft?.text ?? ''}`;
  if (result.retry) return '刚发得太快，等会儿再回。';
  if (!result.ok) return `没回成：${result.reason ?? result.error ?? '未知原因'}`;
  if (result.receipt?.verified) return `回好了：${result.draft?.text ?? ''}`;
  if (result.receipt?.status === 'accepted') return `发出去了（平台没回执确认）：${result.draft?.text ?? ''}`;
  parts.push(`回执 ${result.receipt?.status}`);
  return parts.join(' ');
}
