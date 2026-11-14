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
      const n = Math.min(Math.max(Number(args.count ?? 8), 3), 20);
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const run1 = promisify(execFile);
      await run1('adb', ['shell', 'am', 'start', '-n', 'com.ss.android.ugc.aweme/.splash.SplashActivity'], { timeout: 30_000 });
      await new Promise((r) => setTimeout(r, 3500));
      for (let i = 0; i < n; i += 1) {
        await run1('adb', ['shell', 'input', 'swipe', '656', '2100', '656', '800', '320'], { timeout: 20_000 });
        await new Promise((r) => setTimeout(r, 2200));
      }
      return `刷了 ${n} 条视频。`;
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
  try {
    const text = await action.run({ root, args });
    return { ok: true, text };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error).slice(0, 160) };
  }
}
