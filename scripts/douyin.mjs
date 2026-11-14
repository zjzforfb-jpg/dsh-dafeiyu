#!/usr/bin/env node
/**
 * 抖音评论研究版：
 *   node scripts/douyin.mjs --comments                     # 只读：列出当前视频的评论
 *   node scripts/douyin.mjs --comment "文案" [--dry-run]    # 给当前视频发一条评论
 *   node scripts/douyin.mjs --reply-match "关键词" --reply "文案" [--dry-run]
 */
import { deviceSerial } from '../device/wechat.mjs';
import { openComments, parseComments, postComment, replyToComment } from '../device/douyin.mjs';

const args = process.argv.slice(2);
const option = (name, fallback = '') => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
};
const has = (name) => args.includes(`--${name}`);

async function main() {
  const serial = await deviceSerial();
  if (has('comments')) {
    const nodes = await openComments(serial);
    const rows = parseComments(nodes);
    console.log(`当前评论区共识别 ${rows.length} 条可回复评论：`);
    rows.slice(0, 12).forEach((row, index) => console.log(`${index + 1}. [${row.author}] ${row.text}`));
    return;
  }
  const comment = option('comment');
  if (comment) {
    await openComments(serial);
    const result = await postComment(serial, comment, { dryRun: has('dry-run') });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const match = option('reply-match');
  const reply = option('reply');
  if (match && reply) {
    await openComments(serial);
    const result = await replyToComment(serial, { match, reply, dryRun: has('dry-run') });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log('用法：--comments | --comment "文案" [--dry-run] | --reply-match "关键词" --reply "文案" [--dry-run]');
}

main().catch((error) => {
  console.error(`抖音操作失败：${error.message}`);
  process.exit(1);
});
