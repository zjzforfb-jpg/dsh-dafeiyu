import { execFileSync } from 'node:child_process';
import { getWeather } from '../tools/weather.mjs';
import { openDouyinDb, listComments, listWorks, contentSummary } from '../douyin/store.mjs';
import { capabilityFiles, readCapability, readCapabilityCode } from '../memory/capabilities.mjs';
import { isRunStatus } from '../core/capability.mjs';
import { projectRoot } from '../core/paths.mjs';

/**
 * 只读工具注册表：模型能「查」，不能「做」。
 * 写入类动作（发图文、回评论、打电话）仍走原来的任务 + 爸爸确认，
 * 等只读这条路稳定了再逐个挪过来。
 */
export const READONLY_TOOLS = [
  {
    name: 'weather.get',
    desc: '查某地现在的天气和今天温度范围',
    args: { city: { type: 'string', desc: '城市名，默认石家庄' } },
    async run(args, ctx) {
      const city = String(args.city ?? '').trim() || '石家庄';
      const weather = await getWeather(city, { fetchImpl: ctx.fetchImpl ?? fetch });
      return weather.text;
    },
  },
  {
    name: 'works.list',
    desc: '列出发过的抖音图文作品（标题、时间、评论数）',
    args: { limit: { type: 'number', desc: '最多几条，默认 10' } },
    async run(args, ctx) {
      const db = ctx.douyinDb ?? openDouyinDb(ctx.root);
      const rows = listWorks(db, { limit: clamp(args.limit, 10, 1, 50) });
      if (!rows.length) return '库里还没有发过的作品记录。';
      const summary = contentSummary(db);
      const lines = rows.map((w, i) => {
        const when = localTime(w.published_at ?? w.created_at);
        return `${i + 1}. 「${w.title || '（无标题）'}」 ${when} 评论 ${w.comments ?? 0} 条${w.status === 'discovered' ? '' : ''}`;
      });
      return `一共 ${summary.works} 条作品（评论 ${summary.comments} 条，已回复 ${summary.replied} 条）：\n${lines.join('\n')}`;
    },
  },
  {
    name: 'comments.list',
    desc: '列出评论以及我回过的内容（可按作品过滤）',
    args: { workId: { type: 'string', desc: '只查某个作品，比如 profile:1' }, limit: { type: 'number', desc: '最多几条，默认 10' } },
    async run(args, ctx) {
      const db = ctx.douyinDb ?? openDouyinDb(ctx.root);
      const workId = String(args.workId ?? '').trim() || null;
      const rows = listComments(db, { workId, limit: clamp(args.limit, 10, 1, 50) });
      if (!rows.length) return workId ? `作品 ${workId} 还没有评论记录。` : '库里还没有评论记录。';
      const lines = rows.map((c) => {
        const who = c.author || '（作者未知）';
        const what = c.text ? `「${String(c.text).slice(0, 40)}」` : '（只有图片或表情）';
        const reply = c.reply_text ? ` → 我回了「${String(c.reply_text).slice(0, 40)}」` : ' → 还没回';
        return `${who}：${what}${reply}${c.work_title ? `（作品「${c.work_title}」）` : ''}`;
      });
      return `最近 ${rows.length} 条评论：\n${lines.join('\n')}`;
    },
  },
  {
    name: 'douyin.check_interactions',
    desc: '真的打开手机上的抖音「互动消息」，看最近有没有新评论/新赞（只读，不动账号，约 20-40 秒）',
    args: {},
    async run(_args, ctx) {
      const out = execFileSync(process.execPath, ['scripts/douyin.mjs', '--interactions'], {
        cwd: toolCwd(ctx), encoding: 'utf8', timeout: 150000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: process.env.PATH ?? '' },
      });
      const text = String(out ?? '').trim();
      let data = null;
      for (let at = text.lastIndexOf('{'); at >= 0; at = text.lastIndexOf('{', at - 1)) {
        try { data = JSON.parse(text.slice(at)); break; } catch { /* 继续往前找 */ }
      }
      if (!data?.status) return { ok: true, text: text || '抖音互动消息页打开过，但没读到条目。' };
      if (data.status === 'blocked') {
        const texts = (data.blockers ?? []).map((item) => item.text).filter(Boolean).join(' / ') || '未知弹窗';
        return { ok: false, status: 'blocked', verified: false, blockers: data.blockers, text: `被弹窗挡住了：${texts}。没看成评论区，别当成「没有新评论」。` };
      }
      if (data.status === 'unconfirmed') return { ok: false, status: 'unconfirmed', verified: false, text: '评论区既没读到内容、也没看到空态提示，这次等于没看成。' };
      if (data.status === 'empty') return { ok: true, status: 'empty', verified: true, text: `看过了，确实没有新评论（页面显示「${data.emptyProof ?? '暂无更多'}」）。` };
      const rows = data.rows ?? [];
      const body = rows.map((row, index) => `${index + 1}. ${row.author}：${row.text}`).join('\n');
      return { ok: true, status: 'ok', verified: true, text: `收到的评论 ${data.count} 条：\n${body}` };
    },
  },
  {
    name: 'academy.weekly',
    desc: '把这周的真实战绩写成一篇成长日记，存进成长档案（约 30 秒）',
    args: {},
    async run(_args, ctx) {
      const { runAction } = await import('../actions.mjs');
      const result = await runAction('academy.weekly', { root: ctx.root });
      return String(result?.text ?? result?.detail ?? '周记没写成。');
    },
  },
  {
    name: 'device.page',
    desc: '看手机现在停在哪个应用和页面',
    args: {},
    async run(_args, ctx) {
      const adb = ctx.adb ?? 'adb';
      const out = execFileSync(adb, ['shell', 'dumpsys', 'window'], { encoding: 'utf8', timeout: 6000, stdio: ['ignore', 'pipe', 'ignore'] });
      const focus = /mCurrentFocus=Window\{[^}]*\s([^\s}]+)/u.exec(out)?.[1] ?? '';
      const paused = /mFocusedApp=.*?\s([^\s}]+)/u.exec(out)?.[1] ?? '';
      const target = focus || paused;
      if (!target) return '没读到手机当前页面。';
      return `手机现在停在：${target}`;
    },
  },
];

function localTime(iso) {
  const t = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(t)) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(t));
}

/**
 * 写动作：模型可以「规划」，但不能直接执行——系统会先建任务找爸爸确认。
 * 名字与 connect/actions.mjs 的 ACTIONS 对齐，确认后由原执行器跑。
 */
export const WRITE_TOOLS = [
  {
    name: 'douyin.publish_video',
    desc: '发布一条本地视频到抖音（写操作，需要爸爸确认；要给文件路径、标题和正文）',
    args: {
      file: { type: 'string', desc: '本地视频文件绝对路径，如 /Volumes/macOS/MovieMaker/09 大肥鱼/3.mp4' },
      title: { type: 'string', desc: '标题，最多 20 字' },
      caption: { type: 'string', desc: '正文（可含话题标签）' },
      tags: { type: 'string', desc: '话题标签，如 "#大肥鱼 #deepseek"' },
    },
    requiresConfirm: true,
  },
  {
    name: 'douyin.reply_comments',
    desc: '回复抖音收到的评论（写操作，需要爸爸确认）',
    args: { limit: { type: 'number', desc: '最多回几条，默认 8' } },
    requiresConfirm: true,
  },
  {
    name: 'douyin.hot_comment_round',
    desc: '去爆款视频底下回点赞最高的评论（写操作，需要爸爸确认）',
    args: { videos: { type: 'number', desc: '看几个视频，默认 2' }, perVideo: { type: 'number', desc: '每个视频回几条，默认 2' } },
    requiresConfirm: true,
  },
  {
    name: 'douyin.publish',
    desc: '发布一条抖音图文（写操作，需要爸爸确认，确认后先生成内容再二审）',
    args: { theme: { type: 'string', desc: '主题，可不填由系统挑' } },
    requiresConfirm: true,
  },
  {
    name: 'qq.call',
    desc: '给爸爸打 QQ 语音电话（写操作，需要爸爸确认；不要把「打个电话」当成已经拨出去）',
    args: {},
    requiresConfirm: true,
  },
  {
    name: 'qq.call_mom',
    desc: '给妈妈打 QQ 语音电话（写操作，需要爸爸确认）',
    args: {},
    requiresConfirm: true,
  },
  {
    name: 'wechat.call',
    desc: '用微信给妈妈打语音电话（写操作，需要爸爸确认）',
    args: {},
    requiresConfirm: true,
  },
  {
    name: 'qq.hangup',
    desc: '挂断正在进行的 QQ 语音通话（写操作，需要爸爸确认）',
    args: {},
    requiresConfirm: true,
  },
];

export const CAPABILITY_TOOLS = [
  {
    name: 'capability.read',
    desc: '读某个能力的细节卡（不确定项目里某功能怎么实现/在哪改时，先读它，别凭印象猜）',
    args: { id: { type: 'string', desc: '能力 id，如 publishing / reply-inbox / skills-learning' } },
    run(args) {
      const hit = readCapability(String(args.id ?? ''));
      if (!hit.ok) return `没有这个能力：${args.id}。可用的有：${hit.choices.join('、')}`;
      return hit.text;
    },
  },
  {
    name: 'capability.code',
    desc: '读某个能力登记过的源文件片段（只读、只允许该能力登记的文件，最多 120 行；仅主人私聊可用）',
    ownerOnly: true,
    args: { id: { type: 'string', desc: '能力 id' }, path: { type: 'string', desc: '相对项目根的文件路径，可省略（用该能力第一个文件）' }, from: { type: 'number', desc: '起始行，默认 1' }, lines: { type: 'number', desc: '行数，默认 80' } },
    run(args, ctx) {
      // B-4：源码只对主人私聊开放，普通对话拿不到实现（R-10 源码暴露面）。
      if (ctx?.ownerPrivate === false) return '源码只对主人私聊开放，别人看不到实现。';
      const hit = readCapabilityCode(ctx.root, String(args.id ?? ''), { path: args.path ? String(args.path) : null, from: args.from ?? 1, lines: args.lines ?? 80 });
      if (!hit.ok) return `读不到：${hit.error}。这个能力登记的文件：${(hit.files ?? capabilityFiles(String(args.id ?? ''))).join('、')}`;
      return `${hit.file}（共 ${hit.total} 行，第 ${hit.from} 起）\n${hit.text}`;
    },
  },
];
/** 按身份裁工具目录：非主人看不到 ownerOnly 工具（capability.code 之类）。 */
export function toolsFor(tools = ALL_TOOLS, { owner = true } = {}) {
  return owner ? tools : tools.filter((tool) => !tool.ownerOnly);
}
export const ALL_TOOLS = [...READONLY_TOOLS, ...CAPABILITY_TOOLS, ...WRITE_TOOLS];
export const WRITE_TOOL_NAMES = new Set(WRITE_TOOLS.map((tool) => tool.name));

function clamp(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 给模型看的工具清单（只列只读的）。 */
// ctx.root 是 runtime/connect（服务的工作目录），但 scripts/*.mjs 在仓库根：
// 这里统一向上找到真正带 package.json + scripts/ 的那层，避免子进程 cwd 指错。
export function toolCwd(ctx) {
  return projectRoot(ctx?.root ?? process.cwd());
}

export function catalogText(tools = ALL_TOOLS) {
  return tools.map((tool) => {
    const args = Object.entries(tool.args ?? {}).map(([name, spec]) => `${name}${spec.type === 'number' ? ':数字' : ''}`).join(', ');
    return `- ${tool.name}(${args}) ${tool.desc}`;
  }).join('\n');
}

export function findTool(name, tools = ALL_TOOLS) {
  const raw = String(name ?? '').trim();
  if (!raw) return null;
  const bare = raw.replace(/^(?:douyin\.)+/u, '').replace(/^douyin\./u, '');
  return tools.find((tool) => tool.name === raw)
    ?? tools.find((tool) => tool.name === 'douyin.' + bare)
    ?? tools.find((tool) => tool.name.replace(/^douyin\./u, '') === bare)
    ?? null;
}

/**
 * 校验模型给的计划：工具必须在白名单里（只读），参数用默认值兜底。
 * 不合法的一步直接丢掉并记原因，绝不把未知工具交给执行器。
 */
export function normalizeSteps(steps, tools = ALL_TOOLS) {
  const ok = [];
  const rejected = [];
  if (!Array.isArray(steps)) return { steps: ok, rejected: [{ tool: null, reason: 'steps_not_array' }] };
  for (const step of steps.slice(0, 5)) {
    const name = String(step?.tool ?? '').trim();
    const tool = findTool(name, tools);
    if (!tool) { rejected.push({ tool: name, reason: 'tool_not_allowed' }); continue; }
    const args = {};
    for (const [key, spec] of Object.entries(tool.args ?? {})) {
      const raw = step?.args?.[key];
      if (raw === undefined || raw === null || raw === '') continue;
      if (spec.type === 'number') {
        const n = Number(raw);
        if (Number.isFinite(n)) args[key] = n;
      } else {
        args[key] = String(raw).slice(0, 80);
      }
    }
    ok.push({ tool: tool.name, args, ...(tool.requiresConfirm ? { write: true } : {}) });
  }
  return { steps: ok, rejected };
}

/** 执行一步工具调用，永远返回可读文本（失败也返回文本，交给模型圆场）。 */
export async function runTool(step, ctx) {
  const tool = findTool(step.tool);
  if (!tool) return { tool: step.tool, ok: false, text: `工具 ${step.tool} 不可用。` };
  if (tool.requiresConfirm) return { tool: step.tool, ok: false, text: `工具 ${step.tool} 是写操作，需要爸爸确认后由执行器处理。` };
  try {
    const result = await tool.run(step.args ?? {}, ctx);
    if (result && typeof result === 'object') {
      return {
        tool: step.tool,
        ok: result.ok !== false,
        status: isRunStatus(result.status) ? result.status : (result.ok === false ? 'failed' : 'ok'),
        verified: result.verified === true,
        text: String(result.text ?? '').slice(0, 1200),
        ...(result.blockers ? { blockers: result.blockers } : {}),
      };
    }
    return { tool: step.tool, ok: true, status: 'ok', text: String(result).slice(0, 1200) };
  } catch (error) {
    return { tool: step.tool, ok: false, text: `工具 ${step.tool} 出错：${String(error?.message ?? error).slice(0, 120)}` };
  }
}
