import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { SKILL_DEFS, classifyFailure } from '../connect/skills/defs.mjs';
import { ensureSkillDefs, withSkillRun, skillDbPath } from '../connect/skills/ledger.mjs';

function project() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ledger-'));
  mkdirSync(join(root, 'runtime', 'connect'), { recursive: true });
  return root;
}

test('10 个技能定义完整：id、步骤、后置条件都不缺', () => {
  assert.equal(SKILL_DEFS.length, 10);
  const ids = new Set(SKILL_DEFS.map((def) => def.skillId));
  assert.equal(ids.size, 10);
  for (const def of SKILL_DEFS) {
    assert.ok(def.name.length > 2, `${def.skillId} 缺名字`);
    assert.ok(def.steps.length >= 3, `${def.skillId} 步骤太少`);
    for (const step of def.steps) assert.ok(String(step.assert ?? '').length > 4, `${def.skillId}/${step.id} 缺后置条件`);
  }
});

test('失败分类能落到具体步骤', () => {
  assert.equal(classifyFailure('抖音操作失败：need_text'), 'generate');
  assert.equal(classifyFailure('comment_button_missing:nodes=12'), 'open_comments');
  assert.equal(classifyFailure('SearchResultActivity 没到'), 'search');
  assert.equal(classifyFailure('spawn node ENOENT'), 'spawn');
  assert.equal(classifyFailure('uia_dump_failed: SocketError'), 'device_io');
  assert.equal(classifyFailure('不知道什么错'), 'unknown');
});

test('ensureSkillDefs 幂等注册 10 个技能，状态 validating', () => {
  const root = project();
  const first = ensureSkillDefs(root);
  assert.deepEqual(first, { created: 10, total: 10 });
  assert.deepEqual(ensureSkillDefs(root), { created: 0, total: 10 });
  const db = new DatabaseSync(skillDbPath(root));
  const rows = db.prepare('SELECT status, COUNT(*) c FROM skill_registry GROUP BY status').all();
  db.close();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'validating');
  assert.equal(rows[0].c, 10);
});

test('withSkillRun 成功时记 verified，失败时记 failure_stage', async () => {
  const root = project();
  ensureSkillDefs(root);
  const ok = await withSkillRun(root, { action: 'douyin.check_interactions' }, async () => ({ text: '两条评论', data: { status: 'ok', verified: true } }));
  assert.equal(ok.text, '两条评论');
  await assert.rejects(
    () => withSkillRun(root, { action: 'douyin.check_interactions' }, async () => { throw new Error('抖音操作失败：comments_empty'); }),
    /comments_empty/u,
  );
  const db = new DatabaseSync(skillDbPath(root));
  const rows = db.prepare('SELECT status, success, verified, failure_stage FROM skill_runs ORDER BY started_at ASC').all();
  const proposals = db.prepare('SELECT pattern_key, occurrences FROM learning_proposals').all();
  db.close();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, 'succeeded');
  assert.equal(rows[0].verified, 1);
  assert.equal(rows[1].status, 'failed');
  assert.equal(rows[1].verified, 0);
  assert.equal(rows[1].failure_stage, 'read_comments');
  assert.equal(proposals[0].pattern_key, 'douyin.check_interactions:failure:read_comments');
  assert.equal(proposals[0].occurrences, 1);
});

test('没有对应技能的动作不写账本（保持普通动作）', async () => {
  const root = project();
  ensureSkillDefs(root);
  const outcome = await withSkillRun(root, { action: 'qq.call' }, async () => ({ text: '打电话' }));
  assert.equal(outcome.text, '打电话');
  const db = new DatabaseSync(skillDbPath(root));
  const row = db.prepare('SELECT COUNT(*) c FROM skill_runs').get();
  db.close();
  assert.equal(row.c, 0);
});

test('步骤事件按 run 记账，ok=0 的步骤也留着', async () => {
  const root = project();
  ensureSkillDefs(root);
  await withSkillRun(root, { action: 'douyin.check_interactions' }, async () => ({
    text: 'ok',
    data: { status: 'ok', verified: true, steps: [{ id: 'reset_app', ok: true, evidence: 'aweme' }, { id: 'read_rows', ok: false, evidence: 'count=0' }] },
  }));
  const db = new DatabaseSync(skillDbPath(root));
  const rows = db.prepare('SELECT step_id, ok, evidence FROM skill_step_events ORDER BY id').all();
  db.close();
  assert.deepEqual(rows.map((row) => [row.step_id, row.ok]), [['reset_app', 1], ['read_rows', 0]]);
  assert.equal(rows[1].evidence, 'count=0');
});

test('被弹窗挡住时失败指纹带上阻断类型', () => {
  assert.equal(classifyFailure('blocked_by_dialog:draft_resume:继续编辑作品'), 'blocked:draft_resume');
  assert.equal(classifyFailure('blocked_by_dialog:permission:允许访问相册权限'), 'blocked:permission');
});
