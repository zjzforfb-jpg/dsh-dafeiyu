/**
 * 大肥鱼 · 实时工作流控制台（纯 DOM + SSE，静止时不做任何逐帧渲染）。
 *
 * 设计要点：
 * 1. 只用 CSS transition / 短动画表示「亮」，没有 requestAnimationFrame 循环；
 * 2. 事件流只保留最近 300 条 DOM，多的直接丢；
 * 3. 所有正文（payload / result / evidence）点开才取，列表里只有一行摘要。
 */

import { annotateRows, readinessText } from './readiness.mjs';
import { VERDICT_LABEL, REASON_LABEL, reasonText, shortClock } from './reason-text.mjs';
import { nextSteps } from './next-steps.mjs';
import { RELEASE_PLAN, nextReleaseStep } from './release-plan.mjs';
import { sampleNote } from './sample.mjs';
import { summarizeCompare, describeCompare } from './trend-compare.mjs';

const STORE_KEY = 'dafeiyu.adminToken';
const MAX_EVENTS = 300;
const MAX_DETAIL_STEPS = 200;

const state = {
  preflight: null,
  token: '',
  live: false,
  paused: false,
  filterStage: null,
  events: [],
  tasks: [],
  slots: null,
  tools: null,
  selected: null,
  stream: null,
  tickTimer: null,
  filterState: '',
  search: '',
  taskState: '',
  taskSearch: '',
  detailKind: 'event',
  detailStack: [],
  lastByKind: { event: null, item: null },
  // 当前详情在 /flow 上对应哪个节点（点「在数据流图里看」跳过去）
  flowNode: null,
};

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

/* ---------------- 令牌 ---------------- */

function readToken() {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get('token');
  let token = fromUrl || sessionStorage.getItem(STORE_KEY) || '';
  if (fromUrl) {
    sessionStorage.setItem(STORE_KEY, fromUrl);
    url.searchParams.delete('token');
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }
  return token;
}

function showGate(message = '') {
  $('gate').hidden = false;
  $('gateErr').textContent = message;
  $('gateInput').focus();
}

function hideGate() { $('gate').hidden = true; }

async function api(path) {
  const res = await fetch(path, { headers: state.token ? { authorization: `Bearer ${state.token}` } : {} });
  if (res.status === 401) { showGate('令牌不对，或者过期了。'); throw new Error('unauthorized'); }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

/* ---------------- 渲染小工具 ---------------- */

const STATE_COLOR = { idle: '#4b5563', active: '#22d3ee', ok: '#34d399', fail: '#f87171', wait: '#fbbf24', review: '#a78bfa' };
const STATE_TEXT = { idle: '空闲', active: '进行中', ok: '完成', fail: '失败', wait: '等待', review: '待确认' };
const CHANNEL = { qq: 'QQ', wechat: '微信', ilink: '微信', call: '通话', desktop: '桌宠', android: '安卓', board: '看板', douyin: '抖音', plan: '日程', system: '系统' };
const EVENT_LABEL = {
  message_received: '收到消息', message_replied: '已回复', task_state_changed: '任务状态', task_reported: '任务汇报',
  action_started: '开始执行', action_finished: '执行完成', action_failed: '执行失败', receipt_verified: '回执已核',
  call_ended: '通话结束', observation_created: '环境观察', reflection_created: '反思', approval_requested: '请求审批',
  approval_resolved: '审批结果', skill_run_started: '技能开始', skill_run_finished: '技能完成', skill_candidate: '技能候选',
};
const STATUS_TEXT = {
  awaiting_confirmation: '等确认', awaiting_publish: '等发布', waiting_verification: '等核验', running: '在跑',
  succeeded: '成功', failed: '失败', cancelled: '已取消', pending: '排着', planned: '已排', done: '完成', skipped: '跳过', fired: '已触发', expired: '过期', unknown: '未知',
};

const labelOf = (map, key, fallback) => map[key] ?? (fallback != null ? fallback : String(key ?? ''));

function badge(stateKey, text) {
  const span = el('span', `badge ${stateKey}`, text ?? STATE_TEXT[stateKey] ?? stateKey);
  return span;
}

// 工具卡上「最近一次」的判定说法
// 脚本抛的错常常是一整行 `Command failed: node …`，列表里只留一句人话

function timeText(clock) { return clock || ''; }

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function jsonBlock(value) {
  const pre = el('pre', 'json');
  if (value == null) { pre.textContent = '—'; return pre; }
  let text;
  try { text = typeof value === 'string' ? value : JSON.stringify(value, null, 2); } catch { text = String(value); }
  if (text.length > 8000) text = `${text.slice(0, 8000)}\n…（已截断 ${text.length - 8000} 字）`;
  pre.innerHTML = escapeHtml(text)
    .replace(/(&quot;[^&]*?&quot;)(\s*:)/g, '<span class="k">$1</span>$2')
    .replace(/:\s*(&quot;.*?&quot;)/g, ': <span class="s">$1</span>')
    .replace(/:\s*(-?\d+(?:\.\d+)?)/g, ': <span class="n">$1</span>')
    .replace(/:\s*(true|false|null)/g, ': <span class="b">$1</span>');
  return pre;
}

function kv(pairs) {
  const dl = el('dl', 'kv');
  for (const [key, value] of pairs) {
    if (value == null || value === '') continue;
    dl.append(el('dt', null, key), el('dd', null, typeof value === 'string' ? value : JSON.stringify(value)));
  }
  return dl;
}

function section(title, node) {
  const box = el('div', 'dSec');
  box.append(el('h4', null, title));
  // node 允许是数组（多个块）—— 直接 append 数组会被转成字符串 "[object HTMLDivElement]"
  for (const child of Array.isArray(node) ? node : [node]) {
    if (child) box.append(child);
  }
  return box;
}

/* ---------------- 顶部计数 / 阶段 / 图例 ---------------- */

function renderStats(totals) {
  if (!totals) return;
  $('statEvents').textContent = totals.events ?? 0;
  $('statActions').textContent = totals.actions ?? 0;
  $('statFails').textContent = totals.fails ?? 0;
  $('statOpen').textContent = totals.open ?? 0;
  $('statAwait').textContent = totals.awaiting ?? 0;
}

function stageNode(stage) {
  const node = el('div', 'stage');
  node.dataset.stage = stage.id;
  node.dataset.state = stage.state ?? 'idle';
  node.title = stage.hint ?? '';
  const dot = el('span', 'dot');
  const body = el('div');
  body.append(el('span', 's-label', stage.label), el('span', 's-sub', stage.sub ?? ''));
  const meta = el('div', 's-meta');
  meta.append(el('b', null, String(stage.count ?? 0)), el('em', null, stage.lastEvent ? labelOf(EVENT_LABEL, stage.lastEvent, stage.lastEvent) : stage.wired === false ? '未埋点' : ''));
  if (stage.wired === false) node.classList.add('unwired');
  node.append(dot, body, meta);
  node.addEventListener('click', () => toggleStage(stage.id));
  return node;
}

function renderStages(stages) {
  const box = $('stages');
  box.textContent = '';
  for (const stage of stages) box.append(stageNode(stage));
  paintFilterChip();
}

function updateStages(stages) {
  for (const stage of stages) {
    const node = document.querySelector(`.stage[data-stage="${stage.id}"]`);
    if (!node) continue;
    node.dataset.state = stage.state ?? 'idle';
    node.querySelector('.s-meta b').textContent = String(stage.count ?? 0);
    node.querySelector('.s-meta em').textContent = stage.lastEvent ? labelOf(EVENT_LABEL, stage.lastEvent, stage.lastEvent) : stage.wired === false ? '未埋点' : '';
    node.classList.toggle('unwired', stage.wired === false);
  }
}

function flashStage(stageId) {
  const node = document.querySelector(`.stage[data-stage="${stageId}"]`);
  if (!node) return;
  node.classList.remove('flash');
  void node.offsetWidth;
  node.classList.add('flash');
}

function renderLegend() {
  const box = $('stateLegend');
  box.textContent = '';
  for (const [key, text] of Object.entries(STATE_TEXT)) {
    const span = el('span');
    const dot = el('i');
    dot.style.background = STATE_COLOR[key];
    span.append(dot, el('span', null, text));
    box.append(span);
  }
}

/* ---------------- 事件流 ---------------- */

function eventRow(view) {
  const row = el('div', 'ev');
  row.dataset.state = view.state ?? 'ok';
  row.dataset.id = view.id;
  row.dataset.stage = view.stage ?? '';
  row.append(el('time', null, view.clock ?? ''));
  row.append(el('span', 'st'));
  const body = el('div', 'body');
  const title = el('b', null, labelOf(EVENT_LABEL, view.eventType, view.eventType));
  body.append(title);
  if (view.summary) body.append(el('span', 'sum', view.summary));
  row.append(body);
  row.append(el('span', 'ch', labelOf(CHANNEL, view.channel, view.channel)));
  // 列表行也是「按钮」：键盘能 Tab 到、Enter/Space 能打开详情
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.addEventListener('click', () => openEvent(view.id, row));
  row.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openEvent(view.id, row);
  });
  return row;
}

function matchesEvent(view) {
  if (state.filterStage && view.stage !== state.filterStage) return false;
  if (state.filterState && view.state !== state.filterState) return false;
  const needle = state.search.trim().toLowerCase();
  if (needle) {
    const hay = `${view.summary ?? ''} ${view.eventType ?? ''} ${view.channel ?? ''} ${view.taskId ?? ''} ${view.actor ?? ''}`.toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

function renderStream() {
  const box = $('stream');
  const list = state.events.filter(matchesEvent).slice(-MAX_EVENTS);
  const html = document.createDocumentFragment();
  for (const view of list) html.append(eventRow(view));
  box.textContent = '';
  box.append(html);
  if (!list.length) {
    const filtered = state.filterStage || state.filterState || state.search.trim();
    box.append(el('p', 'empty', filtered ? '当前筛选没有命中的事件，换个条件试试。' : '还没有事件。让大肥鱼动一下（或等一条消息），这里会实时滚出来。'));
  }
  // 只加载了最近一批：明确告诉人「还有多少更早的」，并给一个往前翻的按钮
  const earlier = Number(state.snapshot?.earlierCount ?? 0);
  if (earlier > 0 && !state.filterStage && !state.filterState && !state.search.trim()) {
    const more = el('div', 'streamMore');
    const tip = el('span', 'streamMoreText', `还有 ${earlier} 条更早的事件没显示`);
    const btn = el('button', 'streamMoreBtn', '加载更早 50 条');
    btn.type = 'button';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const cursor = Number(state.snapshot?.oldestRowid ?? 0);
      const page = await api(`/api/live/events?beforeRowid=${encodeURIComponent(cursor)}&limit=50`);
      const older = page?.events ?? [];
      if (older.length) {
        state.events = [...older, ...state.events].slice(-(MAX_EVENTS + 300));
        const oldestRowid = older[0]?.rowid ?? (cursor - older.length);
        state.snapshot = { ...(state.snapshot ?? {}), earlierCount: Math.max(0, earlier - older.length), oldestRowid };
        renderStream();
      } else {
        tip.textContent = '没有更早的事件了';
        btn.remove();
      }
    });
    more.append(tip, btn);
    box.append(more);
  }
  box.scrollTop = 0;
}

function pushEvents(views) {
  if (!views?.length) return;
  for (const view of views) {
    state.events.push(view);
    flashStage(view.stage);
  }
  const latest = views[views.length - 1];
  if (latest) setTicker(latest);
  if (state.events.length > MAX_EVENTS * 2) state.events = state.events.slice(-MAX_EVENTS);
  if (state.paused) return;
  const box = $('stream');
  const frag = document.createDocumentFragment();
  const visible = views.filter(matchesEvent);
  for (const view of visible) frag.append(eventRow(view));
  if (visible.length) {
    const empty = box.querySelector('.empty');
    if (empty) empty.remove();
    box.prepend(frag);
    while (box.children.length > MAX_EVENTS) box.lastElementChild.remove();
  }
}

/* ---------------- 底部一行：最近一条事件 ---------------- */

function setTicker(view) {
  const box = $('ticker');
  if (!box) return;
  box.textContent = '';
  const tk = el('span', 'tk');
  tk.append(el('b', null, view.clock ?? ''), document.createTextNode(' · '),
    document.createTextNode(labelOf(EVENT_LABEL, view.eventType, view.eventType)),
    document.createTextNode(' · '), document.createTextNode(labelOf(CHANNEL, view.channel, view.channel)));
  if (view.summary) tk.append(document.createTextNode(' · '), document.createTextNode(view.summary));
  box.append(tk);
}

/* ---------------- 页签：ARIA + 键盘 ---------------- */

const TABS = ['events', 'tasks', 'slots', 'tools', 'report'];

function tabNodes() {
  return [...document.querySelectorAll('.tabbar .tab')];
}

/** 本轮报告：把散在四处的东西收成一页——覆盖度、授权就绪、额度、本周问题、还没跑过的。 */
async function renderReport() {
  const box = $('reportBody');
  if (!box) return;
  if (!state.tools?.items) {
    const list = await api('/api/live/tools');
    if (list?.items) state.tools = list;
  }
  const tools = state.tools?.items ?? [];
  const cov = state.tools?.coverage ?? null;
  box.textContent = '';

  // 卡片一律是 <details>：重要的默认展开，其余折起来（页面像「今天该做什么」，不是仪表盘）
  const card = (title, nodes, hint, { open = false } = {}) => {
    const wrap = el('details', `repCard${open ? ' repOpen' : ''}`);
    wrap.open = open;
    const summary = el('summary', 'repCardHead');
    const head = el('h3', null, title);
    if (open) head.dataset.pinned = '1';
    summary.append(head);
    if (hint) summary.append(el('p', 'repHint', hint));
    wrap.append(summary);
    const body = el('div', 'repBody');
    for (const node of nodes) body.append(node);
    wrap.append(body);
    return wrap;
  };

  // 0. 下一步该干什么（按优先级；这是打开报告最想看到的东西，放最前）
  {
    const steps = nextSteps({
      coverage: cov ?? {},
      items: tools,
      retired: state.tools?.retired ?? [],
      failures: state.failures ?? {},
    });
    const nodes = [];
    for (const step of steps) {
      const row = el('div', `nextRow ${step.kind}`);
      row.append(el('b', 'nextTitle', step.title));
      if (step.detail) row.append(el('p', 'nextDetail', step.detail));
      if (step.actions?.length) {
        const links = el('div', 'nextLinks');
        for (const action of step.actions) {
          const link = el('a', 'nextLink', action.label);
          link.href = action.href;
          if (action.external) { link.target = '_blank'; link.rel = 'noreferrer'; }
          links.append(link);
        }
        row.append(links);
      }
      nodes.push(row);
    }
    box.append(card('下一步该干什么', nodes, '按「卡住的程度」排序：失败 → 可疑的未确认 → 待放行 → 已下线', { open: true }));
  }

  // 0.5 契约体检：三件套齐不齐
  {
    const summary = state.tools?.contractSummary;
    if (summary) {
      const nodes = [];
      nodes.push(el('p', 'intro', `说明书 / 前置 / 跑完判定 三件齐的：${summary.complete}/${summary.total}。`));
      for (const row of summary.incomplete ?? []) {
        const line = el('p', 'contractRow');
        line.append(el('b', null, row.action), document.createTextNode(`：${(row.gaps ?? []).map((gap) => gap.label).join('、')}`));
        nodes.push(line);
      }
      if (!(summary.incomplete ?? []).length) nodes.push(el('p', 'intro', '全部齐全。'));
      box.append(card('契约体检', nodes, '缺哪件就补哪件：说明书在 tool-meta、前置在 preflight、跑后判定在 expect-after'));
    }
  }

  // 0.8 放行前必须知道的三件事：会用到什么 / 影响多大 / 以前有没有人试过
  const pendingSide = tools.filter((item) => !item.readOnly && !item.lastVerdict && Boolean(item.impact));
  if (pendingSide.length) {
    const list = el('div', 'preknow');
    for (const item of pendingSide) {
      const row = el('div', 'pkRow');
      row.append(el('b', 'pkName', item.title), el('span', 'pkRisk', `风险 ${item.risk ?? 'R0'}`));
      row.append(el('p', 'pkWhat', `会用到：${(item.preflight ?? []).length ? (item.preflight ?? []).join(' / ').slice(0, 120) : '只要手机在线'}`));
      row.append(el('p', 'pkImpact', `影响：${item.impact || '（未声明）'}`));
      row.append(el('p', 'pkPast', item.lastAt
        ? `上次试过：${shortClock(item.lastAt)}（${VERDICT_LABEL[item.lastVerdict] ?? item.lastVerdict ?? '无判定'}）`
        : '从来没有跑过——这次就是第一次，出问题只能看操作单收场'));
      list.append(row);
    }
    box.append(card('放行前必须知道的三件事', [list], '只列还没跑过的公开动作，不含只读工具。'));
  }

  // 0.85 和上周比：只看有趋势数据的动作，变差排最前
  {
    const cmp = summarizeCompare(tools);
    const rows = el('div', 'cmpRows');
    for (const row of cmp.rows.slice(0, 6)) {
      const line = el('div', `cmpRow ${row.status}`);
      line.append(el('b', 'cmpName', row.title));
      line.append(el('em', 'cmpText', describeCompare(row)));
      rows.append(line);
    }
    const summary = `变好 ${cmp.counts.improved} · 变差 ${cmp.counts.regressed} · 持平 ${cmp.counts.flat} · 本周没跑 ${cmp.counts.idle} · 新数据 ${cmp.counts.new}`;
    box.append(card('和上周比', rows.children.length ? [rows, el('p', 'cmpSum', summary)] : [el('p', 'empty', '还没有两周以上的数据，跑几次再看。')], '只比成功率，不评价对错——次数也一并给你。'));
  }

  // 0.9 放行当天按这个顺序（单一真源 release-plan.mjs，docs/RELEASE-DAY.md 同源）
  {
    const step = nextReleaseStep(tools);
    const rows = el('div', 'relPlan');
    for (const entry of RELEASE_PLAN) {
      const done = step.done.includes(entry.action);
      const isNext = step.next?.action === entry.action;
      const row = el('div', `relRow${done ? ' done' : ''}${isNext ? ' next' : ''}`);
      row.append(el('b', 'relNo', String(entry.order)));
      row.append(el('span', 'relName', entry.title));
      row.append(el('em', 'relWhy', entry.why));
      if (isNext) row.append(el('em', 'relStop', `停的条件：${entry.abortIf}`));
      rows.append(row);
    }
    box.append(card('放行当天按这个顺序', [rows], `还剩 ${step.remaining.length}/${step.total} 步没确认；顺序不是随意的，前一步稳了再跑下一步。`));
  }

  // 1. 覆盖度
  if (cov) {
    const done = cov.confirmed ?? 0;
    const body = el('div');
    const bar = el('div', 'covBar');
    const total = Math.max(1, cov.total ?? 1);
    const seg = (cls, n) => {
      const piece = el('i', cls, '');
      piece.style.width = `${(n / total) * 100}%`;
      return piece;
    };
    bar.append(seg('ok', cov.confirmed ?? 0), seg('warn', cov.unconfirmed ?? 0), seg('bad', (cov.failed ?? 0) + (cov.mismatched ?? 0)));
    body.append(el('p', 'repBig', `${done}/${cov.total} 已确认`));
    body.append(bar);
    body.append(el('p', 'repSub', `未确认 ${cov.unconfirmed ?? 0} · 失败 ${(cov.failed ?? 0) + (cov.mismatched ?? 0)} · 没跑过 ${cov.untested ?? 0}`));
    box.append(card('跑通覆盖度', [body], null, { open: true }));
  }

  // 2. 还没跑过的（可直接点开看说明书）
  // 只读工具不走判定链，永远没有 verdict —— 不能把它们算进「没跑过」
  const untested = tools.filter((item) => !item.lastVerdict && !item.readOnly);
  const readOnlyCount = tools.filter((item) => item.readOnly).length;
  if (untested.length) {
    const list = el('div', 'repList');
    for (const item of untested) {
      const row = el('button', 'repRow');
      row.type = 'button';
      row.append(el('b', null, item.title));
      row.append(el('span', 'repTag', item.levelLabel ?? ''));
      row.addEventListener('click', () => { selectTab('tools'); openTool(item); });
      list.append(row);
    }
    box.append(card(`还没跑过的 ${untested.length} 个`, [list, readOnlyCount
      ? el('p', 'repSub', `另有 ${readOnlyCount} 个只读工具（查天气、看作品、读能力卡…）不产生判定，不算没跑过。`)
      : el('span', '')], '点一行看它的说明书与手动命令'));
  }

  // 3. 授权项就绪
  const pre = state.preflight?.results ? Object.values(state.preflight.results).filter((entry) => entry.group === 'authorized') : [];
  if (pre.length) {
    const ready = pre.filter((entry) => entry.ready).length;
    const miss = pre.filter((entry) => !entry.ready).map((entry) => entry.action);
    box.append(card('授权项就绪', [el('p', 'repBig', `${ready}/${pre.length}${miss.length ? `（缺 ${miss.join('、')}）` : ''}`),
      el('p', 'repSub', '这些会响手机或公开发作品，跑之前需要你点头。')]));
  }

  // 4. 本周问题
  const fails = state.failures;
  if (fails?.buckets?.length) {
    const list = el('ul', 'repBullets');
    for (const bucket of fails.buckets.slice(0, 4)) list.append(el('li', null, `${bucket.label} ${bucket.count} 次`));
    box.append(card(`本周问题 ${fails.total} 次`, [list]));
  }

  // 5. 评论额度
  if (state.quota) {
    const q = state.quota;
    box.append(card('评论额度', [el('p', 'repBig', `本小时还剩 ${q.hourlyLeft}/${q.hourlyCap}`),
      el('p', 'repSub', `今天已发 ${q.dailyUsed} 条（上限 ${q.dailyCap}）${q.waitMs > 0 ? ` · 下一条还要等 ${Math.ceil(q.waitMs / 1000)} 秒` : ''}`)]));
  }
}

function selectTab(name, { focus = false } = {}) {
  if (!TABS.includes(name)) name = 'events';
  for (const tab of tabNodes()) {
    const on = tab.dataset.tab === name;
    tab.classList.toggle('on', on);
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    if (on && focus) tab.focus();
  }
  for (const pane of document.querySelectorAll('.pane')) pane.classList.toggle('on', pane.id === `pane-${name}`);
  // 暂停/筛选只对事件流有意义
  const tools = $('streamTools');
  if (tools) tools.hidden = name !== 'events';
  const url = new URL(location.href);
  if (name === 'events') url.searchParams.delete('tab');
  else url.searchParams.set('tab', name);
  history.replaceState(null, '', url);
  if (name === 'events') {
    const box = $('stream');
    if (box) box.scrollTop = 0;
  }
  state.tab = name;
  if (name === 'report') renderReport();
}

function wireTabs() {
  const tabs = tabNodes();
  for (const tab of tabs) {
    tab.addEventListener('click', () => selectTab(tab.dataset.tab));
  }
  const bar = document.querySelector('.tabbar');
  bar?.addEventListener('keydown', (event) => {
    const index = tabs.findIndex((tab) => tab.dataset.tab === (document.activeElement?.dataset?.tab ?? ''));
    if (index < 0) return;
    let next = -1;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    event.preventDefault();
    selectTab(tabs[next].dataset.tab, { focus: true });
  });
}

function toggleStage(stageId) {
  state.filterStage = state.filterStage === stageId ? null : stageId;
  state.flowNode = stageId ? null : state.flowNode;
  for (const node of document.querySelectorAll('.stage')) node.classList.toggle('on', node.dataset.stage === state.filterStage);
  renderStream();
}

function paintFilterChip() {
  const chip = $('filterChip');
  if (!state.filterStage) { chip.hidden = true; return; }
  const stage = document.querySelector(`.stage[data-stage="${state.filterStage}"] .s-label`)?.textContent ?? state.filterStage;
  chip.hidden = false;
  chip.textContent = `只看：${stage} ×`;
  chip.onclick = () => toggleStage(state.filterStage);
}

/* ---------------- 底部：任务 / 定时任务 / 工具 ---------------- */

function matchesTask(task) {
  if (state.taskState && task.state !== state.taskState) return false;
  const needle = state.taskSearch.trim().toLowerCase();
  if (needle) {
    const hay = `${task.intent ?? ''} ${(task.ops ?? []).join(' ')} ${task.origin ?? ''} ${task.id ?? ''} ${task.status ?? ''}`.toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

function renderTasks(tasks) {
  state.tasks = tasks ?? [];
  const box = $('tasks');
  box.textContent = '';
  const visible = state.tasks.filter(matchesTask);
  for (const task of visible) {
    const row = el('div', 'row');
    if (task.state === 'fail') row.classList.add('bad');
    row.append(el('time', null, task.updatedMs ? new Date(task.updatedMs).toLocaleTimeString('zh-CN', { hour12: false }) : ''));
    const main = el('div', 'r-main');
    main.append(el('b', null, task.intent ?? task.id));
    main.append(el('em', null, ` ${(task.ops ?? []).join(' + ') || task.id?.slice(0, 18) || ''}`));
    row.append(main);
    row.append(badge(task.state, labelOf(STATUS_TEXT, task.status, task.status)));
    row.append(el('div', 'r-note', `${task.origin ?? ''} · 试 ${task.attempts ?? 0}`));
    row.addEventListener('click', () => openTask(task.id));
    box.append(row);
  }
  if (!visible.length) box.append(el('p', 'empty', state.taskState || state.taskSearch.trim() ? '当前筛选没有命中的任务。' : '今天还没有任务。'));
  $('tabTasks').textContent = String(state.tasks.length);
}

function renderSlots(slots) {
  state.slots = slots;
  const box = $('slots');
  box.textContent = '';
  if (!slots) return;
  const head = el('div', 'row head');
  head.append(el('div', 'r-main', `${slots.day} · 完成 ${slots.counts.done ?? 0} / 失败 ${slots.counts.failed ?? 0} / 跳过 ${slots.counts.skipped ?? 0} / 待跑 ${slots.counts.planned ?? 0}`));
  box.append(head);
  // 每条槽：这个动作现在能不能跑（核验结果来自顶栏那次探针，不重复跑）
  const rows = annotateRows(slots.slots, state.preflight, (slot) => slot.action);
  for (const slot of rows) {
    const row = el('div', 'row');
    if (slot.state === 'fail') row.classList.add('bad');
    row.append(el('time', null, slot.clock ?? ''));
    const main = el('div', 'r-main');
    main.append(el('b', null, slot.action));
    if (slot.readiness) {
      const tag = el('span', `slotReady ${slot.readiness.ready ? 'ok' : 'bad'}`, slot.readiness.ready ? ' 能跑' : ' 还不行');
      tag.title = readinessText(slot.readiness);
      main.append(tag);
    }
    // 跳过的槽要能一眼看出「为什么跳过」，别让人去读 note 原文
    const why = skipReason(slot.note, slot.status);
    if (why) {
      const tag = el('span', 'slotSkip', ` ${why.short}`);
      tag.title = why.detail;
      main.append(tag);
    }
    if (slot.note) main.append(el('em', null, ` ${slot.note.replace(/\s+/g, ' ').slice(0, 90)}`));
    row.append(main);
    row.append(badge(slot.state, labelOf(STATUS_TEXT, slot.status, slot.status)));
    row.append(el('div', 'r-note', slot.taskId ? slot.taskId.slice(0, 18) : '—'));
    row.addEventListener('click', () => (slot.taskId ? openTask(slot.taskId) : openSlot(slot)));
    box.append(row);
  }
  $('tabSlots').textContent = String(slots.slots.length);
}

/** 跳过的槽：把 note 翻成「为什么没跑」的一句话（详情的原文留在 tooltip 里）。 */
function skipReason(note, status) {
  const text = String(note ?? '');
  if (!text) return null;
  const quota = /^quota_exhausted:(\d+)\/(\d+)$/u.exec(text);
  if (quota) return { short: '额度用完', detail: `本小时已发 ${quota[1]} 条（上限 ${quota[2]}），这条先不发。下一小时会自动恢复。` };
  if (/^skipped:pending_task|pending_task/u.test(text)) return { short: '已有待审草稿', detail: '上一条日常图文还在等你点头，这条等它处理完再跑（避免两篇撞一起）。' };
  if (/^manual_run_ok/u.test(text)) return { short: '已人工跑过', detail: '这条已经被人工跑通，调度器不再重复执行。' };
  if (/^retry:/u.test(text)) return { short: '抖动后重试', detail: '上次因环境抖动失败（手机掉线/超时），已重新排队。' };
  if (/^nothing_to_do/u.test(text)) return { short: '没活干', detail: '跑了但确实没有可处理的（只有表情或已回过）。这不是失败。' };
  if (/^blocked:/u.test(text)) return { short: '被闸门挡住', detail: text.slice(4) };
  if (status === 'skipped') return { short: '跳过', detail: text };
  return null;
}

/** 评论额度：「本小时还剩 N 条」——把自建限速摆到明面上，别让人误以为工具坏了。 */
function renderQuota(quota) {
  const box = $('quotaPill');
  if (!box || !quota) return;
  state.quota = quota;
  box.hidden = false;
  const text = $('quotaText');
  if (text) text.textContent = `评论额度 ${quota.hourlyLeft}/${quota.hourlyCap}（本小时）`;
  const wait = Number(quota.waitMs ?? 0);
  box.title = [
    `本小时已发 ${quota.hourlyUsed} 条（上限 ${quota.hourlyCap}）`,
    `今天已发 ${quota.dailyUsed} 条（上限 ${quota.dailyCap}）`,
    wait > 0 ? `距离下一条还要等 ${Math.ceil(wait / 1000)} 秒` : '间隔已够，可以发下一条',
    quota.source === 'default' ? '上限来自默认值' : `上限来自 ${quota.source}`,
  ].join('\n');
  box.classList.toggle('warn', quota.hourlyLeft === 0);
}

/** 近 7 天失败归类：一眼看出哪类问题最多。 */
function renderFailures(failures) {
  state.failures = failures ?? null;
  const box = $('failStrip');
  if (!box) return;
  box.textContent = '';
  const buckets = (failures?.buckets ?? []).filter((bucket) => bucket.id !== 'nothing_to_do');
  if (!buckets.length) { box.hidden = true; return; }
  box.hidden = false;
  box.append(el('span', 'failTitle', `本周问题 ${failures.total} 次`));
  for (const bucket of buckets.slice(0, 5)) {
    const chip = el('span', `failChip ${bucket.id}`, `${bucket.label} ${bucket.count}`);
    const ops = Object.entries(bucket.ops).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([op, n]) => `${op} ×${n}`).join(' · ');
    chip.title = ops || bucket.label;
    box.append(chip);
  }
}

// 「在页面上真的跑一次」：默认关着（服务端只认 live-run.json 里点名的动作），
// 并且要点两次才发请求——这一层挡的是误触，不是绕过审批。
function runBox(action, item = null) {
  const wrap = el('div', 'runBox');
  wrap.append(el('p', 'runNote', '这条会真的动手机 / 真的拨号。默认关着，需要主人在 runtime/connect/live-run.json 里点名放行。'));
  const btn = el('button', 'btn runBtn', '我现在要跑它');
  btn.type = 'button';
  const out = el('div', 'runOut');
  // 跑之前的最后确认：会做什么 / 会影响谁 / 跑完怎么核对（第三次点击才真跑）
  const confirm = el('div', 'runConfirm');
  confirm.hidden = true;
  const what = el('p', 'runWhat', item?.intro ?? '');
  const impact = el('p', 'runImpact', item?.impact ? `会影响：${item.impact}` : '');
  const checks = el('ul', 'runChecks');
  for (const line of item?.expect ?? []) checks.append(el('li', null, line));
  const actions = el('div', 'runActions');
  const cancel = el('button', 'btn runCancel', '先不跑');
  cancel.type = 'button';
  const go = el('button', 'btn runGo', '确认，跑一次');
  go.type = 'button';
  actions.append(cancel, go);
  confirm.append(what, impact, item?.expect?.length ? el('p', 'runChecksTitle', '跑完应该看到：') : el('span'), checks, actions);
  wrap.append(confirm);
  const reset = () => {
    confirm.hidden = true;
    btn.hidden = false;
    btn.textContent = '我现在要跑它';
    btn.classList.remove('armed');
  };
  cancel.addEventListener('click', reset);
  let stage = 0;
  // 截图/分享用：?confirm=<action> 直接把确认块展开
  const params = new URLSearchParams(location.search);
  if (params.get('confirm') === action) {
    btn.hidden = true;
    confirm.hidden = false;
    stage = 1;
  }
  // 演示/截图用：?run=<action> 自动展开并点一次（仍受放行清单约束）
  if (params.get('run') === action) {
    btn.hidden = true;
    confirm.hidden = false;
    stage = 1;
    setTimeout(() => go.click(), 400);
  }
  btn.addEventListener('click', () => {
    // 第一次点：展开确认块（不跑）
    btn.hidden = true;
    confirm.hidden = false;
    stage = 1;
    go.textContent = '确认，跑一次';
  });
  go.addEventListener('click', async () => {
    if (stage === 0) return;
    stage = 0;
    go.disabled = true;
    btn.disabled = true;
    btn.hidden = false;
    btn.textContent = '正在跑…';
    btn.classList.remove('armed');
    confirm.hidden = true;
    out.textContent = '';
    try {
      // 令牌在 readToken() 里已从地址栏搬到 sessionStorage（并把 URL 里的抹掉），两处都要认
      const token = new URLSearchParams(location.search).get('token') ?? sessionStorage.getItem(STORE_KEY) ?? '';
      const response = await fetch('/api/live/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ action, confirm: 'run' }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const why = payload.error === 'not_allowed' ? '主人还没放行这一条（live-run.json 里没有它）' : `没跑成：${payload.error ?? response.status}`;
        out.append(el('p', 'runFail', why));
      } else {
        // 一页回执：做了什么 → 实际结果 → 核对结论 → 要不要人看一眼；可整段复制
        const verdictLabel = VERDICT_LABEL[payload.verdict] ?? payload.verdict ?? '未知';
        const afterTone = !payload.after
          ? '没有跑后检查'
          : payload.after.verdict === 'pass' ? '符合预期'
            : payload.after.verdict === 'fail' ? '没看到应有的结果'
              : '这个动作没有跑后检查（只读动作正常）';
        const needsEye = payload.verdict !== 'confirmed' || payload.after?.verdict === 'fail';
        const receipt = [
          `【${item?.title ?? action}】${verdictLabel}${payload.reason && payload.reason !== 'ok' ? `（${reasonText(payload.reason)}）` : ''}`,
          `动作：${action}　耗时：${(Number(payload.elapsedMs ?? 0) / 1000).toFixed(1)}s`,
          `做了什么：${item?.intro ?? ''}`,
          `实际结果：${String(payload.text || '没有输出').replace(/\s+/gu, ' ').slice(0, 300)}`,
          `跑后核对：${afterTone}${(payload.after?.checks ?? []).length ? `（${(payload.after.checks ?? []).map((check) => `${check.key}${check.ok === true ? '✅' : check.ok === false ? '❌' : '❔'}`).join(' ')}）` : ''}`,
          `要不要人看一眼：${needsEye ? '要（判定不是「已确认」或核对没通过）' : '不用，机器已确认'}`,
        ].join('\n');
        state.lastRun = { action, receipt, taskId: payload.taskId ?? null, elapsedMs: payload.elapsedMs, verdict: payload.verdict, reason: payload.reason, after: payload.after };
        out.append(el('p', 'runOk', `跑完了（${(Number(payload.elapsedMs ?? 0) / 1000).toFixed(1)}s）：${payload.text || '没有输出'}`));
        out.append(receiptNode(receipt, payload.taskId ?? null));
        if (payload.after && (payload.after.checks ?? []).length) {
          // 副作用有没有真的发生：直接跟着结果一起显示，省一次手动「检查跑完的结果」
          const box = el('ul', 'runAfter');
          const tone = payload.after.verdict === 'pass' ? '符合预期' : payload.after.verdict === 'fail' ? '没看到应有的结果' : '看不出来';
          box.append(el('li', 'runAfterHead', `跑完之后核对：${tone}`));
          for (const check of payload.after.checks ?? []) {
            box.append(el('li', check.ok === true ? 'ok' : check.ok === false ? 'bad' : 'unknown',
              `${check.key}：${check.detail}`));
          }
          out.append(box);
        }
        // 跑完立刻把「卡片 / 就绪角标 / 报告页」一起刷新，页面自己往前走
        await refreshAfterRun().catch(() => {});
        if (typeof refreshTool === 'function') await refreshTool(action).catch(() => {});
      }
    } catch (error) {
      out.append(el('p', 'runFail', `请求失败：${String(error.message ?? error)}`));
    } finally {
      btn.disabled = false;
      btn.textContent = '我现在要跑它';
      btn.classList.remove('armed');
    }
  });
  wrap.append(btn, out);
  return wrap;
}

function renderRetired(retired) {
  const box = $('retiredStrip');
  if (!box) return;
  if (!retired?.length) { box.hidden = true; box.textContent = ''; return; }
  box.textContent = '';
  box.append(el('b', null, `已下线 ${retired.length} 个：`));
  for (const entry of retired) {
    const chip = el('span', 'retiredChip', entry.label ?? entry.action);
    chip.title = `${entry.action} · ${entry.retiredAt} 下线：${entry.reason}${entry.replacedBy ? `；替代：${entry.replacedBy}` : ''}`;
    box.append(chip);
  }
  box.append(el('span', 'retiredHint', '悬停看为什么下线（说明见 docs/TOOL-RUNBOOK.md）'));
  box.hidden = false;
}

function renderTools(data) {
  state.tools = data;
  const box = $('tools');
  box.textContent = '';
  if (!data) return;
  renderRetired(data.retired);
  // 「只看真实业务」：把我手动点出来的 ui-run-* 记录排掉，看它自己跑到什么程度
  const realOnly = state.realOnly === true;
  const toggle = el('label', 'realToggle');
  const box2 = el('input');
  box2.type = 'checkbox';
  box2.checked = realOnly;
  box2.addEventListener('change', async () => {
    state.realOnly = box2.checked;
    const next = await api(`/api/live/tools?real=${box2.checked ? 1 : 0}`);
    if (next) { renderTools(next); if (state.tab === 'report') renderReport(); }
  });
  toggle.append(box2, el('span', null, realOnly ? '只看真实业务（已排除页面手动跑）' : '只看真实业务'));
  box.append(toggle);
  const grid = el('div', 'cards');
  for (const item of data.items) {
    const card = el('article', 'card');
    card.dataset.level = item.level ?? 'auto';
    if (item.fail > 0) card.classList.add('bad');
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `${item.title ?? item.action ?? ''}：${item.levelLabel ?? ''}，近 7 天成功 ${item.ok ?? 0} 次、失败 ${item.fail ?? 0} 次`);

    const head = el('div', 'c-head');
    head.append(el('span', 'c-title', item.title ?? item.label ?? item.action ?? ''));
    const lvl = el('span', `c-lvl ${item.level ?? 'auto'}`, item.levelLabel ?? '');
    lvl.title = item.level === 'auto' ? '脚本自动跑，没有模型参与'
      : item.level === 'ai' ? '中间由模型生成内容或对话'
        : item.level === 'review' ? '产物会公开/不可撤销，需要人工确认'
          : '还没实现，模型不允许承诺';
    head.append(lvl);
    card.append(head);

    if (item.intro) card.append(el('p', 'c-intro', item.intro));
    const gaps = state.tools?.contracts?.[item.action]?.gaps ?? [];
    if (gaps.length) {
      const flag = el('span', 'c-gap', `契约缺 ${gaps.length} 项`);
      flag.title = gaps.map((gap) => gap.label).join('；');
      card.append(flag);
    }

    const meta = el('div', 'c-meta');
    meta.append(el('span', 'c-action', item.action ?? ''));
    const runs = Number(item.runs ?? 0);
    const ok = Number(item.ok ?? 0);
    const fail = Number(item.fail ?? 0);
    meta.append(el('span', fail > 0 ? 'c-stat bad' : 'c-stat', runs > 0 ? `近 7 天 ${ok} 成功 / ${fail} 失败` : '近 7 天没跑过'));
    // 「跑到哪一步」：最近一次真跑的时间 + 判定结论（已确认 / 未确认 / 对不上）
    const judged = item.lastVerdict ? (VERDICT_LABEL[item.lastVerdict] ?? item.lastVerdict) : '';
    const why = reasonText(item.lastVerdictReason);
    const when = shortClock(item.lastAt ?? item.lastVerdictAt);
    if (when) {
      const week = Number(item.weekRuns ?? 0);
      const quotaSkips = Number(item.weekQuotaSkips ?? 0);
      // 「本周 9 次」里有几次是被额度挡住的：分开说，别把跳过算成跑过
      const weekText = week
        ? ` · 本周 ${Math.max(0, week - quotaSkips)} 次${quotaSkips ? ` + 额度跳过 ${quotaSkips} 次` : ''}`
        : '';
      // 样本够不够：确认过 1 次 ≠ 稳定（只标注，不改判定）
      const note = sampleNote(week);
      const label = `${judged ? `最近 ${when} · ${judged}${why ? `（${why}）` : ''}` : `最近 ${when}`}${weekText}${note.thin && note.label ? ` · ${note.label}` : ''}`;
      const last = el('span', `c-last ${item.lastVerdict ?? item.lastState ?? ''}${note.thin ? ' thin' : ''}`, label);
      if (note.tip) last.title = note.tip;
      last.title = item.lastVerdictAt ? `最近一次判定 ${item.lastVerdict}${item.lastVerdictReason ? ` / ${item.lastVerdictReason}` : ''}（${item.lastVerdictAt}）` : '最近一次运行';
      meta.append(last);
    }
    card.append(meta);

    const bar = el('div', 'c-bar');
    const fill = el('i');
    fill.style.width = runs > 0 ? `${Math.round((ok / runs) * 100)}%` : '0%';
    bar.append(fill);
    card.append(bar);

    const open = () => openTool(item);
    card.addEventListener('click', open);
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });
    grid.append(card);
  }
  box.append(grid);
  $('tabTools').textContent = `${data.actions} 动作 / ${data.tools} 工具 / ${data.skills} 技能`;
  // 覆盖度小条：一眼看出「还有几个动作从没跑过」
  const cov = data.coverage;
  const bar = $('toolCoverage');
  if (bar && cov) {
    const pctOf = (n) => Math.round((n / Math.max(1, cov.total)) * 100);
    bar.innerHTML = '<i class="ok" style="width:' + pctOf(cov.confirmed) + '%"></i>'
      + '<i class="warn" style="width:' + pctOf(cov.unconfirmed) + '%"></i>'
      + '<i class="bad" style="width:' + pctOf(cov.failed) + '%"></i>';
    bar.title = `已确认 ${cov.confirmed} · 未确认 ${cov.unconfirmed} · 失败 ${cov.failed} · 没跑过 ${cov.untested}（共 ${cov.total} 个动作）`;
    const note = $('toolCoverageNote');
    if (note) note.textContent = `有证据 ${cov.confirmed + cov.unconfirmed + cov.failed}/${cov.total} · 没跑过 ${cov.untested}`;
  }
}

/* ---------------- 详情 ---------------- */

// /live 的九段 ↔ /flow 的节点：同一份映射表，两个页面互相跳时不会各写一份。
async function flowNodeFor(stage) {
  try {
    const mod = await import('/flow/layout.mjs');
    return mod.STAGE_NODE?.[stage] ?? null;
  } catch {
    return null;
  }
}

/* ---------------- 右侧栏：两个标签（事件 / 任务与工具）+ 返回栈 ---------------- */

const DETAIL_TABS = ['event', 'item'];
const DETAIL_EMPTY = {
  event: '点左边流水线里的一个阶段，或中间的一条事件，这里显示它收到/发出了什么。',
  item: '点一条任务、定时任务或工具，这里显示它的步骤、输入输出与证据。',
};

function renderDetail(title, sub, nodes) {
  // 有内容时才把详情栏展开（没选中时它只占一个窄条，不给中间内容让路）
  document.body.classList.remove('no-detail');
  const flow = $('dFlow');
  if (flow) {
    if (state.flowNode) {
      flow.hidden = false;
      flow.href = `/flow/?node=${encodeURIComponent(state.flowNode)}`;
    } else {
      flow.hidden = true;
    }
  }
  $('dTitle').textContent = title ?? '';
  $('dTitle').dataset.empty = title ? '' : '1';
  $('dSub').textContent = sub ?? '';
  const body = $('dBody');
  body.textContent = '';
  for (const node of nodes ?? []) body.append(node);
}

function setDetailTab(kind, { focus = false } = {}) {
  if (!DETAIL_TABS.includes(kind)) kind = 'event';
  state.detailKind = kind;
  for (const tab of document.querySelectorAll('.detailTabs .dtab')) {
    const on = tab.dataset.dtab === kind;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    tab.classList.toggle('on', on);
    if (on && focus) tab.focus();
  }
}

function paintBack() {
  const back = $('dBack');
  if (back) back.hidden = state.detailStack.length <= 1;
}

/** 打开一份新内容。push=true 表示从详情里的链接跳过去（可以返回上一层）。 */
function showDetail(kind, title, sub, nodes, { push = false } = {}) {
  const entry = { kind, title, sub, nodes };
  if (push && state.detailStack.length) state.detailStack.push(entry);
  else state.detailStack = [entry];
  if (state.detailStack.length > 24) state.detailStack.shift();
  state.lastByKind[kind] = entry;
  setDetailTab(kind);
  renderDetail(title, sub, nodes);
  paintBack();
}

function backDetail() {
  if (state.detailStack.length <= 1) return;
  state.detailStack.pop();
  const entry = state.detailStack[state.detailStack.length - 1];
  state.lastByKind[entry.kind] = entry;
  setDetailTab(entry.kind);
  renderDetail(entry.title, entry.sub, entry.nodes);
  paintBack();
}

function switchDetailTab(kind) {
  const entry = state.lastByKind[kind];
  setDetailTab(kind);
  if (entry) {
    renderDetail(entry.title, entry.sub, entry.nodes);
    paintBack();
  } else {
    renderDetail('', '', [el('p', 'empty', DETAIL_EMPTY[kind])]);
  }
}

function markSelected(id) {
  state.selected = id;
  for (const row of document.querySelectorAll('.ev.on, .row.on')) row.classList.remove('on');
  const row = document.querySelector(`.ev[data-id="${id}"]`);
  if (row) row.classList.add('on');
}

async function openEvent(id, row, { push = false } = {}) {
  markSelected(id);
  state.flowNode = 'events';
  let data;
  try { data = await api(`/api/live/event?id=${encodeURIComponent(id)}`); }
  catch (error) { if (String(error.message) !== 'unauthorized') setDetail('事件', '', [el('p', 'empty', `取不到这条事件：${error.message}`)]); return; }
  const ev = data.event;
  const title = `${labelOf(EVENT_LABEL, ev.eventType, ev.eventType)} · ${labelOf(CHANNEL, ev.channel, ev.channel)}`;
  showDetail('event', title, `${ev.clock} · ${ev.id}`, [
    section('状态', kv([
      ['阶段', ev.stage],
      ['状态', `${badge(ev.state, STATE_TEXT[ev.state] ?? ev.state).outerHTML.replace(/<[^>]+>/g, '')}`],
      ['actor', ev.actor],
      ['任务', ev.taskId],
      ['摘要', ev.summary],
    ])),
    section('输入（payload）', jsonBlock(ev.input)),
    section('输出（result）', jsonBlock(ev.output)),
    section('证据（evidence）', jsonBlock(ev.evidence)),
    data.task ? section('所属任务', taskSummaryNode(data.task)) : el('span'),
  ], { push });
}

function taskSummaryNode(task) {
  const box = el('div');
  box.append(kv([
    ['意图', task.intent],
    ['状态', `${task.status}（${labelOf(STATUS_TEXT, task.status, task.status)}）`],
    ['来源', task.origin],
    ['会话', `${task.conv_kind ?? ''} ${String(task.conv_id ?? '').slice(0, 14)}`],
    ['重试', task.attempts],
  ]));
  const btn = el('button', 'chip ghost', '打开任务详情 →');
  btn.style.marginTop = '6px';
  btn.onclick = () => openTask(task.id, { push: true });
  box.append(btn);
  return box;
}

async function openTask(id, { push = false } = {}) {
  state.flowNode = 'tasks';
  let data;
  try { data = await api(`/api/live/task?id=${encodeURIComponent(id)}`); }
  catch (error) { if (String(error.message) !== 'unauthorized') setDetail('任务', '', [el('p', 'empty', `取不到这个任务：${error.message}`)]); return; }
  const task = data.task;
  const steps = data.steps ?? [];
  const list = el('div', 'steps');
  for (const step of steps.slice(-MAX_DETAIL_STEPS)) {
    const row = el('div', 'step');
    row.dataset.state = step.state ?? 'ok';
    row.append(el('time', null, step.clock ?? ''));
    row.append(el('span', 'st'));
    const body = el('div');
    body.append(el('b', null, labelOf(EVENT_LABEL, step.eventType, step.eventType)));
    if (step.summary) body.append(el('em', null, step.summary));
    row.append(body);
    row.addEventListener('click', () => openEvent(step.id, null, { push: true }));
    list.append(row);
  }
  const meta = kv([
    ['意图', task.intent],
    ['状态', `${task.status}（${labelOf(STATUS_TEXT, task.status, task.status)}）`],
    ['来源', task.origin],
    ['会话', `${task.conv_kind ?? ''} ${task.conv_id ?? ''}`],
    ['重试', task.attempts],
    ['创建', task.createdMs ? new Date(task.createdMs).toLocaleString('zh-CN', { hour12: false }) : ''],
    ['更新', task.updatedMs ? new Date(task.updatedMs).toLocaleString('zh-CN', { hour12: false }) : ''],
  ]);
  // 顺序按「最常看的先」：先看走到哪一步，再看整单的输入输出，最后才是工作状态细节。
  const nodes = [
    section(`任务 · ${data.summary.total} 步${data.summary.failed ? ` · ${data.summary.failed} 步失败` : ''}`, meta),
    section('步骤时间线（点一步看它的输入与输出）', list),
    section('输入（payload）', jsonBlock(task.payload)),
    section('输出（result）', jsonBlock(task.result)),
    section('证据（evidence）', jsonBlock(task.evidence)),
  ];
  if (data.working) nodes.push(section('工作状态（working_tasks）', kv([
    ['状态', data.working.status],
    ['当前步骤', data.working.currentStep],
    ['下一步', data.working.nextAction],
    ['技能', data.working.selectedSkill],
    ['策略', data.working.strategy],
  ])));
  // 标题优先用「人话」：内部意图名（external_action_request）对人没意义，
  // 有具体动作就用动作标题（给爸爸打电话），没有才退回意图/任务号。
  const op = (task.operations ?? task.ops ?? task.payload?.operations ?? (task.result ?? []).map((row) => row.operation))[0];
  const title = op ? ownerOf(op) ?? op : ownerOf(task.intent) ?? task.intent ?? task.id;
  showDetail('item', `任务 · ${title}`, `${task.id} · 共 ${steps.length} 步`, nodes, { push });
}

/** 动作名 → 人话标题（用工具清单里的说明书，没有就退回动作名）。 */
function ownerOf(action) {
  const item = (state.tools?.items ?? []).find((entry) => entry.action === action || entry.tool === action);
  return item?.title ?? null;
}

function openSlot(slot) {
  state.flowNode = 'scheduler';
  showDetail('item', `定时任务 · ${ownerOf(slot.action) ?? slot.action}`, `${slot.clock} · ${slot.status}`, [
    section('执行记录', kv([['状态', slot.status], ['时间', slot.clock], ['动作', slot.action], ['任务', slot.taskId]])),
    section('参数（args）', jsonBlock(slot.args)),
    section('错误 / 备注（原文）', el('p', 'empty', slot.note || '（没有备注）')),
  ]);
}

/** 重新拉工具清单，只重开这一条详情（不动其它状态，也不整页刷新）。 */
/** 跑完一次之后，把「工具卡 / 就绪角标 / 报告页」一起刷新，别让页面停在旧数字上。 */
async function refreshAfterRun() {
  const list = await api('/api/live/tools');
  if (list?.items) {
    state.tools = list;
    renderTools(list);
  }
  await paintReady();
  if (state.tab === 'report') await renderReport();
}

async function refreshTool(action) {
  const needle = String(action ?? '');
  if (!needle) return null;
  const list = await api('/api/live/tools');
  if (!list?.items) return null;
  state.tools = list;
  renderTools(list);
  const item = list.items.find((entry) => entry.action === needle) ?? list.items.find((entry) => entry.tool === needle);
  if (item) {
    openTool(item);
    // 刷新会重建详情面板，把刚才那次跑的回执挂回去（否则跑完一刷新就看不见结果了）
    if (state.lastRun?.action === item.action) {
      const host = document.querySelector('#dBody');
      if (host) host.append(receiptNode(state.lastRun.receipt, state.lastRun.taskId ?? null));
    }
  }
  return item ?? null;
}

function openTool(item) {
  state.flowNode = 'actions';
  const needle = String(item.action ?? item.tool ?? '');
  const matched = needle
    ? state.events.filter((view) => String(view.summary ?? '').includes(needle)).slice(-40)
    : [];
  const list = el('div', 'steps');
  for (const view of matched) {
    const row = el('div', 'step');
    row.dataset.state = view.state ?? 'ok';
    row.append(el('time', null, view.clock));
    row.append(el('span', 'st'));
    const body = el('div');
    body.append(el('b', null, labelOf(EVENT_LABEL, view.eventType, view.eventType)));
    body.append(el('em', null, view.summary));
    row.append(body);
    row.addEventListener('click', () => openEvent(view.id, null, { push: true }));
    list.append(row);
  }
  const lvl = el('span', `lvl ${item.level ?? 'auto'}`, item.levelLabel ?? '');
  const head = el('div', 'toolHead');
  head.append(lvl);
  head.append(el('b', null, item.title ?? item.label ?? item.action ?? ''));
  showDetail('item', item.title ?? item.label ?? item.action ?? '工具', item.file ?? '', [
    section('这是什么', [
      head,
      el('p', 'intro', item.intro || '（还没写介绍）'),
    ]),
    section('逻辑详情', el('p', 'logic', item.logic || '（还没写流程）')),
    ...(item.steps?.length ? [section('这条流程分几步', (() => {
      const strip = el('ol', 'flowSteps');
      for (const step of item.steps) strip.append(el('li', null, step));
      return strip;
    })())] : []),
    ...(item.command ? [section('想自己手动跑', (() => {
      const box = el('div');
      const code = el('code', 'cmd', item.command);
      code.title = '点击复制';
      code.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(item.command); code.dataset.copied = '1'; setTimeout(() => { delete code.dataset.copied; }, 1200); } catch { /* 复制不了就算了 */ }
      });
      box.append(code, el('p', 'cmdHint', '点一下复制到终端即可（跑之前先看下面的「跑之前要确认」）。'));
      return box;
    })())] : []),
    ...(item.preflight?.length ? [section('跑之前要确认', (() => {
      const box = el('div');
      const list = el('ul', 'checks');
      for (const line of item.preflight) list.append(el('li', null, line));
      box.append(list);
      // 能机器判断的条件直接给结果，不用人肉核对（点一下才去问系统，避免每次打开都跑 adb）
      const probe = el('button', 'btn probe', '检查现在能不能跑');
      const out = el('div', 'probeOut');
      probe.addEventListener('click', async () => {
        probe.disabled = true;
        out.textContent = '正在检查…';
        try {
          const data = await api('/api/live/preflight');
          const row = data?.results?.[item.action];
          if (!row) { out.textContent = '这个工具没有可自动核验的前置条件。'; return; }
          out.textContent = '';
          for (const check of row.checks) {
            const line = el('div', `probeLine ${check.ok ? 'ok' : 'bad'}`);
            line.append(el('b', null, check.ok ? '✅' : '❌'));
            line.append(el('span', null, ` ${check.detail}`));
            out.append(line);
          }
          const tail = el('p', 'probeTip', row.ready ? '机器能判的都满足；剩下的（时间是否合适、内容是否认可）由你决定。' : '先把上面 ❌ 的处理掉再跑。');
          out.append(tail);
        } catch (error) {
          out.textContent = `检查失败：${error.message}`;
        } finally {
          probe.disabled = false;
        }
      });
      // 预演：不执行，只把命令 / 影响 / 核对点 / 当前前置摆出来
      const previewBtn = el('button', 'btn probe', '预演：看它会做什么');
      const previewOut = el('div', 'previewOut');
      previewBtn.addEventListener('click', async () => {
        previewBtn.disabled = true;
        previewOut.textContent = '正在整理…';
        try {
          const data = await api(`/api/live/preview?action=${encodeURIComponent(item.action)}`);
          previewOut.textContent = '';
          if (!data || data.error) { previewOut.textContent = `预演失败：${data?.error ?? '未知原因'}`; return; }
          if (data.command) previewOut.append(el('pre', 'previewCmd', `$ ${data.command}`));
          if (data.what) previewOut.append(el('p', 'previewLine', `做什么：${data.what}`));
          if (data.impact) previewOut.append(el('p', 'previewImpact', `影响：${data.impact}`));
          if (data.expect?.length) previewOut.append(el('p', 'previewLine', `跑完核对：${data.expect.join('；')}`));
          if (data.preflightNow) {
            const row = data.preflightNow;
            previewOut.append(el('p', 'previewLine', `现在的前置：${row.ready ? '全部满足' : '有未满足项'}`));
            for (const check of row.checks ?? []) {
              previewOut.append(el('p', check.ok ? 'previewOk' : 'previewBad', `${check.ok ? '✅' : '❌'} ${check.detail}`));
            }
          }
          if (data.why) previewOut.append(el('p', 'previewWhy', data.why));
        } catch (error) {
          previewOut.textContent = `预演失败：${error.message}`;
        } finally {
          previewBtn.disabled = false;
        }
      });
      box.append(probe, previewBtn, out, previewOut);
      // 深链 ?preflight=1 自动跑一次（截图/省一次点击）
      if (new URLSearchParams(location.search).get('preflight') === '1') setTimeout(() => probe.click(), 120);
      if (new URLSearchParams(location.search).get('preview') === '1') setTimeout(() => previewBtn.click(), 160);
      return box;
    })())] : []),
    ...(item.expect?.length ? [section('跑完应该看到什么', (() => {
      const box = el('div');
      const list = el('ul', 'checks');
      for (const line of item.expect) list.append(el('li', null, line));
      box.append(list);
      // 跑完点一下就按这些条件去库里/系统里核（只读：查作品表、call_ended、草稿文件）
      const check = el('button', 'btn probe', '检查跑完的结果');
      const out = el('div', 'probeOut');
      check.addEventListener('click', async () => {
        check.disabled = true;
        out.textContent = '正在核对…';
        try {
          const data = await api(`/api/live/verify?action=${encodeURIComponent(item.action)}`);
          out.textContent = '';
          for (const entry of data?.checks ?? []) {
            const tone = entry.ok === true ? 'ok' : entry.ok === false ? 'bad' : 'skip';
            const line = el('div', `probeLine ${tone}`);
            line.append(el('b', null, entry.ok === true ? '✅' : entry.ok === false ? '❌' : '…'));
            line.append(el('span', null, ` ${entry.detail}`));
            out.append(line);
          }
          const tone = data?.verdict === 'pass' ? '看到了，副作用确实发生了。' : data?.verdict === 'fail' ? '没看到应有的结果，先别当成功。' : '没有足够证据，别急着下结论。';
          out.append(el('p', 'probeTip', tone));
        } catch (error) {
          out.textContent = `核对失败：${error.message}`;
        } finally {
          check.disabled = false;
        }
      });
      box.append(check, out);
      if (new URLSearchParams(location.search).get('verified') === '1') setTimeout(() => check.click(), 140);
      return box;
    })())] : []),
    section('能力映射', kv([
      ['动作', item.action], ['工具', item.tool], ['技能', item.skill],
      ['类别', item.capability], ['风险', item.risk], ['状态', item.status],
      ['已实现', item.implemented ? '是' : '否'],
      ['近 7 天', `开始 ${item.runs} / 成功 ${item.ok} / 失败 ${item.fail}`],
    ])),
    ...(item.weekScanned ? [section('本周「没活干」的量', el('p', 'intro',
      `扫了 ${item.weekScanned} 条，${Object.entries(item.weekBreakdown ?? {}).map(([key, n]) => {
        const label = { no_content: '只有表情', already_replied: '已回过', nothing_new: '没新评论', not_sent: '没发出去' }[key] ?? key;
        return `${label} ${n} 条`;
      }).join(' · ') || '没有具体跳过原因'}。这不是失败，是确实没有可处理的。`))] : []),
    runBox(item.action, item),
    ...((item.trend ?? []).some((point) => point.ok || point.bad) ? [section('近 5 周（左旧右新）', (() => {
      // 5 根小柱：柱高=当周成功率，底色=当周有没成功的；悬停给具体数
      const strip = el('div', 'trendStrip');
      for (const point of item.trend) {
        const total = point.ok + point.bad;
        const cell = el('span', `trendCell${total ? '' : ' empty'}`);
        const when = point.weeksAgo === 0 ? '本周' : `${point.weeksAgo} 周前`;
        cell.title = total ? `${when}：成功 ${point.ok} / 未成功 ${point.bad}` : `${when}：没跑过`;
        if (total) {
          const bar = el('i', 'trendBar');
          bar.style.height = `${Math.max(6, Math.round((point.ok / total) * 100))}%`;
          cell.append(bar);
        }
        strip.append(cell);
      }
      const sum = item.trend.reduce((acc, point) => ({ ok: acc.ok + point.ok, bad: acc.bad + point.bad }), { ok: 0, bad: 0 });
      const wrap = el('div');
      wrap.append(strip, el('p', 'intro', `近 5 周共 ${sum.ok + sum.bad} 次：成功 ${sum.ok} / 未成功 ${sum.bad}`));
      return wrap;
    })())] : []),
    ...((item.reasons ?? []).length ? [section('近 7 天按原因分组', (() => {
      // 同一个原因反复出现，才是「到底卡在哪」；最近 5 条看不出来
      const list = el('ul', 'reasonList');
      for (const entry of item.reasons) {
        const row = el('li', `reasonRow ${entry.id}`);
        row.append(el('b', 'reasonName', entry.label), el('span', 'reasonCount', `×${entry.count}`));
        if (entry.sample) row.append(el('span', 'reasonSample', entry.sample));
        list.append(row);
      }
      return list;
    })())] : []),
    section('判定历史（最近 5 次，点时间跳到那次任务）', item.history?.length
      ? (() => {
        const box = el('div', 'steps');
        for (const entry of item.history) {
          // 有 task_id 就做成链接：点一下直接跳到那次任务，看它的输入输出
          const row = entry.taskId ? el('a', 'step link') : el('div', 'step');
          if (entry.taskId) row.href = `?task=${encodeURIComponent(entry.taskId)}&tab=events`;
          row.dataset.state = entry.verdict === 'confirmed' ? 'ok' : entry.verdict === 'unconfirmed' ? 'wait' : 'fail';
          row.append(el('time', null, shortClock(entry.at)));
          row.append(el('span', 'st'));
          const body = el('div');
          const title = el('b', null, VERDICT_LABEL[entry.verdict] ?? entry.verdict);
          if (entry.origin === 'ui') title.append(el('span', 'originTag', '页面手动'));
          body.append(title);
          body.append(el('em', null, reasonText(entry.reason) || entry.reason || ''));
          row.append(body);
          box.append(row);
        }
        return box;
      })()
      : el('p', 'empty', '还没有判定记录（没跑过，或跑的那次没有留快照）。')),
    // 页面上亲手跑过的记录（留在 runtime/connect/live-runs/，关掉页面也还在）
    // 两段式流程（写草稿 → 人工二审 → 发作品）：把判定历史里两条孤立记录连成一条进度
    section('这条流程现在走到哪一步', item.flow?.steps?.length
      ? (() => {
        const box = el('ol', 'pflow');
        for (const step of item.flow.steps) {
          const row = el('li', `pflowStep ${step.state}`);
          row.append(el('span', 'pflowDot', step.state === 'done' ? '✓' : step.state === 'now' ? '●' : step.state === 'fail' ? '✕' : '○'));
          const body = el('div', 'pflowBody');
          body.append(el('b', null, step.label));
          body.append(el('em', null, step.detail));
          // 卡在「人工二审」时就地给出去处：看这条任务 / 去运行看板批准
          if (step.state === 'now' && step.taskId) {
            const links = el('div', 'pflowLinks');
            const openTask = el('a', 'pLink', '看这条任务 →');
            openTask.href = `?task=${encodeURIComponent(step.taskId)}&tab=events`;
            const goBoard = el('a', 'pLink', '去运行看板批准 →');
            goBoard.href = '/board';
            links.append(openTask, goBoard);
            body.append(links);
            body.append(el('em', 'pflowHint', '也可以直接在 QQ 里回一句「同意」。'));
          }
          row.append(body);
          box.append(row);
        }
        return box;
      })()
      : el('p', 'empty', '这条动作没有分步流程。')),
    section('页面上跑过的记录（最近 3 次）', item.uiRuns?.length
      ? (() => {
        const box = el('div', 'uiRuns');
        for (const run of item.uiRuns) {
          const row = el('details', 'uiRun');
          const summary = el('summary', 'uiRunHead');
          summary.append(el('time', null, shortClock(run.at)));
          summary.append(el('span', `uiRunVerdict ${run.verdict}`, VERDICT_LABEL[run.verdict] ?? run.verdict));
          summary.append(el('span', 'uiRunMs', `${(Number(run.elapsedMs ?? 0) / 1000).toFixed(1)}s`));
          row.append(summary);
          const body = el('div', 'uiRunBody');
          body.append(el('pre', 'uiRunText', String(run.text ?? '').slice(0, 600) || '（没有输出）'));
          if (run.after?.verdict) {
            body.append(el('p', 'uiRunAfter',
              `跑后核对：${run.after.verdict === 'pass' ? '符合预期' : run.after.verdict === 'fail' ? '没看到应有的结果' : '没有跑后检查'}`));
          }
          row.append(body);
          box.append(row);
        }
        return box;
      })()
      : el('p', 'empty', '还没在页面上跑过这一条（手动跑或定时跑不会记在这里）。')),
    section('最近相关事件（点一条看输入输出）', matched.length ? list : el('p', 'empty', '最近事件里还没有它的记录。')),
    // 手动跑完不用整页刷新：点一下重新拉这张卡的数据
    section('刚跑完？', [(() => {
      const btn = el('button', 'btn probe', '刷新「最近一次」');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = '刷新中…';
        const fresh = await refreshTool(item.action ?? item.tool);
        if (!fresh) { btn.disabled = false; btn.textContent = '刷新「最近一次」'; }
      });
      return btn;
    })()]),
  ]);
}

/**
 * 点顶栏「授权项就绪 X/Y」→ 右侧列出这 7 项各自缺什么。
 * 结论来自 /api/live/preflight（只读探针，20s 缓存），页面上不再重复跑。
 */
function openReady() {
  const results = state.preflight ?? {};
  // 右上角只数「需要授权」的那 7 项；手机类动作在定时任务页用，不占这里的名额
  const entries = Object.values(results).filter((entry) => !entry.group || entry.group === 'authorized');
  if (!entries.length) {
    showDetail('item', '授权项就绪', '还没拿到核验结果', [el('p', 'empty', '先点任意一个授权类工具 →「检查现在能不能跑」，或稍等接口返回。')]);
    return;
  }
  const ready = entries.filter((entry) => entry.ready).length;
  const note = el('p', 'intro', '');
  const box = el('div', 'readyList');
  for (const entry of entries) {
    const row = el('div', `readyRow ${entry.ready ? 'ok' : 'bad'}`);
    row.append(el('b', null, entry.ready ? '✅' : '❌'));
    row.append(el('span', 'readyName', entry.action));
    for (const check of entry.checks) {
      row.append(el('em', check.ok ? 'ok' : 'bad', check.ok ? check.detail : `缺：${check.detail}`));
    }
    // 临时放行：只读工具或已确认过的动作可以自助；剩下的必须主人改文件
    const grant = el('button', 'readyGrant', '临时放行 30 分钟');
    grant.type = 'button';
    grant.addEventListener('click', async () => {
      grant.disabled = true;
      const result = await api('/api/live/grant', { method: 'POST', body: { action: entry.action } });
      if (result?.ok) {
        const minutes = Math.max(1, Math.round((result.until - Date.now()) / 60000));
        note.textContent = `已临时放行 ${entry.action}，${minutes} 分钟后自动失效（不用手动收回）。`;
      } else if (result?.error === 'needs_owner') {
        note.textContent = `${entry.action} 会响手机或公开发作品，必须主人在 runtime/connect/live-run.json 里点名放行：${result.snippet ?? ''}`;
      } else {
        note.textContent = `没放行：${result?.error ?? '未知原因'}`;
      }
      grant.disabled = false;
    });
    // 永久放行：同样只对「只读 / 已确认」开放，公开动作会被服务端 403 并给出要写的 JSON
    const forever = el('button', 'readyGrant', '写入永久放行');
    forever.type = 'button';
    forever.addEventListener('click', async () => {
      forever.disabled = true;
      const result = await api('/api/live/grant', { method: 'POST', body: { action: entry.action, mode: 'permanent' } });
      if (result?.ok) {
        note.textContent = `已写进 permanent 清单：${entry.action}（要收回就编辑 runtime/connect/live-run.json 的 allowed）`;
      } else if (result?.error === 'needs_owner') {
        note.textContent = `这一条只能你自己写：${result.snippet ?? ''}`;
      } else {
        note.textContent = `没写成：${result?.error ?? '未知原因'}`;
      }
      forever.disabled = false;
    });
    const btnRow = el('div', 'readyBtns');
    btnRow.append(grant, forever);
    row.append(btnRow);
    box.append(row);
  }
  showDetail('item', '授权项就绪', `${ready}/${entries.length} 项现在能跑`, [
    ...(state.grantInfo?.count ? [section('现在有临时放行', (() => {
      const list = el('ul', 'grantList');
      for (const item of state.grantInfo.items) {
        const left = Math.max(0, Math.round((item.until - Date.now()) / 60000));
        list.append(el('li', null, `${item.action}：还剩 ${left} 分钟自动失效`));
      }
      if ((state.grantInfo.permanent ?? []).length) {
        list.append(el('li', null, `永久放行（写在 live-run.json 的 allowed 里）：${state.grantInfo.permanent.join('、')}`));
      }
      return list;
    })())] : []),
    section('放行清单备注', (() => {
      const wrap = el('div', 'noteBox');
      wrap.append(el('p', 'intro', '写一句「为什么开这个口子」，过一周回头看还有用：'));
      const input = el('input', 'noteInput');
      input.type = 'text';
      input.maxLength = 160;
      input.placeholder = '例：11/18 验声卡链路，临时放开 qq.call';
      input.value = state.grantInfo?.note ?? '';
      const save = el('button', 'noteSave', '保存备注');
      save.type = 'button';
      const note = el('p', 'noteTip', state.grantInfo?.note ? `现在写着：${state.grantInfo.note}` : '现在没有备注。');
      save.addEventListener('click', async () => {
        save.disabled = true;
        const result = await api('/api/live/note', { method: 'POST', body: { note: input.value } });
        note.textContent = result?.ok ? (result.note ? `已保存：${result.note}` : '已清空备注。') : `没写成：${result?.error ?? '未知原因'}`;
        save.disabled = false;
      });
      wrap.append(input, save, note);
      return wrap;
    })()),
    section('这 7 项是哪些', el('p', 'intro', '都需要真实副作用（响手机 / 公开发作品），所以先核验再放行。')),
    box,
    note,
    section('放行方式', el('p', 'intro', '只读工具、以及已经确认过的动作，可以在上面点「临时放行 30 分钟」——到点自动失效。会响手机或公开发作品的 7 个，必须主人在 runtime/connect/live-run.json 里点名。')),
  ]);
}



// 「一页回执」节点：同一份内容既在本次运行里显示，也在刷新后保留
function receiptNode(text, taskId = null) {
  const box = el('div', 'runReceipt');
  box.append(el('pre', 'runReceiptText', text));
  const copy = el('button', 'btn runCopy', '复制这段回执');
  copy.type = 'button';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = '已复制';
    } catch {
      copy.textContent = '复制失败，请手动选中';
    }
  });
  box.append(copy);
  // 证据包：回执 + 判定 + 跑后核对 + 相关事件，粘到哪都能复核（不依赖这个页面）
  if (taskId) {
    const exportBtn = el('button', 'btn runExport', '导出这次证据（Markdown）');
    exportBtn.type = 'button';
    exportBtn.addEventListener('click', async () => {
      exportBtn.disabled = true;
      const data = await api(`/api/live/evidence?id=${encodeURIComponent(taskId)}`);
      exportBtn.disabled = false;
      if (!data?.markdown) { exportBtn.textContent = `导出失败：${data?.error ?? '未知原因'}`; return; }
      try {
        await navigator.clipboard.writeText(data.markdown);
        exportBtn.textContent = '证据已复制（Markdown）';
      } catch {
        const pre = el('pre', 'runReceiptText', data.markdown);
        box.append(pre);
        exportBtn.textContent = '浏览器不给写剪贴板，已贴在下方';
      }
    });
    box.append(exportBtn);
  }
  return box;
}

function closeDetail() {
  state.selected = null;
  state.detailStack = [];
  document.body.classList.add('no-detail');
  for (const row of document.querySelectorAll('.ev.on, .row.on')) row.classList.remove('on');
  renderDetail('', '', [el('p', 'empty', '左边点一个阶段、一条事件、一个任务，这里会显示它收到了什么、回了什么、错在哪一步。')]);
  paintBack();
}

/* ---------------- 连接与启动 ---------------- */

/**
 * 顶栏「需要授权的 7 个里现在有几项能跑」。
 * 只问一次（接口有 20s 缓存），拿不到就静默隐藏，不影响主界面。
 */
async function paintReady() {
  try {
    const data = await api('/api/live/preflight');
    state.preflight = data?.results ?? {};
    // 只数「需要授权」的那 7 项；手机类动作不占顶栏名额（它们出现在定时任务页的徽标上）
    const entries = Object.values(state.preflight).filter((entry) => !entry.group || entry.group === 'authorized');
    if (!entries.length) return;
    const ready = entries.filter((entry) => entry.ready).length;
    const pill = $('readyPill');
    const text = $('readyText');
    if (!pill || !text) return;
    if (state.slots) renderSlots(state.slots);
    text.textContent = `授权项就绪 ${ready}/${entries.length}`;
    pill.hidden = false;
    pill.style.cursor = 'pointer';
    pill.title = '点开看每一项缺什么';
    pill.classList.toggle('warn', ready < entries.length);
    pill.title = entries.map((entry) => `${entry.action}：${entry.ready ? '就绪' : entry.checks.filter((c) => !c.ok).map((c) => c.detail).join('；')}`).join('\n');
  } catch { /* 没令牌或接口没起：不打扰 */ }
}

function setLive(on, text) {
  state.live = on;
  $('livePill').classList.toggle('on', on);
  $('liveText').textContent = text ?? (on ? '实时 · 已连接' : '离线');
}

function connectStream() {
  if (state.stream) state.stream.close();
  const url = `/api/live/stream${state.token ? `?token=${encodeURIComponent(state.token)}` : ''}`;
  const source = new EventSource(url);
  state.stream = source;
  source.onopen = () => setLive(true, '实时 · 已连接');
  source.onerror = () => setLive(false, '重连中…');
  source.onmessage = (message) => {
    let payload;
    try { payload = JSON.parse(message.data); } catch { return; }
    if (payload.type === 'hello') {
      applySnapshot(payload.snapshot);
      setLive(true, '实时 · 已连接');
    } else if (payload.type === 'events') {
      pushEvents(payload.events);
    } else if (payload.type === 'stats') {
      renderStats(payload.totals);
      updateStages(payload.stages ?? []);
      renderTasks(payload.tasks ?? []);
      if (payload.slots) renderSlots(payload.slots);
    } else if (payload.type === 'error') {
      setLive(false, `出错：${payload.error}`);
    }
  };
}

function applySnapshot(snapshot) {
  if (!snapshot) return;
  state.snapshot = snapshot;
  renderStats(snapshot.totals);
  state.grantInfo = snapshot.grantInfo ?? null;
  renderFailures(snapshot.failures);
  renderQuota(snapshot.commentQuota);
  if (snapshot.failures) state.failures = snapshot.failures;
  renderStages(snapshot.stages ?? []);
  state.events = (snapshot.recent ?? []).slice();
  renderStream();
  renderTasks(snapshot.tasks ?? []);
  renderSlots(snapshot.slots ?? null);
  // 打开页面就先在底部那一行显示「最近发生了什么」，不用等第一条新事件
  const latest = state.events[state.events.length - 1];
  if (latest) setTicker(latest);
  const tabEvents = $('tabEvents');
  if (tabEvents) tabEvents.textContent = String(snapshot.totals?.events ?? state.events.length);
}

async function boot() {
  document.body.classList.add('no-detail');
  renderLegend();
  setDetailTab('event');
  state.token = readToken();
  // 截图/演示用：只拉一次快照，不订阅 SSE（headless Chrome 会被常开的 EventSource 卡住不退出）。
  state.offline = new URLSearchParams(location.search).has('nostream');
  try {
    const snapshot = await api('/api/live/snapshot');
    hideGate();
    applySnapshot(snapshot);
    if (!state.offline) connectStream();
    else setLive(true, '实时 · 快照模式');
    api('/api/live/tools').then(renderTools).catch(() => {});
    // ?ready=1 直接把「授权项就绪」清单展开（截图/分享用）
    // ?day=2026-11-17 看某一天的定时任务（默认是库里最新一天）
    const wantDay = new URLSearchParams(location.search).get('day');
    if (wantDay && /^\d{4}-\d{2}-\d{2}$/u.test(wantDay)) {
      api(`/api/live/slots?day=${wantDay}`).then((data) => { if (data?.slots) renderSlots(data); }).catch(() => {});
    }
    paintReady().then(() => { if (new URLSearchParams(location.search).has('ready')) openReady(); });
    openFromUrl();
  } catch (error) {
    if (String(error.message) === 'unauthorized') showGate(`没带令牌（${error.message}）。`);
    else setLive(false, `连不上：${error.message}`);
  }
}

/** 深链：/live/?task=task_xxx 或 ?event=event_xxx 直接展开那条记录。 */
function openFromUrl() {
  const params = new URLSearchParams(location.search);
  const taskId = params.get('task');
  const eventId = params.get('event');
  const tab = params.get('tab');
  if (tab) selectTab(tab);
  const stageParam = params.get('stage');
  if (stageParam) {
    selectTab('events');
    toggleStage(stageParam);
  }
  const toolName = params.get('tool');
  if (toolName) {
    // ?tool=qq.call 这类深链要等工具清单拉回来，否则没有说明书可显示
    setTimeout(() => {
      // 先按动作名精确匹配，再退回工具名——`douyin.draft` 的 tool 字段也叫 douyin.publish，
      // 只按 tool 匹配会把「发布」深链错开成「写草稿」
      const items = state.tools?.items ?? [];
      const item = items.find((entry) => entry.action === toolName)
        ?? items.find((entry) => entry.tool === toolName);
      if (item) openTool(item);
    }, 600);
  } else if (taskId) setTimeout(() => openTask(taskId), 260);
  else if (eventId) setTimeout(() => openEvent(eventId), 260);
}

/* ---------------- 事件绑定 ---------------- */

$('gateBtn').addEventListener('click', async () => {
  const value = $('gateInput').value.trim();
  if (!value) { $('gateErr').textContent = '先粘贴令牌。'; return; }
  state.token = value;
  sessionStorage.setItem(STORE_KEY, value);
  try {
    const snapshot = await api('/api/live/snapshot');
    hideGate();
    applySnapshot(snapshot);
    connectStream();
    api('/api/live/tools').then(renderTools).catch(() => {});
    paintReady();
  } catch { $('gateErr').textContent = '令牌不对。'; }
});
$('gateInput').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('gateBtn').click(); });

$('readyPill').addEventListener('click', () => openReady());
$('readyPill').addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openReady(); } });
$('dClose').addEventListener('click', closeDetail);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeDetail();
  else if (event.key === 'Backspace' && !/^(input|textarea)$/iu.test(event.target?.tagName ?? '')) {
    event.preventDefault();
    backDetail();
  }
});

/* 事件筛选：状态 + 关键词 */
for (const chip of document.querySelectorAll('#eventFilters .fchip')) {
  chip.addEventListener('click', () => {
    state.filterState = chip.dataset.state ?? '';
    for (const node of document.querySelectorAll('#eventFilters .fchip')) node.setAttribute('aria-pressed', String(node === chip));
    renderStream();
  });
}
$('eventSearch').addEventListener('input', (event) => {
  state.search = event.target.value ?? '';
  renderStream();
});

/* 任务筛选：状态 + 关键词 */
for (const chip of document.querySelectorAll('#taskFilters .fchip')) {
  chip.addEventListener('click', () => {
    state.taskState = chip.dataset.fstate ?? '';
    for (const node of document.querySelectorAll('#taskFilters .fchip')) node.setAttribute('aria-pressed', String(node === chip));
    renderTasks(state.tasks);
  });
}
$('taskSearch').addEventListener('input', (event) => {
  state.taskSearch = event.target.value ?? '';
  renderTasks(state.tasks);
});

/* 右侧栏两个标签 + 返回 */
for (const tab of document.querySelectorAll('.detailTabs .dtab')) {
  tab.addEventListener('click', () => switchDetailTab(tab.dataset.dtab));
}
document.querySelector('.detailTabs')?.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  switchDetailTab(state.detailKind === 'event' ? 'item' : 'event');
});
$('dBack').addEventListener('click', backDetail);

$('pauseBtn').addEventListener('click', () => {
  state.paused = !state.paused;
  $('pauseBtn').textContent = state.paused ? '继续' : '暂停';
  $('pauseBtn').classList.toggle('chip', state.paused);
});

wireTabs();

window.__LIVE_READY__ = true;
boot();
