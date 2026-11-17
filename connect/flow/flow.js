/**
 * 平面数据流：所有节点/连线/事件路由都复用已有真源，这里只负责画。
 *  - 节点与连线：connect/arch/graph.mjs（NODES / EDGES / PATHS / EVENT_STYLE）
 *  - 位置：connect/flow/layout.mjs（CELLS）
 *  - 事件→阶段：connect/live/catalog.mjs 的 stageForEvent
 *  - 数据：connect/server.mjs 的 /api/arch/stream（SSE，不需要令牌）
 *
 * 省资源的关键：没有脉冲在飞的时候不跑 requestAnimationFrame，
 * 静止状态下这个页面只花内存，不占 CPU/GPU。
 */
import { NODES, EDGES, PATHS, EVENT_STYLE, CHANNEL_NODE, pathForEvent } from '/arch/graph.mjs';
import { GRID, COLUMNS, STAGE_NODE, NODE_STAGE, canvasSize, centerOf } from '/flow/layout.mjs';
import { VERDICT_LABEL, reasonText, shortClock } from '/live/reason-text.mjs';

window.__FLOW_READY__ = true;

const REDUCED = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const $ = (id) => document.getElementById(id);
const canvas = $('cv');
const ctx = canvas.getContext('2d');
const labels = $('labels');
const size = canvasSize();

const nodes = new Map(NODES.map((node) => [node.id, node]));
const counts = new Map(NODES.map((node) => [node.id, 0]));
const labelEls = new Map();
const ripples = [];
let pulses = [];
let selected = null;
let paused = false;
let lastPulseAt = 0;
let summary = null; // /api/flow/summary 的一次性快照：阶段最近事件 + 动作最近判定

const COLORS = { channel: '#22d3ee', runtime: '#818cf8', cognition: '#f472b6', foundation: '#fbbf24' };

/* ---------------- 布局与静态层 ---------------- */

function buildLabels() {
  for (const node of NODES) {
    const point = centerOf(node.id);
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'node';
    el.dataset.layer = node.layer;
    el.dataset.id = node.id;
    el.style.left = `${point.x}px`;
    el.style.top = `${point.y}px`;
    el.setAttribute('aria-label', `${node.label}：${node.sub ?? ''}`);
    const edge = document.createElement('span');
    edge.className = 'n-edge';
    edge.style.color = COLORS[node.layer] ?? '#22d3ee';
    const label = document.createElement('span');
    label.className = 'n-label';
    label.textContent = node.label;
    const sub = document.createElement('span');
    sub.className = 'n-sub';
    sub.textContent = node.sub ?? '';
    const count = document.createElement('span');
    count.className = 'n-count';
    count.textContent = '0';
    el.append(edge, label, sub, count);
    el.addEventListener('click', () => selectNode(node.id));
    labels.append(el);
    labelEls.set(node.id, el);
  }
  for (let col = 0; col < COLUMNS.length; col += 1) {
    const title = document.createElement('span');
    title.className = 'colTitle';
    title.textContent = COLUMNS[col];
    title.style.left = `${GRID.x0 + col * GRID.col + GRID.w / 2}px`;
    title.style.top = `${GRID.y0 - 40}px`;
    $('cols').append(title);
  }
}

function fit() {
  const box = $('scene').getBoundingClientRect();
  const scale = Math.min(box.width / size.width, box.height / size.height, 1.15);
  labels.style.transform = `translate(${(box.width - size.width * scale) / 2}px, ${(box.height - size.height * scale) / 2}px) scale(${scale})`;
  labels.style.transformOrigin = '0 0';
  $('cols').style.transform = labels.style.transform;
  $('cols').style.transformOrigin = '0 0';
  // 画布按设备像素比放大，线条才不糊
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(box.width * dpr);
  canvas.height = Math.round(box.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.translate((box.width - size.width * scale) / 2, (box.height - size.height * scale) / 2);
  ctx.scale(scale, scale);
  draw();
}

/* ---------------- 画：静态 + 运动 ---------------- */

function control(a, b, curve) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return { x: mx - dy * curve * 0.55, y: my + dx * curve * 0.55 };
}

function edgePoint(a, c, b, t) {
  const k = 1 - t;
  return { x: k * k * a.x + 2 * k * t * c.x + t * t * b.x, y: k * k * a.y + 2 * k * t * c.y + t * t * b.y };
}

const edgeList = EDGES.map(([from, to, curve, style]) => {
  const a = centerOf(from);
  const b = centerOf(to);
  return { from, to, style, a, b, c: control(a, b, curve ?? 0) };
});

function draw() {
  const box = $('scene').getBoundingClientRect();
  ctx.clearRect(-2000, -2000, 8000, 8000);
  // 连线：底
  for (const edge of edgeList) {
    ctx.beginPath();
    ctx.moveTo(edge.a.x, edge.a.y);
    ctx.quadraticCurveTo(edge.c.x, edge.c.y, edge.b.x, edge.b.y);
    ctx.strokeStyle = edge.style === 'dashed' ? 'rgba(148,163,184,0.22)' : edge.style === 'faint' ? 'rgba(148,163,184,0.2)' : 'rgba(129,140,248,0.34)';
    ctx.lineWidth = edge.style === 'main' ? 1.4 : 1;
    if (edge.style === 'dashed') ctx.setLineDash([5, 6]); else ctx.setLineDash([]);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // 脉冲拖尾 + 头
  for (const pulse of pulses) {
    const head = pointOn(pulse);
    const color = pulse.color;
    for (let i = 1; i <= 10; i += 1) {
      const back = Math.max(0, pulse.t - i * 0.008);
      const p = pointOn({ ...pulse, t: back });
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(0.6, 3.4 - i * 0.28), 0, Math.PI * 2);
      ctx.fillStyle = hexA(color, Math.max(0.02, 0.38 - i * 0.033));
      ctx.fill();
    }
    const glow = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, 15);
    glow.addColorStop(0, hexA(color, 0.95));
    glow.addColorStop(0.35, hexA(color, 0.5));
    glow.addColorStop(1, hexA(color, 0));
    ctx.beginPath();
    ctx.arc(head.x, head.y, 15, 0, Math.PI * 2);
    ctx.fillStyle = glow;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(head.x, head.y, 3.6, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
  }

  // 涟漪
  for (const ripple of ripples) {
    ctx.beginPath();
    ctx.arc(ripple.x, ripple.y, ripple.r, 0, Math.PI * 2);
    ctx.strokeStyle = hexA(ripple.color, Math.max(0, 0.55 * (1 - ripple.life)));
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }

  // 列分隔（很淡的竖reference线）
  for (let col = 1; col < COLUMNS.length; col += 1) {
    const x = GRID.x0 + col * GRID.col - (GRID.col - GRID.w) / 2;
    ctx.beginPath();
    ctx.moveTo(x, GRID.y0 - 26);
    ctx.lineTo(x, size.height - GRID.y0 + 26);
    ctx.strokeStyle = 'rgba(148,163,184,0.07)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  void box;
}

/** 路径折线（按累计长度取点），供脉冲定位。 */
function samplePath(nodeIds) {
  const points = nodeIds.map((id) => centerOf(id)).filter(Boolean);
  const segs = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const found = edgeList.find((edge) => (edge.from === nodeIds[i] && edge.to === nodeIds[i + 1]) || (edge.to === nodeIds[i] && edge.from === nodeIds[i + 1]));
    const c = found ? (found.from === nodeIds[i] ? found.c : control(b, a, -0.4)) : control(a, b, 0.12);
    const len = Math.hypot(b.x - a.x, b.y - a.y) * 1.04;
    segs.push({ a, b, c, len });
    total += len;
  }
  return { segs, total };
}

function pointOn(pulse) {
  let distance = pulse.t * pulse.path.total;
  for (const seg of pulse.path.segs) {
    if (distance <= seg.len) {
      const t = seg.len === 0 ? 0 : distance / seg.len;
      return edgePoint(seg.a, seg.c, seg.b, t);
    }
    distance -= seg.len;
  }
  const last = pulse.path.segs[pulse.path.segs.length - 1];
  return last ? last.b : { x: 0, y: 0 };
}

function hexA(hex, alpha) {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? value.split('').map((ch) => ch + ch).join('') : value;
  const num = Number.parseInt(full, 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/* ---------------- 动画循环（有活才跑） ---------------- */

let raf = 0;
let last = 0;

function loop(now) {
  const delta = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
  last = now;

  for (const pulse of pulses) {
    const speed = pulse.speed * (REDUCED ? 1.6 : 1);
    pulse.t += (delta * speed) / Math.max(0.001, pulse.path.total / 320);
    while (pulse.next < pulse.stops.length && pulse.t >= pulse.stops[pulse.next]) {
      burst(pulse.nodes[pulse.next], pulse.color);
      pulse.next += 1;
    }
  }
  const alive = pulses.filter((pulse) => pulse.t < 1);
  pulses = alive;

  for (const ripple of ripples) {
    ripple.r += delta * 190;
    ripple.life += delta * 1.6;
  }
  for (let i = ripples.length - 1; i >= 0; i -= 1) if (ripples[i].life >= 1) ripples.splice(i, 1);

  draw();
  if (pulses.length || ripples.length) {
    raf = requestAnimationFrame(loop);
  } else {
    raf = 0;
    last = 0;
  }
}

function wake() {
  if (raf || paused) return;
  last = 0;
  raf = requestAnimationFrame(loop);
}

function burst(nodeId, color) {
  const point = centerOf(nodeId);
  if (point) ripples.push({ ...point, r: 12, life: 0, color });
  const el = labelEls.get(nodeId);
  if (!el) return;
  el.classList.add('hit');
  setTimeout(() => el.classList.remove('hit'), 620);
  counts.set(nodeId, (counts.get(nodeId) ?? 0) + 1);
  const counter = el.querySelector('.n-count');
  if (counter) counter.textContent = String(counts.get(nodeId));
}

function spawn(nodeIds, color) {
  const path = samplePath(nodeIds);
  if (!path.segs.length) return;
  const stops = [];
  let travelled = 0;
  for (let i = 0; i < nodeIds.length - 1; i += 1) {
    travelled += path.segs[i].len;
    stops.push(travelled / path.total);
  }
  pulses.push({ nodes: nodeIds, path, color, t: 0, next: 0, stops, speed: 560 });
  wake();
}

/* ---------------- 事件 → 动效 ---------------- */

function trigger(event) {
  const spec = pathForEvent(event);
  const path = (spec.path ?? []).map((id) => (id === '{channel}' ? (CHANNEL_NODE[event.channel] ?? 'events') : id)).filter((id) => nodes.has(id));
  if (path.length < 2) return;
  spawn(path, spec.color ?? '#22d3ee');
  ticker(event, spec);
  lastPulseAt = Date.now();
}

function ticker(event, spec) {
  const box = $('ticker');
  const line = document.createElement('span');
  line.className = 'tk';
  line.style.color = spec.color ?? '#22d3ee';
  const dot = document.createElement('i');
  const name = document.createElement('b');
  name.textContent = spec.label ?? event.eventType ?? '';
  const channel = document.createElement('span');
  channel.textContent = event.channel ?? '';
  const time = document.createElement('time');
  time.textContent = new Date(event.createdAt ?? Date.now()).toLocaleTimeString('zh-CN', { hour12: false });
  line.append(dot, name, channel, time);
  box.prepend(line);
  while (box.children.length > 7) box.lastElementChild.remove();
}


/* ---------------- 汇总数据（最近一次 / 判定结论） ---------------- */

const REASON_LABEL = { nothing_to_do: '没活干', no_evidence: '没拿到证据', no_result_data: '没返回数据', awaiting_external_event: '等外部事件' };



/** 把「最近一次」写进节点副标题：阶段节点写时间，动作节点写判定。 */
function paintSummary() {
  if (!summary) return;
  for (const [id, el] of labelEls) {
    const stage = NODE_STAGE[id];
    const sub = el.querySelector('.n-sub');
    if (!sub) continue;
    // 一个阶段可能对应好几个节点（比如所有渠道都算 entry），只在「代表节点」上写时间，免得满屏重复
    const bucket = stage && STAGE_NODE[stage] === id ? summary.stages?.[stage] : null;
    if (bucket?.lastAt) {
      sub.dataset.orig = sub.dataset.orig ?? sub.textContent;
      const n = bucket.count ? ` · ${bucket.count} 条` : '';
      sub.textContent = `最近 ${shortClock(bucket.lastAt)}${n}`;
    }
    if (id === 'gate' && summary.readiness) {
      // 闸门节点：把「现在几项就绪」写在节点上，不用点开也看得见
      const { ready, total, missing } = summary.readiness;
      sub.dataset.orig = sub.dataset.orig ?? sub.textContent;
      const tail = missing?.length ? `（缺 ${missing.join('、')}）` : '';
      sub.textContent = `就绪 ${ready}/${total}${tail}`;
      el.dataset.ready = String(ready);
    }
    if (id === 'actions') {
      // 动作节点再叠一层：所有动作里最近的一条判定
      const entries = Object.entries(summary.tools ?? {}).filter(([, v]) => v?.at);
      if (entries.length) {
        const [action, v] = entries.sort((a, b) => String(b[1].at).localeCompare(String(a[1].at)))[0];
        const label = VERDICT_LABEL[v.verdict] ?? v.verdict;
        const why = reasonText(v.reason);
        // 副标题原本是「17 动作 · UI 自动化」，判定追加在后面，别把能力说明挤掉
        const orig = sub.dataset.orig ?? sub.textContent;
        sub.textContent = `${orig.split(' · ')[0]} · ${shortClock(v.at)} ${label}${why ? `（${why}）` : ''}`;
        sub.title = `${action}：${label}${v.reason && v.reason !== 'ok' ? ` / ${v.reason}` : ''}（${v.at}）`;
        el.dataset.verdict = v.verdict ?? '';
      }
    }
  }
  // 计数也从汇总里补一遍（SSE 没连上时也能看到今天有多少）
  for (const [id] of labelEls) {
    const stage = NODE_STAGE[id];
    // 同上：一个阶段只认代表节点，否则每个渠道节点都会被写成「71」
    const bucket = stage && STAGE_NODE[stage] === id ? summary.stages?.[stage] : null;
    const countEl = labelEls.get(id)?.querySelector('.n-count');
    if (countEl && bucket && bucket.count > (counts.get(id) ?? 0)) {
      counts.set(id, bucket.count);
      countEl.textContent = String(bucket.count);
    }
  }
  const totals = summary.totals;
  if (totals) {
    const put = (id, value) => { const el = $(id); if (el && value != null) el.textContent = String(value); };
    const cov = summary?.coverage;
    if (cov) {
      $('sCoverage').textContent = `${cov.confirmed}/${cov.total} 已确认`;
      $('sCoverage').title = `已确认 ${cov.confirmed} · 未确认 ${cov.unconfirmed} · 失败 ${cov.failed} · 没跑过 ${cov.untested}`;
      const bar = $('covBar');
      if (bar) {
        bar.replaceChildren();
        const total = Math.max(1, cov.total);
        for (const [cls, n] of [['ok', cov.confirmed], ['warn', cov.unconfirmed], ['bad', cov.failed]]) {
          if (!n) continue;
          const i = document.createElement('i');
          i.className = cls;
          i.style.width = `${(n / total) * 100}%`;
          bar.append(i);
        }
      }
    }
    put('sEvents', totals.events);
    put('sActions', totals.actions);
    put('sFails', totals.fails);
  }
  // 汇总后到：已选中的节点要把 facts 重建一遍（判定行是在 selectNode 里生成的）
  if (selected) { selectNode(selected); paintPanelExtras(); }
}

async function loadSummary() {
  try {
    const response = await fetch('/api/flow/summary', { cache: 'no-store' });
    if (!response.ok) return;
    summary = await response.json();
    paintSummary();
  } catch { /* 汇总拿不到就只显示事件流 */ }
}

/** 侧栏里补两行：最近事件 / 最近判定。 */
function paintPanelExtras() {
  if (!selected || !summary) return;
  const stage = NODE_STAGE[selected];
  const bucket = stage ? summary.stages?.[stage] : null;
  const meta = $('pMeta');
  if (!meta) return;
  const add = (key, value) => {
    if (!value) return;
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    dd.textContent = value;
    meta.append(dt, dd);
  };
  if (bucket?.lastAt) add('最近一次', `${shortClock(bucket.lastAt)} · ${bucket.lastEvent ?? ''}`);
  // 闸门节点：最近一次「授权项就绪」核验（预检写 preflight_checked）
  if (selected === 'gate' && summary.readiness) {
    const { ready, total, missing, at } = summary.readiness;
    add('最近核验', `${shortClock(at)} · ${ready}/${total} 就绪${missing?.length ? `（缺 ${missing.join('、')}）` : ''}`);
  }
  // 闸门 / 执行节点：把「下一步要谁点头」摆在这里——不用切到 /live 也能看到
  if (selected === 'gate' || selected === 'actions') {
    const untested = Number(summary.coverage?.untested ?? 0);
    const failed = Number(summary.coverage?.failed ?? 0);
    if (untested || failed) {
      const dt = document.createElement('dt');
      dt.textContent = '下一步';
      const dd = document.createElement('dd');
      const line = document.createElement('span');
      line.textContent = failed ? `${failed} 个失败要先修` : `${untested} 个动作待放行`;
      const toReport = document.createElement('a');
      toReport.href = '/live/?tab=report';
      toReport.textContent = '看报告';
      toReport.className = 'pLink';
      const toRunbook = document.createElement('a');
      toRunbook.href = '/docs/FIRST-RUN.md';
      toRunbook.target = '_blank';
      toRunbook.rel = 'noreferrer';
      toRunbook.textContent = '操作单';
      toRunbook.className = 'pLink';
      dd.append(line, toReport, toRunbook);
      meta.append(dt, dd);
    }
  }

  if (selected === 'actions' && summary.tools) {
    const entries = Object.entries(summary.tools).filter(([, v]) => v?.at).sort((a, b) => String(b[1].at).localeCompare(String(a[1].at)));
    if (entries.length) {
      const [action, v] = entries[0];
      add('最近判定', `${action} · ${VERDICT_LABEL[v.verdict] ?? v.verdict}${v.reason && v.reason !== 'ok' ? `（${v.reason}）` : ''}`);
    }
  }
}

/* ---------------- 侧栏 ---------------- */

function selectNode(id) {
  const node = nodes.get(id);
  if (!node) return;
  selected = id;
  for (const el of labelEls.values()) el.classList.toggle('sel', el.dataset.id === id);
  document.body.classList.remove('no-panel');
  $('pTag').textContent = node.layer === 'channel' ? '入口' : node.layer === 'runtime' ? '内核' : node.layer === 'cognition' ? '认知' : '调度';
  $('pName').textContent = node.label;
  $('pSub').textContent = node.sub ?? '';
  const facts = $('pFacts');
  facts.replaceChildren();
  for (const fact of node.facts ?? []) {
    const li = document.createElement('li');
    li.textContent = fact;
    facts.append(li);
  }
  const meta = $('pMeta');
  meta.replaceChildren();
  const rows = [
    ['今日经过', String(counts.get(id) ?? 0)],
    ['对应阶段', NODE_STAGE[id] ?? '—'],
    ['代码位置', (node.facts ?? [])[0] ?? '—'],
  ];
  for (const [key, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    dd.textContent = value;
    meta.append(dt, dd);
  }
  // 动作节点：把最近几次判定列出来（和 /live 工具详情的「判定历史」同源）
  if (NODE_STAGE[id] === 'act' && summary?.tools) {
    const entries = Object.entries(summary.tools)
      .filter(([, item]) => item?.verdict)
      .sort((a, b) => String(b[1].at).localeCompare(String(a[1].at)))
      .slice(0, 5);
    for (const [operation, item] of entries) {
      const li = document.createElement('li');
      const label = VERDICT_LABEL[item.verdict] ?? item.verdict;
      const week = item.weekRuns ? ` · 本周 ${item.weekRuns} 次` : '';
      li.textContent = `判定：${operation} · ${shortClock(item.at)} ${label}${week}`;
      li.dataset.verdict = item.verdict;
      facts.append(li);
    }
  }
  $('pLive').href = `/live/?stage=${NODE_STAGE[id] ?? 'entry'}`;
}

function closePanel() {
  selected = null;
  for (const el of labelEls.values()) el.classList.remove('sel');
  document.body.classList.add('no-panel');
}

/* ---------------- SSE ---------------- */

function setLive(on, text) {
  $('liveDot').classList.toggle('on', Boolean(on));
  $('liveText').textContent = text;
}

function connectStream() {
  const source = new EventSource('/api/arch/stream');
  source.addEventListener('open', () => setLive(true, '实时 · 订阅 agent_events'));
  source.addEventListener('error', () => setLive(false, '断开了，重连中…'));
  source.addEventListener('message', (message) => {
    let data;
    try { data = JSON.parse(message.data); } catch { return; }
    if (data.type === 'hello') {
      const totals = data.snapshot?.totals ?? {};
      $('sEvents').textContent = String(totals.events ?? 0);
      $('sActions').textContent = String(totals.actions ?? 0);
      $('sFails').textContent = String(totals.fails ?? 0);
      $('sTasks').textContent = String(totals.tasks ?? 0);
      const channels = data.snapshot?.channels ?? {};
      for (const [channel, count] of Object.entries(channels)) {
        const nodeId = CHANNEL_NODE[channel] ?? 'events';
        if (!nodes.has(nodeId)) continue;
        counts.set(nodeId, (counts.get(nodeId) ?? 0) + Number(count ?? 0));
        const el = labelEls.get(nodeId);
        const counter = el?.querySelector('.n-count');
        if (counter) counter.textContent = String(counts.get(nodeId));
      }
      const recent = (data.snapshot?.recent ?? []).slice(-5);
      for (const event of recent) trigger(event);
      return;
    }
    if (data.type === 'event' && data.event) trigger(data.event);
    if (data.type === 'stats' && data.totals) {
      $('sEvents').textContent = String(data.totals.events ?? 0);
      $('sActions').textContent = String(data.totals.actions ?? 0);
      $('sFails').textContent = String(data.totals.fails ?? 0);
      $('sTasks').textContent = String(data.totals.tasks ?? 0);
    }
  });
}

/* ---------------- 启动 ---------------- */

function boot() {
  buildLabels();
  document.body.classList.add('no-panel');
  fit();
  window.addEventListener('resize', fit);
  $('pause').addEventListener('click', () => {
    paused = !paused;
    $('pause').setAttribute('aria-pressed', String(paused));
    $('pause').textContent = paused ? '继续动效' : '暂停动效';
    if (!paused) wake();
  });
  $('pClose').addEventListener('click', closePanel);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closePanel();
  });

  loadSummary();

  const params = new URLSearchParams(location.search);
  const byNode = params.get('node');
  const byStage = params.get('stage');
  if (byNode && nodes.has(byNode)) selectNode(byNode);
  else if (byStage && STAGE_NODE[byStage]) selectNode(STAGE_NODE[byStage]);

  // ?nostream=1：只画一帧、不订阅事件流（截图与录制用；常开 SSE 会让无头浏览器一直不退出）
  if (params.get('nostream') === '1') {
    setLive(false, '静态快照（没订阅事件流）');
    const demo = [
      ['qq', 'message_received'],
      ['qq', 'message_replied'],
      ['douyin', 'action_started'],
      ['douyin', 'receipt_verified'],
    ];
    for (const [channel, eventType] of demo) trigger({ channel, eventType, createdAt: Date.now() });
    return;
  }
  connectStream();
}

boot();
