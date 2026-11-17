import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { SIDE_EFFECT_ACTIONS } from '../connect/live/expect-after.mjs';

test('交接页能从真实数据生成，且把「卡在哪」写清楚', () => {
  const out = execFileSync(process.execPath, ['scripts/handover.mjs'], { encoding: 'utf8' });
  assert.match(out, /已写入 docs\/HANDOVER\.md/u);
  const doc = readFileSync(new URL('../docs/HANDOVER.md', import.meta.url), 'utf8');
  assert.match(doc, /交接：大肥鱼的工具跑到哪了/u);
  assert.match(doc, /已排除页面手动跑/u, '必须声明数字口径');
  assert.match(doc, /唯一的硬阻塞/u);
  for (const action of SIDE_EFFECT_ACTIONS) assert.ok(doc.includes(action), `交接页缺 ${action}`);
  assert.match(doc, /release:check/u);
  assert.match(doc, /已知的坑/u);
});
