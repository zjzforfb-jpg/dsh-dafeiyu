import { ensureColumns } from './core/migrations.mjs';
const SECRET=/(sk-[A-Za-z0-9_-]{12,}|api[_ -]?key|access[_ -]?token|密码|验证码|短信码|银行卡|身份证)/iu;
function clean(value,max=4000){const text=String(value??'').slice(0,max);return SECRET.test(text)?'[内容含敏感字段，已从日记忆中隐藏]':text;}
export function initDailyMemory(db){
  db.exec(`CREATE TABLE IF NOT EXISTS daily_memory_events(
    id INTEGER PRIMARY KEY, day TEXT NOT NULL, channel TEXT NOT NULL,
    conversation_kind TEXT NOT NULL DEFAULT 'direct', peer_id TEXT,
    speaker TEXT, input_kind TEXT NOT NULL DEFAULT 'text', user_text TEXT,
    assistant_text TEXT, role TEXT NOT NULL DEFAULT 'user', content TEXT,
    key_info TEXT, message_id TEXT, dedupe_key TEXT, importance REAL NOT NULL DEFAULT 0.5,
    privacy_scope TEXT NOT NULL DEFAULT 'private', created_at TEXT NOT NULL DEFAULT (datetime('now')),
    digested_at TEXT); CREATE INDEX IF NOT EXISTS daily_memory_day ON daily_memory_events(day,created_at);`);
  ensureColumns(db, 'daily_memory_events', ['role','content','key_info','message_id','dedupe_key']);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS daily_memory_dedupe ON daily_memory_events(dedupe_key) WHERE dedupe_key IS NOT NULL;');
}
export function recordDailyExchange(db,{channel,conversationKind='direct',peerId=null,speaker=null,inputKind='text',userText,assistantText,importance=0.5,privacyScope='private',at=new Date()}){
  const first=recordDailyMessage(db,{channel,conversationKind,peerId,speaker,inputKind,role:'user',content:userText,importance,privacyScope,at,messageId:`exchange:${Date.now()}:user`});
  const second=recordDailyMessage(db,{channel,conversationKind,peerId,speaker,inputKind,role:'assistant',content:assistantText,importance,privacyScope,at,messageId:`exchange:${Date.now()}:assistant`});
  return {user:first,assistant:second};
}
export function recordDailyMessage(db,{channel,conversationKind='direct',peerId=null,speaker=null,inputKind='text',role='user',content,messageId=null,importance=0.5,privacyScope='private',at=new Date(),keyInfo=null}){
  initDailyMemory(db);if(!['user','assistant','system'].includes(role)||!String(content??'').trim())return null;
  const text=clean(content);if(!text||/^\[(?:heartbeat|system|empty)\]$/iu.test(text))return null;
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(at);const dedupe=awaitableHash(`${day}|${channel}|${conversationKind}|${peerId??''}|${messageId??role}|${text}`);
  const info=keyInfo??extractKeyInfo(text);const result=db.prepare(`INSERT OR IGNORE INTO daily_memory_events(day,channel,conversation_kind,peer_id,speaker,input_kind,role,content,key_info,importance,privacy_scope,message_id,dedupe_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(day,String(channel),String(conversationKind),peerId?String(peerId).slice(0,160):null,speaker?String(speaker).slice(0,80):null,inputKind,role,text,JSON.stringify(info),Math.max(0,Math.min(1,Number(importance)||0.5)),privacyScope,messageId?String(messageId).slice(0,240):null,dedupe);
  return result.changes?Number(result.lastInsertRowid):null;
}
function awaitableHash(value){let h=0x811c9dc5;for(const ch of value){h^=ch.codePointAt(0);h=Math.imul(h,16777619);}return (h>>>0).toString(16).padStart(8,'0');}
function extractKeyInfo(text){const out=[];if(/记住|记下|请记得/u.test(text))out.push({type:'memory_request'});if(/回复|评论|点赞|发布|电话|短信|购物/u.test(text))out.push({type:'external_action'});if(/喜欢|生日|名字|称呼|家人|爸爸|妈妈/u.test(text))out.push({type:'identity_or_preference'});return out;}
export function dailyEvents(db,day,{undigestedOnly=false,limit=500}={}){initDailyMemory(db);const safe=Math.min(Math.max(Number(limit)||500,1),2000);return db.prepare(`SELECT * FROM daily_memory_events WHERE day=? ${undigestedOnly?'AND digested_at IS NULL':''} ORDER BY created_at,id LIMIT ?`).all(day,safe);}
export function ownerDigestEvents(db, day, options = {}) {
  return dailyEvents(db, day, options).filter((event) =>
    event.privacy_scope === 'private'
    && event.conversation_kind === 'direct'
    && (!['wechat', 'qq'].includes(event.channel) || event.speaker === 'owner'));
}
export function markDailyDigested(db,day,at=new Date()){initDailyMemory(db);db.prepare('UPDATE daily_memory_events SET digested_at=? WHERE day=? AND digested_at IS NULL').run(at.toISOString(),day);}
export function purgeDailyMemory(db,days=30){initDailyMemory(db);db.prepare("DELETE FROM daily_memory_events WHERE created_at < datetime('now', ?)").run(`-${Math.max(7,Math.min(365,days))} days`);}
