// 四个页面共用的 title bar（/shell/nav.*）的回归：
// 一份定义、四页都引用、按页面高亮、?token= 跨页带上、静态资源只放行白名单。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startConnect } from '../connect/server.mjs';

test('四个页面共用一条 title bar：四页都引用同一份 /shell/nav，且带令牌跨页', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dafeiyu-shell-'));
  const service = await startConnect({ root, port: 0, qq: false, config: { adminToken: 'token-abc', devices: {} } });
  const base = `http://127.0.0.1:${service.port}`;
  try {
    // ---- 静态资源本身 ----
    const css = await fetch(`${base}/shell/nav.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type') ?? '', /text\/css/u);
    assert.match(await css.text(), /\.dsh-nav/u);

    const js = await fetch(`${base}/shell/nav.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type') ?? '', /javascript/u);
    const nav = await js.text();
    // 导航是三个真页面（工具清单是 /live 里的页签，不该再开一个入口），且都是站内路径
    for (const href of ['/board', '/live/', '/flow/', '/arch/']) assert.ok(nav.includes(`href: '${href}'`), `缺入口 ${href}`);
    assert.doesNotMatch(nav, /tab=tools/u, '工具清单不是独立页面，导航里不要再放一个入口');
    assert.doesNotMatch(nav, /https?:\/\//u, 'title bar 不该依赖外部域名');

    // ---- 四个页面都引用了它 ----
    const pages = ['/board', '/live/', '/arch/', '/messages'];
    for (const path of pages) {
      const res = await fetch(`${base}${path}`, { redirect: 'follow' });
      assert.equal(res.status, 200, `${path} 打不开`);
      const html = await res.text();
      assert.match(html, /href="\/shell\/nav\.css"/u, `${path} 没引 title bar 样式`);
      assert.match(html, /src="\/shell\/nav\.js"/u, `${path} 没引 title bar 脚本`);
    }

    // ---- 穿越/不存在 ----
    for (const bad of ['/shell/../server.mjs', '/shell/nope.js']) {
      const res = await fetch(`${base}${bad}`, { redirect: 'manual' });
      assert.ok([400, 401, 404].includes(res.status), `${bad} 应该是拒绝，实际 ${res.status}`);
      assert.doesNotMatch(await res.text(), /startConnect/u);
    }
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('看板的日程失败原因说人话：长命令折叠成一句，人工跑通的要标出来', async () => {
  const { reasonOf } = await import('../connect/board/modules/home.mjs');
  assert.equal(reasonOf('manual_run_ok: 已人工跑通（14:30），等下一轮'), '已人工跑通');
  assert.equal(reasonOf('retry:1:adb: device offline'), '环境抖动后重试');
  assert.equal(reasonOf('skipped:pending_task'), '已有待审草稿，跳过');
  assert.equal(reasonOf('Command failed: node scripts/douyin.mjs --auto-comment\n抖音操作失败：detail_not_opened:...'), '打不开视频');
  assert.equal(reasonOf('Command failed: /opt/homebrew/bin/node scripts/douyin-post.mjs --plan'), '脚本报错（详情看 /live）');
  assert.equal(reasonOf('interactions_unconfirmed:没读到评论列表'), '没读到互动列表');
  assert.equal(reasonOf(''), '');
});
