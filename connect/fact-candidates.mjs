import { randomUUID } from 'node:crypto';

export function initFactCandidates(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_fact_candidates(
    id TEXT PRIMARY KEY, source_event_id INTEGER, day TEXT, subject TEXT NOT NULL,
    predicate TEXT NOT NULL, object_text TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.5,
    status TEXT NOT NULL DEFAULT 'candidate' CHECK(status IN ('candidate','confirmed','rejected','superseded')),
    evidence TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  ); CREATE INDEX IF NOT EXISTS fact_candidates_lookup ON memory_fact_candidates(status,subject,predicate,created_at);`);
}
const enc=v=>{try{return JSON.stringify(v??{});}catch{return '{}';}};
export function extractFactCandidates(db, day, { limit = 500 } = {}) {
  initFactCandidates(db); const safe=Math.max(1,Math.min(2000,Number(limit)||500));
  const rows=db.prepare("SELECT id,day,content,key_info,channel,conversation_kind FROM daily_memory_events WHERE day=? AND role='user' ORDER BY id LIMIT ?").all(day,safe); const out=[];
  for(const row of rows){const text=String(row.content??'');let match=text.match(/(?:我|爸爸)?(?:最)?喜欢(?:的)?[：:，,\s]*(.{2,120})$/u);let predicate='preference';if(!match)match=text.match(/(?:请)?(?:记住|记下)[：:，,\s]*(.{2,160})$/u),predicate='fact';if(!match)continue;const objectText=match[1].trim();const existing=db.prepare('SELECT id FROM memory_fact_candidates WHERE source_event_id=?').get(row.id);if(existing)continue;const id=`candidate_${randomUUID()}`;db.prepare('INSERT INTO memory_fact_candidates(id,source_event_id,day,subject,predicate,object_text,confidence,evidence) VALUES(?,?,?,?,?,?,?,?)').run(id,row.id,row.day,'owner',predicate,objectText,predicate==='fact'?0.85:0.7,enc({channel:row.channel,conversation_kind:row.conversation_kind}));out.push(id);}return out; }
export function listFactCandidates(db,{status='candidate',limit=100}={}){initFactCandidates(db);return db.prepare('SELECT * FROM memory_fact_candidates WHERE status=? ORDER BY created_at DESC LIMIT ?').all(status,Math.max(1,Math.min(500,Number(limit)||100)));}

export function confirmFactCandidate(db, id, { reason = 'owner_confirmed' } = {}) {
  initFactCandidates(db); const candidate=db.prepare("SELECT * FROM memory_fact_candidates WHERE id=? AND status='candidate'").get(String(id)); if(!candidate) return null;
  const content=candidate.predicate==='preference'?`爸爸喜欢${candidate.object_text}`:candidate.object_text;
  db.exec('BEGIN IMMEDIATE'); try {
    const old=db.prepare("SELECT id FROM memory_facts WHERE subject=? AND predicate=? AND status='confirmed' ORDER BY id DESC LIMIT 1").get(candidate.subject,candidate.predicate);
    const turn=db.prepare('INSERT INTO turns(user_text,assistant_text) VALUES(?,?)').run(`候选事实确认：${content}`,reason);
    const memory=db.prepare("INSERT OR IGNORE INTO memories(content,source_turn_id,kind,source,confidence) VALUES(?,?,?,?,?)").run(content,turn.lastInsertRowid,'user_fact','candidate_confirmed',candidate.confidence);
    const memoryId=Number(memory.lastInsertRowid); if(memoryId) db.prepare('INSERT OR IGNORE INTO memory_facts(memory_id,subject,predicate,object_text,status,confidence,source,supersedes_id) VALUES(?,?,?,?,?,?,?,?)').run(memoryId,candidate.subject,candidate.predicate,candidate.object_text,'confirmed',candidate.confidence,'candidate_confirmed',old?.id??null);
    if(old?.id) db.prepare("UPDATE memory_facts SET status='superseded',valid_to=datetime('now'),updated_at=datetime('now') WHERE id=?").run(old.id);
    db.prepare("UPDATE memory_fact_candidates SET status='confirmed',updated_at=datetime('now') WHERE id=?").run(id);
    db.exec('COMMIT'); return { candidate:db.prepare('SELECT * FROM memory_fact_candidates WHERE id=?').get(id), memoryId, supersededMemoryFactId:old?.id??null };
  } catch(error){db.exec('ROLLBACK');throw error;}
}

export function rejectFactCandidate(db, id, reason = 'owner_rejected') { initFactCandidates(db); db.prepare("UPDATE memory_fact_candidates SET status='rejected',evidence=json_set(evidence,'$.rejection_reason',?),updated_at=datetime('now') WHERE id=? AND status='candidate'").run(String(reason).slice(0,300),id); return db.prepare('SELECT * FROM memory_fact_candidates WHERE id=?').get(id)??null; }
export function listFactConflicts(db,{limit=100}={}) { initFactCandidates(db); return db.prepare("SELECT subject,predicate,COUNT(*) AS versions,GROUP_CONCAT(object_text,' || ') AS values_text FROM memory_facts WHERE status IN ('confirmed','superseded') GROUP BY subject,predicate HAVING COUNT(*)>1 ORDER BY subject,predicate LIMIT ?").all(Math.max(1,Math.min(500,Number(limit)||100))); }
export function restoreMemoryFact(db, factId, reason = 'owner_restore') { initFactCandidates(db); const old=db.prepare("SELECT * FROM memory_facts WHERE id=? AND status='superseded'").get(Number(factId)); if(!old)return null; db.exec('BEGIN IMMEDIATE'); try { db.prepare("UPDATE memory_facts SET status='superseded',updated_at=datetime('now') WHERE subject=? AND predicate=? AND status='confirmed'").run(old.subject,old.predicate); db.prepare("UPDATE memory_facts SET status='confirmed',valid_to=NULL,updated_at=datetime('now'),source=? WHERE id=?").run(reason,Number(factId)); db.prepare("UPDATE memories SET active=1,include_context=1 WHERE id=?").run(old.memory_id); db.exec('COMMIT'); return db.prepare('SELECT * FROM memory_facts WHERE id=?').get(Number(factId)); } catch(error){db.exec('ROLLBACK');throw error;} }
