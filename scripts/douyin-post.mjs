#!/usr/bin/env node
/**
 * 发一条抖音图文日常：
 *   生成（人格+心情）→ 推图到手机 → 打开相册选图 → 填文案 → 可选发布。
 *   node scripts/douyin-post.mjs [--theme "..."] [--image 本地图] [--publish]
 * 默认停在「发作品」前，由人确认。
 */
import { execFileSync } from 'node:child_process';
import { deviceSerial } from '../device/wechat.mjs';
import { dumpUi, sleep, tapPoint } from '../device/uia.mjs';
import { withAdbKeyboard, inputText, adbShell } from '../device/uia.mjs';
import { composePost } from '../connect/douyin/poster.mjs';

const root = process.cwd();
const args = process.argv.slice(2);
const option = (name, fallback = '') => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
};
const has = (name) => args.includes(`--${name}`);

const serial = await deviceSerial();
const home = `${root}/runtime/dsh-home`;

const post = has('image')
  ? { imageFile: option('image'), caption: option('caption', '今天也在认真生活呀🐟'), theme: 'manual' }
  : await composePost({ root, home, theme: option('theme') });
console.log(JSON.stringify({ caption: post.caption, imageFile: post.imageFile, theme: post.theme, mood: post.mood }, null, 2));

const remote = `/sdcard/Pictures/DaFeiYu/daily-${Date.now()}.jpg`;
execFileSync('adb', ['shell', 'mkdir', '-p', '/sdcard/Pictures/DaFeiYu']);
execFileSync('adb', ['push', post.imageFile, remote], { stdio: 'ignore' });
execFileSync('adb', ['shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', `file://${remote}`], { stdio: 'ignore' });

await adbShell(serial, 'am force-stop com.ss.android.ugc.aweme');
await sleep(800);
await adbShell(serial, 'monkey -p com.ss.android.ugc.aweme -c android.intent.category.LAUNCHER 1');
await sleep(4000);
await tapPoint(serial, { x: 622, y: 2761 }); // 底部「+」
await sleep(2400);
await tapPoint(serial, { x: 1050, y: 2362 }); // 相册
await sleep(2400);
await tapPoint(serial, { x: 596, y: 110 }); // 「图片」筛选 tab
await sleep(1400);
await tapPoint(serial, { x: 200, y: 760 }); // 第一张（最新）
await sleep(1500);
await tapPoint(serial, { x: 1050, y: 2722 }); // 下一步
await sleep(1600);
await tapPoint(serial, { x: 1050, y: 2722 }); // 下一步（照片预览页）
await sleep(2600);

// 填文案
await tapPoint(serial, { x: 238, y: 1305 });
await sleep(900);
await withAdbKeyboard(serial, async () => inputText(serial, post.caption));
await sleep(800);

const nodes = await dumpUi(serial);
const publish = nodes.find((node) => node.text === '发作品');
if (!publish) throw new Error('publish_button_missing');

if (!has('publish')) {
  console.log(JSON.stringify({ status: 'ready', hint: '已停在发布页，确认后加 --publish 再跑，或手动点「发作品」', publishPoint: { x: publish.bounds.cx, y: publish.bounds.cy } }, null, 2));
  process.exit(0);
}

await tapPoint(serial, { x: publish.bounds.cx, y: publish.bounds.cy });
await sleep(4000);
const after = await dumpUi(serial);
console.log(JSON.stringify({ status: 'published', visible: after.some((node) => node.text.includes(post.caption.slice(0, 6))) }, null, 2));
