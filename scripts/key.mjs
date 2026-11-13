import { spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';

if (process.platform !== 'darwin') {
  console.error('钥匙串脚本只支持 macOS；Windows 请使用 DEEPSEEK_API_KEY 环境变量。');
  process.exit(2);
}

const action = process.argv[2];
const account = userInfo().username;
const service = 'DaFeiYu-DeepSeek-API-Key';

if (action === 'setup') {
  console.log('请输入新密钥。输入内容不会显示，也不会进入终端历史。');
  const result = spawnSync('/usr/bin/security', [
    'add-generic-password', '-U', '-a', account, '-s', service, '-w',
  ], { stdio: 'inherit' });
  if (result.status === 0) console.log('钥匙串条目已保存。请退出并重新启动大肥鱼。');
  process.exit(result.status ?? 1);
}

if (action === 'check') {
  const result = spawnSync('/usr/bin/security', [
    'find-generic-password', '-a', account, '-s', service,
  ], { stdio: 'ignore' });
  console.log(result.status === 0 ? '大肥鱼的钥匙串条目已找到。' : '没有找到大肥鱼的钥匙串条目。');
  process.exit(result.status === 0 ? 0 : 1);
}

console.error('用法：npm run key:setup 或 npm run key:check');
process.exit(2);
