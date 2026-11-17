// 「在页面上真的跑一次」的放行策略。
//
// 默认全都不许：这一层挡的是「误触」和「我自己手滑」，
// 真正放行有两种方式：
//   1) 主人在 runtime/connect/live-run.json 里点名（allowed，永久直到改回）；
//   2) 页面上「临时放行」——只对「无副作用（只读）」或「已确认过」的动作开放，
//      写一条带 expiresAt 的记录，到点自动失效（不用记得收回）。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ACTIONS } from '../actions.mjs';
import { TOOL_ONLY_META } from './tool-meta.mjs';
import { projectRoot } from '../core/paths.mjs';

export const GRANT_MINUTES = 30;

function fileOf(root) {
  return join(projectRoot(root), 'runtime', 'connect', 'live-run.json');
}

/** 读放行清单；文件不存在就是空清单（谁都不许跑）。 */
export function loadRunAllowlist(root = process.cwd()) {
  try {
    const parsed = JSON.parse(readFileSync(fileOf(root), 'utf8'));
    // 兼容两种写法：{ allowed: ['a','b'] } 与 { allowed: [...], grants: [{action, until}] }
    const raw = Array.isArray(parsed?.allowed) ? parsed.allowed : [];
    const allowed = raw.filter((item) => typeof item === 'string');
    const rawGrants = [
      ...(Array.isArray(parsed?.grants) ? parsed.grants : []),
      ...raw.filter((item) => item && typeof item === 'object'),
    ];
    const grants = rawGrants
      .filter((item) => item && typeof item.action === 'string')
      .map((item) => ({ action: item.action, until: Number(item.until ?? 0) }));
    return { allowed, grants, note: parsed?.note ?? '' };
  } catch {
    return { allowed: [], grants: [], note: '' };
  }
}

/** 现在这一刻，这个动作在不在放行范围里（永久清单 + 未过期的临时放行）。 */
export function isAllowed(action, { allowed = [], grants = [], now = Date.now() } = {}) {
  if (allowed.includes(action)) return true;
  return grants.some((grant) => grant.action === action && grant.until > now);
}

/** 写一条临时放行；返回 {ok, until} 或 {ok:false, reason}。 */
export function grantTemporarily(action, { root = process.cwd(), minutes = GRANT_MINUTES, now = Date.now(), allowed = [], grants = [], note = '' } = {}) {
  const safe = isSafeToSelfGrant(action);
  if (!safe.ok) return { ok: false, reason: safe.reason };
  const until = now + Math.max(1, Math.min(120, Number(minutes) || GRANT_MINUTES)) * 60_000;
  const kept = grants.filter((grant) => grant.until > now && grant.action !== action);
  const next = {
    allowed,
    grants: [...kept, { action, until }].map((grant) => ({ action: grant.action, until: grant.until })),
    note: note || `临时放行 ${action} 至 ${new Date(until).toISOString()}`,
  };
  mkdirSync(dirname(fileOf(root)), { recursive: true });
  writeFileSync(fileOf(root), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return { ok: true, until };
}

/**
 * 「页面上点一下就能临时放行」的白名单规则：
 *   - 只读工具（不产生副作用）：可以；
 *   - 已经真跑过且 confirmed 的动作：可以（再跑一次不会更糟）；
 *   - 其余（没跑过 / 只跑出 unconfirmed / 明确会响手机发布作品）：必须主人改文件。
 */
export function isSafeToSelfGrant(action, { lastVerdict = null } = {}) {
  if (!action) return { ok: false, reason: 'no_action' };
  if (TOOL_ONLY_META[action]) return { ok: true, reason: 'read_only' };
  if (!ACTIONS[action]) return { ok: false, reason: 'unknown_action' };
  if (lastVerdict === 'confirmed') return { ok: true, reason: 'already_confirmed' };
  return { ok: false, reason: 'needs_owner' };
}

/** 这个动作能不能从页面跑？返回 {ok, reason}。 */
export function canRunFromUi(action, { allowed = [], grants = [], ready = null, now = Date.now() } = {}) {
  if (!action) return { ok: false, reason: 'no_action' };
  const isAction = Boolean(ACTIONS[action]);
  const isReadOnly = Boolean(TOOL_ONLY_META[action]);
  if (!isAction && !isReadOnly) return { ok: false, reason: 'unknown_action' };
  if (!isAllowed(action, { allowed, grants, now })) return { ok: false, reason: 'not_allowed' };
  if (ready === false) return { ok: false, reason: 'preflight_not_ready' };
  return { ok: true, reason: 'ok', readOnly: isReadOnly };
}

/**
 * 写进永久放行清单（`live-run.json` 的 `allowed`）。
 * 只写文件，不代表「谁都能调」——调用方必须先过 `isSafeToSelfGrant`。
 */
export function grantPermanently(action, { root = process.cwd(), allowed = null, grants = null, note = '' } = {}) {
  const current = loadRunAllowlist(root);
  const base = Array.isArray(allowed) ? allowed : current.allowed;
  const keep = Array.isArray(grants) ? grants : current.grants;
  const next = Array.from(new Set([...base, action]));
  const file = fileOf(root);
  mkdirSync(dirname(file), { recursive: true });
  const payload = { allowed: next, grants: keep.filter((item) => item.until > Date.now()), note };
  writeFileSync(file, JSON.stringify(payload, null, 2));
  return { allowed: next, file };
}

/** 给主人看的「要永久放行该怎么写」——公开动作只能主人自己动手。 */
export function allowlistSnippet(action) {
  return `{ "allowed": ["${action}"] }`;
}

/** 给放行清单写一句备注（为什么开这个口子），最长 160 字。 */
export function writeAllowlistNote(note, { root = process.cwd() } = {}) {
  const current = loadRunAllowlist(root);
  const text = String(note ?? '').replace(/\s+/gu, ' ').trim().slice(0, 160);
  const file = fileOf(root);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({
    allowed: current.allowed,
    grants: current.grants.filter((item) => item.until > Date.now()),
    note: text,
  }, null, 2));
  return { note: text, file };
}
