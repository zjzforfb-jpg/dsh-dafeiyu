/**
 * grs（grsai）出图通道：POST /v1/api/generate + 轮询 /v1/api/result。
 * 优先 nano-banana-2.1（2K），失败依次回退 gpt-image-2.6-flare（2K）。
 * 参考图走 images 字段（本地文件转 data URI），用于锁角色一致性。
 */
import { execFileSync } from 'node:child_process';
import { runtimeDir } from '../core/paths.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';

const DEFAULT_BASE = 'https://grsai.dakka.com.cn';
const CHAIN = ['nano-banana-2.1', 'gpt-image-2.6-flare'];

export function loadImageConfig(root = process.cwd()) {
  const file = join(runtimeDir(root), 'douyin', 'image.json');
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(file, 'utf8')); } catch { /* 允许纯环境变量 */ }
  const apiKey = cfg.apiKey ?? process.env.GRSAI_API_KEY;
  if (!apiKey) throw new Error('grsai_key_missing');
  return {
    baseUrl: (cfg.baseUrl ?? process.env.GRSAI_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, ''),
    apiKey,
    models: Array.isArray(cfg.models) && cfg.models.length ? cfg.models : CHAIN,
    size: cfg.size ?? '2K',
    pollIntervalMs: cfg.pollIntervalMs ?? 3000,
    maxWaitMs: cfg.maxWaitMs ?? 420_000,
  };
}

function dataUri(file) {
  const mime = extname(file).toLowerCase() === '.jpg' || extname(file).toLowerCase() === '.jpeg' ? 'image/jpeg' : 'image/png';
  return `data:${mime};base64,${readFileSync(file).toString('base64')}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function requestJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`grs_http_${response.status}:${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { throw new Error(`grs_bad_json:${text.slice(0, 200)}`); }
}

async function runModel(cfg, model, prompt, refs, aspectRatio) {
  const payload = { model, prompt, images: refs.map(dataUri), aspectRatio, replyType: 'async' };
  if (model.startsWith('nano-banana')) payload.imageSize = cfg.size.toUpperCase();

  let body = await requestJson(`${cfg.baseUrl}/v1/api/generate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const deadline = Date.now() + cfg.maxWaitMs;
  while (body.status === 'running' && Date.now() < deadline) {
    await sleep(cfg.pollIntervalMs);
    body = await requestJson(`${cfg.baseUrl}/v1/api/result?id=${body.id}`, { headers: { Authorization: `Bearer ${cfg.apiKey}` } });
  }
  if (body.status === 'failed' || body.status === 'violation') throw new Error(`grs_${body.status}:${String(body.error ?? body.message ?? '').slice(0, 160)}`);
  if (body.status !== 'succeeded' && !(body.results ?? []).length) throw new Error(`grs_timeout:${body.status}`);
  const url = (body.results ?? []).find((item) => item.url)?.url;
  if (!url) throw new Error('grs_no_url');

  const image = await fetch(url);
  if (!image.ok) throw new Error(`grs_download_${image.status}`);
  const bytes = Buffer.from(await image.arrayBuffer());
  if (bytes.length < 1024) throw new Error('grs_image_too_small');
  return { bytes, model };
}

export async function generateImageGrs(prompt, { root = process.cwd(), refs = [], aspectRatio = '3:4', models } = {}) {
  const cfg = loadImageConfig(root);
  const chain = models?.length ? models : cfg.models;
  const errors = [];
  for (const model of chain) {
    try {
      const { bytes } = await runModel(cfg, model, prompt, refs, aspectRatio);
      const file = join(runtimeDir(root), 'douyin', 'images', `grs-${Date.now()}.png`);
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, bytes, { mode: 0o600 });
      return { file, bytes: bytes.length, model, prompt, attempts: errors.length + 1 };
    } catch (error) {
      errors.push(`${model}: ${error.message}`);
    }
  }
  throw new Error(`grs_all_models_failed: ${errors.join(' | ')}`);
}
