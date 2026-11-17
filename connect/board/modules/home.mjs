// 概览：预警条 + 脉搏四卡 + 待确认/正在执行 + 心情 + 日程 + 最近完成
import { esc, fmt, pct, tag, taskRow, pagerHtml, sparkHtml, setHtml, clockHM, toast } from '../ui.mjs';

// 日程失败原因说人话：原始 note 常常是一整行 `Command failed: node …`，看板这一行只放最短的判断
export function reasonOf(note) {
  const text = String(note ?? '');
  if (!text) return '';
  if (/^manual_run_ok/u.test(text)) return '已人工跑通';
  const quota = /^quota_exhausted:(\d+)\/(\d+)$/u.exec(text);
  if (quota) return `评论额度用完（${quota[1]}/${quota[2]}）`;
  if (/^retry:/u.test(text)) return '环境抖动后重试';
  if (/^skipped:pending_task/u.test(text)) return '已有待审草稿，跳过';
  if (/detail_not_opened/u.test(text)) return '打不开视频';
  if (/comment_panel_not_open/u.test(text)) return '评论面板没开';
  if (/interactions_unconfirmed/u.test(text)) return '没读到互动列表';
  if (/publish_unconfirmed/u.test(text)) return '点了发布但没看到作品';
  if (/nothing_to_do/u.test(text)) return '没活干';
  if (/device|adb|no devices/iu.test(text)) return '手机没连上';
  if (/Command failed/u.test(text)) return '脚本报错（详情看 /live）';
  return text.slice(0, 40);
}

export const meta = { id: 'home', title: '概览', badge: (snap) => (snap?.pending?.length ?? 0) };

export function mount(host, ctx) {
  const state = { page: 1, size: 8, finished: null };
  host.innerHTML = '<div id="homeRoot"></div>';
  const root = host.querySelector('#homeRoot');

  async function loadFinished() {
    state.finished = await ctx.api.list('finished', { page: state.page, size: state.size });
  }

  async function approve(id) {
    const r = await ctx.api.approveTask(id);
    toast(r.ok ? '已同意，手机那边会收到提示' : '没成：' + (r.error ?? 'unknown'));
    await ctx.refresh();
  }
  async function cancel(id) {
    const r = await ctx.api.cancelTask(id);
    toast(r.ok ? '已作废，我不会动它了' : '没成：' + (r.error ?? 'unknown'));
    await ctx.refresh();
  }

  host.addEventListener('click', async (event) => {
    const act = event.target.closest('[data-act]');
    if (act) { event.preventDefault(); await (act.dataset.act === 'approve' ? approve(act.dataset.id) : cancel(act.dataset.id)); return; }
    const moodBtn = event.target.closest('[data-mood]');
    if (moodBtn) {
      const r = await ctx.api.moodAction(moodBtn.dataset.mood);
      if (moodBtn.dataset.mood === 'comfort') toast(r.ok ? `已发给爸爸：${r.text}` : '没发出去');
      if (moodBtn.dataset.mood === 'energy') toast(r.ok ? `能量充到 ${Math.round((r.energy ?? 0) * 100)}%` : '没加成');
      if (moodBtn.dataset.mood === 'rest') toast(r.ok ? `今天先不派活了，跳过 ${r.skipped} 件` : '没改成功');
      await ctx.refresh(); return;
    }
    const pager = event.target.closest('[data-pager]');
    if (pager) {
      const p = Number(pager.dataset.page); if (!p) return;
      state.page = p; await loadFinished(); render(ctx.snapshot); return;
    }
    const size = event.target.closest('[data-size]');
    if (size) { state.size = Number(size.value) || 8; state.page = 1; await loadFinished(); render(ctx.snapshot); }
  });
  host.addEventListener('change', async (event) => {
    const size = event.target.closest('[data-size]');
    if (size) { state.size = Number(size.value) || 8; state.page = 1; await loadFinished(); render(ctx.snapshot); }
  });

  function render(snap) {
    if (!snap) return;
    const pulse = snap.pulse ?? {};
    const tasks = pulse.tasks_today ?? {};
    const ran = (tasks.succeeded ?? 0) + (tasks.failed ?? 0);
    const rate = ran ? Math.round(((tasks.succeeded ?? 0) / ran) * 100) : 0;
    const pending = snap.pending ?? [];
    const running = snap.running ?? [];
    const mood = snap.mood ?? {};
    const trend = (snap.moodTrend ?? []).slice(-7);
    const slots = snap.plan?.slots ?? [];
    const skipped = slots.filter((s) => s.status === 'skipped').length;
    const done = slots.filter((s) => s.status === 'done').length;
    const fin = state.finished ?? { items: snap.finished ?? [], page: 1, size: 8, total: snap.finished_total ?? 0, pages: 1 };

    const banner = pending.length
      ? `<div class="banner">📌 <b>${pending.length} 条待你确认</b>：${esc(pending[0].payload?.args?.theme ?? pending[0].payload?.theme ?? '一条任务')} · 点「同意」我就动手<button class="x" data-v="content">去处理</button></div>`
      : '';

    const pulseHtml = `
      <div class="pulse">
        <div class="pcard"><div class="lab">模型额度</div><div class="val">${pulse.model_calls ?? 0} 次</div><div class="bar"><i style="width:${pct(pulse.model_calls, pulse.model_budget ?? 50)}%"></i></div><div class="sub">今天已用 ${pulse.model_calls ?? 0}/${pulse.model_budget ?? 50}</div></div>
        <div class="pcard"><div class="lab">今日执行</div><div class="val">${tasks.succeeded ?? 0} 成 / ${tasks.failed ?? 0} 败</div><div class="bar"><i class="${rate >= 80 ? '' : 'warn'}" style="width:${rate}%"></i></div><div class="sub">实际跑了 ${ran} 个 · 取消 ${tasks.cancelled ?? 0} · 过期 ${tasks.expired ?? 0}</div></div>
        <div class="pcard"><div class="lab">今日评论</div><div class="val">${pulse.comments_today ?? 0}</div><div class="sub">未回复 ${pulse.unreplied ?? 0} 条</div></div>
        <div class="pcard"><div class="lab">粉丝</div><div class="val">${pulse.fans ?? 0}</div><div class="sub">累计互动 ${pulse.interactions ?? 0} 次</div></div>
      </div>`;

    const pendingRows = pending.length
      ? pending.map((t) => taskRow(t, { act: true })).join('')
      : '<div class="empty">现在没有等你确认的事。</div>';
    const runningRows = running.length
      ? running.map((t) => taskRow(t)).join('')
      : '<div class="empty">现在手上没活儿。</div>';

    const moodHtml = mood.mood
      ? `<div style="font-size:13px;color:var(--on-var)">${esc(mood.why ?? '')}</div>
         <div class="meta">精力 ${Math.round((mood.energy ?? 0) * 100)}%${mood.valence ? ' · 心情指数 ' + Math.round(mood.valence * 100) + '%' : ''}</div>
         ${trend.length > 1 ? sparkHtml(trend.map((d) => Math.max(6, Math.round((d.energy ?? 0) * 100))), { height: 56 }) : `<div class="bar"><i style="width:${Math.max(2, Math.round((mood.energy ?? 0) * 100))}%"></i></div>`}`
      : '<div class="empty">今天还没生成心情。</div>';

    const moodActions = `<div class="acts" style="margin-top:10px">
        <button class="chip" data-mood="comfort">说句安慰</button>
        <button class="chip" data-mood="energy">加点能量</button>
        <button class="chip" data-mood="rest">今天少派活</button>
      </div>`;

    const planRows = slots.length
      ? slots.map((s) => {
        const cls = s.status === 'done' ? 'ok' : s.status === 'skipped' ? 'bad' : s.status === 'waiting' ? 'wait' : '';
        const label = { done: 'done', skipped: 'skipped', waiting: 'waiting', planned: 'planned', fired: '待执行' }[s.status] ?? s.status;
        return `<div class="row ${cls}"><span class="clock">${esc(clockHM(s.at))}</span><div class="body"><div class="l1">${esc(ctxLabel(s.action))}</div><div class="l2">${esc(label)}${s.note ? ' · ' + esc(reasonOf(s.note)) : ''}</div></div></div>`;
      }).join('')
      : '<div class="empty">今天还没有日程。</div>';

    const finishedRows = (fin.items ?? []).length
      ? fin.items.map((t) => taskRow(t)).join('')
      : '<div class="empty">还没有跑完的任务。</div>';

    setHtml(root, `
      ${banner}
      ${pulseHtml}
      <div class="grid cols-12">
        <div class="card w8">
          <header><span class="t">待你确认</span><span class="n">${pending.length}</span><span class="sp"><button class="chip" data-v="content">按时间</button></span></header>
          <div class="list">${pendingRows}</div>
          <header style="margin-top:8px"><span class="t">正在执行</span><span class="n">${running.length}</span></header>
          <div class="list">${runningRows}</div>
        </div>
        <div class="card w4">
          <header><span class="t">今日心情</span><span class="sp">${mood.mood ? tag('ok', mood.mood) : ''}</span></header>
          ${moodHtml}
          ${moodActions}
        </div>
        <div class="card w5">
          <header><span class="t">今日日程</span><span class="n">计划 ${slots.length} 件 · 已完成 ${done} 件</span><span class="sp">${skipped ? tag('', '跳过 ' + skipped) : ''}</span></header>
          <div class="tl">${planRows}</div>
        </div>
        <div class="card w7">
          <header><span class="t">最近完成</span><span class="n">${fin.total ?? 0}</span><span class="sp">${tag('', `${fin.page}/${fin.pages} 页`)}</span></header>
          <div class="list">${finishedRows}</div>
          ${pagerHtml('finished', fin, { sizes: [8, 12, 20] })}
        </div>
      </div>`);
  }

  function ctxLabel(action) {
    const map = {
      'douyin.check_interactions': '查互动', 'douyin.reply_comments': '回评论', 'douyin.hot_comment_round': '爆款热评',
      'douyin.daily_post': '写日常图文', 'douyin.prepare': '准备图文', 'academy.study': '成长学院', 'academy.weekly': '成长日记', 'douyin.hotspot': '热点观察',
    };
    return map[action] ?? action;
  }

  root.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-v]');
    if (btn) ctx.navigate(btn.dataset.v);
  });

  loadFinished().then(() => render(ctx.snapshot)).catch((error) => console.error(error));
  return {
    update: (snap) => render(snap),
    activate: () => loadFinished().then(() => render(ctx.snapshot)),
  };
}
