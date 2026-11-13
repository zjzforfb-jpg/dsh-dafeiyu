import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { launchAgentPlist } from '../service/launchd.mjs';

test('LaunchAgent 配置有效，路径被转义且不含模型密钥', () => {
  const temp = mkdtempSync(join(tmpdir(), 'dafeiyu-service-'));
  const path = join(temp, 'pet.plist');
  try {
    const plist = launchAgentPlist({ root: '/Volumes/My & Mac/DSH-dafeiyu', nodePath: '/opt/homebrew/bin/node', username: 'zhang', logDir: '/Users/zhang/Library/Logs/DaFeiYu' });
    assert.match(plist, /My &amp; Mac/u);
    assert.match(plist, /<key>SuccessfulExit<\/key><false\/>/u);
    assert.doesNotMatch(plist, /DEEPSEEK_API_KEY|sk-[a-z0-9]+/iu);
    writeFileSync(path, plist);
    assert.match(execFileSync('/usr/bin/plutil', ['-lint', path], { encoding: 'utf8' }), /OK/u);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
