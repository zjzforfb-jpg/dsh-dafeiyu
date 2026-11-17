// 共享视图工具：只负责「把数据变成示例页里的那种 DOM 片段」。
const CLOCK = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false });
const DATE = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit' });

export function decode(v) {
  return String(v ?? '')
    .replace(/&#10;/gu, ' ')
    .replace(/&quot;/gu, '"').replace(/&#39;/gu, "'")
    .replace(/&lt;/gu, '<').replace(/&gt;/gu, '>')
    .replace(/&amp;/gu, '&');
}

export const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function fmt(n) {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return '0';
  if (v >= 10000) return (v / 10000).toFixed(v >= 100000 ? 0 : 1).replace(/\.0$/, '') + '万';
  return String(Math.round(v));
}
export function clockHM(iso) { const d = iso ? new Date(iso) : new Date(); return Number.isNaN(d.getTime()) ? '' : CLOCK.format(d); }
export function dateShort(iso) { const d = iso ? new Date(iso) : new Date(); return Number.isNaN(d.getTime()) ? '' : DATE.format(d); }
export function pct(a, b) { return b > 0 ? Math.min(100, Math.round((a / b) * 100)) : 0; }

export const OP_CN = {
  'qa': '问答',
  'douyin.publish': '发图文',
  'douyin.publish_draft': '发图文',
  'douyin.draft': '写图文',
  'douyin.reply_comments': '回评论',
  'douyin.check_interactions': '查互动',
  'douyin.hot_comment_round': '爆款热评',
  'douyin.hotspot': '热点观察',
  'academy.study': '成长学院',
  'academy.weekly': '成长日记',
};
export function opName(op) {
  const raw = String(op ?? '').trim();
  if (!raw) return '任务';
  return OP_CN[raw] ?? OP_CN[raw.replace(/^douyin\./, '')] ?? OP_CN['douyin.' + raw] ?? raw;
}

const STATUS = {
  succeeded: { cls: 'ok', text: '成功', icon: '✅' },
  failed: { cls: 'bad', text: '失败', icon: '❌' },
  cancelled: { cls: '', text: '已取消', icon: '🚫' },
  expired: { cls: '', text: '已过期', icon: '⌛' },
  running: { cls: 'run', text: '执行中', icon: '▶' },
  approved: { cls: 'run', text: '已批准', icon: '▶' },
  awaiting_confirmation: { cls: 'wait', text: '待确认', icon: '⏳' },
  awaiting_publish: { cls: 'wait', text: '待发布', icon: '📝' },
  pending: { cls: 'wait', text: '待确认', icon: '⏳' },
};
export function statusOf(t) { return STATUS[t?.status] ?? { cls: '', text: t?.status ?? '-', icon: '•' }; }

export function taskTitle(t) {
  const name = opName((t?.operations ?? [])[0]);
  const payload = t?.payload ?? {};
  const args = payload.args ?? {};
  const theme = args.theme ?? payload.theme;
  return theme ? `${name}「${theme}」` : name;
}
export function taskDetail(t) {
  const payload = t?.payload ?? {};
  if (t?.status === 'awaiting_publish') return '正文已写好，配图已生成 · 等你回「同意」';
  if (t?.status === 'awaiting_confirmation') return payload.args?.theme ? `主题「${payload.args.theme}」· 等你回「同意」` : '等你回「同意」我再动手';
  if (t?.status === 'running') return '正在手机上操作…';
  const result = t?.result?.detail ?? t?.result?.[0]?.detail ?? '';
  const text = String(result).split('\n')[0].slice(0, 80);
  if (text) return text;
  const fallback = { cancelled: '被我作废了', expired: '超时过期了', awaiting_publish: '正文已写好，图也配好了', awaiting_confirmation: '等你回「同意」' };
  return fallback[t?.status] ?? '—';
}

export function tag(cls, text) { return `<span class="tag ${cls}">${esc(text)}</span>`; }

export function taskRow(t, { act = false } = {}) {
  const st = statusOf(t);
  const side = act
    ? `${tag(st.cls, st.text)}<button class="chip" data-act="approve" data-id="${esc(t.id)}">${t.status === 'awaiting_publish' ? '确认发布' : '同意'}</button><button class="chip" data-act="cancel" data-id="${esc(t.id)}">作废</button>`
    : tag(st.cls, st.text);
  return `<div class="row"><div class="avatar">${st.icon}</div><div class="body"><div class="l1">${esc(taskTitle(t))} · ${esc(t.id?.slice(-8) ?? '')}</div><div class="l2">${esc(taskDetail(t))}${t.reason ? ` · 原因：${esc(t.reason)}` : ''} · ${esc(clockHM(t.updated_ms ? new Date(Number(t.updated_ms)).toISOString() : t.created_at))}</div></div><div class="side">${side}</div></div>`;
}

export function commentRow(c, { showWork = true, act = false } = {}) {
  const replied = Boolean(c.replied_at);
  const who = String(c.author ?? '?').trim().slice(0, 1) || '?';
  const meta = [showWork ? c.work_title : null, c.comment_at].filter(Boolean).join(' · ');
  const reply = replied && c.reply_text
    ? `<div class="l2" style="color:#bff2cd">回复：${esc(decode(c.reply_text))}</div>`
    : '';
  const side = act
    ? `<button class="chip" data-act="reply" data-id="${esc(c.id)}">回一句</button><button class="chip" data-act="skip" data-id="${esc(c.id)}">跳过</button>`
    : tag(replied ? 'ok' : 'wait', replied ? '已回' : '未回复');
  return `<div class="row"><div class="avatar">${esc(who)}</div><div class="body"><div class="l1">${esc(c.author)}</div><div class="l2">${esc(decode(c.text) || '（只有图片或表情）')}${meta ? ' · ' + esc(meta) : ''}</div>${reply}</div><div class="side">${side}</div></div>`;
}

export function hotRow(h, i) {
  const replied = Boolean(h.replied_at);
  const reply = replied && h.reply_text ? `<div class="l2" style="color:#bff2cd">回复：${esc(decode(h.reply_text))}</div>` : '';
  return `<div class="row"><div class="avatar">${i + 1}</div><div class="body"><div class="l1">${esc(decode(h.text))}</div><div class="l2">❤ ${esc(fmt(h.likes))} · ${esc(h.video_title ?? '')}${h.created_at ? ' · ' + esc(dateShort(h.created_at)) : ''}</div>${reply}</div><div class="side">${tag(replied ? 'ok' : 'wait', replied ? '已回' : '未回')}</div></div>`;
}

export function pagerHtml(name, data, { sizes = [5, 8, 10, 20] } = {}) {
  const { page = 1, size = 8, total = 0, pages = 1 } = data ?? {};
  const btn = (label, p, on) => `<button class="btn ${on ? 'on' : ''}" data-pager="${name}" data-page="${p}" ${on ? '' : p < 1 || p > pages ? 'disabled' : ''}>${label}</button>`;
  const nums = [];
  for (let p = 1; p <= pages; p += 1) { if (p === 1 || p === pages || Math.abs(p - page) <= 1) nums.push(btn(String(p), p, p === page)); else if (nums[nums.length - 1] !== '…') nums.push('…'); }
  const opts = sizes.map((s) => `<option value="${s}" ${s === size ? 'selected' : ''}>每页 ${s}</option>`).join('');
  return `<div class="pager">${btn('‹', page - 1, false)}${nums.map((n) => (n === '…' ? '<span>…</span>' : n)).join('')}${btn('›', page + 1, false)}<span class="sp">共 ${total} 条 · 第 ${page}/${pages} 页</span><select data-size="${name}">${opts}</select></div>`;
}

export function sparkHtml(values, { height = 56 } = {}) {
  const nums = values.map((v) => Number(v) || 0);
  const max = Math.max(1, ...nums);
  const min = Math.min(...nums);
  const flat = max === min;
  return `<div class="spark" style="height:${height}px">${nums.map((v) => `<i style="height:${flat ? 45 : Math.max(6, Math.round((v / max) * 90))}%"></i>`).join('')}</div>`;
}

export function setHtml(el, html) { if (el && el.innerHTML !== html) el.innerHTML = html; }
export function toast(msg) {
  document.querySelectorAll('.toast').forEach((n) => n.remove());
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}
