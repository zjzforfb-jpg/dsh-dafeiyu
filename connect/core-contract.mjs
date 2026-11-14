/** Shared channel-to-core contract. Channel adapters normalize into this shape. */
export const CAPABILITY_MATRIX=Object.freeze({chat_text:'stable',chat_voice_in:'real_verified',voice_file_out:'real_verified',native_voice_out:'disabled',external_actions:'disabled',douyin_read_interactions:'prototype',douyin_reply_comments:'prototype',douyin_like_comments:'not_implemented',douyin_publish:'prototype',group_external_actions:'disabled',android_observe:'real_verified',android_control:'prototype'});
export function normalizeCoreRequest({channel,conversationKind='direct',peerId,peerRole='unknown',text,inputKind='text',messageId,metadata={}}){
  if(!['desktop','ilink','qq','call'].includes(channel))throw new Error('invalid_core_channel');
  if(!['direct','group'].includes(conversationKind)||!['text','voice'].includes(inputKind))throw new Error('invalid_core_context');
  if(typeof text!=='string'||!text.trim()||text.length>4000)throw new Error('invalid_core_text');
  return Object.freeze({channel,conversation_kind:conversationKind,peer_id:String(peerId??''),peer_role:peerRole,input_kind:inputKind,message_id:String(messageId??''),text:text.trim(),metadata:{...metadata}});
}
export function capabilityText(channel,{group=false}={}){const lines=['能力状态必须以系统回执为准，不得把模型承诺当成执行结果。','文字聊天：可用。','语音输入：可用；回复默认使用音频文件。','微信原生语音气泡：已关闭。','外部动作：当前统一停在任务确认层，未收到确认和真实回执不会执行。','抖音读取互动：原型能力，必须经过任务确认。','抖音回复评论：原型能力，必须经过任务确认和真实回执。','抖音点赞：尚未实现。','抖音发布：原型能力，必须经过审批和真实回执。'];if(group)lines.push('群聊外部动作：已冻结，不能执行抖音、电话、发布或点赞。');return lines.join('\n');}
