import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,rmSync,readFileSync,statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProtocolJson,trustedBase,IlinkClient } from '../connect/ilink/protocol.mjs';
import { initIlink,registerAccount,ingestUpdates,peerHistory,safeMessages } from '../connect/ilink/store.mjs';
import { IlinkWorker } from '../connect/ilink/worker.mjs';
import { IlinkLogin } from '../connect/ilink/login.mjs';
import { accountStore } from '../connect/ilink/credentials.mjs';
import { startConnect } from '../connect/server.mjs';
const account={id:'bot-a',bindingId:'binding-a',ownerPeerId:'owner-a',token:'secret-token',baseUrl:'https://ilinkai.weixin.qq.com'};
const incoming=(id='18446744073709551615',peer='owner-a')=>({message_id:id,from_user_id:peer,to_user_id:'bot-a',message_type:1,message_state:2,create_time_ms:Date.now(),context_token:'private-context',item_list:[{type:1,text_item:{text:'你好'}}]});
const setup=()=>{const db=new DatabaseSync(':memory:');initIlink(db);registerAccount(db,account);return db;};

test('iLink parser preserves uint64 IDs without modifying quoted text; endpoints reject token exfiltration',()=>{
 const parsed=parseProtocolJson('{"message_id":18446744073709551615,"text":"\\\"message_id\\\":123","ret":0}');
 assert.equal(parsed.message_id,'18446744073709551615');assert.equal(parsed.ret,0);assert.equal(parsed.text,'"message_id":123');
 for(const url of ['http://ilinkai.weixin.qq.com','https://127.0.0.1','https://ilinkai.weixin.qq.com.evil.com','https://user:pass@ilinkai.weixin.qq.com','https://ilinkai.weixin.qq.com/a'])assert.throws(()=>trustedBase(url));
});
test('iLink HTTP client preserves message IDs and binds each reply to its own context and peer',async()=>{
 let seen;
 const client=new IlinkClient({fetchImpl:async(url,opts)=>{seen={url,opts};return new Response('{"ret":0,"message_id":18446744073709551615}');}});
 const result=await client.send(account,{peerId:'owner-a',text:'我是大肥鱼AI',contextToken:'one-context',clientId:'stable-client'});
 assert.equal(result.message_id,'18446744073709551615');assert.equal(seen.opts.headers.Authorization,'Bearer secret-token');
 const body=JSON.parse(seen.opts.body);assert.equal(body.msg.context_token,'one-context');assert.equal(body.msg.to_user_id,'owner-a');assert.equal(body.msg.client_id,'stable-client');
 const bad=new IlinkClient({fetchImpl:async()=>new Response('secret body',{status:403})});await assert.rejects(()=>bad.qr(),e=>e.message==='ilink_http_403');
});
test('iLink stores batches and cursor atomically, deduplicates, isolates accounts and blocks unknown peers',()=>{
 const db=setup();
 assert.equal(ingestUpdates(db,account,{msgs:[incoming(),incoming('2','stranger')],get_updates_buf:'cursor'}),2);
 assert.equal(ingestUpdates(db,account,{msgs:[incoming()]}),0);
 assert.equal(db.prepare('SELECT cursor FROM ilink_cursors').get().cursor,'cursor');
 const blocked=db.prepare("SELECT * FROM ilink_messages WHERE peer_id='stranger'").get();assert.equal(blocked.status,'blocked');assert.equal(blocked.text,'');assert.equal(blocked.context_token,null);
 assert.equal(JSON.stringify(safeMessages(db)).includes('private-context'),false);
 assert.equal(ingestUpdates(db,account,{msgs:[{...incoming('3'),to_user_id:'other-bot'},{...incoming('4'),group_id:'group'}]}),0);
 db.close();
});
test('iLink worker never repeats an ambiguous send and rechecks contact permission after generation',async()=>{
 const db=setup();let sent=0,generated=0;
 const worker=new IlinkWorker({db,accounts:{list:()=>[account]},client:{send:async()=>{sent++;throw new Error('network');}},ask:async()=>{generated++;return 'AI回复';}});
 ingestUpdates(db,account,{msgs:[incoming('1')]});await worker.drain(account,new AbortController().signal);await worker.drain(account,new AbortController().signal);
 assert.equal(sent,1);assert.equal(generated,1);assert.equal(db.prepare('SELECT status FROM ilink_messages').get().status,'unknown');
 ingestUpdates(db,account,{msgs:[incoming('2')]});worker.ask=async()=>{db.prepare("UPDATE ilink_peers SET auto_reply=0 WHERE peer_id='owner-a'").run();return 'should not send';};
 await worker.drain(account,new AbortController().signal);assert.equal(sent,1);assert.equal(db.prepare("SELECT status FROM ilink_messages WHERE upstream_id='2'").get().status,'held');
 db.close();
});
test('iLink conversation history excludes other peers and rebinding invalidates old routing',()=>{
 const db=setup();ingestUpdates(db,account,{msgs:[incoming('1')]});db.prepare("UPDATE ilink_messages SET status='sent',reply='owner private'").run();
 assert.equal(peerHistory(db,{account_id:account.id,binding_id:account.bindingId,peer_id:'other'}).length,0);
 registerAccount(db,{...account,bindingId:'new-binding',ownerPeerId:'new-owner'});
 assert.equal(db.prepare("SELECT enabled FROM ilink_peers WHERE peer_id='owner-a'").get().enabled,0);
 assert.equal(peerHistory(db,{account_id:account.id,binding_id:'new-binding',peer_id:'new-owner'}).length,0);db.close();
});
test('iLink login handles PIN locally and only exposes safe state, credentials are private',async()=>{
 const root=mkdtempSync(join(tmpdir(),'dafeiyu-login-'));const accounts=accountStore(root);let bound;
 let calls=0;
 const client={qr:async()=>({qrcode:'qr-secret',qrcode_img_content:'https://ilinkai.weixin.qq.com/ilink/q/test'}),qrStatus:async(q,options)=>{calls++;return options.pin==='123456'?{status:'confirmed',ilink_bot_id:'bot',ilink_user_id:'owner',bot_token:'token-secret'}:{status:'need_verifycode'};}};
 const login=new IlinkLogin({root,client,accounts,onBound:a=>{bound=a;}});
 try{
 const session=await login.start();for(let i=0;i<20&&!login.view(session.key).needs_pin;i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(login.view(session.key).needs_pin,true);assert.equal(JSON.stringify(login.view(session.key)).includes('token-secret'),false);
 login.pin(session.key,'123456');await login.active.task;
 assert.equal(login.view(session.key).status,'confirmed');assert.equal(bound.ownerPeerId,'owner');assert.equal(accounts.list()[0].token,'token-secret');
 assert.equal(statSync(join(root,'accounts.json')).mode&0o777,0o600);assert.equal(readFileSync(join(root,'accounts.json'),'utf8').includes('123456'),false);
 }finally{login.cancel();rmSync(root,{recursive:true,force:true});}
});
test('iLink bind page has scoped capability; public page never grants admin API access or cross-origin PIN',async()=>{
 const root=mkdtempSync(join(tmpdir(),'dafeiyu-ilink-http-'));
 const client={qr:async()=>({qrcode:'q',qrcode_img_content:'https://ilinkai.weixin.qq.com/ilink/q/test'}),qrStatus:async(q,{signal})=>new Promise((_,reject)=>{signal.addEventListener('abort',()=>reject(Object.assign(new Error('ilink_timeout'),{code:'timeout'})),{once:true});})};
 const service=await startConnect({root,port:0,config:{adminToken:'admin',devices:{}},ilinkClient:client});const base=`http://127.0.0.1:${service.port}`;
 try{
 assert.equal((await fetch(base+'/ilink/status')).status,401);
 const r=await fetch(base+'/ilink/login/start',{method:'POST',headers:{authorization:'Bearer admin'}});const session=await r.json();assert.equal(r.status,200);
 const page=await fetch(session.page_url);assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
 assert.equal((await fetch(session.page_url+'/pin',{method:'POST',headers:{origin:'https://evil.invalid','content-type':'application/json'},body:'{"pin":"123456"}'})).status,403);
 assert.equal((await fetch(base+'/ilink/bind/'+ 'a'.repeat(48))).status,404);
 }finally{await service.close();rmSync(root,{recursive:true,force:true});}
});
