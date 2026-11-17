/**
 * 判定结论的「人话」词汇表——四处（/live 工具卡、/live 定时行、/home 能力卡、/flow 节点）
 * 必须用同一套说法，否则同一个原因在四个页面会写成四种句子。
 */

export const VERDICT_LABEL = {
  confirmed: '已确认',
  unconfirmed: '未确认',
  mismatched: '对不上',
  failed: '失败',
  skipped: '跳过',
};

export const REASON_LABEL = {
  nothing_to_do: '没活干',
  no_evidence: '没拿到证据',
  no_result_data: '没返回数据',
  awaiting_external_event: '等外部事件',
  count_zero: '一条也没成',
  detail_not_opened: '打不开视频',
  comment_panel_not_open: '评论面板没开',
  work_not_found: '没找到作品',
  result_not_found: '没搜到结果',
  missing_count: '没带回数量',
};

/** `Command failed: node … / 抖音操作失败：…` 这种长串，只取第二行里的关键信号。 */
export function commandLabel(reason) {
  if (!/^Command failed/u.test(String(reason))) return '';
  const line = String(reason).split('\n')[1] ?? '';
  if (/detail_not_opened/u.test(line)) return '打不开视频';
  if (/comment_panel_not_open/u.test(line)) return '评论面板没开';
  if (/device_offline|no devices|adb/u.test(line)) return '手机没连上';
  return '脚本报错';
}

/** 一行理由：标题/卡片上用，尽量短；完整原文交给 tooltip。 */
export function reasonText(reason) {
  if (!reason || reason === 'ok') return '';
  const fromCommand = commandLabel(reason);
  if (fromCommand) return fromCommand;
  if (REASON_LABEL[reason]) return REASON_LABEL[reason];
  // 额度用完导致的跳过：这不算失败，是「今天先不发了」
  const quota = /^quota_exhausted:(\d+)\/(\d+)$/u.exec(reason);
  if (quota) return `评论额度用完（本小时 ${quota[1]}/${quota[2]}），先不发`;
  // nothing_to_do(5):no_content×3,already_replied×2 —— 括号里是扫了几条，冒号后是跳过原因分布
  const empty = /^nothing_to_do(?:\((\d+)\))?(?::(.+))?$/u.exec(reason);
  if (empty) {
    const scanned = empty[1] ? `扫了 ${empty[1]} 条` : '';
    const parts = (empty[2] ?? '').split(',').filter(Boolean).slice(0, 2).map((item) => {
      const [key, n] = item.split('×');
      const label = { no_content: '只有表情', already_replied: '已回过', nothing_new: '没新评论', not_sent: '没发出去' }[key] ?? key;
      return n ? `${label} ${n}` : label;
    });
    return ['没活干', scanned, parts.join(' / ')].filter(Boolean).join(' · ');
  }
  const m = /^count=(\d+)<(\d+)$/u.exec(reason);
  if (m) return `只成 ${m[1]} 条（要求 ≥${m[2]}）`;
  const blocked = /^blocked:(.+)$/u.exec(reason);
  if (blocked) return `被闸门挡住：${blocked[1]}`;
  return String(reason).slice(0, 24);
}

/** 时刻：同一天只显示 HH:MM，跨天带 M/D。 */
export function shortClock(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
