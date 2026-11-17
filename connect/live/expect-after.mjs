// 「跑完之后应该看到什么」的纯数据（浏览器与 Node 共用，别在这里 import node:sqlite）。

/** 每个动作「跑完应该看到什么」，写成用户能读的句子。 */
export const EXPECT_AFTER = {
  'qq.call': ['QQ 通话窗口出现并计时（有秒数）', '挂断后事件流出现 call_ended，带「接通/时长」'],
  'qq.call_mom': ['同上，对端是「小朋友」'],
  'wechat.call': ['微信窗口出现通话界面', '挂断后事件流出现 call_ended'],
  'qq.hangup': ['通话窗口消失（不再有计时）', '事件流出现 call_ended（结局 ended/cancelled）'],
  'douyin.publish': ['作品页第一格出现新作品', '作品表新增一条 status=published'],
  'douyin.publish_draft': ['作品页出现该作品', '待审草稿 pending.json 消失'],
  'douyin.publish_video': ['作品页出现新视频，时长与源文件一致（±1s）'],
  'douyin.reply_comments': ['回复数 >0，或明确写清「没活干」（只有表情/已回过）', '作者看到的评论串里出现自己的回复'],
  'douyin.hot_comment_round': ['每个爆款视频下回 1 条；没有可回时写「没活干」', '事件流里 action_finished 带 count'],
  'douyin.comment_latest': ['最新作品下多一条自己的评论', 'RESULT_JSON 里 sent=true'],
  'douyin.check_interactions': ['读到互动条数（评论/赞/新粉丝）', 'activity 停在互动消息页'],
  'douyin.draft': ['runtime/douyin/drafts/ 新增一个 json', '草稿里有标题与正文'],
  'douyin.browse': ['记录里多一条「看到什么」', '不产生任何写操作'],
  'academy.study': ['成长档案新增一课（study_sessions +1）', '消息里给出本课要点'],
  'academy.weekly': ['本周周记落库（growth_archive）', '摘要包含本周任务/作品数'],
};

/** 真正有「外部副作用」（会响手机 / 公开发作品）的 7 个：这些才需要主人放行与第一次真跑操作单。
 *  其余动作的「跑完应该看到」是给判定和文档用的，不涉及对外影响。 */
export const SIDE_EFFECT_ACTIONS = [
  'qq.call', 'qq.call_mom', 'wechat.call', 'qq.hangup',
  'douyin.publish', 'douyin.publish_draft', 'douyin.publish_video',
];
