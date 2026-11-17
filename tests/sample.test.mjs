import assert from 'node:assert/strict';
import test from 'node:test';
import { sampleNote, THIN_SAMPLE } from '../connect/live/sample.mjs';

test('样本少于 3 次要标「样本少」，0 次要直说没跑过', () => {
  assert.equal(sampleNote(0).thin, true);
  assert.match(sampleNote(0).tip, /还没按「真实业务」跑过/u);
  assert.equal(sampleNote(1).label, '样本 1 次');
  assert.equal(sampleNote(THIN_SAMPLE - 1).thin, true);
  assert.equal(sampleNote(THIN_SAMPLE).thin, false);
  assert.equal(sampleNote(200).thin, false);
  assert.match(sampleNote(1).tip, /至少再跑 2 次/u);
});

test('runbook 进度表要带「本周真实次数」，并标出样本少的', async () => {
  const { readFileSync } = await import('node:fs');
  const doc = readFileSync(new URL('../docs/TOOL-RUNBOOK.md', import.meta.url), 'utf8');
  assert.match(doc, /\| 动作 \| 最近判定 \| 理由 \| 本周真实次数 \| 时间 \|/u);
  const script = readFileSync(new URL('../scripts/runbook-progress.mjs', import.meta.url), 'utf8');
  assert.match(script, /item\.weekRuns/u, '次数必须取真实业务口径（weekRuns 来自 toolList）');
  assert.match(script, /（少）/u, '样本少的要标出来');
});
