// 项目根的唯一解析方式。
//
// 踩过的坑：只用「有没有 runtime/ 目录」判断，会把 <repo>/runtime/connect 误当成项目根
// （如果那层下面被误建出 runtime/），于是 `node scripts/douyin-post.mjs` 找不到脚本，
// 定时任务全线失败。这里改成向上找「package.json + scripts/ 同时存在」的那一层。
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function projectRoot(from = process.cwd()) {
  // 有的调用点会把 options 对象当 root 传进来（历史上 boardSnapshot 就这么干过），这里兜一下
  const start = typeof from === 'string' && from ? resolve(from) : resolve(process.cwd());
  let dir = start;
  for (let i = 0; i < 5; i += 1) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'scripts'))) return dir;
    const up = resolve(dir, '..');
    if (up === dir) break;
    dir = up;
  }
  // 找不到项目标记（比如测试里的临时目录）就原样返回，绝不能落回 cwd——
  // 那会把临时目录的数据写进真实仓库的 runtime/ 里。
  return start;
}

export const runtimeDir = (root) => join(projectRoot(root), 'runtime');
export const homeOf = (root) => join(runtimeDir(root), 'dsh-home');
