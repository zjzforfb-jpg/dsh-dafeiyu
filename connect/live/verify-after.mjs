// 「跑完之后，应该看到什么」的机器检查。
//
// 和 preflight（跑之前能不能跑）是一对：preflight 问环境，verifyAfter 问结果。
// 只读：不点手机、不改数据；查的是「副作用有没有真的发生」——
// 通话类看 call_ended 事件与通话窗，发布类看作品表里有没有新增。
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot, runtimeDir } from '../core/paths.mjs';

import { EXPECT_AFTER } from './expect-after.mjs';

export { EXPECT_AFTER };

const MIN = 60_000;

function openDouyin(root) {
  const file = join(runtimeDir(root), 'douyin', 'douyin.db');
  if (!existsSync(file)) return null;
  try {
    return new DatabaseSync(file);
  } catch {
    return null;
  }
}

/** 近 windowMs 内发布的作品。 */
export function recentWorks({ root = process.cwd(), now = Date.now(), windowMs = 60 * MIN } = {}) {
  const db = openDouyin(root);
  if (!db) return [];
  try {
    const rows = db.prepare('SELECT id, title, published_at, status FROM works ORDER BY id DESC LIMIT 20').all();
    return rows
      .map((row) => ({
        id: row.id,
        title: row.title,
        status: row.status,
        at: Number(new Date(row.published_at ?? 0)) || 0,
      }))
      .filter((row) => row.at && now - row.at <= windowMs);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** 近 windowMs 内的 call_ended 事件。 */
export function recentCallEnds({ db, now = Date.now(), windowMs = 60 * MIN } = {}) {
  if (!db) return [];
  try {
    const since = new Date(now - windowMs).toISOString();
    return db.prepare("SELECT id, created_at, payload FROM agent_events WHERE event_type = 'call_ended' AND created_at >= ? ORDER BY id DESC LIMIT 5").all(since)
      .map((row) => {
        let payload = {};
        try { payload = JSON.parse(row.payload ?? '{}'); } catch { /* 旧记录 */ }
        return { id: row.id, at: row.created_at, outcome: payload.outcome ?? 'unknown', durationMs: payload.durationMs ?? null };
      });
  } catch {
    return [];
  }
}

const isCall = (action) => /call|hangup/u.test(action);
const isPublish = (action) => /^douyin\.publish/u.test(action);

/** 检查一个动作「跑完有没有真的发生」。 */
export async function verifyAfter(action, { root = process.cwd(), db = null, probes = null, now = Date.now(), windowMs = 60 * MIN } = {}) {
  const checks = [];
  const expect = EXPECT_AFTER[action] ?? [];
  const works = isPublish(action) ? recentWorks({ root, now, windowMs }) : [];
  const calls = isCall(action) ? recentCallEnds({ db, now, windowMs }) : [];

  if (isCall(action)) {
    const hangup = action === 'qq.hangup';
    if (hangup) {
      const open = probes?.qqCallWindow ? await probes.qqCallWindow() : null;
      checks.push({ key: 'window', ok: open ? !open.ok : null, detail: open ? (open.ok ? '还有通话窗口开着' : '没有进行中的通话') : '没查（没给探针）' });
      // 没有 call_ended 不代表失败（可能压根没接通），所以记成「不知道」
      checks.push({ key: 'event', ok: calls.length ? true : null, detail: calls.length ? `最近一次 ${calls[0].outcome}（${calls[0].at}）` : '近 1 小时没有 call_ended（可能没接通）' });
    } else {
      checks.push({ key: 'event', ok: calls.length ? true : null, detail: calls.length ? `最近一次 ${calls[0].outcome}，时长 ${Math.round((calls[0].durationMs ?? 0) / 1000)}s` : '近 1 小时没有 call_ended（可能没接通）' });
      // 拨出类不查「窗口还在不在」——通话结束后窗口本来就该没了，
      // 那个条件只对 hangup 有意义（「该关的关没关」）。
    }
  }

  if (isPublish(action)) {
    checks.push({
      key: 'works',
      ok: works.length > 0,
      detail: works.length ? `近 1 小时新增 ${works.length} 条：${works[0].title ?? works[0].id}` : '近 1 小时作品表没有新增',
    });
    if (action === 'douyin.publish_draft') {
      const pending = join(runtimeDir(root), 'douyin', 'pending.json');
      checks.push({ key: 'pending', ok: !existsSync(pending), detail: existsSync(pending) ? '待审草稿还在（没发出去）' : '待审草稿已清' });
    }
  }

  if (!checks.length) return { action, expect, checks: [], verdict: 'unknown', reason: '这个动作没有跑后检查（只读或无需副作用）' };
  const failed = checks.filter((check) => check.ok === false);
  const unknown = checks.filter((check) => check.ok === null);
  const verdict = failed.length ? 'fail' : unknown.length === checks.length ? 'unknown' : 'pass';
  return { action, expect, checks, verdict };
}
