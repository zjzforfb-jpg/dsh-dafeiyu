import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {initIlink,registerAccount,ingestUpdates,safeMessages} from '../connect/ilink/store.mjs';
import {IlinkWorker} from '../connect/ilink/worker.mjs';
import {VoiceService} from '../connect/voice/service.mjs';
import {VoiceTransport,cdnUrl,aesKey,crypt} from '../connect/voice/media.mjs';
import {LocalVoice} from '../connect/voice/local.mjs';
import {synthesizeMinimax} from '../connect/voice/cloud.mjs';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const a={id:'voice-bot',bindingId:'binding',ownerPeerId:'dad',baseUrl:'https://ilinkai.weixin.qq.com',token:'token'};
const item={media:{encrypt_query_param:'private-query',aes_key:Buffer.alloc(16,3).toString('base64')},encode_type:6,playtime:8000};
const msg=(id='1',peer='dad')=>({message_id:id,message_type:1,message_state:2,from_user_id:peer,to_user_id:a.id,create_time_ms:Date.now(),context_token:'private-context',item_list:[{type:3,voice_item:item}]});
function setup(){const db=new DatabaseSync(':memory:');initIlink(db);registerAccount(db,a);return db;}
const fakeLocal={status:()=>({asr:'ready'}),transcribe:async()=>({text:'爸爸这是语音测试',source:'local_test'}),synthesize:async()=>({silk:Buffer.from('silk'),file:Buffer.from('m4a'),duration_ms:3000,fileName:'回复.m4a',text:'爸爸，我听清楚了。'}),artifacts:()=>({file:Buffer.from('m4a'),fileName:'回复.m4a'})};
function service(db,extra={}){return new VoiceService({db,local:fakeLocal,transport:{upload:async()=>({encrypt_query_param:'encrypted',aes_key:'key'}),sendItems:async()=>({message_id:'out'}),...extra}});}

test('voice ingress is authorized before persisting media keys and keeps public listings free of keys',()=>{
 const db=setup();ingestUpdates(db,a,{msgs:[msg(),msg('2','unknown')]});
 const accepted=db.prepare("SELECT * FROM ilink_messages WHERE upstream_id='1'").get();assert.equal(accepted.input_kind,'voice');assert.equal(accepted.status,'pending');assert.match(accepted.media_json,/private-query/);
 const denied=db.prepare("SELECT * FROM ilink_messages WHERE upstream_id='2'").get();assert.equal(denied.media_json,null);assert.equal(denied.context_token,null);
 assert.equal(JSON.stringify(safeMessages(db)).includes('private-query'),false);db.close();
});
test('voice transport refuses unsafe URLs/keys and decrypts both supported key representations',async()=>{
 for(const url of ['http://novac2c.cdn.weixin.qq.com/c2c/a','https://127.0.0.1/a','https://evil.example/a','https://x.weixin.qq.com.evil.com'])assert.throws(()=>cdnUrl(url));
 const key=Buffer.alloc(16,8),plain=Buffer.from('voice example'),encrypted=crypt(plain,key);
 assert.deepEqual(aesKey(key.toString('base64')),key);assert.deepEqual(aesKey(Buffer.from(key.toString('hex')).toString('base64')),key);assert.throws(()=>aesKey('bad'));
 let auth;
 const transport=new VoiceTransport({client:{},fetchImpl:async(url,opts)=>{auth=opts.headers;return new Response(encrypted);}});
 assert.deepEqual(await transport.download({media:{encrypt_query_param:'opaque',aes_key:key.toString('base64')}},new AbortController().signal),plain);assert.equal(auth,undefined);
});
test('CDN upload encrypts bytes and passes exact voice type and recipient without leaking API auth to CDN',async()=>{
 let request,posted;
 const transport=new VoiceTransport({client:{request:async(endpoint,opts)=>{request={endpoint,...opts};return {upload_param:'upload'};}},fetchImpl:async(url,opts)=>{posted={url,...opts};return new Response('',{headers:{'x-encrypted-param':'download'}});}});
 const bytes=Buffer.from('audio');const media=await transport.upload(a,'dad',bytes,4,new AbortController().signal);
 assert.equal(request.body.media_type,4);assert.equal(request.body.to_user_id,'dad');assert.equal(request.body.rawfilemd5,createHash('md5').update(bytes).digest('hex'));assert.equal(posted.body.length,16);assert.equal(posted.headers.Authorization,undefined);assert.equal(media.encrypt_query_param,'download');assert.deepEqual(crypt(posted.body,aesKey(media.aes_key),true),bytes);
});
test('voice pipeline transcribes, generates and falls back to a labelled file only before a native message is sent',async()=>{
 const db=setup();const uploads=[],sends=[];const voice=service(db,{upload:async(account,peer,bytes,type)=>{uploads.push(type);if(type===4)throw new Error('unsupported');return {};},sendItems:async(account,args)=>{sends.push(args);return {message_id:'out-file'};}});voice.armTrial(a.id);
 ingestUpdates(db,a,{msgs:[msg()]});let asked;
 const worker=new IlinkWorker({db,accounts:{list:()=>[a]},client:{},voice,ask:async(args)=>{asked=args;return '爸爸，我听清楚了。';}});
 await worker.drain(a,new AbortController().signal);const row=db.prepare('SELECT * FROM ilink_messages').get();
 assert.equal(asked.row.text,'爸爸这是语音测试');assert.equal(row.transcript_source,'local_test');assert.equal(row.media_json,null);assert.equal(row.delivery_kind,'audio_file');assert.equal(row.status,'sent');assert.deepEqual(uploads,[4,3]);assert.equal(sends.length,1);assert.equal(sends[0].items[1].type,4);db.close();
});
test('file transport sends caption and attachment separately and never retries a partially accepted reply',async()=>{
 const calls=[];const transport=new VoiceTransport({client:{request:async(endpoint,args)=>{calls.push(args.body.msg);if(calls.length===2)throw new Error('ambiguous_file_send');return {message_id:'caption'};}}});
 const items=[{type:1,text_item:{text:'音频文件'}},{type:4,file_item:{file_name:'回复.m4a'}}];
 await assert.rejects(transport.sendItems(a,{peerId:'dad',items,contextToken:'context',clientId:'reply'},new AbortController().signal),/ambiguous_file_send/);
 assert.equal(calls.length,2);assert.deepEqual(calls.map(m=>m.item_list.length),[1,1]);assert.deepEqual(calls.map(m=>m.item_list[0].type),[1,4]);assert.deepEqual(calls.map(m=>m.client_id),['reply-0','reply-1']);assert.ok(calls.every(m=>m.context_token==='context'&&m.to_user_id==='dad'));
});
test('native voice acceptance stays unverified until visible and playable confirmation; no automatic replay',async()=>{
 const db=setup();let sends=0;const voice=service(db,{sendItems:async()=>{sends++;return {message_id:'voice-out'};}});voice.armTrial(a.id);
 ingestUpdates(db,a,{msgs:[msg()]});const worker=new IlinkWorker({db,accounts:{list:()=>[a]},client:{},voice,ask:async()=> '我是大肥鱼。'});
 await worker.drain(a,new AbortController().signal);await worker.drain(a,new AbortController().signal);let row=db.prepare('SELECT * FROM ilink_messages').get();
 assert.equal(row.status,'awaiting_voice_confirmation');assert.equal(sends,1);assert.equal(row.context_token,'private-context');assert.notEqual(voice.status().native[0].native_state,'verified');
 voice.confirm(row.id,{visible:true,playable:true});row=db.prepare('SELECT * FROM ilink_messages').get();assert.equal(row.voice_confirmed,1);assert.equal(row.context_token,null);assert.equal(row.delivery_kind,'native_voice');assert.equal(voice.status().native[0].native_state,'verified');
 registerAccount(db,{...a,id:'other',bindingId:'other-binding'});assert.equal(voice.status().native.find(s=>s.account_id==='other').native_state,'unverified');db.close();
});
test('native-not-visible fallback uses one file send even under concurrent duplicate requests',async()=>{
 const db=setup();let sends=0;const voice=service(db,{sendItems:async()=>{sends++;return {message_id:'out'};}});voice.armTrial(a.id);ingestUpdates(db,a,{msgs:[msg()]});
 const worker=new IlinkWorker({db,accounts:{list:()=>[a]},client:{},voice,ask:async()=> '语音'});await worker.drain(a,new AbortController().signal);const id=db.prepare('SELECT id FROM ilink_messages').get().id;voice.confirm(id,{visible:false,playable:false});
 await Promise.all([voice.fallback(a,id,new AbortController().signal),voice.fallback(a,id,new AbortController().signal)]);assert.equal(sends,2);assert.equal((await voice.fallback(a,id,new AbortController().signal)).duplicate,true);assert.equal(db.prepare('SELECT delivery_kind FROM ilink_messages').get().delivery_kind,'audio_file');db.close();
});
test('a corrected negative report revokes native verification and routes later voice to files',async()=>{
 const db=setup();const voice=service(db);voice.armTrial(a.id);ingestUpdates(db,a,{msgs:[msg()]});
 const worker=new IlinkWorker({db,accounts:{list:()=>[a]},client:{},voice,ask:async()=> '语音测试'});await worker.drain(a,new AbortController().signal);
 const id=db.prepare('SELECT id FROM ilink_messages').get().id;voice.confirm(id,{visible:true,playable:true});
 voice.confirm(id,{visible:false,playable:false});const row=db.prepare('SELECT * FROM ilink_messages WHERE id=?').get(id);
 assert.equal(row.voice_confirmed,0);assert.equal(row.status,'native_not_visible');assert.equal(voice.status().native[0].native_state,'unavailable');assert.equal(voice.status().native[0].verified_at,null);
 ingestUpdates(db,a,{msgs:[msg('2')]});await worker.drain(a,new AbortController().signal);assert.equal(db.prepare("SELECT delivery_kind FROM ilink_messages WHERE upstream_id='2'").get().delivery_kind,'audio_file');
 registerAccount(db,{...a,bindingId:'new-binding'});assert.throws(()=>voice.confirm(id,{visible:false,playable:false}));db.close();
});
test('revoking a peer during synthesis prevents even uploading the generated audio',async()=>{
 const db=setup();let uploads=0;const voice=service(db,{upload:async()=>{uploads++;return {};}});voice.local={...fakeLocal,synthesize:async()=>{db.prepare('UPDATE ilink_peers SET auto_reply=0').run();return fakeLocal.synthesize();}};
 ingestUpdates(db,a,{msgs:[msg()]});const worker=new IlinkWorker({db,accounts:{list:()=>[a]},client:{send:async()=>{throw new Error('should not send');}},voice,ask:async()=> '测试'});await worker.drain(a,new AbortController().signal);assert.equal(uploads,0);assert.equal(db.prepare('SELECT status FROM ilink_messages').get().status,'held');db.close();
});
test('neural synthesis reads private text files and does not silently substitute the old system voice on failure',async()=>{
 const root=mkdtempSync(join(tmpdir(),'dafeiyu-neural-'));const calls=[];
 try{
  writeFileSync(join(root,'tts.json'),JSON.stringify({provider:'qwen3_mlx',speaker:'Serena'}));
  const local=new LocalVoice({root});local.run=async(binary,args)=>{calls.push({binary,args});throw new Error('voice_process_failed');};
  await assert.rejects(local.synthesize('a'.repeat(64),'爸爸，这是一条私人测试。'),/voice_process_failed/);
  assert.equal(calls.length,1);assert.ok(calls[0].binary.endsWith('neural-venv/bin/python'));assert.ok(calls[0].args.some(a=>a.endsWith('reply.txt')));assert.equal(JSON.stringify(calls).includes('私人测试'),false);assert.equal(calls.some(c=>c.binary==='/usr/bin/say'),false);
  assert.equal(local.status().tts,'qwen3_mlx_Serena');
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('cloud voice restricts credential destinations and requests unmodified pitch with bounded audio',async()=>{
 let called=0,seen;
 const deps={keyProvider:async()=>{called++;return 'private-api-key';},fetchImpl:async(url,args)=>{seen={url,...args};return new Response(JSON.stringify({base_resp:{status_code:0},data:{audio:Buffer.from('ID3audio').toString('hex')},extra_info:{audio_length:5000}}));}};
 await assert.rejects(synthesizeMinimax('爸爸你好',{base_url:'https://evil.example',voice_id:'test'},undefined,deps),/untrusted_tts_endpoint/);assert.equal(called,0);
 const audio=await synthesizeMinimax('爸爸你好',{base_url:'https://api.minimax.cn',voice_id:'qiaopi_mengmei'},undefined,deps);
 assert.equal(audio.bytes.toString(),'ID3audio');assert.equal(audio.duration_ms,5000);assert.equal(seen.url,'https://api.minimax.cn/v1/t2a_v2');assert.equal(seen.redirect,'error');assert.equal(seen.headers.authorization,'Bearer private-api-key');
 const body=JSON.parse(seen.body);assert.equal(body.model,'speech-2.8-hd');assert.equal(body.voice_setting.pitch,0);assert.equal(body.voice_setting.speed,1);assert.equal(body.text,'爸爸你好');
});
test('cloud errors do not expose provider bodies or return unusable audio as success',async()=>{
 const config={voice_id:'test'},keyProvider=async()=> 'private-key';
 const replies=[{base_resp:{status_code:1008,status_msg:'private-key secret response'},data:{}},{base_resp:{status_code:0},data:{audio:'odd'},extra_info:{audio_length:100}},{base_resp:{status_code:0},data:{audio:'494433'},extra_info:{audio_length:61000}}];
 for(const data of replies)await assert.rejects(synthesizeMinimax('爸爸你好',config,undefined,{keyProvider,fetchImpl:async()=>new Response(JSON.stringify(data))}),error=>!error.message.includes('private-key')&&error.message.startsWith('cloud_voice_'));
 await assert.rejects(synthesizeMinimax('爸爸你好',config,undefined,{keyProvider,fetchImpl:async()=>new Response('private-key',{headers:{'content-length':String(21*1024*1024)}})}),/response_too_large/);
});
test('cloud voice mixes speaker identities at synthesis time and validates speed and pitch before accessing credentials',async()=>{
 let called=0,body;const deps={keyProvider:async()=>{called++;return 'key';},fetchImpl:async(url,args)=>{body=JSON.parse(args.body);return new Response(JSON.stringify({base_resp:{status_code:0},data:{audio:'494433'},extra_info:{audio_length:5000}}));}};
 const mix=[{voice_id:'Chinese (Mandarin)_Soft_Girl',weight:60},{voice_id:'qiaopi_mengmei',weight:40}];
 for(const config of [{timbre_weights:mix,speed:NaN},{timbre_weights:mix,pitch:13},{timbre_weights:mix,pitch:1.5},{timbre_weights:mix,emotion:'flirty'},{timbre_weights:mix,model:'speech-9-hd'},{timbre_weights:[{voice_id:'a',weight:101},{voice_id:'b',weight:-1}]},{timbre_weights:[{voice_id:'a',weight:50},{voice_id:'a',weight:50}]}])await assert.rejects(synthesizeMinimax('爸爸你好',config,undefined,deps),/invalid_tts_/);
 assert.equal(called,0);await synthesizeMinimax('爸爸你好',{timbre_weights:mix,speed:1.12,pitch:3,emotion:'happy',model:'speech-2.6-hd'},undefined,deps);assert.equal(called,1);assert.equal(body.model,'speech-2.6-hd');assert.deepEqual(body.timbre_weights,mix);assert.equal(body.voice_setting.voice_id,'');assert.equal(body.voice_setting.speed,1.12);assert.equal(body.voice_setting.pitch,3);assert.equal(body.voice_setting.emotion,'happy');
});
