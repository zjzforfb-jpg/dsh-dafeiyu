import { createHash } from 'node:crypto';
import { forgetMemory, reviseMemory } from '../../brain/memory.mjs';
import { publishDesktopActivity } from '../../desktop/activity.mjs';
import { CallSessions } from './call.mjs';
import { isVoiceAttachment, QqGateway } from './gateway.mjs';
import { formatMemoryList, listMemories, memoryNotes, rememberExchange, rememberText } from './memory.mjs';
import { captureExchange, todayDigest } from '../memory-hub.mjs';
import { actionMarkerNames, stripActionMarkers, runAction } from '../actions.mjs';
import { qqPlanner } from './planner.mjs';
import { failedResults, factsDigest, factsText } from '../core/facts.mjs';
import { normalizeIntent } from '../core/task.mjs';
import { ROUTES, routePolicy } from '../core/route.mjs';
import { lessonsFor, learnLesson } from './lessons.mjs';
import { ALL_TOOLS, WRITE_TOOL_NAMES, catalogText, runTool } from './tools.mjs';
import { capabilityHints, capabilityIndex } from '../memory/capabilities.mjs';
import { approveLearning, learningText, rejectLearning } from '../skills/learning.mjs';
import { initOutbox, markOutboxSent, pendingOutbox } from './outbox.mjs';
import { ensureBinaries } from '../macui/index.mjs';
import { hangup as hangupQqCall } from '../macui/qq.mjs';
import { approvePendingTask, cancelTask, completeTask, initTasks, latestPendingTask, markAwaitingPublish, proposeTask, startTask, taskPayload } from '../tasks.mjs';
import { commitPublish, executeOperations, prepareDraft } from '../core/publish.mjs';
import { receiptOk } from '../receipts.mjs';
import { recordDailyExchange, recordDailyMessage } from '../daily-memory.mjs';
import { recordAgentEvent } from '../agent-events.mjs';
import { interactionEvent } from '../core-contract.mjs';
import { evaluatePolicy } from '../policy.mjs';
import { executeTaskAction } from '../core/execute.mjs';
import { similarTraces, operationHints } from '../core/traces.mjs';
import { loadTargets } from '../targets.mjs';
import { basename, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
/** 事件里带一行「消息前 80 字」，页面上不点开也能看到说了什么。 */
function clipText(text, max = 80) {
  const flat = String(text ?? '').replace(/\s+/gu, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

import { execFileSync } from 'node:child_process';
import { THEMES } from '../douyin/poster.mjs';
import { DAILY_BUDGET } from '../core/budget.mjs';
import { conversationHistory, dayKey, groupTranscript, initQq, logInbound, memberLabel, messageRow, peer, peers, recentMessages, reserve, savePeer, updateMessage, usage } from './store.mjs';

const MAX_DOWNLOAD = 10 * 1024 * 1024;
// D-2：日配额统一由 connect/core/budget.mjs 的 daily_budget 管（跨渠道同一格）。
// 这里不再各写各的上限——QQ、iLink、life 共用一个模型调用池与一个语音池。
const DAILY_MODEL_CALLS = DAILY_BUDGET.modelCalls;
const DAILY_VOICE_REQUESTS = DAILY_BUDGET.voiceRequests;

/** 主题必须是能放进一句话的短词：去掉「标题：/正文：」前缀，切掉分句，最多 24 字。 */
function sanitizeTheme(value) {
  const text = String(value ?? '').trim().replace(/[「」"']/gu, '');
  if (!text) return '';
  const stripped = text.replace(/^(标题|正文|文案|话题|主题)\s*[:：]\s*/u, '').split(/[；;\n]/u)[0].trim();
  return stripped.slice(0, 24);
}

/** 从「主题为X / 主题：X」这类说法里把主题抠出来。 */
function themeFromText(text) {
  const matched = /主题\s*(?:为|是|叫|：|:)?\s*([^，。！？,.!?\n；;]{1,30})/u.exec(String(text ?? ''));
  return matched ? sanitizeTheme(matched[1]) : '';
}

function formatTaskDetail(result) {
  try {
    const rows = JSON.parse(String(result ?? '[]'));
    const lines = rows.map((row) => String(row?.detail ?? '').trim()).filter(Boolean);
    if (lines.length) return lines.slice(0, 3).join('；').slice(0, 300);
  } catch {}
  const text = String(result ?? '').trim();
  return text ? text.slice(0, 300) : '（没有回执明细）';
}

const CALL_HELP = '通话已开始，直接发语音或文字都行；静默 60 秒会自动挂断，发 /挂断 可手动结束。';
const HANGUP_HELP = '通话已挂断。';

/** 群聊上下文：每个群友的消息带称呼，大肥鱼的回复作为 assistant 轮次。 */
export function groupContext(db, convId, excludeId, limit = 14) {
  const entries = groupTranscript(db, convId, limit, excludeId);
  const out = [];
  for (const entry of entries) {
    const who = entry.author ? memberLabel(db, 'group', convId, entry.author) : '群友';
    out.push({ role: 'user', content: `${who}：${String(entry.text).slice(0, 500)}` });
    if (entry.reply) out.push({ role: 'assistant', content: String(entry.reply).slice(0, 500) });
  }
  return out;
}

export { formatReview } from '../douyin/review.mjs';
import { formatDraftReview } from '../douyin/review.mjs';

/** 一审的主题从现成的 THEMES 里挑一个（先避开上次用过的）。 */
let lastTheme = null;
export function pickTheme(random = Math.random) {
  const pool = THEMES.filter((item) => item !== lastTheme);
  const theme = pool[Math.floor(random() * pool.length)] ?? THEMES[0];
  lastTheme = theme;
  return theme;
}

/**
 * 工具失败时的固定话术：宁可说没做成，也不许把「被弹窗挡住/没加载」说成「没有新评论」。
 */
export function failureReply(results) {
  const failed = (results ?? []).filter((item) => item && (item.ok === false || ['blocked', 'unconfirmed', 'failed'].includes(String(item.status ?? ''))));
  if (!failed.length) return '';
  const why = failed.map((item) => String(item.text ?? '').trim()).filter(Boolean).slice(0, 2).join('；');
  return `爸爸，这次没做成：${why || '工具没跑成，我先不乱说。'}`;
}

/** 消息进来以后依次经过的段：id 与 connect/core/pipeline.mjs 的九段对应。 */
export const RUNTIME_STAGES = Object.freeze([
  {
    id: 'entry',
    call: (service, event) => service.ingest(event),
    assign: (value) => ({ ctx: value }),
    stopIf: (value) => value?.duplicate === true,
    stopValue: () => ({ duplicate: true }),
  },
  { id: 'observe', call: (service, _event, state) => service.identify(state.ctx) },
  {
    id: 'route',
    call: (service, _event, state) => service.route(state.ctx),
    stopIf: (value) => Boolean(value),
    stopValue: (value) => value,
  },
  {
    id: 'task',
    call: (service, _event, state) => service.plan(state.ctx),
    assign: (value) => ({ planned: value }),
    stopIf: (value) => Boolean(value?.result),
    stopValue: (value) => value.result,
  },
  {
    id: 'act',
    call: (service, _event, state) => service.executePlan(state.ctx, state.planned),
    assign: (value) => ({ executed: value }),
    stopIf: (value) => Boolean(value?.result),
    stopValue: (value) => value.result,
  },
  { id: 'deliver', call: (service, _event, state) => service.deliver(state.ctx, state.executed), returns: true },
]);

export class QqService {
  constructor({ db, voice, api, ask, planner = null, WebSocketImpl, gateway, memory = null, home = null, petPort = 3108, log = () => {}, now = () => Date.now(), callTimeoutMs = 60000, downloadImpl = fetch, groupReplyRate = 0.08, groupCooldownMs = 90000, groupNameCooldownMs = 25000, random = Math.random, execute = runAction }) {
    this.root = home ? join(home, '..', '..') : process.cwd();
    initQq(db);
    initTasks(db);
    Object.assign(this, { db, voice, api, ask, log, now, downloadImpl, memory, home, petPort, groupReplyRate, groupCooldownMs, groupNameCooldownMs, random, execute, messageUrl: null });
    try { initOutbox(db); } catch {}
    this.planner = planner ?? (home ? qqPlanner(home) : null);
    this.catalog = catalogText(ALL_TOOLS);
    this.toolCtx = { root: this.root };
    this.ambientAt = new Map();
    this.calls = new CallSessions({ timeoutMs: callTimeoutMs, now });
    this.gateway = gateway ?? new QqGateway({ api, WebSocketImpl, onEvent: event => this.handle(event), onStatus: status => log({ qq: status }) });
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    this.sweepTimer = setInterval(() => this.sweep(), 15000);
    this.sweepTimer.unref?.();
    return this.gateway.start();
  }

  async close() {
    this.stopped = true;
    clearInterval(this.sweepTimer);
    await this.gateway.close();
  }

  status() {
    return { peers: peers(this.db), calls: this.calls.list(), usage: usage(this.db, dayKey(this.now())) };
  }

  setMessageUrl(url) { if (typeof url === 'string' && /^https?:\/\//u.test(url)) this.messageUrl = url; }

  publish(eventKey, { phase, message, activity = 'chat' }) {
    if (!this.memory || !this.home) return;
    void publishDesktopActivity({
      db: this.memory, home: this.home, port: this.petPort, eventKey,
      event: { source: 'conversation', activity, phase, message, ...(this.messageUrl ? { url: this.messageUrl } : {}) },
    }).catch(() => {});
  }

  async download(url) {
    if (typeof url !== 'string' || !url.startsWith('https://')) throw new Error('invalid_qq_media');
    const response = await this.downloadImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('qq_media_download_failed');
    const declared = Number(response.headers?.get?.('content-length') ?? 0);
    if (declared > MAX_DOWNLOAD) throw new Error('qq_media_too_large');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_DOWNLOAD) throw new Error('qq_media_too_large');
    return bytes;
  }

  /** 读取准备阶段落在盘上的待审内容。 */
  readPreparedPost() {
    try { return JSON.parse(readFileSync(join(this.root, 'runtime', 'douyin', 'pending.json'), 'utf8')); } catch { return null; }
  }

  async sendPreparedImage(kind, id, prepared) {
    try {
      const file = prepared?.imageFile;
      if (!file || !this.api?.sendImage) return;
      const preview = join(this.root, 'runtime', 'douyin', 'preview.jpg');
      execFileSync('sips', ['-Z', '1440', '-s', 'format', 'jpeg', file, '--out', preview], { stdio: 'ignore' });
      const buffer = readFileSync(preview);
      if (buffer.length > 6 * 1024 * 1024) return;
      await this.api.sendImage({ kind, id, file: buffer, fileName: basename(preview) });
    } catch (error) {
      this.log({ qq: { image_failed: String(error?.message ?? error) } });
    }
  }

  async sendTextSafe(kind, id, content, msgId) {
    try { await this.api.sendText({ kind, id, content, msgId }); return true; }
    catch (error) { this.log({ qq: 'text_failed', kind, id, error: error.message }); return false; }
  }

  sendVoiceSafe(kind, id, silk, msgId) {
    return this.api.sendVoice({ kind, id, silk, fileName: '大肥鱼语音回复.silk', msgId });
  }

  shouldJoinAmbient(kind, id, text) {
    const key = `${kind}:${id}`;
    const gap = this.now() - (this.ambientAt.get(key) ?? 0);
    const named = /大肥鱼|肥鱼|鱼鱼/u.test(text);
    if (gap < (named ? this.groupNameCooldownMs : this.groupCooldownMs)) return false;
    if (!named && this.random() >= this.groupReplyRate) return false;
    this.ambientAt.set(key, this.now());
    return true;
  }

  async hangupCall() {
    try {
      const bins = ensureBinaries(this.root);
      const done = await hangupQqCall(bins);
      if (done) this.log({ qq: { hangup: true } });
      return done;
    } catch (error) {
      this.log({ qq: { hangup: false, error: error.message } });
      return false;
    }
  }

  static messageKeyOf(mid) { return mid ? createHash('sha256').update(String(mid)).digest('hex') : null; }

  async approveTask(pending, { kind, id, messageId = null, quiet = false, event = null } = {}) {
    if (!evaluatePolicy(event, 'task.approve').allowed) return { held: true, error: 'approval_source_unauthorized' };
    const messageKey = QqService.messageKeyOf(messageId);
    const record = (reply) => { if (messageKey) updateMessage(this.db, messageKey, { status: 'sent', reply, delivery_kind: 'text' }); };
    const approval = approvePendingTask(this.db, pending.id, event.sender.platform_user_id, this.now());
    if (!approval.ok) return { held: true, error: 'task_already_processed' };
    if (!startTask(this.db, pending.id, this.now())) return { held: true, error: 'task_recovery_required' };
    const payload = taskPayload(pending);
    const executeApproved = (name, args = {}) => executeTaskAction({ db: this.db, taskId: pending.id, operation: name, event, root: this.root, args, execute: this.execute });

    if (approval.previous === 'awaiting_publish') {
      // 草稿阶段：内容爸爸已经审过了，现在才动手机（填发布页 → 发作品）。
      let prepared = {};
      try { prepared = JSON.parse(pending.result ?? '{}') ?? {}; } catch { prepared = {}; }
      const outcome = await commitPublish({
        operations: ['douyin.publish'],
        execute: executeApproved,
        args: prepared?.draftFile ? { draft: prepared.draftFile } : {},
        prepared,
        receiptFor: (operation, actionName) => actionName,
        db: this.db,
        taskId: pending.id,
        channel: 'douyin',
      });
      const ok = outcome.ok;
      const detail = ok
        ? (outcome.details.filter(Boolean).join('；') || '发布完成')
        : String(outcome.errors[0] ?? 'publish_failed');
      completeTask(this.db, pending.id, { ok, result: outcome.receipts }, this.now());
      const reply = ok ? `发出去了：${detail}` : `发布没成：${detail}。你看一眼手机，我没再乱点。`;
      await this.sendTextSafe(kind, id, reply, messageId);
      record(reply);
      this.markReported(pending.id);
      return { task_id: pending.id, status: ok ? 'succeeded' : 'failed' };
    }

    // 不是发布类动作：沿用原来的一次性执行。
    if (!(payload?.operations ?? []).includes('douyin.publish')) {
      // 回执的渠道名要跟真动作一致：qq.call 不该记成 adapter=douyin（那是抖音发布专用）。
      const opChannel = (name) => {
        const head = String(name ?? '').split('.')[0];
        return ['qq', 'wechat', 'ilink'].includes(head) ? head : 'douyin';
      };
      const ops = payload?.operations ?? [];
      const outcome = await executeOperations({
        operations: ops,
        execute: executeApproved,
        db: this.db,
        taskId: pending.id,
        channel: opChannel(ops[0]),
        adapterFor: (name) => opChannel(name),
        stopOnFailure: false,
      });
      const joined = outcome.details.filter(Boolean).join('；');
      completeTask(this.db, pending.id, { ok: outcome.ok, result: outcome.receipts }, this.now());
      // 电话/挂断这类动作：ok 只代表「指令送出去了」，接通与否要看 call_ended 事件，
      // 所以措辞不能写「办好了」——那等于替对方答应了接听。
      const isCall = ops.some((name) => /(^|\.)(call|call_mom|hangup)$/u.test(String(name)));
      const reply = outcome.ok
        ? isCall
          ? `${joined || '已经拨出去了。'}（接没接通、聊了多久，我记在通话事件里）`
          : `办好了：${joined || '任务已执行完成。'}`
        : `没办成：${joined || '任务执行未完全成功。'}`;
      await this.sendTextSafe(kind, id, reply, messageId);
      record(reply);
      this.markReported(pending.id);
      return { task_id: pending.id, status: outcome.ok ? 'succeeded' : 'failed' };
    }

    if (!quiet) await this.sendTextSafe(kind, id, '好，我这就写，写完把内容编号发你先审，你点头我再发。', messageId);
    const outcome = await prepareDraft({
      operations: payload?.operations ?? [],
      execute: executeApproved,
      args: { theme: payload?.theme },
      db: this.db,
      taskId: pending.id,
      channel: 'douyin',
      stopOnFailure: false,
    });
    if (!outcome.ok) {
      completeTask(this.db, pending.id, { ok: false, result: outcome.receipts }, this.now());
      const failed = outcome.receipts.find((row) => !receiptOk(row.status));
      const reply = `内容没准备好：${failed?.detail ?? '未知原因'}。这次先断了，再让我试一次就重来。`;
      await this.sendTextSafe(kind, id, reply, messageId);
      record(reply);
      this.markReported(pending.id);
      return { task_id: pending.id, status: 'failed' };
    }
    const prepared = outcome.data ?? this.readPreparedPost();
    markAwaitingPublish(this.db, pending.id, { prepared: { ...prepared, stage: 'draft' }, now: this.now() });
    const review = outcome.data ? formatDraftReview(prepared) : formatReview(prepared);
    await this.sendTextSafe(kind, id, review, messageId);
    await this.sendPreparedImage(kind, id, prepared);
    updateMessage(this.db, messageKey, { status: 'sent', reply: review, delivery_kind: 'text' });
    return { task_id: pending.id, status: 'awaiting_publish' };

  }

  async approveFromBoard(taskId, { adminAuthorized = false } = {}) {
    if (!adminAuthorized) return { ok: false, error: 'board_authorization_required' };
    const task = this.db.prepare('SELECT * FROM external_tasks WHERE id = ?').get(String(taskId ?? ''));
    if (!task) return { ok: false, error: 'task_not_found' };
    if (!['awaiting_confirmation', 'awaiting_publish'].includes(task.status)) return { ok: false, error: 'task_not_pending', status: task.status };
    const kind = task.conv_kind ?? 'c2c';
    const id = task.conv_id;
    const ownerId = loadTargets(this.root).qq.dad;
    if (!ownerId) return { ok: false, error: 'qq_owner_not_configured' };
    const event = interactionEvent({ channel: 'desktop', conversationId: 'board', senderId: ownerId, senderRole: 'owner', text: 'approve', sourceEventId: task.id });
    const result = await this.approveTask(task, { kind, id, quiet: true, event });
    if (result.held) return { ok: false, error: result.error ?? 'held', status: task.status };
    const note = result.status === 'awaiting_publish'
      ? '爸爸在看板上点了「同意」✅，我这就去写，写完把标题、正文、话题和配图编号发你审。'
      : '爸爸在看板上点了「同意」✅，这条我这就去办，办完给你回执。';
    try { await this.sendTextSafe(kind, id, note); } catch {}
    return { ok: true, status: result.status, note };
  }

  async cancelFromBoard(taskId) {
    const task = this.db.prepare('SELECT * FROM external_tasks WHERE id = ?').get(String(taskId ?? ''));
    if (!task) return { ok: false, error: 'task_not_found' };
    if (!['awaiting_confirmation', 'awaiting_publish'].includes(task.status)) return { ok: false, error: 'task_not_pending', status: task.status };
    cancelTask(this.db, task.id, this.now(), '爸爸说算了，先不动了');
    const note = '爸爸在看板上把这条任务作废了，我就不动了。';
    try { await this.sendTextSafe(task.conv_kind ?? 'c2c', task.conv_id, note); } catch {}
    return { ok: true, note };
  }


  /**
   * QQ 入站主链路。拆成六段，每段只干一件事：
   *   ① ingest    去重、认语音附件、算 messageKey
   *   ② identify  身份信封、事件落库、策略判定
   *   ③ route     规则优先：拒绝 / 改稿 / 同意 / 学习闭环 / 外部意图 / 斜杠命令
   *   ④ plan      语音转写、预算、决策脑、只读工具、事实回灌
   *   ⑤ execute   写操作建任务、旧 [DO:...] 标记通道收口
   *   ⑥ deliver   发消息、记日记、回写长期记忆
   *
   * 外部动作永远不由「模型说要做」触发：只有系统回执 + 爸爸的明确同意才执行。
   */
  async handle(event) {
    // 六段一条表（M1 / D1）：顺序、什么时候早退、结果放在哪，全部写在这里，
    // 不再是散在函数体里的 if-return。加一段只改这张表，页面上的九步带也跟着走。
    const state = { ctx: null, planned: null, executed: null };
    for (const stage of RUNTIME_STAGES) {
      const value = await stage.call(this, event, state);
      if (stage.assign && value !== undefined) Object.assign(state, stage.assign(value));
      if (stage.stopIf?.(value)) return stage.stopValue ? stage.stopValue(value) : value;
      if (stage.returns) return value;
    }
    return state.executed;
  }

  // ── ① ingest ─────────────────────────────────────────────────────────
  async ingest(event) {
    const { kind, id, messageId, text = '', attachments = [], atMe = kind !== 'group', memberId = null, mentionOthers = false, mentionAll = false } = event;
    const messageKey = createHash('sha256').update(String(messageId ?? '')).digest('hex');
    const voiceAttachment = attachments.find(isVoiceAttachment) ?? null;
    const inputKind = voiceAttachment ? 'voice' : 'text';
    const fresh = logInbound(this.db, { id: messageKey, kind, convId: id, msgId: messageId ?? null, inputKind, text, createdMs: this.now(), author: memberId });
    if (!fresh) return { duplicate: true };
    return { kind, id, messageId, text, attachments, atMe, memberId, mentionOthers, mentionAll, messageKey, voiceAttachment, inputKind };
  }

  // ── ② identify ───────────────────────────────────────────────────────
  async identify(ctx) {
    const { kind, id, messageId, text, inputKind, messageKey, memberId } = ctx;
    const senderPeer = peer(this.db, kind, id);
    const interaction = interactionEvent({
      channel: 'qq', conversationKind: kind === 'group' ? 'group' : 'direct',
      conversationId: id, senderId: memberId ?? id,
      senderRole: kind === 'group' ? 'member'
        : senderPeer?.role === 'owner' && senderPeer.enabled && senderPeer.autoReply ? 'owner' : 'friend',
      text, inputKind, sourceEventId: messageId ?? messageKey,
      occurredAt: new Date(this.now()),
    });
    try { recordAgentEvent(this.db, { id: `${messageKey}:in`, eventType: 'message_received', channel: 'qq', conversationId: id, actor: memberId ?? id, traceId: interaction.trace_id, payload: { trace_id: interaction.trace_id, kind, input_kind: inputKind, text_length: String(text).length, preview: clipText(text), message_id: String(messageId ?? '') }, privacyScope: interaction.trust.source_class, dedupeKey: `${interaction.event_id}:in` }); } catch {}
    if (this.memory) try { recordDailyMessage(this.memory, { channel: 'qq', conversationKind: kind, peerId: id, speaker: kind === 'group' ? memberId : interaction.sender.role, inputKind, role: 'user', content: text, messageId: String(messageId ?? messageKey), privacyScope: interaction.trust.source_class, importance: kind === 'group' ? 0.25 : 0.6, at: new Date(this.now()) }); } catch {}
    try { await this.flushOutbox(kind, id, messageId); } catch {}

    ctx.senderPeer = senderPeer;
    ctx.allowed = senderPeer;
    ctx.interaction = interaction;
    ctx.pending = latestPendingTask(this.db, kind, id);
    ctx.canApprove = evaluatePolicy(interaction, 'task.approve').allowed;
    ctx.canPropose = evaluatePolicy(interaction, 'task.propose').allowed;
    ctx.canReadMemory = evaluatePolicy(interaction, 'memory.read.owner').allowed;
    ctx.canWriteMemory = evaluatePolicy(interaction, 'memory.write.owner').allowed;
  }

  // ── ③ route ──────────────────────────────────────────────────────────
  async route(ctx) {
    const { kind, id, messageId, text, messageKey, interaction, pending, canApprove, canPropose, canReadMemory, allowed, atMe, mentionOthers, mentionAll } = ctx;
    const decision = routePolicy(text, {
      kind,
      hasPlanner: Boolean(this.planner),
      pendingTask: pending,
      canApprove,
      canPropose,
      canReadMemory,
      allowed,
      atMe,
      mentionOthers,
      mentionAll,
    });

    // 路由是决策回路的第一道岔口，把它记下来：哪句话被当成了同意/拒绝/命令，
    // 事后才能回答「它为什么没听懂」——以前这类问题只能靠猜。
    try {
      recordAgentEvent(this.db, {
        eventType: 'route_decision',
        channel: 'qq',
        conversationId: `${kind}:${id}`,
        actor: 'router',
        payload: { route: decision.route, text_length: String(text ?? '').length, has_pending: Boolean(pending) },
        dedupeKey: `route:${messageKey}`,
      });
    } catch { /* 埋点失败不能影响回复 */ }

    switch (decision.route) {
      case ROUTES.decline: {
        cancelTask(this.db, pending.id, this.now(), '爸爸在看板上把这条作废了');
        const ops = (taskPayload(pending)?.operations ?? []).join('、') || '刚才那件事';
        learnLesson(this.home, `爸爸否掉了「${ops}」的提案，先问清楚要什么再提，别自作主张。`, 'decline');
        const reply = '好，那我不动了，刚才那个任务已经作废。';
        await this.sendTextSafe(kind, id, reply, messageId);
        updateMessage(this.db, messageKey, { status: 'sent', reply, delivery_kind: 'text' });
        return { task_id: pending.id, status: 'cancelled' };
      }
      case ROUTES.revise: {
        let prepared = {};
        try { prepared = JSON.parse(pending.result ?? '{}') ?? {}; } catch { prepared = {}; }
        if (prepared?.stage === 'draft' && prepared.draftFile) {
          const draft = JSON.parse(readFileSync(prepared.draftFile, 'utf8'));
          const field = decision.args.field;
          if (field === 'topics') {
            draft.topics = decision.args.value.split(/[\s,，]+/u).filter(Boolean).map((tag) => (tag.startsWith('#') ? tag : `#${tag}`));
          } else {
            draft[field] = decision.args.value;
          }
          writeFileSync(prepared.draftFile, JSON.stringify(draft, null, 2));
          this.db.prepare('UPDATE external_tasks SET result=?, updated_ms=? WHERE id=?').run(JSON.stringify({ ...prepared, ...draft }), this.now(), pending.id);
          const review = formatDraftReview(draft);
          await this.sendTextSafe(kind, id, review, messageId);
          await this.sendPreparedImage(kind, id, draft);
          updateMessage(this.db, messageKey, { status: 'sent', reply: review, delivery_kind: 'text' });
          return { task_id: pending.id, status: 'revised' };
        }
        const hint = '这条还没到可改的阶段，我先不动了。';
        await this.sendTextSafe(kind, id, hint, messageId);
        updateMessage(this.db, messageKey, { status: 'sent', reply: hint, delivery_kind: 'text' });
        return { held: true, error: 'not_a_draft' };
      }
      case ROUTES.approve:
        return this.approveTask(pending, { kind, id, messageId, event: interaction });
      case ROUTES.learning_list: {
        const reply = learningText(this.db);
        await this.sendTextSafe(kind, id, reply, messageId);
        updateMessage(this.db, messageKey, { status: 'sent', reply, delivery_kind: 'text' });
        return { command: 'learning_list' };
      }
      case ROUTES.learning_approve: {
        let reply = '没找到这条提案，可能已经被处理过啦。';
        try {
          const result = approveLearning(this.db, decision.token, { root: this.root, home: this.home, now: this.now() });
          if (result.ok) reply = `好，我把「${result.skillId}」升到 v${result.to}，改法记进经验本了：${result.lesson}`;
          else if (result.error === 'needs_repeat') reply = '这条只出现过一次，再攒一次失败我才有底气改。';
          else if (result.error === 'verified_successful_run_required') reply = '这个技能还没有一次「验证通过」的成功记录，不能拿它当证据，先别改。';
        } catch (error) { reply = `没改成：${String(error?.message ?? error).slice(0, 80)}`; }
        await this.sendTextSafe(kind, id, reply, messageId);
        updateMessage(this.db, messageKey, { status: 'sent', reply, delivery_kind: 'text' });
        return { command: 'learning_approve', token: decision.token };
      }
      case ROUTES.learning_reject: {
        const result = rejectLearning(this.db, decision.token);
        const reply = result.ok ? '好，这条先不改，我接着观察。' : '没找到这条提案。';
        await this.sendTextSafe(kind, id, reply, messageId);
        updateMessage(this.db, messageKey, { status: 'sent', reply, delivery_kind: 'text' });
        return { command: 'learning_reject', token: decision.token };
      }
      case ROUTES.external_intent: {
        const intent = decision.intent;
        const task = proposeTask(this.db, { kind, convId: id, sourceMessageId: messageId, intent, proposerPeerId: ctx.memberId, now: this.now() });
        const names = intent.operations.map((name) => (name === 'douyin.reply_comments' ? '回复新评论' : '给相关评论点赞'));
        const reply = `爸爸，我识别到两个动作：${names.join('、')}。这会操作抖音账号。要现在执行吗？任务编号：${task.id}`;
        await this.sendTextSafe(kind, id, reply, messageId);
        updateMessage(this.db, messageKey, { status: 'sent', reply, delivery_kind: 'text' });
        return { task_id: task.id, status: 'awaiting_confirmation' };
      }
      case ROUTES.hold: {
        if (decision.reason === 'memory_scope_denied') {
          const reply = '这项记忆操作只能在爸爸的私聊里使用。';
          await this.sendTextSafe(kind, id, reply, messageId);
          updateMessage(this.db, messageKey, { status: 'sent', reply, delivery_kind: 'text' });
          return { held: true, error: 'memory_scope_denied' };
        }
        updateMessage(this.db, messageKey, { status: 'held', error: 'peer_not_allowed' });
        return { held: true };
      }
      case ROUTES.ignore: {
        // ambient_skip 只是「默认不插话」，爸爸点名了或者聊得正热还是要接。
        if (decision.reason === 'ambient_skip' && this.shouldJoinAmbient(kind, id, text)) return null;
        updateMessage(this.db, messageKey, { status: 'ignored', error: decision.reason });
        return { ignored: decision.reason };
      }
      case ROUTES.command: {
        const result = await this.runCommand(ctx, decision.command, decision.args ?? {});
        if (result) return result;
        return null;
      }
      default:
        return null;
    }
  }

  /** 斜杠命令。返回 null 表示「这条命令当前环境不支持」，继续走聊天。 */
  async runCommand(ctx, command, args = {}) {
    const { kind, id, messageId, messageKey } = ctx;
    if (command === 'call_start') {
      this.calls.start(kind, id);
      await this.sendTextSafe(kind, id, CALL_HELP, messageId);
      updateMessage(this.db, messageKey, { status: 'sent', delivery_kind: 'text' });
      return { command: 'call_start' };
    }
    if (command === 'call_end') {
      const ended = this.calls.end(kind, id);
      await this.sendTextSafe(kind, id, ended ? HANGUP_HELP : '当前没有进行中的通话。', messageId);
      updateMessage(this.db, messageKey, { status: 'sent', delivery_kind: 'text' });
      return { command: 'call_end', ended };
    }
    if (command === 'voice_toggle') {
      const enabled = Boolean(args.enabled);
      savePeer(this.db, { kind, id, enabled: true, autoReply: true, voiceReply: enabled });
      await this.sendTextSafe(kind, id, enabled ? '语音回复已开启。' : '语音回复已关闭，改为文字回复。', messageId);
      updateMessage(this.db, messageKey, { status: 'sent', delivery_kind: 'text' });
      return { command: 'voice_toggle', enabled };
    }
    if (!this.memory) return null;
    if (command === 'memory_list') {
      await this.sendTextSafe(kind, id, formatMemoryList(listMemories(this.memory, 10)), messageId);
      updateMessage(this.db, messageKey, { status: 'sent', delivery_kind: 'text' });
      return { command: 'memory_list' };
    }
    if (command === 'memory_save') {
      const row = rememberText(this.memory, args.content);
      await this.sendTextSafe(kind, id, row ? `记住了 #${row.id}：${row.content}` : '这句不方便记（涉及隐私内容），我跳过啦。', messageId);
      updateMessage(this.db, messageKey, { status: 'sent', delivery_kind: 'text' });
      return { command: 'memory_save', id: row?.id ?? null };
    }
    if (command === 'memory_revise') {
      try {
        const result = reviseMemory(this.memory, Number(args.id), args.content);
        await this.sendTextSafe(kind, id, result.changed ? `已改成：${args.content.trim()}` : '内容和原来一样，没有改动。', messageId);
      } catch (error) {
        await this.sendTextSafe(kind, id, `没改成：${error.message}`, messageId);
      }
      updateMessage(this.db, messageKey, { status: 'sent', delivery_kind: 'text' });
      return { command: 'memory_revise' };
    }
    if (command === 'memory_forget') {
      const result = forgetMemory(this.memory, Number(args.id));
      await this.sendTextSafe(kind, id, result ? `已经忘掉 #${args.id} 了。` : `没有找到 #${args.id}。`, messageId);
      updateMessage(this.db, messageKey, { status: 'sent', delivery_kind: 'text' });
      return { command: 'memory_forget' };
    }
    return null;
  }

  // ── ④ plan ───────────────────────────────────────────────────────────
  async plan(ctx) {
    const { kind, id, messageId, messageKey, allowed, voiceAttachment, inputKind, memberId } = ctx;
    let spoken = ctx.text;
    if (inputKind === 'voice') {
      updateMessage(this.db, messageKey, { status: 'transcribing' });
      try {
        const bytes = await this.download(voiceAttachment.url);
        const transcript = await this.voice.transcribeBytes(messageKey, bytes);
        spoken = transcript.text;
        updateMessage(this.db, messageKey, { text: spoken });
      } catch (error) {
        updateMessage(this.db, messageKey, { status: 'failed', error: 'voice_recognition_failed' });
        await this.sendTextSafe(kind, id, '这段语音我暂时没听清，请再说一次或改发文字。', messageId);
        return { result: { error: 'voice_recognition_failed' } };
      }
    }
    if (!spoken || !spoken.trim()) { updateMessage(this.db, messageKey, { status: 'held', error: 'empty_message' }); return { result: { held: true } }; }

    const speaker = kind === 'group' ? memberLabel(this.db, kind, id, memberId, this.now()) : (allowed.label || '联系人');
    const label = allowed.label || (kind === 'group' ? '群里' : '联系人');
    this.publish(`qq:${messageKey}:in`, { phase: 'start', message: `${kind === 'group' ? speaker : label}：${spoken.trim().slice(0, 40)}` });

    const day = dayKey(this.now());
    if (!reserve(this.db, day, 'model_calls', DAILY_MODEL_CALLS)) {
      updateMessage(this.db, messageKey, { status: 'held', error: 'daily_model_budget' });
      await this.sendTextSafe(kind, id, '今天已经说了好多话，明天再聊吧。', messageId);
      return { result: { held: true, error: 'daily_model_budget' } };
    }
    updateMessage(this.db, messageKey, { status: 'drafting' });

    let plan = null;
    let facts = '';
    let toolFailures = [];
    let writeOps = null;
    let promisesAction = false;
    let history = [];
    let today = '';
    let memories = [];
    let lessons = [];
    let traces = [];
    let capabilityBlock = '';
    let accountId = String(this.api?.appId ?? 'qq');
    try {
      const rawHistory = kind === 'group' ? groupContext(this.db, id, messageKey) : conversationHistory(this.db, kind, id);
      // 历史里系统自己的确认话术会被模型模仿（它会照抄「任务编号：task_…」然后自己编一个），喂回模型前先滤掉。
      history = (rawHistory ?? []).filter((turn) => !(turn?.role === 'assistant' && /任务编号：|这会操作抖音账号|任务我已经存好了|我识别到/u.test(String(turn?.content ?? ''))));
      const ownerPrivate = ctx.canReadMemory;
      today = this.memory && ownerPrivate ? todayDigest(this.memory) : '';
      memories = this.memory && ownerPrivate ? memoryNotes(this.memory, spoken, 8) : [];
      lessons = ownerPrivate ? lessonsFor(this.home, spoken) : [];
      // 情景记忆：同类任务最近几次成没成。只读、只给结论，失败过的换个做法。
      traces = ownerPrivate ? similarTraces(this.db, { operations: operationHints(spoken), limit: 3, now: this.now() }) : [];
      capabilityBlock = ownerPrivate ? [capabilityIndex(), capabilityHints(spoken)].filter(Boolean).join('\n\n') : '';
      // 决策脑：先让模型判断「要不要查东西」并给出计划，只读工具直接执行，事实回灌给它组织答案。
      if (this.planner && ownerPrivate) {
        try { plan = await this.planner({ text: spoken, history, memories, today, kind, peerId: id, accountId, messageId, catalog: this.catalog, lessons, traces, capabilities: capabilityBlock }); }
        catch (error) { this.log({ qq: { planner_failed: String(error?.message ?? error).slice(0, 120) } }); }
      }
      // 模型有时嘴上说「这就去看」却一个工具都不给，结果什么都没发生。让它带着这句提醒重规划一次。
      promisesAction = /这就去|这就查|去查|去看|去看一遍|马上|稍等|我看看/u.test(String(plan?.say ?? ''));
      if (plan && !plan.steps?.length && promisesAction) {
        try {
          const retry = await this.planner({ text: `${spoken}\n（你刚说要去做，但 steps 是空的；请把真正要用的工具放进 steps）`, history, memories, today, kind, peerId: id, accountId, messageId, catalog: this.catalog, lessons, traces, capabilities: capabilityBlock });
          if (retry?.steps?.length) plan = retry;
        } catch { /* 重规划失败就按原计划走 */ }
      }
      // 爸爸明明说「再发一条作品，主题为X」，模型却只聊不给工具——补一条写计划，别让这句话落空。
      const asksPublish = /(?:再发|发|发布|写)(?:一)?(?:条|个|篇)(?:新的?)?(?:作品|图文|日常)/u.test(spoken)
        || /再发一条|再发个|发一条图文|发个图文/u.test(spoken);
      if (plan && !plan.steps?.some((step) => WRITE_TOOL_NAMES.has(step.tool)) && asksPublish && !/取消|别发|不发|哪些|几个|多少|什么/u.test(spoken)) {
        const theme = themeFromText(spoken);
        plan = { ...plan, steps: [{ tool: 'douyin.publish', args: theme ? { theme } : {}, write: true }] };
      }
      if (plan?.steps?.length) {
        const readSteps = plan.steps.filter((step) => !WRITE_TOOL_NAMES.has(step.tool));
        const writeSteps = plan.steps.filter((step) => WRITE_TOOL_NAMES.has(step.tool));
        if (readSteps.length) {
          const results = [];
          for (const step of readSteps) results.push(await runTool(step, { ...this.toolCtx, ownerPrivate }));
          facts = factsText(results);
          toolFailures = failedResults(results);
          this.log({ qq: { planner_tools: readSteps.map((step) => step.tool).join(',') } });

          // 只读步骤失手了，就带着「哪一步、错在哪」重新想一次（只重规划一次）。
          // 写操作绝不在这里重试——那是要人点头的事，副作用不能自动重放。
          if (toolFailures.length && !writeSteps.length) {
            try {
              const retry = await this.planner({
                text: `${spoken}\n（上一轮这些查法失败了：${toolFailures.map((row) => `${row.tool}: ${String(row.error ?? row.status ?? row.text ?? '未知错误').slice(0, 80)}`).join('；')}。换一种查法，别重复同样的调用；确实查不到就直接说查不到，不要编。）`,
                history, memories, today, kind, peerId: id, accountId, messageId, catalog: this.catalog, lessons, traces, capabilities: capabilityBlock,
              });
              const retryReads = (retry?.steps ?? []).filter((step) => !WRITE_TOOL_NAMES.has(step.tool));
              if (retryReads.length) {
                const retryResults = [];
                for (const step of retryReads) retryResults.push(await runTool(step, { ...this.toolCtx, ownerPrivate }));
                const retryFailures = failedResults(retryResults);
                // 第二轮只要有一点新东西就用它，全挂就保留第一轮的事实（至少不会更差）。
                if (retryResults.some((row) => row?.ok !== false)) {
                  facts = factsText(retryResults);
                  toolFailures = retryFailures;
                  plan = { ...retry, steps: [...retryReads] };
                }
                try {
                  recordAgentEvent(this.db, {
                    eventType: 'replan_requested',
                    channel: 'qq',
                    conversationId: `${kind}:${id}`,
                    actor: 'planner',
                    payload: { failed: toolFailures.map((row) => String(row.tool).slice(0, 40)), retried: retryReads.map((step) => step.tool), text_length: String(spoken ?? '').length },
                    dedupeKey: `replan:${messageKey}`,
                  });
                } catch { /* 埋点失败不影响回答 */ }
                this.log({ qq: { replan: retryReads.map((step) => step.tool).join(',') } });
              }
            } catch { /* 重规划失败就按第一次的结果回答 */ }
          }
        }
        if (writeSteps.length) {
          const operations = [...new Set(writeSteps.map((step) => step.tool))];
          // 爸爸自己点了主题（「主题为BLG夺冠」）就照他的来，别再随机挑一个。
          const publishStep = writeSteps.find((step) => step.tool === 'douyin.publish');
          const requestedTheme = sanitizeTheme(publishStep?.args?.theme) || themeFromText(spoken);
          const theme = operations.includes('douyin.publish') ? (requestedTheme || pickTheme()) : null;
          if (publishStep && theme) publishStep.args = { ...(publishStep.args ?? {}), theme };
          writeOps = { operations, theme, steps: plan.steps };
        }
      }
    } catch (error) {
      updateMessage(this.db, messageKey, { status: 'failed', error: 'model_failed' });
      return { result: { error: 'model_failed' } };
    }

    ctx.spoken = spoken;
    ctx.speaker = speaker;
    ctx.label = label;
    ctx.day = day;
    return { plan, facts, toolFailures, writeOps, promisesAction, spoken, speaker, label, day, history, today, memories, lessons, traces, capabilityBlock, accountId };
  }

  // ── ⑤ execute ────────────────────────────────────────────────────────
  // 名字带 Plan：构造函数里的 this.execute 是「执行一个平台动作」的函数，
  // 不能和这一步的方法重名，否则实例属性会把方法盖掉。
  async executePlan(ctx, planned) {
    const { kind, id, messageId, messageKey, canPropose } = ctx;
    const { plan, facts, toolFailures, writeOps, promisesAction, spoken, speaker, history, today, memories, lessons, capabilityBlock, accountId, inputKind } = planned;
    let reply = '';
    try {
      let notice = '';
      if (writeOps?.operations?.length) {
        // 同一会话里只留最新的那条待确认，旧的自动作废，免得「同意」时不知道批的是哪条。
        for (const stale of this.db.prepare("SELECT id FROM external_tasks WHERE conv_kind=? AND conv_id=? AND status='awaiting_confirmation'").all(kind, id)) {
          cancelTask(this.db, stale.id, this.now(), '同一会话又发了新的，旧任务自动作废');
        }
        const plannedIntent = normalizeIntent({
          intent: 'external_action_request',
          operations: writeOps.operations,
          target: 'user_requested',
          requires_confirmation: true,
          plan: writeOps.steps,
          ...(writeOps.theme ? { theme: writeOps.theme } : {}),
        });
        const task = proposeTask(this.db, { kind, convId: id, sourceMessageId: messageId, intent: plannedIntent, proposerPeerId: id, now: this.now() });
        // 回执文案按操作种类说清楚，别让「打电话」也回一句「这会操作抖音账号」。
        const CALL_NOTICE = Object.freeze({
          'qq.call': '要我现在给爸爸（QQ 七海）拨过去吗？回「同意」我就拨，接通后我说话。',
          'qq.call_mom': '要我现在给妈妈（QQ 小朋友）拨过去吗？回「同意」我就拨，接通后我说话。',
          'wechat.call': '要我现在用微信给妈妈拨过去吗？回「同意」我就拨，接通后我说话。',
          'qq.hangup': '现在要挂断这通 QQ 通话吗？回「同意」我就挂。',
        });
        const callNotices = writeOps.operations.map((name) => CALL_NOTICE[name]).filter(Boolean);
        notice = writeOps.theme
          ? `\n\n我想发一条「${writeOps.theme}」的图文，回「同意」我就开始写，写完把标题、话题、配图和三项设置发你先审。`
          : callNotices.length && writeOps.operations.length === callNotices.length
            ? `\n\n${callNotices.join(' ')}`
            : `\n\n这会操作抖音账号，任务我已经存好了（${String(task.id).slice(0, 17)}），回「同意」我再执行。`;
        this.log({ qq: { planned_task: writeOps.operations.join(',') } });
      }
      const askBrain = () => this.ask({
        kind, id, peer: ctx.allowed, accountId, messageId, text: spoken, history, inputKind,
        speaker, atMe: ctx.atMe, mentionOthers: ctx.mentionOthers,
        voiceCapabilities: this.voice?.status?.(), today, memories, facts, lessons, capabilities: capabilityBlock,
      });
      if (notice) {
        // 模型爱抢答「标题走《…》、三项设置…」，那是没做完的活儿，别让它替审稿结论先斩后奏。
        const say = String(plan?.say ?? '')
          .split(/(?<=[。！？])/u)
          .filter((sentence) => !/《|三项设置|标题走|话题带/u.test(sentence))
          .join('')
          .trim();
        reply = `${say}${notice}`.trim();
      } else if (plan && !plan.steps?.length && plan.say && promisesAction) {
        // 说了要做又没工具可跑：别让它空口承诺，老实说清楚。
        reply = '这件事我得真去手机上操作，可现在我这边没法直接动手机，先别信我口头答应。要不我先查查库里的记录？';
      } else {
        reply = plan && !plan.steps?.length && plan.say ? plan.say : await askBrain();
      }
      // 工具明确失败/被弹窗挡住时，不允许模型把话说成「看过了、没新评论」。
      if (toolFailures.length) reply = failureReply(toolFailures);
      // 数据已经在手里了，模型要是还只回「我去看/等结果」，就用事实兜底，别让爸爸等一个不存在的回执。
      if (facts && !toolFailures.length) {
        const promises = /这就|去(?:抖音)?(?:看|查|翻)|等结果|等下|稍等|马上|回执/u.test(reply);
        if (promises && !/\d/u.test(reply)) reply = `我刚看过手机了：${factsDigest(facts)}`;
        else if (!/\d/u.test(reply)) reply = `${reply.trim()}\n${factsDigest(facts)}`;
      }
      if (typeof reply !== 'string' || !reply.trim()) throw new Error('empty_reply');
      reply = reply.trim().slice(0, 1200);
    } catch (error) {
      updateMessage(this.db, messageKey, { status: 'failed', error: 'model_failed' });
      return { result: { error: 'model_failed' } };
    }

    // 旧标记通道收口：有决策脑时写操作已经由 planner 建任务，[DO:...] 标记不再重复建任务。
    const wantsHangup = /\[HANGUP\]/i.test(reply);
    if (wantsHangup) reply = reply.replace(/\[HANGUP\]/giu, '').trim();
    const actions = this.planner && kind === 'c2c' ? [] : actionMarkerNames(reply);
    if (wantsHangup) actions.push('qq.hangup');
    // 标记一律从正文里剥掉：留在消息里会变成「[DO:xxx」这种漏字，爸爸看着像卡住了。
    reply = stripActionMarkers(reply);
    if (kind === 'group' && actions.length) {
      // Phase 0 safety freeze: keep group chat conversational and never execute
      // external actions from a group, including legacy [DO:...] markers.
      reply = `${reply} 群聊里的外部操作目前已暂停，请爸爸私聊确认。`;
      actions.length = 0;
    }
    if (kind === 'c2c' && canPropose && actions.length) {
      const theme = actions.includes('douyin.publish') ? pickTheme() : null;
      const intent = normalizeIntent({
        intent: 'external_action_request',
        operations: [...actions],
        target: 'user_requested',
        requires_confirmation: true,
        ...(theme ? { theme } : {}),
      });
      const task = proposeTask(this.db, { kind, convId: id, sourceMessageId: messageId, intent, proposerPeerId: id, now: this.now() });
      reply = theme
        ? `${reply}\n\n我想发一条「${theme}」的图文。回「同意」我就开始写，写完把主题、话题、配图和三项设置发你先审。`
        : `${reply} 外部操作已创建待确认任务 ${task.id}，回复“同意”后才会执行。`;
      actions.length = 0;
    }
    updateMessage(this.db, messageKey, { status: 'ready', reply });
    return { reply, actions };
  }

  // ── ⑥ deliver ────────────────────────────────────────────────────────
  async deliver(ctx, executed) {
    const { kind, id, messageId, messageKey, interaction, spoken, speaker, day, canWriteMemory, allowed, inputKind } = ctx;
    const reply = executed.reply;
    const actions = executed.actions ?? [];
    if (this.memory) {
      try { recordDailyMessage(this.memory, { channel: 'qq', conversationKind: kind, peerId: id, speaker: kind === 'group' ? speaker : interaction.sender.role, inputKind, role: 'assistant', content: reply, messageId: `${messageKey}:reply`, privacyScope: interaction.trust.source_class, importance: kind === 'group' ? 0.25 : 0.6, at: new Date(this.now()) }); } catch {}
    }
    if (this.memory && canWriteMemory) {
      try { rememberExchange(this.memory, spoken, reply); } catch {}
      try { captureExchange(this.memory, spoken, reply, { source: kind === 'group' ? 'qq_group' : 'qq' }); } catch {}
    }
    this.publish(`qq:${messageKey}:out`, { phase: 'done', message: `大肥鱼：${reply.slice(0, 40)}` });

    const inCall = Boolean(this.calls.active(kind, id));
    const wantVoice = Boolean(this.voice) && (inCall || (inputKind === 'voice' && allowed.voiceReply));
    if (wantVoice) {
      let voiceDeliveryStarted = false;
      updateMessage(this.db, messageKey, { status: 'synthesizing' });
      try {
        if (!reserve(this.db, day, 'voice_requests', DAILY_VOICE_REQUESTS)) throw new Error('daily_voice_budget');
        const audio = await this.voice.synthesize(messageKey, reply);
        updateMessage(this.db, messageKey, { status: 'sending' });
        voiceDeliveryStarted = true;
        await this.sendVoiceSafe(kind, id, audio.silk, messageId);
        updateMessage(this.db, messageKey, { status: 'sent', delivery_kind: 'voice', audio_duration_ms: audio.duration_ms });
        try { recordAgentEvent(this.db, { id: `${messageKey}:out`, eventType: 'message_replied', channel: 'qq', conversationId: id, actor: 'assistant', traceId: interaction.trace_id, payload: { trace_id: interaction.trace_id, kind, delivery_kind: 'voice', preview: clipText(reply) }, result: { ok: true }, privacyScope: interaction.trust.source_class, dedupeKey: `${interaction.event_id}:out` }); } catch {}
        if (inCall) this.calls.touch(kind, id);
        return { replied: 'voice', duration_ms: audio.duration_ms };
      } catch (error) {
        if (voiceDeliveryStarted) {
          updateMessage(this.db, messageKey, { status: 'unknown', error: 'voice_delivery_not_confirmed' });
          try { recordAgentEvent(this.db, { id: `${messageKey}:out`, eventType: 'observation_created', channel: 'qq', conversationId: id, actor: 'assistant', traceId: interaction.trace_id, payload: { trace_id: interaction.trace_id, kind, delivery_kind: 'voice' }, result: { status: 'unknown', reason: 'delivery_not_confirmed' }, privacyScope: interaction.trust.source_class, dedupeKey: `${interaction.event_id}:out` }); } catch {}
          return { error: 'voice_delivery_not_confirmed' };
        }
        updateMessage(this.db, messageKey, { error: `voice_reply_failed:${error.message}` });
      }
    }
    try {
      await this.api.sendText({ kind, id, content: reply, msgId: messageId });
      updateMessage(this.db, messageKey, { status: 'sent', delivery_kind: 'text' });
      try { recordAgentEvent(this.db, { id: `${messageKey}:out`, eventType: 'message_replied', channel: 'qq', conversationId: id, actor: 'assistant', traceId: interaction.trace_id, payload: { trace_id: interaction.trace_id, kind, delivery_kind: 'text', preview: clipText(reply) }, result: { ok: true }, privacyScope: interaction.trust.source_class, dedupeKey: `${interaction.event_id}:out` }); } catch {}
      if (inCall) this.calls.touch(kind, id);
      return { replied: 'text', actions };
    } catch (error) {
      updateMessage(this.db, messageKey, { status: 'unknown', error: 'delivery_not_confirmed' });
      try { recordAgentEvent(this.db, { id: `${messageKey}:out`, eventType: 'observation_created', channel: 'qq', conversationId: id, actor: 'assistant', traceId: interaction.trace_id, payload: { trace_id: interaction.trace_id, kind, delivery_kind: 'text' }, result: { status: 'unknown', reason: 'delivery_not_confirmed' }, privacyScope: interaction.trust.source_class, dedupeKey: `${interaction.event_id}:out` }); } catch {}
      return { error: 'delivery_not_confirmed' };
    }
  }

  sweep() {
    for (const expired of this.calls.sweep()) this.sendTextSafe(expired.kind, expired.id, '通话超时，已自动挂断。');
    try { this.reportFinishedTasks(); } catch {}
  }

  /** 群里被 QQ 挡住的主动消息：等这个会话下一条消息进来，借被动窗口补发。 */
  async flushOutbox(kind, id, messageId) {
    const rows = pendingOutbox(this.db, kind, id);
    for (const row of rows) {
      const ok = await this.sendTextSafe(kind, id, row.text, messageId);
      if (!ok) break;
      markOutboxSent(this.db, row.id, this.now());
    }
    return rows.length;
  }

  /** 任务收尾统一向爸爸汇报：谁跑了任务都得回一句，不能悄悄结束。 */
  markReported(taskId) {
    try {
      recordAgentEvent(this.db, { eventType: 'task_reported', channel: 'qq', taskId: String(taskId), actor: 'assistant', payload: { reported: true }, dedupeKey: `task:${taskId}:reported` });
    } catch {}
  }

  reportFinishedTasks(sinceMs = 15 * 60 * 1000) {
    const rows = this.db.prepare(
      "SELECT id, conv_kind, conv_id, status, result, updated_ms FROM external_tasks WHERE status IN ('succeeded','failed') AND updated_ms >= ? ORDER BY updated_ms ASC LIMIT 5",
    ).all(this.now() - sinceMs);
    for (const row of rows) {
      const seen = this.db.prepare('SELECT 1 FROM agent_events WHERE dedupe_key = ?').get(`task:${row.id}:reported`);
      if (seen) continue;
      const detail = formatTaskDetail(row.result);
      const text = row.status === 'succeeded'
        ? `任务办完了 ✅ ${detail}`
        : `任务没办成 ❌ ${detail}`;
      this.sendTextSafe(row.conv_kind, row.conv_id, text, null);
      this.markReported(row.id);
    }
  }

  messages(limit = 20) { return recentMessages(this.db, limit); }

  row(id) { return messageRow(this.db, id); }
}
