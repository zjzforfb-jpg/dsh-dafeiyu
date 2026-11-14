/**
 * MiniMax 文生图：给大肥鱼的图文日常配图。
 * 走 https://api.minimax.cn/v1/image_generation，返回本地 jpg 路径。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { generateImageGrs } from './grs.mjs';

function minimaxKey() {
  if (process.env.MINIMAX_API_KEY) return process.env.MINIMAX_API_KEY;
  try {
    return execFileSync('security', ['find-generic-password', '-s', 'DaFeiYu-MiniMax-API-Key', '-w'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('minimax_key_missing');
  }
}

const ASPECTS = new Set(['1:1', '4:3', '3:2', '16:9', '2:3', '3:4', '9:16']);

export async function generateImage(prompt, { root = process.cwd(), aspect = '1:1', fetchImpl = fetch } = {}) {
  const text = String(prompt ?? '').trim();
  if (!text || text.length > 1500) throw new Error('invalid_image_prompt');
  if (!ASPECTS.has(aspect)) throw new Error('invalid_image_aspect');

  const response = await fetchImpl('https://api.minimax.cn/v1/image_generation', {
    method: 'POST',
    headers: { Authorization: `Bearer ${minimaxKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'image-01', prompt: text, aspect_ratio: aspect, response_format: 'url', n: 1 }),
  });
  if (!response.ok) throw new Error(`image_http_${response.status}`);
  const payload = await response.json();
  if (payload?.base_resp?.status_code !== 0) throw new Error(`image_api_${payload?.base_resp?.status_msg ?? 'unknown'}`);
  const url = payload?.data?.image_urls?.[0];
  if (!url) throw new Error('image_url_missing');

  const image = await fetchImpl(url);
  if (!image.ok) throw new Error(`image_download_${image.status}`);
  const bytes = Buffer.from(await image.arrayBuffer());
  if (bytes.length < 1024) throw new Error('image_too_small');

  const file = join(root, 'runtime', 'douyin', 'images', `image-${Date.now()}.jpg`);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, bytes, { mode: 0o600 });
  return { file, bytes: bytes.length, prompt: text, aspect };
}

/** 统一入口：优先 grs（nano-banana-2.1 → gpt-image-2.6-flare，2K），失败再回落 MiniMax。 */
export async function generateImageAuto(prompt, { root = process.cwd(), aspect = '3:4', refs, models } = {}) {
  const referenceRefs = refs ?? [join(root, 'runtime', 'douyin', 'refs', 'dafeiyu-ref.png')];
  try {
    const result = await generateImageGrs(prompt, { root, refs: referenceRefs, aspectRatio: aspect, models });
    return { ...result, provider: 'grsai' };
  } catch (error) {
    const fallback = await generateImage(prompt, { root, aspect });
    return { ...fallback, provider: 'minimax', grsError: error.message };
  }
}
