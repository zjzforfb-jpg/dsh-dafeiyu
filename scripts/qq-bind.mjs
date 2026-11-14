import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { startQrConnect } from '@tencent-connect/qqbot-connector';

const root = resolve(import.meta.dirname, '..');
const target = join(root, 'runtime/connect/qq.json');
const force = process.argv.includes('--force');

if (existsSync(target) && !force) {
  const current = JSON.parse(readFileSync(target, 'utf8'));
  console.log(`已绑定机器人 appId=${String(current.appId).slice(0, 6)}…（重新绑定请加 --force）`);
  process.exit(0);
}

console.log('请用手机 QQ 扫码，并在页面里选择要接入的机器人：');
console.log('（QQ 开放平台 q.qq.com 可先一键创建机器人，头像昵称可改）\n');

const stop = startQrConnect({
  onQrDisplayed(url) { console.log(`二维码链接（可用手机 QQ 打开）：${url}\n`); },
  onQrExpired() { console.log('二维码已过期，正在刷新…'); },
  onSuccess(credentials) {
    const [value] = credentials;
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, `${JSON.stringify({ appId: value.appId, appSecret: value.appSecret, boundAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(target, 0o600);
    console.log(`\n绑定成功，凭据已写入 ${target}`);
    console.log('接下来：npm run connect:start 让 QQ 通道加载新凭据。');
    process.exit(0);
  },
  onFailure(error) { console.error('绑定失败：', error?.message ?? error); process.exit(1); },
});
process.on('SIGINT', () => { stop(); console.log('\n已取消'); process.exit(130); });
