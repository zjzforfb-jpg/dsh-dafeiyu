// 四个页面共用的 title bar（唯一的定义处）。
// 用法：<link rel="stylesheet" href="/shell/nav.css"><script src="/shell/nav.js" defer></script>
// 约定：脚本自己插 DOM、自己按 pathname 高亮，页面无需再管导航。
// 令牌：地址栏里的 ?token= 会被搬到每个链接上，跨页不用重新授权。

const TABS = [
  { id: 'home', href: '/home/', label: '主页', icon: '⌂' },
  { id: 'board', href: '/board', label: '运行看板', icon: '▤' },
  // 「工具清单」不是独立页面，它是 /live 里的一个页签（底部三页签之一）：
  // 放进来会出现两个入口指向同一个页面，所以导航只留三个页面。
  { id: 'live', href: '/live/', label: '实时工作流', icon: '◉' },
  { id: 'flow', href: '/flow/', label: '数据流', icon: '⇢' },
  { id: 'arch', href: '/arch/', label: '3D 架构', icon: '✦' },
];

function pageOf(path) {
  if (path.startsWith('/home')) return 'home';
  if (path.startsWith('/board')) return 'board';
  if (path.startsWith('/arch')) return 'arch';
  if (path.startsWith('/live')) return 'live';
  if (path.startsWith('/messages')) return 'messages';
  if (path.startsWith('/call')) return 'call';
  return 'other';
}

function withToken(href, token) {
  if (!token) return href;
  return `${href}${href.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

function build() {
  if (document.querySelector('.dsh-nav')) return;
  if (new URLSearchParams(location.search).get('nonav') === '1') return;
  const params = new URLSearchParams(location.search);
  const token = params.get('token') ?? sessionStorage.getItem('dsh.boardToken') ?? '';
  if (params.get('token')) {
    try { sessionStorage.setItem('dsh.boardToken', params.get('token')); } catch { /* 隐私模式下没有 storage */ }
  }
  const path = location.pathname;
  const page = pageOf(path);
  document.documentElement.dataset.page = page;
  document.documentElement.classList.add('dsh-nav-on');

  const nav = document.createElement('nav');
  nav.className = 'dsh-nav';
  nav.setAttribute('aria-label', '大肥鱼 · 页面导航');

  const brand = document.createElement('a');
  brand.className = 'dsh-brand';
  brand.href = withToken('/home/', token);
  brand.innerHTML = '<i>鱼</i><span>大肥鱼</span>';
  nav.append(brand);

  for (const tab of TABS) {
    const a = document.createElement('a');
    a.className = 'dsh-tab';
    a.href = withToken(tab.href, token);
    const on = path.startsWith(tab.href.replace(/\/$/u, ''));
    if (on) a.classList.add('on');
    a.dataset.tab = tab.id;
    const icon = document.createElement('span');
    icon.className = 'dsh-e';
    icon.textContent = tab.icon;
    const label = document.createElement('span');
    label.textContent = tab.label;
    a.append(icon, label);
    nav.append(a);
  }

  const right = document.createElement('div');
  right.className = 'dsh-right';
  const hint = document.createElement('span');
  hint.textContent = '8765 · 大肥鱼';
  right.append(hint);
  nav.append(right);

  document.body.prepend(nav);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build, { once: true });
else build();
