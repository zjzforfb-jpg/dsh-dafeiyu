// 系统：时间线 / 健康 / 成本
import { esc, tag, pagerHtml, sparkHtml, setHtml, clockHM } from '../ui.mjs';

export const meta = { id: 'system', title: '系统', badge: () => 0 };

const EVENT_CN = {
  message_received: '收到消息', message_replied: '回复消息', task_state_changed: '任务状态', action_started: '开始执行',
  action_finished: '执行完成', action_failed: '执行失败', task_reported: '任务汇报', plan_tick: '日程检查', mood_day: '心情生成',
};

const SKILL_KIND = { draft_resume: '草稿弹窗', discard_confirm: '退出确认', ad: '广告', network: '网络' };
const SKILL_CN = {
  'academy.study': '成长学院学一步',
  'academy.weekly': '写每周成长日记',
  'douyin.browse': '刷一会儿抖音',
  'douyin.like_comments': '给评论点赞',
  'douyin.check_interactions': '看互动', 'douyin.reply_comments': '回评论', 'douyin.hot_comment_round': '爆款热评',
  'douyin.draft': '生成草稿', 'douyin.publish_draft': '发布图文', 'douyin.comment_latest': '给对标账号评论',
  'douyin.hotspot': '扫热点', 'douyin.crawl_stats': '抓作品数据',
};

export function mount(host, ctx) {
  const state = { seg: 'timeline', page: 1, size: 20, activity: null, skillPage: 1, skillSize: 10, skillRuns: null };
  host.innerHTML = '<div id="systemRoot"></div>';
  const root = host.querySelector('#systemRoot');

  async function load() { state.activity = await ctx.api.list('activity', { page: state.page, size: state.size }); render(ctx.snapshot); }
  async function loadSkills() {
    try { state.skillRuns = await ctx.api.list('skill_runs', { page: state.skillPage, size: state.skillSize }); }
    catch { state.skillRuns = { items: [], total: 0, pages: 1, page: 1, size: state.skillSize }; }
    render(ctx.snapshot);
  }

  function closeDrawer() { const old = host.querySelector('.drawer'); if (old) old.remove(); const bk = host.querySelector('.drawer-bk'); if (bk) bk.remove(); }
  async function openDetail(id) {
    closeDrawer();
    let data = null;
    try { data = await ctx.api.activityDetail(id); } catch (error) { data = { error: error.message }; }
    const ev = data?.event ?? {};
    const pretty = JSON.stringify(ev, null, 2);
    const wrap = document.createElement('div');
    wrap.innerHTML = `<div class="drawer-bk" data-close></div><aside class="drawer"><header><span class="t">${esc(EVENT_CN[ev.event_type] ?? ev.event_type ?? '事件')}</span><span class="n">#${esc(String(ev.id ?? id))}</span><span class="sp"><button class="chip" data-close>关闭</button></span></header>
      <div class="scroll"><div class="meta" style="margin-bottom:8px">${esc([ev.event_type, ev.actor, ev.channel, ev.task_id ? 'task ' + String(ev.task_id).slice(-8) : '', ev.created_at].filter(Boolean).join(' · '))}</div><pre class="json">${esc(pretty)}</pre></div></aside>`;
    host.appendChild(wrap);
  }

  async function openSkillRun(id) {
    closeDrawer();
    let data = null;
    try { data = await ctx.api.skillRunDetail(id); } catch (error) { data = { error: error.message }; }
    const run = data?.run ?? {};
    const steps = data?.steps ?? [];
    const stepRows = steps.map((step) => {
      const cls = step.ok ? 'ok' : 'bad';
      return `<div class="row ${cls}"><div class="body"><div class="l1">${esc(step.step_id)}</div><div class="l2">${esc(String(step.evidence ?? '').slice(0, 90))}</div></div><div class="side">${tag(cls, step.ok ? '过' : '卡住')}</div></div>`;
    }).join('');
    const wrap = document.createElement('div');
    wrap.innerHTML = `<div class="drawer-bk" data-close></div><aside class="drawer"><header><span class="t">${esc(SKILL_CN[run.skill_id] ?? run.skill_id ?? '技能运行')}</span><span class="n">${esc(String(run.id ?? id).slice(-10))}</span><span class="sp"><button class="chip" data-close>关闭</button></span></header>
      <div class="scroll">
        <div class="meta" style="margin-bottom:8px">${esc([run.status, run.verified ? '已验证' : '未验证', run.failure_stage ? '卡在 ' + run.failure_stage : '', run.started_at, run.duration_ms != null ? run.duration_ms + 'ms' : ''].filter(Boolean).join(' · '))}</div>
        <div class="card" style="margin-bottom:10px"><header><span class="t">步骤</span><span class="n">${steps.length}</span></header>${stepRows || '<div class="empty">没有步骤记录。</div>'}</div>
        <pre class="json">${esc(JSON.stringify(run.result ?? run, null, 2))}</pre>
      </div></aside>`;
    host.appendChild(wrap);
  }

  root.addEventListener('click', async (event) => {
    const seg = event.target.closest('[data-s]');
    if (seg) { state.seg = seg.dataset.s; closeDrawer(); render(ctx.snapshot); return; }
    const close = event.target.closest('[data-close]');
    if (close) { closeDrawer(); return; }
    const row = event.target.closest('[data-ev]');
    if (row && row.dataset.ev) { await openDetail(row.dataset.ev); return; }
    const run = event.target.closest('[data-run]');
    if (run && run.dataset.run) { await openSkillRun(run.dataset.run); return; }
    const pager = event.target.closest('[data-pager]');
    if (pager) {
      const p = Number(pager.dataset.page); if (!p) return;
      if (pager.dataset.pager === 'skill_runs') { state.skillPage = p; await loadSkills(); return; }
      state.page = p; await load(); return;
    }
  });
  root.addEventListener('change', async (event) => {
    const size = event.target.closest('[data-size]'); if (!size) return; state.size = Number(size.value) || 20; state.page = 1; await load();
  });

  function render(snap) {
    if (!snap) return;
    const status = snap.status ?? {};
    const pulse = snap.pulse ?? {};
    const activity = state.activity ?? { items: [], total: snap.activity_total ?? 0, pages: 1, page: 1, size: 20 };
    const failures = snap.failures ?? [];
    const usage = snap.usageTrend ?? [];
    const qq = status.qq ?? {};

    const timelineRows = (activity.items ?? []).map((e) => {
      const type = e.type ?? e.event_type ?? 'event';
      const state = String(e.state ?? '');
      const failed = type === 'action_failed' || state === 'failed';
      const ok = ['action_finished', 'message_replied', 'task_reported'].includes(type) || state === 'succeeded';
      const cancelled = state === 'cancelled';
      const expired = state === 'expired';
      const cls = failed ? 'bad' : ok ? 'ok' : cancelled || expired ? 'wait' : '';
      const title = EVENT_CN[type] ?? type;
      const label = failed ? '失败' : ok ? '成功' : cancelled ? '已取消' : expired ? '过期' : type === 'message_received' ? '消息' : '事件';
      const sub = [e.note || (e.task_id ? 'task ' + String(e.task_id).slice(-8) : ''), e.task_id && e.note ? 'task ' + String(e.task_id).slice(-8) : ''].filter(Boolean).join(' · ');
      return `<div class="row ${cls}" data-ev="${esc(e.id ?? '')}" style="cursor:pointer"><span class="clock">${esc(clockHM(e.at ?? e.created_at))}</span><div class="body"><div class="l1">${esc(title)}</div><div class="l2">${esc(String(sub).slice(0, 70))}</div></div><div class="side">${tag(cls, label)}</div></div>`;
    }).join('');

    const timelineView = `
      <div class="grid cols-12">
        <div class="card w8">
          <header><span class="t">任务时间线</span><span class="n">${activity.total ?? 0}</span><span class="sp">${tag('', '最近 ' + state.size + ' 条')}</span></header>
          <div class="tl">${timelineRows || '<div class="empty">还没有事件。</div>'}</div>
          ${pagerHtml('activity', activity, { sizes: [20, 40, 80] })}
        </div>
        <div class="card w4">
          <header><span class="t">失败原因</span><span class="n">${failures.reduce((a, f) => a + (f.count ?? 0), 0)}</span></header>
          ${failures.map((f) => `<div class="row"><div class="body"><div class="l1">${esc(f.reason)} ${tag('bad', (f.count ?? 0) + ' 次')}</div><div class="l2">${esc(String(f.detail ?? '').split('\n')[0].slice(0, 70))}</div></div></div>`).join('') || '<div class="empty">最近没有失败任务。</div>'}
        </div>
      </div>`;

    const healthView = `
      <div class="grid cols-12">
        <div class="card w6">
          <header><span class="t">服务</span></header>
          <div class="row"><div class="body"><div class="l1">QQ 网关</div><div class="l2">${esc(qq.state ?? 'unknown')} · 会话 ${qq.session ? '已建立' : '未建立'}</div></div><div class="side">${tag(qq.state === 'online' ? 'ok' : 'bad', qq.state === 'online' ? '正常' : '异常')}</div></div>
          <div class="row"><div class="body"><div class="l1">Connect 服务</div><div class="l2">127.0.0.1:8765 · 版本 ${esc(qq.version ?? '0.3')}</div></div><div class="side">${tag('ok', '正常')}</div></div>
          <div class="row"><div class="body"><div class="l1">模型网关</div><div class="l2">${esc(status.model?.base_url ?? '')} · ${esc(status.model?.model ?? '')}</div></div><div class="side">${tag('ok', '正常')}</div></div>
          <div class="row"><div class="body"><div class="l1">今日用量</div><div class="l2">消息 ${status.counters?.messages_today ?? 0} · 任务 ${status.counters?.tasks_today ?? 0} · 评论 ${pulse.comments_today ?? 0}</div></div></div>
        </div>
        <div class="card w6">
          <header><span class="t">最近异常</span><span class="n">${failures.length}</span></header>
          ${failures.slice(0, 4).map((f) => `<div class="row"><div class="body"><div class="l1">${esc(f.reason)}</div><div class="l2">${esc(String(f.detail ?? '').split('\n')[0].slice(0, 80))}</div></div><div class="side">${tag('bad', '待看')}</div></div>`).join('') || '<div class="empty">最近没有异常。</div>'}
        </div>
      </div>`;

    const costView = `
      <div class="grid cols-12">
        <div class="card w8">
          <header><span class="t">模型调用 · 近 ${usage.length || 0} 天</span><span class="n">${usage.reduce((a, u) => a + (u.model_calls ?? 0), 0)} 次</span></header>
          ${usage.length ? sparkHtml(usage.map((u) => u.model_calls ?? 0), { height: 120 }) : '<div class="empty">还没有多日数据。</div>'}
          <div class="meta">每日上限 ${pulse.model_budget ?? 50} 次 · 今天 ${pulse.model_calls ?? 0}/${pulse.model_budget ?? 50} · tokens 统计待接入</div>
        </div>
        <div class="card w4">
          <header><span class="t">今天</span></header>
          <div class="row"><div class="body"><div class="l1">文本调用</div><div class="l2">${pulse.model_calls ?? 0} 次 · 剩余 ${Math.max(0, (pulse.model_budget ?? 50) - (pulse.model_calls ?? 0))} 次</div></div></div>
          <div class="row"><div class="body"><div class="l1">语音调用</div><div class="l2">${pulse.voice_requests ?? 0} 次</div></div></div>
          <div class="row"><div class="body"><div class="l1">今日消息</div><div class="l2">${status.counters?.messages_today ?? 0} 条</div></div></div>
        </div>
      </div>`;

    const skills = snap.skills ?? {};
    const runs = state.skillRuns ?? { items: [], total: skills.runs ?? 0, pages: 1, page: 1, size: state.skillSize };
    const runRows = (runs.items ?? []).map((r) => {
      const cls = r.status === 'succeeded' ? (r.verified ? 'ok' : 'wait') : 'bad';
      const label = r.status === 'succeeded' ? (r.verified ? '已验证' : '没验证') : '失败';
      const l2 = [SKILL_CN[r.skill_id] ?? r.skill_id, r.started_at ? String(r.started_at).slice(5, 16).replace('T', ' ') : '', r.duration_ms != null ? r.duration_ms + 'ms' : '', r.failure_stage ? '卡在 ' + r.failure_stage : '', r.steps ? r.steps + ' 步' : ''].filter(Boolean).join(' · ');
      return `<div class="row ${cls}" data-run="${esc(r.id)}" style="cursor:pointer"><div class="body"><div class="l1">${esc(SKILL_CN[r.skill_id] ?? r.skill_id)} <span class="meta">v${r.version ?? 1}</span></div><div class="l2">${esc(l2)}</div></div><div class="side">${tag(cls, label)}</div></div>`;
    }).join('');
    const proposalRows = (skills.proposals ?? []).map((p) => {
      const [skillId, , stage] = String(p.pattern_key ?? '').split(':');
      return `<div class="row"><div class="body"><div class="l1">${esc(SKILL_CN[skillId] ?? skillId)} · ${esc(stage ?? '')} ${tag('bad', (p.occurrences ?? 0) + ' 次')}</div><div class="l2">攒够 2 次就能在 QQ 里回「提案」查看，回「批准 R编号」升版本（连续 3 次失败会自动回滚）</div></div></div>`;
    }).join('');

    const statusLabel = { enabled: ['ok', '启用'], validating: ['wait', '试用'], deprecated: ['bad', '已弃用'] };
    const versionRows = (skills.versions ?? []).map((v) => {
      const [cls, label] = statusLabel[v.status] ?? ['', v.status ?? ''];
      const rate = v.runs ? Math.round((v.verified / v.runs) * 100) : null;
      const l2 = [v.runs + ' 次', '已验证 ' + v.verified, '失败 ' + v.failed, rate == null ? '还没跑过' : '成功率 ' + rate + '%'].join(' · ');
      return `<div class="row"><div class="body"><div class="l1">${esc(SKILL_CN[v.skill_id] ?? v.skill_id)} <span class="meta">v${v.version}</span></div><div class="l2">${esc(l2)}</div></div><div class="side">${tag(cls, label)}</div></div>`;
    }).join('');
    const rollbackRows = (skills.rollbacks ?? []).map((r) => `<div class="row bad"><div class="body"><div class="l1">${esc(SKILL_CN[r.skill_id] ?? r.skill_id)} 回滚 v${r.from_version} → v${r.to_version}</div><div class="l2">${esc(r.reason ?? '')} · ${esc(String(r.at ?? '').slice(5, 16).replace('T', ' '))}</div></div></div>`).join('');

    const skillsView = `
      <div class="grid cols-12">
        <div class="card w8">
          <header><span class="t">技能账本</span><span class="n">${skills.total ?? 0} 个技能</span><span class="sp">${tag('', '运行 ' + (skills.runs ?? 0) + ' · 已验证 ' + (skills.verified ?? 0) + ' · 失败 ' + (skills.failed ?? 0))}</span></header>
          ${runRows || '<div class="empty">还没有运行记录，等下一次动手机就有了。</div>'}
          ${pagerHtml('skill_runs', runs, { sizes: [10, 20, 40] })}
        </div>
        <div class="card w4">
          <header><span class="t">失败聚合</span><span class="n">${(skills.proposals ?? []).length}</span></header>
          ${proposalRows || '<div class="empty">还没有失败指纹。步骤卡住两次以上会自动出现在这里。</div>'}
          <div class="meta">步骤事件 ${skills.steps ?? 0} 条 · 每一步都带断言结果</div>
          <div class="meta">自愈 ${skills.heals?.total ?? 0} 次${(skills.heals?.kinds ?? []).length ? ' · ' + skills.heals.kinds.map((k) => `${SKILL_KIND[k.kind] ?? k.kind} ${k.n}`).join(' / ') : ''}</div>
        </div>
        <div class="card w12">
          <header><span class="t">版本与回滚</span><span class="n">${(skills.versions ?? []).length} 个版本</span><span class="sp">${tag('', '连续 3 次失败自动回滚')}</span></header>
          ${versionRows || '<div class="empty">还没有版本记录。</div>'}
          ${rollbackRows ? '<header style="margin-top:8px"><span class="t">回滚记录</span><span class="n">' + (skills.rollbacks ?? []).length + '</span></header>' + rollbackRows : ''}
        </div>
      </div>`;

    setHtml(root, `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
        <div class="seg">${[['timeline', '时间线'], ['skills', '技能'], ['health', '健康'], ['cost', '成本']].map(([k, label]) => `<button class="${state.seg === k ? 'on' : ''}" data-s="${k}">${label}</button>`).join('')}</div>
      </div>
      <div style="display:${state.seg === 'timeline' ? 'block' : 'none'}">${timelineView}</div>
      <div style="display:${state.seg === 'skills' ? 'block' : 'none'}">${skillsView}</div>
      <div style="display:${state.seg === 'health' ? 'block' : 'none'}">${healthView}</div>
      <div style="display:${state.seg === 'cost' ? 'block' : 'none'}">${costView}</div>`);
  }

  load().catch((error) => console.error(error));
  loadSkills().catch((error) => console.error(error));
  return { update: (snap) => render(snap), activate: () => load() };
}
