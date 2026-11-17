#!/usr/bin/env node
// 能力记忆的维护脚本：
//   node scripts/capabilities.mjs --check   校验每条能力的登记文件/细节是否齐全、索引是否过长
//   node scripts/capabilities.mjs --index   打印常驻提示词用的索引
//   node scripts/capabilities.mjs --write   把细节写成 docs/capabilities/<id>.md 与 README
//   node scripts/capabilities.mjs --json    机器可读
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPABILITIES, capabilityIndex, matchCapabilities } from '../connect/memory/capabilities.mjs';
import { CAPABILITY_STATUSES, isCapabilityStatus } from '../connect/core/capability.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] ?? '--check';
const MAX_INDEX = 1400;
// 状态词表统一到 connect/core/capability.mjs（R-10 收口）；--check 的对外返回形状与
// 当前数据（12 项 stable/beta）的判定结果不变，仍是 {"count":12,...,"problems":[]}。
const STATUSES = new Set(CAPABILITY_STATUSES);

function check() {
  const problems = [];
  const ids = new Set();
  for (const cap of CAPABILITIES) {
    if (!cap.id || ids.has(cap.id)) problems.push(`重复或缺失 id: ${cap.id}`);
    ids.add(cap.id);
    if (!STATUSES.has(cap.status)) problems.push(`${cap.id}: status 非法 ${cap.status}`);
    if (!cap.title || !cap.one) problems.push(`${cap.id}: 缺少标题或一句话`);
    if (!String(cap.detail ?? '').trim()) problems.push(`${cap.id}: detail 为空`);
    for (const file of cap.files ?? []) {
      if (file.startsWith('runtime/')) continue;
      if (!existsSync(join(root, file))) problems.push(`${cap.id}: 登记文件不存在 ${file}`);
    }
  }
  const index = capabilityIndex();
  if (index.length > MAX_INDEX) problems.push(`索引 ${index.length} 字，超过 ${MAX_INDEX}`);
  return { count: CAPABILITIES.length, indexLength: index.length, problems };
}

function write() {
  const dir = join(root, 'docs', 'capabilities');
  mkdirSync(dir, { recursive: true });
  for (const cap of CAPABILITIES) writeFileSync(join(dir, `${cap.id}.md`), `${cap.detail}\n`);
  const lines = ['# 能力索引（渐进式披露）', '', '模型每次只带下面这张表（很小）；需要细节时调用 `capability.read(id)`，需要看实现时调用 `capability.code(id, path)`。', '', '| id | 能力 | 一句话 | 状态 | 关键文件 |', '| --- | --- | --- | --- | --- |'];
  for (const cap of CAPABILITIES) lines.push(`| \`${cap.id}\` | ${cap.title} | ${cap.one} | ${cap.status} | ${(cap.files ?? []).filter((f) => !f.startsWith('runtime/')).slice(0, 3).map((f) => `\`${f}\``).join(' ')} |`);
  lines.push('', '改完代码记得跑 `node scripts/capabilities.mjs --check`（测试里也会跑）。');
  writeFileSync(join(dir, 'README.md'), `${lines.join('\n')}\n`);
  return { dir, files: CAPABILITIES.length + 1 };
}

if (mode === '--index') {
  console.log(capabilityIndex());
} else if (mode === '--write') {
  const out = write();
  console.log(JSON.stringify({ ok: true, ...out }));
} else if (mode === '--json') {
  console.log(JSON.stringify({ capabilities: CAPABILITIES.map(({ detail, ...rest }) => rest), check: check() }, null, 2));
} else if (mode === '--match') {
  const text = process.argv.slice(3).join(' ');
  console.log(JSON.stringify(matchCapabilities(text, { limit: 5 })));
} else {
  const report = check();
  console.log(JSON.stringify(report));
  if (report.problems.length) process.exitCode = 1;
}
