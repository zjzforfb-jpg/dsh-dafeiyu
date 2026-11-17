import { createServer } from 'node:http';
import { runtimeDir } from './core/paths.mjs';
import { createReadStream, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { boardList, boardSnapshot } from './board.mjs';
import { openDouyinDb, updateDraft } from './douyin/store.mjs';
import { BOARD_PAGE } from './board-page.mjs';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, realpathSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { basename, extname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer, WebSocket } from 'ws';
import { IlinkGateway } from './ilink/gateway.mjs';
import { initInbox, contacts, policy, saveContact, acceptDeviceEvent, eventRows } from './inbox.mjs';
import { loadQqConfig, QqApi } from './qq/api.mjs';
import { openQqMemory } from './qq/memory.mjs';
import { QqService } from './qq/service.mjs';
import { CALL_PAGE, CallService } from './call/service.mjs';
import { buildFeed } from './messages/feed.mjs';
import { MESSAGES_PAGE } from './messages/page.mjs';
import { peer as qqPeer, savePeer as saveQqPeer, peers as qqPeers, syncQqOwner } from './qq/store.mjs';
import { loadTargets } from './targets.mjs';
import { LocalVoice } from './voice/local.mjs';
import { cancelTask, initTasks, listTasks, task, proposeTask, approvePendingTask, startTask, markAwaitingPublish } from './tasks.mjs';
import { prepareDraft, proposePublishTask } from './core/publish.mjs';
import { ensureSkillDefs } from './skills/ledger.mjs';
import { stepsForRun } from './skills/steps.mjs';
import { startScheduler, readTargets } from './scheduler.mjs';
import { formatDraftReview } from './douyin/review.mjs';
import { readMood, writeMood } from './douyin/mood.mjs';
import { probePreflight, systemProbes } from './live/preflight.mjs';
import { canRunFromUi, loadRunAllowlist, grantTemporarily, grantPermanently, isSafeToSelfGrant, allowlistSnippet, writeAllowlistNote, GRANT_MINUTES } from './live/run-policy.mjs';
import { recordRun } from './live/run-log.mjs';
import { runAction } from './actions.mjs';
import { runTool } from './qq/tools.mjs';
import { verifyAfter } from './live/verify-after.mjs';
import { evaluateOutcome } from './core/verify.mjs';
import { recordCheckpoint } from './core/checkpoints.mjs';
import { commentQuota } from './live/quota.mjs';
import { projectRoot } from './core/paths.mjs';
import { previewWithProbes } from './live/dry-run.mjs';
import { attachLiveStream, earlierEvents, eventDetail as liveEventDetail, eventsForTask, liveSnapshot, slotList as liveSlotList, taskDetail as liveTaskDetail, toolList as liveToolList } from './live/api.mjs';
import { renderEvidence } from './live/evidence.mjs';
import { TOOL_META } from './live/tool-meta.mjs';

const COMFORT_LINES = [
  '爸爸别急，我陪着你呢，深呼吸一下～🐟',
  '今天是不是有点累呀？我把我最喜欢的那块键盘角让给你靠一靠。',
  '我刚刚给自己打了打气，也给爸爸打一打：你已经做得很好啦。',
  '不开心就先不干活，我们蹲一会儿，看会儿鱼缸。',
];
import { CAPABILITY_MATRIX, interactionEvent } from './core-contract.mjs';
import { recordObservation } from './observability.mjs';
import { initAgentEvents, recordAgentEvent, listAgentEvents } from './agent-events.mjs';
import { createWorkingTask, listWorkingTasks, recoverWorkingTask, updateWorkingTask, workingTask } from './working-state.mjs';
import { attachObservation, observeAndroidTask, observeWorkingTask } from './environment-observer.mjs';
import { initSkills, listSkills } from './skills.mjs';
import { listReflections, validateReflection } from './reflection.mjs';
import { initStrategies, strategyStats } from './strategies.mjs';
import { planWorkingTask, preparePlanStep } from './cognition-bridge.mjs';
import { confirmFactCandidate, extractFactCandidates, initFactCandidates, listFactCandidates, listFactConflicts, rejectFactCandidate, restoreMemoryFact } from './fact-candidates.mjs';
import { initPerformance, performanceStats, recordPerformance } from './performance.mjs';
import { migrateConnect } from './core/migrations.mjs';
import { flowSummary } from './flow/summary.mjs';
import { openHub } from './memory-hub.mjs';
import { advancePlan } from '../brain/cognition/kernel.mjs';

export const APPS = Object.freeze({ settings: 'com.android.settings', wechat: 'com.tencent.mm', douyin: 'com.ss.android.ugc.aweme', companion: 'com.dafeiyu.companion' });
export function loadConnectConfig(root) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const file = join(root, 'credentials.json');
  if (!existsSync(file)) writeFileSync(file, JSON.stringify({ adminToken: randomBytes(32).toString('hex'), devices: { honor_magic5: randomBytes(32).toString('hex') } }, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
  return JSON.parse(readFileSync(file, 'utf8'));
}
function equal(a, b) { return typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
function safeQqStatus(qq) {
  try {
    if (!qq) return { state: 'disabled' };
    const status = qq.status();
    const gateway = qq.state ?? qq.gateway?.state ?? null;
    return { state: typeof gateway === 'string' ? gateway : (status.peers?.length ? 'online' : 'unknown'), peers: status.peers?.length ?? 0, usage: status.usage ?? null };
  } catch (error) { return { state: 'error', error: error.message }; }
}

function sendFile(res, file) {
  const type = file.endsWith('.png') ? 'image/png' : file.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
  res.writeHead(200, { 'content-type': type, 'cache-control': 'max-age=60' });
  return createReadStream(file).pipe(res);
}

function fileForCover(root, key) {
  const base = resolve(root, 'runtime', 'douyin');
  const file = resolve(base, key.replace(/^\/+/, '').replace(/^runtime\/douyin\//, ''));
  if (!file.startsWith(base + '/')) return null;
  try { return statSync(file).isFile() ? file : null; } catch { return null; }
}

async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body_too_large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text ? JSON.parse(text) : {};
}

function json(res, status, data) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); }
async function body(req) {
  let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 16384) throw new Error('request too large'); }
  return JSON.parse(raw);
}
// 架构可视化页（GET /arch）：three.js 已 vendor 进 connect/arch/vendor/，不依赖外网 CDN。
const ARCH_ROOT = join(import.meta.dirname, 'arch');
// 实时工作流控制台（GET /live）：纯 DOM + SSE，静止时不渲染。
const LIVE_ROOT = join(import.meta.dirname, 'live');
const FLOW_ROOT = join(import.meta.dirname, 'flow');
const HOME_ROOT = join(import.meta.dirname, 'home');
// 四个页面共用的 title bar（/shell/nav.css + /shell/nav.js），只此一份。
const SHELL_ROOT = join(import.meta.dirname, 'shell');
/** 事件里带一行「消息前 80 字」，页面上不点开也能看到说了什么。 */
function clipText(text, max = 80) {
  const flat = String(text ?? '').replace(/\s+/gu, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

const ARCH_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
});
/** 只放行 connect/arch/ 下的白名单文件，拒绝目录穿越。 */
function serveArch(res, pathname) {
  return serveStatic(res, ARCH_ROOT, '/arch', pathname);
}

/** 通用静态服务：白名单扩展名 + realpath 防穿越 + no-store。给 /arch 与 /live 共用。 */
function serveStatic(res, root, prefix, pathname) {
  const rel = pathname === prefix || pathname === `${prefix}/` ? 'index.html' : pathname.slice(`${prefix}/`.length);
  if (!rel || rel.includes('..') || rel.includes('\0')) return json(res, 400, { error: 'bad_path' });
  const full = join(root, rel);
  const type = ARCH_TYPES[extname(full).toLowerCase()];
  if (!type) return json(res, 404, { error: 'not_found' });
  let stat;
  try { stat = statSync(full); } catch { return json(res, 404, { error: 'not_found' }); }
  if (!stat.isFile()) return json(res, 404, { error: 'not_found' });
  try { if (!realpathSync(full).startsWith(realpathSync(root) + sep)) return json(res, 404, { error: 'not_found' }); }
  catch { return json(res, 404, { error: 'not_found' }); }
  res.writeHead(200, { 'content-type': type, 'content-length': stat.size, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  createReadStream(full).pipe(res);
}

const iqPeer = data => Boolean(data) && ['c2c', 'group'].includes(data.kind) && typeof data.id === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(data.id);
const allowedQqPeer = (db, kind, id) => { const value = qqPeer(db, kind, id); return Boolean(value?.enabled && value.autoReply); };

function draftShape(row) {
  let images = [];
  try { images = JSON.parse(row?.images ?? '[]'); } catch { images = []; }
  let settings = null;
  try { settings = row?.settings ? JSON.parse(row.settings) : null; } catch { settings = null; }
  return {
    id: row?.id, title: row?.title, caption: row?.caption, topics: row?.topics,
    images, image: row?.image_file, settings, status: row?.status, draftFile: row?.draft_file,
  };
}

function syncDraftFile(projectRoot, row) {
  const file = row?.draft_file;
  if (!file) return;
  try {
    const cur = JSON.parse(readFileSync(file, 'utf8'));
    const shape = draftShape(row);
    writeFileSync(file, JSON.stringify({
      ...cur,
      title: shape.title,
      caption: shape.caption,
      topics: String(shape.topics ?? '').split(/\s+/).filter(Boolean),
      imageFile: shape.image,
      images: shape.images,
      settings: shape.settings ?? cur.settings ?? null,
    }, null, 2));
  } catch {}
}

export async function startConnect({ root, port = 8765, config = loadConnectConfig(root), onEvent = async () => {}, ilinkClient, askIlink, askQq, askCall, askCallStream = null, voiceRoot, home = null, qq: qqEnabled = true }) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // 前置核验结果缓存 20 秒：探针要问 adb / pgrep / 窗口列表，别让每次点按钮都全量重跑
  const preflightCache = { at: 0, data: null };
  const db = new DatabaseSync(join(root, 'connect.sqlite'));
  chmodSync(join(root, 'connect.sqlite'), 0o600);
  db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, model TEXT, last_seen TEXT);
    CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, action TEXT NOT NULL, payload TEXT NOT NULL,
    status TEXT NOT NULL, expires_at TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    UPDATE commands SET status='unknown' WHERE status='dispatched';`);
  initAgentEvents(db);
  initSkills(db);
  initStrategies(db);
  try { ensureSkillDefs(root); } catch (error) { console.error(JSON.stringify({ skill_defs_failed: String(error?.message ?? error).slice(0, 120) })); }
  initFactCandidates(db);
  initPerformance(db);
  initInbox(db);
  initTasks(db);
  // 计划 A-8：版本化迁移（升级前自动 VACUUM INTO 备份到 runtime/backups）
  try {
    const migration = migrateConnect(db, { backupDir: join(root, '..', 'backups') });
    if (migration.applied.length) console.error(JSON.stringify({ connect_migrations: migration.applied, backup: migration.backup }));
  } catch (error) {
    console.error(JSON.stringify({ connect_migration_failed: String(error?.message ?? error).slice(0, 200) }));
  }
  db.prepare("DELETE FROM communication_events WHERE created_at < datetime('now','-7 days')").run();
  const ilink = new IlinkGateway({db,root,voiceRoot,client:ilinkClient,ask:askIlink});
  const localVoice = new LocalVoice({ root: voiceRoot ?? join(root, 'voice') });
  const calls = new CallService({
    voice: localVoice,
    ask: askCall ?? (async () => { throw new Error('call_brain_not_configured'); }),
    askStream: askCallStream ?? null,
    log: value => console.error(JSON.stringify(value)),
    onHangup: async () => {
      try {
        const { ensureBinaries } = await import('./macui/index.mjs');
        const { hangup } = await import('./macui/qq.mjs');
        await hangup(ensureBinaries(root));
      } catch (error) { console.error(JSON.stringify({ hangup: false, error: error.message })); }
    },
    // D-3：通话接入完整事件流——一次通话轮次在 agent_events 里留 message_received / message_replied，
    // 走 interactionEvent（ingest 适配器）+ recordAgentEvent，和 QQ/iLink 同一套事件流。owner 的电话按私聊主人处理。
    onEvent: ({ eventType, sessionId, text, reply }) => {
      try {
        const interaction = interactionEvent({ channel: 'call', conversationId: sessionId, senderId: 'owner', senderRole: 'owner', text: text ?? '', inputKind: 'voice', sourceEventId: `call:${sessionId}:${eventType}:${Date.now()}` });
        recordAgentEvent(db, {
          id: `${interaction.event_id}:${eventType}`,
          eventType,
          channel: 'call',
          conversationId: sessionId,
          actor: eventType === 'message_received' ? 'owner' : 'assistant',
          traceId: interaction.trace_id,
          payload: { trace_id: interaction.trace_id, input_kind: 'voice', text_length: String(text ?? '').length, preview: clipText(eventType === 'message_replied' ? reply : text) },
          result: eventType === 'message_replied' ? { ok: Boolean(reply) } : undefined,
          privacyScope: interaction.trust.source_class,
          dedupeKey: `${interaction.event_id}:${eventType}`,
        });
      } catch {}
    },
  });
  let qq = null, qqError = null, qqMemory = null;
  if (qqEnabled && home) { try { qqMemory = openQqMemory(home); } catch (error) { qqError = `memory:${error.message}`; } }
  if (qqEnabled) {
    try {
      const credentials = loadQqConfig(root);
      if (credentials) {
        qq = new QqService({ db, voice: localVoice, api: new QqApi(credentials), ask: askQq ?? (async () => { throw new Error('qq_brain_not_configured'); }), WebSocketImpl: WebSocket, memory: qqMemory, home, groupReplyRate: Number(process.env.QQ_GROUP_REPLY_RATE ?? 0.08), groupCooldownMs: Number(process.env.QQ_GROUP_COOLDOWN_MS ?? 90000), log: value => console.error(JSON.stringify(value)) });
        syncQqOwner(db, loadTargets(resolve(root, '../..')).qq.dad);
        qq.start().catch(error => { qqError = error.message; });
      }
    } catch (error) { qqError = error.message; }
  }
  // 日程大脑：每天给自己排活、到点执行；DAFEIYU_SCHEDULER=0 可临时关掉。
  let scheduler = null;
  if (process.env.DAFEIYU_SCHEDULER !== '0') {
    try {
      scheduler = startScheduler({
        db, root, home,
        execute: (name, options) => runAction(name, options),
        notify: async ({ kind, id, text, image = null, fallbackText = null }) => {
          if (!qq) return;
          try {
            // 二审要带配图：先把大图压成适合 QQ 的 jpeg 再发。
            if (kind === 'c2c' && image) {
              try {
                const { execFileSync } = await import('node:child_process');
                const { mkdirSync } = await import('node:fs');
                const dir = resolve(root, '..', 'douyin', 'images');
                mkdirSync(dir, { recursive: true });
                const preview = join(dir, `daily-${Date.now()}.jpg`);
                execFileSync('sips', ['-Z', '1440', '-s', 'format', 'jpeg', image, '--out', preview], { stdio: 'ignore' });
                const { readFileSync: read } = await import('node:fs');
                await qq.api.sendImage({ kind, id, file: read(preview), fileName: preview.split('/').pop() });
              } catch { /* 图发不出去也继续发文字 */ }
            }
            if (kind === 'c2c') { if (await qq.sendTextSafe(kind, id, text, null)) return; }
            else { await qq.api.sendText({ kind, id, content: text }); return; }
          } catch {}
          // 主动消息被 QQ 拒（40034105）：群里先排队，等这个会话下一条消息进来再补发；
          // 同时私聊跟爸爸说一声，不让事情悄无声息。
          if (kind === 'group') {
            const { queueOutbox } = await import('./qq/outbox.mjs');
            queueOutbox(db, { kind, id, text, key: `out:${kind}:${id}:${text.slice(0, 24)}:${new Date().toISOString().slice(0, 10)}` });
            let dad = null;
            try { dad = JSON.parse(readFileSync(join(root, 'targets.json'), 'utf8'))?.qq?.dad ?? null; } catch {}
            if (dad) await qq.sendTextSafe('c2c', dad, fallbackText ?? '群里的消息被 QQ 挡住了，先排队，群里有人说话我就补发。', null);
          }
        },
        logger: (value) => console.error(JSON.stringify(value)),
      });
    } catch (error) { console.error(JSON.stringify({ scheduler: false, error: error.message })); }
  }
  const sessions = new Map();
  let lastObservation=0;
  // ── 架构图实时事件流：SSE 只吐元数据（类型/渠道/任务 id），不吐 payload 正文 ──
  const archClients = new Set();
  let archRowid = (() => { try { return Number(db.prepare('SELECT MAX(rowid) AS id FROM agent_events').get()?.id ?? 0); } catch { return 0; } })();
  const archSend = (res, payload) => { try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch {} };
  const archSnapshot = () => {
    const channels = {};
    try { for (const row of db.prepare('SELECT channel, COUNT(*) AS n FROM agent_events GROUP BY channel').all()) channels[row.channel] = Number(row.n); } catch {}
    let tasks = 0;
    try { tasks = Number(db.prepare("SELECT COUNT(*) AS n FROM agent_events WHERE event_type IN ('plan_created','task_state_changed')").get()?.n ?? 0); } catch {}
    return { channels, totals: { tasks } };
  };
  const archStream = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 3000\n\n');
    archRowid = Math.max(archRowid, (() => { try { return Number(db.prepare('SELECT MAX(rowid) AS id FROM agent_events').get()?.id ?? 0); } catch { return 0; } })());
    archSend(res, { type: 'hello', ...archSnapshot(), recent: archRecent() });
    archClients.add(res);
    const tick = setInterval(() => {
      try {
        const rows = db.prepare('SELECT rowid AS rid, id, event_type, channel, task_id, created_at FROM agent_events WHERE rowid > ? ORDER BY rowid LIMIT 40').all(archRowid);
        for (const row of rows) {
          archRowid = Number(row.rid);
          archSend(res, { type: 'event', event: { id: row.id, eventType: row.event_type, channel: row.channel, taskId: row.task_id, createdAt: row.created_at } });
        }
        archSend(res, { type: 'stats', ...archSnapshot() });
      } catch {}
    }, 1500);
    tick.unref?.();
    const close = () => { clearInterval(tick); archClients.delete(res); };
    req.on('close', close);
    res.on('close', close);
  };
  const archRecent = (limit = 6) => {
    try { return db.prepare('SELECT id, event_type AS eventType, channel, task_id AS taskId, created_at AS createdAt FROM agent_events ORDER BY rowid DESC LIMIT ?').all(limit).reverse(); }
    catch { return []; }
  };
  // ── 任务详情：点 ticker 行时右侧抽屉要看的「这条任务到底走到哪一步」 ──
  // payload/result 只给摘要（白名单键 + 截断），不把整段正文塞进页面。
  const ARCH_DIGEST_KEYS = ['status', 'working_status', 'operation', 'detail', 'summary', 'reason', 'error', 'step', 'steps', 'skill', 'action', 'adapter', 'next_action', 'working_status'];
  const archTrim = (value, max = 120) => {
    const text = String(value).replace(/\s+/gu, ' ').trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  };
  const archDigest = (raw) => {
    if (raw === null || raw === undefined || raw === '') return null;
    let value = raw;
    if (typeof raw === 'string') {
      const text = raw.trim();
      if (!text.startsWith('{') && !text.startsWith('[')) return archTrim(text);
      try { value = JSON.parse(text); } catch { return archTrim(text); }
    }
    if (!value || typeof value !== 'object') return archTrim(value);
    const parts = [];
    const seen = new Set();
    for (const key of ARCH_DIGEST_KEYS) {
      const item = value[key];
      if (item === undefined || item === null || item === '') continue;
      if (typeof item === 'object') continue;
      const text = archTrim(item, 80);
      const signature = text.toLowerCase();
      if (seen.has(signature)) continue; // status/working_status 常常同值，别在抽屉里重复两遍
      seen.add(signature);
      parts.push(`${key}=${text}`);
      if (parts.length >= 4) break;
    }
    if (!parts.length) {
      const keys = Object.keys(value).slice(0, 4);
      if (keys.length) parts.push(keys.map((key) => `${key}…`).join(' / '));
    }
    return parts.length ? archTrim(parts.join(' · '), 160) : null;
  };
  const archEventView = (row) => ({
    id: row.id,
    eventType: row.event_type,
    channel: row.channel,
    actor: row.actor ?? null,
    taskId: row.task_id ?? null,
    createdAt: row.created_at,
    summary: archDigest(row.result) ?? archDigest(row.payload) ?? null,
  });
  const archTaskDetail = (id) => {
    const task = db.prepare('SELECT id, intent, status, origin, conv_kind, conv_id, attempts, created_ms, updated_ms, evidence FROM external_tasks WHERE id = ?').get(id) ?? null;
    const working = db.prepare('SELECT task_id, goal, status, environment, current_step, selected_skill, next_action, retry_count, created_ms, updated_ms FROM working_tasks WHERE task_id = ?').get(id) ?? null;
    const events = db.prepare('SELECT id, event_type, channel, actor, task_id, payload, result, created_at FROM agent_events WHERE task_id = ? ORDER BY rowid LIMIT 200').all(id).map(archEventView);
    if (!task && !working && !events.length) return null;
    return {
      id,
      task: task ? { id: task.id, intent: task.intent, status: task.status, origin: task.origin, convKind: task.conv_kind, convId: task.conv_id, attempts: task.attempts, createdAt: task.created_ms, updatedAt: task.updated_ms } : null,
      working: working ? { goal: working.goal, status: working.status, environment: working.environment, currentStep: working.current_step, skill: working.selected_skill, nextAction: working.next_action, retries: working.retry_count, createdAt: working.created_ms, updatedAt: working.updated_ms } : null,
      events,
    };
  };
  const archPulse = (event) => { for (const client of archClients) archSend(client, { type: 'event', event }); };
  const sendPolicy = id => {
    const ws = sessions.get(id);
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(policy(db, id)));
  };
  const snapshot = () => Object.keys(config.devices).map(id => ({ id, online: sessions.has(id), connected_at: sessions.get(id)?.connectedAt ?? null, ...(db.prepare('SELECT model, last_seen FROM devices WHERE id=?').get(id) ?? {}), capabilities: JSON.parse(db.prepare('SELECT capabilities FROM device_capabilities WHERE device_id=?').get(id)?.capabilities ?? '{}'), policy_revision: policy(db,id).revision }));
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    if (path.startsWith('/ilink/bind/') && await ilink.public(req,res,path,body,server.address().port)) return;
    if (path === '/health' && req.method === 'GET') return json(res, 200, { ok: true, service: 'DaFeiYu Connect', version: '0.3' });
    if (path === '/api/board/auth' && req.method === 'GET') return equal(req.headers.authorization, `Bearer ${config.adminToken}`)
      ? json(res, 200, { ok: true }) : json(res, 401, { error: 'unauthorized' });
    if (((path === '/api/board' || path.startsWith('/api/board/')) && path !== '/api/board/auth')
      || (req.method === 'POST' && path === '/api/academy/reset')) {
      if (!equal(req.headers.authorization, `Bearer ${config.adminToken}`)) return json(res, 401, { error: 'unauthorized' });
    }
    if (path === '/board' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(BOARD_PAGE); }
    // 没有尾斜杠时相对路径会解析到站点根目录（importmap/模块全挂），统一跳到 /arch/。
    if (path === '/arch' && req.method === 'GET') { res.writeHead(302, { location: '/arch/', 'cache-control': 'no-store' }); return res.end(); }
    if ((path === '/arch' || path.startsWith('/arch/')) && req.method === 'GET') return serveArch(res, path);
    if (path === '/api/arch/stream' && req.method === 'GET') return archStream(req, res);
    // 浏览器要用的「纯数据」核心模块（九段流水线是唯一真源，/live 与 /home 都从它派生）。
    // 只放这一个文件，别把 connect/core/ 整个目录暴露出去。
    if (path === '/core/pipeline.mjs' && req.method === 'GET') {
      return serveStatic(res, join(import.meta.dirname, 'core'), '/core', path);
    }
    // /flow 页面的一次性汇总（公开，只给事件类型/时间/判定，不含 payload）
    if (path === '/api/flow/summary' && req.method === 'GET') {
      try { return json(res, 200, flowSummary(db)); } catch (error) { return json(res, 500, { error: error.message }); }
    }
    if (path === '/api/arch/task' && req.method === 'GET') {
      const id = String(url.searchParams.get('id') ?? '');
      if (!/^[0-9a-zA-Z_.:-]{4,120}$/.test(id)) return json(res, 400, { error: 'bad_id' });
      const detail = archTaskDetail(id);
      return detail ? json(res, 200, detail) : json(res, 404, { error: 'not_found' });
    }
    if (path === '/api/arch/event' && req.method === 'GET') {
      const id = String(url.searchParams.get('id') ?? '');
      if (!/^[0-9a-zA-Z_.:-]{4,120}$/.test(id)) return json(res, 400, { error: 'bad_id' });
      const row = db.prepare('SELECT id, event_type, channel, actor, task_id, payload, result, created_at FROM agent_events WHERE id = ?').get(id);
      return row ? json(res, 200, { event: archEventView(row) }) : json(res, 404, { error: 'not_found' });
    }
    if (path === '/home' && req.method === 'GET') { res.writeHead(302, { location: '/home/', 'cache-control': 'no-store' }); return res.end(); }
    if ((path === '/home' || path.startsWith('/home/')) && req.method === 'GET') return serveStatic(res, HOME_ROOT, '/home', path);
    if (path === '/live' && req.method === 'GET') { res.writeHead(302, { location: '/live/', 'cache-control': 'no-store' }); return res.end(); }
    if ((path === '/live' || path.startsWith('/live/')) && req.method === 'GET') return serveStatic(res, LIVE_ROOT, '/live', path);
    if (path === '/flow' && req.method === 'GET') { res.writeHead(302, { location: '/flow/', 'cache-control': 'no-store' }); return res.end(); }
    if ((path === '/flow' || path.startsWith('/flow/')) && req.method === 'GET') return serveStatic(res, FLOW_ROOT, '/flow', path);
    if (path.startsWith('/shell/') && req.method === 'GET') return serveStatic(res, SHELL_ROOT, '/shell', path);
    if (path.startsWith('/api/live')) {
      // 令牌可以从 Authorization 头来，也可以从 ?token= 来（EventSource 不能带自定义头）。
      const liveOk = () => equal(req.headers.authorization, `Bearer ${config.adminToken}`) || equal(String(url.searchParams.get('token') ?? ''), config.adminToken);
      if (!liveOk()) return json(res, 401, { error: 'unauthorized' });
      if (path === '/api/live/stream' && req.method === 'GET') { attachLiveStream(db, req, res, { extra: () => ({ commentQuota: commentQuota(root) }) }); return; }
      if (path === '/api/live/snapshot' && req.method === 'GET') {
        try { return json(res, 200, liveSnapshot(db, Date.now(), { commentQuota: commentQuota(root) })); }
        catch (error) { return json(res, 500, { error: error.message }); }
      }
      if (path === '/api/live/preview' && req.method === 'GET') {
        // 预演：不执行动作，只把命令/影响/核对点/当前前置摆出来
        try {
          const params = new URL(req.url, 'http://x').searchParams;
          const action = String(params.get('action') ?? '');
          if (!action) return json(res, 400, { error: 'action_required' });
          const list = liveToolList(db, Date.now());
          const item = (list.items ?? []).find((entry) => entry.action === action)
            ?? (list.items ?? []).find((entry) => entry.tool === action);
          if (!item) return json(res, 404, { error: 'unknown_action', action });
          return json(res, 200, await previewWithProbes(action, item, { root }));
        } catch (error) { return json(res, 500, { error: error.message }); }
      }
      if (path === '/api/live/note' && req.method === 'POST') {
        // 放行清单的一句话备注：过一周回头看，知道当初为什么开这个口子
        let body = {};
        try { body = await readJsonBody(req); } catch { return json(res, 400, { error: 'bad_json' }); }
        const written = writeAllowlistNote(body.note ?? '', { root });
        recordAgentEvent(db, {
          eventType: 'run_granted', channel: 'system', actor: 'live-ui',
          payload: { note: written.note, summary: written.note ? `放行清单备注：${written.note}` : '清空放行清单备注' },
          dedupeKey: `note:${Date.now()}`,
        });
        return json(res, 200, { ok: true, note: written.note });
      }
      if (path === '/api/live/events' && req.method === 'GET') {
        // 事件流只加载最近 26 条；这里按 before=id 往前翻页
        try {
          const params = new URL(req.url, 'http://x').searchParams;
          const beforeRowid = params.get('beforeRowid');
          if (!beforeRowid) return json(res, 400, { error: 'beforeRowid_required' });
          return json(res, 200, { events: earlierEvents(db, { beforeRowid, limit: Number(params.get('limit') ?? 50) }) });
        } catch (error) { return json(res, 500, { error: error.message }); }
      }
      if (path === '/api/live/tools' && req.method === 'GET') {
        try {
          const real = new URL(req.url, 'http://x').searchParams.get('real') === '1';
          return json(res, 200, liveToolList(db, Date.now(), { realOnly: real }));
        }
        catch (error) { return json(res, 500, { error: error.message }); }
      }
      // 「跑完之后，副作用有没有真的发生」的检查（只读：查作品表 / call_ended / 草稿文件）
      if (path === '/api/live/verify' && req.method === 'GET') {
        const action = url.searchParams.get('action') ?? '';
        if (!/^[a-z][a-z0-9_.]{2,60}$/u.test(action)) return json(res, 400, { error: 'bad_action' });
        try {
          const result = await verifyAfter(action, { root, db, probes: systemProbes({ root }) });
          return json(res, 200, result);
        } catch (error) {
          return json(res, 500, { error: String(error.message ?? error) });
        }
      }
      // 「临时放行 30 分钟」：只对只读工具或已 confirmed 的动作开放，到点自动失效
      if (path === '/api/live/grant' && req.method === 'POST') {
        let body = {};
        try { body = await readJsonBody(req); } catch { return json(res, 400, { error: 'bad_json' }); }
        const action = String(body.action ?? '');
        if (!action) return json(res, 400, { error: 'action_required' });
        let lastVerdict = null;
        try {
          lastVerdict = db.prepare("SELECT verdict FROM task_checkpoints WHERE operation = ? ORDER BY id DESC LIMIT 1").get(action)?.verdict ?? null;
        } catch { /* 空库 */ }
        const safe = isSafeToSelfGrant(action, { lastVerdict });
        if (!safe.ok) {
          return json(res, 403, { error: safe.reason, action, snippet: allowlistSnippet(action) });
        }
        const allow = loadRunAllowlist(root);
        // mode=permanent：写进 allowed（永久直到改回）；否则写有时限的 grants
        if (String(body.mode ?? '') === 'permanent') {
          const written = grantPermanently(action, { root, allowed: allow.allowed, grants: allow.grants });
          recordAgentEvent(db, {
            eventType: 'run_granted', channel: 'system', actor: 'live-ui',
            payload: { action, permanent: true, why: safe.reason, summary: `永久放行 ${action}` },
            dedupeKey: `grant:${action}:permanent`,
          });
          return json(res, 200, { ok: true, action, permanent: true, why: safe.reason, allowed: written.allowed });
        }
        const granted = grantTemporarily(action, {
          root, minutes: Number(body.minutes ?? GRANT_MINUTES), allowed: allow.allowed, grants: allow.grants,
        });
        if (!granted.ok) return json(res, 403, { error: granted.reason, action });
        recordAgentEvent(db, {
          eventType: 'run_granted', channel: 'system', actor: 'live-ui',
          payload: { action, until: granted.until, minutes: Math.round((granted.until - Date.now()) / 60000), why: safe.reason, summary: `临时放行 ${action}（${Math.round((granted.until - Date.now()) / 60000)} 分钟）` },
          dedupeKey: `grant:${action}:${Math.floor(granted.until / 60000)}`,
        });
        return json(res, 200, { ok: true, action, until: granted.until, why: safe.reason });
      }

      // 「在页面上真的跑一次」：默认全关，主人在 runtime/connect/live-run.json 里点名才放行
      if (path === '/api/live/run' && req.method === 'POST') {
        let body = {};
        try { body = await readJsonBody(req); } catch { return json(res, 400, { error: 'bad_json' }); }
        const action = String(body.action ?? '');
        if (body.confirm !== 'run') return json(res, 400, { error: 'need_confirm' });
        const allow = loadRunAllowlist(root);
        let ready = null;
        try {
          const probe = await probePreflight({ root, actions: [action] });
          ready = probe?.results?.[action]?.ready ?? null;
        } catch { /* 拿不到就按未知处理，不阻塞只读动作 */ }
        const verdict = canRunFromUi(action, { allowed: allow.allowed, grants: allow.grants, ready });
        if (!verdict.ok) return json(res, 403, { error: verdict.reason, allowed: allow.allowed.length });
        try {
          const started = Date.now();
          const result = verdict.readOnly
            ? await runTool({ tool: action, args: body.args ?? {} }, { root })
            : await runAction(action, body.args ?? {}, { root });
          const elapsed = Date.now() - started;
          // 页面点着跑的也要进判定链：不然它只写事件、不进覆盖度与「最近一次」，等于两条账
          const judged = verdict.readOnly
            ? { verdict: 'confirmed', reason: 'ok_text', evidence: {} }
            : evaluateOutcome({ operation: action, result, receipt: {} });
          const taskId = `ui-run-${started}`;
          try {
            recordCheckpoint(db, {
              taskId, stage: 'execute', stepKey: `ui:${action}`, stepIndex: 0, operation: action,
              input: body.args ?? {},
              output: { text: result?.text ?? null, data: result?.data ?? null },
              verdict: judged.verdict, reason: judged.reason ?? '', ok: judged.verdict === 'confirmed',
            });
          } catch { /* 记不上账也不该让这次跑失败 */ }
          // 跑完立刻核对「副作用有没有真的发生」：页面上点一次就能看到判定 + 证据
          let after = null;
          try {
            after = await verifyAfter(action, { root, db, probes: systemProbes({ root }) });
          } catch { /* 核对不了不影响这次跑的结果 */ }
          recordAgentEvent(db, {
            eventType: 'action_finished', channel: 'system', actor: 'live-ui',
            payload: { operation: action, status: judged.verdict, reason: judged.reason ?? '', elapsed_ms: elapsed, source: 'ui_run', task_id: taskId },
            dedupeKey: `ui_run:${action}:${Math.floor(started / 60000)}`,
          });
          const afterView = after ? { verdict: after.verdict ?? 'unknown', reason: after.reason ?? '', checks: after.checks ?? [] } : null;
          // 留档：关掉页面再打开，还能看到「什么时候在页面上跑过、结果是什么」
          try {
            recordRun(root, {
              action, at: started, elapsedMs: elapsed, verdict: judged.verdict,
              reason: judged.reason ?? '', text: String(result?.text ?? ''), after: afterView,
            });
          } catch { /* 落档失败不影响这一次结果 */ }
          return json(res, 200, {
            ok: true, action, elapsedMs: elapsed, verdict: judged.verdict, reason: judged.reason ?? '',
            text: String(result?.text ?? '').slice(0, 2000), data: result?.data ?? null,
            after: afterView, taskId,
          });
        } catch (error) {
          return json(res, 500, { error: String(error.message ?? error) });
        }
      }

      // 「放行前能不能真跑」的机器核验（只读探针：adb / pgrep / 窗口列表 / 草稿目录）
      if (path === '/api/live/preflight' && req.method === 'GET') {
        const now = Date.now();
        if (!preflightCache.at || now - preflightCache.at > 20_000) {
          try {
            preflightCache.data = await probePreflight({ root });
            preflightCache.at = now;
          } catch (error) {
            preflightCache.data = { checkedAt: now, results: {}, error: String(error.message ?? error) };
            preflightCache.at = now;
          }
        }
        // 记一笔：谁在什么时候核验过、几项就绪、缺什么。10 分钟一个桶，避免刷页面把事件流灌满。
        // 只记「授权项」那 7 个：手机类 12 个动作也一并核验了，但混在一起数会变成「15/16」，
        // 与页面上的「授权项就绪 6/7」对不上。
        const results = Object.values(preflightCache.data?.results ?? {}).filter((entry) => entry.group === 'authorized');
        if (results.length) {
          const ready = results.filter((entry) => entry.ready).length;
          const bucket = Math.floor(Date.now() / 600_000);
          try {
            recordAgentEvent(db, {
              eventType: 'preflight_checked',
              channel: 'system',
              actor: 'preflight',
              payload: {
                ready,
                total: results.length,
                missing: results.filter((entry) => !entry.ready).map((entry) => entry.action),
              },
              dedupeKey: `preflight:${bucket}:${ready}/${results.length}`,
            });
          } catch { /* 记不上不影响核验结果 */ }
        }
        json(res, 200, preflightCache.data);
        return;
      }
      if (path === '/api/live/slots' && req.method === 'GET') {
        const day = String(url.searchParams.get('day') ?? new Date().toLocaleDateString('sv-SE'));
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json(res, 400, { error: 'bad_day' });
        try { return json(res, 200, liveSlotList(db, day)); }
        catch (error) { return json(res, 500, { error: error.message }); }
      }
      if (path === '/api/live/event' && req.method === 'GET') {
        const id = String(url.searchParams.get('id') ?? '');
        if (!/^[0-9a-zA-Z_.:-]{4,120}$/.test(id)) return json(res, 400, { error: 'bad_id' });
        const detail = liveEventDetail(db, id);
        return detail ? json(res, 200, detail) : json(res, 404, { error: 'not_found' });
      }
      if (path === '/api/live/evidence' && req.method === 'GET') {
        const id = String(url.searchParams.get('id') ?? '');
        if (!/^[0-9a-zA-Z_.:-]{4,120}$/.test(id)) return json(res, 400, { error: 'bad_id' });
        try {
          const rows = db.prepare("SELECT operation, verdict, reason, output_json, task_id, created_ms FROM task_checkpoints WHERE task_id = ? ORDER BY id DESC LIMIT 1").all(id);
          const row = rows[0];
          if (!row) return json(res, 404, { error: 'not_found' });
          const events = eventsForTask(db, id, 12);
          let output = {};
          try { output = JSON.parse(row.output_json ?? '{}') ?? {}; } catch { output = {}; }
          const markdown = renderEvidence({
            action: row.operation,
            at: row.created_ms,
            title: TOOL_META[row.operation]?.title ?? row.operation,
            verdict: row.verdict,
            reason: row.reason ?? '',
            elapsedMs: output.elapsedMs ?? 0,
            text: output.text ?? '',
            after: output.after ?? null,
            events,
            origin: String(row.task_id ?? '').startsWith('ui-run-') ? 'ui' : 'task',
          });
          return json(res, 200, { markdown, taskId: id, action: row.operation, verdict: row.verdict });
        } catch (error) {
          return json(res, 500, { error: String(error.message ?? error) });
        }
      }
      if (path === '/api/live/task' && req.method === 'GET') {
        const id = String(url.searchParams.get('id') ?? '');
        if (!/^[0-9a-zA-Z_.:-]{4,120}$/.test(id)) return json(res, 400, { error: 'bad_id' });
        const detail = liveTaskDetail(db, id);
        return detail ? json(res, 200, detail) : json(res, 404, { error: 'not_found' });
      }
      return json(res, 404, { error: 'not_found' });
    }
    if (path === '/api/arch/pulse' && req.method === 'POST') {
      if (!equal(req.headers.authorization, `Bearer ${config.adminToken}`)) return json(res, 401, { error: 'unauthorized' });
      return body(req).then((payload) => {
        const event = { eventType: String(payload?.eventType ?? 'message_received').slice(0, 60), channel: String(payload?.channel ?? 'system').slice(0, 40) };
        archPulse(event);
        return json(res, 202, { ok: true, delivered: archClients.size, event });
      }).catch(() => json(res, 400, { error: 'invalid request' }));
    }
    if (path === '/api/board' && req.method === 'GET') {
      try { return json(res, 200, boardSnapshot(db, resolve(root, '..', '..'), safeQqStatus(qq), Date.now())); }
      catch (error) { return json(res, 500, { error: error.message }); }
    }
    if (path === '/api/board/activity' && req.method === 'GET') {
      const id = String(url.searchParams.get('id') ?? '');
      if (!/^[0-9a-zA-Z_-]{6,80}$/.test(id)) return json(res, 400, { error: 'bad_id' });
      const row = db.prepare('SELECT * FROM agent_events WHERE id=?').get(id);
      if (!row) return json(res, 404, { error: 'not_found' });
      const parse = (value) => { try { return value ? JSON.parse(value) : null; } catch { return value; } };
      return json(res, 200, { ok: true, event: { ...row, payload: parse(row.payload), result: parse(row.result), evidence: parse(row.evidence) } });
    }
    if (path === '/api/board/skill-run' && req.method === 'GET') {
      const requested = String(url.searchParams.get('id') ?? '');
      if (!/^[0-9a-zA-Z_-]{4,80}$/.test(requested)) return json(res, 400, { error: 'bad_id' });
      const row = db.prepare('SELECT * FROM skill_runs WHERE id=?').get(requested);
      if (!row) return json(res, 404, { error: 'not_found' });
      const parse = (value) => { try { return value ? JSON.parse(value) : null; } catch { return value; } };
      let steps = [];
      try { steps = stepsForRun(db, requested); } catch {}
      return json(res, 200, { ok: true, run: { ...row, result: parse(row.result), environment: parse(row.environment) }, steps });
    }
    if (path === '/api/board/mood' && req.method === 'POST') {
      return body(req).then(async (payload) => {
        const action = String(payload?.action ?? '');
        const targets = readTargets(root);
        const dad = targets?.qq?.dad ?? null;
        const today = readMood(root);
        const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
        if (action === 'comfort') {
          const line = COMFORT_LINES[Math.floor(Math.random() * COMFORT_LINES.length)];
          if (dad) await qq.sendTextSafe('c2c', dad, line, null);
          return json(res, 200, { ok: true, action, text: line, sent: Boolean(dad) });
        }
        if (action === 'energy') {
          const energy = Math.min(1, Math.round(((today?.energy ?? 0.5) + 0.1) * 100) / 100);
          writeMood(root, { ...(today ?? {}), day, energy, why: '爸爸拍了拍我，给我充了点电' });
          try {
            db.prepare("INSERT INTO mood_history(day,mood,energy,valence,why,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(day) DO UPDATE SET energy=excluded.energy, why=excluded.why")
              .run(day, today?.mood ?? 'calm', energy, today?.valence ?? 0.55, '爸爸拍了拍我，给我充了点电', new Date().toISOString());
          } catch {}
          return json(res, 200, { ok: true, action, energy });
        }
        if (action === 'rest') {
          const info = db.prepare("UPDATE plan_slots SET status='skipped', note='今天少派活' WHERE day=? AND status='planned'").run(day);
          return json(res, 200, { ok: true, action, skipped: Number(info.changes ?? 0) });
        }
        return json(res, 400, { error: 'bad_action' });
      }).catch((error) => json(res, 500, { error: error.message }));
    }
    if (path === '/api/academy/reset' && req.method === 'POST') {
      try {
        const { openAcademyDb, resetAcademy } = await import('./academy/study.mjs');
        const academyDb = openAcademyDb(resolve(root, '..', '..'));
        try { resetAcademy(academyDb); } finally { academyDb.close(); }
        return json(res, 200, { ok: true });
      } catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (path === '/api/board/approve' && req.method === 'POST') {
      try {
        const id = new URL(req.url, 'http://localhost').searchParams.get('id');
        if (!id) return json(res, 400, { error: 'missing_id' });
        return json(res, 200, await qq.approveFromBoard(id, { adminAuthorized: true }));
      } catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (path === '/api/board/cancel' && req.method === 'POST') {
      try {
        const id = new URL(req.url, 'http://localhost').searchParams.get('id');
        if (!id) return json(res, 400, { error: 'missing_id' });
        return json(res, 200, await qq.cancelFromBoard(id));
      } catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (path === '/api/board/write' && req.method === 'POST') {
      try {
        const data = await body(req).catch(() => ({}));
        const theme = String(data?.theme ?? '').trim();
        // 第一段：写草稿。动作映射与两段式握手都在 connect/core/publish.mjs。
        const draftOutcome = await prepareDraft({
          operations: ['douyin.publish'],
          execute: (name, args) => runAction(name, { root, args }),
          args: theme ? { theme } : {},
        });
        if (!draftOutcome.ok) return json(res, 500, { ok: false, error: draftOutcome.errors[0] ?? 'draft_failed' });
        const draft = draftOutcome.data ?? {};
        const targets = readTargets(root);
        const convId = targets?.qq?.dad ?? 'owner';
        const now = Date.now();
        const taskRow = proposePublishTask({
          db,
          kind: 'c2c',
          convId,
          sourceMessageId: 'board',
          origin: 'board',
          expiresMs: now + 30 * 60_000,
          now,
          operations: ['douyin.publish'],
          source: 'board',
          requiresConfirmation: false,
        });
        const taskId = taskRow.id;
        approvePendingTask(db, taskId, 'owner', now);
        startTask(db, taskId, now);
        markAwaitingPublish(db, taskId, { prepared: { ...draft, stage: 'draft' }, now });
        try {
          const projectRoot = resolve(root, '..', '..');
          const draftDb = openDouyinDb(projectRoot);
          draftDb.prepare('UPDATE works SET task_id=? WHERE id=?').run(taskId, String(draft.draftId ?? ''));
          draftDb.close();
        } catch {}
        try {
          const review = `爸爸在网页上点了「写一条」🐟\n${formatDraftReview(draft)}`;
          if (await qq.sendTextSafe('c2c', convId, review, null)) {
            const file = draft.imageFile;
            if (file) {
              try {
                const preview = join(runtimeDir(root), 'douyin', 'preview.jpg');
                execFileSync('sips', ['-Z', '1440', '-s', 'format', 'jpeg', file, '--out', preview], { stdio: 'ignore' });
                const buffer = readFileSync(preview);
                if (buffer.length <= 6 * 1024 * 1024) await qq.api.sendImage({ kind: 'c2c', id: convId, file: buffer, fileName: basename(preview) });
              } catch {}
            }
          }
        } catch {}
        return json(res, 200, { ok: true, taskId, draft });
      } catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (path === '/api/board/draft' && req.method === 'POST') {
      try {
        const data = await body(req);
        const projectRoot = resolve(root, '..', '..');
        const draftDb = openDouyinDb(projectRoot);
        let row = null;
        try {
          row = updateDraft(draftDb, String(data?.id ?? ''), {
            title: data?.title, caption: data?.caption, topics: data?.topics, settings: data?.settings,
          });
        } finally { draftDb.close(); }
        if (!row) return json(res, 404, { ok: false, error: 'draft_not_found' });
        syncDraftFile(projectRoot, row);
        return json(res, 200, { ok: true, draft: draftShape(row) });
      } catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (path === '/api/board/draft/image' && req.method === 'POST') {
      try {
        const id = new URL(req.url, 'http://localhost').searchParams.get('id');
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 12 * 1024 * 1024) return json(res, 413, { ok: false, error: 'image_too_large' });
          chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);
        if (!buffer.length) return json(res, 400, { ok: false, error: 'empty_body' });
        const type = String(req.headers['content-type'] ?? 'image/png');
        const ext = type.includes('jpeg') ? 'jpg' : type.includes('webp') ? 'webp' : 'png';
        const projectRoot = resolve(root, '..', '..');
        const dir = join(projectRoot, 'runtime', 'douyin', 'images');
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const name = `board-${Date.now()}.${ext}`;
        writeFileSync(join(dir, name), buffer);
        const rel = `runtime/douyin/images/${name}`;
        const draftDb = openDouyinDb(projectRoot);
        let row = null;
        let images = [];
        try {
          const cur = draftDb.prepare('SELECT * FROM works WHERE id = ?').get(String(id ?? ''));
          if (cur?.status === 'draft') {
            try { images = JSON.parse(cur.images ?? '[]'); } catch { images = []; }
            // 一篇一张图：已经有图就替换掉旧的那张，不留多图（多图发布还没做通）
            for (const old of images) {
              if (!String(old).startsWith('runtime/douyin/images/')) continue;
              const oldPath = join(projectRoot, old);
              if (existsSync(oldPath) && old !== rel) { try { rmSync(oldPath, { force: true }); } catch {} }
            }
            images = [rel];
            row = updateDraft(draftDb, String(id), { images });
          }
        } finally { draftDb.close(); }
        if (!row) return json(res, 404, { ok: false, error: 'draft_not_found' });
        syncDraftFile(projectRoot, row);
        return json(res, 200, { ok: true, images, draft: draftShape(row) });
      } catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (path === '/api/board/draft/image/delete' && req.method === 'POST') {
      try {
        const data = await body(req);
        const projectRoot = resolve(root, '..', '..');
        const id = String(data?.id ?? '');
        const file = String(data?.file ?? '');
        const draftDb = openDouyinDb(projectRoot);
        let row = null;
        try {
          const cur = draftDb.prepare('SELECT * FROM works WHERE id = ?').get(id);
          if (cur?.status === 'draft') {
            let images = [];
            try { images = JSON.parse(cur.images ?? '[]'); } catch { images = []; }
            images = images.filter((f) => f !== file);
            row = updateDraft(draftDb, id, { images });
          }
        } finally { draftDb.close(); }
        if (!row) return json(res, 404, { ok: false, error: 'draft_not_found' });
        if (file.startsWith('runtime/douyin/images/') && existsSync(join(projectRoot, file))) {
          try { rmSync(join(projectRoot, file)); } catch {}
        }
        syncDraftFile(projectRoot, row);
        return json(res, 200, { ok: true, draft: draftShape(row) });
      } catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (path === '/api/board/draft/publish' && req.method === 'POST') {
      try {
        const id = new URL(req.url, 'http://localhost').searchParams.get('id');
        const rows = db.prepare("SELECT id, result FROM external_tasks WHERE status='awaiting_publish'").all();
        const hit = rows.find((row) => {
          try { return JSON.parse(row.result ?? '{}')?.draftId === id; } catch { return false; }
        });
        if (!hit) return json(res, 404, { ok: false, error: 'pending_task_not_found' });
        return json(res, 200, await qq.approveFromBoard(hit.id, { adminAuthorized: true }));
      } catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (path === '/api/board/list' && req.method === 'GET') {
      try {
        const params = new URL(req.url, 'http://localhost').searchParams;
        const section = params.get('section') ?? 'finished';
        const page = Number(params.get('page') ?? 1);
        const size = Number(params.get('size') ?? 8);
        const work = params.get('work') || null;
        const replied = params.get('replied') || null;
        return json(res, 200, boardList(db, resolve(root, '..', '..'), { section, page, size, work, replied }));
      } catch (error) { return json(res, 500, { error: error.message }); }
    }
    if (path.startsWith('/board/') && !path.startsWith('/board/cover/') && req.method === 'GET') {
      const name = decodeURIComponent(path.slice('/board/'.length));
      const base = resolve(root, '..', '..', 'connect', 'board');
      const file = resolve(base, name);
      const type = file.endsWith('.css') ? 'text/css; charset=utf-8' : file.endsWith('.mjs') || file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'application/octet-stream';
      if (file.startsWith(base + '/') && existsSync(file) && statSync(file).isFile()) {
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
        return res.end(readFileSync(file));
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    if (path.startsWith('/board/cover/') && req.method === 'GET') {
      const key = decodeURIComponent(path.slice('/board/cover/'.length));
      const file = fileForCover(resolve(root, '..', '..'), key);
      if (!file) return json(res, 404, { error: 'cover_not_found' });
      return sendFile(res, file);
    }
    if (path === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (path === '/call' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(CALL_PAGE); }
    if (path === '/messages' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(MESSAGES_PAGE); }
    if (!equal(req.headers.authorization, `Bearer ${config.adminToken}`)) return json(res, 401, { error: 'unauthorized' });
    if (path === '/messages/feed' && req.method === 'GET') { const params = new URL(req.url, 'http://localhost').searchParams; return json(res, 200, { items: buildFeed(db, Number(params.get('limit') ?? 60)) }); }
    if (path === '/capabilities' && req.method === 'GET') return json(res,200,{capabilities:CAPABILITY_MATRIX,generated_at:new Date().toISOString()});
    if (path === '/tasks' && req.method === 'GET') { const params=new URL(req.url,'http://localhost').searchParams; return json(res,200,{tasks:listTasks(db,{status:params.get('status')||undefined,limit:params.get('limit')})}); }
    if (path === '/agent-events' && req.method === 'GET') { const params=new URL(req.url,'http://localhost').searchParams; return json(res,200,{events:listAgentEvents(db,{taskId:params.get('task_id')||undefined,eventType:params.get('event_type')||undefined,limit:params.get('limit')})}); }
    if (path === '/working-tasks' && req.method === 'GET') { const params=new URL(req.url,'http://localhost').searchParams; return json(res,200,{tasks:listWorkingTasks(db,{status:params.get('status')||undefined,limit:params.get('limit')})}); }
    if (path === '/skills' && req.method === 'GET') { const params=new URL(req.url,'http://localhost').searchParams; return json(res,200,{skills:listSkills(db,{status:params.get('status')||undefined,limit:params.get('limit')})}); }
    if (path === '/reflections' && req.method === 'GET') { const params=new URL(req.url,'http://localhost').searchParams; return json(res,200,{reflections:listReflections(db,{status:params.get('status')||undefined,limit:params.get('limit')})}); }
    if (path === '/strategies/stats' && req.method === 'GET') return json(res,200,{strategies:strategyStats(db)});
    if (path === '/memory/fact-candidates' && req.method === 'GET') { const params=new URL(req.url,'http://localhost').searchParams; const hub=openHub(root); try { return json(res,200,{candidates:listFactCandidates(hub,{status:params.get('status')||'candidate',limit:params.get('limit')})}); } finally { hub.close(); } }
    if (path === '/memory/fact-candidates/extract' && req.method === 'POST') { try { const data=await body(req); const hub=openHub(root); try { return json(res,200,{ids:extractFactCandidates(hub,String(data.day))}); } finally { hub.close(); } } catch(error) { return json(res,400,{error:error.message}); } }
    if (/^\/memory\/fact-candidates\/[A-Za-z0-9_-]{1,180}\/confirm$/.test(path) && req.method === 'POST') { try { const data=await body(req).catch(()=>({})); const hub=openHub(root); try { const result=confirmFactCandidate(hub,path.split('/')[3],{reason:String(data.reason??'owner_confirmed')}); return json(res,result?200:404,result??{error:'not_found'}); } finally { hub.close(); } } catch(error) { return json(res,400,{error:error.message}); } }
    if (path === '/memory/fact-conflicts' && req.method === 'GET') { const hub=openHub(root); try { return json(res,200,{conflicts:listFactConflicts(hub)}); } finally { hub.close(); } }
    if (path === '/performance/stats' && req.method === 'GET') { const params=new URL(req.url,'http://localhost').searchParams; return json(res,200,performanceStats(db,{stage:params.get('stage')||undefined,channel:params.get('channel')||undefined})); }
    if (/^\/memory\/fact-candidates\/[A-Za-z0-9_-]{1,180}\/reject$/.test(path) && req.method === 'POST') { const hub=openHub(root); try { const result=rejectFactCandidate(hub,path.split('/')[3]); return json(res,result?200:404,result??{error:'not_found'}); } finally { hub.close(); } }
    if (/^\/memory\/facts\/[0-9]+\/restore$/.test(path) && req.method === 'POST') { const hub=openHub(root); try { const result=restoreMemoryFact(hub,Number(path.split('/')[3])); return json(res,result?200:404,result??{error:'not_found'}); } finally { hub.close(); } }
    if (/^\/reflections\/[A-Za-z0-9_-]{1,160}\/validate$/.test(path) && req.method === 'POST') { try { const data=await body(req); const result=validateReflection(db,path.split('/')[2],{successfulRunId:data.successful_run_id}); return json(res,200,result); } catch (error) { return json(res,400,{error:error.message}); } }
    if (/^\/working-tasks\/[A-Za-z0-9_-]{1,160}$/.test(path) && req.method === 'GET') { const row=workingTask(db,path.slice(15)); return json(res,row?200:404,row??{error:'not_found'}); }
    if (/^\/working-tasks\/[A-Za-z0-9_-]{1,160}\/recover$/.test(path) && req.method === 'POST') { try { const id=path.split('/')[2]; const data=await body(req); const row=recoverWorkingTask(db,id,{observationId:data.observation_id,environment:data.environment}); return json(res,row?200:409,row??{error:'not_recoverable'}); } catch (error) { return json(res,400,{error:error.message}); } }
    if (/^\/working-tasks\/[A-Za-z0-9_-]{1,160}\/observe$/.test(path) && req.method === 'POST') { try { const id=path.split('/')[2]; const data=await body(req).catch(()=>({})); const observation=data.serial ? await observeAndroidTask(db,id,String(data.serial)) : observeWorkingTask(db,id,{sessions}); if(!observation)return json(res,404,{error:'not_found'}); if(!data.serial) attachObservation(db,id,observation); return json(res,200,observation); } catch (error) { return json(res,400,{error:error.message}); } }
    if (/^\/working-tasks\/[A-Za-z0-9_-]{1,160}\/plan$/.test(path) && req.method === 'POST') { try { const id=path.split('/')[2]; const result=planWorkingTask(db,id,await body(req)); return json(res,result?.plan?200:404,result??{error:'not_found'}); } catch (error) { return json(res,400,{error:error.message}); } }
    if (/^\/working-tasks\/[A-Za-z0-9_-]{1,160}\/advance$/.test(path) && req.method === 'POST') { try { const id=path.split('/')[2]; const current=workingTask(db,id); if(!current?.plan_json)return json(res,409,{error:'plan_required'}); const data=await body(req); const plan=advancePlan(JSON.parse(current.plan_json),Number(data.index),{status:data.status,observationId:data.observation_id??null,result:data.result??null}); db.prepare('UPDATE working_tasks SET plan_json=?,status=?,current_step=?,next_action=?,last_observation_id=?,updated_ms=? WHERE task_id=?').run(JSON.stringify(plan),plan.status==='needs_reobserve'?'unknown':plan.status,plan.steps.find(s=>s.status==='pending')?.action??null,plan.steps.find(s=>s.status==='pending')?.action??null,data.observation_id??null,Date.now(),id); recordAgentEvent(db,{eventType:plan.status==='needs_reobserve'?'observation_created':'action_finished',channel:'system',taskId:id,actor:'system',payload:{plan_id:plan.planId,index:Number(data.index),status:data.status},result:data.result??null}); return json(res,200,{plan}); } catch(error) { return json(res,400,{error:error.message}); } }
    if (/^\/working-tasks\/[A-Za-z0-9_-]{1,160}\/prepare$/.test(path) && req.method === 'POST') { try { const id=path.split('/')[2]; return json(res,200,preparePlanStep(db,id,await body(req))); } catch(error) { return json(res,400,{error:error.message}); } }
    if (/^\/tasks\/[A-Za-z0-9_-]{1,100}$/.test(path) && req.method === 'GET') { const row=task(db,path.slice(7)); return json(res,row?200:404,row??{error:'not_found'}); }
    if (/^\/tasks\/[A-Za-z0-9_-]{1,100}\/cancel$/.test(path) && req.method === 'POST') { const id=path.split('/')[2]; return json(res,200,{ok:cancelTask(db,id)}); }
    if (path.startsWith('/ilink/')) return ilink.admin(req,res,path,body,server.address().port);
    if (path.startsWith('/qq/')) {
      if (!qq) return json(res, 503, { error: qqError ?? 'qq_not_configured' });
      if (path === '/qq/status' && req.method === 'GET') return json(res, 200, { running: true, ...qq.status() });
      if (path === '/qq/peers' && req.method === 'GET') return json(res, 200, { peers: qqPeers(db) });
      if (path === '/qq/peers' && req.method === 'POST') {
        try { saveQqPeer(db, await body(req)); syncQqOwner(db, loadTargets(resolve(root, '../..')).qq.dad); return json(res, 200, { ok: true }); }
        catch { return json(res, 400, { error: 'invalid_qq_peer' }); }
      }
      if (path === '/qq/call' && req.method === 'POST') {
        try {
          const data = await body(req);
          if (!iqPeer(data)) return json(res, 400, { error: 'invalid_qq_peer' });
          if (data.action === 'start') { qq.calls.start(data.kind, data.id); return json(res, 200, { ok: true, calls: qq.calls.list() }); }
          if (data.action === 'end') return json(res, 200, { ok: true, ended: qq.calls.end(data.kind, data.id) });
          return json(res, 400, { error: 'invalid_qq_action' });
        } catch { return json(res, 400, { error: 'invalid_request' }); }
      }
      if (path === '/qq/messages' && req.method === 'GET') return json(res, 200, { messages: qq.messages() });
      if (path === '/qq/send' && req.method === 'POST') {
        try {
          const data = await body(req);
          if (!iqPeer(data) || typeof data.content !== 'string' || !data.content.trim()) return json(res, 400, { error: 'invalid_qq_message' });
          if (!allowedQqPeer(db, data.kind, data.id)) return json(res, 403, { error: 'qq_peer_not_allowed' });
          const result = await qq.api.sendText({ kind: data.kind, id: data.id, content: data.content });
          return json(res, 200, { ok: true, id: result.id ?? null });
        } catch (error) { return json(res, 502, { error: 'qq_send_failed' }); }
      }
      if (path === '/qq/image' && req.method === 'POST') {
        try {
          const data = await body(req);
          if (!iqPeer(data) || typeof data.path !== 'string' || !data.path.trim()) return json(res, 400, { error: 'invalid_qq_image' });
          if (!allowedQqPeer(db, data.kind, data.id)) return json(res, 403, { error: 'qq_peer_not_allowed' });
          const projectRoot = realpathSync(resolve(root, '..', '..'));
          const target = realpathSync(resolve(data.path));
          if (!target.startsWith(projectRoot + '/')) return json(res, 400, { error: 'path_outside_root' });
          const file = readFileSync(target);
          if (file.length > 6 * 1024 * 1024) return json(res, 400, { error: 'image_too_large' });
          const result = await qq.api.sendImage({ kind: data.kind, id: data.id, file, fileName: basename(target) });
          return json(res, 200, { ok: true, id: result.id ?? null, bytes: file.length });
        } catch (error) { return json(res, 502, { error: `qq_image_failed:${error.message}` }); }
      }
      if (path === '/qq/voice' && req.method === 'POST') {
        try {
          const data = await body(req);
          if (!iqPeer(data) || typeof data.text !== 'string' || !data.text.trim()) return json(res, 400, { error: 'invalid_qq_message' });
          if (!allowedQqPeer(db, data.kind, data.id)) return json(res, 403, { error: 'qq_peer_not_allowed' });
          const { createHash } = await import('node:crypto');
          const key = createHash('sha256').update(`${Date.now()}:${data.text}`).digest('hex');
          const audio = await qq.voice.synthesize(key, data.text);
          const result = await qq.api.sendVoice({ kind: data.kind, id: data.id, silk: audio.silk, fileName: '大肥鱼语音回复.silk' });
          return json(res, 200, { ok: true, duration_ms: audio.duration_ms, id: result.id ?? null });
        } catch (error) { return json(res, 502, { error: error.message?.startsWith('daily_') ? error.message : 'qq_voice_failed' }); }
      }
      return json(res, 404, { error: 'not_found' });
    }
    if (path === '/devices' && req.method === 'GET') return json(res, 200, { devices: snapshot() });
    if (path === '/contacts' && req.method === 'GET') return json(res, 200, { contacts: contacts(db) });
    if (path === '/contacts' && req.method === 'POST') {
      try { const contact = saveContact(db, await body(req), config.devices); sendPolicy(contact.device_id); return json(res, 200, contact); }
      catch { return json(res, 400, { error: 'invalid or conflicting contact' }); }
    }
    if (path === '/events' && req.method === 'GET') return json(res, 200, { events: eventRows(db) });
    if (path.startsWith('/events/') && req.method === 'GET') {
      const row = db.prepare('SELECT * FROM communication_events WHERE id=?').get(path.slice(8));
      return json(res, row ? 200 : 404, row ? { ...row, payload: JSON.parse(row.payload) } : { error: 'not found' });
    }
    if (path.startsWith('/commands/') && req.method === 'GET') {
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(path.slice(10))) return json(res, 400, { error: 'invalid command id' });
      const row = db.prepare('SELECT * FROM commands WHERE id=?').get(path.slice(10));
      return json(res, row ? 200 : 404, row ? { ...row, payload: JSON.parse(row.payload), result: row.result ? JSON.parse(row.result) : null } : { error: 'not found' });
    }
    if (path !== '/commands' || req.method !== 'POST') return json(res, 404, { error: 'not found' });
    try {
      const data = await body(req);
      if (typeof data.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(data.id) || !Object.hasOwn(config.devices, data.device_id)) return json(res, 400, { error: 'invalid command id or device' });
      if (!['device.ping', 'device.capabilities', 'device.diagnostic', 'wechat.scan_notifications', 'app.launch', 'wechat.open_notification'].includes(data.action)) return json(res, 400, { error: 'unsupported action' });
      const payload = data.action === 'app.launch' ? { app: data.payload?.app } : data.action === 'wechat.open_notification' ? { event_id: data.payload?.event_id, contact_id: data.payload?.contact_id } : {};
      if (data.action === 'app.launch' && !Object.hasOwn(APPS, payload.app)) return json(res, 400, { error: 'app not allowed' });
      if (data.action === 'wechat.open_notification') {
        const event = db.prepare("SELECT * FROM communication_events WHERE id=? AND device_id=? AND contact_id=? AND kind='wechat.notification'").get(payload.event_id ?? '', data.device_id, payload.contact_id ?? '');
        const contact = db.prepare('SELECT * FROM contacts WHERE id=? AND device_id=? AND enabled=1').get(payload.contact_id ?? '',data.device_id);
        if (!event || !contact) return json(res, 403, { error: 'contact or notification not allowed' });
      }
      const previous = db.prepare('SELECT * FROM commands WHERE id=?').get(data.id);
      if (previous) {
        if (previous.device_id !== data.device_id || previous.action !== data.action || previous.payload !== JSON.stringify(payload)) return json(res, 409, { error: 'command id already used for different request' });
        return json(res, 200, { id: previous.id, status: previous.status, duplicate: true });
      }
      const expires = Date.parse(data.expires_at);
      if (!Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + 120000) return json(res, 400, { error: 'expiry must be within 120 seconds' });
      const socket = sessions.get(data.device_id);
      if (!socket || socket.readyState !== WebSocket.OPEN) return json(res, 409, { error: 'device offline' });
        db.prepare('INSERT INTO commands(id, device_id, action, payload, status, expires_at) VALUES(?,?,?,?,?,?)').run(data.id, data.device_id, data.action, JSON.stringify(payload), 'dispatched', data.expires_at);
        createWorkingTask(db, { taskId: data.id, goal: data.action, environment: { device_id: data.device_id, app: payload.app ?? null }, deadlineMs: expires, now: Date.now() });
        updateWorkingTask(db, data.id, { status: 'running', currentStep: data.action, nextAction: 'await_device_receipt' }, Date.now());
        recordAgentEvent(db,{eventType:'action_requested',channel:'android',taskId:data.id,actor:'system',payload:{device_id:data.device_id,action:data.action},dedupeKey:`command:${data.id}:requested`});
      socket.send(JSON.stringify({ ...data, type: 'command', payload }));
      return json(res, 202, { id: data.id, status: 'dispatched' });
    } catch { return json(res, 400, { error: 'invalid request' }); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16384 });
  const callWss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    if (req.url?.startsWith('/call/ws')) {
      const token = new URL(req.url, 'http://localhost').searchParams.get('token');
      if (!equal(token, config.adminToken)) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
      callWss.handleUpgrade(req, socket, head, ws => calls.attach(ws));
      return;
    }
    const id = req.headers['x-device-id'];
    if (req.url !== '/device' || !Object.hasOwn(config.devices, id) || !equal(req.headers.authorization, `Bearer ${config.devices[id]}`)) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      sessions.get(id)?.close(4001, 'session replaced'); sessions.set(id, ws); ws.lastSeen = Date.now(); ws.connectedAt = new Date().toISOString();
      ws.on('message', raw => {
        try {
          const value = JSON.parse(raw.toString());
          if (!value || typeof value !== 'object' || value.device_id !== id) return ws.close(1008, 'invalid device');
          if (!['register', 'heartbeat', 'result', 'event', 'policy_ack'].includes(value.type)) return ws.close(1008, 'invalid type');
          ws.lastSeen = Date.now();
          db.prepare("INSERT INTO devices(id,model,last_seen) VALUES(?,?,datetime('now')) ON CONFLICT(id) DO UPDATE SET model=COALESCE(excluded.model,model), last_seen=datetime('now')").run(id, value.type === 'register' ? String(value.model ?? '').slice(0, 120) : null);
          if (value.type === 'event') {
            const outcome = acceptDeviceEvent(db, id, value);
            if (outcome.accepted && !outcome.duplicate) Promise.resolve().then(() => onEvent({ id: value.id, device_id: id, kind: value.event })).catch(() => {});
            ws.send(JSON.stringify({ type: 'event_ack', id: value.id, ...outcome }));
          } else if (value.type === 'policy_ack') {
            const safe = { notification_access: value.notification_access === true, listener_connected: value.listener_connected === true, overlay: value.overlay === true, policy_revision: Number(value.revision) || 0, version: String(value.version ?? '').slice(0,20) };
            db.prepare("INSERT INTO device_capabilities(device_id,capabilities) VALUES(?,?) ON CONFLICT(device_id) DO UPDATE SET capabilities=excluded.capabilities, updated_at=datetime('now')").run(id, JSON.stringify(safe));
          } else if (value.type === 'result') {
            const cmd = db.prepare('SELECT * FROM commands WHERE id=? AND device_id=?').get(value.id, id);
            if (!cmd) return;
            if (['dispatched', 'unknown'].includes(cmd.status)) {
              const ok = value.ok === true;
              db.prepare('UPDATE commands SET status=?, result=? WHERE id=?').run(ok ? 'succeeded' : 'failed', JSON.stringify(value.result ?? {}), value.id);
              const startedAt=Date.parse(cmd.created_at); recordPerformance(db,{stage:'android_command',channel:'android',taskId:value.id,durationMs:Number.isFinite(startedAt)?Date.now()-startedAt:0,success:ok,metadata:{action:cmd.action,device_id:id}});
              updateWorkingTask(db, value.id, { status: ok ? 'succeeded' : 'failed', nextAction: null }, Date.now());
              recordAgentEvent(db, { eventType: ok ? 'receipt_verified' : 'action_failed', channel: 'android', taskId: value.id, actor: 'companion', payload: { device_id: id, action: cmd.action }, result: { ok, result: value.result ?? {} }, evidence: value.result ?? {}, dedupeKey: `command:${value.id}:receipt:${ok ? 'ok' : 'failed'}` });
            }
            ws.send(JSON.stringify({ type: 'result_ack', id: value.id }));
          } else {
            ws.send(JSON.stringify({ type: 'ack', for: value.type, server_time: new Date().toISOString() }));
            if (value.type === 'register') sendPolicy(id);
          }
        } catch { ws.close(1008, 'invalid message'); }
      });
      ws.on('error', () => {});
      ws.on('close', () => {
        if (sessions.get(id) !== ws) return;
        sessions.delete(id);
        const interrupted = db.prepare("SELECT id FROM commands WHERE device_id=? AND status='dispatched'").all(id);
        db.prepare("UPDATE commands SET status='unknown' WHERE device_id=? AND status='dispatched'").run(id);
        for (const command of interrupted) { updateWorkingTask(db, command.id, { status: 'unknown', nextAction: 'reobserve_before_retry' }, Date.now()); recordAgentEvent(db, { eventType: 'observation_created', channel: 'android', taskId: command.id, actor: 'system', payload: { device_id: id, status: 'unknown', reason: 'device_disconnected' }, dedupeKey: `command:${command.id}:device_disconnected` }); }
      });
    });
  });
  const timer = setInterval(() => {
    db.prepare('UPDATE ilink_messages SET context_token=NULL WHERE created_ms<?').run(Date.now()-600000);
    db.prepare('DELETE FROM ilink_messages WHERE created_ms<?').run(Date.now()-7*86400000);
    db.prepare("DELETE FROM performance_samples WHERE created_at < datetime('now','-30 days')").run();
    db.prepare("DELETE FROM agent_events WHERE created_at < datetime('now','-90 days')").run();
    db.prepare('DELETE FROM ilink_cursors WHERE binding_id NOT IN (SELECT binding_id FROM ilink_accounts)').run();
    db.prepare("DELETE FROM communication_events WHERE created_at < datetime('now','-7 days')").run();
    for (const ws of sessions.values()) if (Date.now() - ws.lastSeen > 45000) ws.terminate();
    const expiredCommands = db.prepare("SELECT id,device_id,action FROM commands WHERE status='dispatched' AND expires_at < ?").all(new Date().toISOString());
    db.prepare("UPDATE commands SET status='unknown' WHERE status='dispatched' AND expires_at < ?").run(new Date().toISOString());
    for (const command of expiredCommands) { updateWorkingTask(db, command.id, { status: 'unknown', nextAction: 'reobserve_before_retry' }, Date.now()); recordAgentEvent(db, { eventType: 'observation_created', channel: 'android', taskId: command.id, actor: 'system', payload: { device_id: command.device_id, action: command.action, status: 'unknown', reason: 'command_expired' }, dedupeKey: `command:${command.id}:expired` }); }
    if(Date.now()-lastObservation>=15*60_000){try{recordObservation(root,{sessions,db,qq,now:Date.now()});}catch{}lastObservation=Date.now();}
  }, 5000);
  timer.unref();

  // 每天凌晨 1–2 点整理前一天的记忆（写一条「当天记忆」进长期记忆库）
  const digestTimer = setInterval(async () => {
    try {
      const now = new Date();
      const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }).format(now));
      if (hour < 1 || hour > 2) return;
      const { readFileSync, writeFileSync, existsSync } = await import('node:fs');
      const { join } = await import('node:path');
      const statePath = join(runtimeDir(root), 'connect', 'memory-digest.json');
      const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date(now.getTime() - 86_400_000));
      const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { days: [] };
      if ((state.days ?? []).includes(day)) return;
      const { execFile } = await import('node:child_process');
      const exitCode=await new Promise((resolve) => execFile('node', ['scripts/memory-digest.mjs', '--day', day], { cwd: root }, (_error,_stdout,_stderr)=>resolve(_error?.code??0)));
      if(exitCode===0){state.days = [...(state.days ?? []), day].slice(-30);writeFileSync(statePath, JSON.stringify(state, null, 2));}
    } catch {}
  }, 10 * 60_000);
  digestTimer.unref();

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  qq?.setMessageUrl(`http://127.0.0.1:${server.address().port}/messages?token=${config.adminToken}`);
  try{recordObservation(root,{sessions,db,qq,now:Date.now()});lastObservation=Date.now();}catch{}
  return { port: server.address().port, config, close: async () => { for (const client of archClients) { try { client.end(); } catch {} } await qq?.close(); qqMemory?.close(); await ilink.close(); calls.close(); scheduler?.stop(); clearInterval(timer); clearInterval(digestTimer); for (const ws of callWss.clients) ws.terminate(); for (const ws of wss.clients) ws.terminate(); callWss.close(); await new Promise(r => wss.close(r)); server.close(); server.closeAllConnections?.(); await new Promise(r => server.close(r)); db.close(); } };
}
