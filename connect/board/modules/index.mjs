import * as home from './home.mjs';
import * as content from './content.mjs';
import * as interact from './interact.mjs';
import * as growth from './growth.mjs';
import * as system from './system.mjs';

// 新增页面：在这里加一行（模块文件导出 meta 与 mount）
export const MODULES = [home, content, interact, growth, system].map((mod) => ({ ...mod.meta, mount: mod.mount }));
