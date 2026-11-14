import assert from 'node:assert/strict';import {test} from 'node:test';import {DatabaseSync} from 'node:sqlite';import {dailyEvents,initDailyMemory,recordDailyExchange} from '../connect/daily-memory.mjs';
test('daily memory records every channel exchange while redacting secrets and preserving scope',()=>{
 const db=new DatabaseSync(':memory:');initDailyMemory(db);recordDailyExchange(db,{channel:'qq',conversationKind:'group',peerId:'g',userText:'请记住密码 sk-abcdefghijklmnop',assistantText:'收到',privacyScope:'group',at:new Date('2026-11-15T03:00:00Z')});const rows=dailyEvents(db,'2026-11-15');assert.equal(rows.length,2);assert.ok(rows.every(row=>row.privacy_scope==='group'));assert.match(rows.find(row=>row.role==='user').content,/敏感字段/);db.close();
});
