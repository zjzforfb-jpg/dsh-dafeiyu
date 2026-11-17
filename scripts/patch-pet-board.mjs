#!/usr/bin/env node
// 给桌宠设置页（dsh-pet standalone）加一个「运行看板」入口。
// npm install 后 dsh-pet 会被覆盖，所以在 postinstall 里重跑本脚本；已打过就跳过。
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const file = join(root, 'node_modules', 'dsh-pet', 'lib', 'standalone.js');
const marker = 'data-dafeiyu-board';
const anchor = '<script src="/standalone-ai/chat-panel.js" defer></script>';
const snippet = `${anchor}<script data-dafeiyu-board>(function(){if(document.querySelector("[data-dafeiyu-board-btn]"))return;var open=function(){window.open("http://127.0.0.1:8765/board","dafeiyu-board","width=1180,height=900");};var btn=document.createElement("button");btn.setAttribute("data-dafeiyu-board-btn","1");btn.type="button";btn.textContent="运行看板";Object.assign(btn.style,{position:"fixed",right:"18px",bottom:"18px",zIndex:"9999",padding:"9px 14px",borderRadius:"999px",border:"1px solid #2b3240",background:"#151a23",color:"#e8edf6",font:"12px -apple-system,PingFang SC,sans-serif",cursor:"pointer",boxShadow:"0 8px 24px rgba(0,0,0,.45)"});btn.addEventListener("click",open);document.addEventListener("DOMContentLoaded",function(){document.body.appendChild(btn);});if(document.body)document.body.appendChild(btn);})();</script>`;

let source;
try { source = readFileSync(file, 'utf8'); } catch { console.log('patch-pet-board: dsh-pet 未安装，跳过'); process.exit(0); }
if (source.includes(marker)) { console.log('patch-pet-board: 已经是打过补丁的状态'); process.exit(0); }
if (!source.includes(anchor)) {
  console.error('patch-pet-board: 找不到注入锚点，dsh-pet 版本可能变了，需要人工看一下');
  process.exit(1);
}
writeFileSync(file, source.replace(anchor, snippet));
console.log('patch-pet-board: 已注入「运行看板」入口');
