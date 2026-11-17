// 内容：作品库三栏（列表 / 详情 / 该作品评论）+ 全部评论
import { esc, fmt, tag, commentRow, pagerHtml, setHtml, clockHM, dateShort, toast } from '../ui.mjs';

export const meta = { id: 'content', title: '内容', badge: (snap) => snap?.status?.unreplied ?? 0 };

const cover = (w) => (w?.image ? `<img src="/board/cover/${encodeURIComponent(w.image)}" alt="">` : `<div class="ph">🐟</div>`);

export function mount(host, ctx) {
  const state = { seg: 'works', workId: null, work: null, works: { page: 1, size: 6 }, comments: { page: 1, size: 8 }, all: { page: 1, size: 5, filter: '' } };
  host.innerHTML = '<div id="contentRoot"></div>';
  const root = host.querySelector('#contentRoot');

  async function loadWorks() {
    state.worksData = await ctx.api.list('works', { page: state.works.page, size: state.works.size });
    if (!state.workId && state.worksData.items?.length) state.workId = state.worksData.items[0].id;
    state.work = state.worksData.items?.find((w) => w.id === state.workId) ?? state.worksData.items?.[0] ?? null;
    if (state.work) state.workId = state.work.id;
  }
  async function loadWorkComments() {
    state.workComments = state.work
      ? await ctx.api.list('comments', { work: state.work.id, page: state.comments.page, size: state.comments.size })
      : { items: [], total: 0, pages: 1, page: 1, size: state.comments.size };
  }
  async function loadAll() {
    state.allData = await ctx.api.list('comments', { page: state.all.page, size: state.all.size, replied: state.all.filter });
  }
  async function refreshAll() {
    if (state.seg === 'works') { await loadWorks(); await loadWorkComments(); } else await loadAll();
    render(ctx.snapshot);
  }

  const dlg = document.createElement('div');
  dlg.className = 'modal';
  dlg.hidden = true;
  dlg.innerHTML = `<div class="sheet"><div class="h">写一条</div>
    <div class="b"><label>主题（留空我就自己挑一个）</label><input id="writeTheme" placeholder="比如：今天下雨，趴在窗边看水珠"></div>
    <div class="f"><button class="btn" id="writeCancel">取消</button><button class="btn primary" id="writeGo">生成草稿</button></div></div>`;
  document.body.appendChild(dlg);
  dlg.addEventListener('click', async (event) => {
    if (event.target === dlg) { dlg.hidden = true; return; }
    if (event.target.closest('#writeCancel')) { dlg.hidden = true; return; }
    const go = event.target.closest('#writeGo');
    if (!go) return;
    const old = go.textContent;
    go.disabled = true;
    go.textContent = '生成中…（约 40 秒）';
    try {
      const out = await ctx.api.writeDraft(dlg.querySelector('#writeTheme').value.trim());
      if (!out?.ok) throw new Error(out?.error ?? '生成失败');
      dlg.hidden = true;
      dlg.querySelector('#writeTheme').value = '';
      toast(`草稿进作品库了：${out.draft?.title ?? ''}`);
      state.workId = out.draft?.draftId ?? state.workId;
      state.works.page = 1;
      await loadWorks();
      await loadWorkComments();
      render(ctx.snapshot);
      ctx.refresh?.();
    } catch (error) {
      toast('生成失败：' + error.message);
    } finally {
      go.disabled = false;
      go.textContent = old;
    }
  });

  root.addEventListener('click', async (event) => {
    const seg = event.target.closest('[data-c]');
    if (seg) { state.seg = seg.dataset.c; await refreshAll(); return; }
    const filter = event.target.closest('[data-f]');
    if (filter) { state.all.filter = filter.dataset.f; state.all.page = 1; await refreshAll(); return; }
    const item = event.target.closest('[data-w]');
    if (item) {
      state.workId = item.dataset.w;
      state.work = (state.worksData?.items ?? []).find((w) => w.id === state.workId) ?? state.work;
      state.comments.page = 1;
      await loadWorkComments();
      render(ctx.snapshot);
      return;
    }
    const pager = event.target.closest('[data-pager]');
    if (pager) {
      const sec = pager.dataset.pager; const page = Number(pager.dataset.page);
      if (!page) return;
      if (sec === 'works') { state.works.page = page; await loadWorks(); await loadWorkComments(); }
      if (sec === 'workComments') { state.comments.page = page; await loadWorkComments(); }
      if (sec === 'comments') { state.all.page = page; await loadAll(); }
      render(ctx.snapshot); return;
    }
    if (event.target.closest('[data-write]')) { dlg.hidden = false; dlg.querySelector('#writeTheme').focus(); return; }
    const dset = event.target.closest('[data-dset]');
    if (dset) {
      const on = dset.dataset.on === '1';
      dset.dataset.on = on ? '0' : '1';
      dset.classList.toggle('ok', !on);
      dset.classList.toggle('dim', on);
      dset.textContent = dset.textContent.replace(/\s(开|关)$/u, on ? ' 关' : ' 开');
      return;
    }
    if (event.target.closest('[data-img-del]')) {
      const file = event.target.closest('[data-img-del]').dataset.imgDel;
      const w = state.work;
      if (!w) return;
      const out = await ctx.api.postJson('/api/board/draft/image/delete', { id: w.id, file });
      if (!out?.ok) return toast('删图失败：' + (out?.error ?? ''));
      await loadWorks(); render(ctx.snapshot); return;
    }
    if (event.target.closest('[data-save]')) {
      const saved = await saveDraft();
      if (saved) toast('保存好了');
      return;
    }
    if (event.target.closest('[data-publish]')) {
      const btn = event.target.closest('[data-publish]');
      const w = state.work;
      if (!w) return;
      const saved = await saveDraft();
      if (!saved) return;
      const old = btn.textContent;
      btn.disabled = true;
      btn.textContent = '发布中…';
      try {
        const out = await ctx.api.postJson('/api/board/draft/publish?id=' + encodeURIComponent(w.id), {});
        if (!out?.ok) throw new Error(out?.error ?? '发布失败');
        toast(`发出去了：${out.result?.workCode ?? ''} ${w.title ?? ''}`);
        await loadWorks(); render(ctx.snapshot); ctx.refresh?.();
      } catch (error) {
        toast('发布失败：' + error.message);
      } finally {
        btn.disabled = false;
        btn.textContent = old;
      }
      return;
    }
  });
  function draftValues() {
    const box = root.querySelector('[data-draft]');
    if (!box) return null;
    const val = (field) => box.querySelector(`[data-field="${field}"]`)?.value ?? '';
    const onState = (key) => box.querySelector(`[data-dset="${key}"]`)?.dataset.on === '1';
    return {
      id: box.dataset.draft,
      title: val('title').trim(),
      caption: val('caption').trim(),
      topics: val('topics').trim(),
      settings: { aiDeclared: onState('ai'), downloadOff: !onState('dl'), saveAlbumOff: !onState('album') },
    };
  }

  async function saveDraft() {
    const values = draftValues();
    if (!values) return false;
    try {
      const out = await ctx.api.postJson('/api/board/draft', values);
      if (!out?.ok) throw new Error(out?.error ?? '保存失败');
      await loadWorks();
      render(ctx.snapshot);
      return true;
    } catch (error) {
      toast('保存失败：' + error.message);
      return false;
    }
  }

  root.addEventListener('change', async (event) => {
    const add = event.target.closest('[data-img-add]');
    if (add && add.files?.[0]) {
      const w = state.work;
      if (!w) return;
      const file = add.files[0];
      try {
        const res = await fetch('/api/board/draft/image?id=' + encodeURIComponent(w.id), {
          method: 'POST',
          headers: { ...ctx.api.boardAuthHeaders(), 'content-type': file.type || 'image/png' },
          body: await file.arrayBuffer(),
        });
        const out = await res.json();
        if (!out?.ok) throw new Error(out?.error ?? '上传失败');
        await loadWorks();
        render(ctx.snapshot);
        toast('图加上了');
      } catch (error) {
        toast('上传失败：' + error.message);
      }
      return;
    }
    const size = event.target.closest('[data-size]');
    if (!size) return;
    const sec = size.dataset.size; const n = Number(size.value) || 8;
    if (sec === 'works') { state.works = { page: 1, size: n }; await loadWorks(); await loadWorkComments(); }
    if (sec === 'workComments') { state.comments = { page: 1, size: n }; await loadWorkComments(); }
    if (sec === 'comments') { state.all = { ...state.all, page: 1, size: n }; await loadAll(); }
    render(ctx.snapshot);
  });

  function workItem(w) {
    const on = w.id === state.workId ? ' on' : '';
    const draft = w.status === 'draft';
    const stats = draft
      ? '待发布'
      : [w.views != null ? `播放 ${fmt(w.views)}` : '', w.likes != null ? `赞 ${fmt(w.likes)}` : '', `评论 ${w.comments_count ?? 0}/${w.replied_count ?? 0}`].filter(Boolean).join(' · ');
    return `<div class="witem${on}" data-w="${esc(w.id)}">${cover(w)}<div><div class="t">${esc(w.title)}</div><div class="m">${esc(w.code ?? (draft ? '待发布' : ''))} · ${esc(dateShort(w.published_at ?? w.created_at))}<br>${esc(stats)}</div></div></div>`;
  }

  function draftHtml(w) {
    const images = Array.isArray(w.images) && w.images.length ? w.images : (w.image ? [w.image] : []);
    const settings = w.settings ?? { aiDeclared: true, downloadOff: true, saveAlbumOff: true };
    const pill = (key, label, on) => `<button class="pill set${on ? ' ok' : ' dim'}" data-dset="${key}" data-on="${on ? '1' : '0'}">${label} ${on ? '开' : '关'}</button>`;
    return `
      <header><span class="t">作品详情</span><span class="sp">${tag('wait', '待发布')}</span></header>
      <div class="scroll" data-draft="${esc(w.id)}">
        <div class="thumbs">
          ${images.map((f) => `<div class="thumb"><img src="/board/cover/${encodeURIComponent(f)}" alt=""><button class="x" data-img-del="${esc(f)}" title="删掉这张">✕</button></div>`).join('')}
          ${images.length ? '' : '<label class="thumb add" title="加一张图"><input type="file" accept="image/*" data-img-add hidden>＋</label>'}
        </div>
        <label class="fld"><span>标题</span><input data-field="title" maxlength="40" value="${esc(w.title ?? '')}"></label>
        <label class="fld"><span>正文</span><textarea data-field="caption" rows="4">${esc(w.caption ?? '')}</textarea></label>
        <label class="fld"><span>话题（空格分隔）</span><input data-field="topics" value="${esc(w.topics ?? '')}"></label>
        <div class="pills">
          ${pill('ai', 'AI 生成', settings.aiDeclared !== false)}
          ${pill('dl', '允许下载', settings.downloadOff === false)}
          ${pill('album', '保存至相册', settings.saveAlbumOff === false)}
        </div>
        <div class="acts"><button class="btn primary" data-save>保存</button><button class="btn" data-publish>发布到抖音</button></div>
        <div class="hint">保存只改内容和设置；点「发布到抖音」我才会去手机上上传图片、填文案、改设置、发布。<br>现在一篇只发一张图（多图发布还没做通）：想换图先点图上的 ✕ 删掉，再点 ＋ 传新的。</div>
      </div>`;
  }

  function detailHtml(w) {
    if (!w) return '<div class="empty">还没有作品。</div>';
    if (w.status === 'draft') return draftHtml(w);
    const settings = w.settings ?? {};
    const topics = String(w.topics ?? '').split(/\s+/).filter(Boolean);
    return `
      <header><span class="t">作品详情</span><span class="sp">${w.status === 'draft' ? tag('wait', '待发布') : tag(w.status === 'archived' ? '' : 'ok', w.status === 'archived' ? '存档' : '已发布')}</span></header>
      <div class="scroll">
        <div class="cover">${w.image ? `<img src="/board/cover/${encodeURIComponent(w.image)}" alt="">` : '<span class="face">🐟</span>'}</div>
        <div class="h1">${esc(w.title)}</div>
        <div class="pills"><span class="pill dim">${esc(w.code ?? '—')}</span>${w.theme ? `<span class="pill dim">主题：${esc(w.theme)}</span>` : ''}<span class="pill dim">${esc(dateShort(w.published_at ?? w.created_at))}</span>
          ${w.status === 'draft' ? '' : `<span class="pill">播放 ${fmt(w.views ?? 0)}</span><span class="pill">赞 ${fmt(w.likes ?? 0)}</span><span class="pill">收藏 ${fmt(w.favorites ?? 0)}</span><span class="pill">转发 ${fmt(w.shares ?? 0)}</span>`}</div>
        <div class="pills">${topics.map((t) => `<span class="pill">${esc(t)}</span>`).join('')}</div>
        <div class="pills">${w.status === 'draft'
          ? '<span class="pill dim">AI 生成 · 待设置</span><span class="pill dim">允许下载 · 待设置</span><span class="pill dim">保存至相册 · 待设置</span>'
          : `<span class="pill ok">AI 生成 ${settings.aiDeclared ? '已开' : '未开'}</span><span class="pill ok">允许下载 ${settings.downloadOff === false ? '已开' : '已关'}</span><span class="pill ok">保存至相册 ${settings.saveAlbumOff === false ? '已开' : '已关'}</span>`}</div>
        <div class="body-text">${esc(w.caption ?? '')}</div>
      </div>`;
  }

  function render(snap) {
    if (!snap) return;
    const works = state.worksData ?? { items: [], total: 0, pages: 1, page: 1, size: state.works.size };
    const wc = state.workComments ?? { items: [], total: 0, pages: 1, page: 1, size: state.comments.size };
    const all = state.allData ?? { items: [], total: 0, pages: 1, page: 1, size: state.all.size };
    const status = snap.status ?? {};
    const repliedCount = (wc.items ?? []).filter((c) => c.replied_at).length;

    const worksView = `
      <div class="works">
        <section class="card">
          <header><span class="t">作品列表</span><span class="n">${works.total ?? 0}</span></header>
          <div class="scroll" id="workList">${(works.items ?? []).map(workItem).join('') || '<div class="empty">还没有作品。</div>'}</div>
          ${pagerHtml('works', works, { sizes: [6, 12, 24] })}
        </section>
        <section class="card" id="workDetail">${detailHtml(state.work)}</section>
        <section class="card">
          <header><span class="t">评论</span><span class="n">${wc.total ?? 0}</span><span class="sp">${tag('', `已回 ${repliedCount}`)}</span></header>
          <div class="scroll" id="workComments">${(wc.items ?? []).map((c) => commentRow(c, { showWork: false })).join('') || '<div class="empty">这个作品还没有评论。</div>'}</div>
          ${pagerHtml('workComments', wc, { sizes: [8, 16] })}
        </section>
      </div>`;

    const allView = `
      <div class="card">
        <header><span class="t">全部评论</span><span class="n">${all.total ?? 0}</span><span class="sp"><span class="seg">${[
          ['', '全部'], ['no', '未回复'], ['yes', '已回复'],
        ].map(([f, label]) => `<button class="${state.all.filter === f ? 'on' : ''}" data-f="${f}">${label}</button>`).join('')}</span></span></header>
        <div class="list">${(all.items ?? []).map((c) => commentRow(c)).join('') || '<div class="empty">没有符合条件的评论。</div>'}</div>
        ${pagerHtml('comments', all, { sizes: [5, 10, 20] })}
      </div>`;

    setHtml(root, `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
        <div class="seg">${[['works', '作品库'], ['comments', '全部评论']].map(([k, label]) => `<button class="${state.seg === k ? 'on' : ''}" data-c="${k}">${label}</button>`).join('')}</div>
        <span style="font-size:12px;color:var(--on-var)">${status.works ?? 0} 个作品 · ${status.comments ?? 0} 条评论 · 未回复 ${status.unreplied ?? 0}</span>
        <button class="chip" style="margin-left:auto" data-write>＋ 写一条</button>
      </div>
      <div id="contentWorks" style="display:${state.seg === 'works' ? 'block' : 'none'}">${worksView}</div>
      <div id="contentComments" style="display:${state.seg === 'comments' ? 'block' : 'none'}">${allView}</div>`);
  }

  refreshAll().catch((error) => console.error(error));
  return {
    update: (snap) => render(snap),
    activate: () => refreshAll(),
  };
}
