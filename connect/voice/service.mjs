import { VoiceTransport } from './media.mjs';
import { LocalVoice } from './local.mjs';
export function initVoice(db){
  const fields={input_kind:"TEXT NOT NULL DEFAULT 'text'",media_json:'TEXT',transcript_source:'TEXT',delivery_kind:"TEXT NOT NULL DEFAULT 'text'",audio_duration_ms:'INTEGER',voice_confirmed:'INTEGER NOT NULL DEFAULT 0',fallback_status:'TEXT',fallback_outbound_id:'TEXT'};
  const existing=new Set(db.prepare('PRAGMA table_info(ilink_messages)').all().map(r=>r.name));
  for(const [name,type] of Object.entries(fields))if(!existing.has(name))db.exec(`ALTER TABLE ilink_messages ADD COLUMN ${name} ${type}`);
  if(!db.prepare('PRAGMA table_info(ilink_usage)').all().some(r=>r.name==='voice_requests'))db.exec('ALTER TABLE ilink_usage ADD COLUMN voice_requests INTEGER NOT NULL DEFAULT 0');
  db.exec(`CREATE TABLE IF NOT EXISTS ilink_voice_settings(account_id TEXT PRIMARY KEY,native_state TEXT NOT NULL DEFAULT 'unverified',trial_remaining INTEGER NOT NULL DEFAULT 0,verified_at TEXT,last_error TEXT);
    UPDATE ilink_messages SET status='failed',error='voice_preparation_interrupted' WHERE status IN ('transcribing','synthesizing');
    UPDATE ilink_messages SET fallback_status='unknown' WHERE fallback_status='sending';`);
}
export class VoiceService {
  constructor({db,root,client,local,transport}){
    this.db=db;this.transport=transport??new VoiceTransport({client});this.local=local??new LocalVoice({root,transport:this.transport});
  }
  status(){return {...this.local.status(),native:this.db.prepare('SELECT account_id,native_state,trial_remaining,verified_at,last_error FROM ilink_voice_settings').all()};}
  armTrial(accountId){if(!this.db.prepare('SELECT 1 FROM ilink_accounts WHERE id=? AND enabled=1').get(accountId))throw new Error('account_not_available');if(this.db.prepare("SELECT 1 FROM ilink_messages WHERE account_id=? AND status='awaiting_voice_confirmation'").get(accountId))throw new Error('voice_confirmation_pending');this.db.prepare("UPDATE ilink_voice_settings SET native_state='unverified',trial_remaining=1,last_error=NULL WHERE account_id=?").run(accountId);}
  mode(peer,row){
    if(row.delivery_kind==='native_voice_unverified')return 'native_voice_unverified';
    if(peer.role!=='owner')return 'text';
    const settings=this.db.prepare('SELECT * FROM ilink_voice_settings WHERE account_id=?').get(row.account_id);
    if(settings.native_state==='verified')return 'native_voice';
    if(settings.trial_remaining>0){this.db.prepare("UPDATE ilink_voice_settings SET trial_remaining=0,native_state='trial_pending' WHERE account_id=?").run(row.account_id);return 'native_voice_unverified';}
    return 'audio_file';
  }
  ensureAllowed(account,peerId){
    const active=this.db.prepare('SELECT enabled,binding_id FROM ilink_accounts WHERE id=?').get(account.id);
    const peer=this.db.prepare('SELECT enabled,auto_reply FROM ilink_peers WHERE account_id=? AND peer_id=?').get(account.id,peerId);
    if(!active?.enabled||active.binding_id!==account.bindingId||!peer?.enabled||!peer.auto_reply)throw new Error('voice_permission_changed');
  }
  async prepare(account,peer,row,signal){
    const mode=this.mode(peer,row);
    if(mode==='text')return null;
    this.db.prepare('UPDATE ilink_messages SET delivery_kind=? WHERE id=?').run(mode,row.id);
    const audio=await this.local.synthesize(row.id,row.reply,signal);
    this.ensureAllowed(account,row.peer_id);
    let kind=mode,media;
    if(mode.startsWith('native_voice')){
      try{media=await this.transport.upload(account,row.peer_id,audio.silk,4,signal);}
      catch(error){
        if(signal?.aborted)throw error;
        kind='audio_file';this.db.prepare("UPDATE ilink_voice_settings SET native_state='unavailable',trial_remaining=0,last_error='native_upload_failed' WHERE account_id=?").run(account.id);
      }
    }
    if(kind==='audio_file'){this.ensureAllowed(account,row.peer_id);media=await this.transport.upload(account,row.peer_id,audio.file,3,signal);}
    const item=kind==='audio_file'?{type:4,file_item:{media,file_name:audio.fileName,len:String(audio.file.length)}}:{type:3,voice_item:{media,encode_type:6,bits_per_sample:16,sample_rate:24000,playtime:audio.duration_ms}};
    const items=kind==='audio_file'?[{type:1,text_item:{text:'大肥鱼语音回复（音频文件）'}},item]:[item];
    this.db.prepare('UPDATE ilink_messages SET delivery_kind=?,audio_duration_ms=? WHERE id=?').run(kind,audio.duration_ms,row.id);
    return {kind,items,duration_ms:audio.duration_ms,spokenText:audio.text??row.reply};
  }
  async send(account,row,prepared,signal){return this.transport.sendItems(account,{peerId:row.peer_id,items:prepared.items,contextToken:row.context_token,clientId:row.client_id},signal);}
  confirm(id,{visible,playable}){
    if(typeof visible!=='boolean'||typeof playable!=='boolean')throw new Error('invalid_voice_confirmation');
    const positive=visible&&playable;
    const row=this.db.prepare(`SELECT m.* FROM ilink_messages m JOIN ilink_accounts a ON a.id=m.account_id AND a.binding_id=m.binding_id
      WHERE m.id=? AND ((m.delivery_kind='native_voice_unverified' AND m.status='awaiting_voice_confirmation')
      OR (?=0 AND m.delivery_kind='native_voice' AND m.status='sent'))`).get(id,positive?1:0);
    if(!row)throw new Error('no_unconfirmed_voice');
    if(visible&&playable){
      this.db.prepare("UPDATE ilink_messages SET status='sent',delivery_kind='native_voice',voice_confirmed=1,context_token=NULL WHERE id=?").run(id);
      this.db.prepare("UPDATE ilink_voice_settings SET native_state='verified',verified_at=datetime('now'),last_error=NULL WHERE account_id=?").run(row.account_id);
    }else{
      this.db.prepare("UPDATE ilink_messages SET status='native_not_visible',voice_confirmed=0,error='native_voice_not_confirmed' WHERE id=?").run(id);
      this.db.prepare("UPDATE ilink_voice_settings SET native_state='unavailable',trial_remaining=0,verified_at=NULL,last_error='native_voice_not_visible' WHERE account_id=?").run(row.account_id);
    }
    return {ok:true,native_verified:visible&&playable};
  }
  async fallback(account,id,signal){
    const row=this.db.prepare("SELECT * FROM ilink_messages WHERE id=? AND account_id=? AND binding_id=?").get(id,account.id,account.bindingId);
    if(!row)throw new Error('no_native_voice_candidate');
    if(row.fallback_status)return {status:row.fallback_status,duplicate:true};
    if(row.delivery_kind!=='native_voice_unverified'||!['awaiting_voice_confirmation','native_not_visible'].includes(row.status))throw new Error('no_native_voice_candidate');
    const peer=this.db.prepare('SELECT * FROM ilink_peers WHERE account_id=? AND peer_id=? AND enabled=1 AND auto_reply=1').get(account.id,row.peer_id);
    const enabled=this.db.prepare('SELECT enabled FROM ilink_accounts WHERE id=?').get(account.id)?.enabled;
    if(!enabled||!peer||!row.context_token||Date.now()-row.created_ms>600000)throw new Error('voice_context_expired_or_revoked');
    const audio=this.local.artifacts(id);
    const media=await this.transport.upload(account,row.peer_id,audio.file,3,signal);
    const items=[{type:1,text_item:{text:'原生语音尚未确认，改发音频文件供播放。'}},{type:4,file_item:{media,file_name:audio.fileName,len:String(audio.file.length)}}];
    const active=this.db.prepare('SELECT enabled,binding_id FROM ilink_accounts WHERE id=?').get(account.id);
    const stillAllowed=this.db.prepare('SELECT enabled,auto_reply FROM ilink_peers WHERE account_id=? AND peer_id=?').get(account.id,row.peer_id);
    if(!active?.enabled||active.binding_id!==account.bindingId||!stillAllowed?.enabled||!stillAllowed.auto_reply||Date.now()-row.created_ms>600000)throw new Error('voice_permission_changed');
    if(!this.db.prepare("UPDATE ilink_messages SET fallback_status='sending' WHERE id=? AND fallback_status IS NULL").run(id).changes)return {status:'already_in_progress',duplicate:true};
    try{
      const result=await this.transport.sendItems(account,{peerId:row.peer_id,items,contextToken:row.context_token,clientId:row.client_id+'-file'},signal);
      this.db.prepare("UPDATE ilink_messages SET fallback_status='sent',fallback_outbound_id=?,context_token=NULL,status='sent',delivery_kind='audio_file' WHERE id=?").run(result.message_id?String(result.message_id):null,id);
      return {status:'sent',delivery_kind:'audio_file'};
    }catch{this.db.prepare("UPDATE ilink_messages SET fallback_status='unknown' WHERE id=?").run(id);return {status:'unknown'};}
  }
}
