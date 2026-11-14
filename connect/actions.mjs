/**
 * 大肥鱼可自主执行的动作（白名单）。
 * 大脑在回复里写 [DO:名字]，渠道层负责真的执行，并回一句结果。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureBinaries } from './macui/index.mjs';
import { hangup } from './macui/qq.mjs';

const run = promisify(execFile);

export const ACTIONS = {
  'douyin.reply_comments': {
    label: '回复抖音的互动消息',
    async run({ root }) {
      const { stdout } = await run('node', ['scripts/douyin.mjs', '--reply-interaction', '0', '--generate'], { cwd: root, timeout: 180_000 });
      return summarize(stdout) || '抖音互动回复已处理。';
    },
  },
  'douyin.check_interactions': {
    label: '看抖音有没有新互动',
    async run({ root }) {
      const { stdout } = await run('node', ['scripts/douyin.mjs', '--interactions'], { cwd: root, timeout: 120_000 });
      return summarize(stdout) || '互动消息看过了。';
    },
  },
  'douyin.comment_latest': {
    label: '给对标账号最新作品评论',
    async run({ root, args = {} }) {
      const keyword = args.keyword ?? '大肥鱼';
      const { stdout } = await run('node', ['scripts/douyin.mjs', '--auto-comment', '--keyword', keyword, '--pick', '1', '--generate'], { cwd: root, timeout: 240_000 });
      return summarize(stdout) || '评论任务已执行。';
    },
  },
  'douyin.browse': {
    label: '刷一会儿抖音',
    async run({ root, args = {} }) {
      const n = Math.min(Math.max(Number(args.count ?? 5), 2), 12);
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { watchDelayMs, sleep, swipeJitter } = await import('./douyin/humanize.mjs');
      const run1 = promisify(execFile);
      await run1('adb', ['shell', 'am', 'start', '-n', 'com.ss.android.ugc.aweme/.splash.SplashActivity'], { timeout: 30_000 });
      await sleep(4000);
      const { dumpUi } = await import('../device/uia.mjs');
      const signature = async () => {
        const nodes = await dumpUi('ARMR023302000316').catch(() => []);
        const longest = nodes.filter((x) => (x.text ?? '').length > 12).map((x) => x.text.trim()).sort((a, b) => b.length - a.length)[0] ?? '';
        return longest.slice(0, 40);
      };
      let watched = 0;
      for (let i = 0; i < n; i += 1) {
        const stay = watchDelayMs();
        await sleep(stay);
        watched += 1;
        if (i === n - 1) break;
        const before = await signature();
        let moved = false;
        for (let attempt = 0; attempt < 3 && !moved; attempt += 1) {
          const [x1, y1, x2, y2, ms] = swipeJitter({ y0: 2300 + attempt * 80, y1: 700 - attempt * 60 });
          await run1('adb', ['shell', 'input', 'swipe', String(x1), String(y1), String(x2), String(y2), String(ms)], { timeout: 20_000 });
          await sleep(rand0(1400, 2800));
          moved = (await signature()) !== before;
        }
        if (!moved) {
          await run1('adb', ['shell', 'input', 'keyevent', '4'], { timeout: 10_000 });
          await sleep(1200);
          await run1('adb', ['shell', 'input', 'tap', '119', '2730'], { timeout: 10_000 });
          await sleep(1800);
        }
      }
      return `看了 ${watched} 条视频，按每条看完的节奏走的。`;
    },
  },
  'douyin.publish': {
    label: '发一条图文日常',
    async run({ root }) {
      const { readFileSync, writeFileSync, existsSync, mkdirSync } = await import('node:fs');
      const { join } = await import('node:path');
      const stateDir = join(root, 'runtime', 'douyin');
      const stateFile = join(stateDir, 'publish-state.json');
      mkdirSync(stateDir, { recursive: true });
      const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
      const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { dates: [] };
      const countToday = (state.dates ?? []).filter((d) => d === today).length;
      if (countToday >= 2) return '今天已经发了两条啦，剩下的留到明天，免得刷屏～';
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execAsync = promisify(execFile);
      const { stdout } = await execAsync('node', ['scripts/douyin-post.mjs', '--publish'], { cwd: root, timeout: 480_000 });
      (state.dates ??= []).push(today);
      writeFileSync(stateFile, JSON.stringify(state, null, 2));
      const tail = String(stdout).trim().split('\n').slice(-6).join(' ');
      return tail.slice(0, 160) || '图文发出去了。';
    },
  },
  'qq.call': {
    label: '给爸爸打电话（QQ 七海）',
    async run({ root }) {
      const { spawn } = await import('node:child_process');
      const child = spawn('node', ['scripts/qq-call.mjs', '--keep', '--contact', '七海'], { cwd: root, detached: true, stdio: 'ignore' });
      child.unref();
      return '正在给爸爸（QQ 七海）拨语音，接通后我会自己说话。';
    },
  },
  'qq.call_mom': {
    label: '给妈妈打电话（QQ 小朋友）',
    async run({ root }) {
      const { spawn } = await import('node:child_process');
      const child = spawn('node', ['scripts/qq-call.mjs', '--keep', '--contact', '小朋友'], { cwd: root, detached: true, stdio: 'ignore' });
      child.unref();
      return '正在给妈妈（QQ 小朋友）拨语音，接通后我会自己说话。';
    },
  },
  'wechat.call': {
    label: '给妈妈打电话（微信 敢敢不憨了）',
    async run({ root }) {
      const { spawn } = await import('node:child_process');
      const child = spawn('node', ['scripts/wechat-call.mjs', '--keep', '--contact', '敢敢不憨了'], { cwd: root, detached: true, stdio: 'ignore' });
      child.unref();
      return '正在给妈妈（微信 敢敢不憨了）拨语音，接通后我会自己说话。';
    },
  },
  'qq.hangup': {
    label: '挂断 QQ 通话',
    async run({ root }) {
      const done = await hangup(ensureBinaries(root));
      return done ? '挂了。' : '现在没有正在进行的 QQ 通话。';
    },
  },
};

function rand0(min, max) { return Math.round(min + Math.random() * (max - min)); }

function summarize(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return '';
  try {
    const data = JSON.parse(text.slice(text.indexOf('{')));
    return [data.sent !== undefined ? `sent=${data.sent}` : '', data.drafted ?? data.text ?? '', data.error ?? ''].filter(Boolean).join(' · ').slice(0, 120);
  } catch {
    return text.split('\n').slice(-2).join(' ').slice(0, 120);
  }
}

export function actionMarkerNames(text) {
  const names = [];
  for (const match of String(text ?? '').matchAll(/\[DO:([a-z0-9_.]+)\]/giu)) names.push(match[1]);
  return [...new Set(names)];
}

export function stripActionMarkers(text) {
  return String(text ?? '').replace(/\[DO:[a-z0-9_.]+\]/giu, '').replace(/\s{2,}/g, ' ').trim();
}

export async function runAction(name, { root, args } = {}) {
  const action = ACTIONS[name];
  if (!action) return { ok: false, error: `unknown_action:${name}` };
  const started = Date.now();
  try {
    const text = await action.run({ root, args });
    record(name, action, true, text, Date.now() - started, root);
    return { ok: true, text };
  } catch (error) {
    const message = String(error?.message ?? error).slice(0, 160);
    record(name, action, false, message, Date.now() - started, root);
    return { ok: false, error: message };
  }
}

function record(name, action, ok, detail, ms, root) {
  try {
    const hub = openHub(root ?? process.cwd());
    if (!hub) return;
    const line = ok ? `执行「${action.label ?? name}」完成${detail ? `：${String(detail).slice(0, 80)}` : ''}` : `执行「${action.label ?? name}」失败：${String(detail).slice(0, 80)}`;
    recordActivity(hub, line, { channel: 'action' });
  } catch {}
}
