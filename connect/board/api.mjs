const queryToken = typeof location === 'undefined' ? '' : new URLSearchParams(location.search).get('token') ?? '';
if (queryToken && typeof sessionStorage !== 'undefined') {
  sessionStorage.setItem('dafeiyu_board_token', queryToken);
  history.replaceState(null, '', location.pathname + location.hash);
}
export const boardAuthHeaders = () => {
  const token = (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('dafeiyu_board_token') : '') || queryToken || '';
  return token ? { authorization: `Bearer ${token}` } : {};
};
export const authorizeBoard = async (token) => {
  const response = await fetch('/api/board/auth', { headers: { authorization: `Bearer ${String(token ?? '')}` } });
  if (!response.ok) return false;
  sessionStorage.setItem('dafeiyu_board_token', String(token));
  return true;
};

export const getJson = async (url) => { const res = await fetch(url, { headers: boardAuthHeaders() }); if (!res.ok) throw new Error(res.status + ' ' + url); return res.json(); };
export const snapshot = () => getJson('/api/board');
export const list = (section, params = {}) => {
  const q = new URLSearchParams({ section, ...Object.fromEntries(Object.entries(params).filter(([, v]) => v !== '' && v != null)) });
  return getJson('/api/board/list?' + q.toString());
};
export const resetAcademy = () => fetch('/api/academy/reset', { method: 'POST', headers: boardAuthHeaders() }).then((r) => r.json());

export const postJson = (url, payload) => fetch(url, {
  method: 'POST',
  headers: { ...boardAuthHeaders(), ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
  body: payload === undefined ? undefined : JSON.stringify(payload),
}).then((r) => r.json());
export const approveTask = (id) => postJson('/api/board/approve?id=' + encodeURIComponent(id));
export const cancelTask = (id) => postJson('/api/board/cancel?id=' + encodeURIComponent(id));
export const writeDraft = (theme) => fetch('/api/board/write', {
  method: 'POST',
  headers: { ...boardAuthHeaders(), 'content-type': 'application/json' },
  body: JSON.stringify({ theme: String(theme ?? '') }),
}).then((r) => r.json());

export const moodAction = (action) => postJson('/api/board/mood', { action });
export const activityDetail = (id) => getJson('/api/board/activity?id=' + encodeURIComponent(id));
export const skillRunDetail = (id) => getJson('/api/board/skill-run?id=' + encodeURIComponent(id));
