/**
 * 大肥鱼可自主执行的动作（白名单）。
 * 大脑在回复里写 [DO:名字]，渠道层负责真的执行，并回一句结果。
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { ensureBinaries } from './macui/index.mjs';
import { hangup } from './macui/qq.mjs';
import { skillDbPath, withSkillRun } from './skills/ledger.mjs';
import { normalizeChannel } from './agent-events.mjs';
import { openHub, recordActivity } from './memory-hub.mjs';
import { actionStage, safeRecordPerformance } from './performance.mjs';

const run = promisify(execFile);

// launchd 起的服务默认 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin，找不到 Homebrew 的 node / adb。
// 这里补上常用目录并统一用 process.execPath，子进程（douyin-post.mjs 里的 adb）也一起受益。
const EXTRA_PATH = ['/opt/homebrew/bin', '/opt/homebrew/opt/node@24/bin', '/usr/local/bin'];
process.env.PATH = [...new Set([...(process.env.PATH ?? '').split(':').filter(Boolean), ...EXTRA_PATH, '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
const NODE = process.execPath;

// 调度器传进来的是 connect 目录（runtime/connect），QQ 服务传的是项目根；
// 统一成一个「项目根」，脚本路径和 home 都按它算。
export { projectRoot } from './core/paths.mjs';
import { projectRoot as projectRootOf, homeOf } from './core/paths.mjs';
const projectRoot = projectRootOf;

export const ACTIONS = {
  'academy.study': {
    label: '去成长学院学一课',
    async run({ root }) {
      // 晚上 20:00 的学习块：挑一门没学完的课，写一句收获 + 一句练习，落进成长档案。
      const { runStudyBlock, openAcademyDb } = await import('./academy/study.mjs');
      const base = projectRoot(root);
      const db = openAcademyDb(base);
      try {
        const result = await runStudyBlock({ db, root: base, home: homeOf(base) });
        if (result.status === 'finished') return { text: '十二门课都学完了，可以进毕业项目了。', data: result };
        const text = result.degraded
          ? `「${result.courseTitle}」第 ${result.step}/${result.total} 步（${result.stepLabel}）时模型没接上（${result.error}），先用课程内容记了一笔：${result.summary}`
          : `「${result.courseTitle}」第 ${result.step}/${result.total} 步·${result.stepLabel}：${result.summary}${result.score != null ? `（考核 ${result.score} 分）` : ''}`;
        return { text: text.slice(0, 400), data: { ...result, verified: result.status !== 'failed', steps: [
          { id: 'pick_course', ok: Boolean(result.courseTitle), evidence: String(result.courseTitle ?? '') },
          { id: 'digest', ok: Boolean(result.summary), evidence: `${String(result.summary ?? '').length} 字${result.degraded ? '（降级）' : ''}` },
          { id: 'save', ok: Boolean(result.status), evidence: `第 ${result.step}/${result.total} 步 ${result.status}` },
        ] } };
      } finally { db.close(); }
    },
  },
  'academy.weekly': {
    label: '写这周的成长日记',
    async run({ root }) {
      // 每周一次：把最近 7 天的真实战绩写成周记，进成长档案。
      const { writeWeekly } = await import('./academy/weekly.mjs');
      const { openAcademyDb } = await import('./academy/study.mjs');
      const base = projectRoot(root);
      const db = openAcademyDb(base);
      try {
        const result = await writeWeekly(db, base, homeOf(base));
        return { text: `${result.title} 写好了${result.degraded ? '（模型没接上，用模板写的）' : ''}：${String(result.body).slice(0, 180)}`, data: { ...result, verified: Boolean(result.body), steps: [
          { id: 'collect', ok: Boolean(result.stats), evidence: `${result.stats?.from ?? ''}~${result.stats?.to ?? ''}` },
          { id: 'compose', ok: Boolean(result.body), evidence: `${String(result.body ?? '').length} 字${result.degraded ? '（降级）' : ''}` },
          { id: 'archive', ok: Boolean(result.status === 'weekly'), evidence: result.status },
        ] } };
      } finally { db.close(); }
    },
  },
  'douyin.reply_comments': {
    label: '回复收到的评论',
    async run({ root }) {
      // 走「消息 → 互动消息 → 收到的评论」，和人在手机上看到的未回复列表一致。
      // 内部已改用评论专用流水线（connect/core/comment-pipeline.mjs），每条回复都带回执状态。
      const { stdout } = await run(NODE, ['scripts/douyin.mjs', '--reply-inbox', '--generate', '--limit', '8'], { cwd: projectRoot(root), timeout: 1_200_000 });
      const data = lastJson(stdout);
      if (data?.replied !== undefined) {
        const rows = (data.results ?? []).filter((row) => row.sent);
        const lines = rows.slice(0, 3).map((row) => `「${String(row.comment).slice(0, 12)}」→ ${row.reply}`);
        // 回执五态：verified=业务核验过，accepted=平台收下了但没独立核对。
        const verified = rows.filter((row) => row.receipt === 'verified').length;
        const accepted = rows.filter((row) => row.receipt === 'accepted').length;
        const head = verified
          ? `回复了 ${data.replied} 条评论（${verified} 条已核验${accepted ? `，${accepted} 条平台已收` : ''}）`
          : `回复了 ${data.replied} 条评论${accepted ? `（${accepted} 条平台已收，没独立核验）` : ''}`;
        // 一条都没回的时候要分清两种：真的没活干（评论是图片/表情、或都回过了），
        // 还是该回却没回上。前者不该记成失败，否则每天都被误判一次。
        const allRows = data.results ?? [];
        const skipped = allRows.map((row) => row.skipped).filter(Boolean);
        const blockedRows = allRows.filter((row) => row.blocked);
        const failedRows = allRows.filter((row) => (row.error || row.sent === false) && !row.blocked);
        // 被闸门挡住（比如每小时 5 条上限）不是故障，也不是「没活干」——单独记 blocked
        if ((Number(data.replied) || 0) === 0 && blockedRows.length) {
          const reason = blockedRows[0].blocked;
          return {
            text: `这轮没发出去：${reason}（${blockedRows.length} 条待回，等额度恢复）`.slice(0, 400),
            data: { status: 'blocked', count: 0, sent: false, blocked: reason, scanned: allRows.length },
          };
        }
        // 「收件箱本来就没评论」也算没活干；但只要有真正失败的尝试，就不能算
        const idle = (Number(data.replied) || 0) === 0
          && blockedRows.length === 0
          && failedRows.length === 0
          && (skipped.length > 0
            ? skipped.every((reason) => ['no_content', 'already_replied', 'nothing_new'].includes(reason))
            : allRows.length === 0);
        // 带上结构化计数：判定层（connect/core/verify.mjs）要靠 data.count 才算得清「说回了几条、实际几条」。
        const scanned = allRows.length;
        const breakdown = skipped.reduce((acc, reason) => { acc[reason] = (acc[reason] ?? 0) + 1; return acc; }, {});
        return {
          text: (idle ? `没有可回的评论（${skipped[0] === 'no_content' ? '只剩图片或表情' : '都回过了'}）` : [head, ...lines].join('\n')).slice(0, 400),
          // 即使「没活干」也要留证据：扫了几条、为什么跳过——否则页面上只剩一句「没活干」，无法复核
          data: { status: 'ok', count: Number(data.replied) || 0, verified, accepted, scanned, ...(idle ? { nothingToDo: true, skipped, breakdown } : { breakdown }) },
        };
      }
      return summarize(stdout) || '评论回复已处理。';
    },
  },
  'douyin.hot_comment_round': {
    label: '去爆款视频底下回热评',
    async run({ root }) {
      // 搜索爆款 → 评论区按点赞挑最火的 2 条 → 逐条回复（合规闸门在脚本里）。
      const args = ['scripts/douyin.mjs', '--hot-comment-round', '--generate', '--videos', '2', '--per-video', '2'];
      const { stdout } = await run(NODE, args, { cwd: projectRoot(root), timeout: 1_500_000 });
      const data = lastJson(stdout);
      if (data?.rounds) {
        const done = data.rounds.reduce((sum, round) => sum + round.comments.filter((item) => item.sent).length, 0);
        const lines = data.rounds.filter((round) => !round.error).slice(0, 2)
          .map((round) => `「${String(round.video).slice(0, 14)}」下回了 ${round.comments.filter((item) => item.sent).length} 条`);
        const scanned = data.rounds.reduce((sum, round) => sum + (round.comments ?? []).length, 0);
        const skippedRows = data.rounds.flatMap((round) => (round.comments ?? []).filter((item) => !item.sent));
        const breakdown = skippedRows.reduce((acc, item) => {
          const key = item.skipped ?? item.reason ?? 'not_sent';
          acc[key] = (acc[key] ?? 0) + 1;
          return acc;
        }, {});
        return {
          text: [`今天在爆款下回了 ${done} 条`, ...lines].join('\n').slice(0, 400),
          // 同样：0 条也要能说清「看了多少、为什么没回」
          data: { status: 'ok', count: done, rounds: data.rounds.length, scanned, breakdown, ...(done === 0 ? { nothingToDo: true } : {}) },
        };
      }
      return summarize(stdout) || '爆款评论这一轮处理完了。';
    },
  },
  'douyin.check_interactions': {
    label: '看抖音有没有新互动',
    async run({ root }) {
      const { stdout } = await run(NODE, ['scripts/douyin.mjs', '--interactions'], { cwd: projectRoot(root), timeout: 120_000 });
      const data = lastJson(stdout);
      if (!data || !data.status) return summarize(stdout) || '互动消息看过了。';
      if (data.status === 'blocked') {
        const texts = (data.blockers ?? []).map((item) => item.text).filter(Boolean).join(' / ') || '未知弹窗';
        const kind = data.blockers?.[0]?.kind ?? 'unknown';
        throw new Error(`blocked_by_dialog:${kind}:${texts}`);
      }
      if (data.status === 'unconfirmed') throw new Error('interactions_unconfirmed:没读到评论列表，也没看到空态提示');
      if (data.status === 'empty') {
        return { text: `看过了，确实没有新评论（页面显示「${data.emptyProof ?? '暂无更多'}」）`, data };
      }
      const rows = data.rows ?? [];
      const lines = rows.map((row, index) => `${index + 1}. ${row.author}：${String(row.text).slice(0, 40)}`);
      return { text: `收到的评论 ${data.count} 条：\n${lines.join('\n')}`, data };
    },
  },
  'douyin.comment_latest': {
    label: '给对标账号最新作品评论',
    async run({ root, args = {} }) {
      const keyword = args.keyword ?? '大肥鱼';
      // 搜索结果页偶尔没加载完就点了卡片（result_not_found / 面板没弹出），整条重试一次比在原地猜便宜
      let stdout = '';
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          ({ stdout } = await run(NODE, ['scripts/douyin.mjs', '--auto-comment', '--keyword', keyword, '--pick', '1', '--generate'], { cwd: projectRoot(root), timeout: 240_000 }));
        } catch (error) {
          if (attempt === 1) throw error;
          continue;
        }
        if (stdout.includes('RESULT_JSON ')) break;
      }
      // 判定层需要「到底发没发出去」这个结构化事实：脚本最后一行 JSON 里的 sent/verified
      let sent = null;
      let verified = null;
      let video = '';
      let blocked = '';
      for (const line of String(stdout).split('\n')) {
        const text = line.trim();
        if (!text.startsWith('RESULT_JSON ')) continue;
        try {
          const parsed = JSON.parse(text.slice('RESULT_JSON '.length));
          if (parsed.video) video = String(parsed.video).slice(0, 60);
          if (parsed.blocked) blocked = `${parsed.blocked}:${parsed.reason ?? ''}`;
      if (typeof parsed.sent === 'boolean') { sent = parsed.sent; verified = parsed.verified ?? null; }
        } catch { /* 坏行跳过 */ }
      }
      const text = summarize(stdout) || '评论任务已执行。';
      if (sent === null) return text;
      if (sent === false && blocked) {
        // 被闸门挡住：这不是失败，是「这次不该发」
        return { text, data: { status: 'blocked', count: 0, sent: false, blocked } };
      }
      return { text, data: { status: sent ? 'ok' : 'failed', count: sent ? 1 : 0, sent, verified, video } };
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
        // 之前这里直接引用了一个不存在的 loadTargets（只写在别处），browse 一调就 ReferenceError。
        const { loadTargets } = await import('./targets.mjs');
        const serial = loadTargets(projectRoot(root)).deviceSerial || undefined;
        const nodes = await dumpUi(serial).catch(() => []);
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
      return { text: `看了 ${watched} 条视频，按每条看完的节奏走的。`, data: { verified: watched > 0, steps: [
        { id: 'open_app', ok: true, evidence: 'SplashActivity' },
        { id: 'open_feed', ok: true, evidence: '信息流' },
        { id: 'watch', ok: watched > 0, evidence: `${watched} 条` },
      ] } };
    },
  },
  'douyin.draft': {
    // 只写内容、不碰手机：生成标题/正文/话题/配图，交爸爸审。
    label: '写一条抖音图文草稿（先审内容）',
    async run({ root, args }) {
      const argv = ['scripts/douyin-post.mjs', '--plan'];
      if (args?.theme) argv.push('--theme', String(args.theme));
      const { stdout } = await run(NODE, argv, { cwd: projectRoot(root), timeout: 300_000 });
      const draft = parseReady(stdout);
      if (!draft || draft.status !== 'draft' || !draft.draftFile) throw new Error('draft_output_missing');
      return { text: `草稿写好了：${draft.title ?? ''}`, data: draft };
    },
  },
  'douyin.publish_draft': {
    // 爸爸审过内容之后：按草稿填发布页，然后立刻点「发作品」。
    label: '按审过的内容发一条抖音图文',
    async run({ root, args }) {
      const base = projectRoot(root);
      if (!args?.draft) throw new Error('draft_missing');
      await run(NODE, ['scripts/douyin-post.mjs', '--draft', String(args.draft)], { cwd: base, timeout: 480_000 });
      const { stdout } = await run(NODE, ['scripts/douyin-confirm.mjs'], { cwd: base, timeout: 180_000 });
      const result = parseReady(stdout) ?? {};
      if (result.status === 'unconfirmed') throw new Error('publish_unconfirmed:点了发作品，但没在作品页看到正文');
      if (result.status !== 'published') throw new Error(result.error ?? 'publish_unverified');
      return { text: `发出去了${result.workCode ? `（${result.workCode}）` : ''}：${result.title ?? ''}`, data: result };
    },
  },
  'douyin.publish': {
    // 二审（发布）通过后：只点「发作品」并核对结果。
    label: '发布审核过的抖音图文',
    async run({ root }) {
      const { stdout } = await run(NODE, ['scripts/douyin-confirm.mjs'], { cwd: projectRoot(root), timeout: 180_000 });
      const result = parseReady(stdout) ?? {};
      if (result.status === 'unconfirmed') throw new Error('publish_unconfirmed:点了发作品，但没在作品页看到正文');
      if (result.status !== 'published') throw new Error(result.error ?? 'publish_unverified');
      return result.visible ? '已经发出去，作品页能看到正文。' : '已经点发布，但没在页面上核对到正文，你看一眼。';
    },
  },
  'douyin.publish_video': {
    // 发布一条本地视频：分享 intent 进剪辑页 → 下一步到发布页 → 收话题面板 → 发作品。
    // 标题/正文/标签由调用方给，脚本自己落库与记活动。
    label: '发布一条本地视频到抖音',
    async run({ root, args }) {
      const file = String(args?.file ?? '').trim();
      if (!file) throw new Error('video_file_required');
      if (!existsSync(file)) throw new Error(`video_file_missing:${file}`);
      const argv = ['scripts/douyin-video.mjs', '--file', file, '--publish'];
      if (args?.title) argv.push('--title', String(args.title));
      if (args?.caption) argv.push('--caption', String(args.caption));
      if (args?.tags) argv.push('--tags', String(args.tags));
      const { stdout } = await run(NODE, argv, { cwd: projectRoot(root), timeout: 600_000 });
      const result = parseReady(stdout) ?? {};
      if (!result.ok) throw new Error(result.error ?? `video_publish_${result.stage ?? 'unknown'}`);
      return { text: `视频发出去了：《${result.title ?? result.caption?.slice(0, 16) ?? ''}》`, data: result };
    },
  },
  'qq.call': {
    label: '给爸爸打电话（QQ 七海）',
    async run({ root }) {
      const { spawn } = await import('node:child_process');
      const child = spawn(NODE, ['scripts/qq-call.mjs', '--keep', '--contact', '七海'], { cwd: projectRoot(root), detached: true, stdio: 'ignore' });
      child.unref();
      return '正在给爸爸（QQ 七海）拨语音，接通后我会自己说话。';
    },
  },
  'qq.call_mom': {
    label: '给妈妈打电话（QQ 小朋友）',
    async run({ root }) {
      const { spawn } = await import('node:child_process');
      const child = spawn(NODE, ['scripts/qq-call.mjs', '--keep', '--contact', '小朋友'], { cwd: projectRoot(root), detached: true, stdio: 'ignore' });
      child.unref();
      return '正在给妈妈（QQ 小朋友）拨语音，接通后我会自己说话。';
    },
  },
  'wechat.call': {
    label: '给妈妈打电话（微信 敢敢不憨了）',
    async run({ root }) {
      const { spawn } = await import('node:child_process');
      const child = spawn(NODE, ['scripts/wechat-call.mjs', '--keep', '--contact', '敢敢不憨了'], { cwd: projectRoot(root), detached: true, stdio: 'ignore' });
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

/** 从 stdout 里取最靠后的那段可解析 JSON。 */
function lastJson(stdout) {
  const text = String(stdout ?? '');
  for (let at = text.lastIndexOf('{'); at >= 0; at = text.lastIndexOf('{', at - 1)) {
    try {
      return JSON.parse(text.slice(at));
    } catch {
      // 继续往前找
    }
  }
  return null;
}

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

/** 从脚本 stdout 里取最靠后的那段 JSON（prepare 会把 ready 对象打在最后）。 */
function parseReady(stdout) {
  const text = String(stdout ?? '').trim();
  for (let i = text.lastIndexOf('{'); i >= 0; i = text.lastIndexOf('{', i - 1)) {
    try { return JSON.parse(text.slice(i)); } catch {}
  }
  return null;
}

export function actionMarkerNames(text) {
  const names = [];
  for (const match of String(text ?? '').matchAll(/\[DO:([a-z0-9_.]+)\]/giu)) names.push(match[1]);
  return [...new Set(names)];
}

export function stripActionMarkers(text) {
  return String(text ?? '').replace(/\[DO:[a-z0-9_.]+\]/giu, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * 动手机的动作都依赖「adb 能看到恰好一台设备」。
 * 之前没有预检：手机一掉线，脚本照样跑 200 多秒，最后抛一句
 * 「微信发送需要恰好一台已授权设备」——既慢又看不懂。
 * 这里在动手前先花 200ms 看一眼，没设备就立刻给出人能读懂的失败。
 */
function countAdbDevices() {
  const out = execFileSync('adb', ['devices'], { encoding: 'utf8', timeout: 8_000 });
  return out.split(/\r?\n/u).slice(1).filter((line) => /\bdevice\b/u.test(line)).length;
}

/** adb 掉过设备后会一直显示 0 台（server 还在，但设备没回来），重启 server 通常就好了。 */
function reviveAdb() {
  for (const args of [['reconnect', 'offline'], ['kill-server'], ['start-server']]) {
    try { execFileSync('adb', args, { timeout: 8_000, stdio: 'ignore' }); } catch { /* 尽力而为 */ }
  }
}

export function devicePreflight() {
  try {
    let count = countAdbDevices();
    let revived = false;
    if (count === 0) {
      // 自己救一次：杀掉僵死的 adb server 再起来，多数掉线都能恢复。
      reviveAdb();
      revived = true;
      count = countAdbDevices();
    }
    if (count === 1) return { ok: true, count, revived };
    return { ok: false, count, revived, reason: count === 0 ? 'no_device' : 'multiple_devices' };
  } catch (error) {
    return { ok: false, count: 0, reason: 'adb_missing', error: String(error?.message ?? error).slice(0, 120) };
  }
}

const NEEDS_DEVICE = /^(douyin\.|device\.)/u;

export async function runAction(name, { root, args, channel = 'system', taskId = null } = {}) {
  const action = ACTIONS[name];
  if (!action) return { ok: false, error: `unknown_action:${name}` };
  if (NEEDS_DEVICE.test(name)) {
    const pre = devicePreflight();
    if (!pre.ok) {
      const why = pre.reason === 'no_device'
        ? '手机没连上（adb 看到 0 台）：插上 USB 或打开无线调试，再让我做这件事。'
        : pre.reason === 'multiple_devices'
          ? `adb 看到 ${pre.count} 台设备，我不确定该动哪台：先只留一台再试。`
          : '找不到 adb 命令：检查 ADB_PATH 或 Homebrew 的 android-platform-tools。';
      // 也记一笔学习账本，方便看出「掉设备」到底多频繁（别和逻辑 bug 混成一类）。
      try {
        const { reflectOnActionFailure } = await import('./core/reflect.mjs');
        const db = new DatabaseSync(skillDbPath(root));
        reflectOnActionFailure(db, { operation: name, reason: `no_device: adb=${pre.count}`, now: Date.now() });
        db.close();
      } catch { /* 学习是附加信息，不影响本次返回 */ }
      return { ok: false, error: why, data: { status: 'no_device', count: pre.count } };
    }
  }
  const started = Date.now();
  try {
    const outcome = await withSkillRun(root, { action: name }, () => action.run({ root, args }));
    const text = typeof outcome === 'string' ? outcome : String(outcome?.text ?? '');
    const data = outcome && typeof outcome === 'object' ? outcome.data : undefined;
    const durationMs = Date.now() - started;
    sampleActionPerformance(root, { name, durationMs, success: true, channel, taskId });
    record(name, action, true, text, durationMs, root);
    return { ok: true, text, ...(data ? { data } : {}) };
  } catch (error) {
    const message = String(error?.message ?? error).slice(0, 160);
    const durationMs = Date.now() - started;
    sampleActionPerformance(root, { name, durationMs, success: false, channel, taskId, error: message });
    record(name, action, false, message, durationMs, root);
    return { ok: false, error: message };
  }
}

/**
 * 把一次动作执行落成性能样本（计划 P1-C / C-5）。
 *
 * connect 库平时由 server 长期持有，这里单独开一条短连接写完就关；
 * 库路径复用 skills/ledger 的 skillDbPath(root)（和 server 用的是同一个 connect.sqlite）。
 * 整段包在 try/catch 里：采样是旁路，写不进去也不能让动作失败。
 */
function sampleActionPerformance(root, { name, durationMs, success, channel = 'system', taskId = null, error = null }) {
  let db = null;
  try {
    db = new DatabaseSync(skillDbPath(root));
    db.exec('PRAGMA busy_timeout = 3000');
    safeRecordPerformance(db, {
      stage: actionStage(name),
      channel: normalizeChannel(channel),
      taskId,
      durationMs,
      success,
      metadata: error ? { action: name, error } : { action: name },
    });
  } catch (err) {
    process.stderr.write(`performance_sample_failed:${String(err?.message ?? err).slice(0, 160)}\n`);
  } finally {
    try { db?.close(); } catch {}
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
