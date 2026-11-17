import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRunAllowlist, canRunFromUi } from '../connect/live/run-policy.mjs';

test('默认什么都不许跑：没有 live-run.json 就是空清单', () => {
  const root = mkdtempSync(join(tmpdir(), 'run-policy-'));
  assert.deepEqual(loadRunAllowlist(root).allowed, []);
  assert.equal(canRunFromUi('qq.call', { allowed: [] }).reason, 'not_allowed');
  assert.equal(canRunFromUi('weather.get', { allowed: [] }).ok, false);
});

test('主人点名后才放行，且只放行点名的那些', () => {
  const root = mkdtempSync(join(tmpdir(), 'run-policy-'));
  mkdirSync(join(root, 'runtime', 'connect'), { recursive: true });
  // 注意：loadRunAllowlist 会先归一到仓库根，这里用真实仓库根写文件更贴近实际
  const repo = new URL('..', import.meta.url).pathname;
  const file = join(repo, 'runtime', 'connect', 'live-run.json');
  const before = (() => { try { return readFileSync(file, 'utf8'); } catch { return null; } })();
  try {
    writeFileSync(file, JSON.stringify({ allowed: ['qq.call'], note: '测试' }));
    const loaded = loadRunAllowlist(repo);
    assert.deepEqual(loaded.allowed, ['qq.call']);
    assert.equal(canRunFromUi('qq.call', { allowed: loaded.allowed }).ok, true);
    assert.equal(canRunFromUi('qq.call_mom', { allowed: loaded.allowed }).reason, 'not_allowed');
  } finally {
    if (before === null) writeFileSync(file, JSON.stringify({ allowed: [] }));
    else writeFileSync(file, before);
  }
});

test('不认识的动作用不让跑；核验没过也不让跑', () => {
  assert.equal(canRunFromUi('some.unknown', { allowed: ['some.unknown'] }).reason, 'unknown_action');
  assert.equal(canRunFromUi('qq.call', { allowed: ['qq.call'], ready: false }).reason, 'preflight_not_ready');
  assert.equal(canRunFromUi('weather.get', { allowed: ['weather.get'] }).readOnly, true);
});

test('服务端接口先要 confirm，再要放行清单；页面上先展开确认块、再点确认才跑', () => {
  const server = readFileSync(new URL('../connect/server.mjs', import.meta.url), 'utf8');
  assert.match(server, /path === '\/api\/live\/run' && req\.method === 'POST'/u);
  assert.match(server, /body\.confirm !== 'run'[\s\S]{0,40}need_confirm/u, '缺 confirm 要 400');
  assert.match(server, /canRunFromUi\(action/u);
  assert.match(server, /loadRunAllowlist\(root\)/u);
  const ui = readFileSync(new URL('../connect/live/live.js', import.meta.url), 'utf8');
  // 第 54 轮改成「展开确认块（会做什么 / 会影响谁 / 跑完怎么核对）→ 点确认」，仍是两次动作
  assert.match(ui, /确认，跑一次/u, '要有明确的确认按钮');
  assert.match(ui, /会影响：/u, '确认块要说清影响谁');
  assert.match(ui, /跑完应该看到/u, '确认块要说清怎么核对');
  assert.match(ui, /\/api\/live\/run/u);
});

test('页面点着跑的也要进判定链（checkpoint + 覆盖度），不能只写一条事件', () => {
  const server = readFileSync(new URL('../connect/server.mjs', import.meta.url), 'utf8');
  assert.match(server, /recordCheckpoint\(db, \{/u, '要写 task_checkpoints');
  assert.match(server, /evaluateOutcome\(\{ operation: action, result, receipt: \{\} \}\)/u, '要用同一条判定规则');
  assert.match(server, /taskId = `ui-run-\$\{started\}`/u, '要有可追溯的 task_id');
  assert.match(server, /verdict: judged\.verdict/u, '事件与快照要用同一个判定');
  assert.match(server, /reason: 'ok_text'/u, '只读工具以「拿到内容」为 confirmed，别伪装成有回执');
});

test('页面跑完自动核对（不再要人手动点「检查跑完的结果」）', () => {
  const server = readFileSync(new URL('../connect/server.mjs', import.meta.url), 'utf8');
  assert.match(server, /await verifyAfter\(action, \{ root, db, probes: systemProbes\(\{ root \}\) \}\)/u, '跑完要自动核对');
  assert.match(server, /const afterView = after \? \{ verdict: after\.verdict/u, '要把核对结果整理成 afterView');
  assert.match(server, /after: afterView/u, '要把核对结果带回给页面');
  const ui = readFileSync(new URL('../connect/live/live.js', import.meta.url), 'utf8');
  assert.match(ui, /runAfter/u, '页面要显示核对明细');
  assert.match(ui, /符合预期/u);
  // 没有跑后检查的动作（只读）不该在页面上渲染一个空盒子
  assert.match(ui, /payload\.after && \(payload\.after\.checks \?\? \[\]\)\.length/u);
});

test('临时放行：过期即失效、只对只读或已确认开放、写完能读到', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const {
    loadRunAllowlist, grantTemporarily, isAllowed, canRunFromUi, isSafeToSelfGrant, GRANT_MINUTES,
  } = await import('../connect/live/run-policy.mjs');

  const root = mkdtempSync(join(tmpdir(), 'grant-'));
  const now = Date.now();

  // 只读工具可以自助放行；没跑过的电话不行
  assert.equal(isSafeToSelfGrant('works.list').ok, true);
  assert.equal(isSafeToSelfGrant('qq.call').ok, false);
  assert.equal(isSafeToSelfGrant('qq.call', { lastVerdict: 'confirmed' }).ok, true, '跑通过一次就允许再跑');

  const granted = grantTemporarily('works.list', { root, now, minutes: GRANT_MINUTES });
  assert.equal(granted.ok, true);
  const allow = loadRunAllowlist(root);
  assert.deepEqual(allow.allowed, [], '临时放行不该写进永久清单');
  assert.equal(isAllowed('works.list', { ...allow, now }), true);
  assert.equal(canRunFromUi('works.list', { ...allow, now }).ok, true);

  // 过期后自动失效（不用记得收回）
  const later = now + (GRANT_MINUTES + 1) * 60_000;
  assert.equal(isAllowed('works.list', { ...allow, now: later }), false);
  assert.equal(canRunFromUi('works.list', { ...allow, now: later }).reason, 'not_allowed');
});

test('跑完要留一页可复制的回执（做了什么/结果/核对/要不要人看）', () => {
  const ui = readFileSync(new URL('../connect/live/live.js', import.meta.url), 'utf8');
  assert.match(ui, /runReceipt/u, '要有回执容器');
  assert.match(ui, /做了什么：/u);
  assert.match(ui, /实际结果：/u);
  assert.match(ui, /跑后核对：/u);
  assert.match(ui, /要不要人看一眼/u);
  assert.match(ui, /navigator\.clipboard\.writeText/u, '要能整段复制');
  assert.match(ui, /runCopy/u);
});

test('页面跑过的记录要落盘，关掉页面也还在', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { recordRun, recentRuns, runsDirOf } = await import('../connect/live/run-log.mjs');

  const root = mkdtempSync(join(tmpdir(), 'live-runs-'));
  // projectRoot 会向上找 package.json + scripts，这里伪造一个最小仓库
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{}');
  const at = Date.now();
  recordRun(root, { action: 'weather.get', at, elapsedMs: 12, verdict: 'confirmed', reason: 'ok_text', text: '晴 6°C' });
  recordRun(root, { action: 'weather.get', at: at + 1000, elapsedMs: 9, verdict: 'unconfirmed', reason: 'no_evidence', text: '第二次' });
  recordRun(root, { action: 'qq.call', at: at + 2000, elapsedMs: 3, verdict: 'failed', reason: 'device', text: '别的动作' });

  const runs = recentRuns(root, 'weather.get', 3);
  assert.equal(runs.length, 2, '只取这个动作的');
  assert.equal(runs[0].text, '第二次', '新的在前');
  assert.match(runsDirOf(root), /runtime\/connect\/live-runs$/u);
  assert.doesNotThrow(() => JSON.stringify(runs));
});

test('永久放行：只读动作能自助写进 allowed；公开动作只能主人自己写（带 snippet）', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { grantPermanently, loadRunAllowlist, isSafeToSelfGrant, allowlistSnippet } = await import('../connect/live/run-policy.mjs');

  const root = mkdtempSync(join(tmpdir(), 'grant-forever-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{}');

  const written = grantPermanently('weather.get', { root });
  assert.deepEqual(written.allowed, ['weather.get']);
  const again = loadRunAllowlist(root);
  assert.ok(again.allowed.includes('weather.get'), '写进去要能读回来');
  assert.equal(again.grants.length, 0, '永久放行不该混进临时清单');

  // 公开动作不许自助
  assert.equal(isSafeToSelfGrant('qq.call', { lastVerdict: null }).ok, false);
  assert.equal(isSafeToSelfGrant('qq.call', { lastVerdict: 'confirmed' }).ok, true, '已确认过的可以自助');
  assert.match(allowlistSnippet('qq.call'), /"allowed": \["qq\.call"\]/u);

  // 再写第二个，不该把第一个冲掉
  grantPermanently('works.list', { root });
  assert.deepEqual(loadRunAllowlist(root).allowed.sort(), ['weather.get', 'works.list']);
  assert.doesNotThrow(() => JSON.parse(readFileSync(join(root, 'runtime', 'connect', 'live-run.json'), 'utf8')));
});

test('跑完要自动刷新工具卡、就绪角标与报告页（不用手动重载）', async () => {
  const { readFileSync } = await import('node:fs');
  const ui = readFileSync(new URL('../connect/live/live.js', import.meta.url), 'utf8');
  assert.match(ui, /async function refreshAfterRun\(\)/u);
  assert.match(ui, /await refreshAfterRun\(\)/u, '跑成功之后要调用');
  assert.match(ui, /await paintReady\(\)/u, '就绪角标要跟着变');
  assert.match(ui, /if \(state\.tab === 'report'\) await renderReport\(\)/u, '停在报告页时要重绘');
  assert.doesNotMatch(ui, /location\.reload\(\)/u, '不许整页重载');
});

test('放行清单能写一句备注：压缩空白、截 160 字、不冲掉已有条目', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { writeAllowlistNote, loadRunAllowlist, grantPermanently } = await import('../connect/live/run-policy.mjs');

  const root = mkdtempSync(join(tmpdir(), 'grant-note-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{}');
  grantPermanently('weather.get', { root });

  const written = writeAllowlistNote('  11/18  验声卡链路\n临时放开 qq.call  ', { root });
  assert.equal(written.note, '11/18 验声卡链路 临时放开 qq.call');
  const again = loadRunAllowlist(root);
  assert.equal(again.note, written.note);
  assert.deepEqual(again.allowed, ['weather.get'], '写备注不该动 allowed');

  const long = writeAllowlistNote('好'.repeat(300), { root });
  assert.equal(long.note.length, 160);
});

test('预演：不执行动作，只给命令/影响/核对点；没 dry-run 的要说清', async () => {
  const { buildPreview } = await import('../connect/live/dry-run.mjs');
  const item = {
    title: '给爸爸打电话', command: 'node scripts/qq-call.mjs --keep --contact 七海',
    intro: '拨给爸爸，接通后自己说话', impact: '会真的拨给七海（爸爸）——他的手机会响。',
    expect: ['QQ 通话窗口出现并计时'], preflight: ['QQ 主窗口在屏上'],
  };
  const preview = buildPreview('qq.call', item);
  assert.equal(preview.supported, false, '拨号没有真正的 dry-run');
  assert.match(preview.why, /没有真正的 dry-run/u);
  assert.equal(preview.command, item.command);
  assert.deepEqual(preview.expect, item.expect, '跑完该核对什么要一并给');
  // 只读动作同样不执行，但也要能给命令
  assert.ok(buildPreview('weather.get', { command: 'brain', intro: '查天气' }).command);
});
