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
import { withAdbKeyboard, inputText } from '../device/uia.mjs';
import { adbShell } from '../device/douyin.mjs';
import { composePost } from '../connect/douyin/poster.mjs';
import { openHub, recordActivity } from '../connect/memory-hub.mjs';
import { readFileSync } from 'node:fs';

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

// 用分享 intent 把图片直接送进抖音发布流程（比相册选择器稳定）
const idLine = execFileSync('adb', ['shell', `content query --uri content://media/external/images/media --projection _id:_display_name --where "_display_name LIKE '${remote.split('/').pop()}%'"`], { encoding: 'utf8' });
const mediaId = idLine.match(/_id=(\d+)/)?.[1];
if (!mediaId) throw new Error('mediastore_id_missing');

await adbShell(serial, 'am force-stop com.ss.android.ugc.aweme');
await sleep(900);
await adbShell(serial, `am start -a android.intent.action.SEND -t image/jpeg -n com.ss.android.ugc.aweme/.share.OpenPlatformShareRealActivity --eu android.intent.extra.STREAM content://media/external/images/media/${mediaId} --grant-read-uri-permission`);
await sleep(5000);
await tapPoint(serial, { x: 900, y: 2741 }); // 下一步（图片编辑页）
await sleep(3200);

// 标题
const title = option('title') || await makeTitle(home, post.caption);
await tapPoint(serial, { x: 670, y: 1208 });
await sleep(900);
await adbShell(serial, 'am broadcast -a ADB_CLEAR_TEXT');
await withAdbKeyboard(serial, async () => inputText(serial, title));
await sleep(600);
// 正文 + 话题（末尾留空格，避免被联想成 #token过期）
const body = `${post.caption}\n#大肥鱼 #deepseek #claude #token `;
await tapPoint(serial, { x: 670, y: 1439 });
await sleep(900);
await adbShell(serial, 'am broadcast -a ADB_CLEAR_TEXT');
await withAdbKeyboard(serial, async () => inputText(serial, body));
await sleep(700);
await adbShell(serial, 'input keyevent 4');
await sleep(800);
// 自主声明：内容由 AI 生成
try {
  const decl = (await dumpUi(serial)).find((node) => (node.text ?? '').includes('自主声明'));
  if (decl && !/AI 生成/u.test(decl.text ?? '')) {
    await tapPoint(serial, { x: decl.bounds.cx, y: decl.bounds.cy });
    await sleep(1500);
    const opt = (await dumpUi(serial)).find((node) => node.text === '内容由AI生成');
    if (opt) { await tapPoint(serial, { x: opt.bounds.cx, y: opt.bounds.cy }); await sleep(1200); }
  }
} catch {}

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
const visible = after.some((node) => node.text.includes(post.caption.slice(0, 6)));
try {
  const hub = openHub(root);
  recordActivity(hub, `在抖音发布了图文作品《${post.title ?? post.caption.slice(0, 20)}》`, { channel: 'douyin' });
  hub.close();
} catch (error) {
  console.error(`活动记忆写入失败：${error.message}`);
}
console.log(JSON.stringify({ status: 'published', visible }, null, 2));
