#!/usr/bin/env node
/**
 * 发布前审批：把图文发到 QQ 群/好友，等回复「同意」再发布。
 *   node scripts/approve.mjs --image a.jpg --title "标题" --caption "正文" [--publish] [--timeout 900]
 *   node scripts/approve.mjs --image a.jpg --title "标题" --caption "正文" --send-only
 */
import { execFileSync } from 'node:child_process';
import { sendApprovalRequest, waitApproval } from '../connect/approvals.mjs';

const args = process.argv.slice(2);
const option = (name, fallback = '') => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
};
const has = (name) => args.includes(`--${name}`);

const image = option('image');
const title = option('title');
const caption = option('caption');
if (!image || !caption) {
  console.error('usage: node scripts/approve.mjs --image <file> --title <t> --caption <c> [--publish] [--send-only]');
  process.exit(2);
}

const root = process.cwd();
const sent = await sendApprovalRequest({
  root,
  target: option('target', '大肥鱼小可爱'),
  title,
  caption,
  imageFile: image,
});
console.log(JSON.stringify({ requested: true, target: sent.target, sentAt: new Date(sent.sentAt).toISOString() }, null, 2));

if (has('send-only')) process.exit(0);

const timeoutMs = Number(option('timeout', '900')) * 1000;
const result = await waitApproval({ root, sinceMs: sent.sentAt, timeoutMs });
if (!result) {
  console.log(JSON.stringify({ approved: false, reason: 'timeout' }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ approved: result.approved, author: result.author, reply: result.text }, null, 2));

if (result.approved && has('publish')) {
  const out = execFileSync('node', ['scripts/douyin-post.mjs', '--image', image, '--caption', caption, '--publish'], { encoding: 'utf8' });
  console.log(out.trim());
}
