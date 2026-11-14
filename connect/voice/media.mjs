import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { BASE_INFO } from '../ilink/protocol.mjs';
export const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c';
const LIMIT = 10 * 1024 * 1024;
export function cdnUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.weixin.qq.com') || url.username || url.password || (url.port && url.port !== '443')) throw new Error('untrusted_media_endpoint');
  return url.toString();
}
export function aesKey(value) {
  if(typeof value!=='string'||value.length>128)throw new Error('invalid_media_key');
  const decoded=Buffer.from(value,'base64');
  if(decoded.length===16)return decoded;
  if(decoded.length===32&&/^[a-f0-9]{32}$/i.test(decoded.toString('ascii')))return Buffer.from(decoded.toString('ascii'),'hex');
  throw new Error('invalid_media_key');
}
export function crypt(bytes,key,decrypt=false) {
  const engine=(decrypt?createDecipheriv:createCipheriv)('aes-128-ecb',key,null);
  return Buffer.concat([engine.update(bytes),engine.final()]);
}
async function responseBytes(res) {
  if(Number(res.headers.get('content-length')??0)>LIMIT) {await res.body?.cancel();throw new Error('voice_media_too_large');}
  let size=0;const chunks=[];const reader=res.body.getReader();
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>LIMIT){await reader.cancel();throw new Error('voice_media_too_large');}chunks.push(value);}
  return Buffer.concat(chunks);
}
export class VoiceTransport {
  constructor({client,fetchImpl=fetch}){this.client=client;this.fetch=fetchImpl;}
  async download(voice,signal){
    const media=voice?.media;
    if(!media||typeof media.aes_key!=='string'||(!media.full_url&&!media.encrypt_query_param))throw new Error('voice_media_missing');
    const key=aesKey(media.aes_key);
    const url=cdnUrl(media.full_url||`${CDN_BASE}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`);
    let response;
    try{response=await this.fetch(url,{redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});}catch{throw new Error('voice_download_failed');}
    if(!response.ok)throw new Error(`voice_download_http_${response.status}`);
    const bytes=await responseBytes(response);
    try{return crypt(bytes,key,true);}catch{throw new Error('voice_decryption_failed');}
  }
  async upload(account,peerId,bytes,type,signal){
    if(!Buffer.isBuffer(bytes)||bytes.length===0||bytes.length>LIMIT)throw new Error('invalid_voice_size');
    const key=randomBytes(16),filekey=randomBytes(16).toString('hex');
    const ciphertext=crypt(bytes,key);
    const response=await this.client.request('ilink/bot/getuploadurl',{base:account.baseUrl,token:account.token,signal,timeout:15000,
      body:{filekey,media_type:type,to_user_id:peerId,rawsize:bytes.length,rawfilemd5:createHash('md5').update(bytes).digest('hex'),filesize:ciphertext.length,no_need_thumb:true,aeskey:key.toString('hex'),base_info:BASE_INFO}});
    if(!response.upload_full_url&&!response.upload_param)throw new Error('voice_upload_url_missing');
    const url=cdnUrl(response.upload_full_url||`${CDN_BASE}/upload?encrypted_query_param=${encodeURIComponent(response.upload_param)}&filekey=${filekey}`);
    let uploaded;
    try{uploaded=await this.fetch(url,{method:'POST',body:ciphertext,headers:{'content-type':'application/octet-stream'},redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});}catch{throw new Error('voice_cdn_upload_failed');}
    if(uploaded.status!==200){await uploaded.body?.cancel();throw new Error(`voice_upload_http_${uploaded.status}`);}
    const downloadParam=uploaded.headers.get('x-encrypted-param');await uploaded.body?.cancel();
    if(!downloadParam||downloadParam.length>20000)throw new Error('voice_upload_receipt_missing');
    return {encrypt_query_param:downloadParam,aes_key:Buffer.from(key.toString('hex')).toString('base64'),encrypt_type:1};
  }
  async sendItems(account,{peerId,items,contextToken,clientId},signal){
    // Follow the upstream media sender: one item per request, caption before file.
    // A partial/ambiguous send is propagated to the worker; never retry here.
    let result;
    for(let index=0;index<items.length;index++){
      signal?.throwIfAborted();
      result=await this.client.request('ilink/bot/sendmessage',{base:account.baseUrl,token:account.token,signal,timeout:15000,
        body:{msg:{from_user_id:'',to_user_id:peerId,client_id:items.length===1?clientId:`${clientId}-${index}`,message_type:2,message_state:2,item_list:[items[index]],context_token:contextToken},base_info:BASE_INFO}});
    }
    return result;
  }
}
