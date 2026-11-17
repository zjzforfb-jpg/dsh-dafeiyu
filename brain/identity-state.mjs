export function initIdentityState(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS identity_state(
    id INTEGER PRIMARY KEY CHECK(id=1), mood TEXT NOT NULL DEFAULT '平静', energy REAL NOT NULL DEFAULT 0.8,
    curiosity REAL NOT NULL DEFAULT 0.7, focus TEXT, reason TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  ); INSERT OR IGNORE INTO identity_state(id) VALUES(1);`);
}
export function getIdentityState(db){initIdentityState(db);return db.prepare('SELECT * FROM identity_state WHERE id=1').get();}
export function updateIdentityState(db,{mood,energy,curiosity,focus,reason='system'}={}){initIdentityState(db);const current=getIdentityState(db);const next={mood:mood??current.mood,energy:energy==null?current.energy:Math.max(0,Math.min(1,Number(energy))),curiosity:curiosity==null?current.curiosity:Math.max(0,Math.min(1,Number(curiosity))),focus:focus??current.focus,reason:String(reason).slice(0,300)};db.prepare('UPDATE identity_state SET mood=?,energy=?,curiosity=?,focus=?,reason=?,updated_at=datetime(\'now\') WHERE id=1').run(next.mood,next.energy,next.curiosity,next.focus,next.reason);return getIdentityState(db);}
