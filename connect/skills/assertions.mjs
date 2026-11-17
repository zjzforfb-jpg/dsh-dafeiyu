// P1-C · C-2：结构化断言执行器（堵 R-12）。
//
// 以前 46 条技能断言全是中文散文，写在 connect/skills/defs.mjs 里：
//   { id: 'send', action: '点「发送」', assert: '回复框收起，或回复文字出现在列表里' }
// 这类断言**没法执行**：机器读不懂「收起」是什么意思，也没有稳定的数据来源去核。
// 于是技能跑完只能记一个 success=true，「到底哪一步真的成了」全靠人肉翻日志。
//
// 现在断言是结构化的：
//   { kind: 'ui_nodes_min', min: 1, where: { text: '回复' } }
//   { kind: 'db_row', table: 'works', where: { status: 'draft' } }
//   { kind: 'field_length', field: 'summary', min: 60 }
//
// 约定：
//   * 断言只读，不许改状态——它唯一的职责是「核」。
//   * 核不了就是 false，不许「大概过了」；上下文缺东西也要 false，并写清缺什么。
//   * 每个 kind 都必须能单独测。
//
// 「事后重放」怎么核手机类断言（2026-11-16 补）：
//   ui_* / activity_* / pixel 这类断言要的是**当时的**界面/Activity/像素，
//   而技能跑完再回放时，nodes/activity/pixels 根本没存下来——硬核必然 false，
//   技能就永远晋升不了。所以：
//     * ctx 里有 live 证据（nodes/activity/pixels）→ **优先**用 live 断言核，
//       核出来的 true/false 就是结论，绝不拿步骤事件冒充。
//     * ctx 里没有 live 证据 → 回落到步骤事件（ctx.steps[stepId]，真机跑的时候
//       记进 skill_step_events 的 ok/verified/evidence）：
//         - 事件说这一步真机核过了（ok===1）→ ok:true, basis:'step_event'
//         - 没有事件 / 事件说没核过 → ok:false, basis:'missing', detail:'no_live_context'
//   每条结果都带 basis，说明这条结论**是从哪来的**：
//     assertion（当场核过）/ step_event（真机步骤事件佐证）/ missing（核不了）。
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const ASSERT_KINDS = Object.freeze([
  'all', 'any',
  'field_not_empty', 'field_length', 'field_length_max', 'field_equals', 'field_gt',
  'field_contains', 'field_count_min', 'field_parseable', 'field_changed',
  'ui_text', 'ui_nodes_min', 'ui_nodes_max', 'ui_input_contains', 'ui_input_nonempty',
  'ui_contains_field',
  'activity_equals', 'activity_contains', 'activity_prefix', 'activity_matches',
  'db_row', 'db_count', 'file_exists', 'pixel',
]);

/** 结论的来源。写进每条结果里，人一看就知道这条是真核的还是补的。 */
export const ASSERT_BASES = Object.freeze(['assertion', 'step_event', 'missing']);

/** 手机类断言：事后重放时没有 live ctx，只能靠步骤事件佐证。 */
export const LIVE_ASSERT_KINDS = Object.freeze([
  'ui_text', 'ui_nodes_min', 'ui_nodes_max', 'ui_input_contains', 'ui_input_nonempty',
  'ui_contains_field',
  'activity_equals', 'activity_contains', 'activity_prefix', 'activity_matches',
  'pixel',
]);

const TABLE = /^[a-z_][a-z0-9_]*$/u;
const LIVE = new Set(LIVE_ASSERT_KINDS);
const STRENGTH = { assertion: 2, step_event: 1, missing: 0 };

/**
 * defs 里的正则写法是 '/(MainActivity|SplashActivity)/' 这种带斜杠的字符串。
 * 直接 new RegExp('/.../') 会把斜杠当字面量，**永远匹配不上**——这种断言等于恒假。
 * 这里统一认三种写法：RegExp、'/pattern/flags' 字符串、裸 pattern 字符串。
 */
function toRegExp(pattern) {
  if (pattern instanceof RegExp) return pattern;
  const text = String(pattern ?? '');
  const slash = text.match(/^\/(.*)\/([a-z]*)$/su);
  if (slash) return new RegExp(slash[1], slash[2] || 'u');
  return new RegExp(text, 'u');
}

function pick(source, path) {
  if (!path) return undefined;
  let cur = source;
  for (const part of String(path).split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

function textOf(node) {
  return `${node?.text ?? ''}\n${node?.desc ?? ''}`;
}

function whereMatches(node, where = {}) {
  for (const [key, expected] of Object.entries(where)) {
    const actual = node?.[key] ?? '';
    if (key === 'textContains' || key === 'descContains') {
      const field = key === 'textContains' ? 'text' : 'desc';
      if (!String(node?.[field] ?? '').includes(String(expected))) return false;
      continue;
    }
    if (key === 'textMatches' || key === 'descMatches') {
      // 正则按节点文本/描述逐个测（trim 后再测，避免尾部空白误杀）。
      const field = key === 'textMatches' ? 'text' : 'desc';
      const re = toRegExp(expected);
      if (!re.test(String(node?.[field] ?? '').trim())) return false;
      continue;
    }
    if (key === 'clsEndsWith') {
      if (!String(node?.cls ?? '').endsWith(String(expected))) return false;
      continue;
    }
    if (String(actual) !== String(expected)) return false;
  }
  return true;
}

function countNodes(nodes, where) {
  const list = Array.isArray(nodes) ? nodes : [];
  return list.filter((node) => whereMatches(node, where)).length;
}

function dbWhere(db, table, where = {}) {
  const keys = Object.keys(where);
  const clause = keys.length ? ` WHERE ${keys.map((key) => `"${key}"=?`).join(' AND ')}` : '';
  const sql = `SELECT COUNT(*) AS n FROM "${table}"${clause}`;
  return Number(db.prepare(sql).get(...keys.map((key) => where[key]))?.n ?? 0);
}

/** 一条结果的统一形状。 */
function result(ok, kind, basis, detail, extra = {}) {
  return { ok: Boolean(ok), kind, basis, detail, ...extra };
}

/** 步骤事件（ctx.steps[stepId]）说的是不是「这一步真机核过了」。 */
function eventOk(evidence) {
  if (!evidence || typeof evidence !== 'object') return false;
  const flag = evidence.ok === undefined ? evidence.verified : evidence.ok;
  return flag === 1 || flag === true || flag === '1';
}

/** ctx 里有没有这条断言需要的 live 证据。 */
function hasLiveContext(kind, assertion, ctx) {
  switch (kind) {
    case 'ui_text':
    case 'ui_nodes_min':
    case 'ui_nodes_max':
      return Array.isArray(ctx.nodes);
    case 'ui_input_contains':
    case 'ui_input_nonempty':
    case 'ui_contains_field':
      return Array.isArray(ctx.nodes);
    case 'activity_equals':
    case 'activity_contains':
    case 'activity_prefix':
    case 'activity_matches':
      return typeof ctx.activity === 'string' && ctx.activity.length > 0;
    case 'pixel':
      return Boolean(ctx.pixels) && ctx.pixels[assertion.target] !== undefined;
    default:
      return true;
  }
}

/** 没有 live ctx 时的兜底：真机步骤事件说核过了就算核过。 */
function stepEventFallback(kind, ctx) {
  const evidence = ctx.stepEvidence ?? null;
  if (eventOk(evidence)) {
    return result(true, kind, 'step_event', 'step_event_ok', {
      evidence: String(evidence?.evidence ?? '').slice(0, 120),
    });
  }
  return result(false, kind, 'missing', 'no_live_context');
}

function composite(kind, parts) {
  const ok = kind === 'all'
    ? parts.length > 0 && parts.every((part) => part.ok)
    : parts.some((part) => part.ok);
  if (ok) {
    const basis = kind === 'all'
      ? parts.reduce((weak, part) => (STRENGTH[part.basis] < STRENGTH[weak] ? part.basis : weak), 'assertion')
      : parts.filter((part) => part.ok).reduce((strong, part) => (STRENGTH[part.basis] > STRENGTH[strong] ? part.basis : strong), 'missing');
    return result(true, kind, basis, kind === 'all' ? 'all_passed' : 'any_passed');
  }
  const failed = parts.filter((part) => !part.ok);
  const basis = failed.length > 0 && failed.every((part) => part.basis === 'missing') ? 'missing' : 'assertion';
  const detail = failed.map((part) => part.detail).join('; ').slice(0, 240) || 'no_parts';
  return result(false, kind, basis, detail);
}

/** 字段类断言的公共入口：字段不存在 → 核不了（missing）；存在但值不对 → 当场核过（assertion）。 */
function fieldValue(assertion, ctx) {
  const value = pick(ctx.data ?? {}, assertion.field);
  return { value, absent: value === undefined || value === null };
}

/** 一条断言的执行结果。永远有 ok / basis，失败时带 detail。 */
export function checkAssertion(assertion, ctx = {}) {
  if (!assertion || typeof assertion !== 'object' || !assertion.kind) {
    return result(false, assertion?.kind ?? null, 'missing', 'assertion_malformed');
  }
  const kind = assertion.kind;
  const data = ctx.data ?? {};
  if (kind === 'all' || kind === 'any') {
    const parts = (assertion.of ?? []).map((item) => checkAssertion(item, ctx));
    return composite(kind, parts);
  }
  // 手机类断言：没有 live 证据时回落到真机步骤事件（live 优先，绝不拿事件冒充）。
  if (LIVE.has(kind) && !hasLiveContext(kind, assertion, ctx)) {
    return stepEventFallback(kind, ctx);
  }
  switch (kind) {
    case 'field_not_empty': {
      const { value, absent } = fieldValue(assertion, ctx);
      if (absent) return result(false, kind, 'missing', `missing:${assertion.field}`);
      const ok = String(value).trim() !== '';
      const len = typeof value === 'string' ? value.length : 0;
      const withinMax = assertion.maxLength === undefined || len <= Number(assertion.maxLength);
      return result(ok && withinMax, kind, 'assertion', ok ? (withinMax ? 'field_set' : `too_long:${len}`) : `empty:${assertion.field}`);
    }
    case 'field_length': {
      const { value, absent } = fieldValue(assertion, ctx);
      if (absent) return result(false, kind, 'missing', `missing:${assertion.field}`);
      const len = typeof value === 'string' ? value.length : Number(value ?? 0);
      const ok = len >= Number(assertion.min ?? 1);
      return result(ok, kind, 'assertion', ok ? 'length_ok' : `too_short:${len}`);
    }
    case 'field_length_max': {
      const { value, absent } = fieldValue(assertion, ctx);
      if (absent) return result(false, kind, 'missing', `missing:${assertion.field}`);
      const len = typeof value === 'string' ? value.length : Number(value ?? 0);
      const ok = len <= Number(assertion.max ?? Infinity);
      return result(ok, kind, 'assertion', ok ? 'length_ok' : `too_long:${len}`);
    }
    case 'field_equals': {
      const { value, absent } = fieldValue(assertion, ctx);
      if (absent) return result(false, kind, 'missing', `missing:${assertion.field}`);
      const ok = value === assertion.value;
      return result(ok, kind, 'assertion', ok ? 'equals' : `expected:${assertion.value},got:${JSON.stringify(value)}`);
    }
    case 'field_gt': {
      const { value, absent } = fieldValue(assertion, ctx);
      if (absent) return result(false, kind, 'missing', `missing:${assertion.field}`);
      const num = Number(value);
      const ok = Number.isFinite(num) && num > Number(assertion.value ?? 0);
      return result(ok, kind, 'assertion', ok ? 'gt_ok' : `not_gt:${assertion.field}=${JSON.stringify(value)}`);
    }
    case 'field_contains': {
      const { value, absent } = fieldValue(assertion, ctx);
      if (absent) return result(false, kind, 'missing', `missing:${assertion.field}`);
      const ok = String(value).includes(String(assertion.value ?? ''));
      return result(ok, kind, 'assertion', ok ? 'contains' : `missing_token:${assertion.value}`);
    }
    case 'field_count_min': {
      const { value, absent } = fieldValue(assertion, ctx);
      if (absent) return result(false, kind, 'missing', `missing:${assertion.field}`);
      const count = Array.isArray(value) ? value.length : Number(value ?? 0);
      const ok = count >= Number(assertion.min ?? 1);
      return result(ok, kind, 'assertion', ok ? 'count_ok' : `count:${count}`);
    }
    case 'field_parseable': {
      const { value, absent } = fieldValue(assertion, ctx);
      if (absent) return result(false, kind, 'missing', `missing:${assertion.field}`);
      const ok = value !== '' && !Number.isNaN(Number(value));
      return result(ok, kind, 'assertion', ok ? 'parseable' : `unparseable:${assertion.field}`);
    }
    case 'field_changed': {
      const { value, absent } = fieldValue(assertion, ctx);
      if (absent) return result(false, kind, 'missing', `missing:${assertion.field}`);
      const ok = value !== false;
      return result(ok, kind, 'assertion', ok ? 'changed' : `unchanged:${assertion.field}`);
    }
    case 'ui_text': {
      const nodes = Array.isArray(ctx.nodes) ? ctx.nodes : [];
      const blob = nodes.map((node) => textOf(node)).join('\n');
      const ok = assertion.contains
        ? blob.includes(String(assertion.contains))
        : assertion.pattern ? toRegExp(assertion.pattern).test(blob) : false;
      return result(ok, kind, 'assertion', ok ? 'text_found' : `text_missing:${assertion.contains ?? assertion.pattern}`);
    }
    case 'ui_nodes_min': {
      const count = countNodes(ctx.nodes, assertion.where);
      const ok = count >= Number(assertion.min ?? 1);
      return result(ok, kind, 'assertion', ok ? 'nodes_ok' : `nodes:${count}`);
    }
    case 'ui_nodes_max': {
      const count = countNodes(ctx.nodes, assertion.where);
      const ok = count <= Number(assertion.max ?? 0);
      return result(ok, kind, 'assertion', ok ? 'nodes_ok' : `nodes:${count}`);
    }
    case 'ui_input_contains': {
      const source = String(pick(data, assertion.prefixOf) ?? '');
      const head = source.slice(0, Number(assertion.length ?? 6));
      if (!head) return result(false, kind, 'missing', `missing_source:${assertion.prefixOf}`);
      const nodes = (Array.isArray(ctx.nodes) ? ctx.nodes : []).filter((node) => String(node?.cls ?? '').includes('EditText'));
      const ok = nodes.some((node) => String(node?.text ?? '').includes(head));
      return result(ok, kind, 'assertion', ok ? 'input_ok' : `input_missing:${head}`);
    }
    case 'ui_input_nonempty': {
      // 输入框里有字（不为空）。用于「生成/草稿类」动作：动作返回的只是摘要，
      // 真正能核的是输入框里确实落了字。
      const nodes = (Array.isArray(ctx.nodes) ? ctx.nodes : [])
        .filter((node) => String(node?.cls ?? '').includes('EditText'))
        .filter((node) => whereMatches(node, assertion.where));
      const filled = nodes.filter((node) => String(node?.text ?? '').trim() !== '');
      const ok = filled.length > 0;
      return result(ok, kind, 'assertion', ok ? 'input_ok' : `input_empty:${nodes.length}`);
    }
    case 'ui_contains_field': {
      const source = String(pick(data, assertion.prefixOf) ?? '');
      const head = source.slice(0, Number(assertion.length ?? 6));
      if (!head) return result(false, kind, 'missing', `missing_source:${assertion.prefixOf}`);
      const nodes = Array.isArray(ctx.nodes) ? ctx.nodes : [];
      const ok = nodes.some((node) => textOf(node).includes(head));
      return result(ok, kind, 'assertion', ok ? 'text_ok' : `text_missing:${head}`);
    }
    case 'activity_equals': {
      const ok = String(ctx.activity ?? '') === String(assertion.value ?? '');
      return result(ok, kind, 'assertion', ok ? 'activity_ok' : `activity:${ctx.activity}`);
    }
    case 'activity_contains': {
      const ok = String(ctx.activity ?? '').includes(String(assertion.contains ?? ''));
      return result(ok, kind, 'assertion', ok ? 'activity_ok' : `activity:${ctx.activity}`);
    }
    case 'activity_prefix': {
      const ok = String(ctx.activity ?? '').startsWith(String(assertion.prefix ?? ''));
      return result(ok, kind, 'assertion', ok ? 'activity_ok' : `activity:${ctx.activity}`);
    }
    case 'activity_matches': {
      const ok = toRegExp(assertion.pattern ?? '').test(String(ctx.activity ?? ''));
      return result(ok, kind, 'assertion', ok ? 'activity_ok' : `activity:${ctx.activity}`);
    }
    case 'db_row': {
      if (!ctx.db) return result(false, kind, 'missing', 'no_db');
      const table = String(assertion.table ?? '');
      if (!TABLE.test(table)) return result(false, kind, 'missing', 'bad_table');
      try {
        const n = dbWhere(ctx.db, table, assertion.where);
        return result(n > 0, kind, 'assertion', n > 0 ? 'row_found' : `row_missing:${table}`);
      } catch (error) {
        return result(false, kind, 'missing', `db_error:${String(error?.message ?? error).slice(0, 80)}`);
      }
    }
    case 'db_count': {
      if (!ctx.db) return result(false, kind, 'missing', 'no_db');
      const table = String(assertion.table ?? '');
      if (!TABLE.test(table)) return result(false, kind, 'missing', 'bad_table');
      try {
        const n = dbWhere(ctx.db, table, assertion.where);
        const ok = n >= Number(assertion.min ?? 1);
        return result(ok, kind, 'assertion', ok ? 'count_ok' : `count:${n}`);
      } catch (error) {
        return result(false, kind, 'missing', `db_error:${String(error?.message ?? error).slice(0, 80)}`);
      }
    }
    case 'file_exists': {
      const raw = String(assertion.path ?? '');
      // 路径来源：ctx.files 映射 → ctx.data 里的真实路径字段（如 imageFile）→ root 下的相对路径。
      const fromData = typeof ctx.data?.[raw] === 'string' && ctx.data[raw] ? ctx.data[raw] : undefined;
      const resolved = ctx.files?.[raw] ?? fromData ?? (ctx.root ? join(ctx.root, raw) : undefined);
      if (!resolved) return result(false, kind, 'missing', `no_path_source:${raw}`);
      let ok = false;
      try { ok = existsSync(resolved) && statSync(resolved).size > 0; } catch { ok = false; }
      return result(ok, kind, 'assertion', ok ? 'file_ok' : `file_missing:${raw}`);
    }
    case 'pixel': {
      const actual = ctx.pixels?.[assertion.target];
      const expect = assertion.expect ?? 'on';
      const ok = expect === 'on' ? actual === 'on' || actual === true : actual === 'off' || actual === false;
      return result(ok, kind, 'assertion', ok ? 'pixel_ok' : `pixel:${assertion.target}=${JSON.stringify(actual ?? null)}`);
    }
    default:
      return result(false, kind, 'missing', `unknown_kind:${kind}`);
  }
}

/** 跑一组步骤的断言，返回逐条结果（每条都带 basis）。 */
export function runAssertions(steps = [], ctx = {}) {
  const results = [];
  for (const step of steps) {
    const assertion = step?.assert ?? null;
    const stepId = step?.id ?? null;
    if (!assertion || typeof assertion !== 'object' || !assertion.kind) {
      results.push({ step: stepId, ok: false, kind: null, basis: 'missing', detail: 'no_assertion' });
      continue;
    }
    // 事后重放：把这一步真机跑出来的步骤事件挂上去，live ctx 缺失时靠它佐证。
    const evidence = ctx.steps?.[stepId] ?? null;
    const stepCtx = { ...ctx, stepEvidence: evidence };
    const checked = checkAssertion(assertion, stepCtx);
    results.push({
      step: stepId,
      ok: checked.ok,
      kind: checked.kind,
      basis: checked.basis,
      detail: checked.detail,
      ...(checked.evidence ? { evidence: checked.evidence } : {}),
    });
  }
  const failed = results.filter((item) => !item.ok);
  const basis = results.length === 0
    ? 'missing'
    : failed.length === 0
      ? results.reduce((weak, item) => (STRENGTH[item.basis] < STRENGTH[weak] ? item.basis : weak), 'assertion')
      : failed.every((item) => item.basis === 'missing') ? 'missing' : 'assertion';
  return {
    ok: results.length > 0 && failed.length === 0,
    results,
    passed: results.length - failed.length,
    total: results.length,
    basis,
  };
}

/** 把结构化断言渲染成一句人话（给人看 / 给模型看）。 */
export function describeAssertion(assertion) {
  if (!assertion || typeof assertion !== 'object') return '';
  switch (assertion.kind) {
    case 'all': return (assertion.of ?? []).map(describeAssertion).join(' 且 ');
    case 'any': return (assertion.of ?? []).map(describeAssertion).join(' 或 ');
    case 'field_not_empty': return `${assertion.field} 非空${assertion.maxLength ? `且 ≤${assertion.maxLength} 字` : ''}`;
    case 'field_length': return `${assertion.field} 长度 ≥ ${assertion.min ?? 1}`;
    case 'field_length_max': return `${assertion.field} 长度 ≤ ${assertion.max ?? '?'}`;
    case 'field_equals': return `${assertion.field} = ${assertion.value}`;
    case 'field_gt': return `${assertion.field} > ${assertion.value ?? 0}`;
    case 'field_contains': return `${assertion.field} 含 ${assertion.value}`;
    case 'field_count_min': return `${assertion.field} 至少 ${assertion.min ?? 1} 条`;
    case 'field_parseable': return `${assertion.field} 可解析`;
    case 'field_changed': return `${assertion.field} 有变化`;
    case 'ui_text': return `界面含「${assertion.contains ?? assertion.pattern ?? ''}」`;
    case 'ui_nodes_min': return `界面至少 ${assertion.min ?? 1} 个 ${describeWhere(assertion.where)}`;
    case 'ui_nodes_max': return `界面最多 ${assertion.max ?? 0} 个 ${describeWhere(assertion.where)}`;
    case 'ui_input_contains': return `输入框含 ${assertion.prefixOf} 前 ${assertion.length ?? 6} 字`;
    case 'ui_input_nonempty': return `输入框里有字${assertion.where ? `（${describeWhere(assertion.where)}）` : ''}`;
    case 'ui_contains_field': return `界面含 ${assertion.prefixOf} 前 ${assertion.length ?? 6} 字`;
    case 'activity_equals': return `前台 Activity = ${assertion.value}`;
    case 'activity_contains': return `前台 Activity 含 ${assertion.contains}`;
    case 'activity_prefix': return `前台 Activity 以 ${assertion.prefix} 开头`;
    case 'activity_matches': return `前台 Activity 匹配 ${assertion.pattern}`;
    case 'db_row': return `${assertion.table} 有满足条件的行`;
    case 'db_count': return `${assertion.table} 至少 ${assertion.min ?? 1} 行`;
    case 'file_exists': return `文件 ${assertion.path} 存在且可读`;
    case 'pixel': return `${assertion.target} = ${assertion.expect ?? 'on'}`;
    default: return assertion.kind ?? '';
  }
}

function describeWhere(where = {}) {
  const parts = [];
  for (const [key, value] of Object.entries(where)) {
    if (key === 'textContains') parts.push(`文本含 ${value}`);
    else if (key === 'descContains') parts.push(`描述含 ${value}`);
    else if (key === 'textMatches') parts.push(`文本匹配 ${value}`);
    else if (key === 'descMatches') parts.push(`描述匹配 ${value}`);
    else if (key === 'clsEndsWith') parts.push(`类名以 ${value} 结尾`);
    else parts.push(`${key}=${value}`);
  }
  return parts.join('、') || '任意节点';
}
