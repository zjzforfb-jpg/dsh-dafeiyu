// 主页渲染。数据三来源：
// 1) ./data.mjs           —— 技术栈 + 九段流水线（静态，测试可校验）
// 2) /live/tool-meta.mjs  —— 每项能力的人话说明书（静态，不需要令牌）
// 3) /api/live/snapshot   —— 今日四个数字（需要令牌，拿不到就显示「—」）
//
// 首屏讲「它能做什么」：按场景分五组，每组里只露能力名 + 等级徽章，
// 细节（介绍 / 入口文件 / 逻辑）全部收进 <details>，点开才出现。
// 纯 DOM 一次性渲染：没有 rAF、没有定时器。

import { PIPELINES, STACK } from './data.mjs';
import { LEVELS, TOOL_META, TOOL_ONLY_META } from '/live/tool-meta.mjs';
import { nextSteps } from '/live/next-steps.mjs';
import { VERDICT_LABEL, reasonText, shortClock } from '/live/reason-text.mjs';

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

const TOOLS = [
  ...Object.entries(TOOL_META).map(([action, meta]) => ({ key: action, kind: '动作', ...meta })),
  ...Object.entries(TOOL_ONLY_META).map(([tool, meta]) => ({ key: tool, kind: '只读', ...meta })),
];

/* ---------------- 能力分组 ---------------- */

// 分组只看动作前缀，新工具只要落在已有前缀下就自动归位。
const GROUPS = [
  { id: 'douyin', accent: '#22d3ee', label: '抖音运营', blurb: '看热点、写图文、回评论、发作品', match: (key) => key.startsWith('douyin.') || /^(works|comments)\./u.test(key) },
  { id: 'talk', accent: '#a78bfa', label: '联络与通话', blurb: '给家里人打电话、接电话、微信语音', match: (key) => /^(qq|wechat)\./u.test(key) },
  { id: 'device', accent: '#34d399', label: '手机与桌面', blurb: '看手机屏幕、点界面、跑桌面自动化', match: (key) => /^(device|macui)\./u.test(key) },
  { id: 'grow', accent: '#fb923c', label: '成长与学习', blurb: '写成长周记、沉淀技能账本', match: (key) => key.startsWith('academy.') },
  { id: 'misc', accent: '#94a3b8', label: '其他能力', blurb: '天气、能力自述这类小工具', match: () => true },
];

function groupOf(tool) {
  return GROUPS.find((group) => group.match(tool.key)) ?? GROUPS[GROUPS.length - 1];
}

function capabilityNode(tool) {
  const item = el('li', 'cap');
  item.dataset.level = tool.level;

  const details = el('details', 'capBox');
  const summary = el('summary', 'capSummary');
  summary.append(el('span', 'capName', tool.title));
  summary.append(el('span', `lvl ${tool.level}`, LEVELS[tool.level]?.label ?? tool.level));
  // 最近一次真跑 + 判定：折叠状态下也要看得见，所以放在 summary 行里
  const verdict = flowSnapshot?.tools?.[tool.key];
  if (verdict) {
    const label = VERDICT_LABEL[verdict.verdict] ?? verdict.verdict;
    const why = reasonText(verdict.reason);
    const week = Number(verdict.weekRuns ?? 0);
    const weekText = week ? ` · 本周 ${week} 次` : '';
    const last = el('span', `capLast ${verdict.verdict}`, `${shortClock(verdict.at)} ${label}${why ? `（${why}）` : ''}${weekText}`);
    last.title = `最近一次：${verdict.verdict}${verdict.reason ? ` / ${verdict.reason}` : ''}（${verdict.at}）`;
    summary.append(last);
  }
  details.append(summary);

  const body = el('div', 'capBody');
  body.append(el('p', null, tool.intro || '（还没写介绍）'));
  const meta = el('p', 'capMeta');
  meta.append(el('span', 'kind', tool.kind));
  meta.append(el('code', null, tool.file));
  body.append(meta);
  body.append(el('p', 'logic', tool.logic || '（还没写流程）'));
  const more = el('a', 'capMore', '在实时工作流里看它的输入输出 →');
  more.href = `/live/?tab=tools&tool=${encodeURIComponent(tool.key)}`;
  body.append(more);

  details.append(body);
  item.append(details);
  return item;
}

let levelFilter = '';
let flowSnapshot = null; // /api/flow/summary：每个动作最近一次判定（公开接口，不需要令牌）

const REASON_LABEL = { nothing_to_do: '没活干', no_evidence: '没拿到证据', no_result_data: '没返回数据', awaiting_external_event: '等外部事件', detail_not_opened: '打不开视频', comment_panel_not_open: '评论面板没开', work_not_found: '没找到作品', result_not_found: '没搜到结果' };
// 脚本抛的错常常是一整行 `Command failed: node …`，列表里只留一句人话
function commandLabel(reason) {
  if (!/^Command failed/u.test(String(reason))) return '';
  const line = String(reason).split('\n')[1] ?? '';
  if (/detail_not_opened/u.test(line)) return '打不开视频';
  if (/comment_panel_not_open/u.test(line)) return '评论面板没开';
  if (/device_offline|no devices|adb/u.test(line)) return '手机没连上';
  return '脚本报错';
}



async function loadSummary() {
  try {
    const response = await fetch('/api/flow/summary', { cache: 'no-store' });
    if (!response.ok) return;
    flowSnapshot = await response.json();
    renderTools();
    paintToday(flowSnapshot.today ?? {});
    paintNextLine();
  } catch { /* 拿不到就不显示「最近一次」 */ }
}

function renderTools() {
  const box = $('toolGrid');
  if (!box) return;
  box.textContent = '';

  const visible = levelFilter ? TOOLS.filter((tool) => tool.level === levelFilter) : TOOLS;
  let rendered = 0;

  for (const group of GROUPS) {
    const items = visible.filter((tool) => groupOf(tool).id === group.id);
    if (!items.length) continue;
    rendered += items.length;

    const card = el('section', 'group');
    card.dataset.group = group.id;

    const head = el('div', 'groupHead');
    const title = el('h3', null, group.label);
    title.style.setProperty('--accent', group.accent);
    head.append(title);
    head.append(el('span', 'groupCount', `${items.length} 项`));
    card.append(head);
    card.append(el('p', 'groupBlurb', group.blurb));

    const list = el('ul', 'capList');
    for (const tool of items) list.append(capabilityNode(tool));
    card.append(list);
    box.append(card);
  }

  if (!rendered) box.append(el('p', 'empty', '这一档现在没有能力。'));

  const count = $('toolCount');
  if (count) count.textContent = String(TOOLS.length);
  const note = $('toolNote');
  if (note) note.hidden = !levelFilter;
}

function wireToolFilters() {
  const bar = $('toolFilters');
  if (!bar) return;
  for (const chip of bar.querySelectorAll('.chip')) {
    chip.addEventListener('click', () => {
      levelFilter = chip.dataset.level ?? '';
      for (const node of bar.querySelectorAll('.chip')) node.setAttribute('aria-pressed', String(node === chip));
      renderTools();
    });
  }
}

/* ---------------- 技术栈（标题为主，内容折叠） ---------------- */

function renderStack() {
  const box = $('stackGrid');
  if (!box) return;
  for (const group of STACK) {
    const card = el('details', 'stackCard');
    const summary = el('summary', 'stackSummary');
    summary.append(el('span', 'stackName', group.group));
    summary.append(el('span', 'stackHint', `${group.items.length} 项`));
    card.append(summary);

    const list = el('ul', 'stackList');
    for (const item of group.items) {
      const li = el('li');
      li.append(el('b', null, item.name));
      li.append(el('span', 'note', item.note));
      li.append(el('code', null, item.where));
      list.append(li);
    }
    card.append(list);
    box.append(card);
  }
}

/* ---------------- 流水线（一条带子 + 折叠详情） ---------------- */

function renderPipeline() {
  const flow = $('flow');
  const detail = $('flowDetail');
  if (!flow || !detail) return;

  PIPELINES.forEach((line, index) => {
    const li = el('li', 'flowStep');
    li.append(el('span', 'flowNo', String(index + 1)));
    li.append(el('span', 'flowLabel', line.label));
    flow.append(li);
  });

  const box = el('details', 'flowDetails');
  box.append(el('summary', null, `展开九段的分工与代码位置（${PIPELINES.length} 段）`));
  const list = el('ol', 'flowList');
  for (const line of PIPELINES) {
    const item = el('li');
    const head = el('div', 'flowRow');
    head.append(el('b', null, line.label));
    head.append(el('span', 'note', line.duty));
    item.append(head);
    const meta = el('p', 'flowMeta');
    for (const file of line.files) meta.append(el('code', null, file));
    for (const event of line.events) meta.append(el('code', 'ev', event));
    item.append(meta);
    list.append(item);
  }
  box.append(list);
  detail.append(box);
}

/* ---------------- 今日数字 ---------------- */


// 首屏一行「下一步」：进度只看最靠前那件事，不在这里展开（要看全的去 /live 的报告页签）
function paintNextLine() {
  const box = $('nextLine');
  if (!box || !flowSnapshot) return;
  const items = TOOLS.map((tool) => {
    const verdict = flowSnapshot.tools?.[tool.key] ?? null;
    return {
      action: tool.key,
      // 只读工具（天气/看作品/读能力卡…）不产生判定，别算进「没跑过」
      readOnly: Boolean(tool.readOnly) || Boolean(TOOL_ONLY_META[tool.key]),
      levelLabel: LEVELS[tool.level]?.label ?? '',
      lastVerdict: verdict?.verdict ?? null,
      lastVerdictReason: verdict?.reason ?? '',
    };
  }).filter((item) => !item.readOnly);
  const steps = nextSteps({
    coverage: flowSnapshot.coverage ?? {},
    items,
    retired: flowSnapshot.retired ?? [],
    failures: flowSnapshot.failures ?? {},
  });
  const first = steps[0];
  if (!first || first.kind === 'done') { box.hidden = true; return; }
  box.textContent = '';
  box.append(el('b', null, '下一步：'), document.createTextNode(first.title));
  const link = el('a', 'nextGo', first.kind === 'untested' ? '看操作单 →' : '看详情 →');
  link.href = first.kind === 'untested' ? '/docs/FIRST-RUN.md' : (first.actions?.[0]?.href ? `/live/${first.actions[0].href}` : '/live/');
  if (first.kind === 'untested') { link.target = '_blank'; link.rel = 'noreferrer'; }
  box.append(link);
  box.hidden = false;
}

function paintToday(today) {
  if (!today) return false;
  const put = (id, value) => { const node = $(id); if (node) node.textContent = String(value ?? 0); };
  put('statEvents', today.events);
  put('statActions', today.actions);
  put('statFails', today.fails);
  put('statAwaiting', today.awaiting);
  const hint = $('heroStats');
  if (hint) hint.removeAttribute('title');
  return true;
}

// 先用公开的 /api/flow/summary 填今天的四个数（不需要令牌），拿不到再退回带令牌的 /api/live/snapshot
function renderTodayPublic() {
  if (flowSnapshot?.today) { paintToday(flowSnapshot.today); return; }
  fetch('/api/flow/summary', { cache: 'no-store' })
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => { if (data?.today) paintToday(data.today); })
    .catch(() => {});
}

async function renderStats() {
  const params = new URLSearchParams(location.search);
  const token = params.get('token') ?? sessionStorage.getItem('dsh.boardToken') ?? '';
  try {
    const response = await fetch('/api/live/snapshot', {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) throw new Error(String(response.status));
    const snapshot = await response.json();
    const totals = snapshot.totals ?? {};
    $('statEvents').textContent = String(totals.events ?? 0);
    $('statActions').textContent = String(totals.actions ?? 0);
    $('statFails').textContent = String(totals.fails ?? 0);
    $('statAwaiting').textContent = String(totals.awaiting ?? 0);
  } catch {
    for (const id of ['statEvents', 'statActions', 'statFails', 'statAwaiting']) {
      const node = $(id);
      if (node) node.textContent = '—';
    }
    const hint = $('heroStats');
    if (hint) hint.setAttribute('title', '带 ?token= 打开或先登录运行看板，才能看到实时数字');
  }
}

// 首屏那句「N 项能力」跟着说明书走，别写死（下线一个动作就变）
const total = $('capTotal');
if (total) total.textContent = String(TOOLS.length);
renderTools();
wireToolFilters();
renderStack();
renderPipeline();
renderStats();
renderTodayPublic();
// 判定结论要等接口回来再补一次渲染（首屏先出卡片，别让页面干等）
loadSummary();
