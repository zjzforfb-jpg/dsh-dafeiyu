import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reasonBucket } from '../connect/live/failures.mjs';

test('回填脚本只补能推断的，且把几百字的 Command failed 归一成 command_failed', () => {
  const script = readFileSync(new URL('../scripts/backfill-reasons.mjs', import.meta.url), 'utf8');
  assert.match(script, /WHERE reason IS NULL OR TRIM\(reason\) = ''/u, '老行是 NULL、新行是空串，两种都要扫');
  assert.match(script, /--dry/u, '要能演练');
  assert.match(script, /command_failed/u, '长命令要归一');
  assert.match(script, /evaluateOutcome/u, '要用同一条判定规则重算，不能自己编');
  assert.match(script, /保持空白/u, '推断不出来的要留着，不许编理由');
});

test('归一后的 command_failed 仍能被归类（不然页面显示「原因不明」）', () => {
  assert.equal(reasonBucket('command_failed')?.id, 'command_failed');
  assert.equal(reasonBucket('Command failed: /opt/homebrew/bin/node x.mjs')?.id, 'command_failed');
  assert.equal(reasonBucket('ok'), null, '成功不进组');
});
