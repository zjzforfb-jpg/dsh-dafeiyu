// 顶栏 + 导航 + 路由 + 轮询：不认识具体模块，只按注册表挂载。
import { MODULES } from './modules/index.mjs';
import * as api from './api.mjs';
import { esc, clockHM, toast } from './ui.mjs';

const state = { route: 'home', snap: null, instances: new Map(), busy: false };

const app = document.getElementById('app');
app.innerHTML = `
  <div class="topbar">
    <div class="brand"><span class="logo">🐟</span>大肥鱼 · 运行看板</div>
    <div class="chips" id="chips"></div>
  </div>
  <nav class="nav" id="nav">${MODULES.map((m) => `<button data-v="${m.id}"${m.id === 'home' ? ' class="on"' : ''}>${esc(m.title)}<span class="badge" data-badge="${m.id}" hidden></span></button>`).join('')}</nav>
  <main id="views"></main>
  <div class="modal" id="archModal" hidden>
    <div class="sheet">
      <h3>模块化架构 · 加模块只改两处</h3>
      <p>前端一个注册表，后端一个数据源；新增页面/数据源都不用碰 shell 和路由。</p>
      <pre>connect/board/
  shell.mjs        # 顶栏 + 导航 + 轮询 + 路由（不认识具体模块）
  index.mjs        # MODULES = [home, content, interact, growth, system]
  modules/
    home.mjs  content.mjs  interact.mjs  growth.mjs  system.mjs
  sections.mjs     # 分页数据源注册表（Map）
    sections/works.mjs comments.mjs hot.mjs timeline.mjs ...</pre>
      <ul>
        <li><b>加一个页面</b>：新建 <code>modules/粉丝.mjs</code>，在 <code>index.mjs</code> 的 MODULES 里加一行。</li>
        <li><b>加一个列表</b>：新建 <code>sections/snapshots.mjs</code>，在 <code>sections.mjs</code> 注册一行；<code>GET /api/board/list?section=snapshots</code> 立即可用。</li>
        <li><b>卡片规范</b>：标题+计数+右侧操作 / 行高 ≥52 / 两行文字 / tag 五色 / 统一分页。</li>
        <li>单文件 ≤400 行，超了拆子模块。</li>
      </ul>
      <button class="chip" id="archClose">知道了</button>
    </div>
  </div>
  <div class="modal" id="tokenModal" hidden>
    <div class="sheet">
      <h3>授权看板操作</h3>
      <label for="tokenInput">管理员令牌</label>
      <input id="tokenInput" type="password" autocomplete="off">
      <div class="f"><button class="chip" id="tokenCancel">取消</button><button class="chip" id="tokenSave">授权</button></div>
    </div>
  </div>`;

const views = document.getElementById('views');
for (const mod of MODULES) {
  const section = document.createElement('section');
  section.className = 'view' + (mod.id === 'home' ? ' on' : '');
  section.id = 'v-' + mod.id;
  views.append(section);
}

const ctx = {
  api,
  get snapshot() { return state.snap; },
  refresh: () => tick(true),
  navigate: (route) => go(route),
  toast,
};

function instanceOf(mod) {
  if (!state.instances.has(mod.id)) {
    const host = document.getElementById('v-' + mod.id);
    state.instances.set(mod.id, mod.mount(host, ctx));
  }
  return state.instances.get(mod.id);
}

function go(route, { replace = false } = {}) {
  const target = MODULES.some((m) => m.id === route) ? route : 'home';
  state.route = target;
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.v === target));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('on', v.id === 'v-' + target));
  if (replace) history.replaceState(null, '', '#/' + target); else history.replaceState(null, '', '#/' + target);
  const mod = MODULES.find((m) => m.id === target);
  const inst = instanceOf(mod);
  if (state.snap) inst.update(state.snap);
  if (inst.activate) inst.activate();
}

function renderChips() {
  const snap = state.snap || {};
  const status = snap.status || {};
  const qq = status.qq || {};
  const model = status.model || {};
  const academy = snap.academy || {};
  const chips = document.getElementById('chips');
  if (!chips) return;
  const online = qq.state === 'online';
  chips.innerHTML = `
    <span class="chip"><i class="dot" style="background:${online ? 'var(--ok)' : 'var(--bad)'}"></i>QQ ${esc(qq.state ?? 'unknown')}</span>
    <span class="chip">🧠 ${esc(model.model ?? 'model')}</span>
    <span class="chip">🎓 学院 ${academy.done ?? 0}/${academy.total ?? 12}</span>
    <span class="chip">⏱ 3 秒刷新 · ${esc(clockHM(snap.now))}</span>
    <button class="chip" id="tokenBtn">${api.boardAuthHeaders().authorization ? '🔓 操作已授权' : '🔒 授权操作'}</button>
    <button class="chip icon" id="archBtn" title="看架构">⌘</button>`;
  document.getElementById('archBtn')?.addEventListener('click', () => { document.getElementById('archModal').hidden = false; });
  document.getElementById('tokenBtn')?.addEventListener('click', () => { document.getElementById('tokenModal').hidden = false; document.getElementById('tokenInput').focus(); });
  for (const mod of MODULES) {
    const el = document.querySelector(`[data-badge="${mod.id}"]`);
    if (!el) continue;
    const n = mod.badge ? mod.badge(snap) : 0;
    el.hidden = !n;
    el.textContent = String(n ?? '');
  }
}

/**
 * 没有令牌时 /api/board 会 401，旧代码只在 console 里报错，
 * 页面就一直停在「加载中…」——看着就像看板断了。这里把它变成能看懂的一屏。
 */
function showAuthGate() {
  if (state.gateShown) return;
  state.gateShown = true;
  const views = document.getElementById('views');
  if (views) {
    views.innerHTML = `<div class="view on" style="padding:40px 8px">
      <div class="card" style="max-width:560px">
        <header><span class="t">看板需要授权令牌</span><span class="sp"><button class="chip" id="gateUnlock">输入令牌</button></span></header>
        <div class="row"><div class="body">
          <div class="l1">服务是通的（页面、样式、脚本都加载成功），只是数据接口要 Bearer 令牌。</div>
          <div class="l2">令牌在 runtime/connect/credentials.json 的 adminToken；也可以直接打开 /board?token=… 一次，浏览器会记住。</div>
        </div></div>
      </div>
    </div>`;
    document.getElementById('gateUnlock')?.addEventListener('click', () => {
      document.getElementById('tokenModal').hidden = false;
      document.getElementById('tokenInput').focus();
    });
  }
}

async function tick(fromAction = false) {
  if (state.busy) return;
  state.busy = true;
  try {
    state.snap = await api.snapshot();
    if (state.gateShown) { state.gateShown = false; location.reload(); return; }
    renderChips();
    const mod = MODULES.find((m) => m.id === state.route);
    if (mod) instanceOf(mod).update(state.snap);
  } catch (error) {
    console.error('board refresh failed', error);
    if (/^401/u.test(String(error.message))) { showAuthGate(); return; }
    if (fromAction) toast('刷新失败：' + error.message);
  } finally {
    state.busy = false;
  }
}

document.getElementById('nav').addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-v]');
  if (btn) go(btn.dataset.v);
});
document.getElementById('archClose').addEventListener('click', () => { document.getElementById('archModal').hidden = true; });
document.getElementById('archModal').addEventListener('click', (event) => {
  if (event.target.id === 'archModal') document.getElementById('archModal').hidden = true;
});
document.getElementById('tokenCancel').addEventListener('click', () => { document.getElementById('tokenModal').hidden = true; });
document.getElementById('tokenSave').addEventListener('click', async () => {
  const input = document.getElementById('tokenInput');
  const authorized = await api.authorizeBoard(input.value).catch(() => false);
  input.value = '';
  if (!authorized) { toast('令牌不正确'); return; }
  document.getElementById('tokenModal').hidden = true;
  toast('操作已授权');
  renderChips();
  tick(true);
});

window.addEventListener('hashchange', () => {
  const r = (location.hash || '').replace(/^#\/?/, '') || 'home';
  if (r !== state.route) go(r);
});

const initial = (location.hash || '').replace(/^#\/?/, '') || 'home';
go(initial);
renderChips();
tick();
setInterval(() => tick(), 3000);
