/** Shared channel-to-core contract. Channel adapters normalize into this shape. */
import { createHash, randomUUID } from 'node:crypto';
import { invalidStatuses } from './core/capability.mjs';
import { atomicCapabilityCards, atomicCapabilityMatrix } from './memory/capabilities.mjs';
// 状态词表统一到 connect/core/capability.mjs（real_verified→stable）。R-10 收口。
// 矩阵本身不再手写第二份：从 connect/memory/capabilities.mjs 的 12 张能力卡派生（B-2）。
export const CAPABILITY_MATRIX=Object.freeze(atomicCapabilityMatrix());
if (invalidStatuses(CAPABILITY_MATRIX).length) throw new Error('capability_status_vocab_mismatch');
export function normalizeCoreRequest({channel,conversationKind='direct',peerId,peerRole='unknown',text,inputKind='text',messageId,metadata={}}){
  if(!['desktop','ilink','qq','call'].includes(channel))throw new Error('invalid_core_channel');
  if(!['direct','group'].includes(conversationKind)||!['text','voice'].includes(inputKind))throw new Error('invalid_core_context');
  if(typeof text!=='string'||!text.trim()||text.length>4000)throw new Error('invalid_core_text');
  return Object.freeze({channel,conversation_kind:conversationKind,peer_id:String(peerId??''),peer_role:peerRole,input_kind:inputKind,message_id:String(messageId??''),text:text.trim(),metadata:{...metadata}});
}
export function interactionEvent({
  channel, accountId = '', conversationKind = 'direct', conversationId,
  senderId, senderRole = 'unknown', text = '', inputKind = 'text',
  sourceEventId = '', occurredAt = new Date(), receivedAt = new Date(),
} = {}) {
  if (!['desktop', 'qq', 'wechat', 'android', 'douyin', 'call'].includes(channel)) throw new Error('invalid_interaction_channel');
  if (!['direct', 'group', 'public'].includes(conversationKind)) throw new Error('invalid_interaction_conversation');
  if (!['text', 'voice', 'event'].includes(inputKind)) throw new Error('invalid_interaction_content');
  if (!conversationId || !senderId) throw new Error('invalid_interaction_identity');
  const source = String(sourceEventId ?? '');
  const stableKey = source
    ? JSON.stringify([channel, accountId, conversationKind, conversationId, source])
    : null;
  const eventId = stableKey
    ? createHash('sha256').update(stableKey).digest('hex')
    : randomUUID();
  const scope = conversationKind === 'group' ? 'group'
    : conversationKind === 'public' ? 'public'
      : senderRole === 'owner' ? 'private' : 'friend';
  return Object.freeze({
    event_id: eventId,
    trace_id: eventId,
    event_type: inputKind === 'event' ? 'platform.event' : 'message.received',
    channel,
    agent_id: 'dafeiyu',
    sender: Object.freeze({
      platform_user_id: String(senderId),
      canonical_person_id: senderRole === 'owner' && scope === 'private' ? 'owner' : null,
      role: senderRole,
    }),
    conversation: Object.freeze({
      account_id: String(accountId),
      conversation_id: String(conversationId),
      type: conversationKind,
    }),
    content: Object.freeze({ type: inputKind, text: String(text) }),
    source_context: Object.freeze({ platform_event_id: source || null }),
    trust: Object.freeze({
      source_class: scope,
      instruction_trust: senderRole === 'owner' && scope === 'private'
        ? 'verified_user_input' : 'untrusted_user_input',
    }),
    permissions_context: Object.freeze({ scopes: scope === 'private' ? ['conversation', 'task.request'] : ['conversation'] }),
    occurred_at: new Date(occurredAt).toISOString(),
    received_at: new Date(receivedAt).toISOString(),
  });
}
export function capabilityText(channel,{group=false}={}){
  // 能力文案从能力卡派生（B-2）：状态与说明只有一份，渠道不再各写一套。
  const lines=['能力状态必须以系统回执为准，不得把模型承诺当成执行结果。'];
  for(const card of atomicCapabilityCards()){
    if(card.scope==='always')lines.push(`${card.label}：${card.note}`);
    else if(card.scope==='group'&&group)lines.push(`${card.label}：${card.note}`);
  }
  return lines.join('\n');
}
