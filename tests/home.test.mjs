import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { PIPELINES, STACK, validateData } from '../connect/home/data.mjs';
import { startConnect } from '../connect/server.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(import.meta.dirname, '..');

test('主页数据自洽：九段流水线都写了职责与代码位置，引用的文件真实存在', () => {
  assert.deepEqual(validateData(), []);
  assert.equal(PIPELINES.length, 9);
  assert.deepEqual(
    PIPELINES.map((line) => line.id),
    ['entry', 'observe', 'route', 'task', 'gate', 'act', 'verify', 'memory', 'call'],
  );
  // 技术栈四组：运行时 / 渠道 / 服务 / 数据
  assert.equal(STACK.length, 4);

  // 文件路径不许是编的：repo 里必须有这个文件
  const missing = [];
  for (const line of PIPELINES) {
    for (const file of line.files) if (!existsSync(join(ROOT, file))) missing.push(`${line.id}:${file}`);
  }
  for (const group of STACK) {
    for (const item of group.items) {
      for (const path of item.paths) {
        // 运行期数据可能还没生成，只要它在 runtime/ 下就算通过
        if (path.startsWith('runtime/')) continue;
        if (!existsSync(join(ROOT, path))) missing.push(`${item.name}:${path}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test('主页的能力清单覆盖 15 个动作 + 5 个只读工具，且每项都有等级与介绍', async () => {
  const { LEVELS, TOOL_META, TOOL_ONLY_META } = await import('../connect/live/tool-meta.mjs');
  const all = [...Object.values(TOOL_META), ...Object.values(TOOL_ONLY_META)];
  // 18 → 16：douyin.like_comments / douyin.prepare 已于 2026-11-18 下线（从动作表与说明书里一起移除）
  assert.equal(Object.keys(TOOL_META).length, 15);
  assert.equal(Object.keys(TOOL_ONLY_META).length, 5);
  for (const tool of all) {
    assert.ok(LEVELS[tool.level], `未知等级：${tool.level}`);
    assert.ok(tool.title && tool.intro && tool.logic, `说明书不全：${tool.title}`);
  }
});

test('主页能打开：/home 跳 /home/，页面带导航与技术栈，静态资源只放行白名单', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dafeiyu-home-'));
  const service = await startConnect({ root, port: 0, qq: false, config: { adminToken: 'token-home', devices: {} } });
  const base = `http://127.0.0.1:${service.port}`;
  try {
    // 302：/home 没尾斜杠时相对路径会解析到站点根，必须跳到 /home/
    const redirect = await fetch(`${base}/home`, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), '/home/');

    const page = await fetch(`${base}/home/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/u);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    const html = await page.text();
    assert.match(html, /大肥鱼 · 主页/u);
    assert.match(html, /\/shell\/nav\.css/u);
    assert.match(html, /\/home\/home\.js/u);
    // Web 标准：跳过导航链接 + 语义化 landmark + 唯一 h1
    assert.match(html, /class="skip" href="#main"/u);
    assert.match(html, /<main id="main">/u);
    assert.match(html, /<header class="hero">/u);
    assert.match(html, /<footer class="foot">/u);
    assert.equal((html.match(/<h1[\s>]/gu) ?? []).length, 1);
    // 三段主内容：技术栈 / 会做什么 / 流水线
    for (const id of ['stack', 'tools', 'pipeline']) assert.match(html, new RegExp(`id="${id}"`, 'u'), id);
    assert.match(html, /<div class="groups" id="toolGrid">/u);
    // 能力细节必须默认收起：首屏只露标题
    assert.match(html, /它能做什么/u);
    assert.match(html, /id="toolFilters"[^>]*role="group"/u);
    // 流水线被弱化：细节在 <details> 里，由 js 渲染
    assert.match(html, /id="flowDetail"/u);
    // 角色贴图：有图、有替代文字、有说明
    assert.match(html, /<img src="\/home\/pet\.png"[^>]*alt="[^"]+"[^>]*>/u);
    assert.match(html, /<figure class="portrait">/u);

    // 主页的能力清单直接复用 /live 的说明书模块，不必再抄一份
    const meta = await fetch(`${base}/live/tool-meta.mjs`);
    assert.equal(meta.status, 200);
    assert.match(meta.headers.get('content-type') ?? '', /javascript/u);

    for (const [path, type] of [
      ['/home/home.js', /javascript/u],
      ['/home/home.css', /text\/css/u],
      ['/home/data.mjs', /javascript/u],
      ['/home/pet.png', /image\/png/u],
    ]) {
      const asset = await fetch(`${base}${path}`);
      assert.equal(asset.status, 200, path);
      assert.match(asset.headers.get('content-type') ?? '', type, path);
    }

    // 目录穿越 / 不存在的文件：不许把 server.mjs 之类的东西吐出来
    for (const path of ['/home/%2e%2e/server.mjs', '/home/..%2fserver.mjs', '/home/nope.js']) {
      const bad = await fetch(`${base}${path}`);
      assert.ok([400, 401, 404].includes(bad.status), `${path} → ${bad.status}`);
      const body = await bad.text();
      assert.ok(!body.includes('startConnect'), `${path} 泄露了源码`);
    }
  } finally {
    await service.close?.();
    rmSync(root, { recursive: true, force: true });
  }
});

test('主页的模块图能真的在浏览器里加载：/core/pipeline.mjs 必须可访问，且不能被同名变量遮住', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { startConnect } = await import('../connect/server.mjs');

  const root = mkdtempSync(join(tmpdir(), 'home-modules-'));
  const app = await startConnect({ root, port: 0, qq: false, config: { adminToken: 'tok', devices: {} } });
  const base = `http://127.0.0.1:${app.port ?? app.server?.address?.().port}`;
  try {
    // data.mjs 里 import '../core/pipeline.mjs' → 浏览器会去要 /core/pipeline.mjs
    const pipeline = await fetch(`${base}/core/pipeline.mjs`);
    assert.equal(pipeline.status, 200, '/core/pipeline.mjs 必须能被页面取到，否则 /home 整页白');
    assert.match(pipeline.headers.get('content-type') ?? '', /javascript/u);
    assert.match(await pipeline.text(), /export const PIPELINE/u);

    // 只放这一个文件，不要把整个 core 目录暴露出去
    const leak = await fetch(`${base}/core/migrations.mjs`);
    assert.ok([400, 401, 404].includes(leak.status), `core 目录被整个暴露了：${leak.status}`);

    // 变量遮罩回归：capabilityNode 里的 <summary> 元素曾经盖住同名的汇总数据
    const home = await (await fetch(`${base}/home/home.js`)).text();
    assert.match(home, /flowSnapshot/u, '汇总数据要叫 flowSnapshot，别再叫 summary');
    assert.match(home, /flowSnapshot\??\.tools/u, '判定要用 flowSnapshot 取');
    // 反向断言：不许出现裸的 summary?.tools（那是被 <summary> 元素遮住的写法）
    assert.doesNotMatch(home, /[^.\w]summary\?\.tools/u, 'summary 被 <summary> 元素遮住了');
  } finally {
    await app.close?.();
  }
});
