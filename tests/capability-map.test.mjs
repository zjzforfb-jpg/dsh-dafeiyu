// P1-B · B-2 + B-5：能力矩阵单一真源 + 动作↔工具↔技能显式映射。
//
// 验收目标：
//  1) 动作表（connect/actions.mjs 17 项）、工具表（connect/qq/tools.mjs 12 项）、
//     技能表（connect/skills/defs.mjs 12 项）三张表**全部**在映射表里登记，一项不漏。
//  2) 能力矩阵不再手写第二份：从产品能力卡的原子能力派生。
//  3) 渠道能力文案与决策脑菜单都从同一张表渲染，不再各写一套。
//  4) 占位动作（douyin.like_comments）不许出现在提示词里——不许承诺做不到的事。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { ACTIONS } from '../connect/actions.mjs';
import { ALL_TOOLS } from '../connect/qq/tools.mjs';
import { SKILL_DEFS } from '../connect/skills/defs.mjs';
import {
  CAPABILITY_MAP, TOOL_ONLY, SKILL_ONLY, ALL_ROWS,
  actionEntry, toolEntry, skillEntry,
  unimplementedActions, mapProblems, mapReport,
  actionsForTool, actionsForSkill,
  actionMenuPrompt, BRAIN_RULES,
} from '../connect/core/capability-map.mjs';
import { CAPABILITY_MATRIX, capabilityText } from '../connect/core-contract.mjs';
import { atomicCapabilityCards, atomicCapabilityMatrix, CAPABILITIES } from '../connect/memory/capabilities.mjs';

test('B-5：三张表全部登记进映射表，一项不漏', () => {
  const actionNames = Object.keys(ACTIONS);
  for (const action of actionNames) {
    assert.ok(actionEntry(action), `动作 ${action} 没登记进 CAPABILITY_MAP`);
  }
  const toolNames = ALL_TOOLS.map((t) => t.name);
  for (const tool of toolNames) {
    assert.ok(toolEntry(tool), `工具 ${tool} 没登记进映射表`);
  }
  const skillNames = SKILL_DEFS.map((s) => s.skillId);
  for (const skill of skillNames) {
    assert.ok(skillEntry(skill), `技能 ${skill} 没登记进映射表`);
  }
});

test('B-5：映射表计数与计划基线一致（动作 15 / 工具 16 / 技能 10）且无问题', () => {
  const report = mapReport();
  // 18 → 16：2026-11-18 下线 douyin.like_comments（适配层没有可验证的点赞）与 douyin.prepare（被 draft→publish_draft 取代）
  assert.equal(report.actions, 15);
  // 工具数随动作增加：12 → 16 补了四个通话动作，16 → 17 补了 douyin.publish_video
  // （这四个通话动作以前只有 [DO:...] 通道，模型规划不出来，现在都是 WRITE_TOOLS）。
  assert.equal(report.tools, 16);
  assert.equal(report.skills, 10);
  assert.deepEqual(report.problems, []);
  assert.deepEqual(mapProblems(), []);
  // 工具按唯一名计数（douyin.publish 同时服务 draft/publish 两个动作，不能算两次）
  assert.equal(new Set(report.toolNames).size, report.tools);
});

test('B-5：反向索引能从工具/技能找回动作', () => {
  const publish = actionsForTool('douyin.publish');
  assert.ok(publish.includes('douyin.draft'));
  assert.ok(publish.includes('douyin.publish'));
  assert.ok(actionsForSkill('douyin.reply_comments').includes('douyin.reply_comments'));
});

test('B-4/B-5：占位动作不进提示词', () => {
  const unimplemented = unimplementedActions();
  assert.ok(unimplemented.includes('douyin.like_comments'));
  const menu = actionMenuPrompt();
  assert.ok(!menu.includes('douyin.like_comments'));
  assert.ok(!menu.includes('douyin.prepare'));
  assert.ok(menu.includes('BRAIN_RULES'.slice(0, 0) + '你能做的事'));
  assert.ok(menu.includes(BRAIN_RULES.identity));
  assert.ok(menu.includes(BRAIN_RULES.footer));
});

test('B-2：能力矩阵从产品能力卡派生，不再手写第二份', () => {
  const cards = atomicCapabilityCards();
  const matrix = atomicCapabilityMatrix();
  assert.equal(Object.keys(matrix).length, 12);
  assert.deepEqual(Object.keys(matrix).sort(), cards.map((c) => c.id).sort());
  // core-contract 导出的矩阵必须与能力卡派生结果一致
  assert.deepEqual({ ...CAPABILITY_MATRIX }, { ...matrix });
  // 每张产品能力卡的 atomic 字段都已登记进矩阵
  for (const cap of CAPABILITIES) {
    for (const item of cap.atomic ?? []) {
      assert.ok(CAPABILITY_MATRIX[item.id], `原子能力 ${item.id} 没进矩阵`);
    }
  }
});

test('B-2：渠道能力文案逐字保持原样（always 必显 / group 仅群聊显 / none 不显）', () => {
  const expected = [
    '能力状态必须以系统回执为准，不得把模型承诺当成执行结果。',
    '文字聊天：可用。',
    '语音输入：可用；回复默认使用音频文件。',
    '微信原生语音气泡：已关闭。',
    '外部动作：当前统一停在任务确认层，未收到确认和真实回执不会执行。',
    '抖音读取互动：原型能力，必须经过任务确认。',
    '抖音回复评论：原型能力，必须经过任务确认和真实回执。',
    '抖音点赞：尚未实现。',
    '抖音发布：原型能力，必须经过审批和真实回执。',
  ].join('\n');
  assert.equal(capabilityText('qq'), expected);
  assert.equal(capabilityText('qq', { group: true }), `${expected}\n群聊外部动作：已冻结，不能执行抖音、电话、发布或点赞。`);
});

test('B-2/B-5：决策脑菜单从映射表渲染，brain.mjs 不再硬编码第二份', () => {
  const src = readFileSync(new URL('../connect/qq/brain.mjs', import.meta.url), 'utf8');
  assert.ok(!src.includes('你能做的事（不要说自己没权限）'), 'brain.mjs 里还留着硬编码能力菜单');
  assert.ok(src.includes('actionMenuPrompt'), 'brain.mjs 没接上动作菜单映射表');
  const menu = actionMenuPrompt();
  assert.ok(menu.includes('回复抖音评论/互动消息（动作 douyin.reply_comments）'));
  assert.ok(menu.includes('查天气（系统已自动提供当天天气数据）'), '只读工具的提示词丢了');
});

test('B-5：TOOL_ONLY / SKILL_ONLY 行也进 ALL_ROWS，状态合法', () => {
  assert.equal(ALL_ROWS.length, CAPABILITY_MAP.length + TOOL_ONLY.length + SKILL_ONLY.length);
  for (const row of ALL_ROWS) {
    assert.ok(row.status && typeof row.status === 'string');
    assert.ok(row.implemented === true || row.implemented === false);
  }
  // capability.code 是 ownerOnly，不能被当成普通工具随便承诺
  const code = toolEntry('capability.code');
  assert.equal(code.ownerOnly, true);
});
