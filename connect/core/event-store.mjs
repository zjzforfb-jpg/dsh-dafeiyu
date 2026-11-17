/**
 * 统一事件存储（计划 A-4 / 决策 D3）。
 *
 * `agent_events` 的唯一真源是 CONNECT 库（runtime/connect/connect.sqlite）。
 * 之前 Brain 侧在 BRAIN 库（runtime/dsh-home/dafeiyu-memory.sqlite）另建了一张同构表，
 * 导致事件流分叉、桌面那一半在看板上完全不可见。
 *
 * 职责边界：
 * - CONNECT 库：agent_events（事件流）+ 任务/工具/技能等运行时状态。
 * - BRAIN 库：memories / daily_memory_events / identity / life / goals 等认知域数据。
 *
 * 任何进程要写事件，都从这里拿连接，不要自己再开一张表。
 */
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { initAgentEvents } from '../agent-events.mjs';

/**
 * 打开 CONNECT 事件库。
 *
 * 注意：这里**不**跑版本化迁移——CONNECT 库的迁移归 `connect/server.mjs` 所有，
 * 事件库只是另一个进程/连接，避免两个进程同时 BEGIN IMMEDIATE 抢锁。
 * `initAgentEvents` 是幂等的（CREATE TABLE IF NOT EXISTS + ensureColumn），重复调用安全。
 *
 * @param {string} runtimeRoot runtime 根目录（含 connect/ 子目录的父目录）
 * @returns {import('node:sqlite').DatabaseSync}
 */
export function openEventStore(runtimeRoot) {
  const dir = join(runtimeRoot, 'connect');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'connect.sqlite');
  const db = new DatabaseSync(file);
  if (process.platform !== 'win32') {
    try { chmodSync(dir, 0o700); chmodSync(file, 0o600); } catch {}
  }
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  initAgentEvents(db);
  return db;
}
