// 互动：待回复 / 爆款热评（两段切换）
import { esc, fmt, tag, commentRow, hotRow, pagerHtml, sparkHtml, setHtml, clockHM, toast } from '../ui.mjs';

export const meta = { id: 'interact', title: '互动', badge: (snap) => snap?.status?.unreplied ?? 0 };

export function mount(host, ctx) {
  const state = {
    seg: 'pending',
    pending: { page: 1, size: 8 },
    replied: null,
    hot: { videoId: null, filter: '', page: 1, size: 8 },
    videos: null,
  };
  host.innerHTML = '<div id="interactRoot"></div>';
  const root = host.querySelector('#interactRoot');

  async function loadPending() {
    state.pendingData = await ctx.api.list('comments', { replied: 'no', page: state.pending.page, size: state.pending.size });
    state.repliedData = await ctx.api.list('comments', { replied: 'yes', page: 1, size: 5 });
  }
  async function loadHot() {
    state.videosData = await ctx.api.list('videos', { page: 1, size: 20 });
    if (!state.hot.videoId && state.videosData.items?.length) {
      const withComments = state.videosData.items.find((v) => (v.comment_count ?? 0) > 0);
      state.hot.videoId = (withComments ?? state.videosData.items[0]).id;
    }
    state.hotData = await ctx.api.list('hot', { work: state.hot.videoId ?? '', replied: state.hot.filter, page: state.hot.page, size: state.hot.size });
  }
  async function refreshAll() {
    if (state.seg === 'pending') await loadPending(); else await loadHot();
    render(ctx.snapshot);
  }

  root.addEventListener('click', async (event) => {
    const seg = event.target.closest('[data-i]');
    if (seg) { state.seg = seg.dataset.i; await refreshAll(); return; }
    const pager = event.target.closest('[data-pager]');
    if (pager) {
      const sec = pager.dataset.pager; const page = Number(pager.dataset.page); if (!page) return;
      if (sec === 'pendingComments') { state.pending.page = page; await loadPending(); }
      if (sec === 'hotComments') { state.hot.page = page; await loadHot(); }
      render(ctx.snapshot); return;
    }
    const filter = event.target.closest('[data-f]');
    if (filter) { state.hot.filter = filter.dataset.f; state.hot.page = 1; await loadHot(); render(ctx.snapshot); return; }
    const item = event.target.closest('[data-video]');
    if (item) { state.hot.videoId = item.dataset.video; state.hot.page = 1; await loadHot(); render(ctx.snapshot); return; }
    if (event.target.closest('[data-reply-hint]')) toast('回复入口在 QQ 里说「把收到的评论都回一遍」，或者等日程自动回。');
  });
  root.addEventListener('change', async (event) => {
    const size = event.target.closest('[data-size]'); if (!size) return;
    const n = Number(size.value) || 8;
    if (size.dataset.size === 'pendingComments') { state.pending = { page: 1, size: n }; await loadPending(); }
    if (size.dataset.size === 'hotComments') { state.hot = { ...state.hot, page: 1, size: n }; await loadHot(); }
    render(ctx.snapshot);
  });

  function render(snap) {
    if (!snap) return;
    const status = snap.status ?? {};
    const pulse = snap.pulse ?? {};
    const pend = state.pendingData ?? { items: [], total: 0, pages: 1, page: 1, size: 8 };
    const replied = state.repliedData ?? { items: [], total: 0, pages: 1, page: 1, size: 5 };
    const trend = (snap.fans?.trend ?? []).slice(-7).map((d) => d.interactions ?? 0);
    const nextRound = (snap.plan?.slots ?? []).filter((s) => s.action === 'douyin.hot_comment_round' && s.status === 'planned');
    const nextText = nextRound.length ? `下一轮 ${clockHM(nextRound[0].at)}` : '今天的热评轮次都过了';

    const pendingView = `
      <div class="grid cols-12">
        <div class="card w8">
          <header><span class="t">待回复</span><span class="n">${pend.total ?? 0}</span><span class="sp">${pend.total ? tag('wait', `有 ${pend.total} 条等你`) : ''}</span></header>
          <div class="list">${(pend.items ?? []).map((c) => commentRow(c)).join('') || '<div class="empty">没有待回复的评论，都回完了。</div>'}</div>
          ${(pend.items ?? []).length ? pagerHtml('pendingComments', pend, { sizes: [8, 16] }) : ''}
          <header style="margin-top:8px"><span class="t">今天回过的</span><span class="n">${replied.total ?? 0}</span></header>
          <div class="list">${(replied.items ?? []).map((c) => `<div class="row"><div class="avatar">${esc(String(c.author ?? '?').slice(0, 1))}</div><div class="body"><div class="l1">${esc(c.author)} · ${esc(c.text || '（只有图片）')}</div><div class="l2" style="color:#bff2cd">${esc(c.reply_text ?? '')} · ${esc(clockHM(c.replied_at))}</div></div><div class="side">${tag('ok', '已回')}</div></div>`).join('') || '<div class="empty">今天还没回过评论。</div>'}</div>
        </div>
        <div class="card w4">
          <header><span class="t">互动概览</span><span class="sp">${tag('', '近 7 天')}</span></header>
          <div class="row"><div class="body"><div class="l1">收到评论</div><div class="l2">${status.comments ?? 0} 条 · 回复率 ${status.comments ? Math.round((((status.comments ?? 0) - (status.unreplied ?? 0)) / status.comments) * 100) : 0}%</div></div></div>
          <div class="row"><div class="body"><div class="l1">爆款下回复</div><div class="l2">${status.hot_replied ?? 0} 条 / 热评 ${status.hot_comments ?? 0} 条</div></div></div>
          <div class="row"><div class="body"><div class="l1">粉丝</div><div class="l2">${pulse.fans ?? 0} 个 · 互动 ${pulse.interactions ?? 0} 次</div></div></div>
          <div class="meta">每天 5 轮热评 × 2 视频 × 2 条，限速 90 秒 / 5 条每小时</div>
          ${trend.length > 1 ? sparkHtml(trend, { height: 70 }) : ''}
          <div class="pager" style="padding-top:12px"><span>${esc(nextText)}</span></div>
        </div>
      </div>`;

    const videos = state.videosData ?? { items: [] };
    const hot = state.hotData ?? { items: [], total: 0, pages: 1, page: 1, size: 8 };
    const videoRow = (v) => `<div class="witem${v.id === state.hot.videoId ? ' on' : ''}" data-video="${esc(v.id)}"><div class="ph">🔥</div><div><div class="t">${esc(v.title)}</div><div class="m">❤ ${esc(fmt(v.likes))} · 热评 ${v.comment_count ?? 0} · 已回 ${v.replied_count ?? 0}</div></div></div>`;
    const hotView = `
      <div class="works" style="height:auto;grid-template-columns:360px 1fr">
        <section class="card">
          <header><span class="t">爆款视频</span><span class="n">${videos.total ?? (videos.items ?? []).length}</span></header>
          <div class="scroll">${(videos.items ?? []).map(videoRow).join('') || '<div class="empty">还没发现爆款视频。</div>'}</div>
        </section>
        <section class="card">
          <header><span class="t">热评</span><span class="n">${hot.total ?? 0}</span><span class="sp"><span class="seg">${[['', '全部'], ['no', '未回复'], ['yes', '已回复']].map(([f, label]) => `<button class="${state.hot.filter === f ? 'on' : ''}" data-f="${f}">${label}</button>`).join('')}</span></span></header>
          <div class="scroll">${(hot.items ?? []).map((h, i) => hotRow(h, i)).join('') || '<div class="empty">这个视频还没有热评记录。</div>'}</div>
          ${(hot.items ?? []).length ? pagerHtml('hotComments', hot, { sizes: [8, 16] }) : ''}
        </section>
      </div>`;

    setHtml(root, `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
        <div class="seg">${[['pending', '待回复'], ['hot', '爆款热评']].map(([k, label]) => `<button class="${state.seg === k ? 'on' : ''}" data-i="${k}">${label}</button>`).join('')}</div>
        <span style="font-size:12px;color:var(--on-var)"><b style="color:var(--on)">待回复 ${status.unreplied ?? 0}</b> · 今天已回 ${pulse.comments_today ?? 0} · 爆款下累计 ${status.hot_replied ?? 0}</span>
      </div>
      <div style="display:${state.seg === 'pending' ? 'block' : 'none'}">${pendingView}</div>
      <div style="display:${state.seg === 'hot' ? 'block' : 'none'}">${hotView}</div>`);
  }

  refreshAll().catch((error) => console.error(error));
  return { update: (snap) => render(snap), activate: () => refreshAll() };
}
