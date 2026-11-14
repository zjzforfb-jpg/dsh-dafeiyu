import {execFile as execCallback} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execCallback);
const HOSTS=new Set(['https://api.minimax.cn','https://api.minimax.io']);
const EMOTIONS=new Set(['happy','sad','angry','fearful','disgusted','surprised','neutral']);
const MODELS=new Set(['speech-2.8-hd','speech-2.6-hd','speech-2.6-turbo','speech-2.5-hd-preview','speech-2.5-turbo-preview','speech-02-hd','speech-02-turbo']);

export async function minimaxKey(){
  // Prefer this app's own credential over a possibly unrelated login environment.
  try{const {stdout}=await exec('/usr/bin/security',['find-generic-password','-s','DaFeiYu-MiniMax-API-Key','-w'],{timeout:10000,maxBuffer:16384});if(stdout.trim())return stdout.trim();}catch{}
  const key=process.env.MINIMAX_API_KEY?.trim();if(key)return key;
  throw new Error('cloud_voice_key_missing');
}

function validate(text,config){
  const base=config.base_url??'https://api.minimax.cn';
  if(!HOSTS.has(base))throw new Error('untrusted_tts_endpoint');
  if(typeof text!=='string'||!text.trim()||text.length>240)throw new Error('invalid_tts_text');
  const validVoice=id=>typeof id==='string'&&!!id.trim()&&id.length<=128;
  const mix=config.timbre_weights;
  if(mix!==undefined){
    if(!Array.isArray(mix)||mix.length<2||mix.length>4||mix.some(v=>!validVoice(v?.voice_id)||!Number.isInteger(v.weight)||v.weight<1||v.weight>100)||mix.reduce((n,v)=>n+v.weight,0)!==100||new Set(mix.map(v=>v.voice_id)).size!==mix.length)throw new Error('invalid_tts_mix');
  }else if(!validVoice(config.voice_id))throw new Error('invalid_tts_voice');
  const speed=config.speed??1;
  if(typeof speed!=='number'||!Number.isFinite(speed)||speed<0.5||speed>2)throw new Error('invalid_tts_speed');
  const pitch=config.pitch??0;
  if(!Number.isInteger(pitch)||pitch<-12||pitch>12)throw new Error('invalid_tts_pitch');
  const model=config.model??'speech-2.8-hd';
  if(!MODELS.has(model))throw new Error('invalid_tts_model');
  const emotion=config.emotion;
  if(emotion!==undefined&&!EMOTIONS.has(emotion))throw new Error('invalid_tts_emotion');
  return {base,model,mix,speed,pitch,emotion};
}

export async function synthesizeMinimax(text,config,signal,{fetchImpl=fetch,keyProvider=minimaxKey}={}){
  const {base,model,mix,speed,pitch,emotion}=validate(text,config);
  const key=await keyProvider();
  let response;
  try{
    response=await fetchImpl(base+'/v1/t2a_v2',{method:'POST',redirect:'error',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(45000)]):AbortSignal.timeout(45000),
      body:JSON.stringify({model,text,stream:false,output_format:'hex',language_boost:'Chinese',voice_setting:{voice_id:mix?'':config.voice_id,speed,vol:1,pitch,...(emotion?{emotion}:{})},...(mix?{timbre_weights:mix.map(({voice_id,weight})=>({voice_id,weight}))}:{}),audio_setting:{sample_rate:32000,bitrate:128000,format:'mp3',channel:1}})});
  }catch{throw new Error(signal?.aborted?'voice_cancelled':'cloud_voice_request_failed');}
  if(!response.ok){await response.body?.cancel();throw new Error('cloud_voice_http_failed');}
  const limit=20*1024*1024;
  if(Number(response.headers.get('content-length')??0)>limit){await response.body?.cancel();throw new Error('cloud_voice_response_too_large');}
  const reader=response.body.getReader();const chunks=[];let size=0;
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();throw new Error('cloud_voice_response_too_large');}chunks.push(value);}
  let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('cloud_voice_invalid_response');}
  if(data.base_resp?.status_code!==0)throw new Error('cloud_voice_api_failed');
  const hex=data.data?.audio;
  if(typeof hex!=='string'||!hex.length||hex.length%2||!/^[a-f0-9]+$/i.test(hex))throw new Error('cloud_voice_audio_missing');
  const duration=data.extra_info?.audio_length;
  if(typeof duration!=='number'||duration<=0||duration>60000)throw new Error('cloud_voice_duration_invalid');
  return {bytes:Buffer.from(hex,'hex'),duration_ms:duration,usage_characters:data.extra_info?.usage_characters??null};
}


/** 流式合成：按服务端返回的 SSE 分片回调音频（mp3 bytes），首包最早约 0.5s。 */
export async function synthesizeMinimaxStream(text,config,signal,{fetchImpl=fetch,keyProvider=minimaxKey,onAudio=()=>{}}={}){
  const {base,model,mix,speed,pitch,emotion}=validate(text,config);
  const key=await keyProvider();
  let response;
  try{
    response=await fetchImpl(base+'/v1/t2a_v2',{method:'POST',redirect:'error',headers:{authorization:`Bearer ${key}`,'content-type':'application/json',accept:'text/event-stream'},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(45000)]):AbortSignal.timeout(45000),
      body:JSON.stringify({model,text,stream:true,stream_options:{exclude_aggregated_audio:true},output_format:'hex',language_boost:'Chinese',voice_setting:{voice_id:mix?'':config.voice_id,speed,vol:1,pitch,...(emotion?{emotion}:{})},...(mix?{timbre_weights:mix.map(({voice_id,weight})=>({voice_id,weight}))}:{}),audio_setting:{sample_rate:32000,bitrate:128000,format:'mp3',channel:1}})});
  }catch{throw new Error(signal?.aborted?'voice_cancelled':'cloud_voice_request_failed');}
  if(!response.ok){await response.body?.cancel();throw new Error('cloud_voice_http_failed');}
  const limit=20*1024*1024;
  const reader=response.body.getReader();const decoder=new TextDecoder();const parts=[];let buffer='';let size=0;let durationMs=0;
  for(;;){
    const {done,value}=await reader.read();
    if(done)break;
    buffer+=decoder.decode(value,{stream:true});
    let index;
    while((index=buffer.indexOf('\n'))>=0){
      const line=buffer.slice(0,index).trim();buffer=buffer.slice(index+1);
      if(!line.startsWith('data:'))continue;
      const payload=line.slice(5).trim();
      if(!payload||payload==='[DONE]')continue;
      let parsed;try{parsed=JSON.parse(payload);}catch{continue;}
      if(parsed.base_resp&&parsed.base_resp.status_code!==0)throw new Error('cloud_voice_api_failed');
      if(parsed.data?.audio){const bytes=Buffer.from(parsed.data.audio,'hex');size+=bytes.length;if(size>limit){await reader.cancel();throw new Error('cloud_voice_response_too_large');}parts.push(bytes);onAudio(bytes);}
      if(parsed.extra_info?.audio_length)durationMs=parsed.extra_info.audio_length;
    }
  }
  if(!parts.length)throw new Error('cloud_voice_empty_stream');
  return {bytes:Buffer.concat(parts),duration_ms:durationMs};
}
