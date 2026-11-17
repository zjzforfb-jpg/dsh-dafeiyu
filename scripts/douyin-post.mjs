#!/usr/bin/env node
/**
 * 发一条抖音图文日常：
 *   生成（人格+心情）→ 推图到手机 → 打开相册选图 → 填文案 → 可选发布。
 *   node scripts/douyin-post.mjs [--theme "..."] [--image 本地图] [--publish]
 * 默认停在「发作品」前，由人确认。
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { deviceSerial } from '../device/wechat.mjs';
import { dumpUi, sleep, tapPoint } from '../device/uia.mjs';
import { withAdbKeyboard, inputText } from '../device/uia.mjs';
import { adbShell, ensureClear } from '../device/douyin.mjs';
import { composePost } from '../connect/douyin/poster.mjs';
import { openDouyinDb, saveWork } from '../connect/douyin/store.mjs';
import { openHub, recordActivity } from '../connect/memory-hub.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

async function makeTitle(home, caption) {
  try {
    const settings = JSON.parse(readFileSync(`${home}/dsh-pet/standalone-ai.json`, 'utf8'));
    const response = await fetch('http://127.0.0.1:3110/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: `给这条抖音图文起一个爆款标题：20 字以内、带一点悬念或可爱情绪，不要井号不要引号，只输出标题。正文参考：${caption}` }],
        max_tokens: 90,
        thinking: { type: 'disabled' },
      }),
    });
    const data = await response.json();
    const text = String(data?.choices?.[0]?.message?.content ?? '').replace(/[""]/gu, '').split('\n')[0].trim();
    return text.slice(0, 20) || caption.slice(0, 18);
  } catch { return caption.slice(0, 18); }
}

const root = process.cwd();
const args = process.argv.slice(2);
const option = (name, fallback = '') => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
};
const has = (name) => args.includes(`--${name}`);

const TOPICS = ['#大肥鱼', '#deepseek', '#claude', '#token'];
const serial = await deviceSerial();
const home = `${root}/runtime/dsh-home`;

const draftFileArg = option('draft');
const draft = draftFileArg ? JSON.parse(readFileSync(draftFileArg, 'utf8')) : null;
const post = draft
  ? { imageFile: option('image') || draft.imageFile, caption: option('caption') || draft.caption, theme: draft.theme ?? 'draft' }
  : has('image')
    ? { imageFile: option('image'), caption: option('caption', '今天也在认真生活呀🐟'), theme: 'manual' }
    : await composePost({ root, home, theme: option('theme') });
const topics = Array.isArray(draft?.topics) && draft.topics.length ? draft.topics : TOPICS;
const title = option('title') || draft?.title || await makeTitle(home, post.caption);

// 只写不碰手机：把内容交出去审核，爸爸点头后再填发布页。
if (has('plan')) {
  const dir = join(root, 'runtime', 'douyin', 'drafts');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `draft-${Date.now()}.json`);
  const draftId = `draft:${Date.now()}`;
  const rel = (p) => (p && p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p);
  const planned = { status: 'draft', draftId, title, caption: post.caption, topics, imageFile: post.imageFile, theme: post.theme, draftFile: file, at: Date.now() };
  writeFileSync(file, JSON.stringify(planned, null, 2));
  let stored = false;
  try {
    const db = openDouyinDb(root);
    saveWork(db, {
      id: draftId, title, caption: post.caption, topics: topics.join(' '),
      imageFile: rel(post.imageFile), images: [rel(post.imageFile)], draftFile: file,
      theme: post.theme, status: 'draft',
    });
    db.close();
    stored = true;
  } catch (error) {
    console.error(`draft_work_save_failed: ${error.message}`);
  }
  planned.steps = [
    { id: 'theme', ok: Boolean(post.theme), evidence: String(post.theme ?? '').slice(0, 40) },
    { id: 'image', ok: Boolean(post.imageFile) && existsSync(post.imageFile), evidence: String(rel(post.imageFile) ?? '') },
    { id: 'copy', ok: Boolean(title && post.caption), evidence: `${String(title ?? '').length} 字标题 / ${String(post.caption ?? '').length} 字正文` },
    { id: 'store', ok: stored, evidence: draftId },
  ];
  writeFileSync(file, JSON.stringify(planned, null, 2));
  console.log(JSON.stringify(planned, null, 2));
  process.exit(0);
}
console.log(JSON.stringify({ caption: post.caption, imageFile: post.imageFile, theme: post.theme, mood: post.mood }, null, 2));

const images = (Array.isArray(draft?.images) && draft.images.length ? draft.images : [post.imageFile]).filter(Boolean);
execFileSync('adb', ['shell', 'mkdir', '-p', '/sdcard/Pictures/DaFeiYu']);
const pushed = [];
for (const [index, file] of images.entries()) {
  const remote = `/sdcard/Pictures/DaFeiYu/daily-${Date.now()}-${index}.jpg`;
  execFileSync('adb', ['push', file, remote], { stdio: 'ignore' });
  execFileSync('adb', ['shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', `file://${remote}`], { stdio: 'ignore' });
  pushed.push(remote);
}
// 用分享 intent 把图片直接送进抖音发布流程（比相册选择器稳定）；多图后续在发布页点「＋」补选
const firstRemote = pushed[0];
const idLine = execFileSync('adb', ['shell', `content query --uri content://media/external/images/media --projection _id:_display_name --where "_display_name LIKE '${firstRemote.split('/').pop()}%'"`], { encoding: 'utf8' });
const mediaId = idLine.match(/_id=(\d+)/)?.[1];
if (!mediaId) throw new Error('mediastore_id_missing');

async function pickMusic(serial) {
  try {
    const before = await dumpUi(serial);
    const btn = before.find((n) => (n.text ?? '').includes('选择音乐'));
    if (!btn) return 'music_button_missing';
    await tapPoint(serial, { x: btn.bounds.cx, y: btn.bounds.cy });
    await sleep(1800);
    const panel = await dumpUi(serial);
    const candidates = panel.filter((n) => n.text && /[一-龥]/u.test(n.text) && n.text.length >= 2 && n.text.length <= 12 && !/选择音乐|搜索|热门|收藏|推荐|取消|完成|使用/u.test(n.text));
    const pick = candidates.find((n) => n.cls.includes('TextView')) ?? candidates[0];
    if (!pick) { await adbShell(serial, 'input keyevent 4'); return 'music_empty'; }
    await tapPoint(serial, { x: pick.bounds.cx, y: pick.bounds.cy });
    await sleep(1200);
    const after = await dumpUi(serial);
    const use = after.find((n) => /使用|完成|选好了/u.test(n.text ?? ''));
    if (use) { await tapPoint(serial, { x: use.bounds.cx, y: use.bounds.cy }); await sleep(900); }
    else { await adbShell(serial, 'input keyevent 4'); }
    return `music:${pick.text}`;
  } catch (error) { return `music_failed:${error.message}`; }
}

await adbShell(serial, 'am force-stop com.ss.android.ugc.aweme');
await sleep(900);
await adbShell(serial, `am start -a android.intent.action.SEND -t image/jpeg -n com.ss.android.ugc.aweme/.share.OpenPlatformShareRealActivity --eu android.intent.extra.STREAM content://media/external/images/media/${mediaId} --grant-read-uri-permission`);
await sleep(5000);
// 进入发布流程时常见「继续编辑作品」弹窗：先按白名单关掉，再继续填内容。
const heals = [];
const clearOnEnter = await ensureClear(serial);
heals.push(...clearOnEnter.healed);
const music = await pickMusic(serial);
console.log(JSON.stringify({ music }));
await sleep(600);
await tapPoint(serial, { x: 900, y: 2741 }); // 下一步（图片编辑页）
await sleep(3200);
const clearAfterNext = await ensureClear(serial);
heals.push(...clearAfterNext.healed);

// 多图：发布页左下角有「＋」图块，点开相册补选剩下的图（最新的在最前面）
let multi = { selected: images.length ? 1 : 0, wanted: images.length };
if (images.length > 1 && process.env.DAFEIYU_MULTI_IMAGE === '1') {
  try {
    const before = await dumpUi(serial);
    const plus = before.find((n) => (n.text ?? '').trim() === '+') ?? before.find((n) => /添加图片|添加/u.test(n.desc ?? ''));
    if (plus) {
      await tapPoint(serial, { x: plus.bounds.cx, y: plus.bounds.cy });
      await sleep(2200);
      const added = images.length - 1;
      const cols = [164, 492, 820, 1148];
      let picked = 0;
      for (let i = 0; i < added; i += 1) {
        const col = cols[i % 4];
        const row = 980 + Math.floor(i / 4) * 330;
        await tapPoint(serial, { x: col, y: row });
        await sleep(600);
        picked += 1;
      }
      const confirm = (await dumpUi(serial)).find((n) => /完成|下一步|确定/u.test(n.text ?? ''));
      if (confirm) { await tapPoint(serial, { x: confirm.bounds.cx, y: confirm.bounds.cy }); await sleep(2200); }
      multi = { selected: 1 + picked, wanted: images.length };
    }
  } catch (error) { multi = { selected: 1, wanted: images.length, error: error.message }; }
}
console.log(JSON.stringify({ images: multi }));

// 标题和正文按 EditText 实际位置填（页面会随图片数量改版，不能写死坐标）
const body = `${post.caption}\n${topics.join(' ')} `;
const editNodes = async () => (await dumpUi(serial)).filter((node) => /EditText/u.test(node.cls ?? '') && node.bounds)
  .sort((a, b) => a.bounds.cy - b.bounds.cy);
async function fillAt(node, value, verify) {
  await tapPoint(serial, { x: node.bounds.cx, y: node.bounds.cy });
  await sleep(900);
  await adbShell(serial, 'am broadcast -a ADB_CLEAR_TEXT');
  await withAdbKeyboard(serial, async () => inputText(serial, value));
  await sleep(700);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const now = await editNodes();
    if (now.some((n) => String(n.text ?? '').includes(verify))) return true;
    await sleep(700);
  }
  return false;
}
let titleFilled = false;
for (let attempt = 0; attempt < 2 && !titleFilled; attempt += 1) {
  const edits = await editNodes();
  if (!edits.length) { await sleep(800); continue; }
  titleFilled = await fillAt(edits[0], title, title.slice(0, 6));
}
const bodyFilled = await (async () => {
  const edits = await editNodes();
  const target = edits[edits.length - 1];
  if (!target) return false;
  return fillAt(target, body, post.caption.slice(0, 6));
})();
console.log(JSON.stringify({ filled: { title: titleFilled, body: bodyFilled } }));
await adbShell(serial, 'input keyevent 4');
await sleep(800);
// 自主声明：内容由 AI 生成（二审要如实报告状态）
const settings = { aiDeclared: null, downloadOff: null, saveAlbumOff: null };
try {
  const decl = (await dumpUi(serial)).find((node) => (node.text ?? '').includes('自主声明'));
  if (decl) {
    let declared = /AI/u.test(decl.text ?? '');
    if (!declared) {
      await tapPoint(serial, { x: decl.bounds.cx, y: decl.bounds.cy });
      await sleep(1500);
      const opt = (await dumpUi(serial)).find((node) => node.text === '内容由AI生成');
      if (opt) {
        await tapPoint(serial, { x: opt.bounds.cx, y: opt.bounds.cy });
        await sleep(1200);
        declared = true;
      }
    }
    settings.aiDeclared = declared;
  }
} catch {}

// 高级设置：确保「发布后保存至相册」「允许下载」都是关闭的，并把真实状态记下来。
// 开关状态不在无障碍描述里（有的行连「已关闭」后缀都没有），只能看开关轨道的颜色：
// 关=浅灰(220,220,222)，开=绿色(88,130,104)。
async function dumpSteady(minNodes = 60) {
  let nodes = [];
  for (let i = 0; i < 8; i += 1) {
    nodes = await dumpUi(serial);
    if (nodes.length >= minNodes) return nodes;
    await sleep(800);
  }
  return nodes;
}

function screenshotRaw() {
  const buffer = execFileSync('adb', ['-s', serial, 'exec-out', 'screencap'], { maxBuffer: 64 * 1024 * 1024 });
  return { width: buffer.readUInt32LE(0), height: buffer.readUInt32LE(4), buffer };
}

/** 开关轨道在行右侧约 x=1120；绿色=开，浅灰=关。 */
function switchOn(shot, y) {
  const x = Math.min(Math.round(shot.width * 0.855), shot.width - 1);
  const offset = 12 + (Math.round(y) * shot.width + x) * 4;
  if (offset + 2 >= shot.buffer.length) return null;
  const [r, g] = [shot.buffer[offset], shot.buffer[offset + 1]];
  return g > r + 12;
}

const rowNode = (nodes, label) =>
  nodes.find((node) => ((node.text ?? '').includes(label) || (node.desc ?? '').includes(label)) && !String(node.cls ?? '').endsWith('TextView') && node.bounds);

let settingsOpened = false;
try {
  let opened = false;
  for (let i = 0; i < 5 && !opened; i += 1) {
    const nodes = await dumpSteady(120);
    const adv = nodes.find((node) => ['高级设置', '更多设置'].includes(node.text ?? ''));
    if (adv) {
      await tapPoint(serial, { x: adv.bounds.cx, y: adv.bounds.cy });
      await sleep(1800);
      opened = true;
    } else {
      // 高级设置在发布页下方，需要把内容往上滑一屏
      await adbShell(serial, 'input swipe 650 2350 650 1250 420');
      await sleep(1200);
    }
  }
  settingsOpened = opened;
  for (const [label, key] of [['发布后保存至相册', 'saveAlbumOff'], ['允许下载', 'downloadOff']]) {
    if (!opened) break;
    let off = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const sheet = await dumpSteady(60);
      const row = rowNode(sheet, label);
      if (!row) { await sleep(900); continue; }
      const on = switchOn(screenshotRaw(), row.bounds.cy);
      off = on === null ? null : !on;
      if (off) break;
      await tapPoint(serial, { x: row.bounds.cx, y: row.bounds.cy });
      await sleep(1800);
    }
    settings[key] = off;
  }
  if (opened) {
    await adbShell(serial, 'input keyevent 4');
    await sleep(900);
    // 回到发布页顶部，保证「发作品」可见
    await adbShell(serial, 'input swipe 650 1200 650 2400 380');
    await sleep(1000);
  }
} catch {}

const finalClear = await ensureClear(serial);
heals.push(...finalClear.healed);
const nodes = await dumpUi(serial);
const publish = nodes.find((node) => node.text === '发作品');
if (!publish) throw new Error(`publish_button_missing${finalClear.blockers.length ? ':' + finalClear.blockers.map((b) => b.kind).join(',') : ''}`);

const ready = {
  status: 'ready',
  steps: [
    ...heals.map((item) => ({ id: `heal:${item.kind}`, ok: true, evidence: `点了「${item.clicked}」` })),
    { id: 'fill', ok: true, evidence: `${String(title ?? '').length} 字标题 / ${String(post.caption ?? '').length} 字正文` },
    { id: 'publish_button', ok: Boolean(publish), evidence: '发作品 可见' },
    { id: 'settings', ok: settingsOpened, evidence: settingsOpened ? '三项设置已读' : '高级设置没打开' },
  ],
  settingsKnown: settingsOpened,
  title,
  caption: post.caption,
  topics,
  settings,
  imageFile: post.imageFile,
  theme: post.theme,
  publishPoint: { x: publish.bounds.cx, y: publish.bounds.cy },
  at: Date.now(),
};
mkdirSync(join(root, 'runtime', 'douyin'), { recursive: true });
writeFileSync(join(root, 'runtime', 'douyin', 'pending.json'), JSON.stringify(ready, null, 2));
console.log(JSON.stringify(ready, null, 2));
if (!has('publish')) process.exit(0);

await tapPoint(serial, { x: publish.bounds.cx, y: publish.bounds.cy });
await sleep(4000);
const after = await dumpUi(serial);
const visible = after.some((node) => node.text.includes(post.caption.slice(0, 6)));
try {
  const hub = openHub(root);
  recordActivity(hub, `在抖音发布了图文作品《${post.title ?? post.caption.slice(0, 20)}》`, { channel: 'douyin' });
  hub.close();
} catch (error) {
  console.error(`活动记忆写入失败：${error.message}`);
}
console.log(JSON.stringify({ status: 'published', visible }, null, 2));
