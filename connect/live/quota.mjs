/**
 * 「还能发几条评论」——把自建限速的用量摆到页面上。
 *
 * 失败理由里出现最多的一类是「被自己的闸门挡住」，但那不是故障，是设计如此。
 * 页面上直接显示剩余额度，就不会再把「到限额了」误读成「工具坏了」。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadLimits, quotaOf } from '../douyin/compliance.mjs';
import { runtimeDir } from '../core/paths.mjs';

export function commentQuota(root, { now = Date.now() } = {}) {
  const base = runtimeDir(root);
  let history = [];
  try {
    const state = JSON.parse(readFileSync(join(base, 'douyin', 'state.json'), 'utf8'));
    history = Array.isArray(state.history) ? state.history : [];
  } catch { /* 没跑过就是空的 */ }
  const limits = loadLimits(root);
  return { ...quotaOf(history, { now, limits }), checkedAt: now };
}
