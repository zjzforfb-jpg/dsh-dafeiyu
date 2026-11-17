import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAPABILITIES, capabilityById, capabilityHints, capabilityIndex, matchCapabilities, readCapability, readCapabilityCode,
} from '../connect/memory/capabilities.mjs';
import { CAPABILITY_TOOLS, runTool } from '../connect/qq/tools.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('能力记忆：索引够短、每条都在、id 不重复', () => {
  const index = capabilityIndex();
  assert.ok(index.length <= 1400, `索引 ${index.length} 字太长`);
  assert.ok(CAPABILITIES.length >= 10, `能力少于 10 条：${CAPABILITIES.length}`);
  const ids = CAPABILITIES.map((cap) => cap.id);
  assert.equal(new Set(ids).size, ids.length, '有重复 id');
  for (const id of ids) assert.ok(index.includes(id), `索引缺 ${id}`);
});

test('能力记忆：中文说法能匹配到对应能力', () => {
  assert.equal(matchCapabilities('怎么发一条图文')[0].id, 'publishing');
  assert.equal(matchCapabilities('热评怎么回')[0].id, 'hot-comments');
  assert.equal(matchCapabilities('互动消息里回评论')[0].id, 'reply-inbox');
  assert.equal(matchCapabilities('看板上面加一页')[0].id, 'board');
  assert.deepEqual(matchCapabilities('今天天气怎么样'), []);
  assert.match(capabilityHints('怎么回评论'), /reply-inbox/u);
  assert.equal(capabilityHints('今天天气怎么样'), '');
});

test('能力记忆：读细节与读代码，越界拒绝', () => {
  const detail = readCapability('publishing');
  assert.equal(detail.ok, true);
  assert.match(detail.text, /发图文/u);
  assert.match(detail.text, /关键文件/u);
  assert.equal(readCapability('nope').ok, false);

  const code = readCapabilityCode(root, 'publishing', { path: 'connect/actions.mjs', lines: 5 });
  assert.equal(code.ok, true);
  assert.equal(code.text.split('\n').length, 5);
  assert.match(code.text, /^\s+1\| /u);
  assert.equal(readCapabilityCode(root, 'publishing', { path: 'package.json' }).ok, false);
  assert.equal(readCapabilityCode(root, 'publishing', { path: '../package.json' }).ok, false);
});

test('能力记忆：登记的文件都存在（runtime/ 除外）', () => {
  for (const cap of CAPABILITIES) {
    for (const file of cap.files) {
      if (file.startsWith('runtime/')) continue;
      assert.ok(existsSync(resolve(root, file)), `${cap.id} 登记了不存在的文件 ${file}`);
    }
  }
});

test('能力记忆：模型可以通过 capability.read 工具读到细节', async () => {
  const tool = CAPABILITY_TOOLS.find((item) => item.name === 'capability.read');
  assert.ok(tool, 'capability.read 没注册');
  const result = await runTool({ tool: tool.name, args: { id: 'board' } }, { root });
  assert.equal(result.ok, true);
  assert.match(result.text, /看板|board/u);
  const bad = await runTool({ tool: 'capability.read', args: { id: 'nope' } }, { root });
  assert.match(bad.text, /没有这个能力/u);
  assert.equal(capabilityById('board').title, '运行看板');
});
