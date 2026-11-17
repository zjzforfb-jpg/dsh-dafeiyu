import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * 项目约束：功能一变（加/改/删），/live「实时工作流」必须同步维护。
 * 这条用例就是那个约束的执行者——忘了维护，它红。
 *
 * 对应约定写在工作区根目录的 AGENTS.md「前端维护约定」。
 */
import { CAPABILITY_MAP } from '../connect/core/capability-map.mjs';
import { PIPELINE } from '../connect/core/pipeline.mjs';
import { EVENT_TYPE_LIST } from '../connect/agent-events.mjs';
import { STAGES, STAGE_IDS, STATES, EVENT_ROUTE, UNMAPPED_EVENTS, stageForEvent } from '../connect/live/catalog.mjs';
import { TOOL_META, TOOL_ONLY_META, LEVELS } from '../connect/live/tool-meta.mjs';
import { ALL_TOOLS } from '../connect/qq/tools.mjs';

test('/live 的能力清单跟着动作表走：加了动作没写说明书，这里红', () => {
  // offline 的行是留档（已下线），不该再出现在页面的工具清单里
  const actions = CAPABILITY_MAP.filter((row) => row.action && !row.offline).map((row) => row.action);
  const described = Object.keys(TOOL_META);
  const missing = actions.filter((action) => !described.includes(action));
  assert.deepEqual(missing, [], `这些动作还没在 connect/live/tool-meta.mjs 的 TOOL_META 里写标题/入口/介绍/逻辑：${missing.join('、')}`);
  const ghosts = described.filter((action) => !actions.includes(action));
  assert.deepEqual(ghosts, [], `这些说明书对应的动作已经从能力表删掉了，页面会显示幽灵条目：${ghosts.join('、')}`);
  for (const action of actions) {
    const meta = TOOL_META[action];
    assert.ok(meta.title && meta.file && meta.intro && meta.logic, `说明书不全：${action}`);
    assert.ok(LEVELS[meta.level], `等级不认识：${action} → ${meta.level}`);
  }
});

test('/live 的九段流水线与代码里的 PIPELINE 同源，且每段都有归属事件', () => {
  assert.deepEqual(STAGES.map((stage) => stage.id), PIPELINE.map((stage) => stage.id));
  assert.deepEqual([...STAGE_IDS], PIPELINE.map((stage) => stage.id));
  for (const stage of PIPELINE) {
    assert.ok(stage.events.length > 0, `阶段 ${stage.id} 没有归属事件，页面会一直显示未埋点`);
    for (const event of stage.events) {
      assert.ok(EVENT_TYPE_LIST.includes(event), `阶段 ${stage.id} 登记了不存在的事件：${event}`);
    }
  }
});

const STATE_KEYS = STATES;

test('/live 的事件映射不漏：新事件类型要么有归属，要么在 UNMAPPED_EVENTS 里写明理由', () => {
  const mapped = Object.keys(EVENT_ROUTE);
  const forgotten = EVENT_TYPE_LIST.filter((type) => !mapped.includes(type) && !(type in UNMAPPED_EVENTS));
  assert.deepEqual(forgotten, [], `这些事件类型既没接进 EVENT_ROUTE、也没在 UNMAPPED_EVENTS 里说明：${forgotten.join('、')}`);
  const stale = mapped.filter((type) => !EVENT_TYPE_LIST.includes(type));
  assert.deepEqual(stale, [], `EVENT_ROUTE 里有已经不存在的事件类型：${stale.join('、')}`);
  const staleList = Object.keys(UNMAPPED_EVENTS).filter((type) => !EVENT_TYPE_LIST.includes(type));
  assert.deepEqual(staleList, [], `UNMAPPED_EVENTS 里有已经不存在的事件类型：${staleList.join('、')}`);
  for (const type of EVENT_TYPE_LIST) {
    const routed = stageForEvent({ eventType: type });
    assert.ok(STAGE_IDS.includes(routed.stage), `${type} 落不到任何阶段`);
    assert.ok(Object.hasOwn(STATE_KEYS, routed.state), `${type} 落到了未知状态 ${routed.state}`);
  }
});

test('/live 的只读工具清单不会指向已经删掉的工具', () => {
  const known = new Set(ALL_TOOLS.map((tool) => tool.name));
  const ghosts = Object.keys(TOOL_ONLY_META).filter((name) => !known.has(name));
  assert.deepEqual(ghosts, [], `TOOL_ONLY_META 里有已经不存在的工具：${ghosts.join('、')}`);
});

test('/live 的说明书指向的文件真实存在：写错路径等于告诉主人一个打不开的入口', async () => {
  const { TOOL_META, TOOL_ONLY_META } = await import('../connect/live/tool-meta.mjs');
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const repo = join(import.meta.dirname, '..');
  const missing = [];
  for (const [key, meta] of Object.entries({ ...TOOL_META, ...TOOL_ONLY_META })) {
    const rel = String(meta.file ?? '').match(/^[\w.\/-]+\.(mjs|js|swift|json)/u)?.[0];
    if (!rel) continue;
    if (!existsSync(join(repo, rel))) missing.push(`${key} → ${rel}`);
  }
  assert.deepEqual(missing, [], `这些工具说明书写了不存在的文件：${missing.join('；')}`);
});
