export const MESSAGES_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>大肥鱼 · 消息中心</title>
<link rel="stylesheet" href="/shell/nav.css">
<script src="/shell/nav.js" defer></script>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;background:#0f1115;color:#e9edf3;font:15px/1.5 -apple-system,"PingFang SC",system-ui,sans-serif}
header{position:sticky;top:0;z-index:2;display:flex;gap:10px;align-items:center;padding:14px 18px;background:rgba(15,17,21,.92);backdrop-filter:blur(12px);border-bottom:1px solid #1e2430}
h1{font-size:16px;margin:0;font-weight:600}
.chips{display:flex;gap:6px;margin-left:auto}
.chip{border:1px solid #2a3240;background:#161b23;color:#aeb8c6;border-radius:999px;padding:4px 12px;font-size:13px;cursor:pointer}
.chip.on{background:#2b6cf6;border-color:#2b6cf6;color:#fff}
main{max-width:860px;margin:0 auto;padding:16px 18px 60px;display:flex;flex-direction:column;gap:10px}
.row{display:flex;flex-direction:column;max-width:78%}
.row.out{margin-left:auto;align-items:flex-end}
.meta{font-size:11px;color:#7d8798;margin:0 4px 3px;display:flex;gap:6px;align-items:center}
.badge{font-size:10px;border-radius:4px;padding:0 4px;border:1px solid #333d4d;color:#9aa6b6}
.bubble{padding:9px 12px;border-radius:12px;background:#1b212b;border:1px solid #242c38;white-space:pre-wrap;word-break:break-word}
.row.out .bubble{background:#173a63;border-color:#1e4c80}
.voice{color:#8fb7e8}
.status{font-size:10px;color:#6b7686;margin-top:3px}
.empty{color:#7d8798;text-align:center;padding:40px 0}
footer{position:fixed;left:0;right:0;bottom:0;padding:10px 18px;background:rgba(15,17,21,.95);border-top:1px solid #1e2430;font-size:12px;color:#7d8798;display:flex;gap:12px}
</style></head>
<body>
<header><h1>大肥鱼 · 消息中心</h1><div class="chips">
<button class="chip on" data-filter="all">全部</button>
<button class="chip" data-filter="wechat">微信</button>
<button class="chip" data-filter="qq">QQ</button>
</div></header>
<main id="list"><div class="empty">加载中…</div></main>
<footer><span id="stat">–</span><span>桌宠气泡只显示前 40 字，点开这里看全文</span></footer>
<script>
const token = new URLSearchParams(location.search).get('token') || '';
const list = document.getElementById('list');
const stat = document.getElementById('stat');
let filter = 'all';
let items = [];
let firstPaint = true;
const fmt = t => { const d = new Date(t); return isNaN(d) ? '' : d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); };
function render() {
  const shown = items.filter(i => filter === 'all' || i.source === filter);
  if (!shown.length) { list.innerHTML = '<div class="empty">还没有消息</div>'; return; }
  list.replaceChildren(...shown.map(i => {
    const row = document.createElement('div');
    row.className = 'row ' + (i.direction === 'out' ? 'out' : 'in');
    const meta = document.createElement('div');
    meta.className = 'meta';
    const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = i.source === 'qq' ? 'QQ·' + i.kind : i.kind;
    meta.append(badge, document.createTextNode(i.label + ' · ' + (i.direction === 'out' ? '大肥鱼' : fmt(i.time))));
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (i.inputKind === 'voice' && i.direction === 'in') { const v = document.createElement('span'); v.className = 'voice'; v.textContent = '🎤 '; bubble.append(v); }
    bubble.append(document.createTextNode(i.text || '（空）'));
    const status = document.createElement('div');
    status.className = 'status';
    status.textContent = i.direction === 'in' ? ('状态：' + (i.status || '?') + (i.error ? ' · ' + i.error : '')) : '';
    row.append(meta, bubble, status);
    return row;
  }));
  // 只在「本来就在底部」或第一次进来时才跟到最新，否则每 2 秒刷新会把正在翻旧消息的人拽回底部。
  const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 160;
  if (firstPaint || atBottom) window.scrollTo({ top: document.body.scrollHeight });
  firstPaint = false;
}
async function refresh() {
  try {
    const r = await fetch('/messages/feed?limit=60', { headers: { authorization: 'Bearer ' + token } });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    items = data.items || [];
    stat.textContent = '共 ' + items.length + ' 条 · 每 2 秒刷新';
    render();
  } catch (e) { stat.textContent = '刷新失败：' + e.message; }
}
document.querySelectorAll('.chip').forEach(chip => chip.addEventListener('click', () => {
  filter = chip.dataset.filter;
  document.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c === chip));
  render();
}));
if (!token) stat.textContent = '缺少 token：用 npm run connect:messages 生成链接';
refresh(); setInterval(refresh, 2000);
</script></body></html>`;
