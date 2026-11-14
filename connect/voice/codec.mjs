// Isolate the untrusted SILK decoder in a short-lived child process.
import { readFileSync, writeFileSync } from 'node:fs';
import { encode, decode, isSilk, getDuration } from 'silk-wasm';
const [mode,input,output]=process.argv.slice(2);
try {
  const bytes=readFileSync(input);
  if(bytes.length>10*1024*1024)throw new Error();
  let result;
  if(mode==='decode'){
    if(!isSilk(bytes)||getDuration(bytes)>90000)throw new Error();
    result=await decode(bytes,24000);
  }else if(mode==='encode'){
    if(bytes.length>24000*2*60)throw new Error();
    result=await encode(bytes,24000);
  }else throw new Error();
  if(result.duration>90000||result.data.byteLength>24000*2*90)throw new Error();
  writeFileSync(output,result.data,{mode:0o600});
  process.stdout.write(JSON.stringify({duration_ms:result.duration,bytes:result.data.byteLength}));
}catch {process.stderr.write('voice_codec_failed');process.exitCode=1;}
