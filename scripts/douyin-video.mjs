#!/usr/bin/env node
/**
 * 发一条抖音**视频**作品（图文走 scripts/douyin-post.mjs，这里只处理视频）：
 *
 *   node scripts/douyin-video.mjs --file "/path/to/3.mp4" \
 *        --title "当你以为你不会再出糗时" \
 *        --caption "刚说完这次绝对不出糗……" \
 *        --probe            # 只推到手机、打开发布页、把界面 dump 出来，不发
 *        --publish          # 真的点发布
 *
 * 设计要点：
 *   - 用分享 intent 把视频直接送进抖音发布流程（和图文同一条路，比相册选择器稳）；
 *   - 文案与标题分两步填，先点描述区进编辑面板再输入，避免直接 input text 落到不确定的焦点；
 *   - 话题沿用固定那一组（#大肥鱼 #deepseek #claude #token），不在这里另发明；
 *   - 没有 --publish 就停在发布页之前，绝不默认发出去。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { deviceSerial } from '../device/wechat.mjs';
import {
  ensureClear, findBlockers, currentActivity, adbShell,
} from '../device/douyin.mjs';
import {
  dumpUi, sleep, tapPoint, inputText, withAdbKeyboard,
} from '../device/uia.mjs';
import { openDouyinDb, saveWork } from '../connect/douyin/store.mjs';
import { openHub, recordActivity } from '../connect/memory-hub.mjs';

const argv = process.argv.slice(2);
const has = (...names) => names.some((name) => argv.includes(`--${name}`));
const option = (name, fallback = '') => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const DEFAULT_TAGS = '#大肥鱼 #deepseek #claude #token';
const root = process.cwd();
const home = join(root, 'runtime', 'dsh-home');

const file = option('file');
if (!file) {
  console.error('用法：node scripts/douyin-video.mjs --file <视频> [--title 标题] [--caption 正文] [--probe|--publish]');
  process.exit(1);
}
if (!existsSync(file)) {
  console.error(`找不到视频文件：${file}`);
  process.exit(1);
}
const size = statSync(file).size;
if (size < 200 * 1024) {
  console.error(`视频太小（${Math.round(size / 1024)} KB），像是没导出成功`);
  process.exit(1);
}
const ext = extname(file).toLowerCase();
if (!['.mp4', '.mov', '.m4v'].includes(ext)) {
  console.error(`只支持 mp4/mov/m4v，收到 ${ext}`);
  process.exit(1);
}

const title = option('title').trim();
const caption = option('caption').trim();
const tags = option('tags', DEFAULT_TAGS).trim();
const probe = has('probe');
const publish = has('publish');
if (!probe && !caption) {
  console.error('要么给 --caption，要么用 --probe 先看界面');
  process.exit(1);
}

const serial = await deviceSerial();

// 1. 推到手机相册目录（Movies 而不是 Pictures：相册选择器按类型分；再用 media scanner 登记）
const remoteDir = '/sdcard/Movies/DaFeiYu';
const remote = `${remoteDir}/video-${Date.now()}${ext}`;
execFileSync(serial ? 'adb' : 'adb', ['-s', serial, 'shell', 'mkdir', '-p', remoteDir], { stdio: 'ignore' });
execFileSync('adb', ['-s', serial, 'push', file, remote], { stdio: 'ignore' });
execFileSync('adb', [
  '-s', serial, 'shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE',
  '-d', `file://${remote}`,
], { stdio: 'ignore' });

// 2. 等 MediaStore 收录，拿 content://media/external/video/media/<id>
let mediaId = '';
const name = basename(remote);
for (let attempt = 0; attempt < 12 && !mediaId; attempt += 1) {
  await sleep(800);
  const out = execFileSync('adb', [
    '-s', serial, 'shell',
    `content query --uri content://media/external/video/media --projection _id:_display_name --where "_display_name LIKE '${name}%'"`,
  ], { encoding: 'utf8' });
  mediaId = out.match(/_id=(\d+)/u)?.[1] ?? '';
}
if (!mediaId) {
  console.error(JSON.stringify({ ok: false, error: 'mediastore_id_missing', remote }));
  process.exit(1);
}

// 3. 用分享 intent 打开抖音发布流程
await adbShell(serial, 'am force-stop com.ss.android.ugc.aweme');
await sleep(900);
await adbShell(serial,
  `am start -a android.intent.action.SEND -t video/mp4 -n com.ss.android.ugc.aweme/.share.OpenPlatformShareRealActivity `
  + `--eu android.intent.extra.STREAM content://media/external/video/media/${mediaId} --grant-read-uri-permission`);
await sleep(6000);

const heals = [];
try {
  const cleared = await ensureClear(serial);
  heals.push(...(cleared.healed ?? []));
} catch {
  // 弹窗白名单没命中就算了，下面看界面说话
}

const nodes = await dumpUi(serial);
const activity = await currentActivity(serial);
mkdirSync('/tmp', { recursive: true });
const dumpPath = '/tmp/douyin-video-publish.json';
writeFileSync(dumpPath, JSON.stringify(nodes, null, 1));
const blockers = findBlockers(nodes);
const texts = nodes.filter((node) => node.text).map((node) => node.text.trim()).slice(0, 60);

if (probe) {
  // 分享 intent 落的是「剪辑页」，正文在点「下一步」之后的发布页。
  // 探针模式多走一步，把发布页也 dump 出来，方便对齐输入区。
  const next = nodes.find((node) => node.text?.trim() === '下一步');
  let second = null;
  if (probe && next) {
    await tapPoint(serial, { x: next.bounds.cx, y: next.bounds.cy });
    await sleep(3600);
    const cleared = await ensureClear(serial).catch(() => ({ healed: [] }));
    heals.push(...(cleared.healed ?? []));
    const publishNodes = await dumpUi(serial);
    writeFileSync('/tmp/douyin-video-publish2.json', JSON.stringify(publishNodes, null, 1));
    second = {
      activity: await currentActivity(serial),
      dump: '/tmp/douyin-video-publish2.json',
      texts: publishNodes.filter((node) => node.text).map((node) => node.text.trim()).slice(0, 60),
      inputs: publishNodes
        .filter((node) => /EditText|Input|写|描述|标题/u.test(`${node.cls} ${node.text} ${node.desc}`))
        .map((node) => ({ cls: node.cls, text: node.text, desc: node.desc, x: node.bounds.cx, y: node.bounds.cy })),
    };
  }
  console.log(JSON.stringify({
    ok: true,
    stage: second ? 'publish_page' : 'opened',
    dryRun: !publish,
    mediaId,
    remote,
    activity,
    heal: heals,
    blockers,
    dump: dumpPath,
    texts,
    second,
  }, null, 1));
  process.exit(0);
}

// 4. 点「下一步」进发布页（分享 intent 落的是剪辑页）
const publishNodes = nodes;
const next = publishNodes.find((node) => node.text?.trim() === '下一步');
if (next) {
  await tapPoint(serial, { x: next.bounds.cx, y: next.bounds.cy });
  await sleep(3600);
  const cleared = await ensureClear(serial).catch(() => ({ healed: [] }));
  heals.push(...(cleared.healed ?? []));
}
let page = await dumpUi(serial);

/** 发布页上的两个 EditText：标题与描述。按占位文案找，找不到再按位置兜底。 */
const fieldOf = (pattern) => page.find((node) => node.cls.includes('EditText') && pattern.test(node.text ?? ''))
  ?? page.find((node) => node.cls.includes('EditText') && /添加标题/u.test(node.text ?? '') && pattern.source.includes('标题'));

async function fillField(pattern, value) {
  if (!value) return 'empty';
  const field = fieldOf(pattern);
  if (!field) return 'missing';
  await tapPoint(serial, { x: field.bounds.cx, y: field.bounds.cy });
  await sleep(900);
  await adbShell(serial, 'am broadcast -a ADB_CLEAR_TEXT');
  await sleep(300);
  await withAdbKeyboard(serial, async () => inputText(serial, value));
  await sleep(700);
  // 抖音的标题/描述面板是弹层，输入完要按返回收起才会回到发布页
  await adbShell(serial, 'input keyevent 4');
  await sleep(900);
  page = await dumpUi(serial);
  return 'ok';
}

const titleState = await fillField(/添加标题|标题/u, title);
const descState = await fillField(/添加作品描述|描述/u, [caption, tags].filter(Boolean).join(' '));

// 描述里带 # 会弹出话题候选面板：它只是辅助列表，却把「发作品」视觉上盖住
//（a11y 里按钮还在，直接按坐标点会点到话题列表）。实测唯一可靠的收尾是：
// 按一次返回退到剪辑页（内容保留）→ 再点「下一步」→ 回到发布页时面板已经关了。
const chipCount = (pageNodes) => pageNodes.filter((node) => /^#[^\s]{1,20}$/u.test((node.text ?? '').trim())).length;
const hasText = (pageNodes, text) => pageNodes.some((node) => node.text?.trim() === text);

async function settlePublishPage() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const page = await dumpUi(serial);
    if (chipCount(page) < 5 && hasText(page, '发作品')) return page;
    if (!hasText(page, '下一步') && chipCount(page) >= 5) {
      // 面板开着还留在发布页：退到剪辑页，再进去一次即可关闭面板
      await adbShell(serial, 'input keyevent 4');
      await sleep(1400);
      const editPage = await dumpUi(serial);
      const nextBtn = editPage.find((node) => node.text?.trim() === '下一步');
      if (nextBtn) {
        await tapPoint(serial, { x: nextBtn.bounds.cx, y: nextBtn.bounds.cy });
        await sleep(3600);
      }
      continue;
    }
    if (hasText(page, '下一步')) {
      const nextBtn = page.find((node) => node.text?.trim() === '下一步');
      await tapPoint(serial, { x: nextBtn.bounds.cx, y: nextBtn.bounds.cy });
      await sleep(3600);
      continue;
    }
    await sleep(1200);
  }
  return dumpUi(serial);
}

const beforePublish = await settlePublishPage();
writeFileSync('/tmp/douyin-video-before-publish.json', JSON.stringify(beforePublish, null, 1));
const textsBefore = beforePublish.filter((node) => node.text).map((node) => node.text.trim());
const filled = (needle) => textsBefore.some((text) => text.includes(needle.slice(0, 8)));
const submit = beforePublish.find((node) => node.text?.trim() === '发作品');

const report = {
  ok: Boolean(submit),
  stage: 'ready_to_publish',
  mediaId,
  remote,
  title: { state: titleState, visible: filled(title || '（无标题）') },
  caption: { state: descState, visible: filled(caption.slice(0, 10)) },
  tags,
  heal: heals,
  submit: submit ? { x: submit.bounds.cx, y: submit.bounds.cy } : null,
  dump: '/tmp/douyin-video-before-publish.json',
  texts: textsBefore.slice(0, 40),
};

if (!publish) {
  console.log(JSON.stringify({ ...report, dryRun: true }, null, 1));
  process.exit(0);
}

if (!submit) {
  console.log(JSON.stringify({ ...report, ok: false, error: 'submit_button_missing' }, null, 1));
  process.exit(1);
}
await tapPoint(serial, { x: submit.bounds.cx, y: submit.bounds.cy });
await sleep(9000);
const after = await dumpUi(serial);
const afterTexts = after.filter((node) => node.text).map((node) => node.text.trim());
const afterActivity = await currentActivity(serial).catch(() => '');
// 真正发出去会离开剪辑页（回到推荐流 MainActivity 或作品详情 UltraDetailActivity）；
// 停在 VideoRecordNewActivity 说明按钮没点到。
const leftEditor = !/VideoRecordNewActivity/u.test(afterActivity);
const published = afterTexts.some((text) => /发布成功|作品已发布/u.test(text))
  || (leftEditor && !afterTexts.some((text) => text === '发作品'));
writeFileSync('/tmp/douyin-video-after.json', JSON.stringify(after, null, 1));

// 5. 记账：作品落库 + 活动记录（失败也不影响已经发出去的事实）
try {
  const db = openDouyinDb(join(root, 'runtime', 'connect'));
  saveWork(db, {
    id: `video-${Date.now()}`,
    title: title || caption.slice(0, 20),
    caption,
    topics: tags,
    status: published ? 'published' : 'unknown',
    published_at: published ? new Date().toISOString() : null,
    created_at: new Date().toISOString(),
  });
  db.close();
} catch {
  // 落库失败只影响页面统计，不该让脚本报错
}
try {
  const hub = openHub(join(root, 'runtime', 'dsh-home'));
  recordActivity(hub, `在抖音发布了视频作品《${(title || caption).slice(0, 20)}》`, { channel: 'douyin' });
  hub.close?.();
} catch {
  // 同上
}

console.log(JSON.stringify({
  ...report,
  ok: published,
  stage: published ? 'published' : (leftEditor ? 'unknown' : 'submit_blocked'),
  activity: afterActivity,
}, null, 1));
process.exit(published ? 0 : 3);
