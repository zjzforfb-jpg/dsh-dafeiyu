import assert from 'node:assert/strict';import {test} from 'node:test';import {createReceipt,validateReceipt} from '../connect/receipts.mjs';
test('receipts distinguish success, failure and unknown without claiming completion',()=>{
 const ok=createReceipt({operation:'douyin.reply_comments',adapter:'douyin',result:{ok:true,text:'sent=2'}});const fail=createReceipt({operation:'douyin.like_comments',adapter:'douyin',result:{ok:false,error:'not_implemented'}});const unknown=createReceipt({operation:'x',result:{}});
 assert.equal(ok.status,'succeeded');assert.equal(fail.status,'failed');assert.equal(unknown.status,'unknown');assert.equal(validateReceipt(ok),true);assert.equal(validateReceipt({status:'succeeded'}),false);
});
