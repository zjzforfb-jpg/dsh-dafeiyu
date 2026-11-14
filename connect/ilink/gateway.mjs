import { randomBytes } from 'node:crypto';
import { VoiceService } from '../voice/service.mjs';
import { join,resolve } from 'node:path';
import { IlinkClient } from './protocol.mjs';
import { accountStore } from './credentials.mjs';
import { IlinkLogin, loginPage } from './login.mjs';
import { initIlink, registerAccount, safeAccounts, safeMessages, authorizePeer } from './store.mjs';
import { IlinkWorker } from './worker.mjs';
function json(res,status,data){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'});res.end(JSON.stringify(data));}
export class IlinkGateway {
  constructor({db,root,voiceRoot=join(root,'voice'),client=new IlinkClient(),ask=async()=>{throw new Error('brain_not_configured');}}){
    this.db=db;this.root=join(root,'ilink');this.accounts=accountStore(this.root);initIlink(db);
    this.voice=new VoiceService({db,root:voiceRoot,client});
    this.worker=new IlinkWorker({db,accounts:this.accounts,client,ask,voice:this.voice});
    this.voiceCleanup=setInterval(()=>{try{this.voice.local.cleanup();}catch{}},60000);this.voiceCleanup.unref();
    this.login=new IlinkLogin({root:this.root,client,accounts:this.accounts,onBound:a=>{registerAccount(db,a);this.worker.reconcile();}});
    this.worker.start();
  }
  async public(req,res,path,readBody,port){
    const match=/^\/ilink\/bind\/([a-f0-9]{48})(\/(?:state|pin))?$/.exec(path);
    if(!match)return false;
    const key=match[1], tail=match[2]??'';
    const view=this.login.view(key);
    if(!view){json(res,404,{error:'binding_not_found'});return true;}
    if(req.method==='GET'&&tail==='/state'){json(res,200,view);return true;}
    if(req.method==='GET'&&!tail){
      const nonce=randomBytes(18).toString('base64');
      res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff','content-security-policy':`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`});res.end(loginPage(key,nonce));return true;
    }
    if(req.method==='POST'&&tail==='/pin'){
      if(req.headers.origin!==`http://127.0.0.1:${port}`||!req.headers['content-type']?.startsWith('application/json')){json(res,403,{error:'invalid_origin'});return true;}
      try {const data=await readBody(req);this.login.pin(key,data.pin);json(res,200,{ok:true});}catch{json(res,400,{error:'pin_not_accepted'});}return true;
    }
    json(res,405,{error:'method_not_allowed'});return true;
  }
  async admin(req,res,path,readBody,port){
    if(path==='/ilink/status'&&req.method==='GET'){json(res,200,{accounts:safeAccounts(this.db),protocol:'Tencent iLink',text_replies:true,media_send:{audio_files:true,native_voice:this.voice.status().native},voice:this.voice.status()});return;}
    if(path==='/ilink/voice'&&req.method==='GET'){json(res,200,this.voice.status());return;}
    if(path.startsWith('/ilink/voice/')&&req.method==='POST'){
      try{
        const data=await readBody(req);
        if(path==='/ilink/voice/trial'){
          const rows=this.accounts.list();const id=data.account_id??(rows.length===1?rows[0].id:null);this.voice.armTrial(id);json(res,200,this.voice.status());return;
        }
        if(path==='/ilink/voice/confirm'){json(res,200,this.voice.confirm(data.id,{visible:data.visible,playable:data.playable}));return;}
        if(path==='/ilink/voice/fallback'){
          const row=this.db.prepare('SELECT account_id FROM ilink_messages WHERE id=?').get(data.id??'');
          const account=this.accounts.list().find(a=>a.id===row?.account_id);if(!account)throw new Error('account_not_available');
          const stop=new AbortController();res.on('close',()=>{if(!res.writableEnded)stop.abort();});
          json(res,200,await this.voice.fallback(account,data.id,AbortSignal.any([stop.signal,AbortSignal.timeout(90000)])));return;
        }
        json(res,404,{error:'not_found'});
      }catch(e){json(res,400,{error:/^[a-z_]+$/.test(e.message)?e.message:'voice_action_failed'});}return;
    }
    if(path==='/ilink/login/start'&&req.method==='POST'){
      try {const session=await this.login.start();json(res,200,{page_url:`http://127.0.0.1:${port}/ilink/bind/${session.key}`,image_file:session.image_file,expires_at:session.expires_at});}
      catch(e){json(res,502,{error:e.message});}return;
    }
    if(path==='/ilink/peers'&&req.method==='GET'){json(res,200,{peers:this.db.prepare('SELECT account_id,peer_id,label,role,enabled,auto_reply FROM ilink_peers ORDER BY account_id,peer_id').all()});return;}
    if(path==='/ilink/peers'&&req.method==='POST'){try{authorizePeer(this.db,await readBody(req));json(res,200,{ok:true});}catch{json(res,400,{error:'invalid_peer_policy'});}return;}
    if(path==='/ilink/account'&&req.method==='POST'){
      try {const data=await readBody(req);if(typeof data.id!=='string'||typeof data.enabled!=='boolean')throw new Error();
        const changed=this.db.prepare("UPDATE ilink_accounts SET enabled=?,status=CASE WHEN ?=0 THEN 'paused' WHEN status='login_required' THEN status ELSE 'bound' END WHERE id=?").run(data.enabled?1:0,data.enabled?1:0,data.id);
        if(!changed.changes)throw new Error();this.worker.reconcile();json(res,200,{ok:true});
      }catch{json(res,400,{error:'invalid_account'});}return;
    }
    if(path==='/ilink/messages'&&req.method==='GET'){json(res,200,{messages:safeMessages(this.db)});return;}
    if(/^\/ilink\/messages\/[a-f0-9]{64}$/.test(path)&&req.method==='GET'){
      const row=this.db.prepare('SELECT id,account_id,peer_id,text,reply,status,error,created_ms,outbound_id,input_kind,transcript_source,delivery_kind,audio_duration_ms,voice_confirmed,fallback_status,fallback_outbound_id FROM ilink_messages WHERE id=?').get(path.split('/').at(-1));json(res,row?200:404,row??{error:'not_found'});return;
    }
    json(res,404,{error:'not_found'});
  }
  async close(){clearInterval(this.voiceCleanup);const task=this.login.active?.task;this.login.cancel();await Promise.allSettled([task,this.worker.close()]);}
}
