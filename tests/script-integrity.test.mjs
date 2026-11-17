// 守一个很蠢但很贵的错误：脚本被编辑到语法坏了，或者整段被复制两遍（今天真的发生过一次）。
// 这类问题不会让单测变红（测试根本不 import 这些 CLI 脚本），但会让夜里所有定时任务一起崩。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = [
  'scripts/douyin.mjs',
  'scripts/douyin-post.mjs',
  'scripts/douyin-video.mjs',
  'scripts/qq-call.mjs',
  'scripts/wechat-call.mjs',
  'scripts/connect.mjs',
];

test('定时任务会调用到的 CLI 脚本都能通过 node --check', async () => {
  for (const script of SCRIPTS) {
    await run(process.execPath, ['--check', join(ROOT, script)]);
  }
});

test('CLI 脚本里不该出现整段复制（同一个分支/变量声明出现两次）', () => {
  const markers = [
    "if (has('auto-comment'))",
    "if (has('reply-inbox'))",
    "if (has('hot-videos') || has('hot-comment-round'))",
    "const match = option('reply-match')",
    'main().catch(',
  ];
  for (const script of SCRIPTS) {
    const text = readFileSync(join(ROOT, script), 'utf8');
    for (const marker of markers) {
      const count = text.split(marker).length - 1;
      assert.ok(count <= 1, `${script} 里出现了 ${count} 次「${marker}」，像是整段被复制了`);
    }
  }
});

test('抖音搜索前必须确认「真的在搜索结果页」，否则会点空', async () => {
  const { readFileSync } = await import('node:fs');
  const dev = readFileSync(new URL('../device/douyin.mjs', import.meta.url), 'utf8');
  assert.match(dev, /export async function onSearchResults/u, '要有「是否在搜索结果页」的判断');
  assert.match(dev, /SearchResultActivity/u);
  const cli = readFileSync(new URL('../scripts/douyin.mjs', import.meta.url), 'utf8');
  // auto-comment 分支里，搜索完必须校验一次；失败要走整页恢复
  const start = cli.indexOf("if (has('auto-comment'))");
  assert.ok(start > 0, '找不到 auto-comment 分支');
  const branch = cli.slice(start, start + 4000);
  assert.match(branch, /onSearchResults/u, 'auto-comment 没校验搜索结果页');
  assert.match(branch, /not_on_search/u);
  assert.match(branch, /resetDouyin/u, '校验不过要能整页恢复');
});

test('同一个视频不会重复评论：有「已回过的视频」记录与 --allow-repeat 开关', async () => {
  const { readFileSync } = await import('node:fs');
  const cli = readFileSync(new URL('../scripts/douyin.mjs', import.meta.url), 'utf8');
  assert.match(cli, /duplicate_video/u, '要有「这个视频已经回过」的结论');
  assert.match(cli, /recentVideos/u, '要把回过的视频记下来');
  assert.match(cli, /has\('allow-repeat'\)/u, '要留一个显式重发开关');
});
