import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { RELEASE_PLAN, nextReleaseStep, validateReleasePlan } from '../connect/live/release-plan.mjs';
import { SIDE_EFFECT_ACTIONS } from '../connect/live/expect-after.mjs';

test('放行顺序自洽：7 个副作用动作都在、order 连续、每步都有为什么与停的条件', () => {
  assert.deepEqual(validateReleasePlan(SIDE_EFFECT_ACTIONS), []);
  assert.equal(RELEASE_PLAN.length, SIDE_EFFECT_ACTIONS.length);
  const first = RELEASE_PLAN[0].action;
  assert.equal(first, 'qq.call', '第一件事应该是「先打一通电话」验声卡与窗口识别');
  const last = RELEASE_PLAN.at(-1).action;
  assert.equal(last, 'douyin.publish', '最不可控的生成式发布放最后');
});

test('下一步会跳过已确认的动作', () => {
  const none = nextReleaseStep([]);
  assert.equal(none.next.action, 'qq.call');
  assert.equal(none.remaining.length, RELEASE_PLAN.length);

  const some = nextReleaseStep([{ action: 'qq.call', lastVerdict: 'confirmed' }, { action: 'qq.hangup', lastVerdict: 'failed' }]);
  assert.deepEqual(some.done, ['qq.call']);
  assert.equal(some.next.action, 'qq.hangup', '失败过的动作还在待办里');
});

test('docs/RELEASE-DAY.md 的顺序与代码一致', async () => {
  const doc = readFileSync(new URL('../docs/RELEASE-DAY.md', import.meta.url), 'utf8');
  let cursor = -1;
  for (const step of RELEASE_PLAN) {
    const at = doc.indexOf(step.title);
    assert.ok(at > cursor, `${step.order}. ${step.title} 在文档里缺失或顺序不对`);
    cursor = at;
  }
});
