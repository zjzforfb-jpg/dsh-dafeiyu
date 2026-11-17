// P3 学习闭环：重复失败 → 提案 → 升个小版本 + 写经验本 → 三连败自动回滚。
// 这里只做「改法」本身；审批入口在 QQ，账本/步骤事件由 ledger 负责。
//
// P1-C / C-3：阈值和审批不再写死「2 次 + 主人点头」，按技能背后的动作风险分层：
// R0/R2 攒够 2 次自动升版，R3 攒够 3 次且必须主人点头（见 learning-policy.mjs）。
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { registerSkill, setSkillStatus, skill, initSkills } from '../skills.mjs';
import { validateReflection } from '../reflection.mjs';
import { addLesson } from '../douyin/lessons.mjs';
import { policyForSkill, thresholdForSkill, describePolicy } from './learning-policy.mjs';

const decode = (value, fallback) => { try { const parsed = JSON.parse(value ?? ''); return parsed ?? fallback; } catch { return fallback; } };

export const shortId = (id) => String(id ?? '').slice(-4);

const STRATEGIES = {
  'blocked:draft_resume': { strategy: 'close_dialog_then_retry', text: '进发布页或看互动时如果弹「继续编辑作品」，先点「放弃/取消」关掉（千万别点继续编辑），再重新走那一步。' },
  'blocked:discard_confirm': { strategy: 'confirm_exit_then_retry', text: '退出编辑确认弹窗里点「确定/退出」，然后重新开始这一步。' },
  'blocked:network': { strategy: 'retry_after_wait', text: '碰到网络错误先等 2 秒，点一次「重试」；还不行动作要如实报失败，不能说看过了。' },
  'blocked:ad': { strategy: 'skip_ad_then_retry', text: '开屏/插屏广告先点「跳过/关闭」，再继续原来的步骤。' },
  'blocked:permission': { strategy: 'report_to_owner', text: '遇到权限弹窗不要自己点允许，直接把页面截下来问爸爸。' },
  'blocked:login': { strategy: 'report_to_owner', text: '登录态掉了不要自己点登录，先告诉爸爸。' },
  'blocked:upgrade': { strategy: 'report_to_owner', text: '遇到升级弹窗不要点升级，先告诉爸爸。' },
  read_comments: { strategy: 'wait_rows_then_retry', text: '评论面板打开后可能还没渲染完：回到顶部，最多重 dump 6 次，拿到行再判断有没有新评论。' },
  open_comments: { strategy: 'tap_comment_by_desc_then_retry', text: '找不到评论入口时按 desc「评论 N」找右侧按钮，坐标点 3 次；还不行退回详情重开。' },
  search: { strategy: 'back_to_feed_then_search', text: '抖音可能停在横屏视频流，先连按 BACK 回首页再点搜索。' },
  open_card: { strategy: 'redump_coordinates_then_tap', text: '搜索卡片坐标会变，每次点击前重新 dump 再点，别用旧坐标。' },
  device_io: { strategy: 'restart_uia_then_retry', text: 'uiautomator 服务断了：重新 adb forward 19008，等 1 秒再 dump。' },
  rate_limit: { strategy: 'wait_interval_then_retry', text: '评论太密了：睡 96 秒再重试同一条，别把它记成已回。' },
  timeout: { strategy: 'extend_timeout', text: '这一步超时了：把超时放宽到 1.5 倍再试一次。' },
  spawn: { strategy: 'check_path', text: '找不到 node/adb：检查 PATH（/opt/homebrew/bin 等）与 process.execPath。' },
  generate: { strategy: 'regenerate_with_budget', text: '文案生成失败就把 token 预算提到 2200 重试一次，别空着提交。' },
  photo_post: { strategy: 'skip_photo_post', text: '图文作品没有评论区入口，跳过换下一个。' },
};
const DEFAULT_STRATEGY = { strategy: 'report_to_owner', text: '这个失败还没见过：先如实报失败，把现场记下来。' };

export function strategyFor(stage) { return STRATEGIES[stage] ?? DEFAULT_STRATEGY; }

function initRollbackTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS skill_rollbacks(id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, from_version INTEGER NOT NULL, to_version INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT '', at TEXT NOT NULL DEFAULT (datetime('now')))`);
}

export function listRollbacks(db, limit = 6) {
  try { initRollbackTable(db); return db.prepare('SELECT * FROM skill_rollbacks ORDER BY at DESC LIMIT ?').all(Math.max(1, Math.min(50, limit))); } catch { return []; }
}

export function currentVersion(db, skillId) {
  initSkills(db);
  const row = db.prepare('SELECT current_version FROM skill_registry WHERE skill_id=?').get(skillId);
  return row ? Number(row.current_version) : 1;
}

export function pendingLearning(db, { limit = 6 } = {}) {
  initSkills(db);
  // 阈值按每个技能自己的风险档走（R0/R2 两次、R3 三次、未知两次但要审核），
  // 所以 SQL 先把候选全捞出来，再按技能逐条过滤——写死一个数字就是 R-06 的病根。
  const candidates = db.prepare("SELECT * FROM learning_proposals WHERE status IN ('candidate','validating') ORDER BY occurrences DESC, updated_at DESC").all();
  const reflections = candidates.filter((row) => Number(row.occurrences ?? 0) >= thresholdForSkill(row.skill_id)).slice(0, limit);
  const proposals = db.prepare("SELECT * FROM skill_proposals WHERE status='candidate' ORDER BY created_at DESC LIMIT ?").all(limit);
  return { reflections, proposals };
}

export function learningText(db) {
  const { reflections, proposals } = pendingLearning(db);
  if (!reflections.length && !proposals.length) return '现在没有攒够次数的失败，暂时没有要学的新东西。';
  const lines = [];
  const auto = reflections.filter((row) => policyForSkill(row.skill_id).autoApprove);
  const manual = reflections.filter((row) => !policyForSkill(row.skill_id).autoApprove);
  if (auto.length) lines.push('R0/R2 技能攒够两次的失败，我会自己升版本（你要催我也可以回「批准 R编号」）：');
  if (manual.length) lines.push('R3 技能攒够三次的失败（回「批准 R编号」我就升版本，回「驳回 R编号」跳过）：');
  for (const row of reflections) {
    // 两类失败分开说：技能失败有具体步骤，动作失败（定时任务这类）只有动作名和类别。
    if (row.kind === 'action_reflection') {
      const matched = /^action:failure:(.+):(.+)$/u.exec(String(row.pattern_key ?? ''));
      const operation = matched?.[1] ?? row.pattern_key ?? '未知动作';
      const category = matched?.[2] ?? 'unknown';
      lines.push(`R${shortId(row.id)} · ${operation} · 反复「${category === 'unknown' ? '原因不明' : category}」· ${row.occurrences} 次 · 改法：${strategyFor(category).text}`);
      continue;
    }
    const stage = String(row.pattern_key).split(':failure:')[1] ?? '未知';
    const policy = policyForSkill(row.skill_id);
    lines.push(`R${shortId(row.id)} · ${row.skill_id} · 卡在「${stage}」· ${row.occurrences} 次 · ${describePolicy(policy)} · 改法：${strategyFor(stage).text}`);
  }
  for (const row of proposals) lines.push(`R${shortId(row.id)} · ${row.skill_id} 已通过验证，等你点头升版本`);
  return lines.join('\n');
}

function resolveTarget(db, token) {
  const needle = String(token ?? '').replace(/^R/i, '').trim();
  if (!needle) return null;
  const reflection = db.prepare("SELECT * FROM learning_proposals WHERE id LIKE ? ORDER BY updated_at DESC LIMIT 1").get(`%${needle}`);
  if (reflection) return { table: 'reflection', row: reflection };
  const proposal = db.prepare("SELECT * FROM skill_proposals WHERE id LIKE ? ORDER BY created_at DESC LIMIT 1").get(`%${needle}`);
  if (proposal) return { table: 'proposal', row: proposal };
  return null;
}

export function proposeChange(db, reflectionId) {
  const row = db.prepare('SELECT * FROM learning_proposals WHERE id=?').get(reflectionId);
  if (!row) return null;
  const success = db.prepare("SELECT id FROM skill_runs WHERE skill_id=? AND version=? AND status='succeeded' AND success=1 AND verified=1 ORDER BY started_at DESC LIMIT 1").get(row.skill_id, row.version);
  if (!success) throw new Error('verified_successful_run_required');
  return validateReflection(db, reflectionId, { successfulRunId: success.id, minOccurrences: thresholdForSkill(row.skill_id) });
}

export function activateProposal(db, proposalId, { root, home, now = Date.now() } = {}) {
  const proposal = db.prepare('SELECT * FROM skill_proposals WHERE id=?').get(proposalId);
  if (!proposal) return null;
  const skillId = proposal.skill_id;
  const base = currentVersion(db, skillId);
  const prev = skill(db, skillId, base);
  if (!prev) throw new Error('skill_version_missing');
  const evidence = decode(proposal.evidence, {});
  const reflection = evidence.reflection_id ? db.prepare('SELECT * FROM learning_proposals WHERE id=?').get(evidence.reflection_id) : null;
  const stage = String(reflection?.pattern_key ?? '').split(':failure:')[1] ?? 'unknown';
  const plan = strategyFor(stage);
  const next = base + 1;
  registerSkill(db, {
    skillId,
    name: prev.name,
    description: prev.description,
    version: next,
    preconditions: decode(prev.preconditions, {}),
    steps: decode(prev.steps, []),
    postconditions: decode(prev.postconditions, {}),
    fallback: [...decode(prev.fallback, []), { stage, strategy: plan.strategy }],
    environment: decode(prev.environment, {}),
    confidence: Math.max(0.3, Number(prev.confidence ?? 0.5) - 0.1),
    status: 'validating',
  });
  setSkillStatus(db, skillId, next, 'enabled');
  db.prepare("UPDATE skill_proposals SET status='active' WHERE id=?").run(proposalId);
  if (reflection) db.prepare("UPDATE learning_proposals SET status='validated', updated_at=datetime('now') WHERE id=?").run(reflection.id);
  try { addLesson(join(home ?? join(root, 'runtime', 'dsh-home'), 'lessons.json'), { kind: 'skill', text: plan.text, tags: [skillId, stage], channels: ['qq', 'douyin'] }, now); } catch {}
  return { skillId, from: base, to: next, stage, strategy: plan.strategy, lesson: plan.text };
}

export function approveLearning(db, token, { root, home, now = Date.now() } = {}) {
  initSkills(db);
  const target = resolveTarget(db, token);
  if (!target) return { ok: false, error: 'not_found' };
  if (target.table === 'reflection') {
    const row = target.row;
    if (Number(row.occurrences ?? 0) < thresholdForSkill(row.skill_id)) return { ok: false, error: 'needs_repeat' };
    let created = null;
    try { created = proposeChange(db, row.id); } catch (error) { return { ok: false, error: error.message }; }
    const activated = created?.skillProposal ? activateProposal(db, created.skillProposal.id, { root, home, now }) : null;
    return { ok: Boolean(activated), reflection: row.id, ...activated };
  }
  const activated = activateProposal(db, target.row.id, { root, home, now });
  return { ok: Boolean(activated), ...activated };
}

/**
 * 自动升版：只有 R0/R2 档（且攒够本档阈值）才自动做。
 * R3（发布这类不可撤回的外部动作）和查不到风险的技能一律要主人点头。
 */
export function maybeAutoApprove(db, skillId, { root, home, now = Date.now() } = {}) {
  const policy = policyForSkill(skillId);
  if (!policy.autoApprove) return { ok: false, reason: 'manual_review_required', policy, approved: [], skipped: [] };
  const rows = db.prepare("SELECT * FROM learning_proposals WHERE skill_id=? AND status IN ('candidate','validating') ORDER BY occurrences DESC, updated_at DESC").all(skillId);
  const eligible = rows.filter((row) => Number(row.occurrences ?? 0) >= policy.threshold);
  const approved = [];
  const skipped = [];
  for (const row of eligible) {
    try {
      const created = proposeChange(db, row.id);
      const activated = created?.skillProposal ? activateProposal(db, created.skillProposal.id, { root, home, now }) : null;
      if (activated) approved.push({ reflection: row.id, ...activated });
      else skipped.push({ reflection: row.id, reason: 'not_activated' });
    } catch (error) {
      skipped.push({ reflection: row.id, reason: String(error?.message ?? error) });
    }
  }
  return { ok: approved.length > 0, policy, approved, skipped };
}

/** 扫一遍所有攒够次数的反思：该自动升的自动升，该等人点头的列出来。 */
export function sweepLearning(db, { root, home, now = Date.now() } = {}) {
  initSkills(db);
  const skills = db.prepare("SELECT DISTINCT skill_id FROM learning_proposals WHERE status IN ('candidate','validating')").all();
  const approved = [];
  const pending = [];
  const skipped = [];
  for (const row of skills) {
    const skillId = row.skill_id;
    const policy = policyForSkill(skillId);
    const result = maybeAutoApprove(db, skillId, { root, home, now });
    if (result.approved?.length) approved.push(...result.approved);
    if (result.skipped?.length) skipped.push(...result.skipped);
    const left = db.prepare("SELECT * FROM learning_proposals WHERE skill_id=? AND status IN ('candidate','validating')").all(skillId);
    for (const item of left) {
      pending.push({ reflection: item.id, skillId, occurrences: item.occurrences, threshold: policy.threshold, autoApprove: policy.autoApprove });
    }
  }
  return { approved, pending, skipped };
}

export function rejectLearning(db, token) {
  const target = resolveTarget(db, token);
  if (!target) return { ok: false, error: 'not_found' };
  if (target.table === 'reflection') db.prepare("UPDATE learning_proposals SET status='rejected', updated_at=datetime('now') WHERE id=?").run(target.row.id);
  else db.prepare("UPDATE skill_proposals SET status='rejected' WHERE id=?").run(target.row.id);
  return { ok: true, id: target.row.id };
}

/** 升级后连续 threshold 次失败（没有任何一次成功）→ 回滚到上一版，并记一条经验。 */
export function maybeRollback(db, skillId, { root, home, threshold = 3, now = Date.now() } = {}) {
  try {
    const version = currentVersion(db, skillId);
    if (version <= 1) return null;
    const runs = db.prepare("SELECT success, verified FROM skill_runs WHERE skill_id=? AND version=? AND status!='running' ORDER BY started_at DESC LIMIT ?").all(skillId, version, threshold);
    if (runs.length < threshold) return null;
    if (runs.some((run) => run.success === 1)) return null;
    db.prepare("UPDATE skill_versions SET status='deprecated' WHERE skill_id=? AND version=?").run(skillId, version);
    setSkillStatus(db, skillId, version - 1, 'enabled');
    try {
      initRollbackTable(db);
      db.prepare('INSERT INTO skill_rollbacks(id, skill_id, from_version, to_version, reason, at) VALUES(?,?,?,?,?,?)').run(`rollback_${randomUUID()}`, skillId, version, version - 1, `连续 ${threshold} 次失败`, new Date(now).toISOString());
    } catch {}
    const text = `${skillId} 升到 v${version} 后连续 ${threshold} 次失败，已回滚到 v${version - 1}，改法先不用了。`;
    try { addLesson(join(home ?? join(root, 'runtime', 'dsh-home'), 'lessons.json'), { kind: 'rollback', text, tags: [skillId], channels: ['qq', 'douyin'] }, now); } catch {}
    return { rolledBack: true, skillId, from: version, to: version - 1 };
  } catch (error) {
    process.stderr.write(`skill_rollback_failed: ${String(error?.message ?? error).slice(0, 120)}\n`);
    return null;
  }
}
