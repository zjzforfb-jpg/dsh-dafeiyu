#!/usr/bin/env node
/**
 * 二审通过后：只做「点发作品 + 核对结果」。
 * 依赖 douyin-post.mjs --prepare 留下的 runtime/douyin/pending.json。
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { deviceSerial } from '../device/wechat.mjs';
import { dumpUi, sleep, tapPoint } from '../device/uia.mjs';
import { ensureClear } from '../device/douyin.mjs';
import { openHub, recordActivity } from '../connect/memory-hub.mjs';
import { openDouyinDb, saveWork, publishDraft } from '../connect/douyin/store.mjs';

const root = process.cwd();
const file = join(root, 'runtime', 'douyin', 'pending.json');
if (!existsSync(file)) {
  console.log(JSON.stringify({ status: 'failed', error: 'pending_post_missing' }));
  process.exit(1);
}

const ready = JSON.parse(readFileSync(file, 'utf8'));
const serial = await deviceSerial();
const clear = await ensureClear(serial);
const nodes = await dumpUi(serial);
const publish = nodes.find((node) => node.text === '发作品') ?? nodes.find((node) => (node.text ?? '').includes('发作品'));
if (!publish) {
  console.log(JSON.stringify({ status: 'failed', error: 'publish_page_missing', title: ready.title ?? null }));
  process.exit(1);
}

await tapPoint(serial, { x: publish.bounds.cx, y: publish.bounds.cy });
await sleep(4500);

const after = await dumpUi(serial);
const head = String(ready.caption ?? '').slice(0, 6);
const visible = after.some((node) => node.text && head && node.text.includes(head));
const toast = after.some((node) => /发布成功|作品已发布/u.test(node.text ?? ''));
try {
  const hub = openHub(root);
  recordActivity(hub, `在抖音发布了图文作品《${ready.title ?? ''}》`, { channel: 'douyin' });
  hub.close();
} catch {}
let workId = null;
let workCode = null;
try {
  const db = openDouyinDb(root);
  const patch = {
    title: ready.title ?? '',
    caption: ready.caption ?? '',
    topics: (ready.topics ?? []).join(' '),
    imageFile: ready.imageFile ?? null,
    settings: ready.settings ?? null,
    publishedAt: new Date().toISOString(),
    status: visible ? 'published' : 'published_unverified',
  };
  const published = ready.draftId ? publishDraft(db, ready.draftId, patch) : null;
  if (published) {
    workId = published.id;
    workCode = published.code;
  } else {
    const savedId = saveWork(db, { taskId: ready.taskId ?? null, theme: ready.theme ?? null, ...patch });
    workId = savedId;
    workCode = db.prepare('SELECT code FROM works WHERE id = ?').get(savedId)?.code ?? null;
  }
  db.close();
} catch (error) {
  workId = null;
  workCode = null;
}
try { rmSync(file, { force: true }); } catch {}
const status = visible ? 'published' : 'unconfirmed';
console.log(JSON.stringify({
  status,
  verified: visible === true,
  workId,
  workCode,
  title: ready.title,
  topics: ready.topics,
  visible,
  toast,
  steps: [
    ...(clear.healed ?? []).map((item) => ({ id: `heal:${item.kind}`, ok: true, evidence: `点了「${item.clicked}」` })),
    { id: 'pending', ok: Boolean(ready?.title), evidence: ready?.title ?? 'no_pending' },
    { id: 'publish', ok: visible === true, evidence: String(toast ?? '').slice(0, 60) || (visible ? '正文可见' : '没看到正文') },
  ],
}, null, 2));
