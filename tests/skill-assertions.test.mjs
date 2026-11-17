// P1-C · C-2：结构化断言执行器的单元测试 + 技能定义（defs.mjs）一致性测试。
//
// 三件事：
//   1. 每种断言 kind 都有正例和反例——「核不了」必须是 false，不能是「大概过了」。
//   2. 事后重放没有 live ctx 时，手机类断言回落到真机步骤事件（step_event）；
//      有 live ctx 时永远以 live 为准，不许拿步骤事件冒充。
//   3. defs.mjs 里 46 步的结构化断言必须真的能核：字段路径要落在 action 真实返回的
//      data 上，db_row 要落在 CONNECT 库（抖音库跨库核不了），file_exists 要指向真实路径字段。
//
// 数据库全部用临时目录，绝不碰真实 runtime/。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  ASSERT_BASES,
  ASSERT_KINDS,
  checkAssertion,
  describeAssertion,
  runAssertions,
} from '../connect/skills/assertions.mjs';
import { SKILL_DEFS } from '../connect/skills/defs.mjs';

// ── 小工具 ────────────────────────────────────────────────────────────────────

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'dafeiyu-assert-'));
  const db = new DatabaseSync(join(dir, 'connect.sqlite'));
  db.exec('CREATE TABLE study_sessions (id TEXT PRIMARY KEY, course_id TEXT, step INTEGER, source TEXT)');
  db.exec('CREATE TABLE growth_archive (id TEXT PRIMARY KEY, source TEXT, body TEXT)');
  db.prepare('INSERT INTO study_sessions (id, course_id, step, source) VALUES (?,?,?,?)').run('s1', 'c1', 1, 'study');
  db.prepare('INSERT INTO growth_archive (id, source, body) VALUES (?,?,?)').run('g1', 'weekly', '一周');
  return { dir, db };
}

const NODES = [
  { text: '互动消息', desc: '', cls: 'android.widget.TextView' },
  { text: '收到评论', desc: '评论 3 条', cls: 'android.widget.TextView' },
  { text: '', desc: '搜索框', cls: 'android.widget.EditText' },
  { text: '发送', desc: '', cls: 'android.widget.Button' },
];

function ctx(extra = {}) {
  return { nodes: NODES, activity: 'com.ss.android.ugc.aweme.main.MainActivity', data: {}, db: null, files: {}, root: '', pixels: {}, ...extra };
}

function leafNodes(assertion, out = []) {
  if (!assertion || typeof assertion !== 'object') return out;
  if (assertion.kind === 'all' || assertion.kind === 'any') {
    for (const part of assertion.of ?? []) leafNodes(part, out);
    return out;
  }
  out.push(assertion);
  return out;
}

function resolvePath(source, path) {
  let cur = source;
  for (const part of String(path).split('.')) {
    if (cur === null || cur === undefined) return { found: false, value: undefined };
    cur = cur[part];
  }
  return { found: cur !== undefined, value: cur };
}

// ── 1. 每种 kind 的正例 + 反例 ────────────────────────────────────────────────

test('field_* 断言：正例过、反例不过、字段缺失核不了', () => {
  const data = { title: '标题', body: 'x'.repeat(80), count: 5, topics: ['#a', '#b'], changed: true, nothing: null };

  assert.equal(checkAssertion({ kind: 'field_not_empty', field: 'title' }, ctx({ data })).ok, true);
  assert.equal(checkAssertion({ kind: 'field_not_empty', field: 'missing' }, ctx({ data })).ok, false);
  assert.equal(checkAssertion({ kind: 'field_not_empty', field: 'missing' }, ctx({ data })).basis, 'missing');
  assert.equal(checkAssertion({ kind: 'field_not_empty', field: 'nothing' }, ctx({ data })).basis, 'missing');

  assert.equal(checkAssertion({ kind: 'field_length', field: 'body', min: 60 }, ctx({ data })).ok, true);
  assert.equal(checkAssertion({ kind: 'field_length', field: 'body', min: 120 }, ctx({ data })).ok, false);
  assert.equal(checkAssertion({ kind: 'field_length_max', field: 'body', max: 100 }, ctx({ data })).ok, true);
  assert.equal(checkAssertion({ kind: 'field_length_max', field: 'body', max: 10 }, ctx({ data })).ok, false);

  assert.equal(checkAssertion({ kind: 'field_equals', field: 'count', value: 5 }, ctx({ data })).ok, true);
  assert.equal(checkAssertion({ kind: 'field_equals', field: 'count', value: 6 }, ctx({ data })).ok, false);

  assert.equal(checkAssertion({ kind: 'field_gt', field: 'count', value: 4 }, ctx({ data })).ok, true);
  assert.equal(checkAssertion({ kind: 'field_gt', field: 'count', value: 5 }, ctx({ data })).ok, false);
  assert.equal(checkAssertion({ kind: 'field_gt', field: 'count', value: 0 }, ctx({ data: { count: [1, 2] } })).ok, false, '数组不能当数字比');

  assert.equal(checkAssertion({ kind: 'field_contains', field: 'topics', value: '#' }, ctx({ data })).ok, true);
  assert.equal(checkAssertion({ kind: 'field_contains', field: 'topics', value: '@' }, ctx({ data })).ok, false);

  assert.equal(checkAssertion({ kind: 'field_count_min', field: 'topics', min: 2 }, ctx({ data })).ok, true);
  assert.equal(checkAssertion({ kind: 'field_count_min', field: 'topics', min: 3 }, ctx({ data })).ok, false);

  assert.equal(checkAssertion({ kind: 'field_parseable', field: 'count' }, ctx({ data })).ok, true);
  assert.equal(checkAssertion({ kind: 'field_parseable', field: 'title' }, ctx({ data })).ok, false);

  assert.equal(checkAssertion({ kind: 'field_changed', field: 'changed' }, ctx({ data })).ok, true);
  assert.equal(checkAssertion({ kind: 'field_changed', field: 'changed' }, ctx({ data: { changed: false } })).ok, false);
});

test('ui_* 断言：正例过、反例不过', () => {
  assert.equal(checkAssertion({ kind: 'ui_text', contains: '互动消息' }, ctx()).ok, true);
  assert.equal(checkAssertion({ kind: 'ui_text', contains: '不存在的字' }, ctx()).ok, false);
  assert.equal(checkAssertion({ kind: 'ui_text', pattern: '/互动消息/' }, ctx()).ok, true);
  assert.equal(checkAssertion({ kind: 'ui_text', pattern: '/不存在/' }, ctx()).ok, false);

  assert.equal(checkAssertion({ kind: 'ui_nodes_min', min: 1, where: { text: '发送' } }, ctx()).ok, true);
  assert.equal(checkAssertion({ kind: 'ui_nodes_min', min: 2, where: { text: '发送' } }, ctx()).ok, false);
  assert.equal(checkAssertion({ kind: 'ui_nodes_max', max: 0, where: { clsEndsWith: 'EditText' } }, ctx()).ok, false);
  assert.equal(checkAssertion({ kind: 'ui_nodes_max', max: 1, where: { clsEndsWith: 'EditText' } }, ctx()).ok, true);
  // cls 是**精确**匹配：真机 dump 里是 android.widget.EditText，写 'EditText' 匹配不到
  assert.equal(checkAssertion({ kind: 'ui_nodes_min', min: 1, where: { cls: 'EditText' } }, ctx()).ok, false);
  assert.equal(checkAssertion({ kind: 'ui_nodes_min', min: 1, where: { textContains: '互动' } }, ctx()).ok, true);
  assert.equal(checkAssertion({ kind: 'ui_nodes_min', min: 1, where: { descContains: '评论' } }, ctx()).ok, true);
  assert.equal(checkAssertion({ kind: 'ui_nodes_min', min: 1, where: { clsEndsWith: 'Button' } }, ctx()).ok, true);
  assert.equal(checkAssertion({ kind: 'ui_nodes_min', min: 1, where: { textMatches: '/^发/' } }, ctx()).ok, true);
  assert.equal(checkAssertion({ kind: 'ui_nodes_min', min: 1, where: { textMatches: '/^送/' } }, ctx()).ok, false);
});

test('ui_input_* 断言：输入框里有字才算过', () => {
  const data = { title: '互动消息内容' };
  const filled = ctx({ nodes: [{ text: '互动消息内容', desc: '', cls: 'android.widget.EditText' }] });
  const empty = ctx({ nodes: [{ text: '', desc: '', cls: 'android.widget.EditText' }] });

  assert.equal(checkAssertion({ kind: 'ui_input_contains', prefixOf: 'title', length: 6 }, ctx({ ...filled, data })).ok, true);
  assert.equal(checkAssertion({ kind: 'ui_input_contains', prefixOf: 'title', length: 6 }, ctx({ ...empty, data })).ok, false);
  assert.equal(checkAssertion({ kind: 'ui_input_contains', prefixOf: 'missing', length: 6 }, ctx({ ...filled, data })).basis, 'missing');

  assert.equal(checkAssertion({ kind: 'ui_input_nonempty' }, filled).ok, true);
  assert.equal(checkAssertion({ kind: 'ui_input_nonempty' }, empty).ok, false);
  assert.equal(checkAssertion({ kind: 'ui_input_nonempty' }, ctx()).ok, false);

  assert.equal(checkAssertion({ kind: 'ui_contains_field', prefixOf: 'title', length: 6 }, ctx({ data })).ok, false);
  assert.equal(checkAssertion({ kind: 'ui_contains_field', prefixOf: 'title', length: 2 }, ctx({ data })).ok, true);
});

test('activity_* 断言：正例过、反例不过', () => {
  const c = ctx();
  assert.equal(checkAssertion({ kind: 'activity_equals', value: 'com.ss.android.ugc.aweme.main.MainActivity' }, c).ok, true);
  assert.equal(checkAssertion({ kind: 'activity_equals', value: 'other' }, c).ok, false);
  assert.equal(checkAssertion({ kind: 'activity_contains', contains: 'MainActivity' }, c).ok, true);
  assert.equal(checkAssertion({ kind: 'activity_contains', contains: 'DetailActivity' }, c).ok, false);
  assert.equal(checkAssertion({ kind: 'activity_prefix', prefix: 'com.ss.android.ugc.aweme' }, c).ok, true);
  assert.equal(checkAssertion({ kind: 'activity_prefix', prefix: 'com.other' }, c).ok, false);
  assert.equal(checkAssertion({ kind: 'activity_matches', pattern: '/(MainActivity|SplashActivity)/' }, c).ok, true);
  assert.equal(checkAssertion({ kind: 'activity_matches', pattern: '/(DetailActivity)/' }, c).ok, false);
});

test('pixel 断言：按 on/off 判色', () => {
  assert.equal(checkAssertion({ kind: 'pixel', target: 'ai_generate', expect: 'on' }, ctx({ pixels: { ai_generate: 'on' } })).ok, true);
  assert.equal(checkAssertion({ kind: 'pixel', target: 'ai_generate', expect: 'on' }, ctx({ pixels: { ai_generate: 'off' } })).ok, false);
  assert.equal(checkAssertion({ kind: 'pixel', target: 'save_album', expect: 'off' }, ctx({ pixels: { save_album: 'off' } })).ok, true);
  assert.equal(checkAssertion({ kind: 'pixel', target: 'save_album', expect: 'off' }, ctx({ pixels: { save_album: 'on' } })).ok, false);
});

test('all / any 组合：全过才算过，有一个过就算过', () => {
  const c = ctx({ data: { a: 'x', b: 'y' } });
  assert.equal(checkAssertion({ kind: 'all', of: [{ kind: 'field_not_empty', field: 'a' }, { kind: 'field_not_empty', field: 'b' }] }, c).ok, true);
  assert.equal(checkAssertion({ kind: 'all', of: [{ kind: 'field_not_empty', field: 'a' }, { kind: 'field_not_empty', field: 'zzz' }] }, c).ok, false);
  assert.equal(checkAssertion({ kind: 'any', of: [{ kind: 'field_not_empty', field: 'zzz' }, { kind: 'field_not_empty', field: 'b' }] }, c).ok, true);
  assert.equal(checkAssertion({ kind: 'any', of: [{ kind: 'field_not_empty', field: 'zzz' }, { kind: 'field_not_empty', field: 'yyy' }] }, c).ok, false);
});

test('未知 kind 核不了（missing），不猜', () => {
  const res = checkAssertion({ kind: 'no_such_kind' }, ctx());
  assert.equal(res.ok, false);
  assert.equal(res.basis, 'missing');
  assert.match(res.detail, /^unknown_kind:/u);
});

// ── 2. 核不了就 false：缺 db / 缺表 / 表名非法 ────────────────────────────────

test('db_row / db_count：缺 db、缺表、表名非法都核不了', () => {
  const { db } = freshDb();

  const okRow = checkAssertion({ kind: 'db_row', table: 'study_sessions' }, ctx({ db }));
  assert.equal(okRow.ok, true);
  assert.equal(okRow.basis, 'assertion');

  const missingRow = checkAssertion({ kind: 'db_row', table: 'no_such_table' }, ctx({ db }));
  assert.equal(missingRow.ok, false);
  assert.match(missingRow.detail, /^db_error:/u);
  assert.equal(missingRow.basis, 'missing');

  const noDb = checkAssertion({ kind: 'db_row', table: 'study_sessions' }, ctx());
  assert.equal(noDb.ok, false);
  assert.equal(noDb.detail, 'no_db');
  assert.equal(noDb.basis, 'missing');

  const badTable = checkAssertion({ kind: 'db_row', table: 'Study Sessions; DROP TABLE x' }, ctx({ db }));
  assert.equal(badTable.ok, false);
  assert.equal(badTable.detail, 'bad_table');

  const okCount = checkAssertion({ kind: 'db_count', table: 'growth_archive', min: 1 }, ctx({ db }));
  assert.equal(okCount.ok, true);
  const lowCount = checkAssertion({ kind: 'db_count', table: 'growth_archive', min: 2 }, ctx({ db }));
  assert.equal(lowCount.ok, false);
  const noDbCount = checkAssertion({ kind: 'db_count', table: 'growth_archive' }, ctx());
  assert.equal(noDbCount.ok, false);
  assert.equal(noDbCount.detail, 'no_db');
  const badTableCount = checkAssertion({ kind: 'db_count', table: 'bad table' }, ctx({ db }));
  assert.equal(badTableCount.ok, false);
  assert.equal(badTableCount.detail, 'bad_table');
});

test('file_exists：路径来源与空文件都核不了', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dafeiyu-assert-file-'));
  const image = join(dir, 'cover.png');
  writeFileSync(image, 'PNG');
  const empty = join(dir, 'empty.png');
  writeFileSync(empty, '');

  assert.equal(checkAssertion({ kind: 'file_exists', path: 'imageFile' }, ctx({ files: { imageFile: image } })).ok, true);
  assert.equal(checkAssertion({ kind: 'file_exists', path: 'imageFile' }, ctx({ files: { imageFile: empty } })).ok, false);
  assert.equal(checkAssertion({ kind: 'file_exists', path: 'imageFile' }, ctx({ files: { imageFile: join(dir, 'nope.png') } })).ok, false);
  assert.equal(checkAssertion({ kind: 'file_exists', path: 'imageFile' }, ctx()).ok, false);
  const noSource = checkAssertion({ kind: 'file_exists', path: 'imageFile' }, ctx());
  assert.equal(noSource.basis, 'missing');
  assert.match(noSource.detail, /^no_path_source:/u);
  // data 里的真实路径字段也能当来源
  assert.equal(checkAssertion({ kind: 'file_exists', path: 'imageFile' }, ctx({ data: { imageFile: image } })).ok, true);
  // root 下的相对路径
  assert.equal(checkAssertion({ kind: 'file_exists', path: 'cover.png' }, ctx({ root: dir })).ok, true);
});

// ── 3. step_event 兜底 / live 优先 ───────────────────────────────────────────

test('没有 live ctx 时回落到真机步骤事件（basis=step_event）', () => {
  const c = ctx({ nodes: undefined, activity: undefined, steps: { open_app: { ok: 1, verified: true, evidence: '真机点到首页' } } });
  const res = checkAssertion({ kind: 'activity_matches', pattern: '/MainActivity/' }, { ...c, stepEvidence: c.steps.open_app });
  assert.equal(res.ok, true);
  assert.equal(res.basis, 'step_event');
  assert.equal(res.detail, 'step_event_ok');
  assert.equal(res.evidence, '真机点到首页');
});

test('没有 live ctx 又没有步骤事件 → 核不了（no_live_context）', () => {
  const res = checkAssertion({ kind: 'ui_text', contains: '互动消息' }, ctx({ nodes: undefined }));
  assert.equal(res.ok, false);
  assert.equal(res.basis, 'missing');
  assert.equal(res.detail, 'no_live_context');

  const noEvent = checkAssertion({ kind: 'activity_contains', contains: 'MainActivity' }, ctx({ activity: undefined }));
  assert.equal(noEvent.ok, false);
  assert.equal(noEvent.detail, 'no_live_context');

  const failedEvent = checkAssertion({ kind: 'pixel', target: 'ai_generate', expect: 'on' }, {
    ...ctx({ pixels: undefined }),
    stepEvidence: { ok: 0, verified: false },
  });
  assert.equal(failedEvent.ok, false);
  assert.equal(failedEvent.detail, 'no_live_context');
});

test('live ctx 存在时以 live 断言为准，不拿步骤事件冒充', () => {
  // 步骤事件说核过了，但 live 证据说界面里没有 → 以 live 为准（false）。
  const contradicted = checkAssertion({ kind: 'ui_text', contains: '互动消息' }, {
    ...ctx({ nodes: [{ text: '别的界面', desc: '', cls: 'TextView' }] }),
    stepEvidence: { ok: 1, verified: true },
  });
  assert.equal(contradicted.ok, false);
  assert.equal(contradicted.basis, 'assertion');

  // 步骤事件说没核过，但 live 证据说界面里有 → 以 live 为准（true，basis=assertion）。
  const trusted = checkAssertion({ kind: 'ui_text', contains: '互动消息' }, {
    ...ctx(),
    stepEvidence: { ok: 0, verified: false },
  });
  assert.equal(trusted.ok, true);
  assert.equal(trusted.basis, 'assertion');
});

test('runAssertions：逐步带上 stepEvidence，汇总 passed/total/ok', () => {
  const steps = [
    { id: 'a', assert: { kind: 'field_not_empty', field: 'title' } },
    { id: 'b', assert: { kind: 'activity_matches', pattern: '/MainActivity/' } },
  ];
  const summary = runAssertions(steps, {
    data: { title: '标题' },
    activity: 'com.ss.android.ugc.aweme.main.MainActivity',
    steps: { b: { ok: 1, verified: true } },
  });
  assert.equal(summary.ok, true);
  assert.equal(summary.passed, 2);
  assert.equal(summary.total, 2);
  assert.equal(summary.results.length, 2);
  assert.deepEqual(summary.results.map((r) => r.step), ['a', 'b']);
  assert.equal(summary.results[0].basis, 'assertion');
  assert.equal(summary.results[1].basis, 'assertion');

  // 只有步骤事件 → step_event；没有事件 → missing
  const replay = runAssertions(steps, { data: { title: '标题' }, steps: { b: { ok: 1, verified: true } } });
  assert.equal(replay.passed, 2);
  assert.equal(replay.total, 2);
  assert.equal(replay.results[1].basis, 'step_event');

  const blind = runAssertions(steps, { data: { title: '标题' } });
  assert.equal(blind.ok, false);
  assert.equal(blind.passed, 1);
  assert.equal(blind.total, 2);
  assert.equal(blind.results[1].basis, 'missing');
  assert.equal(blind.results[1].detail, 'no_live_context');
});

test('每条结果都带 basis，basis 取值受限', () => {
  const res = runAssertions([{ id: 'x', assert: { kind: 'field_not_empty', field: 'a' } }], { data: { a: 'x' } });
  for (const item of res.results) {
    assert.ok(ASSERT_BASES.includes(item.basis), `basis 非法：${item.basis}`);
  }
  assert.ok(ASSERT_BASES.includes(res.basis));
});

test('describeAssertion 把结构化断言讲成人话', () => {
  assert.equal(describeAssertion({ kind: 'field_not_empty', field: 'title' }), 'title 非空');
  assert.equal(describeAssertion({ kind: 'db_row', table: 'study_sessions' }), 'study_sessions 有满足条件的行');
  assert.equal(describeAssertion({ kind: 'all', of: [{ kind: 'field_gt', field: 'step', value: 0 }] }), 'step > 0');
  assert.ok(describeAssertion({ kind: 'ui_input_nonempty' }).includes('输入框'));
});

// ── 4. defs 一致性：46 步都结构化，字段路径都落在真实 data 上 ────────────────

// action 真实返回的 data（来源：connect/actions.mjs / connect/academy/study.mjs /
// connect/academy/weekly.mjs / scripts/douyin*.mjs）。
const REAL_DATA = {
  'academy.study': {
    sample: {
      status: 'step_done', courseId: 'course-1', courseTitle: '提示词工程', step: 1,
      stepKey: 'knowledge', stepLabel: '看概念', total: 7, summary: 'x'.repeat(70),
      score: null, passed: null, degraded: false, error: null, verified: true, steps: [],
    },
    keys: ['status', 'courseId', 'courseTitle', 'step', 'stepKey', 'stepLabel', 'total', 'summary', 'score', 'passed', 'degraded', 'error', 'verified', 'steps'],
  },
  'academy.weekly': {
    sample: {
      status: 'weekly', title: '本周周记', body: 'y'.repeat(140),
      stats: { from: '2026-11-10', to: '2026-11-16', tasks: {}, courses: 1, steps: 3, works: [], received: 2, replied: 1, hot: {}, fans: {} },
      degraded: false, verified: true, steps: [],
    },
    keys: ['status', 'title', 'body', 'stats', 'degraded', 'verified', 'steps'],
  },
  'douyin.browse': {
    sample: { verified: true, steps: [] },
    keys: ['verified', 'steps'],
  },
  'douyin.check_interactions': {
    sample: {
      status: 'ok', verified: true, activity: 'socialnotice.view.activity.IntegratedInteractionActivity',
      count: 2, emptyProof: null, blockers: [], steps: [], rows: [{ author: '小明', text: '好看' }],
    },
    keys: ['status', 'verified', 'activity', 'count', 'emptyProof', 'blockers', 'steps', 'rows'],
  },
  'douyin.draft': {
    sample: {
      status: 'draft', draftId: 'draft-1', title: '标题', caption: '正文'.repeat(10),
      topics: ['#大肥鱼', '#deepseek'], imageFile: '/tmp/cover.png', theme: '成长',
      draftFile: '/tmp/draft.json', at: 1, steps: [],
    },
    keys: ['status', 'draftId', 'title', 'caption', 'topics', 'imageFile', 'theme', 'draftFile', 'at', 'steps'],
  },
  'douyin.publish_draft': {
    sample: {
      status: 'published', verified: true, workId: 'dy-1', workCode: 'DY001', title: '标题',
      topics: ['#大肥鱼'], visible: true, toast: false, steps: [],
    },
    keys: ['status', 'verified', 'workId', 'workCode', 'title', 'topics', 'visible', 'toast', 'steps'],
  },
  'douyin.hotspot': {
    sample: {
      status: 'hotspot',
      topics: [{ topic: '提示词', videos: 3, topLikes: 12345, topTitle: '标题', verdict: 'join', note: '跟' }],
    },
    keys: ['status', 'topics'],
  },
};

// 这些技能的 action **没有结构化 data**（只回一句摘要文字，或直接抛错），
// 所以它们的断言只能是手机类，不能出现 field/db/file 叶子。
const NO_DATA_SKILLS = new Set([
  'douyin.reply_comments',
  'douyin.hot_comment_round',
  'douyin.comment_latest',
  'douyin.like_comments',
  'douyin.crawl_stats',
]);

// 断言 ctx.db 指的是 CONNECT 库（runtime/connect/connect.sqlite），只有这些表核得到。
const CONNECT_DB_TABLES = new Set([
  'study_sessions', 'growth_archive', 'course_state', 'skill_step_events',
  'skill_runs', 'skill_registry', 'skill_versions', 'learning_proposals',
]);

const ALL_STEPS = SKILL_DEFS.flatMap((def) => def.steps.map((step) => ({ skillId: def.skillId, ...step })));

test('defs：10 个技能、40 步，每步都有结构化 assert 与中文 assertText', () => {
  // 12 → 11 / 46 → 43：douyin.like_comments 下线；11 → 10 / 43 → 40：douyin.hotspot 下线（搜索页改成视频流，列表读不到）
  assert.equal(SKILL_DEFS.length, 10);
  assert.equal(ALL_STEPS.length, 40);
  for (const step of ALL_STEPS) {
    assert.ok(step.assert && typeof step.assert === 'object' && !Array.isArray(step.assert), `${step.skillId}/${step.id} 的 assert 必须是对象`);
    assert.ok(typeof step.assert.kind === 'string' && step.assert.kind.length > 0, `${step.skillId}/${step.id} 缺 kind`);
    assert.ok(ASSERT_KINDS.includes(step.assert.kind), `${step.skillId}/${step.id} 的 kind 非法：${step.assert.kind}`);
    assert.ok(typeof step.assertText === 'string' && step.assertText.trim().length > 0, `${step.skillId}/${step.id} 缺 assertText`);
    for (const leaf of leafNodes(step.assert)) {
      assert.ok(ASSERT_KINDS.includes(leaf.kind), `${step.skillId}/${step.id} 子断言 kind 非法：${leaf.kind}`);
    }
  }
});

test('defs：断言里的字段路径都落在 action 真实返回的 data 上', () => {
  for (const step of ALL_STEPS) {
    const leaves = leafNodes(step.assert);
    const fieldLeaves = leaves.filter((leaf) => typeof leaf.field === 'string');
    if (NO_DATA_SKILLS.has(step.skillId)) {
      assert.equal(fieldLeaves.length, 0, `${step.skillId}/${step.id} 没有真实 data，不能核字段`);
      assert.equal(leaves.filter((leaf) => leaf.kind === 'db_row' || leaf.kind === 'db_count').length, 0, `${step.skillId}/${step.id} 没有真实 data，不能核库`);
      assert.equal(leaves.filter((leaf) => leaf.kind === 'file_exists').length, 0, `${step.skillId}/${step.id} 没有真实 data，不能核文件`);
      continue;
    }
    const real = REAL_DATA[step.skillId];
    assert.ok(real, `缺少 ${step.skillId} 的真实 data 映射`);
    for (const leaf of fieldLeaves) {
      const found = resolvePath(real.sample, leaf.field);
      assert.ok(found.found, `${step.skillId}/${step.id} 核不到字段 ${leaf.field}（action 真实 data 里没有这个键）`);
    }
    for (const leaf of leaves.filter((item) => item.kind === 'file_exists')) {
      assert.ok(real.keys.includes(leaf.path), `${step.skillId}/${step.id} 的 file_exists 路径 ${leaf.path} 不在真实 data 里`);
    }
    for (const leaf of leaves.filter((item) => item.kind === 'db_row' || item.kind === 'db_count')) {
      assert.ok(CONNECT_DB_TABLES.has(leaf.table), `${step.skillId}/${step.id} 核的表 ${leaf.table} 不在 CONNECT 库里（跨库核不到）`);
    }
  }
});

test('defs：跨库的那几条断言已经换成 data 里的等价事实', () => {
  const find = (skillId, stepId) => ALL_STEPS.find((step) => step.skillId === skillId && step.id === stepId);
  const tables = (skillId, stepId) => leafNodes(find(skillId, stepId).assert).filter((leaf) => leaf.kind === 'db_row' || leaf.kind === 'db_count').map((leaf) => leaf.table);
  const fields = (skillId, stepId) => leafNodes(find(skillId, stepId).assert).filter((leaf) => leaf.field).map((leaf) => leaf.field);

  // 抖音库（runtime/douyin/douyin.db）：works / hotspots 跨库核不到 → 改成 data 等价断言
  assert.deepEqual(tables('douyin.draft', 'store'), []);
  assert.deepEqual(fields('douyin.draft', 'store').sort(), ['draftId', 'status']);

  // CONNECT 库里的两张表还留着（核得到）
  assert.deepEqual(tables('academy.study', 'save'), ['study_sessions']);
  assert.deepEqual(tables('academy.weekly', 'archive'), ['growth_archive']);

  // 已知的历史错配全部消失（逐个技能查，别把别的技能的合法字段误伤）
  const stale = [
    ['douyin.draft', 'copy', ['body', 'hashtags']],
    ['douyin.draft', 'image', []],
    ['douyin.crawl_stats', 'save', ['works.stats_at']],
    ['douyin.comment_latest', 'generate', ['gate.ok', 'level']],
    ['douyin.hot_comment_round', 'pick_top', ['comments', 'likes']],
    ['academy.study', 'pick_course', ['course']],
    ['academy.study', 'digest', ['body']],
  ];
  for (const [skillId, stepId, banned] of stale) {
    const used = fields(skillId, stepId);
    for (const name of banned) {
      assert.equal(used.includes(name), false, `${skillId}/${stepId} 还核着旧字段 ${name}`);
    }
  }
  // 配图路径不是 'image'，而是真实 data 里的 imageFile
  const imageLeaf = leafNodes(find('douyin.draft', 'image').assert)[0];
  assert.equal(imageLeaf.path, 'imageFile');
  // 抖音草稿的正文叫 caption、话题叫 topics
  assert.ok(fields('douyin.draft', 'copy').includes('caption'));
  assert.ok(fields('douyin.draft', 'copy').includes('topics'));
  // 课程步骤核 courseTitle / courseId，摘要核 summary
  assert.ok(fields('academy.study', 'pick_course').includes('courseTitle'));
  assert.ok(fields('academy.study', 'pick_course').includes('courseId'));
  assert.ok(fields('academy.study', 'digest').includes('summary'));
  // rows 是数组，只能数条数
  assert.ok(fields('douyin.check_interactions', 'read_rows').includes('rows'));
});

test('defs：每条结构化断言在真实 data 上真的能核过（不是恒真）', () => {
  // 有真实 data 的技能：把 data 灌进 ctx 跑一遍，纯手机类断言（ui_/activity_/pixel）跳过。
  for (const step of ALL_STEPS) {
    const real = REAL_DATA[step.skillId];
    if (!real) continue;
    const leaves = leafNodes(step.assert);
    const onlyLive = leaves.every((leaf) => leaf.kind.startsWith('ui_') || leaf.kind.startsWith('activity_') || leaf.kind === 'pixel');
    if (onlyLive) continue;
    const { db, dir } = freshDb();
    // 真实路径字段指向真的临时文件
    const data = { ...real.sample };
    const files = {};
    for (const key of ['imageFile', 'draftFile']) {
      if (typeof data[key] === 'string') {
        const path = join(dir, `${key}.bin`);
        writeFileSync(path, 'x');
        data[key] = path;
        files[key] = path;
      }
    }
    const summary = runAssertions([step], {
      data, db, files, root: dir, nodes: NODES, activity: 'com.ss.android.ugc.aweme.main.MainActivity',
    });
    assert.equal(summary.ok, true, `${step.skillId}/${step.id} 在真实 data 上没核过：${JSON.stringify(summary.results)}`);
  }
});
