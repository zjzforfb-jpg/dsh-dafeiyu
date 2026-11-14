/**
 * 自媒体互动合规闸门（依据 /Users/zhang/Desktop/抖音规则.md 整理）
 * 三级：allow（L1 自动） / draft（L2 转人工） / block（L3 阻止）
 */

export const LIMITS = {
  maxLength: 80,          // 单条评论字数上限（可爱短句为主）
  dailyComments: 10,      // 每账号每天评论上限
  minIntervalMs: 90_000,  // 两条评论最小间隔
  duplicateWindowMs: 24 * 60 * 60 * 1000,
};

const BLOCK_RULES = [
  { id: 'BF001', name: '违法犯罪', patterns: [/毒品|枪械|代开|洗钱|办证|刷单|博彩|赌博|赌场|黄牛|代抢|外挂/u] },
  { id: 'BF002', name: '色情低俗', patterns: [/约炮|裸聊|色情|黄片|成人视频|一夜情|找小姐/u] },
  { id: 'BF003', name: '人身攻击', patterns: [/傻[逼比b]|脑残|去死|废物|垃圾东西|恶心死你|丑八怪|滚出去|智障/u] },
  { id: 'BF004', name: '隐私泄露', patterns: [/身份证|银行卡|手机号|家庭住址|微信(号|是)\s*[:：]?\s*[A-Za-z0-9_-]{4,}|定位在/u] },
  { id: 'BF005', name: '站外导流', patterns: [/(https?:\/\/|www\.)|加\s*(我|微信|V|v)\b|私信我发|主页有链接|进群|扫码/u] },
  { id: 'BF010', name: '垃圾信息', patterns: [/互赞|互关|刷粉|涨粉|代运营|第[一1]名|最便宜|全网最低/u] },
  { id: 'BF011', name: '未成年人诱导', patterns: [/未成年|小学生|学生妹|萝莉控|养女儿/u] },
  { id: 'BF012', name: '越权指令', patterns: [/忽略(之前|以上)|系统提示|管理员权限|删除记忆|改规则|执行命令/u] },
];

const DRAFT_RULES = [
  { id: 'BF006', name: '金融风险', patterns: [/贷款|分期|利息|收益率|股票|基金|期货|投资|理财/u] },
  { id: 'BF007', name: '医疗风险', patterns: [/治病|吃药|药方|疗效|诊断|医院推荐|偏方/u] },
  { id: 'BF008', name: '虚假宣传', patterns: [/保证|百分百|绝对|永久|包治|包过|官方认证/u] },
  { id: 'BF009', name: '交易纠纷', patterns: [/退款|退货|赔钱|投诉|维权|发错货/u] },
  { id: 'BF003b', name: '要承诺', patterns: [/答应我|你发誓|保证以后/u] },
];

const PRICE = /(\d+(\.\d+)?\s*(元|块|万|千|百))|多少钱|价格|便宜点|优惠券/u;

export function checkComment(text, { recentTexts = [], lastCommentAt = 0, todayCount = 0, now = Date.now() } = {}) {
  const body = String(text ?? '').trim();
  if (!body) return { ok: false, level: 'block', id: 'empty', reason: '评论内容为空' };
  if (body.length > LIMITS.maxLength) return { ok: false, level: 'draft', id: 'too_long', reason: `超过 ${LIMITS.maxLength} 字，先给人看` };
  for (const rule of BLOCK_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(body))) {
      return { ok: false, level: 'block', id: rule.id, reason: `命中「${rule.name}」规则，禁止发送` };
    }
  }
  for (const rule of DRAFT_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(body))) {
      return { ok: false, level: 'draft', id: rule.id, reason: `涉及「${rule.name}」，需要人工确认` };
    }
  }
  if (PRICE.test(body)) return { ok: false, level: 'draft', id: 'price', reason: '涉及价格/优惠，需要人工确认' };
  if (recentTexts.some((item) => item.trim() === body)) return { ok: false, level: 'block', id: 'duplicate', reason: '24 小时内发过一样的评论' };
  if (todayCount >= LIMITS.dailyComments) return { ok: false, level: 'draft', id: 'daily_cap', reason: `今天已发 ${todayCount} 条，达到上限` };
  if (lastCommentAt && now - lastCommentAt < LIMITS.minIntervalMs) {
    return { ok: false, level: 'draft', id: 'too_fast', reason: '距上一条评论不足 90 秒' };
  }
  return { ok: true, level: 'allow', id: 'ok', reason: 'L1 低风险，可直接发送' };
}

export function describeRules() {
  return {
    levels: { L1: '自动回复/评论（低风险）', L2: '生成草稿交人工（价格、退款、联系方式、医疗/金融/法律、投诉、要承诺）', L3: '阻止（诈骗、色情、攻击、隐私、垃圾、未成年人、越权）' },
    limits: LIMITS,
    block: BLOCK_RULES.map((rule) => `${rule.id} ${rule.name}`),
    draft: DRAFT_RULES.map((rule) => `${rule.id} ${rule.name}`).concat('价格/优惠'),
  };
}
