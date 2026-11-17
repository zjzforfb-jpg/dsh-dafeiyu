import { ingestUpdates, registerAccount, peerHistory } from './store.mjs';
import { openHub, captureExchange } from '../memory-hub.mjs';
import { actionMarkerNames, stripActionMarkers } from '../actions.mjs';
import { proposeTask } from '../tasks.mjs';
import { recordDailyMessage } from '../daily-memory.mjs';
import { recordAgentEvent } from '../agent-events.mjs';
import { interactionEvent } from '../core-contract.mjs';
import { evaluatePolicy } from '../policy.mjs';
/** 事件里带一行「消息前 80 字」，页面上不点开也能看到说了什么。 */
function clipText(text, max = 80) {
  const flat = String(text ?? '').replace(/\s+/gu, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

import { reserveModelCall, reserveVoiceRequest } from '../core/budget.mjs';

let hubCache = null;
function unifiedHub() {
  if (hubCache) return hubCache;
  try { hubCache = openHub(process.cwd()); } catch { hubCache = null; }
  return hubCache;
}
export class IlinkWorker {
  constructor({ db, accounts, client, ask, voice, now = () => Date.now() }) { Object.assign(this,{db,accounts,client,ask,voice,now}); this.jobs = new Map(); this.stopped=false; }
  start() { this.reconcile(); this.timer=setInterval(()=>this.reconcile(),2000); this.timer.unref(); }
  reconcile() {
    try { this.syncJobs(); } catch { /* Keep the running transport alive if a local store is temporarily unavailable. */ }
  }
  syncJobs() {
    if(this.stopped) return;
    let rows;
    try { rows=this.accounts.list(); } catch { return; }
    for(const a of rows) registerAccount(this.db,a);
    for(const [id,job] of this.jobs) {
      const a=rows.find(a=>a.id===id);
      if(!a || a.bindingId!==job.bindingId || !this.db.prepare('SELECT enabled FROM ilink_accounts WHERE id=?').get(id)?.enabled) job.stop.abort();
    }
    for(const a of rows) {
      const state=this.db.prepare('SELECT * FROM ilink_accounts WHERE id=?').get(a.id);
      if(!state.enabled || state.status==='login_required' || this.jobs.has(a.id)) continue;
      const job={bindingId:a.bindingId,stop:new AbortController()};this.jobs.set(a.id,job);
      job.task=this.run(a,job.stop.signal).catch(()=>{if(!this.stopped)this.db.prepare("UPDATE ilink_accounts SET status='error',last_error='worker_failed' WHERE id=?").run(a.id);}).finally(()=>this.jobs.delete(a.id));
    }
  }
  allowed(a,row) {
    const state=this.db.prepare('SELECT enabled,binding_id FROM ilink_accounts WHERE id=?').get(a.id);
    const p=this.db.prepare('SELECT * FROM ilink_peers WHERE account_id=? AND peer_id=?').get(a.id,row.peer_id);
    return state?.enabled && state.binding_id===a.bindingId && p?.enabled && p.auto_reply ? p : null;
  }
  async drain(a,signal) {
    const rows=this.db.prepare("SELECT * FROM ilink_messages WHERE account_id=? AND binding_id=? AND status IN ('pending','ready') ORDER BY created_ms,rowid LIMIT 10").all(a.id,a.bindingId);
    for(const original of rows) {
      const row={...original};
      if(signal.aborted) return;
      let peer=this.allowed(a,row);
      if(!peer) {this.db.prepare("UPDATE ilink_messages SET status='held' WHERE id=?").run(row.id);continue;}
      const interaction = interactionEvent({
        channel: 'wechat', accountId: a.id, conversationId: row.peer_id,
        senderId: row.peer_id, senderRole: peer.role, text: row.text ?? '',
        inputKind: row.input_kind ?? 'text', sourceEventId: row.upstream_id || row.id,
        occurredAt: new Date(row.created_ms),
      });
      const privacyScope = interaction.trust.source_class;
      try { recordAgentEvent(this.db, { id: `${row.id}:in`, eventType: 'message_received', channel: 'wechat', conversationId: row.peer_id, actor: peer.role === 'owner' ? 'owner' : 'friend', traceId: interaction.trace_id, payload: { trace_id: interaction.trace_id, input_kind: row.input_kind ?? 'text', text_length: String(row.text ?? '').length, preview: clipText(row.text), message_id: row.id }, privacyScope, dedupeKey: `${interaction.event_id}:in` }); } catch {}
      try { const hub=unifiedHub(); if(hub&&row.text) recordDailyMessage(hub,{channel:'wechat',conversationKind:'direct',peerId:row.peer_id,speaker:peer.role,inputKind:row.input_kind??'text',role:'user',content:row.text,messageId:row.id,privacyScope,importance:0.7,at:new Date(row.created_ms)}); } catch {}
      if(this.now()-row.created_ms>600000) {this.db.prepare("UPDATE ilink_messages SET status='expired' WHERE id=?").run(row.id);continue;}
      const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(this.now()));
      let reply=row.reply;
      let voiceError=false;
      if(row.status==='pending') {
        if(row.input_kind==='voice') {
          // D-2：语音/模型配额走统一预算（connect/core/budget.mjs 的 daily_budget），
          // 不再按账号各自记账——微信与 QQ、life 占用的是同一个跨渠道池子。
          const reserved=reserveVoiceRequest(this.db,day);
          if(!reserved) {this.db.prepare("UPDATE ilink_messages SET status='held',error='daily_voice_budget' WHERE id=?").run(row.id);continue;}
          this.db.prepare("UPDATE ilink_messages SET status='transcribing' WHERE id=?").run(row.id);
          try {
            if(!this.voice)throw new Error('voice_not_available');
            const result=await this.voice.local.transcribe(row,signal);row.text=result.text;row.transcript_source=result.source;
            this.db.prepare('UPDATE ilink_messages SET text=?,transcript_source=?,media_json=NULL WHERE id=?').run(row.text,row.transcript_source,row.id);
          }catch{
            if(signal.aborted)return;
            voiceError=true;reply=(peer.role==='owner'?'爸爸，':'')+'这段语音我暂时没听清，请再说一次或改发文字。';
            this.db.prepare("UPDATE ilink_messages SET error='voice_recognition_failed',media_json=NULL WHERE id=?").run(row.id);
          }
        }
        peer=this.allowed(a,row);
        if(signal.aborted||!peer||peer.role!==interaction.sender.role){this.db.prepare("UPDATE ilink_messages SET status='held',error='permission_changed' WHERE id=?").run(row.id);continue;}
        if(!voiceError) {
          const reservation=reserveModelCall(this.db,day);
          if(!reservation) {this.db.prepare("UPDATE ilink_messages SET status='held',error='daily_model_budget' WHERE id=?").run(row.id);continue;}
          this.db.prepare("UPDATE ilink_messages SET status='drafting' WHERE id=?").run(row.id);
          try {reply=await this.ask({account:a,peer,row,history:peerHistory(this.db,row),voiceCapabilities:this.voice?.status(),signal});if(typeof reply!=='string'||!reply.trim())throw new Error('empty_reply');reply=reply.trim().slice(0,row.input_kind==='voice'?240:1800);}
          catch {this.db.prepare("UPDATE ilink_messages SET status='failed',error='model_failed' WHERE id=?").run(row.id);continue;}
        }
        this.db.prepare("UPDATE ilink_messages SET status='ready',reply=? WHERE id=?").run(reply,row.id);row.reply=reply;
      }
      let prepared=null;
      if(row.input_kind==='voice'&&this.voice&&peer.role==='owner'&&!voiceError) {
        this.db.prepare("UPDATE ilink_messages SET status='synthesizing' WHERE id=?").run(row.id);
        try {prepared=await this.voice.prepare(a,peer,{...row,reply},signal);if(prepared?.spokenText)reply=prepared.spokenText;}
        catch {
          if(signal.aborted)return;
          reply='（语音回复暂不可用，先用文字回复）'+reply;
          this.db.prepare("UPDATE ilink_messages SET error='voice_reply_preparation_failed',delivery_kind='text' WHERE id=?").run(row.id);
        }
        this.db.prepare("UPDATE ilink_messages SET status='ready',reply=? WHERE id=?").run(reply,row.id);
      }
      peer=this.allowed(a,row);
      if(signal.aborted || !peer || peer.role!==interaction.sender.role || this.now()-row.created_ms>600000) {this.db.prepare("UPDATE ilink_messages SET status='held',error='permission_or_session_changed' WHERE id=?").run(row.id);continue;}
      const actions = actionMarkerNames(reply);
      if (actions.length && evaluatePolicy(interaction, 'task.propose').allowed) {
        const intent={intent:'external_action_request',operations:actions,target:'unspecified',requires_confirmation:true};
        const task=proposeTask(this.db,{kind:'ilink',convId:row.peer_id,sourceMessageId:row.id,intent,proposerPeerId:row.peer_id,origin:'ilink',now:this.now()});
        reply = `${stripActionMarkers(reply)} 外部操作已记录为待确认任务 ${task.id}，本次没有执行。`;
        this.db.prepare("UPDATE ilink_messages SET reply=?,error='external_action_not_executed' WHERE id=?").run(reply, row.id);
      }
      if (actions.length && !evaluatePolicy(interaction, 'task.propose').allowed) {
        reply = stripActionMarkers(reply);
        this.db.prepare("UPDATE ilink_messages SET reply=?,error='external_action_unauthorized' WHERE id=?").run(reply, row.id);
      }
      this.db.prepare("UPDATE ilink_messages SET status='sending' WHERE id=?").run(row.id);
      try {
        const result=prepared?await this.voice.send(a,row,prepared,signal):await this.client.send(a,{peerId:row.peer_id,text:reply,contextToken:row.context_token,clientId:row.client_id},signal);
        const unverified=prepared?.kind==='native_voice_unverified';
        this.db.prepare("UPDATE ilink_messages SET status=?,outbound_id=?,context_token=CASE WHEN ? THEN context_token ELSE NULL END,updated_at=datetime('now') WHERE id=?").run(unverified?'awaiting_voice_confirmation':'sent',result.message_id?String(result.message_id):null,unverified?1:0,row.id);
        try { const hub = unifiedHub(); if (hub && row.text && reply) { recordDailyMessage(hub,{channel:'wechat',conversationKind:'direct',peerId:row.peer_id,speaker:peer.role,inputKind:row.input_kind??'text',role:'assistant',content:reply,messageId:`${row.id}:reply`,privacyScope,importance:0.7,at:new Date()}); if (evaluatePolicy(interaction, 'memory.write.owner').allowed) captureExchange(hub, row.text, reply, { source: 'wechat' }); } } catch {}
        try { recordAgentEvent(this.db, { id: `${row.id}:out`, eventType: 'message_replied', channel: 'wechat', conversationId: row.peer_id, actor: 'assistant', traceId: interaction.trace_id, payload: { input_kind: row.input_kind ?? 'text', message_id: row.id }, result: { ok: true, outbound_id: result.message_id ? String(result.message_id) : null }, privacyScope: peer.role === 'owner' ? 'private' : 'friend', dedupeKey: `${row.id}:out` }); } catch {}
      } catch {
        this.db.prepare("UPDATE ilink_messages SET status='unknown',error='delivery_not_confirmed',updated_at=datetime('now') WHERE id=?").run(row.id);
        try { recordAgentEvent(this.db, { id: `${row.id}:out`, eventType: 'action_failed', channel: 'wechat', conversationId: row.peer_id, actor: 'assistant', traceId: interaction.trace_id, payload: { message_id: row.id }, result: { ok: false, error: 'delivery_not_confirmed' }, privacyScope: peer.role === 'owner' ? 'private' : 'friend', dedupeKey: `${row.id}:out` }); } catch {}
      }
    }
  }
  async run(a,signal) {
    let delay=1000;
    // Recover committed but not-yet-sent drafts before waiting for the next long poll.
    await this.drain(a,signal);
    while(!signal.aborted) {
      try {
        const cursor=this.db.prepare('SELECT cursor FROM ilink_cursors WHERE binding_id=?').get(a.bindingId)?.cursor ?? '';
        const batch=await this.client.updates(a,cursor,signal);
        if(signal.aborted)return;
        ingestUpdates(this.db,a,batch,this.now());
        this.db.prepare("UPDATE ilink_accounts SET status='online',last_poll=datetime('now'),last_error=NULL WHERE id=?").run(a.id);
        this.db.prepare('DELETE FROM ilink_messages WHERE created_ms<?').run(this.now()-7*86400000);
        delay=1000; await this.drain(a,signal);
        if(!(batch.msgs?.length))await new Promise(r=>setTimeout(r,300));
      } catch(error) {
        if(signal.aborted)return;
        if(error.code==='timeout') { this.db.prepare("UPDATE ilink_accounts SET status='waiting',last_error=NULL WHERE id=?").run(a.id); continue; }
        if(error.message==='ilink_api_-14'||error.message==='ilink_http_401') {this.db.prepare("UPDATE ilink_accounts SET status='login_required',last_error='session_expired' WHERE id=?").run(a.id);return;}
        this.db.prepare("UPDATE ilink_accounts SET status='reconnecting',last_error=? WHERE id=?").run(error.code==='timeout'?'poll_timeout':'poll_failed',a.id);
        await new Promise(r=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);r();};const timer=setTimeout(done,delay);signal.addEventListener('abort',done,{once:true});});delay=Math.min(delay*2,30000);
      }
    }
  }
  async close(){this.stopped=true;clearInterval(this.timer);for(const j of this.jobs.values())j.stop.abort();await Promise.allSettled([...this.jobs.values()].map(j=>j.task));}
}
