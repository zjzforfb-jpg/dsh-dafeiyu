/**
 * 平面流程图（/flow）的布局唯一真源。
 *
 * 节点与连线的语义全部复用 connect/arch/graph.mjs（那份是 3D 版的真源），
 * 这里只负责「摆在哪」，所以以后加节点只需两边各加一行：
 *   - arch/graph.mjs 的 NODES 加节点
 *   - 这个文件的 CELLS 给它一个格子
 * tests/flow.test.mjs 会检查两边没有漏。
 */

/** 网格：列宽 176、行高 96，左上角留 84/74 给边距。 */
export const GRID = Object.freeze({ col: 176, row: 96, x0: 84, y0: 74, w: 148, h: 58 });

/**
 * 每个节点占哪一格（列, 行）。列从左到右＝数据流动方向：
 * 渠道 → 事件流（接入）→ 路由 → 任务/预算 → 闸门/审批/生活目标 → 执行 → 认知（脑/记忆/技能）。
 */
export const CELLS = Object.freeze({
  qq: [0, 0], ilink: [0, 1], call: [0, 2], desktop: [0, 3], android: [0, 4], douyin: [0, 5], board: [0, 6],
  events: [1, 3],
  route: [2, 3], scheduler: [2, 6],
  tasks: [3, 2], budget: [3, 4],
  gate: [4, 2], approvals: [4, 4], life: [4, 6],
  actions: [5, 2],
  brain: [6, 1], memory: [6, 3], skills: [6, 5],
});

/** 列标题：让人一眼看出「这一列在干什么」。 */
export const COLUMNS = Object.freeze(['入口渠道', '事件流', '路由', '任务', '闸门', '执行', '认知']);

/** /live 的九段（connect/core/pipeline.mjs）↔ 这张图的节点：两个方向都要能跳。 */
export const STAGE_NODE = Object.freeze({
  entry: 'events', observe: 'events', route: 'route', task: 'tasks', gate: 'gate',
  act: 'actions', verify: 'events', memory: 'memory', call: 'call',
});

/** 节点 → /live 阶段（跳回实时工作流时用；一个节点只挑一个最能代表的阶段）。 */
export const NODE_STAGE = Object.freeze({
  qq: 'entry', ilink: 'entry', call: 'call', desktop: 'entry', android: 'entry', douyin: 'entry', board: 'entry',
  events: 'entry', route: 'route', tasks: 'task', budget: 'task', scheduler: 'task', life: 'task',
  gate: 'gate', approvals: 'gate', actions: 'act', brain: 'memory', memory: 'memory', skills: 'memory',
});

/** 画布尺寸（唯一一处算像素的地方）。 */
export function canvasSize() {
  const cols = Math.max(...Object.values(CELLS).map(([col]) => col)) + 1;
  const rows = Math.max(...Object.values(CELLS).map(([, row]) => row)) + 1;
  return {
    width: GRID.x0 * 2 + (cols - 1) * GRID.col + GRID.w,
    height: GRID.y0 * 2 + (rows - 1) * GRID.row + GRID.h,
    cols,
    rows,
  };
}

/** 节点中心点。 */
export function centerOf(id) {
  const cell = CELLS[id];
  if (!cell) return null;
  const [col, row] = cell;
  return {
    x: GRID.x0 + col * GRID.col + GRID.w / 2,
    y: GRID.y0 + row * GRID.row + GRID.h / 2,
  };
}

/**
 * 自检：节点/连线/阶段映射三者是否自洽。返回问题列表，空数组＝没问题。
 * @param {{ nodes: {id: string}[], edges: unknown[][] }} graph  connect/arch/graph.mjs 的内容
 * @param {string[]} stageIds  connect/core/pipeline.mjs 的 PIPELINE_IDS
 */
export function validateLayout(graph, stageIds) {
  const problems = [];
  const ids = graph.nodes.map((node) => node.id);
  for (const id of ids) if (!CELLS[id]) problems.push(`节点 ${id} 在图上有位置吗？layout.CELLS 里没有`);
  for (const id of Object.keys(CELLS)) if (!ids.includes(id)) problems.push(`layout.CELLS 里的 ${id} 在 arch 图上不存在`);
  for (const [from, to] of graph.edges) {
    if (!CELLS[from]) problems.push(`连线 ${from} → ${to} 的起点没有位置`);
    if (!CELLS[to]) problems.push(`连线 ${from} → ${to} 的终点没有位置`);
  }
  const stageSet = new Set(stageIds);
  for (const stage of stageIds) {
    if (!STAGE_NODE[stage]) problems.push(`/live 阶段 ${stage} 没有对应的流程图节点`);
    else if (!CELLS[STAGE_NODE[stage]]) problems.push(`/live 阶段 ${stage} 映射到的节点 ${STAGE_NODE[stage]} 没有位置`);
  }
  for (const stage of Object.keys(STAGE_NODE)) if (!stageSet.has(stage)) problems.push(`STAGE_NODE 里的 ${stage} 不是 /live 的阶段`);
  for (const id of ids) {
    if (!NODE_STAGE[id]) problems.push(`节点 ${id} 没定义跳回 /live 哪个阶段`);
    else if (!stageSet.has(NODE_STAGE[id])) problems.push(`节点 ${id} 的 NODE_STAGE 指向不存在的阶段 ${NODE_STAGE[id]}`);
  }
  const seen = new Set();
  for (const [col, row] of Object.values(CELLS)) {
    const key = `${col},${row}`;
    if (seen.has(key)) problems.push(`两个节点抢同一格 ${key}`);
    seen.add(key);
  }
  return problems;
}
