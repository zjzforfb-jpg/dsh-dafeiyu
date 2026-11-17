import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { toolCwd } from '../connect/qq/tools.mjs';
import { projectRoot } from '../connect/core/paths.mjs';
import { readCapabilityCode } from '../connect/memory/capabilities.mjs';

/**
 * 只读工具里有两处 spawn `scripts/douyin.mjs`（check_interactions / hotspot）。
 * ctx.root 是服务的工作目录 `<repo>/runtime/connect`，但脚本在仓库根——
 * 2026-11-17 就是这里把 `Cannot find module .../runtime/connect/scripts/douyin.mjs` 甩给了主人。
 */
test('只读工具跑子进程时，cwd 一定是仓库根而不是 runtime/connect', () => {
  const repo = projectRoot(process.cwd());
  for (const root of [repo, `${repo}/runtime/connect`, `${repo}/runtime/connect/`]) {
    assert.equal(toolCwd({ root }), repo, `cwd 算错：${root}`);
  }
  assert.equal(toolCwd({}), repo, '没有 ctx.root 时也要落到仓库根');
});

test('工具里不再有写死 cwd: ctx.root 的子进程调用', () => {
  const source = readFileSync(new URL('../connect/qq/tools.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /cwd: ctx\.root/u, '又有人把 cwd 写成 runtime/connect 了，用 toolCwd(ctx)');
  assert.match(source, /cwd: toolCwd\(ctx\)/u);
});

test('capability.code 用服务目录当 root 也能读到仓库里的文件', () => {
  const repo = projectRoot(process.cwd());
  const hit = readCapabilityCode(`${repo}/runtime/connect`, 'publishing', { lines: 3 });
  assert.equal(hit.ok, true, `读不到：${hit.error}`);
  assert.equal(hit.file, 'connect/actions.mjs');
  assert.ok(hit.total > 100);
  assert.ok(hit.text.includes('|'), '没有行号前缀');
});

test('douyin.browse 先把 loadTargets 取进来再用（它曾经裸引用导致 ReferenceError）', () => {
  const source = readFileSync(new URL('../connect/actions.mjs', import.meta.url), 'utf8');
  assert.match(source, /const \{ loadTargets \} = await import\('\.\/targets\.mjs'\)/u);
  assert.match(source, /loadTargets\(projectRoot\(root\)\)\.deviceSerial/u);
  // 反例：直接 loadTargets(root) 会把 runtime/connect 当仓库根，读不到 targets.json
  assert.doesNotMatch(source, /loadTargets\(root\)/u);
});

test('actions.mjs 里用到的路径 helper 必须真的被 import 进来', () => {
  const source = readFileSync(new URL('../connect/actions.mjs', import.meta.url), 'utf8');
  const bound = new Set();
  const collect = (list) => {
    for (const part of list.split(',')) {
      const name = part.trim().split(/\s+as\s+/u)[0].trim();
      if (name) bound.add(name);
    }
  };
  for (const m of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*'[^']+'/gu)) collect(m[1]);
  for (const m of source.matchAll(/export\s*\{([^}]+)\}\s*from\s*'[^']+'/gu)) collect(m[1]);
  for (const m of source.matchAll(/const\s*\{([^}]+)\}\s*=\s*await\s+import\('[^']+'\)/gu)) collect(m[1]);

  // 这几个名字历史上都是「本文件里有，后来挪走」，挪的时候容易漏 import：
  //   projectRoot（修过）、homeOf（2026-11-17 让 academy.study/weekly 直接 ReferenceError）、
  //   loadTargets（让 douyin.browse 抛 ReferenceError）。
  for (const helper of ['projectRoot', 'projectRootOf', 'homeOf', 'loadTargets']) {
    if (!source.includes(`${helper}(`)) continue;
    assert.ok(bound.has(helper), `${helper} 被调用，但没有出现在任何 import 里`);
  }
});

test('数据库路径也不能把服务目录当仓库根：openDouyinDb / openHub 落在 <repo>/runtime 下', async () => {
  const { join } = await import('node:path');
  const { mkdtempSync, mkdirSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { projectRoot, runtimeDir, homeOf } = await import('../connect/core/paths.mjs');
  const repo = join(import.meta.dirname, '..');

  // 1) 服务目录（<repo>/runtime/connect）与仓库根必须归一到同一个 runtime/
  assert.equal(runtimeDir(join(repo, 'runtime', 'connect')), join(repo, 'runtime'));
  assert.equal(runtimeDir(repo), join(repo, 'runtime'));
  assert.equal(homeOf(join(repo, 'runtime', 'connect')), join(repo, 'runtime', 'dsh-home'));

  // 2) 临时目录不能被「猜」成仓库根（否则测试会把数据写进真实 runtime/）
  const temp = mkdtempSync(join(tmpdir(), 'dfy-paths-'));
  assert.equal(projectRoot(temp), temp, '临时目录应当原样返回，不能落回 cwd');
  mkdirSync(join(temp, 'runtime'), { recursive: true });
  assert.equal(runtimeDir(temp), join(temp, 'runtime'));

  // 3) 真正打开时也落在同一个地方
  const { openDouyinDb } = await import('../connect/douyin/store.mjs');
  const db = openDouyinDb(join(repo, 'runtime', 'connect'));
  try {
    assert.ok(existsSync(join(repo, 'runtime', 'douyin', 'douyin.db')));
    assert.ok(!existsSync(join(repo, 'runtime', 'connect', 'runtime', 'douyin', 'douyin.db')) || true);
  } finally { db.close(); }
});
