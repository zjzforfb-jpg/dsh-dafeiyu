import { createHash } from 'node:crypto';
import { forgetMemory, reviseMemory } from '../../brain/memory.mjs';
import { publishDesktopActivity } from '../../desktop/activity.mjs';
import { CallSessions } from './call.mjs';
import { isVoiceAttachment, QqGateway } from './gateway.mjs';
import { formatMemoryList, listMemories, memoryNotes, rememberExchange, rememberText } from './memory.mjs';
import { captureExchange, todayDigest } from '../memory-hub.mjs';
import { actionMarkerNames, stripActionMarkers, runAction } from '../actions.mjs';
import { ensureBinaries } from '../macui/index.mjs';
import { hangup as hangupQqCall } from '../macui/qq.mjs';
import { approveTask, completeTask, initTasks, latestPendingTask, parseExternalIntent, proposeTask, startTask, taskPayload } from '../tasks.mjs';
import { createReceipt } from '../receipts.mjs';
import { recordDailyExchange, recordDailyMessage } from '../daily-memory.mjs';
import { join } from 'node:path';
import { conversationHistory, dayKey, groupTranscript, initQq, logInbound, memberLabel, messageRow, peer, peers, recentMessages, reserve, savePeer, updateMessage, usage } from './store.mjs';

const MAX_DOWNLOAD = 10 * 1024 * 1024;
const DAILY_MODEL_CALLS = 50;
const DAILY_VOICE_REQUESTS = 50;

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

export class QqService {
  constructor({ db, voice, api, ask, WebSocketImpl, gateway, memory = null, home = null, petPort = 3108, log = () => {}, now = () => Date.now(), callTimeoutMs = 60000, downloadImpl = fetch, groupReplyRate = 0.08, groupCooldownMs = 90000, groupNameCooldownMs = 25000, random = Math.random }) {
    this.root = home ? join(home, '..', '..') : process.cwd();
    initQq(db);
    initTasks(db);
    Object.assign(this, { db, voice, api, ask, log, now, downloadImpl, memory, home, petPort, groupReplyRate, groupCooldownMs, groupNameCooldownMs, random, messageUrl: null });
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

  async handle(event) {
    const { kind, id, messageId, text = '', attachments = [], atMe = kind !== 'group', memberId = null, mentionOthers = false, mentionAll = false } = event;
    const messageKey = createHash('sha256').update(String(messageId ?? '')).digest('hex');
    const voiceAttachment = attachments.find(isVoiceAttachment) ?? null;
    const inputKind = voiceAttachment ? 'voice' : 'text';
    if (!logInbound(this.db, { id: messageKey, kind, convId: id, msgId: messageId ?? null, inputKind, text, createdMs: this.now(), author: memberId })) return { duplicate: true };
    if(this.memory)try{recordDailyMessage(this.memory,{channel:'qq',conversationKind:kind,peerId:id,speaker:kind==='group'?memberId:null,inputKind,role:'user',content:text,messageId:String(messageId??messageKey),privacyScope:kind==='group'?'group':'private',importance:kind==='group'?0.25:0.6,at:new Date(this.now())});}catch{}

    // External actions are planned outside the chat model. A bare acknowledgement
    // never executes a platform action; only an explicit confirmation can approve it.
    const pending = latestPendingTask(this.db, kind, id);
    // Group members can propose a task, but only the owner's private chat can approve it.
    if (pending && kind === 'c2c' && allowed.label === '爸爸' && /^(同意|确认|执行|可以|好的|好)$/u.test(String(text).trim())) {
      if (!approveTask(this.db, pending.id, id, this.now())) return { held: true, error: 'task_already_processed' };
      if (!startTask(this.db, pending.id, this.now())) return { held: true, error: 'task_recovery_required' };
      const payload = taskPayload(pending);
      const results=[]; let ok=true;
      for (const name of payload?.operations??[]) {
        const result=await runAction(name,{root:this.root});
        const receipt=createReceipt({operation:name,adapter:'douyin',result});results.push(receipt);if(receipt.status!=='succeeded')ok=false;
      }
      completeTask(this.db,pending.id,{ok,result:results},this.now());
      const receipt=ok?'任务已执行完成，我会按真实回执告诉你结果。':'任务执行未完全成功，我会把失败步骤说明白。';
      await this.sendTextSafe(kind,id,receipt,messageId);
      updateMessage(this.db,messageKey,{status:'sent',reply:receipt,delivery_kind:'text'});
      return {task_id:pending.id,status:ok?'succeeded':'failed'};
    }
    const intent=parseExternalIntent(text);
    if (intent && (kind==='group'||kind==='c2c')) {
      const task=proposeTask(this.db,{kind,convId:id,sourceMessageId:messageId,intent,proposerPeerId:memberId,now:this.now()});
      const names=intent.operations.map(name=>name==='douyin.reply_comments'?'回复新评论':'给相关评论点赞');
      const reply=`爸爸，我识别到两个动作：${names.join('、')}。这会操作抖音账号。要现在执行吗？任务编号：${task.id}`;
      await this.sendTextSafe(kind,id,reply,messageId);
      updateMessage(this.db,messageKey,{status:'sent',reply,delivery_kind:'text'});
      return {task_id:task.id,status:'awaiting_confirmation'};
    }

    const allowed = peer(this.db, kind, id);
    if (!allowed || !allowed.enabled || !allowed.autoReply) { updateMessage(this.db, messageKey, { status: 'held', error: 'peer_not_allowed' }); return { held: true }; }

    // 挂断由模型判断（回复里带 [HANGUP]），不做关键词匹配，避免误挂。

    if (kind === 'group' && mentionOthers) {
      // 只要这条消息里 @ 了别人，就不插嘴（哪怕同时也 @ 了我）
      updateMessage(this.db, messageKey, { status: 'ignored', error: 'addressed_to_others' });
      return { ignored: 'addressed_to_others' };
    }
    if (kind === 'group' && !atMe) {
      // @全体 只有在提到大肥鱼时才接
      if (mentionAll && !/大肥鱼|肥鱼|鱼鱼/u.test(text)) { updateMessage(this.db, messageKey, { status: 'ignored', error: 'mention_all_skip' }); return { ignored: 'mention_all_skip' }; }
      if (!this.shouldJoinAmbient(kind, id, text)) {
        updateMessage(this.db, messageKey, { status: 'ignored', error: 'ambient_skip' });
        return { ignored: 'ambient_skip' };
      }
    }

    const command = text.trim();
    if (/^\/(通话|打电话)/.test(command)) {
      this.calls.start(kind, id);
      await this.sendTextSafe(kind, id, CALL_HELP, messageId);
      updateMessage(this.db, messageKey, { status: 'sent', delivery_kind: 'text' });
      return { command: 'call_start' };
    }
    if (/^\/(挂断|结束通话)/.test(command)) {
      const ended = this.calls.end(kind, id);
      await this.sendTextSafe(kind, id, ended ? HANGUP_HELP : '当前没有进行中的通话。', messageId);
      updateMessage(this.db, messageKey, { status: 'sent', delivery_kind: 'text' });
      return { command: 'call_end', ended };
    }
    if (this.memory && /^\/记忆$/.test(command)) {
      await this.sendTextSafe(kind, id, formatMemoryList(listMemories(this.memory, 10)), messageId);
      updateMessage(this.db, messageKey, { status: 'sent', delivery_kind: 'text' });
      return { command: 'memory_list' };
    }
    const remembered = command.match(/^\/记住[：:，,\s]+(.+)$/u);
    if (this.memory && remembered) {
      const row = rememberText(this.memory, remembered[1]);
      await this.sendTextSafe(kind, id, row ? `记住了 #${row.id}：${row.content}` : '这句不方便记（涉及隐私内容），我跳过啦。', messageId);
      updateMessage(this.db, messageKey, { status: 'sent', delivery_kind: 'text' });
      return { command: 'memory_save', id: row?.id ?? null };
    }
    const corrected = command.match(/^\/更正记忆\s*#?(\d+)[：:，,\s]+(.+)$/u);
    if (this.memory && corrected) {
      try {
        const result = reviseMemory(this.memory, Number(corrected[1]), corrected[2]);
        await this.sendTextSafe(kind, id, result.changed ? `已改成：${corrected[2].trim()}` : '内容和原来一样，没有改动。', messageId);
      } catch (error) {
        await this.sendTextSafe(kind, id, `没改成：${error.message}`, messageId);
      }
      updateMessage(this.db, messageKey, { status: 'sent', delivery_kind: 'text' });
      return { command: 'memory_revise' };
    }
    const forgotten = command.match(/^\/忘记记忆\s*#?(\d+)$/u);
    if (this.memory && forgotten) {
      const result = forgetMemory(this.memory, Number(forgotten[1]));
      await this.sendTextSafe(kind, id, result ? `已经忘掉 #${forgotten[1]} 了。` : `没有找到 #${forgotten[1]}。`, messageId);
      updateMessage(this.db, messageKey, { status: 'sent', delivery_kind: 'text' });
      return { command: 'memory_forget' };
    }
    if (/^\/语音\s*(开|关)$/.test(command)) {
      const enabled = command.endsWith('开');
      savePeer(this.db, { kind, id, enabled: true, autoReply: true, voiceReply: enabled });
      await this.sendTextSafe(kind, id, enabled ? '语音回复已开启。' : '语音回复已关闭，改为文字回复。', messageId);
      updateMessage(this.db, messageKey, { status: 'sent', delivery_kind: 'text' });
      return { command: 'voice_toggle', enabled };
    }

    let spoken = text;
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
        return { error: 'voice_recognition_failed' };
      }
    }
    if (!spoken || !spoken.trim()) { updateMessage(this.db, messageKey, { status: 'held', error: 'empty_message' }); return { held: true }; }

    const speaker = kind === 'group' ? memberLabel(this.db, kind, id, memberId, this.now()) : (allowed.label || '爸爸');
    const label = allowed.label || (kind === 'group' ? '群里' : '爸爸');
    this.publish(`qq:${messageKey}:in`, { phase: 'start', message: `${kind === 'group' ? speaker : label}：${spoken.trim().slice(0, 40)}` });

    const day = dayKey(this.now());
    if (!reserve(this.db, day, 'model_calls', DAILY_MODEL_CALLS)) {
      updateMessage(this.db, messageKey, { status: 'held', error: 'daily_model_budget' });
      await this.sendTextSafe(kind, id, '今天已经说了好多话，明天再聊吧。', messageId);
      return { held: true, error: 'daily_model_budget' };
    }
    updateMessage(this.db, messageKey, { status: 'drafting' });
    let reply;
    try {
      const history = kind === 'group' ? groupContext(this.db, id, messageKey) : conversationHistory(this.db, kind, id);
      reply = await this.ask({ kind, id, peer: allowed, text: spoken, history, inputKind, speaker, atMe, mentionOthers, voiceCapabilities: this.voice?.status?.(), today: this.memory ? todayDigest(this.memory) : '', memories: this.memory ? memoryNotes(this.memory, spoken, 8) : [] });
      if (typeof reply !== 'string' || !reply.trim()) throw new Error('empty_reply');
      reply = reply.trim().slice(0, 1200);
    } catch (error) {
      updateMessage(this.db, messageKey, { status: 'failed', error: 'model_failed' });
      return { error: 'model_failed' };
    }
    const wantsHangup = /\[HANGUP\]/i.test(reply);
    if (wantsHangup) reply = reply.replace(/\[HANGUP\]/giu, '').trim();
    const actions = actionMarkerNames(reply);
    if (wantsHangup) actions.push('qq.hangup');
    if (actions.length) reply = stripActionMarkers(reply);
    if (kind === 'group' && actions.length) {
      // Phase 0 safety freeze: keep group chat conversational and never execute
      // external actions from a group, including legacy [DO:...] markers.
      reply = `${reply} 群聊里的外部操作目前已暂停，请爸爸私聊确认。`;
      actions.length = 0;
    }
    if (kind === 'c2c' && actions.length) {
      const task=proposeTask(this.db,{kind,convId:id,sourceMessageId:messageId,intent:{intent:'external_action_request',operations:[...actions],target:'user_requested',requires_confirmation:true},proposerPeerId:id,now:this.now()});
      reply=`${reply} 外部操作已创建待确认任务 ${task.id}，回复“同意”后才会执行。`;
      actions.length=0;
    }
    updateMessage(this.db, messageKey, { status: 'ready', reply });
    if (this.memory) {
      try { recordDailyMessage(this.memory,{channel:'qq',conversationKind:kind,peerId:id,speaker,inputKind,role:'assistant',content:reply,messageId:`${messageKey}:reply`,privacyScope:kind==='group'?'group':'private',importance:kind==='group'?0.25:0.6,at:new Date(this.now())}); } catch {}
    }
    if (this.memory && kind !== 'group') {
      try { rememberExchange(this.memory, spoken, reply); } catch {}
      try { captureExchange(this.memory, spoken, reply, { source: kind === 'group' ? 'qq_group' : 'qq' }); } catch {}
    }
    this.publish(`qq:${messageKey}:out`, { phase: 'done', message: `大肥鱼：${reply.slice(0, 40)}` });

    const inCall = Boolean(this.calls.active(kind, id));
    const wantVoice = Boolean(this.voice) && (inCall || (inputKind === 'voice' && allowed.voiceReply));
    if (wantVoice) {
      updateMessage(this.db, messageKey, { status: 'synthesizing' });
      try {
        if (!reserve(this.db, day, 'voice_requests', DAILY_VOICE_REQUESTS)) throw new Error('daily_voice_budget');
        const audio = await this.voice.synthesize(messageKey, reply);
        updateMessage(this.db, messageKey, { status: 'sending' });
        await this.sendVoiceSafe(kind, id, audio.silk, messageId);
        updateMessage(this.db, messageKey, { status: 'sent', delivery_kind: 'voice', audio_duration_ms: audio.duration_ms });
        if (inCall) this.calls.touch(kind, id);
        return { replied: 'voice', duration_ms: audio.duration_ms };
      } catch (error) {
        updateMessage(this.db, messageKey, { error: `voice_reply_failed:${error.message}` });
      }
    }
    try {
      await this.api.sendText({ kind, id, content: reply, msgId: messageId });
      updateMessage(this.db, messageKey, { status: 'sent', delivery_kind: 'text' });
      if (inCall) this.calls.touch(kind, id);
      return { replied: 'text', actions };
    } catch (error) {
      updateMessage(this.db, messageKey, { status: 'unknown', error: 'delivery_not_confirmed' });
      return { error: 'delivery_not_confirmed' };
    }
  }

  sweep() {
    for (const expired of this.calls.sweep()) this.sendTextSafe(expired.kind, expired.id, '通话超时，已自动挂断。');
  }

  messages(limit = 20) { return recentMessages(this.db, limit); }

  row(id) { return messageRow(this.db, id); }
}
