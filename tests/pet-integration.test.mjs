import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { startBrain } from '../brain/server.mjs';

const root = resolve(import.meta.dirname, '..');

async function freePort() {
  const server = createServer();
  await new Promise((resolveReady) => server.listen(0, '127.0.0.1', resolveReady));
  const port = server.address().port;
  await new Promise((resolveClosed) => server.close(resolveClosed));
  return port;
}

async function waitForFile(file, child) {
  for (let i = 0; i < 100; i += 1) {
    if (existsSync(file)) return;
    if (child.exitCode !== null) throw new Error(`桌宠提前退出：${child.exitCode}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('等待桌宠启动超时');
}

test('桌宠对话经过记忆桥并在下一轮召回', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dafeiyu-pet-e2e-'));
  const petPort = await freePort();
  const seen = [];
  const upstream = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    seen.push(body);
    const answer = seen.length === 1 ? '爸爸，我记下啦。' : '爸爸，你喜欢草莓。';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: answer } }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((resolveReady) => upstream.listen(0, '127.0.0.1', resolveReady));
  const brain = await startBrain({
    home, token: 'e2e-bridge-token', apiKey: 'fake-test-key', port: 0,
    personaPath: join(root, 'config', 'persona.md'),
    upstreamUrl: `http://127.0.0.1:${upstream.address().port}`,
  });
  const petDir = join(home, 'dsh-pet');
  mkdirSync(petDir, { recursive: true });
  const config = JSON.parse(readFileSync(join(root, 'config', 'pet.jsonc'), 'utf8'));
  config.pets[0].display = 'none';
  writeFileSync(join(petDir, 'main-config.jsonc'), JSON.stringify(config));
  writeFileSync(join(petDir, 'standalone-ai.json'), JSON.stringify({
    protocol: 'openai-compatible', baseUrl: `http://127.0.0.1:${brain.port}/v1`,
    model: 'deepseek-flash', balanceProvider: '', enabled: true,
    automaticWhispers: false, whisperIntervalSec: 300, maxTokens: 128,
    timeoutMs: 15000, apiKey: 'e2e-bridge-token',
  }), { mode: 0o600 });
  const child = spawn(process.execPath, [join(root, 'node_modules', 'dsh-pet', 'lib', 'standalone.js'), '--port', String(petPort)], {
    env: { ...process.env, DSH_HOME: home }, stdio: 'ignore',
  });
  try {
    const stateFile = join(petDir, 'standalone-runtime.json');
    await waitForFile(stateFile, child);
    const { token } = JSON.parse(readFileSync(stateFile, 'utf8'));
    const ask = async (text) => {
      const response = await fetch(`http://127.0.0.1:${petPort}/dsh-pet-7340/chat?pet=main&surface=any`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dsh-pet-token': token },
        body: JSON.stringify({ text }),
      });
      return response.json();
    };
    const first = await ask('请记住：我最喜欢的水果是草莓');
    assert.equal(first.ok, true, JSON.stringify(first));
    const second = await ask('爸爸最喜欢什么水果？');
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.match(seen[1].messages[0].content, /我最喜欢的水果是草莓/u);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolveExit) => child.once('exit', resolveExit));
    await brain.close();
    await new Promise((resolveClosed) => upstream.close(resolveClosed));
    rmSync(home, { recursive: true, force: true });
  }
});
