import { dumpUi, findNodes, inputText, sleep, tapPoint, withAdbKeyboard } from './uia.mjs';
import { deviceSerial } from './wechat.mjs';

export const DOUYIN = {
  packageName: 'com.ss.android.ugc.aweme',
  activity: '.splash.SplashActivity',
  commentIcon: { x: 1136, y: 1859 },
  commentInput: { x: 610, y: 2735 },
  composerInput: { x: 594, y: 1155 },
  sendButton: { x: 1179, y: 1565 },
};

const sleepMs = sleep;

async function adbShell(serial, command) {
  const { execFile } = await import('node:child_process');
  await new Promise((resolve, reject) => {
    execFile(process.env.ADB_PATH || 'adb', ['-s', serial, 'shell', command], (error) => (error ? reject(error) : resolve()));
  });
}

/** Force-stop and relaunch so every run starts from the feed. */
export async function resetDouyin(serial) {
  await adbShell(serial, 'am force-stop ' + DOUYIN.packageName);
  await sleepMs(1200);
  await adbShell(serial, `monkey -p ${DOUYIN.packageName} -c android.intent.category.LAUNCHER 1`);
  await sleepMs(3200);
}

/** 回到竖屏主界面：横屏视频流 / 详情页里底部 tab 是点不到的。 */
export async function backToFeed(serial) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const activity = await currentActivity(serial);
    if (/SplashActivity/u.test(activity)) return activity;
    await adbShell(serial, 'input keyevent 4');
    await sleepMs(1000);
  }
  return currentActivity(serial);
}

export async function openDouyin(serial = null) {
  const target = serial ?? (await deviceSerial());
  await adbShell(target, `monkey -p ${DOUYIN.packageName} -c android.intent.category.LAUNCHER 1`);
  await sleepMs(2500);
  return target;
}

/** Open the comment panel of the current video and wait for it to render. */
export async function openComments(serial) {
  await tapPoint(serial, DOUYIN.commentIcon);
  await sleepMs(1800);
  return dumpUi(serial);
}

/** Read caption + comments from the current video. */
export async function readVideo(serial) {
  const nodes = await dumpUi(serial);
  const texts = nodes.map((node) => node.text).filter(Boolean);
  const caption = texts.find((text) => /^@/u.test(text) || text.length > 12) ?? '';
  return { caption, texts, nodes };
}

const META = /^(回复|展开.*|我|刚刚|\d+|[·\s]|\d+小时前|\d+分钟前|\d+天前|\d+月前)/u;

function looksLikeName(text) {
  return text.length <= 8 && !/[，。！？!?…]/u.test(text);
}

/** Comment rows: author line, content line, then a "回复" link. */
/** 评论面板顶部「昵称 作者」里的昵称：用来识别「自己发的回复」，避免回复自己的回复。 */
export function panelOwner(nodes) {
  const at = nodes.findIndex((node) => node.text === '作者');
  if (at < 0) return '';
  const prev = [...nodes.slice(Math.max(0, at - 6), at)]
    .reverse()
    .find((node) => node.cls.includes('Text') && node.text && looksLikeName(node.text));
  return prev?.text ?? '';
}

export function parseComments(nodes) {
  const rows = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (!node.cls.includes('Text')) continue;
    if (!node.text || META.test(node.text) || node.text.length < 4) continue;
    if (/^(去发布作品|发作品交流|让更多人看到|同时发布为作品)/u.test(node.text)) continue;
    // 昵称行也在同一条评论上方：它后面紧跟的正文文字会矮一截（cy 更大）。
    // 不排掉的话「LP0423」这种昵称会被当成一条评论去回复。
    const nextText = nodes.slice(index + 1).find((next) => next.cls.includes('Text') && next.text);
    if (nextText && !META.test(nextText.text) && nextText.bounds.cy > node.bounds.cy + 20 && nextText.bounds.cy < node.bounds.cy + 150) continue;
    const reply = nodes.slice(index + 1, index + 14).find((next) => next.text === '回复' && next.clickable);
    if (!reply) continue;
    const author = [...nodes.slice(0, index)].reverse().find((prev) => prev.cls.includes('Text') && prev.text && !META.test(prev.text) && looksLikeName(prev.text) && !/^(作者|作者赞过|置顶|朋友)$/u.test(prev.text));
    const isAuthorReply = nodes.slice(index, index + 14).some((next) => next.text === '作者');
    rows.push({
      author: decodeEntities(author?.text ?? ''),
      text: decodeEntities(node.text),
      isAuthorReply,
      replyPoint: { x: reply.bounds.cx, y: reply.bounds.cy },
    });
  }
  return rows;
}

const LIKE_COUNT = /^(\d+(?:\.\d+)?)\s*(万|w|W)?$/u;
const SEARCH_DATE = /^(\d{2}[.-]\d{2}|昨天|今天|前天|\d+天前|\d+小时前)$/u;

/** 「28.8万」→ 288000，「2803」→ 2803 */
const decodeEntities = (text) => String(text ?? '')
  .replace(/&#(\d+);/gu, (_m, code) => String.fromCodePoint(Number(code)))
  .replace(/&quot;/gu, '"').replace(/&#39;|&apos;/gu, "'").replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&amp;/gu, '&');

export function parseLikes(text) {
  const match = LIKE_COUNT.exec(String(text ?? '').trim());
  if (!match) return 0;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return 0;
  return Math.round(match[2] ? base * 10_000 : base);
}

export function formatLikes(value) {
  const n = Number(value) || 0;
  if (n >= 10_000) return `${(n / 10_000).toFixed(1).replace(/\.0$/u, '')}万`;
  return String(n);
}

/** 评论面板：在 parseComments 的结果上补点赞数（右侧的大数字）。 */
export function parseCommentsWithLikes(nodes) {
  const likes = nodes
    .filter((node) => node.cls.includes('Text') && LIKE_COUNT.test(String(node.text ?? '').trim()))
    .map((node) => ({ text: node.text.trim(), value: parseLikes(node.text), cx: node.bounds.cx, cy: node.bounds.cy }));
  return parseComments(nodes).map((row) => {
    const near = likes
      .filter((item) => item.cx > row.replyPoint.x + 200 && Math.abs(item.cy - row.replyPoint.y) < 120)
      .sort((a, b) => Math.abs(a.cy - row.replyPoint.y) - Math.abs(b.cy - row.replyPoint.y))[0];
    return { ...row, likes: near?.value ?? 0, likesText: near?.text ?? '' };
  });
}

/** 评论区里点赞最多的前 n 条（跳过作者自己的回复）。 */
export function topComments(rows, limit = 2) {
  return rows
    .filter((row) => !row.isAuthorReply && row.text && row.text.length >= 2)
    .sort((a, b) => (b.likes ?? 0) - (a.likes ?? 0))
    .slice(0, Math.max(1, limit));
}

/** 搜索结果卡片：标题 + 作者 + 日期 + 点赞数（几何配对，不依赖节点顺序）。 */
export function parseSearchHotVideos(nodes) {
  const texts = nodes.filter((node) => node.cls.includes('Text') && node.text?.trim());
  const titles = texts.filter((node) => node.bounds.w >= 450 && node.bounds.w <= 760 && node.bounds.h >= 90 && node.bounds.h <= 230);
  const dates = texts.filter((node) => SEARCH_DATE.test(node.text.trim()) && node.bounds.w < 200);
  const likes = texts
    .filter((node) => LIKE_COUNT.test(node.text.trim()) && !SEARCH_DATE.test(node.text.trim()) && node.bounds.w >= 20 && node.bounds.w <= 220 && node.bounds.h >= 30 && node.bounds.h <= 80)
    .map((node) => ({ ...node, value: parseLikes(node.text) }));
  const cards = [];
  for (const title of titles) {
    const date = dates
      .filter((node) => node.bounds.cy > title.bounds.cy && node.bounds.cy < title.bounds.cy + 520 && Math.abs(node.bounds.cx - title.bounds.cx) < 460)
      .sort((a, b) => a.bounds.cy - b.bounds.cy)[0];
    // 有些搜索结果不显示「3天前」这种日期（比如按最新排序 / 布局差异）。
    // 没有日期就从标题往下找同列的点赞数，别再整条丢弃——否则整页都会解析成 0 条。
    const anchorY = date ? date.bounds.cy : title.bounds.cy;
    const like = date
      ? likes
        .filter((node) => node.bounds.cx > date.bounds.cx + 80 && Math.abs(node.bounds.cy - date.bounds.cy) < 70)
        .sort((a, b) => Math.abs(a.bounds.cy - date.bounds.cy) - Math.abs(b.bounds.cy - date.bounds.cy))[0]
      : likes
        .filter((node) => node.bounds.cy > title.bounds.cy && node.bounds.cy < title.bounds.cy + 420 && Math.abs(node.bounds.cx - title.bounds.cx) < 260)
        .sort((a, b) => a.bounds.cy - b.bounds.cy)[0];
    if (!like) continue;
    // 点标题文字不会跳转，必须点封面容器：取同一列、在标题上方、面积最大的可点容器。
    const cover = nodes
      .filter((node) => node.clickable && node.bounds.w > 260 && node.bounds.h > 260
        && Math.abs(node.bounds.cx - title.bounds.cx) < 60
        && node.bounds.cy < title.bounds.cy && node.bounds.cy > title.bounds.cy - 1000)
      .sort((a, b) => b.bounds.w * b.bounds.h - a.bounds.w * a.bounds.h)[0];
    cards.push({
      title: title.text.trim(),
      date: date ? date.text.trim() : '',
      likes: like.value,
      likesText: like.text.trim(),
      anchorY,
      point: cover ? { x: cover.bounds.cx, y: cover.bounds.cy } : { x: title.bounds.cx, y: title.bounds.cy },
    });
  }
  return cards.sort((a, b) => b.likes - a.likes);
}

/** Open a video card from the current search results by matching title text. */
/** 自己作品详情页的平台数据：播放/点赞/评论/收藏/转发。 */
export function parseOwnWorkStats(nodes) {
  const fromDesc = (regex) => {
    for (const node of nodes) {
      const m = String(node.desc ?? '').match(regex);
      if (m) return parseLikes(m[1]);
    }
    return null;
  };
  const viewNode = nodes.find((node) => /^[\d.]+\s*万?\s*浏览$/u.test(String(node.text ?? '').trim()));
  const views = viewNode ? parseLikes(String(viewNode.text).replace(/[\s浏览]/gu, '')) : null;
  const titleNode = nodes.find((node) => {
    const text = String(node.text ?? '').trim();
    return text.length >= 6 && !/^[\d.]+\s*万?\s*(浏览|播放)$/u.test(text) && !/^(公开|私密|仅自己可见)$/u.test(text);
  });
  return {
    title: titleNode?.text ?? '',
    views,
    likes: fromDesc(/喜欢\s*([\d.]+\s*万?)/u),
    comments: fromDesc(/评论\s*(\d+)/u),
    favorites: fromDesc(/收藏\s*([\d.]+\s*万?)/u),
    shares: fromDesc(/分享\s*([\d.]+\s*万?)/u),
  };
}

export async function openSearchCard(serial, fragment) {
  const nodes = await dumpUi(serial);
  const card = parseSearchHotVideos(nodes).find((item) => item.title.includes(fragment))
    ?? (() => {
      const node = nodes.find((n) => n.cls.includes('Text') && n.text?.includes(fragment) && n.bounds.w > 300);
      return node ? { point: { x: node.bounds.cx, y: node.bounds.cy } } : null;
    })();
  if (!card) throw new Error('card_missing');
  await adbShell(serial, `input tap ${card.point.x} ${card.point.y}`);
}

/** 打开详情页的评论面板（视频走「评论 N」按钮，图文点底部评论数）。 */
export async function openVideoComments(serial) {
  const panelOpen = (nodes) => nodes.filter((node) => node.text === '回复').length >= 1
    || nodes.some((node) => /^(展开|收起)\d+条?回复/u.test(node.text ?? ''));
  let lastCount = -1;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const nodes = await dumpUi(serial);
    lastCount = nodes.length;
    if (panelOpen(nodes)) return { opened: true, already: true };
    // 坐标点击，所以节点本身可点不可点都能落点；优先右侧竖排的『评论 N』按钮。
    const candidates = nodes
      .filter((node) => /^评论/u.test(node.desc ?? '') || node.id?.endsWith('comment_container') || node.text === '评论')
      .sort((a, b) => (b.bounds?.cx ?? 0) - (a.bounds?.cx ?? 0));
    const btn = candidates[0];
    if (btn?.bounds) {
      await adbShell(serial, `input tap ${Math.round(btn.bounds.cx)} ${Math.round(btn.bounds.cy)}`);
      await sleepMs(3200);
      const after = await dumpUi(serial);
      if (panelOpen(after) || after.length > nodes.length + 5) return { opened: true, at: { x: btn.bounds.cx, y: btn.bounds.cy } };
    }
    await sleepMs(1500);
  }
  throw new Error(`comment_button_missing:nodes=${lastCount}`);
}

/** Post a top-level comment on the current video（失败重试一次，时序抖动能自愈）。 */
export async function postComment(serial, text, { dryRun = false } = {}) {
  let last = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      last = await attemptPostComment(serial, text, { dryRun });
      if (last?.sent !== false) return last;
    } catch (error) {
      last = { sent: false, error: error.message };
    }
    await sleepMs(1200);
  }
  // 两次都没发出去：把现场（截图 + 控件树）留下来，下次不用再猜停在哪一屏
  if (!dryRun && last?.sent === false) {
    try {
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { execFileSync } = await import('node:child_process');
      const dir = join(process.cwd(), 'runtime', 'douyin', 'failures');
      mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
      const shot = join(dir, `comment-${stamp}.png`);
      writeFileSync(shot, execFileSync('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], { maxBuffer: 32 * 1024 * 1024 }));
      writeFileSync(join(dir, `comment-${stamp}.json`), JSON.stringify(await dumpUi(serial), null, 1));
      last.capture = shot;
    } catch { /* 落现场失败不影响结论 */ }
  }
  return last ?? { sent: false };
}

async function attemptPostComment(serial, text, { dryRun = false }) {
  let nodes = await dumpUi(serial);
  // 有些布局里详情页压根没有输入框，得先点右侧那个「评论」按钮把面板叫出来
  if (!nodes.some((node) => node.cls.includes('EditText'))) {
    const commentBtn = nodes
      .filter((node) => node.clickable && `${node.desc}${node.text}`.includes('评论'))
      .sort((a, b) => b.bounds.cy - a.bounds.cy)[0];
    if (commentBtn) {
      await tapPoint(serial, { x: commentBtn.bounds.cx, y: commentBtn.bounds.cy });
      await sleepMs(2000);
      nodes = await dumpUi(serial);
    }
  }
  // 详情页底部的「有爱评论/发条评论」是假输入框，真正的编辑器要在点开后才出现
  let input = nodes.find((node) => node.focused && node.cls.includes('EditText'))
    ?? nodes.find((node) => node.cls.includes('EditText') && /评论|说点|说说|有爱/u.test(`${node.text}${node.desc}`))
    ?? nodes.find((node) => node.cls.includes('EditText'));
  if (!input) {
    // 兜底：有些图文/合集页的评论入口只是一条文字栏（没有 EditText 也没有「评论」按钮），
    // 直接点屏幕底部那条栏试试，再 dump 一次
    const bottom = nodes.filter((node) => node.bounds && node.bounds.cy > 2350 && node.bounds.w > 700)
      .sort((a, b) => b.bounds.cy - a.bounds.cy)[0];
    if (bottom) {
      await tapPoint(serial, { x: bottom.bounds.cx, y: bottom.bounds.cy });
      await sleepMs(1800);
      nodes = await dumpUi(serial);
      input = nodes.find((node) => node.focused && node.cls.includes('EditText'))
        ?? nodes.find((node) => node.cls.includes('EditText'));
    }
  }
  if (!input) throw new Error('comment_bar_missing');

  await tapPoint(serial, { x: input.bounds.cx, y: input.bounds.cy });
  await sleepMs(1600);
  nodes = await dumpUi(serial);
  const composer = nodes.find((node) => node.focused && node.cls.includes('EditText'))
    ?? nodes.find((node) => node.cls.includes('EditText') && /评论|说点|说说|有爱/u.test(`${node.text}${node.desc}`));
  if (composer) {
    await tapPoint(serial, { x: composer.bounds.cx, y: composer.bounds.cy });
    await sleepMs(900);
  }

  await withAdbKeyboard(serial, async () => inputText(serial, text));
  await sleepMs(1100);

  nodes = await dumpUi(serial);
  // 「发送」在 a11y 里常常是 clickable=false 的 TextView，不能按可点过滤；取最靠下的那个
  const sends = nodes.filter((node) => /^发送$/u.test((node.text ?? '').trim()));
  const send = sends.sort((a, b) => b.bounds.cy - a.bounds.cy)[0];
  if (!send) throw new Error('comment_send_missing');
  if (dryRun) {
    await adbShell(serial, 'input keyevent 4');
    await sleepMs(500);
    return { dryRun: true, text, sendPoint: { x: send.bounds.cx, y: send.bounds.cy } };
  }
  await tapPoint(serial, { x: send.bounds.cx, y: send.bounds.cy });
  const head = text.slice(0, 6);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await sleepMs(1200);
    const after = await dumpUi(serial);
    const typing = after.some((node) => node.cls.includes('EditText') && (node.text ?? '').includes(head));
    const composerGone = !after.some((node) => /^发送$/u.test((node.text ?? '').trim()));
    // 两种都算发出去：编辑器关了、或这条评论已经出现在评论列表里
    if (after.some((node) => (node.text ?? '').includes(head)) && !typing) return { sent: true, verified: 'comment_visible' };
    if (composerGone && !typing) return { sent: true, verified: 'composer_closed' };
  }
  return { sent: false };
}

/** Reply to the first comment whose text matches `match`. */
export async function replyToComment(serial, { match, reply, dryRun = false }) {
  const nodes = await dumpUi(serial);
  const rows = parseComments(nodes);
  const row = rows.find((item) => item.text.includes(match));
  if (!row) throw new Error(`comment_not_found:${match}`);
  await tapPoint(serial, row.replyPoint);
  await sleepMs(1200);
  const composer = await dumpUi(serial);
  const input = composer.find((node) => node.focused && node.cls.includes('EditText'));
  if (!input) throw new Error('reply_input_missing');
  await withAdbKeyboard(serial, async () => inputText(serial, reply));
  await sleepMs(700);
  const typedNodes = await dumpUi(serial);
  const send = findNodes(typedNodes, { text: '发送' }).pop();
  if (!send) throw new Error('reply_send_missing');
  if (dryRun) {
    await adbShell(serial, 'input keyevent 4');
    await sleepMs(500);
    return { dryRun: true, reply, to: row.text, sendPoint: { x: send.bounds.cx, y: send.bounds.cy } };
  }
  await tapPoint(serial, { x: send.bounds.cx, y: send.bounds.cy });
  await sleepMs(1600);
  const after = await dumpUi(serial);
  return { sent: after.some((node) => node.text.includes(reply.slice(0, 8))), to: row.text };
}

export const DOUYIN_NAV = {
  searchIcon: { x: 1249, y: 218 },
  searchInput: { x: 700, y: 264 },
  homeTab: { x: 131, y: 2763 },
  messagesTab: { x: 917, y: 2763 },
  meTab: { x: 1181, y: 2763 },
  interactions: { x: 277, y: 692 },
};

/** 消息页 → 互动消息（按行 desc 找，找不到才退回固定坐标）。 */
export async function openInteractions(serial) {
  await tapPoint(serial, DOUYIN_NAV.messagesTab);
  await sleepMs(1900);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const nodes = await dumpUi(serial);
    const row = nodes.find((node) => (node.desc ?? '').includes('互动消息'));
    if (row) {
      await tapPoint(serial, { x: row.bounds.cx, y: row.bounds.cy });
      await sleepMs(2400);
      const after = await dumpUi(serial);
      if (after.some((node) => (node.text ?? '').includes('互动消息'))) return after;
    }
    await tapPoint(serial, DOUYIN_NAV.interactions);
    await sleepMs(2400);
    const guess = await dumpUi(serial);
    if (guess.some((node) => /互动消息|赞了你的|收藏了你的/u.test(`${node.text ?? ''}${node.desc ?? ''}`))) return guess;
  }
  return dumpUi(serial);
}

/** 消息 → 互动消息 → 顶部「互动消息」筛选 → 点「收到的评论」，返回筛选后的通知列表。 */
export async function openCommentInbox(serial) {
  await backToFeed(serial);
  await tapPoint(serial, DOUYIN_NAV.messagesTab);
  await sleepMs(1900);
  const inbox = await dumpUi(serial);
  const entry = inbox.find((node) => (node.desc ?? '').includes('互动消息'));
  if (entry) await tapPoint(serial, { x: entry.bounds.cx, y: entry.bounds.cy });
  else await tapPoint(serial, DOUYIN_NAV.interactions);
  await sleepMs(2500);
  let nodes = await dumpUi(serial);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const tab = nodes.find((node) => node.text === '互动消息' && node.bounds.cy < 420);
    if (!tab) break;
    await tapPoint(serial, { x: tab.bounds.cx, y: tab.bounds.cy });
    await sleepMs(1600);
    const sheet = await dumpUi(serial);
    const choice = sheet.find((node) => node.text === '收到的评论' || (node.desc ?? '') === '收到的评论');
    if (!choice) {
      nodes = sheet;
      continue;
    }
    await tapPoint(serial, { x: choice.bounds.cx, y: choice.bounds.cy });
    await sleepMs(2500);
    nodes = await dumpUi(serial);
    if (nodes.some((node) => /评论了你/u.test(`${node.text ?? ''}${node.desc ?? ''}`))) return nodes;
  }
  return nodes;
}

const INBOX_TIME = /(昨天|今天|前天)\s*\d{1,2}:\d{2}|\d+\s*(?:秒|分钟|小时|天|月)前|刚刚|\d{2}-\d{2}/u;

/** 「收到的评论」列表：作者 + 评论正文 + 「回复评论」按钮（按坐标配对，别依赖节点顺序）。 */
export function parseCommentInbox(nodes) {
  const buttons = nodes.filter((node) => node.text === '回复评论');
  const rows = [];
  for (const node of nodes) {
    const text = node.text?.trim();
    if (!text || !/评论了你/u.test(text)) continue;
    const reply = buttons
      .filter((btn) => btn.bounds.cy > node.bounds.cy && btn.bounds.cy - node.bounds.cy < 320)
      .sort((a, b) => a.bounds.cy - b.bounds.cy)[0];
    if (!reply) continue;
    const author = nodes
      .filter((prev) => prev.cls.includes('Text') && prev.text
        && prev.bounds.cy < node.bounds.cy && node.bounds.cy - prev.bounds.cy < 220
        && !/互相关注|粉丝|评论了你|回复评论|已赞/u.test(prev.text)
        && prev.text.length <= 24)
      .sort((a, b) => b.bounds.cy - a.bounds.cy)[0];
    const content = text
      .replace(/^.*?评论了你[:：]?\s*/u, '')
      .replace(INBOX_TIME, '')
      .replace(/[，,\s]+$/u, '')
      .trim();
    // 同一行的作品封面缩略图：点它进作品详情页才能读到文案/话题/其它评论，
    // 点「回复评论」只会直接弹输入框，什么上下文都看不到。
    const thumb = nodes
      .filter((item) => {
        if (item === node) return false;
        const inside = item.bounds.cy > node.bounds.cy - 300 && item.bounds.cy < reply.bounds.cy;
        if (!inside) return false;
        const wide = item.bounds.w >= 48 && item.bounds.w <= 220 && item.bounds.h >= 48;
        const looksImage = /ImageView|Image|Cover|Thumb/u.test(item.cls) || item.desc === '作品封面';
        return wide && (looksImage || !item.text);
      })
      .sort((a, b) => b.bounds.cx - a.bounds.cx)[0];
    rows.push({
      author: author?.text ?? '',
      text: content,
      raw: text,
      replyPoint: { x: reply.bounds.cx, y: reply.bounds.cy },
      thumbPoint: thumb ? { x: thumb.bounds.cx, y: thumb.bounds.cy } : null,
    });
  }
  return rows.sort((a, b) => a.replyPoint.y - b.replyPoint.y);
}

const DETAIL_CHROME = /^(回复|作者|关注|已关注|评论|赞|收藏|浏览|分享|展开|收起|回复@|广告|搜索|关闭|输入评论|说点什么)/u;
const DETAIL_META = /^(\d{1,2}:\d{2}|昨天|今天|前天|\d+天前|\d+小时前|\d+分钟前|\d{4}-\d{2}-\d{2}|·.*|\d+[万w]?|回复)$/u;

/**
 * 从「作品详情页」的控件树里读出回复评论需要的上下文：
 *   - 作品：作者、正文（含话题）、类型（视频/图文，看有没有视频播放控件）
 *   - 计数：评论 / 赞 / 收藏 / 浏览
 *   - 评论链：作者 → 正文，能认出「回复@某人」表示是我们之前回过的
 * 只读控件树，不做任何点击。抓不到就返回空字段，调用方据此降级成 comment_only。
 */
export function parseCommentDetail(nodes) {
  const texts = nodes.filter((node) => String(node.text ?? '').trim());
  const counts = {};
  for (const node of texts) {
    const match = /^(评论|赞|收藏|浏览)\s*([\d.]+\s*[万w]?)$/u.exec(node.text.trim());
    if (match) counts[match[1]] = match[2].replace(/\s+/gu, '');
  }
  const videoPlaying = nodes.some((node) => /(暂停|播放)视频/u.test(node.desc ?? ''));
  const badge = nodes.find((node) => node.text === '作者');
  const author = badge
    ? texts
      .filter((node) => node !== badge && Math.abs(node.bounds.cy - badge.bounds.cy) <= 70 && node.bounds.cx < badge.bounds.cx)
      .sort((a, b) => b.bounds.cx - a.bounds.cx)[0]?.text ?? ''
    : '';
  // 正文是页面上最长的那段文字；抖音会在结尾塞「昨天20:23」，剥掉再判长度。
  const captionNode = texts
    .filter((node) => !DETAIL_CHROME.test(node.text.trim()) && node.text.trim().length >= 12
      && !/^\d{1,2}:\d{2}$/u.test(node.text.trim()))
    .sort((a, b) => b.text.trim().length - a.text.trim().length)[0];
  const caption = captionNode
    ? captionNode.text.replace(/&#10;/gu, '\n').replace(/\s*(昨天|今天|前天)\s*\d{1,2}:\d{2}\s*$/u, '').trim()
    : '';
  // 一条评论的边界不是「作者名」而是它底部那排元信息（回复 / 赞…未选中）：
  // 昵称和正文都可能是短文本，只有元信息栏是稳定的分隔线。
  const rowMarks = nodes
    .filter((node) => node.text?.trim() === '回复' || /^赞\d*,/u.test(node.desc ?? ''))
    .map((node) => node.bounds.cy)
    .sort((a, b) => a - b);
  const top = (captionNode?.bounds.cy ?? badge?.bounds.cy ?? 0) + 80;
  const thread = [];
  let cursor = top;
  for (const markY of [...new Set(rowMarks)]) {
    const inside = texts
      .filter((node) => node.bounds.cy > cursor && node.bounds.cy < markY - 8)
      .sort((a, b) => a.bounds.cy - b.bounds.cy);
    cursor = markY;
    const lines = inside
      .map((node) => node.text.trim())
      .filter((text) => text && !DETAIL_CHROME.test(text) && !DETAIL_META.test(text));
    if (!lines.length) continue;
    const [name, ...rest] = lines;
    const body = rest.join(' ').trim();
    thread.push({
      author: name,
      text: body || name,
      isMine: author !== '' && name === author,
      isParent: body.startsWith('回复@'),
    });
  }
  if (!thread.length) {
    // 兜底：没有元信息栏（例如只有一条评论且被折叠），退化成「第一条短文本是昵称」。
    const fallback = texts
      .filter((node) => node.bounds.cy > top && !DETAIL_CHROME.test(node.text.trim()))
      .sort((a, b) => a.bounds.cy - b.bounds.cy)
      .map((node) => node.text.trim())
      .filter((text) => text && !DETAIL_META.test(text));
    if (fallback.length >= 2) thread.push({ author: fallback[0], text: fallback.slice(1).join(' '), isMine: false, isParent: false });
  }
  const kind = videoPlaying ? 'video' : 'image';
  return {
    work: { author, caption, kind, title: caption.split('\n')[0].slice(0, 40) },
    counts,
    thread,
  };
}

/** 已知弹窗/阻断：命中就停下报告，不自动点（P0 只报告；自愈在 P2）。 */
export const BLOCKER_RULES = [
  { kind: 'draft_resume', re: /继续编辑作品|继续编辑/u, hint: '草稿恢复弹窗' },
  { kind: 'discard_confirm', re: /放弃编辑|确定退出|是否退出|退出编辑/u, hint: '退出确认弹窗' },
  { kind: 'permission', re: /允许.*权限|权限申请|授权/u, hint: '权限弹窗' },
  { kind: 'login', re: /一键登录|登录后可|请先登录/u, hint: '登录弹窗' },
  { kind: 'upgrade', re: /立即升级|立即更新|新版本/u, hint: '升级弹窗' },
  { kind: 'ad', re: /跳过广告|广告\s*\d+\s*[sS]?/u, hint: '广告' },
  { kind: 'network', re: /网络不给力|网络异常|重试/u, hint: '网络错误' },
];

export function findBlockers(nodes) {
  const found = [];
  for (const node of nodes ?? []) {
    const label = String(node?.text || node?.desc || '').trim();
    if (!label || label.length > 40) continue;
    for (const rule of BLOCKER_RULES) {
      if (!rule.re.test(label)) continue;
      if (found.some((item) => item.kind === rule.kind)) continue;
      const b = node.bounds ?? null;
      found.push({
        kind: rule.kind,
        hint: rule.hint,
        text: label.slice(0, 60),
        clickable: node.clickable === true,
        point: b ? { x: Math.round((b.left + b.right) / 2), y: Math.round((b.top + b.bottom) / 2) } : null,
      });
    }
  }
  return found;
}

// 自愈策略：只处理「关掉/取消/重试」这类无害动作，权限/登录/升级一律不碰。
export const HEAL_POLICY = {
  draft_resume: { label: '关掉草稿恢复弹窗', texts: ['放弃', '取消', '关闭', '不保存', '退出编辑', '返回'] },
  discard_confirm: { label: '确认退出编辑', texts: ['确定', '退出', '放弃', '不保存', '关闭'] },
  ad: { label: '跳过广告', texts: ['跳过', '关闭', '以后再说', '知道了'] },
  network: { label: '网络错误重试', texts: ['重试', '刷新', '重新加载'] },
  permission: null,
  login: null,
  upgrade: null,
};

// 任何情况下都不点这些字，哪怕它在白名单相近位置（防误点）。
export const NEVER_CLICK = /允许|同意|授权|升级|更新|安装|发布|发作品|购买|支付|充值|领取|下载|立即/u;

export function pickHealTarget(nodes, kind) {
  const policy = HEAL_POLICY[kind];
  if (!policy) return null;
  for (const wanted of policy.texts) {
    const hit = (nodes ?? []).find((node) => {
      const label = String(node?.text || node?.desc || '').trim();
      if (label !== wanted) return false;
      if (NEVER_CLICK.test(label)) return false;
      return Boolean(node.bounds);
    });
    if (hit) return { kind, label: policy.label, text: wanted, point: { x: hit.bounds.cx, y: hit.bounds.cy }, clickable: hit.clickable === true };
  }
  return null;
}

// 扫一遍当前页面：有可自愈的阻断就点掉再扫，最多 maxRounds 轮；剩下的原样返回给调用方报失败。
export async function ensureClear(serial, { maxRounds = 2 } = {}) {
  const healed = [];
  let blockers = [];
  for (let round = 0; round < maxRounds; round += 1) {
    const nodes = await dumpUi(serial);
    blockers = findBlockers(nodes);
    if (!blockers.length) return { ok: true, healed, blockers: [], rounds: round };
    let acted = false;
    for (const blocker of blockers) {
      const target = pickHealTarget(nodes, blocker.kind);
      if (!target) continue;
      await tapPoint(serial, target.point);
      await sleepMs(1300);
      healed.push({ kind: blocker.kind, clicked: target.text });
      acted = true;
      break;
    }
    if (!acted) break;
  }
  return { ok: false, healed, blockers, rounds: maxRounds };
}

export const EMPTY_PROOFS = [/暂时没有更多了/u, /暂时没有/u, /暂无内容/u, /没有更多/u, /还没有评论/u];

export function emptyProof(nodes) {
  for (const node of nodes ?? []) {
    const label = String(node?.text || node?.desc || '').trim();
    if (!label) continue;
    for (const re of EMPTY_PROOFS) if (re.test(label)) return { ok: true, text: label.slice(0, 40) };
  }
  return { ok: false, text: null };
}

/** 当前屏一次体检：阻断 + 空态证明 + 前台 activity。 */
export async function scanBlockers(serial) {
  const [nodes, activity] = [await dumpUi(serial), await currentActivity(serial)];
  return { activity, blockers: findBlockers(nodes), proof: emptyProof(nodes) };
}

/** 底部「我」→ 主页作品网格。 */
export async function openProfile(serial) {
  // 长视频/横屏流会把底部 tab 全挡住，先退回竖屏主界面。
  await backToFeed(serial);
  await tapPoint(serial, DOUYIN_NAV.meTab);
  await sleepMs(2600);
  return dumpUi(serial);
}

/** 主页第 index 个作品 → 详情 → 打开评论区，返回评论面板节点。 */
export async function openWorkComments(serial, index = 0) {
  const grid = await dumpUi(serial);
  const tile = worksTiles(grid)[index];
  if (!tile) throw new Error(`work_tile_missing:${index}`);
  await tapPoint(serial, tile.point);
  await sleepMs(3200);
  let nodes = await dumpUi(serial);
  // 图文详情：底部/中部有「评论 N」tab；视频详情：右侧竖排「评论」按钮。
  const panelOpen = (batch) => batch.some((node) => /有什么想法|展开说说|发条评论/u.test(`${node.text ?? ''}${node.desc ?? ''}`))
    || parseComments(batch).length > 0;
  if (!panelOpen(nodes)) {
    const tab = nodes
      .filter((node) => /^评论/u.test(node.text ?? '') && node.bounds.cy > 700 && node.bounds.cy < 1600)
      .sort((a, b) => a.bounds.cy - b.bounds.cy)[0];
    const button = nodes
      .filter((node) => node.clickable && /评论/u.test(`${node.text ?? ''}${node.desc ?? ''}`))
      .sort((a, b) => b.bounds.cy - a.bounds.cy)[0];
    const target = tab ?? button;
    if (target) {
      await tapPoint(serial, { x: target.bounds.cx, y: target.bounds.cy });
      await sleepMs(2400);
      nodes = await dumpUi(serial);
    }
  }
  if (!panelOpen(nodes)) nodes = await openCommentsSmart(serial);
  return nodes;
}

/** 从作品详情退回主页（评论面板 → 详情 → 主页）。 */
export async function backToProfile(serial) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await adbShell(serial, 'input keyevent 4');
    await sleepMs(1400);
    const nodes = await dumpUi(serial);
    if (nodes.some((node) => /作品|获赞|粉丝/u.test(node.text ?? '')) && worksTiles(nodes).length) return nodes;
  }
  throw new Error('profile_not_restored');
}

/** Open the comment panel and confirm the input bar exists. */
export async function openCommentsSmart(serial) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const nodes = await dumpUi(serial);
    const button = nodes
      .filter((node) => node.clickable && `${node.desc}${node.text}`.includes('评论'))
      .sort((a, b) => b.bounds.cy - a.bounds.cy)[0];
    if (button) await tapPoint(serial, { x: button.bounds.cx, y: button.bounds.cy });
    else await tapPoint(serial, DOUYIN.commentIcon);
    await sleepMs(2200);
    const panel = await dumpUi(serial);
    // 评论面板认得三种样子：底部输入框（有爱评论/说点儿好听的）、展开后的评论列表、以及旧的占位文案
    const input = panel.find((node) => node.cls.includes('EditText')
      && /评论|说点|说说|有爱/u.test(`${node.text}${node.desc}`));
    if (input) {
      // 详情页默认只有一个「有爱评论」的假输入框，点它才会展开真正的评论面板（带发送按钮）
      const expanded = panel.some((node) => /^(发送|发布)$/u.test((node.text ?? '').trim()));
      if (expanded) return panel;
      await tapPoint(serial, { x: input.bounds.cx, y: input.bounds.cy });
      await sleepMs(1800);
      const composer = await dumpUi(serial);
      if (composer.some((node) => /^(发送|发布)$/u.test((node.text ?? '').trim()))) return composer;
      if (parseComments(composer).length) return composer;
      continue;
    }
    if (panel.some((node) => /有什么想法|发条评论|展开说说|有爱评论/u.test(`${node.text}${node.desc}`))
      || parseComments(panel).length) {
      return panel;
    }
  }
  throw new Error('comment_panel_not_open');
}

/** 视频详情到底开没开：activity 之外再看一眼界面（评论框/分享/收藏），冷启动时 activity 会误报 Splash。 */
export async function isWorkDetailOpen(serial) {
  const activity = await currentActivity(serial);
  if (/DetailActivity|LandscapeFeedActivity/u.test(activity)) return true;
  const nodes = await dumpUi(serial).catch(() => []);
  const blob = (node) => `${node.text ?? ''}${node.desc ?? ''}`;
  // 详情页的标志：评论输入口 + 右侧互动条（赞/收藏/分享）
  const hasComposer = nodes.some((node) => /有爱评论|说点儿好听的|留下你的精彩评论/u.test(blob(node)));
  const hasActions = nodes.some((node) => /分享|收藏/u.test(blob(node)));
  if (hasComposer && hasActions) return true;
  // 兜底：搜索结果页一定有搜索框与「视频/用户/商品」页签，详情页没有；
  // 同时详情页会有「分享」或全屏观看入口。两者同时成立才认，避免把首页当详情。
  const onSearch = nodes.some((node) => /搜索/u.test(blob(node)) && /^搜索$/u.test((node.text ?? '').trim()))
    || nodes.some((node) => /^(视频|用户|商品|直播)$/u.test((node.text ?? '').trim()));
  const looksLikeDetail = nodes.some((node) => /全屏观看/u.test(blob(node))) || hasActions;
  return !onSearch && looksLikeDetail;
}

/** 等抖音真正起来（冷启动会先停在 SplashActivity，太早点搜索会点空）。 */
export async function waitForHome(serial, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const activity = await currentActivity(serial);
    if (!/SplashActivity/u.test(activity)) {
      const nodes = await dumpUi(serial);
      if (nodes.some((node) => /^(首页|推荐|商城|消息|我)$/u.test((node.text ?? '').trim()))) return true;
    }
    await sleepMs(700);
  }
  return false;
}

/** Open the search page from the feed. */
export async function openSearch(serial) {
  await tapPoint(serial, DOUYIN_NAV.searchIcon);
  await sleepMs(1600);
}

/**
 * 确认「现在真的在搜索结果页」。
 * 之前出过的事故：抖音停在「互动消息」时，openSearch 的坐标点击打在别处，
 * 后面照样解析出一堆「评论行」，把它们当视频卡片去点，结果永远进不了详情页。
 */
export async function onSearchResults(serial) {
  const activity = await currentActivity(serial);
  if (!/SearchResultActivity/u.test(activity)) return false;
  const nodes = await dumpUi(serial).catch(() => []);
  return nodes.some((node) => /^(综合|视频|用户|商品)$/u.test((node.text ?? '').trim()));
}

/** Current foreground activity, used to verify we actually left the search page. */
export async function currentActivity(serial) {
  const { execFile } = await import('node:child_process');
  const output = await new Promise((resolve, reject) => {
    execFile(process.env.ADB_PATH || 'adb', ['-s', serial, 'shell', 'dumpsys', 'activity', 'activities'], (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
  return /(?:top)?ResumedActivity=[^\n]*?([\w.]+\/[\w.$]+)/u.exec(output)?.[1] ?? '';
}

/** Search a keyword (视频 tab by default) and return the result nodes. */
export async function searchKeyword(serial, keyword, { videoTab = true } = {}) {
  await tapPoint(serial, DOUYIN_NAV.searchInput);
  await sleepMs(900);
  await adbShell(serial, 'input keyevent 123');
  await adbShell(serial, 'input keyevent ' + Array.from({ length: 40 }, () => 67).join(' '));
  await withAdbKeyboard(serial, async () => inputText(serial, keyword));
  await sleepMs(700);
  // 提交搜索：优先点「搜索」按钮，回车在 ADBKeyboard 下不一定触发。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const shot = await dumpUi(serial);
    const submit = shot.find((node) => node.text === '搜索' && node.clickable);
    if (submit) await tapPoint(serial, { x: submit.bounds.cx, y: submit.bounds.cy });
    else await adbShell(serial, 'input keyevent 66');
    await sleepMs(2800);
    const check = await dumpUi(serial);
    if (check.some((node) => node.text === '综合' && node.clickable)) break;
  }
  if (videoTab) {
    const nodes = await dumpUi(serial);
    const tab = nodes.find((node) => node.text === '视频' && node.clickable);
    if (tab) {
      await tapPoint(serial, { x: tab.bounds.cx, y: tab.bounds.cy });
      await sleepMs(2200);
    }
  }
  return dumpUi(serial);
}

/** List result cards whose text looks like a video title. */
export function parseResults(nodes) {
  const seen = new Set();
  const rows = [];
  for (const node of nodes) {
    const text = node.text?.trim();
    if (!text || text.length < 6) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    rows.push({ text, point: { x: node.bounds.cx, y: node.bounds.cy } });
  }
  return rows;
}

export async function openResult(serial, keyword) {
  const nodes = await dumpUi(serial);
  const rows = parseResults(nodes).filter((item) => item.text.includes(keyword));
  for (const row of rows.slice(0, 3)) {
    await tapPoint(serial, row.point);
    await sleepMs(2600);
    const activity = await currentActivity(serial);
    if (activity.includes('UltraDetailActivity') || activity.includes('DetailActivity')) return dumpUi(serial);
  }
  throw new Error(`result_not_found:${keyword}`);
}

/** Go to 消息 → 互动消息 and list the entries. */
export async function readInteractions(serial) {
  await tapPoint(serial, DOUYIN_NAV.messagesTab);
  await sleepMs(1800);
  await tapPoint(serial, DOUYIN_NAV.interactions);
  await sleepMs(2200);
  const nodes = await dumpUi(serial);
  return nodes;
}

export function parseInteractions(nodes) {
  const rows = [];
  for (const node of nodes) {
    const text = node.text?.trim();
    if (!text || text.length < 4) continue;
    if (/^(互动消息|新的关注|消息|筛选方式|合并|分类|新关注我的)$/u.test(text)) continue;
    if (/^你还没有收到|^赶快去和/u.test(text)) continue;
    if (/^\d{1,2}:\d{2}$/u.test(text)) continue;
    rows.push({ text, point: { x: node.bounds.cx, y: node.bounds.cy } });
  }
  return rows;
}

/** Open the N-th interaction entry and take a screenshot of what it opened. */
export async function openInteraction(serial, index = 0) {
  const nodes = await dumpUi(serial);
  const rows = parseInteractions(nodes);
  const row = rows[index];
  if (!row) throw new Error(`interaction_not_found:${index}`);
  await tapPoint(serial, row.point);
  await sleepMs(2600);
  return { opened: row.text, nodes: await dumpUi(serial) };
}

export { adbShell };

const DATE = /^\d{1,2}\.\d{1,2}$/u;
const LIKES = /^[\d.]+\s*万?$/u;

/** Group search video cards into {title, author, date, likes}. */
export function parseSearchCards(nodes) {
  const cards = [];
  const texts = nodes.filter((node) => node.text?.trim());
  for (let i = 0; i < texts.length; i += 1) {
    const date = texts[i];
    if (!DATE.test(date.text)) continue;
    const author = texts[i - 1];
    const title = texts[i - 2];
    const likes = texts[i + 1];
    if (!author || !title) continue;
    if (author.text.length > 20 || !LIKES.test(likes?.text ?? '')) continue;
    cards.push({
      title: title.text,
      author: author.text,
      date: date.text,
      likes: likes?.text ?? '',
      point: { x: title.bounds.cx, y: title.bounds.cy },
    });
  }
  return cards;
}

/** Open an account profile from the search page (uses 用户 tab). */
export async function openUserProfile(serial, name) {
  const first = await dumpUi(serial);
  const tab = first.find((node) => node.text === '用户') ?? first.find((node) => (node.text ?? '').includes('用户'));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!tab) break;
    await tapPoint(serial, { x: tab.bounds.cx, y: tab.bounds.cy });
    await sleepMs(2600);
    const check = await dumpUi(serial);
    if (check.some((node) => /粉丝指数|抖音号/u.test(node.text ?? ''))) break;
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const users = await dumpUi(serial);
    const label = users.find((node) => node.text === name && !node.cls.includes('EditText'))
      ?? users.find((node) => node.text?.includes(name) && !node.cls.includes('EditText'));
    if (!label) {
      // 用户列表是自绘卡片：第一张卡片的头像/名字位置（实测 1312×2848：名字 (389,456)、头像 (157,501)）。
      for (const point of [{ x: 389, y: 456 }, { x: 157, y: 501 }, { x: 500, y: 460 }]) {
        await tapPoint(serial, point);
        await sleepMs(3000);
        const after = await dumpUi(serial);
        const activity = await currentActivity(serial);
        if (/UserProfile/u.test(activity) || after.some((node) => /粉丝|获赞|作品|私信|编辑主页/u.test(node.text ?? ''))) return after;
      }
      // 再退一步：点第一个可点的整行卡片。
      const rows = users
        .filter((node) => node.clickable && node.bounds.w >= 900 && node.bounds.h >= 120)
        .sort((a, b) => a.bounds.y - b.bounds.y);
      for (const row of rows.slice(0, 3)) {
        await tapPoint(serial, { x: row.bounds.cx, y: row.bounds.cy });
        await sleepMs(3000);
        const after = await dumpUi(serial);
        const activity = await currentActivity(serial);
        if (/UserProfile/u.test(activity) || after.some((node) => /粉丝|获赞|作品|私信|编辑主页/u.test(node.text ?? ''))) return after;
      }
      throw new Error(`user_not_found:${name}`);
    }
    // 用户名是自绘文字但通常可点；点不到时退回头像位置。
    const points = [
      { x: label.bounds.cx, y: label.bounds.cy },
      { x: Math.max(80, label.bounds.x - 70), y: label.bounds.cy },
      { x: label.bounds.x - 70, y: label.bounds.cy - 40 },
    ];
    for (const point of points) {
      await tapPoint(serial, point);
      await sleepMs(2800);
      const after = await dumpUi(serial);
      const activity = await currentActivity(serial);
      if (/UserProfile/u.test(activity) || after.some((node) => /粉丝|获赞|作品|私信|编辑主页/u.test(node.text ?? ''))) return after;
    }
  }
  throw new Error('user_profile_not_opened');
}

/** Recent works on a profile page: titles shown on the grid. */
export function parseProfileWorks(nodes) {
  return nodes
    .filter((node) => node.text?.trim() && node.text.length > 8 && !/粉丝|获赞|关注|作品|私信|编辑主页|IP|抖音号/u.test(node.text))
    .map((node) => ({ text: node.text.trim(), point: { x: node.bounds.cx, y: node.bounds.cy }, bounds: node.bounds }));
}

/** 主页作品是自绘网格：文字节点不可点，要点它所在的可点容器（缩略图区域）。 */
export function worksTiles(nodes) {
  // 网格在「作品 / 日常 / 收藏 / 喜欢」这排 tab 之下：用 tab 的底边当分界线，
  // 否则头像框、添加好友、编辑主页这些同样尺寸的按钮会被当成作品。
  const tab = nodes.find((node) => node.text === '作品' || /^作品,按钮/u.test(node.desc ?? ''));
  const gridTop = tab ? tab.bounds.y + tab.bounds.h + 20 : 0;
  return nodes
    .filter((node) => node.clickable
      && node.bounds.y >= gridTop
      && node.bounds.w >= 300 && node.bounds.w <= 720
      // 作品封面 434×579；h<450 的多半是草稿箱/私密作品那种横条提示。
      && node.bounds.h >= 450 && node.bounds.h <= 900
      // 「本地草稿箱」浮层和封面同尺寸、还压在第一格左上角，必须排除，否则会被当成第 0 个作品。
      && !/草稿箱|私密作品|新点赞|播放数/u.test(`${node.desc ?? ''}${node.text ?? ''}`))
    .map((node) => ({ bounds: node.bounds, point: { x: node.bounds.cx, y: node.bounds.y + Math.round(node.bounds.h * 0.38) } }))
    .sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x);
}

/** Type into whatever comment composer is currently open and send it. */
export async function sendInCurrentComposer(serial, text, { dryRun = false } = {}) {
  const nodes = await dumpUi(serial);
  const input = nodes.find((node) => /有什么想法|发条评论|回复/u.test(`${node.text}${node.desc}`) && node.clickable)
    ?? nodes.find((node) => node.focused && node.cls.includes('EditText'));
  if (!input) throw new Error('composer_not_found');
  await tapPoint(serial, { x: input.bounds.cx, y: input.bounds.cy });
  await sleepMs(1000);
  await adbShell(serial, 'am broadcast -a ADB_CLEAR_TEXT');
  await sleepMs(400);
  await withAdbKeyboard(serial, async () => inputText(serial, text));
  await sleepMs(700);
  let after = await dumpUi(serial);
  let send = findNodes(after, { text: '发送' }).pop();
  if (!send) {
    await tapPoint(serial, DOUYIN.composerInput);
    await sleepMs(900);
    after = await dumpUi(serial);
    send = findNodes(after, { text: '发送' }).pop();
  }
  if (!send) throw new Error('send_button_missing');
  if (dryRun) {
    await adbShell(serial, 'input keyevent 4');
    return { dryRun: true, sendPoint: { x: send.bounds.cx, y: send.bounds.cy } };
  }
  await tapPoint(serial, { x: send.bounds.cx, y: send.bounds.cy });
  await sleepMs(1800);
  const final = await dumpUi(serial);
  if (final.some((node) => node.text.includes(text.slice(0, 6)))) return { sent: true, verified: 'text_visible' };
  // 评论通知里的内联回复框：发完会直接收起，界面上看不到刚发的字。
  const composerGone = !final.some((node) => node.text === '发送')
    && !final.some((node) => node.cls.includes('EditText'));
  return composerGone ? { sent: true, verified: 'composer_closed' } : { sent: false };
}

/** 给“我”的作品评论区点赞（回心）：打开自己的第一个作品 → 评论区 → 逐行点右侧的 ♡。 */
/** 互动消息页：给「赞了你的图文」回赞（点头像右下角红心），并给评论点「赞」。 */
export async function likeBackComments(serial, { max = 12, gapMs = 900, dryRun = true } = {}) {
  await adbShell(serial, 'am start -n com.ss.android.ugc.aweme/.splash.SplashActivity');
  await sleepMs(4000);
  let nodes = null;
  let pageOn = false;
  for (let attempt = 0; attempt < 3 && !pageOn; attempt += 1) {
    await adbShell(serial, 'input keyevent 4'); // 先退出播放/子页
    await sleepMs(700);
    await adbShell(serial, 'input tap 940 2757'); // 消息 tab
    await sleepMs(1800);
    await adbShell(serial, 'input tap 277 692'); // 互动消息
    await sleepMs(2400);
    nodes = await dumpUi(serial);
    pageOn = nodes.some((n) => `${n.text ?? ''}${n.desc ?? ''}`.includes('互动消息'));
  }
  if (!pageOn) return { liked: 0, error: 'interactions_not_open' };

  const rows = nodes.filter((n) => /赞了你的图文/u.test(`${n.desc ?? ''}${n.text ?? ''}`));
  const commentRows = nodes.filter((n) => /评论了你/u.test(`${n.desc ?? ''}${n.text ?? ''}`));
  let liked = 0;
  let commentedLikes = 0;

  for (const row of rows.slice(0, max)) {
    // 头像右下角的红心：头像 FrameLayout 在行内左侧 56..236
    const avatarY = row.bounds.y + Math.round(row.bounds.h * 0.55);
    if (!dryRun) await tapPoint(serial, { x: 196, y: avatarY });
    liked += 1;
    await sleepMs(gapMs);
  }

  for (const row of commentRows.slice(0, max)) {
    // 评论行只点「赞」按钮（在「回复评论」右侧）
    const btn = nodes.find((n) => n.bounds && n.bounds.y > row.bounds.y && n.bounds.y < row.bounds.y + row.bounds.h && (n.text ?? '').trim() === '赞');
    if (!btn) continue;
    if (!dryRun) await tapPoint(serial, { x: btn.bounds.cx, y: btn.bounds.cy });
    commentedLikes += 1;
    await sleepMs(gapMs);
  }

  return { liked, commentLikes: commentedLikes, rows: rows.length, commentRows: commentRows.length };
}


/**
 * 回到抖音首页（推荐流）。首页是判断「有没有新消息」最省事的锚点：
 * 底部 tab 的「消息」右上角有红点/数字就说明有未读。
 */
export async function openFeed(serial) {
  // 注意：抖音把 MainActivity 之外还挂了 SplashActivity 当栈底，currentActivity 经常
  // 一直报 SplashActivity，但界面早就是首页了。所以以「底部 tab 在不在」为准，不看 activity。
  const hasTabs = (nodes) => nodes.some((node) => (node.text ?? '').trim() === '首页');
  let nodes = await dumpUi(serial);
  if (!hasTabs(nodes)) {
    const activity = await currentActivity(serial).catch(() => '');
    if (!/com\.ss\.android\.ugc\.aweme/u.test(activity)) await openDouyin(serial);
    else await backToFeed(serial);
    await sleepMs(1500);
    nodes = await dumpUi(serial);
    for (let wait = 0; wait < 4 && !hasTabs(nodes); wait += 1) {
      await backToFeed(serial);
      await sleepMs(1200);
      nodes = await dumpUi(serial);
    }
  }
  // 已经在推荐流上就别再点一次「首页」：每分钟点一下会把主人正在看的那条视频顶回顶部。
  const onFeed = nodes.some((node) => (node.text ?? '').trim() === '推荐')
    || nodes.some((node) => (node.desc ?? '').includes('拍同款'));
  const homeTab = nodes.find((node) => (node.text ?? '').trim() === '首页');
  if (homeTab && !onFeed) {
    await tapPoint(serial, { x: homeTab.bounds.cx, y: homeTab.bounds.cy });
    await sleepMs(1600);
    nodes = await dumpUi(serial);
  }
  return nodes;
}

/**
 * 从首页控件树里读「消息」tab 的红点。
 * 抖音的红点是 tab 右上角一个纯数字 TextView（1/12/99+），没有单独的语义节点，
 * 所以按「贴着消息 tab 的小数字」来找；也兼容 desc 直接写「消息，3条未读」的版本。
 */
export function parseMessageBadge(nodes) {
  const tab = nodes.find((node) => (node.text ?? '').trim() === '消息' || /^消息[，,]/u.test(node.desc ?? ''));
  const badge = tab && nodes.find((node) => /^\d{1,3}\+?$/u.test((node.text ?? '').trim())
    && node.bounds
    && Math.abs(node.bounds.cx - tab.bounds.cx) < 100
    && Math.abs(node.bounds.cy - tab.bounds.cy) < 95
    && node.bounds.w < 90);
  const described = nodes.map((node) => /消息[，,]\s*(\d+)\s*条?未读/u.exec(node.desc ?? '')).find(Boolean);
  const flagged = nodes.some((node) => /消息[，,]?按钮有未读/u.test(node.desc ?? ''));
  const count = badge ? Number(String(badge.text).replace('+', '')) : (described ? Number(described[1]) : null);
  return {
    has: Boolean(badge) || Boolean(described) || flagged,
    count,
    label: badge?.text ?? (described ? described[1] : ''),
    point: badge ? { x: badge.bounds.cx, y: badge.bounds.cy } : null,
    tab: tab ? { x: tab.bounds.cx, y: tab.bounds.cy } : null,
  };
}
