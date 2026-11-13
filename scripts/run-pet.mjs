import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBrain } from '../brain/server.mjs';
import { startLifeSchedule } from '../life/manager.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = join(projectRoot, 'runtime', 'dsh-home');
const configFile = join(home, 'dsh-pet', 'main-config.jsonc');
const template = join(projectRoot, 'config', 'pet.jsonc');
const entry = join(projectRoot, 'node_modules', 'dsh-pet', 'lib', 'standalone.js');
const aiSettingsFile = join(home, 'dsh-pet', 'standalone-ai.json');

process.umask(0o077);
const petEnv = { ...process.env, DSH_HOME: home };
delete petEnv.DEEPSEEK_API_KEY;

if (!existsSync(entry)) {
  console.error('请先运行 npm install。');
  process.exit(1);
}

mkdirSync(dirname(configFile), { recursive: true });
if (!existsSync(configFile)) copyFileSync(template, configFile);

const args = process.argv.slice(2);
if (args.includes('--check')) {
  const child = spawn(process.execPath, [entry, '--check'], {
    cwd: projectRoot,
    env: petEnv,
    stdio: 'inherit',
  });
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
  process.on('SIGINT', () => child.kill('SIGINT'));
} else {
if (!existsSync(aiSettingsFile)) {
  writeFileSync(aiSettingsFile, JSON.stringify({
    protocol: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:3110/v1',
    model: 'deepseek-flash',
    balanceProvider: '',
    enabled: true,
    automaticWhispers: false,
    whisperIntervalSec: 300,
    maxTokens: 1024,
    timeoutMs: 60000,
    apiKey: randomBytes(32).toString('hex'),
  }, null, 2), { mode: 0o600 });
}

const aiSettings = JSON.parse(readFileSync(aiSettingsFile, 'utf8'));
if (aiSettings.baseUrl !== 'http://127.0.0.1:3110/v1') {
  console.error('独立 AI 设置已指向其他接口；长期记忆桥不会用于该设置。');
}
let modelKey = process.env.DEEPSEEK_API_KEY?.trim() ?? '';
if (!modelKey && process.platform === 'darwin') {
  try {
    modelKey = execFileSync('/usr/bin/security', [
      'find-generic-password', '-a', userInfo().username,
      '-s', 'DaFeiYu-DeepSeek-API-Key', '-w',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { /* 密钥尚未配置，记忆桥会明确返回配置错误。 */ }
}
const brain = await startBrain({ home, token: aiSettings.apiKey, apiKey: modelKey, personaPath: join(projectRoot, 'config', 'persona.md') });
console.log(`[大肥鱼] 记忆桥已启动；模型${modelKey ? '已就绪' : '尚未配置密钥'}。`);
if (!args.includes('--check') && !args.includes('--port') && !args.some((arg) => arg.startsWith('--port='))) {
  args.push('--port', '3108');
}
const portIndex = args.indexOf('--port');
const petPort = Number(portIndex >= 0 ? args[portIndex + 1] : args.find((arg) => arg.startsWith('--port='))?.split('=')[1] ?? 3108);
const life = modelKey ? startLifeSchedule({ home, brainPort: brain.port, token: aiSettings.apiKey, petPort }) : null;

const child = spawn(process.execPath, [entry, ...args], {
  cwd: projectRoot,
  env: petEnv,
  stdio: 'inherit',
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on('exit', async (code, signal) => {
  life?.close(code ?? (signal ? 1 : 0));
  await brain.close();
  process.exitCode = code ?? (signal ? 1 : 0);
});
}
