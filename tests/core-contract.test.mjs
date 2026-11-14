import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CAPABILITY_MATRIX,capabilityText,normalizeCoreRequest} from '../connect/core-contract.mjs';

test('core contract normalizes all channels and rejects untrusted shapes',()=>{
 const r=normalizeCoreRequest({channel:'qq',conversationKind:'group',peerId:'g1',text:'帮我看看',inputKind:'text'});
 assert.equal(r.channel,'qq');assert.equal(r.conversation_kind,'group');assert.equal(r.input_kind,'text');
 assert.throws(()=>normalizeCoreRequest({channel:'unknown',text:'x'}),/invalid_core_channel/);
 assert.throws(()=>normalizeCoreRequest({channel:'qq',text:''}),/invalid_core_text/);
});
test('capability declaration makes disabled and unimplemented actions explicit',()=>{
 assert.equal(CAPABILITY_MATRIX.native_voice_out,'disabled');assert.equal(CAPABILITY_MATRIX.douyin_like_comments,'not_implemented');assert.match(capabilityText('qq',{group:true}),/群聊外部动作：已冻结/u);
});
