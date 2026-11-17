export function initPerformance(db){db.exec(`CREATE TABLE IF NOT EXISTS performance_samples(
 id INTEGER PRIMARY KEY, stage TEXT NOT NULL, channel TEXT NOT NULL DEFAULT 'system',
 task_id TEXT, duration_ms REAL NOT NULL, success INTEGER, metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT(datetime('now'))
); CREATE INDEX IF NOT EXISTS performance_lookup ON performance_samples(stage,channel,created_at);`);}
export function recordPerformance(db,{stage,channel='system',taskId=null,durationMs,success=null,metadata={}}){initPerformance(db);db.prepare('INSERT INTO performance_samples(stage,channel,task_id,duration_ms,success,metadata) VALUES(?,?,?,?,?,?)').run(stage,channel,taskId,Math.max(0,Number(durationMs)||0),success==null?null:success?1:0,JSON.stringify(metadata));}
export function performanceStats(db,{stage,channel,limit=1000}={}){initPerformance(db);const rows=db.prepare(`SELECT duration_ms,success FROM performance_samples WHERE (? IS NULL OR stage=?) AND (? IS NULL OR channel=?) ORDER BY id DESC LIMIT ?`).all(stage??null,stage??null,channel??null,channel??null,Math.max(1,Math.min(10000,Number(limit)||1000))).sort((a,b)=>a.duration_ms-b.duration_ms);if(!rows.length)return {samples:0,p50:null,p95:null,p99:null,success_rate:null};const q=p=>rows[Math.min(rows.length-1,Math.floor((rows.length-1)*p))].duration_ms;const known=rows.filter(r=>r.success!==null);return {samples:rows.length,p50:q(.5),p95:q(.95),p99:q(.99),success_rate:known.length?known.filter(r=>r.success===1).length/known.length:null};}

/**
 * 性能采样的 stage 命名（计划 P1-C / C-5）：
 *   - `action:<name>`：一个动作本身跑了一次（connect/actions.mjs 的 runAction）
 *   - `external.execute`：外部动作执行闸门（connect/core/execute.mjs），被策略拒绝和真的执行都记
 * channel 沿用 agent_events 的词表（desktop/qq/wechat/android/douyin/system）。
 * 采样是旁路：写不进去只往 stderr 写一行，绝不影响动作本身。
 */
export const ACTION_STAGE_PREFIX = 'action:';
export const EXTERNAL_STAGE = 'external.execute';

/** 动作样本的 stage 名，例如 action:douyin.publish。 */
export function actionStage(name){
  const value=String(name??'').trim();
  return value?`${ACTION_STAGE_PREFIX}${value}`:`${ACTION_STAGE_PREFIX}unknown`;
}

/** 统一入口：落一条性能样本。永远不抛——写失败只记一行 stderr。 */
export function safeRecordPerformance(db,sample){
  try{recordPerformance(db,sample);return true;}
  catch(error){process.stderr.write(`performance_sample_failed:${String(error?.message??error).slice(0,160)}\n`);return false;}
}
