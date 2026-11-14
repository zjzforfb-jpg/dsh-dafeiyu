import { randomUUID } from 'node:crypto';

export function initTasks(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS external_tasks(
    id TEXT PRIMARY KEY, conv_kind TEXT NOT NULL, conv_id TEXT NOT NULL,
    source_message_id TEXT, intent TEXT NOT NULL, payload TEXT NOT NULL,
    status TEXT NOT NULL, result TEXT, evidence TEXT, origin TEXT NOT NULL DEFAULT 'qq',
    proposer_peer_id TEXT, approver_peer_id TEXT, idempotency_key TEXT UNIQUE,
    attempts INTEGER NOT NULL DEFAULT 0, expires_ms INTEGER, created_ms INTEGER NOT NULL,
    updated_ms INTEGER NOT NULL);`);
  const columns=new Set(db.prepare('PRAGMA table_info(external_tasks)').all().map(r=>r.name));
  for(const [name,type] of Object.entries({evidence:'TEXT',origin:"TEXT NOT NULL DEFAULT 'qq'",proposer_peer_id:'TEXT',approver_peer_id:'TEXT',idempotency_key:'TEXT',attempts:'INTEGER NOT NULL DEFAULT 0',expires_ms:'INTEGER'}))if(!columns.has(name))db.exec(`ALTER TABLE external_tasks ADD COLUMN ${name} ${type}`);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS external_tasks_idempotency ON external_tasks(idempotency_key) WHERE idempotency_key IS NOT NULL;");
  db.prepare("UPDATE external_tasks SET status='unknown',updated_ms=? WHERE status IN ('approved','running')").run(Date.now());
  db.prepare("UPDATE external_tasks SET status='expired',updated_ms=? WHERE status='awaiting_confirmation' AND expires_ms IS NOT NULL AND expires_ms<?").run(Date.now(),Date.now());
}

export function parseExternalIntent(text) {
  const value=String(text??'').replace(/\s+/gu,' ').trim();
  if(!value)return null;
  const douyin=/(抖音|评论区|评论|点赞)/u.test(value);
  const manage=/(回复|回|点赞|维护|互动)/u.test(value);
  if(!douyin||!manage)return null;
  const operations=[];
  if(/(回复|回|维护)/u.test(value))operations.push('douyin.reply_comments');
  if(/点赞|赞|维护/u.test(value))operations.push('douyin.like_comments');
  return {intent:'douyin.manage_comments',operations:[...new Set(operations)],target:'my_latest_work',requires_confirmation:true};
}

export function proposeTask(db,{kind,convId,sourceMessageId,intent,proposerPeerId=null,origin='qq',expiresMs=Date.now()+15*60_000,now=Date.now()}) {
  const idem=`${origin}:${kind}:${convId}:${sourceMessageId}:${intent.intent}:${intent.operations.join(',')}`;
  const existing=db.prepare('SELECT * FROM external_tasks WHERE idempotency_key=?').get(idem);if(existing)return existing;
  const id=`task_${randomUUID()}`;
  db.prepare('INSERT INTO external_tasks(id,conv_kind,conv_id,source_message_id,intent,payload,status,origin,proposer_peer_id,idempotency_key,expires_ms,created_ms,updated_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id,kind,convId,sourceMessageId,intent.intent,JSON.stringify(intent),'awaiting_confirmation',origin,proposerPeerId,idem,expiresMs,now,now);
  return db.prepare('SELECT * FROM external_tasks WHERE id=?').get(id);
}

export function latestPendingTask(db,kind,convId) {
  return db.prepare("SELECT * FROM external_tasks WHERE conv_kind=? AND conv_id=? AND status='awaiting_confirmation' ORDER BY created_ms DESC LIMIT 1").get(kind,convId)??null;
}

export function taskPayload(row){try{return JSON.parse(row.payload);}catch{return null;}}

export function approveTask(db,id,approverPeerId='owner',now=Date.now()) {
  const result=db.prepare("UPDATE external_tasks SET status='approved',approver_peer_id=?,updated_ms=? WHERE id=? AND status='awaiting_confirmation' AND (expires_ms IS NULL OR expires_ms>?)").run(approverPeerId,now,id,now);
  return result.changes===1;
}

export function startTask(db,id,now=Date.now()) {
  const result=db.prepare("UPDATE external_tasks SET status='running',attempts=attempts+1,updated_ms=? WHERE id=? AND status='approved'").run(now,id);
  return result.changes===1;
}

export function completeTask(db,id,{ok,result},now=Date.now()) {
  db.prepare('UPDATE external_tasks SET status=?,result=?,evidence=?,attempts=attempts+1,updated_ms=? WHERE id=?').run(ok?'succeeded':'failed',JSON.stringify(result??{}),JSON.stringify(result??{}),now,id);
}

export function listTasks(db,{status,limit=50}={}){const safe=Math.min(Math.max(Number(limit)||50,1),200);return status?db.prepare('SELECT id,conv_kind,conv_id,intent,status,origin,proposer_peer_id,approver_peer_id,attempts,expires_ms,created_ms,updated_ms,result,evidence FROM external_tasks WHERE status=? ORDER BY created_ms DESC LIMIT ?').all(status,safe):db.prepare('SELECT id,conv_kind,conv_id,intent,status,origin,proposer_peer_id,approver_peer_id,attempts,expires_ms,created_ms,updated_ms,result,evidence FROM external_tasks ORDER BY created_ms DESC LIMIT ?').all(safe);}
export function task(db,id){return db.prepare('SELECT * FROM external_tasks WHERE id=?').get(id)??null;}
export function cancelTask(db,id,now=Date.now()){return db.prepare("UPDATE external_tasks SET status='cancelled',updated_ms=? WHERE id=? AND status IN ('awaiting_confirmation','approved')").run(now,id).changes===1;}
