// 一次真跑的证据包：不依赖页面，粘到哪都能看懂。
//
// 一次「跑通了」由四样东西组成：
//   1. 回执（谁跑的、什么时候、结果是什么）
//   2. 判定（verdict + reason，机器判的）
//   3. 跑后核对（真去查库/查系统看到什么）
//   4. 相关事件（库里留下的痕迹，可复核）

const cut = (text, max) => {
  const raw = String(text ?? '').replace(/\r/g, '');
  return raw.length > max ? `${raw.slice(0, max)}…（共 ${raw.length} 字）` : raw;
};

/** @returns {string} markdown */
export function renderEvidence({ action, at, title, verdict, reason, elapsedMs, text, after, events, origin }) {
  const lines = [];
  const clock = at ? new Date(Number(at) || at).toLocaleString('zh-CN', { hour12: false }) : '—';
  lines.push(`### ${title && title !== action ? `${title}（${action}）` : action}`);
  lines.push('');
  lines.push(`- 时间：${clock}`);
  lines.push(`- 来源：${origin === 'ui' ? '页面手动跑' : '定时任务 / 脚本'}`);
  lines.push(`- 耗时：${Number(elapsedMs ?? 0)} ms`);
  lines.push(`- 判定：**${verdict ?? 'unknown'}**${reason ? `（${reason}）` : ''}`);
  lines.push('');
  if (text) {
    lines.push('做了什么 / 实际结果：');
    lines.push('');
    lines.push('```');
    lines.push(cut(text, 1200));
    lines.push('```');
    lines.push('');
  }
  if (after && (after.checks ?? []).length) {
    lines.push(`跑完之后核对：**${after.verdict ?? 'unknown'}**${after.reason ? `（${after.reason}）` : ''}`);
    lines.push('');
    for (const check of after.checks) lines.push(`- ${check.ok ? '✅' : '❌'} ${check.key}：${cut(check.detail, 160)}`);
    lines.push('');
  } else if (after) {
    lines.push(`跑完之后核对：**${after.verdict ?? 'unknown'}**（这个动作没有可自动核对的东西）`);
    lines.push('');
  }
  if ((events ?? []).length) {
    lines.push(`库里留下的事件（${events.length} 条）：`);
    lines.push('');
    lines.push('| 时间 | 事件 | 摘要 |');
    lines.push('|---|---|---|');
    for (const event of events.slice(0, 12)) {
      lines.push(`| ${event.clock ?? '—'} | \`${event.eventType ?? ''}\` | ${cut(event.summary ?? '', 80) || '—'} |`);
    }
    lines.push('');
  }
  lines.push('> 这段可以直接贴给任何人复核：判定是机器给的，核对项是真去查过的，事件是库里查得到的。');
  return lines.join('\n');
}
