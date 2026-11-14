import { execFile as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isSilk } from 'silk-wasm';
import { synthesizeMinimax } from './cloud.mjs';
const exec=promisify(execCallback);
const FF='/opt/homebrew/bin/ffmpeg';
export class LocalVoice {
  constructor({root,model=resolve(root,'models/ggml-small.bin'),whisper='/opt/homebrew/bin/whisper-cli',voice='Tingting',transport}){Object.assign(this,{root,model,whisper,voice,transport});mkdirSync(root,{recursive:true,mode:0o700});chmodSync(root,0o700);}
  dir(id){if(!/^[a-f0-9]{64}$/.test(id))throw new Error('invalid_voice_id');const dir=join(this.root,'messages',id);mkdirSync(dir,{recursive:true,mode:0o700});chmodSync(dir,0o700);return dir;}
  ttsConfig(){const path=join(this.root,'tts.json');return existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{provider:'macos_say'};}
  async run(binary,args,signal,timeout=30000){
    try{return await exec(binary,args,{timeout,signal,maxBuffer:1024*1024,env:{...process.env,LC_ALL:'en_US.UTF-8'}});}catch{if(signal?.aborted)throw new Error('voice_cancelled');throw new Error('voice_process_failed');}
  }
  async codec(mode,input,output,signal){
    const {stdout}=await this.run(process.execPath,['--max-old-space-size=256',resolve(import.meta.dirname,'codec.mjs'),mode,input,output],signal,20000);
    return JSON.parse(stdout);
  }
  async transcribe(row,signal){
    const voice=JSON.parse(row.media_json);
    if(!voice.media&&(typeof voice.text==='string')&&voice.text.trim())return {text:voice.text.trim().slice(0,4000),source:'ilink_voice_transcript'};
    const bytes=await this.transport.download(voice,signal);
    return this.transcribeBytes(row.id,bytes,signal);
  }
  async transcribeBytes(id,bytes,signal){
    if(!Buffer.isBuffer(bytes)||!bytes.length)throw new Error('voice_empty_audio');
    const dir=this.dir(id),input=join(dir,'incoming.audio'),wav=join(dir,'incoming.wav');
    writeFileSync(input,bytes,{mode:0o600});
    let source=input;
    const isPcmSilk=isSilk(bytes);
    const isAudio=bytes.subarray(0,3).toString()==='ID3'||(bytes[0]===255&&(bytes[1]&224)===224)||bytes.subarray(0,4).toString()==='OggS'||(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WAVE');
    if(!isPcmSilk&&!isAudio)throw new Error('unsupported_voice_codec');
    if(isPcmSilk){source=join(dir,'incoming.pcm');await this.codec('decode',input,source,signal);}
    const args=['-nostdin','-hide_banner','-loglevel','error','-y','-protocol_whitelist','file,pipe',...(source.endsWith('.pcm')?['-f','s16le','-ar','24000','-ac','1']:[]),'-i',source,'-t','90','-ar','16000','-ac','1','-c:a','pcm_s16le',wav];
    await this.run(FF,args,signal);chmodSync(wav,0o600);
    if(!existsSync(this.model)||!existsSync(this.whisper))throw new Error('voice_asr_not_ready');
    const output=join(dir,'transcript');
    await this.run(this.whisper,['-m',this.model,'-f',wav,'-l','zh','-otxt','-of',output,'-nt','-np'],signal,120000);
    let text=readFileSync(output+'.txt','utf8').replace(/\[(?:BLANK_AUDIO|SILENCE|MUSIC)\]/g,'').trim();
    if(!text||text.length>4000)throw new Error('voice_not_understood');
    chmodSync(output+'.txt',0o600);
    return {text,source:'local_whisper_cpp'};
  }
  async synthesize(id,text,signal,{silk:wantSilk=true}={}){
    const dir=this.dir(id);const plain=text.replace(/\[\[.*?\]\]/gs,'').replace(/[*`#]/g,'').trim().slice(0,240);
    if(!plain)throw new Error('voice_empty_reply');
    const input=join(dir,'reply.txt'),aiff=join(dir,'reply.aiff'),wav=join(dir,'reply.wav'),pcm=join(dir,'reply.pcm'),silk=join(dir,'reply.silk'),file=join(dir,'reply.m4a');
    writeFileSync(input,plain,{mode:0o600});
    let source=aiff;
    const tts=this.ttsConfig();
    if(tts.provider==='minimax'){
      source=join(dir,'reply-cloud.mp3');
      const cloud=await synthesizeMinimax(plain,tts,signal);writeFileSync(source,cloud.bytes,{mode:0o600});
    }else if(tts.provider==='qwen3_mlx'){
      source=join(dir,'reply-neural.wav');
      await this.run(join(this.root,'neural-venv/bin/python'),[resolve(import.meta.dirname,'neural.py'),this.root,input,source],signal,180000);
    }else if(tts.provider==='macos_say'){
      await this.run('/usr/bin/say',['-v',this.voice,'-r','205','-o',aiff,'-f',input],signal,60000);
    }else throw new Error('unknown_tts_provider');
    await this.run(FF,['-nostdin','-hide_banner','-loglevel','error','-y','-i',source,'-t','60','-ac','1','-ar','24000','-c:a','pcm_s16le',wav],signal);
    let info={duration_ms:(statSync(wav).size-44)/2/24000*1000};
    if(wantSilk){
      await this.run(FF,['-nostdin','-hide_banner','-loglevel','error','-y','-i',wav,'-f','s16le','-ac','1','-ar','24000',pcm],signal);
      info=await this.codec('encode',pcm,silk,signal);
    }
    await this.run(FF,['-nostdin','-hide_banner','-loglevel','error','-y','-i',wav,'-c:a','aac','-b:a','64k',file],signal);
    for(const f of wantSilk?[source,wav,pcm,silk,file]:[source,wav,file])chmodSync(f,0o600);
    return {duration_ms:Math.round(info.duration_ms),silk:wantSilk?readFileSync(silk):null,file:readFileSync(file),fileName:'大肥鱼语音回复.m4a',text:plain};
  }
  artifacts(id){const dir=this.dir(id);return {silk:readFileSync(join(dir,'reply.silk')),file:readFileSync(join(dir,'reply.m4a')),fileName:'大肥鱼语音回复.m4a'};}
  status(){let tts;try{const c=this.ttsConfig();tts=c.provider==='minimax'?'minimax_'+(c.model??'speech-2.8-hd'):c.provider==='qwen3_mlx'?'qwen3_mlx_'+(c.speaker??'Serena'):c.provider==='macos_say'&&process.platform==='darwin'?'macOS_say_'+this.voice:'unavailable';}catch{tts='invalid_configuration';}return {asr:existsSync(this.model)&&existsSync(this.whisper)?'ready':'not_installed',tts,codec:'silk_wasm',audio_files:true};}
  cleanup(){const dir=join(this.root,'messages');if(!existsSync(dir))return;for(const name of readdirSync(dir)){if(!/^[a-f0-9]{64}$/.test(name))continue;const path=join(dir,name);if(statSync(path).mtimeMs<Date.now()-86400000)rmSync(path,{recursive:true,force:true});}}
}
