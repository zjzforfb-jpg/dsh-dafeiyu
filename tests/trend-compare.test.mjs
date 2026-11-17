import assert from 'node:assert/strict';
import test from 'node:test';
import { compareWeeks, describeCompare, summarizeCompare } from '../connect/live/trend-compare.mjs';

const cell = (weeksAgo, ok, bad) => ({ weeksAgo, ok, bad });

test('比上周：变好 / 变差 / 持平 / 本周没跑 / 上周没跑', () => {
  assert.equal(compareWeeks([cell(1, 1, 3), cell(0, 3, 1)]).status, 'improved');
  assert.equal(compareWeeks([cell(1, 3, 1), cell(0, 1, 3)]).status, 'regressed');
  assert.equal(compareWeeks([cell(1, 1, 1), cell(0, 2, 2)]).status, 'flat');
  assert.equal(compareWeeks([cell(1, 2, 0), cell(0, 0, 0)]).status, 'idle');
  assert.equal(compareWeeks([cell(1, 0, 0), cell(0, 1, 0)]).status, 'new', '上周没数据但本周跑了');
  assert.equal(compareWeeks([]).status, 'new');
});

test('句子带数字，不评价对错', () => {
  assert.match(describeCompare(compareWeeks([cell(1, 1, 3), cell(0, 3, 1)])), /25% → 75%/u);
  assert.match(describeCompare(compareWeeks([cell(1, 2, 0), cell(0, 0, 0)])), /本周没跑/u);
  assert.match(describeCompare(compareWeeks([cell(1, 0, 0), cell(0, 1, 0)])), /上周没跑过/u);
});

test('汇总把「变差」排在前面，只读工具不参加', () => {
  const summary = summarizeCompare([
    { action: 'a.improved', trend: [cell(1, 1, 3), cell(0, 3, 1)] },
    { action: 'b.regressed', trend: [cell(1, 3, 1), cell(0, 1, 3)] },
    { action: 'c.readonly', readOnly: true, trend: [cell(1, 0, 0), cell(0, 1, 0)] },
    { action: 'd.idle', trend: [cell(1, 2, 0), cell(0, 0, 0)] },
  ]);
  assert.deepEqual(summary.rows.map((row) => row.action), ['b.regressed', 'a.improved', 'd.idle']);
  assert.equal(summary.counts.improved, 1);
  assert.equal(summary.counts.regressed, 1);
});
