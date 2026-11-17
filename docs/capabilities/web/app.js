/* 大肥鱼 · 能力图谱 — three.js scene */
(function () {
  'use strict';

  var DATA = [
    {
      id: 'publishing', name: '发图文', icon: '🚀', color: '#4d7cff', status: 'stable',
      tagline: '生成 → 编号审核 → 填页 → 发布',
      points: [
        '两次审核的发布链路：先生成草稿，编号发给爸爸审',
        '同意后才填抖音发布页并发出去',
        '单图可发；多图补选未做通（DAFEIYU_MULTI_IMAGE 关着）'
      ],
      files: ['connect/actions.mjs', 'scripts/douyin-post.mjs', 'scripts/douyin-confirm.mjs']
    },
    {
      id: 'reply-inbox', name: '回评论', icon: '💬', color: '#35d2ff', status: 'stable',
      tagline: '互动消息 → 收到的评论 → 内联回复',
      points: [
        '消息 tab → 互动消息行 → 收到的评论 → 行内回复',
        '合规闸门：90 秒/条、30 条/天、24h 去重',
        '回复完常停在横屏流，回列表前要 backToFeed'
      ],
      files: ['device/douyin.mjs', 'scripts/douyin.mjs', 'connect/douyin/compliance.mjs']
    },
    {
      id: 'hot-comments', name: '爆款热评', icon: '🔥', color: '#ff7a59', status: 'beta',
      tagline: '搜索热视频 → 高赞评论 → 回复',
      points: [
        '每日 5 轮 × 4 条：12:00 / 14:00 / 16:00 / 18:30 / 21:00',
        '按赞数取前 N 条，生成可爱回复再过合规闸门',
        '偶发 comments_empty / card_missing 时序问题'
      ],
      files: ['connect/douyin/discover.mjs', 'device/douyin.mjs', 'scripts/douyin.mjs']
    },
    {
      id: 'planner-tools', name: '决策脑与工具', icon: '🧠', color: '#a77bff', status: 'stable',
      tagline: '模型规划 steps → 执行 → 事实回灌',
      points: [
        '每条消息先给 planner：{ say, steps: [{ tool, args }] }',
        '只读工具立即执行；写工具只建任务等爸爸确认',
        '工具 ok 只代表命令没崩，不代表事情做成'
      ],
      files: ['connect/qq/planner.mjs', 'connect/qq/tools.mjs', 'connect/qq/service.mjs']
    },
    {
      id: 'qq-bridge', name: 'QQ 通道', icon: '📡', color: '#37e6c9', status: 'stable',
      tagline: '收发消息 / 审批 / 发件箱',
      points: [
        'WebSocket 网关收发，service.handle 做审批、规划、回复',
        '群主动消息被拒（40034105）时用 qq_outbox 借被动窗口补发',
        '网关半死连接会一直显示 online（缺心跳看门狗）'
      ],
      files: ['connect/qq/service.mjs', 'connect/qq/gateway.mjs', 'connect/qq/api.mjs']
    },
    {
      id: 'scheduler-mood', name: '日程与情绪', icon: '🗓', color: '#ffc857', status: 'stable',
      tagline: '每日计划 / 定时执行 / 心情状态',
      points: [
        '每天生成日程槽，调度器每 60 秒跑到期槽位',
        '心情由规则决定：失败多 → 低能量，久不发 → 好奇',
        '状态写入 mood.json 与 mood_history'
      ],
      files: ['connect/scheduler.mjs', 'connect/douyin/dayplan.mjs', 'connect/douyin/mood.mjs']
    },
    {
      id: 'board', name: '运行看板', icon: '📊', color: '#5b8dff', status: 'stable',
      tagline: '概览 / 内容 / 互动 / 成长 / 系统',
      points: [
        '127.0.0.1:8765/board，M3 深色，hash 路由五页',
        '前端 shell + modules，模块契约 meta + mount(host, ctx)',
        '内容页可直接编辑草稿并点「发布到抖音」'
      ],
      files: ['connect/board.mjs', 'connect/board/shell.mjs', 'connect/board/modules/home.mjs']
    },
    {
      id: 'academy', name: '成长学院', icon: '🎓', color: '#ff8ad8', status: 'stable',
      tagline: '12 门课 / 七步学习 / 认证 / 周记',
      points: [
        '12 门课 / 四阶段 / 每门 7 步：导入 → … → 总结',
        'Lv1–Lv4 认证按真实战绩，毕业项目 12 项',
        '已跑真 LLM；考核分数解析与降级兜底可用'
      ],
      files: ['connect/academy/courses.mjs', 'connect/academy/study.mjs', 'connect/academy/levels.mjs']
    },
    {
      id: 'stores', name: '数据层', icon: '🗄', color: '#48d98a', status: 'stable',
      tagline: 'connect.sqlite + douyin.db',
      points: [
        'connect.sqlite：任务、QQ 消息、事件、计划槽、心情、成长档案',
        'douyin.db：作品、评论、视频、热评、粉丝、热点',
        '任务状态机在 tasks.mjs，事件有 EVENT_TYPES 白名单'
      ],
      files: ['connect/douyin/store.mjs', 'connect/tasks.mjs', 'connect/agent-events.mjs']
    },
    {
      id: 'skills-learning', name: '技能与学习', icon: '🧪', color: '#c78bff', status: 'beta',
      tagline: '技能版本 / 反思聚合 / 策略试验',
      points: [
        'skill_registry / skill_versions / skill_runs 骨架已搭',
        '失败按 skill:failure:stage 聚合到 learning_proposals',
        '现状：表存在但全 0 行，步骤判据与 fallback 还是空'
      ],
      files: ['connect/skills.mjs', 'connect/reflection.mjs', 'connect/strategies.mjs']
    },
    {
      id: 'device-layer', name: '手机自动化', icon: '📱', color: '#7fd8ff', status: 'beta',
      tagline: 'ADB / UI dump / 坐标点击 / 断言',
      points: [
        'uiautomator2 服务 127.0.0.1:19008 → 设备 9008',
        '封装 resetDouyin / backToFeed / parseComments',
        '已知缺口：没有弹窗阻断检测，点击后无后置断言'
      ],
      files: ['device/douyin.mjs', 'device/uia.mjs', 'device/wechat.mjs']
    },
    {
      id: 'memory-hub', name: '记忆与活动', icon: '🌊', color: '#8ea8ff', status: 'stable',
      tagline: '长期记忆 / 活动流 / 经验注入',
      points: [
        'brain/memory.mjs：turns / memories / 修订，可审计',
        'recall 按词重叠取相关记忆，注入模型上下文',
        'lessons 文本经验注入 planner 与 brain'
      ],
      files: ['brain/memory.mjs', 'connect/memory-hub.mjs', 'connect/daily-memory.mjs']
    }
  ];


  /* ------------------------------------------------------------ mobile list */
  var NARROW_MQ = '(max-width: 760px)';
  function buildList() {
    var host = document.getElementById('list');
    if (!host) return;
    var src = window.__FISH_SRC__ || '';
    var html = '<div class="hero">' + (src ? '<img alt="大肥鱼" src="' + src + '">' : '') + '</div>';
    DATA.forEach(function (d) {
      var ok = d.status === 'stable';
      html += '<article class="card" style="--c:' + d.color + '">'
        + '<div class="c-icon">' + d.icon + '</div>'
        + '<div class="c-body">'
        + '<div class="c-top"><h3>' + d.name + '</h3><code>' + d.id + '</code>'
        + '<span class="pill ' + (ok ? 'ok' : 'beta') + '">' + d.status + '</span></div>'
        + '<p class="c-tag">' + d.tagline + '</p>'
        + '<ul class="c-pts">' + d.points.map(function (t) { return '<li>' + t + '</li>'; }).join('') + '</ul>'
        + '<div class="c-more">展开要点</div>'
        + '</div></article>';
    });
    host.innerHTML = html;
    host.addEventListener('click', function (e) {
      var card = e.target.closest('.card');
      if (!card) return;
      card.classList.toggle('open');
      var more = card.querySelector('.c-more');
      if (more) more.textContent = card.classList.contains('open') ? '收起' : '展开要点';
    });

    var el = document.getElementById('counts');
    var stable = DATA.filter(function (d) { return d.status === 'stable'; }).length;
    if (el) el.textContent = DATA.length + ' 项能力 · ' + stable + ' stable · ' + (DATA.length - stable) + ' beta';
  }

  if (window.matchMedia(NARROW_MQ).matches) {
    buildList();
    var wasNarrow = true;
    window.addEventListener('resize', function () {
      if (window.matchMedia(NARROW_MQ).matches !== wasNarrow) location.reload();
    });
    return;
  }

  var canvas = document.getElementById('scene');
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
  camera.position.set(0, 0, 11.0);

  var world = new THREE.Group();
  scene.add(world);

  var orbRoot = new THREE.Group();  // bubbles + lines, draggable
  world.add(orbRoot);

  /* ---------------------------------------------------------------- helpers */

  function radialTexture(stops, size) {
    var c = document.createElement('canvas');
    size = size || 256;
    c.width = c.height = size;
    var g = c.getContext('2d');
    var grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    stops.forEach(function (s) { grd.addColorStop(s[0], s[1]); });
    g.fillStyle = grd;
    g.fillRect(0, 0, size, size);
    var t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  var haloTexture = radialTexture([
    [0, 'rgba(255,255,255,1)'],
    [0.25, 'rgba(255,255,255,0.55)'],
    [0.55, 'rgba(255,255,255,0.12)'],
    [1, 'rgba(255,255,255,0)']
  ]);

  function hexToRgb(hex) {
    var n = parseInt(hex.slice(1), 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
  }

  /* ------------------------------------------------------------ background */

  // nebula glows
  [
    { x: -6, y: 2.5, z: -12, s: 16, c: '#1d3a9c', o: 0.30 },
    { x: 6.5, y: -3, z: -14, s: 18, c: '#3c1d8f', o: 0.26 },
    { x: 0, y: 5.5, z: -16, s: 20, c: '#0f4f8a', o: 0.20 }
  ].forEach(function (n) {
    var m = new THREE.SpriteMaterial({
      map: haloTexture, color: new THREE.Color(n.c), transparent: true,
      opacity: n.o, blending: THREE.AdditiveBlending, depthWrite: false
    });
    var sp = new THREE.Sprite(m);
    sp.position.set(n.x, n.y, n.z);
    sp.scale.set(n.s, n.s, 1);
    world.add(sp);
  });

  // stars
  var updateStars = function () {};
  (function () {
    var COUNT = 1100;
    var pos = new Float32Array(COUNT * 3);
    var size = new Float32Array(COUNT);
    var phase = new Float32Array(COUNT);
    for (var i = 0; i < COUNT; i++) {
      var r = 9 + Math.random() * 20;
      var th = Math.random() * Math.PI * 2;
      var ph = Math.acos(2 * Math.random() - 1);
      pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = r * Math.cos(ph) * 0.75;
      pos[i * 3 + 2] = -Math.abs(r * Math.sin(ph) * Math.sin(th)) - 2;
      size[i] = 0.6 + Math.random() * 2.2;
      phase[i] = Math.random() * Math.PI * 2;
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    var mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
        uColor: { value: new THREE.Color('#9dc4ff') }
      },
      vertexShader: [
        'attribute float aSize;',
        'attribute float aPhase;',
        'uniform float uTime;',
        'uniform float uPixelRatio;',
        'varying float vA;',
        'void main(){',
        '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
        '  gl_Position = projectionMatrix * mv;',
        '  float tw = 0.45 + 0.55 * sin(uTime * 1.4 + aPhase);',
        '  vA = tw;',
        '  gl_PointSize = aSize * uPixelRatio * (16.0 / max(-mv.z, 1.0));',
        '}'
      ].join('\n'),
      fragmentShader: [
        'varying float vA;',
        'uniform vec3 uColor;',
        'void main(){',
        '  vec2 c = gl_PointCoord - 0.5;',
        '  float d = length(c);',
        '  float a = smoothstep(0.5, 0.0, d);',
        '  gl_FragColor = vec4(uColor, a * a * vA * 0.85);',
        '}'
      ].join('\n'),
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
    });
    var pts = new THREE.Points(geo, mat);
    world.add(pts);
    updateStars = function (t) { mat.uniforms.uTime.value = t; };
  })();

  // rising bubbles
  var bubbles = [];
  (function () {
    var g = new THREE.BufferGeometry();
    var COUNT = 46;
    var pos = new Float32Array(COUNT * 3);
    var seed = new Float32Array(COUNT);
    for (var i = 0; i < COUNT; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 16;
      pos[i * 3 + 1] = (Math.random() - 0.5) * 12;
      pos[i * 3 + 2] = -3 - Math.random() * 7;
      seed[i] = Math.random();
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    var m = new THREE.PointsMaterial({
      color: new THREE.Color('#8fc6ff'), size: 0.055, transparent: true,
      opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true
    });
    var pts = new THREE.Points(g, m);
    world.add(pts);
    bubbles.push({ pts: pts, seed: seed, pos: pos, count: COUNT, geometry: g });
  })();

  /* ------------------------------------------------------------------ fish */

  var fishAspect = 0.748;
  var fishGroup = new THREE.Group();
  world.add(fishGroup);

  var glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: haloTexture, color: new THREE.Color('#3f6dff'), transparent: true,
    opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false
  }));
  glow.scale.set(8.6, 8.6, 1);
  glow.position.set(0, 0.1, -0.5);
  fishGroup.add(glow);

  var groundGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: haloTexture, color: new THREE.Color('#4d84ff'), transparent: true,
    opacity: 0.30, blending: THREE.AdditiveBlending, depthWrite: false
  }));
  groundGlow.scale.set(6.4, 1.5, 1);
  groundGlow.position.set(0, -2.42, -0.2);
  fishGroup.add(groundGlow);

  var FISH_H = 4.32;
  var MODEL_H = 2.60;

  // lights: only the toon model reacts to them (everything else is basic/shader)
  scene.add(new THREE.HemisphereLight(0xe8f0ff, 0x2b3260, 1.15));
  var keyLight = new THREE.DirectionalLight(0xfff3e2, 1.75);
  keyLight.position.set(2.8, 5.0, 5.4);
  scene.add(keyLight);
  var rimLight = new THREE.DirectionalLight(0x92b6ff, 1.15);
  rimLight.position.set(-3.8, 2.0, -3.4);
  scene.add(rimLight);

  var fishPivot = new THREE.Group();
  var fishSpin = new THREE.Group();
  fishPivot.add(fishSpin);
  fishPivot.scale.setScalar(FISH_H / MODEL_H);
  fishPivot.position.y = -FISH_H / 2 - 0.16;
  fishGroup.add(fishPivot);

  var fishModel = null;
  var fishMesh = null;

  function b64bytes(b64) {
    var s = atob(b64), n = s.length, out = new Uint8Array(n);
    for (var i = 0; i < n; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  function buildFishGeometry(data) {
    var n = data.n, scale = data.scale;
    var pb = b64bytes(data.pos), cb = b64bytes(data.col), ib = b64bytes(data.idx);
    var pv = new DataView(pb.buffer), cv = null, iv = new DataView(ib.buffer);
    var pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    for (var i = 0; i < n * 3; i++) pos[i] = pv.getInt16(i * 2, true) / scale;
    for (var i2 = 0; i2 < n * 3; i2++) {
      var v = cb[i2] / 255;
      col[i2] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    }
    var tris = data.tris, idx = new Uint16Array(tris * 3);
    for (var i3 = 0; i3 < tris * 3; i3++) idx[i3] = iv.getUint16(i3 * 2, true);
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('col', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return geo;
  }

  var fishVS = [
    'varying vec3 vN; varying vec3 vV; varying vec3 vC;',
    'attribute vec3 col;',
    'void main() {',
    '  vC = col;',
    '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
    '  vN = normalize(normalMatrix * normal);',
    '  vV = normalize(-mv.xyz);',
    '  gl_Position = projectionMatrix * mv;',
    '}'
  ].join('\n');

  var fishFS = [
    'varying vec3 vN; varying vec3 vV; varying vec3 vC;',
    'void main() {',
    '  vec3 n = normalize(vN);',
    '  vec3 v = normalize(vV);',
    '  vec3 L1 = normalize(vec3(-0.38, 0.52, 0.77));',
    '  vec3 L2 = normalize(vec3(0.62, -0.30, 0.72));',
    '  float lam = clamp(dot(n, L1) * 0.5 + 0.5, 0.0, 1.0);',
    '  float shade = 0.62 + 0.33 * lam;',
    '  vec3 col = vC * shade;',
    '  col += vC * max(0.0, dot(n, L2)) * 0.12;',
    '  float rim = pow(1.0 - max(0.0, dot(n, v)), 3.0);',
    '  col += vec3(0.34, 0.50, 1.0) * rim * 0.26;',
    '  float sheen = pow(max(0.0, dot(n, normalize(vec3(-0.15, 0.55, 0.82)))), 24.0);',
    '  col += vec3(1.0) * sheen * 0.05;',
    '  col *= vec3(0.99, 0.985, 0.975);',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  var fishMat3d = new THREE.ShaderMaterial({
    vertexShader: fishVS,
    fragmentShader: fishFS,
    side: THREE.DoubleSide,
    toneMapped: false
  });

  var FISH_MESH_DATA = window.__FISH_MESH__;
  if (FISH_MESH_DATA) {
    try {
      var fgeo = buildFishGeometry(FISH_MESH_DATA);
      fishMesh = new THREE.Mesh(fgeo, fishMat3d);
      fishSpin.add(fishMesh);
      fishModel = fishMesh;
    } catch (e) {
      if (window.console) console.warn('3D model failed, falling back to artwork', e);
    }
  }

  var fishPlane = null;
  var fishMat = new THREE.MeshBasicMaterial({
    transparent: true, depthWrite: true, depthTest: true, alphaTest: 0.04, toneMapped: false
  });
  var FISH_SRC = window.__FISH_SRC__;
  if (FISH_SRC) {
    fishPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), fishMat);
    fishPlane.scale.set(3.24, 4.05, 1);
    fishPlane.visible = !fishModel;
    fishGroup.add(fishPlane);
    var img = new Image();
    img.onload = function () {
      var t = new THREE.Texture(img);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      t.needsUpdate = true;
      fishMat.map = t;
      fishMat.needsUpdate = true;
      fishAspect = img.naturalWidth / img.naturalHeight;
      fishPlane.scale.set(4.05 * fishAspect, 4.05, 1);
      fishPlane.position.y = -0.05;
    };
    img.src = FISH_SRC;
  }

  (function () {
    var btn = document.getElementById('fish-mode');
    if (!btn) return;
    if (!fishModel || !fishPlane) { btn.style.display = 'none'; return; }
    var use3d = true;
    btn.addEventListener('click', function () {
      use3d = !use3d;
      fishSpin.visible = use3d;
      fishPlane.visible = !use3d;
      btn.textContent = use3d ? '3D 模型' : '插画';
    });
  })();

  /* ---------------------------------------------------------------- orbits */

  var orbVS = [
    'varying vec3 vN;',
    'varying vec3 vV;',
    'void main(){',
    '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
    '  vN = normalize(normalMatrix * normal);',
    '  vV = normalize(-mv.xyz);',
    '  gl_Position = projectionMatrix * mv;',
    '}'
  ].join('\n');

  var orbFS = [
    'uniform vec3 uColor;',
    'uniform float uHover;',
    'varying vec3 vN;',
    'varying vec3 vV;',
    'void main(){',
    '  vec3 N = normalize(vN);',
    '  vec3 V = normalize(vV);',
    '  float d = clamp(dot(N, V), 0.0, 1.0);',
    '  float fres = pow(1.0 - d, 2.4);',
    '  vec3 col = uColor * 0.06 + uColor * 0.42 * pow(d, 1.7) + uColor * fres * 1.5;',
    '  vec3 L = normalize(vec3(-0.45, 0.62, 0.95));',
    '  float spec = pow(max(dot(reflect(-L, N), V), 0.0), 46.0);',
    '  col += vec3(1.0) * spec * 1.35;',
    '  float a = 0.40 + fres * 0.56 + spec * 0.55;',
    '  a *= 0.92 + uHover * 0.08;',
    '  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));',
    '}'
  ].join('\n');

  var lineVS = [
    'attribute float aT;',
    'varying float vT;',
    'void main(){',
    '  vT = aT;',
    '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
    '}'
  ].join('\n');

  var lineFS = [
    'uniform float uTime;',
    'uniform float uOpacity;',
    'uniform vec3 uColor;',
    'varying float vT;',
    'void main(){',
    '  float s = fract(vT * 1.7 - uTime * 0.22);',
    '  float dash = smoothstep(0.0, 0.10, s) * (1.0 - smoothstep(0.40, 0.72, s));',
    '  float edge = smoothstep(0.0, 0.10, vT) * (1.0 - smoothstep(0.86, 1.0, vT));',
    '  gl_FragColor = vec4(uColor, (0.085 + dash * 0.50) * edge * uOpacity);',
    '}'
  ].join('\n');

  var orbs = [];
  var _tmpV = new THREE.Vector3();
  var hitTargets = [];
  var labels = [];

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function makeLabel(item, colorHex) {
    var W = 720, H = 232;
    var c = document.createElement('canvas');
    c.width = W * 2; c.height = H * 2;
    var g = c.getContext('2d');
    g.scale(2, 2);
    g.clearRect(0, 0, W, H);
    g.textAlign = 'center';
    g.textBaseline = 'middle';

    var nameFont = '600 56px "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif';
    var idFont = '500 27px "SF Mono", "JetBrains Mono", ui-monospace, Menlo, monospace';
    g.font = nameFont;
    var nameW = g.measureText(item.name).width;
    g.font = idFont;
    var idW = g.measureText(item.id).width;
    var isStable = item.status === 'stable';
    var pillW = 118;
    var innerW = Math.max(nameW, idW, pillW + 34);
    var plateW = Math.min(W - 12, innerW + 66);
    var plateH = 196;
    var px = (W - plateW) / 2, py = (H - plateH) / 2;

    // glass plate
    roundRect(g, px, py, plateW, plateH, 34);
    var grad = g.createLinearGradient(0, py, 0, py + plateH);
    grad.addColorStop(0, 'rgba(16,30,62,0.62)');
    grad.addColorStop(1, 'rgba(6,12,28,0.72)');
    g.fillStyle = grad;
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = 'rgba(128,170,255,0.22)';
    g.stroke();

    // name
    g.font = nameFont;
    g.shadowColor = 'rgba(120,180,255,0.55)';
    g.shadowBlur = 14;
    g.fillStyle = 'rgba(238,245,255,0.97)';
    g.fillText(item.name, W / 2, py + 56);

    // id
    g.shadowBlur = 0;
    g.font = idFont;
    g.fillStyle = 'rgba(146,176,228,0.78)';
    g.fillText(item.id, W / 2, py + 108);

    // status pill
    var statusText = isStable ? 'stable' : 'beta';
    g.font = '500 25px "SF Mono", ui-monospace, Menlo, monospace';
    var tw = g.measureText(statusText).width;
    var dotR = 7, gap = 11;
    var contentW = dotR * 2 + gap + tw;
    var startX = W / 2 - contentW / 2;
    g.beginPath();
    g.arc(startX + dotR, py + 156, dotR, 0, Math.PI * 2);
    g.fillStyle = isStable ? 'rgba(74,227,176,0.95)' : 'rgba(255,196,92,0.95)';
    g.shadowColor = isStable ? 'rgba(74,227,176,0.9)' : 'rgba(255,196,92,0.9)';
    g.shadowBlur = 12;
    g.fill();
    g.shadowBlur = 0;
    g.textAlign = 'left';
    g.fillStyle = isStable ? 'rgba(140,240,212,0.9)' : 'rgba(255,212,140,0.9)';
    g.fillText(statusText, startX + dotR * 2 + gap, py + 157);

    var tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    var m = new THREE.SpriteMaterial({
      map: tex, transparent: true, opacity: 0.74, depthWrite: false, depthTest: false, toneMapped: false
    });
    var sp = new THREE.Sprite(m);
    sp.scale.set(1.62, 1.62 * (H / W), 1);
    return sp;
  }

  // 左右两簇星座：6 + 6，避开角色轮廓，读起来像"能力星图"
  function anchorOf(i) {
    var side = (i % 2 === 0) ? -1 : 1;
    var k = Math.floor(i / 2);              // 0..5
    var ax = side * (2.80 + (k % 2) * 0.80 + k * 0.02);
    var ay = 1.70 - k * 0.82;               // 1.70 .. -2.40
    var az = Math.sin(i * 1.87) * 0.62;
    return { x: ax, y: ay, z: az };
  }

  DATA.forEach(function (item, i) {
    var color = new THREE.Color(item.color);
    var anchor = anchorOf(i);

    var orb = new THREE.Group();
    orbRoot.add(orb);

    var sphere = new THREE.Mesh(
      new THREE.SphereGeometry(0.37, 40, 32),
      new THREE.ShaderMaterial({
        uniforms: { uColor: { value: color }, uHover: { value: 0 } },
        vertexShader: orbVS, fragmentShader: orbFS,
        transparent: true, depthWrite: false
      })
    );
    orb.add(sphere);

    var halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: haloTexture, color: color, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false
    }));
    halo.scale.set(1.9, 1.9, 1);
    orb.add(halo);

    var ringMesh = new THREE.Mesh(
      new THREE.TorusGeometry(0.52, 0.0075, 6, 72),
      new THREE.MeshBasicMaterial({
        color: color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false
      })
    );
    ringMesh.rotation.x = 1.15;
    orb.add(ringMesh);

    var label = makeLabel(item, item.color);
    label.position.set(0, -0.74, 0);
    orb.add(label);

    var hit = new THREE.Mesh(
      new THREE.SphereGeometry(0.62, 12, 10),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    orb.add(hit);
    hit.userData.index = i;
    hitTargets.push(hit);

    orbs.push({
      data: item, group: orb, sphere: sphere, halo: halo, label: label,
      ringMesh: ringMesh, color: color,
      anchor: anchor, seed: i * 1.7,
      hover: 0, hoverTarget: 0, scale: 1, scaleTarget: 1,
      pos: new THREE.Vector3()
    });
  });

  /* ------------------------------------------------------------- connectors */

  var lines = [];
  DATA.forEach(function (item, i) {
    var seg = 26;
    var positions = new Float32Array((seg + 1) * 3);
    var tArr = new Float32Array(seg + 1);
    for (var j = 0; j <= seg; j++) tArr[j] = j / seg;
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aT', new THREE.BufferAttribute(tArr, 1));
    var mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uOpacity: { value: 1 },
        uColor: { value: new THREE.Color(item.color) }
      },
      vertexShader: lineVS, fragmentShader: lineFS,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
    });
    var line = new THREE.Line(geo, mat);
    line.frustumCulled = false;
    orbRoot.add(line);

    var pulse = new THREE.Sprite(new THREE.SpriteMaterial({
      map: haloTexture, color: new THREE.Color(item.color), transparent: true,
      opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false
    }));
    pulse.scale.set(0.22, 0.22, 1);
    orbRoot.add(pulse);

    lines.push({
      line: line, mat: mat, geo: geo, positions: positions, seg: seg,
      pulse: pulse, offset: Math.random(), curve: new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()
      )
    });
  });

  /* --------------------------------------------------------------- big ring */

  var bigRing = new THREE.Mesh(
    new THREE.TorusGeometry(6.4, 0.006, 4, 220),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color('#5f8bff'), transparent: true, opacity: 0.18,
      blending: THREE.AdditiveBlending, depthWrite: false
    })
  );
  bigRing.rotation.x = Math.PI / 2.35;
  bigRing.position.y = -0.2;
  world.add(bigRing);

  var bigRing2 = bigRing.clone();
  bigRing2.material = bigRing.material.clone();
  bigRing2.material.opacity = 0.10;
  bigRing2.scale.setScalar(0.72);
  bigRing2.rotation.x = Math.PI / 2.9;
  bigRing2.rotation.z = 0.6;
  world.add(bigRing2);

  /* ------------------------------------------------------------ interaction */

  var pointer = new THREE.Vector2(-10, -10);
  var pointerPx = { x: 0, y: 0 };
  var raycaster = new THREE.Raycaster();
  var hovered = -1;
  var selected = -1;

  var drag = { active: false, moved: 0, x: 0, y: 0, vx: 0, vy: 0 };
  var rotX = 0.12, rotY = 0.2;
  var camZ = 11.0, camZTarget = 11.0;
  var panelAmt = 0, panelAmtTarget = 0, baseFit = 1;

  var panel = document.getElementById('panel');
  var panelBody = document.getElementById('panel-body');
  var hint = document.getElementById('hint');
  var scrim = document.getElementById('scrim');

  function setHovered(idx) {
    if (hovered === idx) return;
    hovered = idx;
    orbs.forEach(function (o, i) {
      o.hoverTarget = (i === idx || i === selected) ? 1 : 0;
      o.scaleTarget = (i === idx) ? 1.24 : (i === selected ? 1.12 : 1);
    });
    canvas.style.cursor = idx >= 0 ? 'pointer' : 'grab';
  }

  function renderPanel(item) {
    var stable = item.status === 'stable';
    var html = ''
      + '<div class="p-head">'
      + '<div class="p-icon" style="--c:' + item.color + '">' + item.icon + '</div>'
      + '<div class="p-titles">'
      + '<h2>' + item.name + '</h2>'
      + '<code>' + item.id + '</code>'
      + '</div>'
      + '<span class="pill ' + (stable ? 'ok' : 'beta') + '">' + item.status + '</span>'
      + '</div>'
      + '<p class="p-tag">' + item.tagline + '</p>'
      + '<ul class="p-list">' + item.points.map(function (p) {
        return '<li>' + p + '</li>';
      }).join('') + '</ul>'
      + '<div class="p-files"><span>关键文件</span>'
      + item.files.map(function (f) { return '<code>' + f + '</code>'; }).join('')
      + '</div>'
      + '<a class="p-link" href="./' + item.id + '.md" target="_blank" rel="noreferrer">打开细节文档 ↗</a>';
    panelBody.innerHTML = html;
  }

  function select(idx) {
    selected = idx;
    var wide = window.innerWidth > 820;
    panelAmtTarget = (idx >= 0 && wide) ? 1 : 0;
    if (idx < 0) {
      panel.classList.remove('open');
      if (scrim) scrim.classList.remove('on');
      if (hint) hint.classList.remove('dim');
      setHovered(hovered);
      return;
    }
    renderPanel(DATA[idx]);
    panel.classList.add('open');
    if (scrim) scrim.classList.add('on');
    setHovered(hovered);
    orbs.forEach(function (o, i) {
      o.scaleTarget = (i === idx) ? 1.16 : 1;
      o.hoverTarget = (i === idx || i === hovered) ? 1 : 0;
    });
    if (hint) hint.classList.add('dim');
  }

  canvas.addEventListener('pointerdown', function (e) {
    drag.active = true;
    drag.moved = 0;
    drag.x = e.clientX; drag.y = e.clientY;
    drag.vx = 0; drag.vy = 0;
    canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
  });

  canvas.addEventListener('pointermove', function (e) {
    var r = canvas.getBoundingClientRect();
    pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    pointerPx.x = e.clientX; pointerPx.y = e.clientY;

    if (drag.active) {
      var dx = e.clientX - drag.x;
      var dy = e.clientY - drag.y;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      rotY += dx * 0.0055;
      rotX = Math.max(-0.42, Math.min(0.42, rotX + dy * 0.0035));
      drag.vx = dx * 0.0055;
      drag.vy = dy * 0.0035;
      drag.x = e.clientX; drag.y = e.clientY;
      canvas.style.cursor = 'grabbing';
    }
  });

  function endDrag(e) {
    if (!drag.active) return;
    drag.active = false;
    canvas.style.cursor = hovered >= 0 ? 'pointer' : 'grab';
    if (drag.moved < 7) {
      // click
      raycaster.setFromCamera(pointer, camera);
      var hits = raycaster.intersectObjects(hitTargets, false);
      if (hits.length) {
        var idx = hits[0].object.userData.index;
        select(selected === idx ? -1 : idx);
      } else {
        select(-1);
      }
    }
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', function () { drag.active = false; });
  canvas.addEventListener('pointerleave', function () { pointer.set(-10, -10); });

  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    camZTarget = Math.max(7.6, Math.min(13.5, camZTarget + e.deltaY * 0.0055));
  }, { passive: false });

  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') select(-1);
  });

  /* ------------------------------------------------------------------ sizing */

  function resize() {
    var w = canvas.clientWidth || window.innerWidth;
    var h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;

    // 以"版面需要多宽/多高"反推缩放，竖屏时也能把高度用起来
    var tan = Math.tan(camera.fov * Math.PI / 360);
    var viewHalfW = tan * 11 * (w / h);
    var fit = Math.min(viewHalfW / 5.95, tan * 11 / 4.15);
    fit = Math.max(0.58, Math.min(1.12, fit));
    baseFit = fit;
    world.scale.setScalar(fit * (1 - 0.105 * panelAmt));

    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);

  /* ------------------------------------------------------------------- loop */

  var clock = new THREE.Clock();
  var t = 0;

  function updateLines(time) {
    for (var i = 0; i < orbs.length; i++) {
      var o = orbs[i];
      var L = lines[i];
      o.group.getWorldPosition(o.pos);
      // convert to orbRoot local space
      var end = orbRoot.worldToLocal(o.pos.clone());
      var start = new THREE.Vector3(0, 0.15, -0.9);
      var ctrl = start.clone().lerp(end, 0.45);
      ctrl.y += 0.9;
      ctrl.z += 0.02;
      L.curve.v0.copy(start);
      L.curve.v1.copy(ctrl);
      L.curve.v2.copy(end);
      var pts = L.curve.getPoints(L.seg);
      for (var j = 0; j <= L.seg; j++) {
        L.positions[j * 3] = pts[j].x;
        L.positions[j * 3 + 1] = pts[j].y;
        L.positions[j * 3 + 2] = pts[j].z;
      }
      L.geo.attributes.position.needsUpdate = true;
      L.mat.uniforms.uTime.value = time;
      var isFocus = (i === selected || i === hovered);
      L.mat.uniforms.uOpacity.value = isFocus ? 1.9 : 1;

      var p = (time * 0.22 + L.offset) % 1;
      var pt = L.curve.getPoint(p);
      L.pulse.position.copy(pt);
      L.pulse.material.opacity = (isFocus ? 0.95 : 0.55) * Math.sin(p * Math.PI);
      L.pulse.scale.setScalar(isFocus ? 0.3 : 0.2);
    }
  }

  function animate() {
    requestAnimationFrame(animate);
    var dt = Math.min(clock.getDelta(), 0.05);
    t += dt;

    var speed = reduceMotion ? 0.25 : 1;

    // idle auto-rotation + inertia
    if (!drag.active) {
      rotY += dt * 0.055 * speed + drag.vx;
      rotX += drag.vy;
      rotX = Math.max(-0.42, Math.min(0.42, rotX));
      drag.vx *= 0.94;
      drag.vy *= 0.94;
    }
    orbRoot.rotation.y = rotY;
    orbRoot.rotation.x = rotX;

    // orbit positions
    orbs.forEach(function (o) {
      o.group.position.set(
        o.anchor.x + Math.sin(t * 0.42 + o.seed) * 0.13,
        o.anchor.y + Math.sin(t * 0.63 + o.seed * 1.3) * 0.11,
        o.anchor.z + Math.sin(t * 0.35 + o.seed * 0.7) * 0.16
      );
      o.hover += (o.hoverTarget - o.hover) * Math.min(1, dt * 8);
      o.scale += (o.scaleTarget - o.scale) * Math.min(1, dt * 8);
      o.group.scale.setScalar(o.scale);
      o.sphere.material.uniforms.uHover.value = o.hover;
      o.halo.material.opacity = 0.28 + o.hover * 0.5;
      o.halo.scale.setScalar(1.75 + o.hover * 0.5);
      var wp = o.group.getWorldPosition(_tmpV);
      var front = THREE.MathUtils.clamp((wp.z + 2.6) / 3.6, 0, 1);
      o.label.material.opacity = (0.42 + 0.44 * front) + o.hover * 0.22;
      var halfW = Math.tan(camera.fov * Math.PI / 360) * camZ * camera.aspect / world.scale.x;
      var maxLx = Math.max(1.2, halfW - 0.78);
      var lx = o.anchor.x < 0 ? -1.24 : 1.24;
      lx = Math.max(-maxLx - o.anchor.x, Math.min(maxLx - o.anchor.x, lx));
      o.label.position.x = lx;
      o.label.position.y = 0.0;
      var ls = 0.94 + 0.09 * front + o.hover * 0.12;
      o.label.scale.set(1.62 * ls, 1.62 * (232 / 720) * ls, 1);
      o.ringMesh.material.opacity = o.hover * 0.85;
      o.ringMesh.rotation.z += dt * 0.6 * (0.4 + o.hover);
      o.ringMesh.rotation.y += dt * 0.25;
    });

    // fish idle
    var mx = pointer.x === -10 ? 0 : pointer.x;
    var my = pointer.y === -10 ? 0 : pointer.y;
    fishGroup.position.y = Math.sin(t * 0.95) * 0.085 * speed;
    fishGroup.rotation.y = mx * 0.16;
    fishGroup.rotation.x = -my * 0.05;
    fishGroup.rotation.z = Math.sin(t * 0.7) * 0.012 * speed;
    var breathe = 1 + Math.sin(t * 1.5) * 0.006;
    if (fishModel && fishSpin.visible) {
      fishSpin.rotation.y = mx * 0.30;
      fishSpin.rotation.x = -my * 0.12 + Math.sin(t * 0.9) * 0.012;
      fishPivot.scale.setScalar((FISH_H / MODEL_H) * breathe);
    } else if (fishPlane && fishPlane.visible) {
      fishPlane.scale.set((4.05 * (fishAspect || 0.75)) * breathe, 4.05 * breathe, 1);
    }
    glow.material.opacity = 0.45 + Math.sin(t * 1.1) * 0.07;
    glow.scale.setScalar(8.4 + Math.sin(t * 1.1) * 0.35);
    groundGlow.material.opacity = 0.24 + Math.sin(t * 1.5 + 1) * 0.05;

    bigRing.rotation.z += dt * 0.02 * speed;
    bigRing2.rotation.z -= dt * 0.014 * speed;

    // particles
    updateStars(t);
    bubbles.forEach(function (b) {
      for (var i = 0; i < b.count; i++) {
        b.pos[i * 3 + 1] += dt * (0.09 + b.seed[i] * 0.14) * speed;
        if (b.pos[i * 3 + 1] > 6.5) b.pos[i * 3 + 1] = -6.5;
      }
      b.geometry.attributes.position.needsUpdate = true;
      b.pts.material.opacity = 0.32 + Math.sin(t * 0.5) * 0.08;
    });

    // hover raycast
    if (!drag.active) {
      raycaster.setFromCamera(pointer, camera);
      var hits = raycaster.intersectObjects(hitTargets, false);
      setHovered(hits.length ? hits[0].object.userData.index : -1);
    }

    // camera parallax + zoom
    panelAmt += (panelAmtTarget - panelAmt) * Math.min(1, dt * 6);
    world.position.x = -0.85 * panelAmt;
    world.scale.setScalar(baseFit * (1 - 0.105 * panelAmt));
    camZ += (camZTarget - camZ) * Math.min(1, dt * 6);
    camera.position.z = camZ;
    camera.position.x += (pointer.x * 0.42 * speed - camera.position.x) * Math.min(1, dt * 3);
    camera.position.y += (pointer.y * 0.28 * speed - camera.position.y) * Math.min(1, dt * 3);
    camera.lookAt(0, 0, 0);

    updateLines(t);
    renderer.render(scene, camera);
  }

  canvas.style.cursor = 'grab';
  resize();
  panel.classList.remove('open');
  animate();

  window.__select = select;  // debug hook
  window.__world = world;

  /* footer counts */
  var stableCount = DATA.filter(function (d) { return d.status === 'stable'; }).length;
  var el = document.getElementById('counts');
  if (el) el.textContent = DATA.length + ' 项能力 · ' + stableCount + ' stable · ' + (DATA.length - stableCount) + ' beta';
})();
