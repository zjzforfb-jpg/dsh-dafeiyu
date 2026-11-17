import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nextSteps, isExpectedReason } from '../connect/live/next-steps.mjs';

const item = (action, extra = {}) => ({ action, levelLabel: 'AI 介入', ...extra });

test('排序：失败 → 可疑未确认 → 待放行 → 最高频问题 → 已下线', () => {
  const steps = nextSteps({
    coverage: { confirmed: 6, total: 15 },
    items: [
      item('a.failed', { lastVerdict: 'failed', lastVerdictReason: 'Command failed: boom' }),
      item('b.doubtful', { lastVerdict: 'unconfirmed', lastVerdictReason: 'missing_count' }),
      item('c.untested'),
      item('d.expected', { lastVerdict: 'unconfirmed', lastVerdictReason: 'nothing_to_do(3):no_content×3' }),
    ],
    // ops 用真实 summarizeFailures() 的形状：对象而不是数组（这个形状差异曾经把页面打白）
    failures: { buckets: [{ id: 'ui_missing', key: 'ui_missing', label: '界面没开到位', count: 3, ops: { 'a.failed': 3 } }] },
    retired: [{ label: '看热点', reason: '搜索页改版' }],
  });
  assert.deepEqual(steps.map((step) => step.kind), ['fail', 'unconfirmed', 'untested', 'pattern', 'retired']);
  // 「没活干」是正常现象，不该被列成待办
  assert.ok(!steps.some((step) => step.detail?.includes('d.expected')));

  // 「早期记录没写原因」「只读工具当动作跑」都是历史噪音，不该占「最高频问题」这一格
  const noisy = nextSteps({
    coverage: { confirmed: 1, total: 3 },
    items: [item('x.untested')],
    failures: { buckets: [
      { id: 'no_reason', label: '早期记录没写原因', count: 9, ops: { a: 9 } },
      { id: 'unknown_action', label: '走错通道', count: 8, ops: { b: 8 } },
      { id: 'count_short', label: '做了但数量不够', count: 2, ops: { 'douyin.reply_comments': 2 } },
    ] },
  });
  const pattern = noisy.find((step) => step.kind === 'pattern');
  assert.match(pattern.title, /做了但数量不够/u, `应跳过历史噪音，实际：${pattern.title}`);
});

test('「没活干 / 等外部事件 / 被闸门挡住」算正常，别当成待修', () => {
  for (const reason of ['', 'ok', 'ok_text', 'nothing_to_do', 'nothing_to_do(5):no_content×5', 'awaiting_external_event', 'blocked:这一小时已发 5 条']) {
    assert.equal(isExpectedReason(reason), true, `${reason} 应算正常`);
  }
  for (const reason of ['missing_count', 'count=0<1', 'Command failed', 'no_result_data']) {
    assert.equal(isExpectedReason(reason), false, `${reason} 应算可疑`);
  }
});

test('ops 是对象（动作→次数），别当成数组', async () => {
  const { summarizeFailures } = await import('../connect/live/failures.mjs');
  const real = summarizeFailures([
    { verdict: 'failed', reason: 'detail_not_opened:SearchResultActivity', created_ms: Date.now(), task_id: 't1' },
    { verdict: 'failed', reason: 'detail_not_opened:SearchResultActivity', created_ms: Date.now(), task_id: 't2' },
  ]);
  const steps = nextSteps({ coverage: { confirmed: 1, total: 2 }, items: [item('x.untested')], failures: real });
  const pattern = steps.find((step) => step.kind === 'pattern');
  assert.ok(pattern, '有失败时应该给出「最高频问题」');
  assert.match(pattern.detail, /×2/u, `细节里要带次数，实际：${pattern.detail}`);
  assert.doesNotThrow(() => JSON.stringify(steps));
});

test('只读工具不进口径；全绿时给一句「没有待办」', () => {
  const onlyRead = nextSteps({ coverage: { confirmed: 3, total: 3 }, items: [item('weather.get', { readOnly: true })] });
  assert.equal(onlyRead.length, 1);
  assert.equal(onlyRead[0].kind, 'done');
});

test('主页首屏也有一行「下一步」，且只读工具不算进「没跑过」', () => {
  const home = readFileSync(new URL('../connect/home/home.js', import.meta.url), 'utf8');
  assert.match(home, /import \{ nextSteps \} from '\/live\/next-steps\.mjs'/u, '主页要复用同一份排序');
  assert.match(home, /function paintNextLine\(/u);
  assert.match(home, /TOOL_ONLY_META\[tool\.key\]/u, '只读工具要排除，别算成没跑过');
  assert.match(home, /\/docs\/FIRST-RUN\.md/u, '待放行要能点开操作单');
  const html = readFileSync(new URL('../connect/home/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="nextLine"/u, '首屏要有一个位置放这一行');
});

test('报告页签真的把这张卡渲出来，且链接指向工具详情与操作单', () => {
  const js = readFileSync(new URL('../connect/live/live.js', import.meta.url), 'utf8');
  assert.match(js, /下一步该干什么/u);
  assert.match(js, /nextSteps\(/u);
  // 操作单链接在 next-steps.mjs 里（页面 import 它）
  const mod = readFileSync(new URL('../connect/live/next-steps.mjs', import.meta.url), 'utf8');
  assert.match(mod, /\/docs\/FIRST-RUN\.md/u, '待放行要能点开操作单');
  assert.match(mod, /tool=\$\{encodeURIComponent\(item\.action\)\}/u, '要能点进具体工具');
});
