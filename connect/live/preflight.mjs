// 「放行前能不能真跑」的机器核验。
//
// 只读：不点手机、不改文件、不发消息。默认探针会去问系统（adb / pgrep / 窗口列表），
// 测试可以注入 probes 全换成假的。所有动作的检查项都来自 tool-meta 里写的 preflight 条件，
// 能机器判断的给 ✅/❌，判断不了的（比如「这个时间点打扰别人合适吗」）留给主人。
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot, runtimeDir } from '../core/paths.mjs';

const run = (cmd, args, timeout = 4000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout }, (error, stdout) => resolve({ ok: !error, out: String(stdout ?? '') }));
});

/** 默认探针：真去问系统。每个都返回 { ok, detail }。 */
export function systemProbes({ root = process.cwd() } = {}) {
  const base = projectRoot(root);
  return {
    async device() {
      const { ok, out } = await run('adb', ['devices']);
      const lines = out.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('List of devices'));
      const online = lines.filter((line) => /\bdevice$/u.test(line));
      if (!ok) return { ok: false, detail: 'adb 不可用' };
      if (online.length === 1) return { ok: true, detail: `1 台在线（${online[0].split('\t')[0]}）` };
      return { ok: false, detail: online.length === 0 ? '0 台在线' : `${online.length} 台在线（要求恰好 1 台）` };
    },
    async wechat() {
      const { out } = await run('/usr/bin/pgrep', ['-fl', 'WeChat|微信']);
      const alive = out.split('\n').some((line) => /WeChat\.app|微信\.app/u.test(line));
      return alive ? { ok: true, detail: '微信桌面端在跑' } : { ok: false, detail: '微信桌面端没启动' };
    },
    async qqWindow() {
      const { ok, out } = await run(process.execPath, ['-e', `
        const { ensureBinaries, listWindows } = await import(${JSON.stringify(join(base, 'connect/macui/index.mjs'))});
        const bins = ensureBinaries(${JSON.stringify(base)});
        const wins = listWindows(bins, 'QQ');
        console.log(JSON.stringify(wins.map((w) => ({ name: w.name, width: w.width, height: w.height }))));
      `], 6000);
      if (!ok) return { ok: false, detail: '读不到 QQ 窗口（可能要屏幕录制权限）' };
      let wins = [];
      try { wins = JSON.parse(out.trim().split('\n').pop() || '[]'); } catch { wins = []; }
      if (!wins.length) return { ok: false, detail: 'QQ 没有在屏上的窗口' };
      const named = wins.filter((w) => w.name).length;
      return { ok: true, detail: `${wins.length} 个窗口${named ? '（标题可读）' : '（标题读不到，可能需要屏幕录制权限）'}` };
    },
    async qqCallWindow() {
      const { ok, out } = await run(process.execPath, ['-e', `
        const { ensureBinaries, listWindows } = await import(${JSON.stringify(join(base, 'connect/macui/index.mjs'))});
        const bins = ensureBinaries(${JSON.stringify(base)});
        const wins = listWindows(bins, 'QQ');
        console.log(JSON.stringify(wins.map((w) => w.name ?? '')));
      `], 6000);
      if (!ok) return { ok: false, detail: '读不到 QQ 窗口' };
      let names = [];
      try { names = JSON.parse(out.trim().split('\n').pop() || '[]'); } catch { names = []; }
      const call = names.find((name) => /语音|视频/u.test(name));
      return call ? { ok: true, detail: `正在通话：${call}` } : { ok: false, detail: '当前没有进行中的通话' };
    },
    async draft() {
      const dir = join(runtimeDir(base), 'douyin');
      const pending = join(dir, 'pending.json');
      if (existsSync(pending)) return { ok: true, detail: 'pending.json 已就绪（可直接发）' };
      const drafts = join(dir, 'drafts');
      if (!existsSync(drafts)) return { ok: false, detail: '还没有草稿' };
      const files = readdirSync(drafts).filter((name) => name.endsWith('.json'));
      let ready = 0;
      for (const name of files) {
        try {
          const data = JSON.parse(readFileSync(join(drafts, name), 'utf8'));
          if (data?.status === 'draft' || data?.status === 'pending') ready += 1;
        } catch { /* 坏文件忽略 */ }
      }
      return ready ? { ok: true, detail: `${ready} 份草稿可发` } : { ok: false, detail: '草稿目录里没有可发的' };
    },
  };
}

/** 动作 → 用哪几个探针。判断不了的条件（时间是否合适、内容是否认可）不在这里。 */
const NEEDS = {
  'qq.call': ['qqWindow'],
  'qq.call_mom': ['qqWindow'],
  'wechat.call': ['wechat'],
  'qq.hangup': ['qqWindow', 'qqCallWindow'],
  'douyin.publish': ['device', 'draft'],
  'douyin.publish_draft': ['device', 'draft'],
  'douyin.publish_video': ['device'],
};

/**
 * 依赖手机的动作：核验成本低（一次 `adb devices` 就够），顺手把「手机在不在」告诉定时任务页。
 * 这些不是「需要主人授权」的动作，所以单独一组，别让顶栏的「授权项就绪 X/Y」把它们算进去。
 */
const DEVICE_ACTIONS = [
  'douyin.daily_post', 'douyin.draft', 'douyin.publish', 'douyin.publish_draft', 'douyin.publish_video',
  'douyin.reply_comments', 'douyin.hot_comment_round', 'douyin.check_interactions', 'douyin.comment_latest',
  'douyin.browse', 'device.page',
];

const GROUP = {};
for (const action of Object.keys(NEEDS)) GROUP[action] = 'authorized';
for (const action of DEVICE_ACTIONS) if (!GROUP[action]) GROUP[action] = 'device';
for (const action of DEVICE_ACTIONS) if (!NEEDS[action]) NEEDS[action] = ['device'];

export const PROBE_ACTIONS = Object.keys(NEEDS).filter((action) => GROUP[action] === 'authorized');
export const DEVICE_ACTIONS_LIST = DEVICE_ACTIONS;
export const ALL_PROBE_ACTIONS = Object.keys(NEEDS);
export const groupOf = (action) => GROUP[action] ?? null;

/**
 * 核验一批动作。probes 可注入（测试用假的）。
 * @returns {{ checkedAt:number, results:Record<string,{action,checks:{key,ok,detail}[],ready:boolean}> }}
 */
export async function probePreflight({ root = process.cwd(), actions = ALL_PROBE_ACTIONS, probes = null } = {}) {
  const table = probes ?? systemProbes({ root });
  const results = {};
  for (const action of actions) {
    const needs = NEEDS[action];
    if (!needs) continue;
    const checks = [];
    for (const key of needs) {
      const probe = table[key];
      if (!probe) { checks.push({ key, ok: false, detail: '没有这个探针' }); continue; }
      try {
        const result = await probe();
        checks.push({ key, ok: Boolean(result?.ok), detail: result?.detail ?? '' });
      } catch (error) {
        checks.push({ key, ok: false, detail: `探测失败：${error.message}`.slice(0, 80) });
      }
    }
    results[action] = { action, group: GROUP[action] ?? 'authorized', checks, ready: checks.every((check) => check.ok) };
  }
  return { checkedAt: Date.now(), results };
}

/** 这个动作有没有前置核验项（设备类会自动补 device，所以 DEVICE_ACTIONS 也算）。 */
export function hasPreflight(action) {
  // 空数组也算「声明过前置为无」——和「忘了写」要能区分开
  return Object.prototype.hasOwnProperty.call(NEEDS, action);
}
