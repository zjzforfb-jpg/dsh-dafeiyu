import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendWechatMessage } from '../device/wechat.mjs';

const projectRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(projectRoot, 'config', 'wechat.json'), 'utf8'));

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

const has = (name) => process.argv.includes(`--${name}`);

if (has('list')) {
  console.log(JSON.stringify({ contacts: Object.keys(config.contacts ?? {}) }, null, 2));
  process.exit(0);
}

const contact = arg('to');
const message = arg('message');
if (!contact || !message) {
  console.error('用法：npm run device:wechat -- --to <联系人> --message <内容> [--dry-run] [--json]');
  console.error(`可用联系人：${Object.keys(config.contacts ?? {}).join('、')}`);
  process.exit(2);
}

const result = await sendWechatMessage({
  contact,
  message,
  config,
  dryRun: has('dry-run'),
  outputDir: join(projectRoot, 'runtime', 'device', 'wechat'),
});

if (has('json')) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`${result.sent ? '已发送' : '演练（未发送）'} → ${contact}：${message}`);
  for (const shot of result.screenshots) console.log(`截图：${shot.file}`);
}
