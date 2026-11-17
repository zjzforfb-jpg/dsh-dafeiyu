// 成长：能力认证 / 课程 / 毕业项目 + 最近学习
import { esc, pct, tag, setHtml, clockHM } from '../ui.mjs';

export const meta = { id: 'growth', title: '成长', badge: () => 0 };

const STAGE_NAMES = ['① 认识自己', '② 成为创作者', '③ 认识人类社会', '④ 学会独立成长'];
const STEP_CN = { intro: '课程导入', knowledge: '知识学习', case: '案例分析', imitate: '模仿练习', practice: '独立实践', assess: '考核评价', summary: '成长总结' };
const stripMd = (text) => String(text).replace(/\*\*(.+?)\*\*/gu, '$1').replace(/^#+\s*/gmu, '').replace(/^[-*]\s+/gmu, '');

export function mount(host, ctx) {
  const state = { courses: null, study: null };
  host.innerHTML = '<div id="growthRoot"></div>';
  const root = host.querySelector('#growthRoot');

  async function load() {
    state.courses = await ctx.api.list('courses', { page: 1, size: 20 });
    state.study = await ctx.api.list('study', { page: 1, size: 2 });
    render(ctx.snapshot);
  }

  function render(snap) {
    if (!snap) return;
    const cert = snap.certification ?? {};
    const academy = snap.academy ?? {};
    const courses = state.courses ?? { items: [] };
    const study = state.study ?? { items: [] };
    const grad = courses.graduation ?? { items: [], done: 0, total: 12, percent: 0 };
    const next = cert.next ?? null;

    const stageBars = (academy.stages ?? []).map((s, i) => `
      <div class="stagebar"><div class="lab"><span>${STAGE_NAMES[s.stage - 1] ?? '阶段 ' + s.stage}</span><span>${s.done ?? 0}/${s.total ?? 3}</span></div>
      <div class="bar"><i style="width:${Math.max(2, pct(s.done ?? 0, s.total ?? 3))}%"></i></div></div>`).join('');

    const certCard = `
      <header><span class="t">能力认证</span><span class="sp">${tag('', 'Lv' + (cert.level ?? 0))}</span></header>
      <div style="font-size:15px;font-weight:600">${esc(cert.title ?? '刚来的小鲸鱼')}</div>
      ${next ? `<div class="stagebar"><div class="lab"><span>升 Lv${next.level} ${esc(next.title)}</span><span>${next.requirements.filter((r) => r.ok).length}/${next.requirements.length}</span></div><div class="bar"><i style="width:${pct(next.requirements.filter((r) => r.ok).length, next.requirements.length)}%"></i></div></div>
      <div style="font-size:12px;color:var(--on-var)">${next.requirements.slice(0, 3).map((r) => `${r.ok ? '✓' : '✗'} ${esc(r.label)} ${esc(String(r.value ?? 0))}/${esc(String(r.target ?? 1))}${r.unit ? esc(r.unit) : ''}`).join('　')}</div>` : ''}
      <header style="margin-top:14px"><span class="t">四阶段</span></header>
      ${stageBars || '<div class="empty">还没有课程进度。</div>'}`;

    const courseRows = (courses.items ?? []).map((c) => {
      const done = c.status === 'done';
      const p = done ? 100 : Math.round(((c.step ?? 0) / (c.total ?? 7)) * 100);
      return `<div class="course"><span class="idx">${esc(String(c.id).replace(/^c/, ''))}</span><div style="flex:1"><div class="t">${esc(c.title)}</div><div class="m">第 ${c.stage} 阶段 · ${done ? '已学完' : c.step ? `${c.stepLabel ?? ''} ${c.step}/${c.total}` : '未开始'}</div></div><div class="track"><i style="width:${Math.max(2, p)}%"></i></div></div>`;
    }).join('');

    const gradRows = (grad.items ?? []).slice(0, 8).map((g) => `<div class="g${g.done ? ' done' : ''}"><b>${g.done ? '✔' : '○'} ${esc(g.label)}</b>${esc(String(g.progress ?? ''))}${g.target != null ? '/' + esc(String(g.target)) : ''}</div>`).join('');

    const studyRows = (study.items ?? []).slice(0, 2).map((s) => `<div class="row"><div class="avatar">📖</div><div class="body"><div class="l1">${esc(s.course_id)} · ${esc(STEP_CN[s.step_key] ?? s.step_key ?? '')}</div><div class="l2">${esc(stripMd(String(s.summary ?? '')).slice(0, 46))}${s.score ? ' · ' + esc(String(s.score)) + ' 分' : ''} · ${esc(clockHM(s.created_at))}</div></div></div>`).join('');

    setHtml(root, `
      <div class="grid cols-12">
        <div class="card w4">${certCard}</div>
        <div class="card w4">
          <header><span class="t">课程</span><span class="n">${academy.total ?? 12} 门 · 已完成 ${academy.done ?? 0}</span></header>
          <div class="scroll" style="max-height:520px">${courseRows || '<div class="empty">课程还没加载。</div>'}</div>
        </div>
        <div class="card w4">
          <header><span class="t">毕业项目</span><span class="n">${grad.done ?? 0}/${grad.total ?? 12} · ${grad.percent ?? 0}%</span></header>
          <div class="grad">${gradRows || '<div class="empty">还没有里程碑数据。</div>'}</div>
          <header style="margin-top:14px"><span class="t">最近学习</span></header>
          ${studyRows || '<div class="empty">还没开始学。</div>'}
        </div>
      </div>`);
  }

  load().catch((error) => console.error(error));
  return { update: (snap) => render(snap), activate: () => load() };
}
