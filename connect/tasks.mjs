import { randomUUID } from 'node:crypto';
import { initAgentEvents, recordAgentEvent } from './agent-events.mjs';
import { createWorkingTask, initWorkingTasks, recoverWorkingTasks, updateWorkingTask } from './working-state.mjs';
import { AUTO_ACTIONS } from './douyin/dayplan.mjs';
import { ensureColumns } from './core/migrations.mjs';
import { intentFromText } from './core/task.mjs';

export function initTasks(db) {
  initAgentEvents(db);
  initWorkingTasks(db);
  db.exec(`CREATE TABLE IF NOT EXISTS external_tasks(
    id TEXT PRIMARY KEY, conv_kind TEXT NOT NULL, conv_id TEXT NOT NULL,
    source_message_id TEXT, intent TEXT NOT NULL, payload TEXT NOT NULL,
    status TEXT NOT NULL, result TEXT, evidence TEXT, origin TEXT NOT NULL DEFAULT 'qq',
    proposer_peer_id TEXT, approver_peer_id TEXT, idempotency_key TEXT UNIQUE,
    attempts INTEGER NOT NULL DEFAULT 0, expires_ms INTEGER, created_ms INTEGER NOT NULL,
    updated_ms INTEGER NOT NULL);`);
  ensureColumns(db, 'external_tasks', ['evidence','origin','proposer_peer_id','approver_peer_id','idempotency_key','attempts','expires_ms']);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS external_tasks_idempotency ON external_tasks(idempotency_key) WHERE idempotency_key IS NOT NULL;");
  db.prepare("UPDATE external_tasks SET status='unknown',updated_ms=? WHERE status IN ('approved','running')").run(Date.now());
  for(const row of db.prepare("SELECT id FROM external_tasks WHERE status IN ('awaiting_confirmation','awaiting_publish') AND expires_ms IS NOT NULL AND expires_ms<?").all(Date.now())){
    db.prepare("UPDATE external_tasks SET status='expired',updated_ms=? WHERE id=?").run(Date.now(),row.id);
    updateWorkingTask(db,row.id,{status:'expired'},Date.now());
    recordAgentEvent(db,{eventType:'task_state_changed',channel:'system',taskId:row.id,actor:'system',payload:{status:'expired',reason:'超时没人确认，自己过期了'},dedupeKey:`task:${row.id}:expired`});
  }
  recoverWorkingTasks(db);
}

/**
 * 正则意图识别。实现已经搬到 connect/core/task.mjs（和路由决策共用一份），
 * 这里只保留一个转发口，老调用方不用改。
 */
export function parseExternalIntent(text) {
  return intentFromText(text);
}

export function proposeTask(db,{kind,convId,sourceMessageId,intent,proposerPeerId=null,origin='qq',expiresMs=Date.now()+15*60_000,now=Date.now()}) {
  const idem=`${origin}:${kind}:${convId}:${sourceMessageId}:${intent.intent}:${intent.operations.join(',')}`;
  const existing=db.prepare('SELECT * FROM external_tasks WHERE idempotency_key=?').get(idem);if(existing)return existing;
  const id=`task_${randomUUID()}`;
  db.prepare('INSERT INTO external_tasks(id,conv_kind,conv_id,source_message_id,intent,payload,status,origin,proposer_peer_id,idempotency_key,expires_ms,created_ms,updated_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id,kind,convId,sourceMessageId,intent.intent,JSON.stringify(intent),'awaiting_confirmation',origin,proposerPeerId,idem,expiresMs,now,now);
  createWorkingTask(db, { taskId: id, goal: intent.intent, environment: { channel: origin, conversation_kind: kind, conversation_id: convId }, deadlineMs: expiresMs, now });
  recordAgentEvent(db,{eventType:'task_state_changed',channel:origin,conversationId:convId,taskId:id,actor:proposerPeerId??'system',payload:{status:'awaiting_confirmation',intent:intent.intent},dedupeKey:`task:${id}:awaiting`});
  // 闸门：这条任务停下来了，等一个「同意/拒绝」。页面「闸门」段靠它点亮。
  recordAgentEvent(db,{eventType:'approval_requested',channel:origin,conversationId:convId,taskId:id,actor:proposerPeerId??'system',payload:{status:'awaiting_confirmation',intent:intent.intent,operations:intent.operations},dedupeKey:`approval:${id}:requested`});
  return db.prepare('SELECT * FROM external_tasks WHERE id=?').get(id);
}

/**
 * D-1：自主目标的一次推进也登记成统一 AgentTask（external_tasks 的一行）。
 * 这样 goals → goal_progress → AgentTask 是一条能追的链：
 * 目标（BRAIN 库 goals）→ 当日推进（BRAIN 库 goal_progress.task_id）→ 统一任务（CONNECT 库 external_tasks）。
 * 幂等键用 goal+day，同一天重复推进只登记一次。
 */
export function createGoalTask(db, { goalId, day, goal = '', intent = 'goal.explore', origin = 'life', now = Date.now(), risk = 'R0', result = null } = {}) {
  if (!goalId || !day) throw new Error('goal_task_requires_goal_and_day');
  const idem = `${origin}:goal:${goalId}:${day}`;
  const existing = db.prepare('SELECT * FROM external_tasks WHERE idempotency_key=?').get(idem);
  if (existing) return existing;
  const id = `task_goal_${randomUUID()}`;
  const payload = { goal_id: goalId, day, origin, risk };
  db.prepare(`INSERT INTO external_tasks
    (id,conv_kind,conv_id,source_message_id,intent,payload,status,origin,idempotency_key,created_ms,updated_ms,result)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, 'c2c', `goal:${goalId}`, `life:${day}:${intent}`, intent, JSON.stringify(payload), 'succeeded', origin, idem, now, now, JSON.stringify(result ?? {}));
  try { createWorkingTask(db, { taskId: id, goal: goal || intent, environment: { channel: origin, conversation_kind: 'c2c', conversation_id: `goal:${goalId}` }, now }); } catch { /* 看板镜像缺列不影响任务本身。 */ }
  try { recordAgentEvent(db, { eventType: 'task_state_changed', channel: 'system', taskId: id, actor: 'system', payload: { status: 'succeeded', goal_id: goalId, intent }, dedupeKey: `task:${id}:succeeded` }); } catch { /* 事件表不可用不影响任务本身。 */ }
  return db.prepare('SELECT * FROM external_tasks WHERE id=?').get(id);
}

export function latestPendingTask(db,kind,convId) {
  return db.prepare("SELECT * FROM external_tasks WHERE conv_kind=? AND conv_id=? AND status IN ('awaiting_confirmation','awaiting_publish') ORDER BY created_ms DESC LIMIT 1").get(kind,convId)??null;
}

export function taskPayload(row){try{return JSON.parse(row.payload);}catch{return null;}}

/** 批准 pending 任务，并告诉调用方批准前是哪一阶段（awaiting_confirmation / awaiting_publish）。 */
export function approvePendingTask(db,id,approverPeerId='owner',now=Date.now()) {
  const before=db.prepare('SELECT status FROM external_tasks WHERE id=?').get(id)?.status??null;
  const result=db.prepare("UPDATE external_tasks SET status='approved',approver_peer_id=?,updated_ms=? WHERE id=? AND status IN ('awaiting_confirmation','awaiting_publish') AND (expires_ms IS NULL OR expires_ms>?)").run(approverPeerId,now,id,now);
  if (result.changes===1) updateWorkingTask(db, id, { status: 'pending' }, now);
  if (result.changes===1) recordAgentEvent(db,{eventType:'task_state_changed',channel:'system',taskId:id,actor:approverPeerId,payload:{status:'approved'},dedupeKey:`task:${id}:approved`});
  if (result.changes===1) recordAgentEvent(db,{eventType:'approval_resolved',channel:'system',taskId:id,actor:approverPeerId,payload:{decision:'approved',was:before},dedupeKey:`approval:${id}:approved`});
  return { ok: result.changes === 1, previous: before };
}

export function approveTask(db,id,approverPeerId='owner',now=Date.now()) {
  return approvePendingTask(db,id,approverPeerId,now).ok;
}

/** 内容准备好、停在发布页等爸爸二审：不进 completed，改成 awaiting_publish 并刷新有效期。 */
export function markAwaitingPublish(db,id,{prepared=null,now=Date.now()}={}) {
  const result=db.prepare("UPDATE external_tasks SET status='awaiting_publish',result=?,updated_ms=?,expires_ms=? WHERE id=? AND status='running'").run(JSON.stringify(prepared??{}),now,now+30*60_000,id);
  if(result.changes===1){
    updateWorkingTask(db, id, { status: 'waiting_verification' }, now);
    recordAgentEvent(db,{eventType:'task_state_changed',channel:'system',taskId:id,actor:'system',payload:{status:'awaiting_publish'},dedupeKey:`task:${id}:awaiting_publish`});
  }
  return result.changes===1;
}

export function startTask(db,id,now=Date.now()) {
  const result=db.prepare("UPDATE external_tasks SET status='running',attempts=attempts+1,updated_ms=? WHERE id=? AND status='approved'").run(now,id);
  if (result.changes===1) updateWorkingTask(db, id, { status: 'running', retryCount: Number(db.prepare('SELECT attempts FROM external_tasks WHERE id=?').get(id)?.attempts ?? 1) }, now);
  if (result.changes===1) recordAgentEvent(db,{eventType:'action_started',channel:'system',taskId:id,actor:'system',payload:{status:'running'},dedupeKey:`task:${id}:running:${now}`});
  return result.changes===1;
}

/** 仅日程白名单动作可跳过人工审批，直接从待处理进入运行。 */
export function startAutomaticTask(db,id,now=Date.now()) {
  const row=db.prepare('SELECT origin,payload,status,expires_ms FROM external_tasks WHERE id=?').get(id);
  const payload=row ? taskPayload(row) : null;
  const operations=payload?.operations;
  if(row?.origin!=='plan'||row.status!=='awaiting_confirmation'||(row.expires_ms!==null&&row.expires_ms<=now)
    ||payload?.requires_confirmation!==false||!Array.isArray(operations)||operations.length!==1||!AUTO_ACTIONS.has(operations[0]))return false;
  const changed=db.prepare("UPDATE external_tasks SET status='running',attempts=attempts+1,updated_ms=? WHERE id=? AND status='awaiting_confirmation'").run(now,id).changes;
  if(!changed)return false;
  updateWorkingTask(db,id,{status:'running',retryCount:Number(db.prepare('SELECT attempts FROM external_tasks WHERE id=?').get(id)?.attempts??1)},now);
  recordAgentEvent(db,{eventType:'action_started',channel:'system',taskId:id,actor:'scheduler',payload:{status:'running',authorization:'automatic',operation:operations[0]},dedupeKey:`task:${id}:running:${now}`});
  return true;
}

/** 日常内容已写好但尚未触碰发布页，直接挂起等主人审稿。 */
export function markPreparedTask(db,id,{prepared=null,now=Date.now()}={}) {
  const row=db.prepare('SELECT origin,payload,status,expires_ms FROM external_tasks WHERE id=?').get(id);
  const payload=row ? taskPayload(row) : null;
  if(row?.origin!=='plan'||row.status!=='awaiting_confirmation'||(row.expires_ms!==null&&row.expires_ms<=now)
    ||payload?.requires_confirmation!==true||payload.operations?.length!==1||payload.operations[0]!=='douyin.publish')return false;
  const changed=db.prepare("UPDATE external_tasks SET status='awaiting_publish',result=?,updated_ms=?,expires_ms=? WHERE id=? AND status='awaiting_confirmation'")
    .run(JSON.stringify(prepared??{}),now,now+30*60_000,id).changes;
  if(!changed)return false;
  updateWorkingTask(db,id,{status:'waiting_verification'},now);
  recordAgentEvent(db,{eventType:'task_state_changed',channel:'system',taskId:id,actor:'scheduler',payload:{status:'awaiting_publish',authorization:'owner_required'},dedupeKey:`task:${id}:awaiting_publish`});
  return true;
}

export function completeTask(db,id,{ok,result},now=Date.now()) {
  db.prepare('UPDATE external_tasks SET status=?,result=?,evidence=?,attempts=attempts+1,updated_ms=? WHERE id=?').run(ok?'succeeded':'failed',JSON.stringify(result??{}),JSON.stringify(result??{}),now,id);
  updateWorkingTask(db, id, { status: ok ? 'succeeded' : 'failed' }, now);
  recordAgentEvent(db,{eventType:ok?'action_finished':'action_failed',channel:'system',taskId:id,actor:'system',result:{ok:Boolean(ok),result:result??{}},evidence:result??{},payload:{status:ok?'succeeded':'failed'},dedupeKey:`task:${id}:${ok?'succeeded':'failed'}:${now}`});
}

export function listTasks(db,{status,limit=50}={}){const safe=Math.min(Math.max(Number(limit)||50,1),200);return status?db.prepare('SELECT id,conv_kind,conv_id,intent,status,origin,proposer_peer_id,approver_peer_id,attempts,expires_ms,created_ms,updated_ms,result,evidence FROM external_tasks WHERE status=? ORDER BY created_ms DESC LIMIT ?').all(status,safe):db.prepare('SELECT id,conv_kind,conv_id,intent,status,origin,proposer_peer_id,approver_peer_id,attempts,expires_ms,created_ms,updated_ms,result,evidence FROM external_tasks ORDER BY created_ms DESC LIMIT ?').all(safe);}
export function task(db,id){return db.prepare('SELECT * FROM external_tasks WHERE id=?').get(id)??null;}
export function cancelTask(db,id,now=Date.now(),reason=''){const result=db.prepare("UPDATE external_tasks SET status='cancelled',updated_ms=? WHERE id=? AND status IN ('awaiting_confirmation','awaiting_publish','approved')").run(now,id);if(result.changes===1){updateWorkingTask(db,id,{status:'cancelled'},now);recordAgentEvent(db,{eventType:'task_state_changed',channel:'system',taskId:id,actor:'owner',payload:{status:'cancelled',reason:reason||'没记原因'},dedupeKey:`task:${id}:cancelled`});recordAgentEvent(db,{eventType:'approval_resolved',channel:'system',taskId:id,actor:'owner',payload:{decision:'cancelled',reason:reason||'没记原因'},dedupeKey:`approval:${id}:cancelled`});}return result.changes===1;}
