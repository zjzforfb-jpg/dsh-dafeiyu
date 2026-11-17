// 生成 docs/capabilities/index.html —— 单文件、离线可双击打开
// 用法: node scripts/build-capabilities-page.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'docs/capabilities/web');

const template = readFileSync(join(src, 'template.html'), 'utf8');
const three = readFileSync(join(src, 'vendor/three.min.js'), 'utf8');
const app = readFileSync(join(src, 'app.js'), 'utf8');
const fish = readFileSync(join(src, 'assets/dafeiyu.webp')).toString('base64');
// 默认用原画（2D）；想把 Blender 导出的 3D 模型放回去：FISH_MESH=on node scripts/build-capabilities-page.mjs
const meshPath = join(src, 'assets/dafeiyu-mesh.json');
let mesh = 'null';
if (process.env.FISH_MESH === 'on') {
  try {
    mesh = readFileSync(meshPath, 'utf8').trim();
  } catch {
    console.warn('no mesh json, falling back to 2D sprite');
  }
}

const out = template
  .replace('/*__THREE__*/', () => three)
  .replace('__FISH_B64__', () => fish)
  .replace('/*__FISH_MESH__*/null', () => mesh)
  .replace('/*__APP__*/', () => app);

const dest = join(root, 'docs/capabilities/index.html');
writeFileSync(dest, out);
console.log(`wrote ${dest} (${(out.length / 1024 / 1024).toFixed(2)} MB)`);
