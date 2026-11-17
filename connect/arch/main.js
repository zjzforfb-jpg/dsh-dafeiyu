/**
 * 大肥鱼 · 统一智能体架构图（three.js）
 *
 * 页面只做三件事：
 *   1. 把 connect/arch/graph.mjs 里的节点/边画成一个有呼吸感的球面拓扑；
 *   2. 用 SSE 订阅 agent_events，事件一发生就沿「真实经过的节点」跑一条光脉冲；
 *   3. 点节点能看到它对应的 file:line，并手动演示某条路径。
 *
 * 数据（谁连谁、事件走哪条路）全在 graph.mjs，这里不硬编码架构。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { NODES, CORE, EDGES, LAYERS, PATHS, EVENT_STYLE, pathForEvent, nodesById, edgeKey } from './graph.mjs';

const params = new URLSearchParams(location.search);
const FORCE_DEMO = params.get('demo') === '1';
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const HOME = { pos: new THREE.Vector3(0, 27, 29), target: new THREE.Vector3(0, -0.9, 0) };
const NODE_SCALE = 0.84;
// index.html 的兜底提示靠这个标记判断「模块到底跑起来没有」。
window.__ARCH_READY__ = true;

// ───────────────────────────────── 基础场景 ─────────────────────────────────
const stage = document.getElementById('stage');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
} catch (error) {
  stage.innerHTML = '<div style="position:absolute;inset:0;display:grid;place-items:center;color:#f88;font-size:14px">WebGL 不可用：' + String(error.message).slice(0, 120) + '</div>';
  throw error;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x04060f, 0.0115);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 600);
camera.position.copy(HOME.pos);

const labelRenderer = new CSS2DRenderer({ element: document.getElementById('labels') });
labelRenderer.setSize(window.innerWidth, window.innerHeight);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.46, 0.5, 0.3);
composer.addPass(bloom);
composer.addPass(new OutputPass());

const controls = new OrbitControls(camera, renderer.domElement);
Object.assign(controls, {
  enableDamping: true, dampingFactor: 0.06, rotateSpeed: 0.62, zoomSpeed: 0.85,
  minDistance: 16, maxDistance: 76, maxPolarAngle: Math.PI * 0.52, minPolarAngle: Math.PI * 0.14,
  autoRotate: !REDUCED, autoRotateSpeed: 0.3,
});
controls.target.copy(HOME.target);

scene.add(new THREE.HemisphereLight(0x3b82f6, 0x02040a, 1.15));
const coreLight = new THREE.PointLight(0x22d3ee, 320, 90, 2);
coreLight.position.set(0, 0.6, 0);
scene.add(coreLight);
const topLight = new THREE.PointLight(0xa78bfa, 180, 120, 2);
topLight.position.set(0, 18, 0);
scene.add(topLight);
const rimLight = new THREE.DirectionalLight(0x60a5fa, 0.55);
rimLight.position.set(-14, 10, 18);
scene.add(rimLight);

/** 一张径向渐变，所有光晕共用。 */
function glowTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.22, 'rgba(255,255,255,0.72)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.18)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
const GLOW = glowTexture();

function sprite(color, scale, opacity, map = GLOW) {
  const material = new THREE.SpriteMaterial({
    map, color: new THREE.Color(color), blending: THREE.AdditiveBlending,
    transparent: true, opacity, depthWrite: false, depthTest: true,
  });
  const s = new THREE.Sprite(material);
  s.scale.setScalar(scale);
  return s;
}

// ───────────────────────────────── 星野 ─────────────────────────────────
(function makeStars() {
  const count = 2400;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const r = 70 + Math.random() * 130;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi) * 0.55;
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    size: 0.62, map: GLOW, color: 0x9fd8ff, transparent: true, opacity: 0.66,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
  });
  const stars = new THREE.Points(geometry, material);
  stars.name = 'stars';
  scene.add(stars);
})();

// ───────────────────────────── 地面极坐标网格 ─────────────────────────────
const gridGroup = new THREE.Group();
(function makeGrid() {
  const ringMaterial = new THREE.LineBasicMaterial({ color: 0x1d4ed8, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false });
  const innerMaterial = new THREE.LineBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false });
  for (let r = 3; r <= 33; r += 3) {
    const points = [];
    for (let i = 0; i <= 128; i += 1) {
      const a = (i / 128) * Math.PI * 2;
      points.push(new THREE.Vector3(Math.cos(a) * r, -0.02, Math.sin(a) * r));
    }
    gridGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), r === 30 ? innerMaterial : ringMaterial));
  }
  for (let i = 0; i < 24; i += 1) {
    const a = (i / 24) * Math.PI * 2;
    const points = [new THREE.Vector3(Math.cos(a) * 3, -0.02, Math.sin(a) * 3), new THREE.Vector3(Math.cos(a) * 33, -0.02, Math.sin(a) * 33)];
    gridGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), ringMaterial));
  }
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(34, 96),
    new THREE.MeshBasicMaterial({ color: 0x061428, transparent: true, opacity: 0.6, depthWrite: false }),
  );
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = -0.04;
  gridGroup.add(disc);
  scene.add(gridGroup);
})();

// ───────────────────────────────── 节点 ─────────────────────────────────
const NODE_INDEX = nodesById();
/** @type {Map<string, any>} */
const nodeViews = new Map();
const pickables = [];
const sphereGeometry = new THREE.SphereGeometry(1, 32, 24);
const ringGeometry = new THREE.RingGeometry(0.72, 0.9, 64);

function makeLabel(label, sub) {
  const div = document.createElement('div');
  div.className = 'node-label';
  const b = document.createElement('b');
  b.textContent = label;
  const span = document.createElement('span');
  span.textContent = sub;
  div.append(b, span);
  return div;
}

function addNode(node) {
  const size = node.size * NODE_SCALE;
  const color = new THREE.Color(LAYERS[node.layer]?.color ?? '#7dd3fc');
  const group = new THREE.Group();
  group.position.set(...node.pos);
  group.userData.node = node;

  const mesh = new THREE.Mesh(sphereGeometry, new THREE.MeshStandardMaterial({
    color: color.clone().multiplyScalar(0.42), emissive: color.clone().multiplyScalar(0.9), emissiveIntensity: 0.3,
    roughness: 0.4, metalness: 0.22, transparent: true, opacity: 0.97,
  }));
  mesh.scale.setScalar(size);
  group.add(mesh);
  mesh.userData.node = node;
  pickables.push(mesh);

  const halo = sprite(color, size * 3.6, 0.3);
  group.add(halo);

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(size * 1.42, 0.014, 8, 72),
    new THREE.MeshBasicMaterial({ color: color.clone(), transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  ring.rotation.set(Math.PI * 0.42, 0, Math.random() * Math.PI);
  group.add(ring);

  const label = new CSS2DObject(makeLabel(node.label, node.sub));
  label.position.set(0, size * 1.95, 0);
  group.add(label);

  scene.add(group);
  nodeViews.set(node.id, {
    node, size, group, mesh, halo, ring, label, color,
    baseY: node.pos[1], glow: 0, hover: 0, phase: Math.random() * Math.PI * 2,
  });
}

NODES.forEach(addNode);

// 中庭：大肥鱼本体
const coreView = (() => {
  const group = new THREE.Group();
  group.position.set(...CORE.pos);

  const shell = new THREE.Mesh(
    new THREE.IcosahedronGeometry(CORE.size, 5),
    new THREE.ShaderMaterial({
      uniforms: {
        uInner: { value: new THREE.Color('#0b2a4a') },
        uOuter: { value: new THREE.Color('#38e8ff') },
        uTime: { value: 0 },
        uGlow: { value: 0 },
      },
      vertexShader: `
        varying vec3 vNormal; varying vec3 vView;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vView = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform vec3 uInner; uniform vec3 uOuter; uniform float uTime; uniform float uGlow;
        varying vec3 vNormal; varying vec3 vView;
        void main() {
          float f = pow(1.0 - clamp(dot(normalize(vNormal), normalize(vView)), 0.0, 1.0), 2.1);
          float ripple = 0.5 + 0.5 * sin(uTime * 1.7 + vNormal.y * 7.0 + vNormal.x * 3.0);
          vec3 col = mix(uInner, uOuter, f);
          col += uOuter * f * (0.55 + 1.4 * uGlow);
          col *= 0.8 + 0.4 * ripple;
          gl_FragColor = vec4(col, 0.5 + 0.5 * f);
        }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.FrontSide,
    }),
  );
  group.add(shell);

  const wire = new THREE.Mesh(
    new THREE.IcosahedronGeometry(CORE.size * 1.12, 2),
    new THREE.MeshBasicMaterial({ color: 0x38bdf8, wireframe: true, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  group.add(wire);

  const rings = [0, 1, 2].map((i) => {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(CORE.size * (1.35 + i * 0.16), 0.018, 8, 96),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(i % 2 ? '#a78bfa' : '#22d3ee'), transparent: true, opacity: 0.34 - i * 0.07, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    ring.rotation.set(Math.PI * (0.3 + i * 0.18), Math.PI * 0.12 * i, 0);
    group.add(ring);
    return ring;
  });

  const halo = sprite('#22d3ee', 7.5, 0.26);
  group.add(halo);

  const label = new CSS2DObject(makeLabel(CORE.label, CORE.sub));
  label.position.set(0, -CORE.size * 1.55, 0);
  group.add(label);

  group.userData.node = CORE;
  scene.add(group);
  return { node: CORE, group, shell, wire, rings, halo, label, glow: 0, color: new THREE.Color('#22d3ee') };
})();

// ───────────────────────────────── 边 ─────────────────────────────────
const edgeCurves = new Map();
const flowDots = [];

function buildEdge(from, to, bend, style) {
  const a = NODE_INDEX.get(from) ?? (from === 'core' ? CORE : null);
  const b = NODE_INDEX.get(to) ?? (to === 'core' ? CORE : null);
  if (!a || !b) return;
  const p0 = new THREE.Vector3(...a.pos);
  const p1 = new THREE.Vector3(...b.pos);
  const mid = p0.clone().add(p1).multiplyScalar(0.5);
  const dir = p1.clone().sub(p0);
  const normal = new THREE.Vector3(-dir.z, 0, dir.x).normalize();
  const control = mid.add(normal.multiplyScalar(dir.length() * bend)).add(new THREE.Vector3(0, Math.abs(bend) * 1.2, 0));
  const curve = new THREE.QuadraticBezierCurve3(p0, control, p1);
  edgeCurves.set(edgeKey(from, to), curve);

  const color = new THREE.Color(LAYERS[a.layer]?.color ?? '#38bdf8');
  const isDashed = style === 'dashed';
  const isFaint = style === 'faint';
  const opacity = isDashed ? 0.4 : isFaint ? 0.15 : 0.28;

  if (isDashed) {
    const geometry = new THREE.BufferGeometry().setFromPoints(curve.getPoints(28));
    const line = new THREE.Line(geometry, new THREE.LineDashedMaterial({
      color: new THREE.Color('#fbbf24'), dashSize: 0.34, gapSize: 0.42,
      transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    line.computeLineDistances();
    scene.add(line);
  } else {
    const tube = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 40, 0.02, 6, false),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    scene.add(tube);
  }

  // 沿线流动的光点：让静态图也有「血液在流」的感觉
  const dots = isFaint ? 1 : 2;
  for (let i = 0; i < dots; i += 1) {
    const dot = sprite(color, isFaint ? 0.2 : 0.26, isFaint ? 0.35 : 0.7);
    dot.userData.edge = { curve, offset: i / dots + Math.random() * 0.12, speed: 0.11 + Math.random() * 0.07 };
    scene.add(dot);
    flowDots.push(dot);
  }
}

EDGES.forEach((edge) => buildEdge(...edge));

// ───────────────────────────────── 脉冲 ─────────────────────────────────
const pulses = [];
const ripples = [];
const trailGeometry = new THREE.SphereGeometry(0.12, 8, 6);

function samplePath(nodeIds) {
  const points = [];
  const nodeT = [{ id: nodeIds[0], t: 0 }];
  let total = 0;
  const segments = [];
  for (let i = 0; i < nodeIds.length - 1; i += 1) {
    const from = nodeIds[i];
    const to = nodeIds[i + 1];
    const curve = edgeCurves.get(edgeKey(from, to)) ?? new THREE.LineCurve3(
      new THREE.Vector3(...(NODE_INDEX.get(from)?.pos ?? CORE.pos)),
      new THREE.Vector3(...(NODE_INDEX.get(to)?.pos ?? CORE.pos)),
    );
    const length = curve.getLength();
    segments.push({ curve, length });
    total += length;
    nodeT.push({ id: to, t: total });
    for (let s = 0; s <= 18; s += 1) points.push(curve.getPoint(s / 18));
  }
  const path = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.02);
  return { path, nodeT: nodeT.map((item) => ({ ...item, t: total ? item.t / total : 0 })) };
}

function spawnPulse(nodeIds, colorHex, { delay = 0, gain = 1 } = {}) {
  const clean = nodeIds.filter((id, i) => id && id !== nodeIds[i - 1]);
  if (clean.length < 2) return;
  const { path, nodeT } = samplePath(clean);
  const color = new THREE.Color(colorHex);
  const head = sprite(color, 1.5 * gain, 0.95);
  const core = sprite('#ffffff', 0.5 * gain, 0.9);
  const trail = Array.from({ length: 8 }, (_, i) => {
    const s = sprite(color, 0.9 * gain * (1 - i / 9), 0.42 * (1 - i / 9));
    scene.add(s);
    return s;
  });
  scene.add(head, core);
  pulses.push({
    path, nodeT, color, head, core, trail, t: -delay / 1.2, life: Math.max(0.62, path.getLength() * 0.052),
    visited: new Set(), nodeIds: clean,
  });
}

function burstRipple(nodeId, colorHex, strength = 1) {
  const view = nodeViews.get(nodeId);
  const position = new THREE.Vector3(...(view?.node.pos ?? CORE.pos));
  if (view) view.glow = Math.max(view.glow, 0.85 * strength);
  else coreView.glow = Math.max(coreView.glow, 0.7 * strength);
  const material = new THREE.MeshBasicMaterial({
    color: new THREE.Color(colorHex), transparent: true, opacity: 0.85,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(ringGeometry, material);
  mesh.position.copy(position);
  mesh.scale.setScalar(0.9 + (view?.size ?? 1.6) * 0.35);
  scene.add(mesh);
  ripples.push({ mesh, age: 0, life: 0.95 });
}

// ───────────────────────────────── HUD ─────────────────────────────────
const el = (id) => document.getElementById(id);
const hud = {
  events: el('statEvents'), actions: el('statActions'), fails: el('statFails'), tasks: el('statTasks'),
  failBox: el('statFailBox'), ticker: el('ticker'), chanList: el('chanList'), live: el('live'), liveText: el('liveText'),
  legend: el('legendList'), detail: el('detail'), dTag: el('dTag'), dName: el('dName'), dHint: el('dHint'), dFacts: el('dFacts'),
  flow: el('flow'), fBadge: el('fBadge'), fName: el('fName'), fSub: el('fSub'), fMeta: el('fMeta'), fSteps: el('fSteps'),
  fFoot: el('fFoot'), fClose: el('fClose'),
};
const metrics = {
  stamps: [], actions: 0, fails: 0, tasks: 0,
  channels: new Map(), channelValues: new Map(),
};
const CHANNEL_LABEL = { qq: 'QQ', wechat: '微信', ilink: '微信', call: '通话', desktop: '桌宠', android: 'Android', douyin: '抖音', board: '看板', system: '系统' };

(function initLegend() {
  hud.legend.innerHTML = Object.entries(LAYERS).map(([, layer]) => (
    `<div class="lg"><s style="background:${layer.color};color:${layer.color}"></s>${layer.label}</div>`
  )).join('');
})();

(function initChannelRows() {
  hud.chanList.innerHTML = ['qq', 'wechat', 'call', 'desktop', 'android', 'douyin']
    .map((key) => `<div class="chan" data-ch="${key}"><span>${CHANNEL_LABEL[key]}</span><i><s style="background:${LAYERS.channel.color}"></s></i><em>0</em></div>`)
    .join('');
})();

function paintChannel(key) {
  const row = hud.chanList.querySelector(`[data-ch="${key}"]`);
  if (!row) return;
  const value = metrics.channels.get(key) ?? 0;
  const max = Math.max(1, ...metrics.channels.values());
  row.querySelector('em').textContent = String(value);
  row.querySelector('s').style.width = `${Math.round((value / max) * 100)}%`;
}

const metricKey = (channel) => (channel === 'ilink' ? 'wechat' : (CHANNEL_LABEL[channel] ? channel : 'system'));

function bumpChannel(channel) {
  const key = metricKey(channel);
  metrics.channels.set(key, (metrics.channels.get(key) ?? 0) + 1);
  paintChannel(key);
}

function pushTicker(spec, when, payload = null) {
  const row = document.createElement('div');
  row.className = 'tk';
  row.style.color = spec.color;
  const dot = document.createElement('i');
  dot.style.background = spec.color;
  const text = document.createElement('span');
  text.style.color = '#b9d6ea';
  text.textContent = `${spec.label} · ${CHANNEL_LABEL[spec.channel] ?? spec.channel}`;
  const time = document.createElement('time');
  time.textContent = new Date(Number(when) || Date.now()).toLocaleTimeString('zh-CN', { hour12: false });
  row.append(dot, text, time);
  if (payload) {
    row.classList.add('clickable');
    row.dataset.eventType = payload.eventType ?? spec.eventType ?? '';
    row.dataset.channel = payload.channel ?? spec.channel ?? '';
    if (payload.taskId) row.dataset.taskId = payload.taskId;
    if (payload.id) row.dataset.eventId = payload.id;
    row.title = payload.taskId ? '点开看这条任务的完整流程' : '点开看这条事件';
    row.addEventListener('click', () => {
      for (const other of hud.ticker.querySelectorAll('.tk.on')) other.classList.remove('on');
      row.classList.add('on');
      openFlow(payload);
    });
  }
  hud.ticker.prepend(row);
  while (hud.ticker.children.length > 5) hud.ticker.lastElementChild.remove();
}

function setLive(on) {
  hud.live.classList.toggle('off', !on);
  hud.liveText.textContent = on ? '实时 · 订阅 agent_events' : '离线 · 本地演示';
}

let lastEventAt = 0;
function trigger(payload, { synthetic = false } = {}) {
  const spec = pathForEvent(payload);
  spawnPulse(spec.path, spec.color);
  pushTicker(spec, null, payload);
  bumpChannel(spec.channel);
  metrics.stamps.push(Date.now());
  const type = spec.eventType;
  if (type === 'action_started' || type === 'action_finished') metrics.actions += 1;
  if (type === 'action_failed') metrics.fails += 1;
  if (type === 'plan_created' || type === 'task_state_changed') metrics.tasks += 1;
  lastEventAt = Date.now();
  renderStats();
  if (!synthetic) pending.shift();
}

function renderStats() {
  const now = Date.now();
  metrics.stamps = metrics.stamps.filter((stamp) => now - stamp < 60_000);
  hud.events.textContent = String(metrics.stamps.length);
  hud.actions.textContent = String(metrics.actions);
  hud.fails.textContent = String(metrics.fails);
  hud.tasks.textContent = String(metrics.tasks);
  hud.failBox.classList.toggle('hot', metrics.fails > 0);
}
setInterval(renderStats, 2000);

// 事件排队：真实流量偶尔一次涌进来十几条（抖音评论流水线），排队播完更耐看
const pending = [];
let draining = false;
function enqueue(payload) {
  pending.push(payload);
  if (!draining) drain();
}
function drain() {
  if (!pending.length) { draining = false; return; }
  draining = true;
  trigger(pending[0]);
  setTimeout(drain, 260);
}

// ───────────────────────────────── SSE ─────────────────────────────────
let source = null;
let demoTypeTimer = null;

function randomDemoEvent() {
  const types = Object.keys(EVENT_STYLE);
  const channels = ['qq', 'wechat', 'call', 'desktop', 'android', 'douyin'];
  enqueue({
    eventType: types[Math.floor(Math.random() * types.length)],
    channel: channels[Math.floor(Math.random() * channels.length)],
  });
}
function startDemo() {
  if (demoTypeTimer) return;
  demoTypeTimer = setInterval(randomDemoEvent, REDUCED ? 9000 : 4200);
}

function connectStream() {
  if (FORCE_DEMO) { setLive(false); startDemo(); return; }
  try {
    source = new EventSource('/api/arch/stream');
  } catch {
    setLive(false); startDemo(); return;
  }
  source.onopen = () => { setLive(true); if (demoTypeTimer) { clearInterval(demoTypeTimer); demoTypeTimer = null; } };
  source.onerror = () => { setLive(false); startDemo(); };
  source.onmessage = (message) => {
    let data;
    try { data = JSON.parse(message.data); } catch { return; }
    if (data.type === 'hello' || data.type === 'stats') {
      Object.entries(data.channels ?? {}).forEach(([channel, count]) => {
        metrics.channels.set(metricKey(channel), Number(count));
      });
      Object.keys(CHANNEL_LABEL).forEach(paintChannel);
      if (!metrics.started && Array.isArray(data.recent) && data.recent.length) {
        // 打开页面时先把最近几条事件铺到 ticker，不然一开始永远是「等待事件…」
        for (const ev of data.recent.slice(-5)) {
          const spec = pathForEvent(ev);
          pushTicker({ label: spec.label, color: spec.color, channel: ev.channel }, ev.createdAt, ev);
        }
        metrics.started = true;
      }
      if (data.totals) {
        metrics.tasks = Number(data.totals.tasks ?? metrics.tasks);
        hud.tasks.textContent = String(metrics.tasks);
      }
      return;
    }
    if (data.type === 'event') enqueue(data.event ?? data);
  };
}

// 空闲时也跑一条「心跳」脉冲，页面不会看起来死掉
setInterval(() => {
  if (Date.now() - lastEventAt < 22_000) return;
  const channels = ['qq', 'wechat', 'desktop', 'call'];
  const channel = channels[Math.floor(Math.random() * channels.length)];
  spawnPulse(pathForEvent({ eventType: 'message_received', channel }).path, '#1e6f8a', { gain: 0.55 });
}, 11_000);

// ───────────────────────────────── 交互 ─────────────────────────────────
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2(-2, -2);
let hovered = null;
let selected = null;
let pointerDownAt = null;

renderer.domElement.addEventListener('pointermove', (event) => {
  pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
});
renderer.domElement.addEventListener('pointerdown', (event) => { pointerDownAt = { x: event.clientX, y: event.clientY }; });
renderer.domElement.addEventListener('pointerup', (event) => {
  if (!pointerDownAt) return;
  const moved = Math.hypot(event.clientX - pointerDownAt.x, event.clientY - pointerDownAt.y);
  pointerDownAt = null;
  if (moved > 6) return;
  pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(pickables, false)[0];
  selectNode(hit ? hit.object.userData.node.id : null);
});

// 3D 页也显示「最近一次真跑 + 判定」：数据来自 /api/flow/summary（和 /live、/flow、/home 同一份 task_checkpoints）
const STAGE_BY_NODE = Object.freeze({
  events: 'entry', route: 'route', tasks: 'task', gate: 'gate', actions: 'act', memory: 'memory', call: 'call',
  qq: 'entry', ilink: 'entry', callNode: 'call', desktop: 'entry', android: 'entry', board: 'entry', douyin: 'entry',
  brain: 'memory', skills: 'memory', scheduler: 'task', life: 'task', budget: 'task', approvals: 'gate',
});
const VERDICT_LABEL_CN = { confirmed: '已确认', unconfirmed: '未确认', mismatched: '对不上', failed: '失败', skipped: '跳过' };
let flowSummary = null;

async function loadSummary() {
  try {
    const response = await fetch('/api/flow/summary', { cache: 'no-store' });
    if (!response.ok) return;
    flowSummary = await response.json();
    if (selected) selectNode(selected);
  } catch { /* 拿不到就不显示这一行 */ }
}

function summaryFactsFor(id) {
  if (!flowSummary) return [];
  const stage = STAGE_BY_NODE[id];
  const facts = [];
  const bucket = stage ? flowSummary.stages?.[stage] : null;
  if (bucket?.lastAt) {
    const clock = new Date(bucket.lastAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    facts.push(`最近一次事件：${clock}（近 24h ${bucket.count} 条）`);
  }
  if (id === 'actions' || id === 'gate') {
    const entries = Object.entries(flowSummary.tools ?? {});
    const confirmed = entries.filter(([, v]) => v.verdict === 'confirmed').length;
    const unconfirmed = entries.filter(([, v]) => v.verdict === 'unconfirmed').length;
    const failed = entries.filter(([, v]) => v.verdict === 'failed').length;
    if (entries.length) facts.push(`近 24h 判定：已确认 ${confirmed} · 未确认 ${unconfirmed} · 失败 ${failed}`);
    const latest = entries.sort((a, b) => String(b[1].at).localeCompare(String(a[1].at)))[0];
    if (latest) {
      const [op, v] = latest;
      const clock = new Date(v.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      facts.push(`最近一条：${op} ${clock} ${VERDICT_LABEL_CN[v.verdict] ?? v.verdict}`);
    }
  }
  return facts;
}

function selectNode(id) {
  for (const view of nodeViews.values()) view.label.element.classList.toggle('sel', view.node.id === id);
  coreView.label.element.classList.toggle('sel', id === 'core');
  selected = id;
  const node = id ? (NODE_INDEX.get(id) ?? (id === 'core' ? CORE : null)) : null;
  if (!node) { hud.detail.classList.remove('show'); return; }
  closeFlow();
  const layer = LAYERS[node.layer];
  hud.dTag.textContent = layer?.label ?? '核心';
  hud.dTag.style.color = layer?.color ?? '#22d3ee';
  hud.dTag.style.background = `${layer?.color ?? '#22d3ee'}1f`;
  hud.dTag.style.border = `1px solid ${layer?.color ?? '#22d3ee'}44`;
  hud.dName.textContent = node.label;
  hud.dHint.textContent = node.hint;
  const extra = summaryFactsFor(id);
  hud.dFacts.innerHTML = [...(node.facts ?? []), ...extra].map((fact) => `<li>${fact}</li>`).join('');
  hud.detail.classList.add('show');
  burstRipple(id, layer?.color ?? '#22d3ee', 1.2);
  focusCamera(node);
}

// ─────────────────────── 右侧「任务流程」抽屉 ───────────────────────
const STATUS_TONE = {
  succeeded: '#34d399', done: '#34d399', completed: '#34d399', verified: '#34d399',
  running: '#facc15', awaiting_confirmation: '#facc15', waiting_verification: '#facc15', pending: '#facc15', approved: '#facc15',
  awaiting_publish: '#facc15', queued: '#facc15',
  failed: '#ef4444', cancelled: '#ef4444', unknown: '#ef4444', rejected: '#ef4444', expired: '#f97316',
};

function toText(value) {
  if (value === null || value === undefined || value === '') return '—';
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return String(value);
  return new Date(ms).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function clockOf(value) {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return '--:--:--';
  return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });
}
function paintBadge(text, tone) {
  hud.fBadge.textContent = text ?? '—';
  hud.fBadge.style.color = tone;
  hud.fBadge.style.background = `${tone}22`;
  hud.fBadge.style.border = `1px solid ${tone}55`;
}
function flowStep(event, { onPick } = {}) {
  const style = EVENT_STYLE[event.eventType] ?? EVENT_STYLE.observation_created;
  const li = document.createElement('li');
  li.className = 'step';
  li.title = '回放这一步';
  const time = document.createElement('time');
  time.textContent = clockOf(event.createdAt);
  const dot = document.createElement('s');
  dot.style.background = style.color;
  dot.style.color = style.color;
  const body = document.createElement('div');
  body.className = 'txt';
  const head = document.createElement('b');
  head.textContent = style.label;
  body.append(head);
  const detail = [CHANNEL_LABEL[event.channel] ?? event.channel, event.summary].filter(Boolean).join(' · ');
  if (detail) {
    const sub = document.createElement('span');
    sub.textContent = detail;
    body.append(sub);
  }
  li.append(time, dot, body);
  li.addEventListener('click', () => {
    for (const other of hud.fSteps.querySelectorAll('.step.on')) other.classList.remove('on');
    li.classList.add('on');
    const spec = pathForEvent(event);
    spawnPulse(spec.path, spec.color);
    onPick?.(event, spec);
  });
  return li;
}

let flowToken = 0;
async function openFlow(payload) {
  const taskId = payload?.taskId ?? null;
  const eventId = payload?.id ?? null;
  if (!taskId && !eventId) return;
  hud.detail.classList.remove('show');
  hud.flow.classList.add('show');
  const token = ++flowToken;
  hud.fName.textContent = taskId ? '任务流程' : '单条事件';
  hud.fSub.textContent = taskId ?? eventId;
  paintBadge('读取中', '#22d3ee');
  hud.fMeta.innerHTML = '';
  hud.fFoot.textContent = '点任意一步可回放该步在架构图上的走势';
  hud.fSteps.innerHTML = '<li class="empty">读取中…</li>';
  const query = encodeURIComponent(taskId ?? eventId);
  try {
    const response = await fetch(`/api/arch/${taskId ? 'task' : 'event'}?id=${query}`);
    if (!response.ok) throw new Error(response.status === 404 ? '库里没有这条记录' : `HTTP ${response.status}`);
    const data = await response.json();
    if (token !== flowToken) return;
    if (taskId) renderTaskFlow(data, payload);
    else renderEventFlow(data.event ?? payload);
  } catch (error) {
    hud.fSteps.innerHTML = `<li class="empty">读不到详情：${error.message}（本地演示事件没有落库，属正常）</li>`;
    paintBadge('无详情', '#6f8ba6');
  }
}

function renderTaskFlow(data, payload) {
  const task = data.task;
  const working = data.working;
  const events = data.events ?? [];
  const status = task?.status ?? working?.status ?? 'unknown';
  paintBadge(status, STATUS_TONE[status] ?? '#818cf8');
  hud.fName.textContent = task?.intent ? task.intent.replaceAll('.', ' · ') : (working?.goal || '任务流程');
  hud.fSub.textContent = task?.id ?? data.id;
  const meta = [];
  if (task?.origin) meta.push(`<span>来源 <b>${task.origin}</b></span>`);
  const CONV_LABEL = { c2c: '私聊', group: '群聊', channel: '频道' };
  if (task?.convKind) meta.push(`<span>会话 <b>${CONV_LABEL[task.convKind] ?? task.convKind}</b></span>`);
  if (task?.attempts !== undefined && task?.attempts !== null) meta.push(`<span>重试 <b>${task.attempts}</b></span>`);
  if (task?.createdAt) meta.push(`<span>创建 <b>${toText(task.createdAt)}</b></span>`);
  if (task?.updatedAt) meta.push(`<span>更新 <b>${toText(task.updatedAt)}</b></span>`);
  if (working?.currentStep) meta.push(`<span>当前步骤 <b>${working.currentStep}</b></span>`);
  if (working?.retries) meta.push(`<span>重试次数 <b>${working.retries}</b></span>`);
  if (working?.nextAction) meta.push(`<span>下一步 <b>${working.nextAction}</b></span>`);
  hud.fMeta.innerHTML = meta.join('');
  if (!events.length) {
    hud.fSteps.innerHTML = '<li class="empty">这条任务还没有事件（可能只建了任务壳）。</li>';
    return;
  }
  hud.fSteps.replaceChildren();
  for (const event of events) hud.fSteps.append(flowStep(event));
  hud.fFoot.textContent = `共 ${events.length} 步 · 点任意一步回放走势 · Esc 关闭`;
  if (payload?.eventId) {
    const target = hud.fSteps.querySelectorAll('.step')[events.findIndex((event) => event.id === payload.eventId)];
    target?.classList.add('on');
  }
}

function renderEventFlow(event) {
  if (!event) {
    hud.fSteps.innerHTML = '<li class="empty">没有可显示的事件。</li>';
    return;
  }
  const style = EVENT_STYLE[event.eventType] ?? EVENT_STYLE.observation_created;
  paintBadge(style.label, style.color);
  hud.fName.textContent = '单条事件';
  hud.fSub.textContent = event.id ?? '—';
  const meta = [];
  if (event.channel) meta.push(`<span>渠道 <b>${CHANNEL_LABEL[event.channel] ?? event.channel}</b></span>`);
  if (event.actor) meta.push(`<span>actor <b>${event.actor}</b></span>`);
  if (event.createdAt) meta.push(`<span>时间 <b>${toText(event.createdAt)}</b></span>`);
  if (event.taskId) meta.push(`<span>任务 <b>${event.taskId}</b></span>`);
  hud.fMeta.innerHTML = meta.join('');
  hud.fSteps.replaceChildren(flowStep(event));
  hud.fFoot.textContent = event.taskId
    ? '这条事件挂在某个任务上：点 ticker 里同任务的行可以看完整流程'
    : '这条事件没有挂任务，只能看单步';
}

function closeFlow() {
  flowToken += 1;
  hud.flow.classList.remove('show');
}
hud.fClose.addEventListener('click', closeFlow);
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeFlow();
});

// 标签防重叠：近的/选中/正在发光的优先占位，挤不下的暂时隐藏（悬停或点击会重新露出来）。
const projected = new THREE.Vector3();
let lastDeclutter = 0;
function screenOf(group) {
  group.getWorldPosition(projected);
  projected.project(camera);
  return { x: (projected.x * 0.5 + 0.5) * window.innerWidth, y: (-projected.y * 0.5 + 0.5) * window.innerHeight, behind: projected.z > 1 };
}
function declutterLabels() {
  const items = [];
  const push = (label, node, group, width, height, keep, isCore = false) => {
    const p = screenOf(group);
    if (p.behind) { label.visible = false; return; }
    items.push({ label, p, width, height, keep, isCore, depth: camera.position.distanceTo(group.getWorldPosition(new THREE.Vector3())) });
  };
  for (const view of nodeViews.values()) {
    const el = view.label.element;
    const keep = el.classList.contains('sel') || view.glow > 0.3;
    push(view.label, view.node, view.group, Math.max(58, view.node.label.length * 12.5 + 10), keep ? 32 : 18, keep);
  }
  push(coreView.label, CORE, coreView.group, 62, 32, coreView.label.element.classList.contains('sel'), true);

  items.sort((a, b) => (Number(b.keep) - Number(a.keep)) || (a.depth - b.depth));
  const placed = [];
  for (const item of items) {
    const rect = { x: item.p.x - item.width / 2, y: item.p.y - item.height - 8, w: item.width, h: item.height + 4 };
    const hit = placed.some((other) => !(rect.x > other.x + other.w || rect.x + rect.w < other.x || rect.y > other.y + other.h || rect.y + rect.h < other.y));
    if (hit && !item.keep) { item.label.visible = false; continue; }
    item.label.visible = true;
    placed.push(rect);
  }
}

let cameraGoal = null;
let autoPaused = false;
function focusCamera(node) {
  const target = new THREE.Vector3(...node.pos);
  const offset = camera.position.clone().sub(controls.target);
  const distance = Math.max(15, Math.min(offset.length(), 24));
  const direction = new THREE.Vector3(0, 0.42, 1).normalize();
  cameraGoal = { pos: target.clone().add(direction.multiplyScalar(distance)), target };
}
function resetCamera() {
  cameraGoal = { pos: HOME.pos.clone(), target: HOME.target.clone() };
  hud.detail.classList.remove('show');
  selected = null;
}

el('dReset').addEventListener('click', resetCamera);
el('dDemo').addEventListener('click', () => {
  if (!selected) return;
  const keys = Object.keys(PATHS);
  const template = PATHS[keys[Math.floor(Math.random() * keys.length)]];
  const path = template.map((id) => (id === '{channel}' ? (selected === 'core' ? 'qq' : selected) : id));
  const color = EVENT_STYLE[Object.keys(EVENT_STYLE)[Math.floor(Math.random() * 13)]]?.color ?? '#22d3ee';
  spawnPulse(path, color);
  path.forEach((id, index) => setTimeout(() => burstRipple(id, color, 0.8), index * 130));
});

window.addEventListener('dblclick', resetCamera);
window.addEventListener('keydown', (event) => {
  if (event.code === 'Space') { event.preventDefault(); controls.autoRotate = !controls.autoRotate; }
  if (event.key === 'r' || event.key === 'R') resetCamera();
});
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  labelRenderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  bloom.setSize(window.innerWidth, window.innerHeight);
});

// ───────────────────────────────── 主循环 ─────────────────────────────────
const clock = new THREE.Clock();
let elapsed = 0;
let stars = scene.getObjectByName('stars');

function animate() {
  const delta = Math.min(clock.getDelta(), 0.05);
  elapsed += delta;

  // 自转会和镜头补间互相拉扯：补间期间先停下自转，到站后再恢复
  if (cameraGoal && controls.autoRotate) { controls.autoRotate = false; autoPaused = true; }
  controls.update();
  if (cameraGoal) {
    camera.position.lerp(cameraGoal.pos, 1 - Math.exp(-delta * 4.2));
    controls.target.lerp(cameraGoal.target, 1 - Math.exp(-delta * 4.2));
    if (camera.position.distanceTo(cameraGoal.pos) < 0.25) {
      cameraGoal = null;
      if (autoPaused) { controls.autoRotate = true; autoPaused = false; }
    }
  }

  // 悬停
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(pickables, false)[0];
  const hoverId = hit ? hit.object.userData.node.id : null;
  if (hoverId !== hovered) {
    hovered = hoverId;
    renderer.domElement.style.cursor = hovered ? 'pointer' : 'grab';
  }
  nodeViews.forEach((view) => {
    const target = hovered === view.node.id || selected === view.node.id ? 1 : 0;
    view.hover += (target - view.hover) * Math.min(1, delta * 9);
    const scale = view.node.size * (1 + view.hover * 0.16 + view.glow * 0.08);
    view.mesh.scale.setScalar(scale);
    view.glow *= Math.exp(-delta * 3.4);
    view.mesh.material.emissiveIntensity = 0.34 + view.glow * 2.2;
    view.halo.material.opacity = 0.24 + view.glow * 0.45 + view.hover * 0.1;
    view.halo.scale.setScalar(view.size * (3.6 + view.glow * 2.0));
    view.ring.rotation.z += delta * (0.24 + view.glow * 1.2);
    view.label.element.classList.toggle('hot', view.glow > 0.32);
    view.group.position.y = view.baseY + Math.sin(elapsed * 0.7 + view.phase) * 0.12;
  });

  // 核心
  coreView.glow *= Math.exp(-delta * 2.6);
  coreView.shell.material.uniforms.uTime.value = elapsed;
  coreView.shell.material.uniforms.uGlow.value = coreView.glow * 0.8 + 0.15;
  coreView.shell.rotation.y += delta * 0.12;
  coreView.shell.rotation.x = Math.sin(elapsed * 0.22) * 0.12;
  coreView.wire.rotation.y -= delta * 0.2;
  coreView.wire.rotation.z += delta * 0.06;
  coreView.rings.forEach((ring, i) => {
    ring.rotation.z += delta * (0.3 + i * 0.16);
    ring.rotation.x += delta * 0.07 * (i + 1);
  });
  coreView.halo.material.opacity = 0.22 + coreView.glow * 0.3;
  coreLight.intensity = 300 + coreView.glow * 240 + Math.sin(elapsed * 1.4) * 24;

  // 边上的流动光点
  flowDots.forEach((dot) => {
    const edge = dot.userData.edge;
    const t = (elapsed * edge.speed + edge.offset) % 1;
    const point = edge.curve.getPoint(t);
    dot.position.copy(point);
    dot.material.opacity = 0.32 + 0.4 * Math.sin(t * Math.PI);
  });

  // 脉冲
  for (let i = pulses.length - 1; i >= 0; i -= 1) {
    const pulse = pulses[i];
    pulse.t += delta / pulse.life;
    if (pulse.t < 0) continue;
    if (pulse.t >= 1.06) {
      scene.remove(pulse.head, pulse.core);
      pulse.trail.forEach((s) => scene.remove(s));
      pulse.head.material.dispose(); pulse.core.material.dispose();
      pulse.trail.forEach((s) => s.material.dispose());
      pulses.splice(i, 1);
      continue;
    }
    const t = Math.min(1, pulse.t);
    const point = pulse.path.getPointAt(t);
    const ahead = pulse.path.getPointAt(Math.min(1, t + 0.012));
    pulse.head.position.copy(point);
    pulse.core.position.copy(point);
    pulse.head.material.opacity = 0.85 * (1 - Math.max(0, pulse.t - 0.9) / 0.16);
    pulse.core.material.opacity = pulse.head.material.opacity;
    pulse.head.scale.setScalar(1.85 + Math.sin(elapsed * 22) * 0.16);
    for (let k = 0; k < pulse.trail.length; k += 1) {
      const tt = Math.max(0, t - (k + 1) * 0.026);
      const tp = pulse.path.getPointAt(tt);
      const trail = pulse.trail[k];
      trail.position.copy(tp);
      trail.material.opacity = Math.max(0, 0.62 - k * 0.06) * (1 - Math.max(0, pulse.t - 0.9) / 0.2);
      trail.scale.setScalar(0.85 * (1 - k / 10));
    }
    // 抵达节点 → 闪光 + 涟漪
    pulse.nodeT.forEach((item) => {
      if (item.t <= t && !pulse.visited.has(item.id)) {
        pulse.visited.add(item.id);
        burstRipple(item.id, pulse.color.getStyle(), 1);
      }
    });
    // 方向：给头部一点朝向感
    pulse.head.position.lerp(ahead, 0.35);
  }

  // 涟漪
  for (let i = ripples.length - 1; i >= 0; i -= 1) {
    const ripple = ripples[i];
    ripple.age += delta;
    const p = ripple.age / ripple.life;
    if (p >= 1) { scene.remove(ripple.mesh); ripple.mesh.material.dispose(); ripples.splice(i, 1); continue; }
    ripple.mesh.scale.setScalar((0.9 + p * 3.2));
    ripple.mesh.material.opacity = 0.8 * (1 - p) ** 1.6;
    ripple.mesh.quaternion.copy(camera.quaternion);
  }

  if (stars) stars.rotation.y += delta * 0.006;
  gridGroup.rotation.y += delta * 0.012;

  if (elapsed - lastDeclutter > 0.25) { lastDeclutter = elapsed; declutterLabels(); }

  composer.render();
  labelRenderer.render(scene, camera);
  requestAnimationFrame(animate);
}

// ───────────────────────────────── 启动 ─────────────────────────────────
setLive(false);
connectStream();
animate();
// 节点详情里的「最近一次 / 最近判定」：一次拉取，点节点时直接用
loadSummary();
// 开场先跑一条完整链路，打开就能看到动效
setTimeout(() => {
  const color = EVENT_STYLE.receipt_verified.color;
  spawnPulse(['android', 'events', 'route', 'tasks', 'gate', 'actions', 'events'], color);
  burstRipple('core', '#22d3ee', 1.4);
}, 520);
setTimeout(() => selectNode(null), 0);

// ?pulse=<eventType>&ch=<channel>：立刻跑一条指定链路（截图/演示用，不依赖 SSE）
const BOOT_TASK = params.get('task'); // 截图/分享用：直接展开某条任务流程
const BOOT_PULSE = params.get('pulse');
if (BOOT_PULSE) {
  const fire = () => trigger({ eventType: BOOT_PULSE, channel: params.get('ch') ?? 'qq' });
  setTimeout(fire, 80);
  // 演示用：持续循环同一条链路，打开页面任何时候都能看到光点在跑
  if (params.get('loop') === '1') setInterval(fire, 1100);
}
if (FORCE_DEMO) setTimeout(randomDemoEvent, 80);
// ?node=actions 直接展开某个节点的详情（截图/分享用）
const BOOT_NODE = params.get('node');
if (BOOT_NODE) setTimeout(() => selectNode(BOOT_NODE), 500);
if (BOOT_TASK) setTimeout(() => openFlow({ taskId: BOOT_TASK }), 700);
