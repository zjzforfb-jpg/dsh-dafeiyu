// 已下线的动作：从动作表里移除了，但留一份可查的记录。
//
// 为什么单独存一份：菜单里少了一项，人只会觉得「怎么没了」；
// 写清「什么时候因为什么下线」，下次想重做时才知道踩过什么坑。
export const RETIRED_ACTIONS = [
  {
    action: 'douyin.like_comments',
    label: '给抖音相关评论点赞',
    retiredAt: '2026-11-18',
    reason: '适配层没有可验证的点赞结果，旧实现直接抛 douyin_like_not_implemented',
    replacedBy: null,
  },
  {
    action: 'douyin.prepare',
    label: '准备一条抖音图文（旧流程）',
    retiredAt: '2026-11-18',
    reason: '旧的一审流程已被「草稿 → 人工二审 → 发布」两段式取代',
    replacedBy: 'douyin.draft → douyin.publish_draft',
  },
  {
    action: 'douyin.hotspot',
    label: '看今天有什么热点',
    retiredAt: '2026-11-18',
    reason: '抖音搜索页改成视频流形态（全屏竖向滑动，按返回是换视频），结果列表读不到；原解析器依赖「标题+日期」锚点',
    replacedBy: 'douyin.browse（刷推荐流记录看到什么）',
  },
];

/** 按动作名查已下线记录（页面/脚本共用）。 */
export function retiredOf(action) {
  return RETIRED_ACTIONS.find((entry) => entry.action === action) ?? null;
}
