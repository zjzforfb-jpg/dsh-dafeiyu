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
export function parseComments(nodes) {
  const rows = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (!node.cls.includes('Text')) continue;
    if (!node.text || META.test(node.text) || node.text.length < 4) continue;
    if (/^(去发布作品|发作品交流|让更多人看到|同时发布为作品)/u.test(node.text)) continue;
    const reply = nodes.slice(index + 1, index + 14).find((next) => next.text === '回复' && next.clickable);
    if (!reply) continue;
    const author = [...nodes.slice(0, index)].reverse().find((prev) => prev.cls.includes('Text') && prev.text && !META.test(prev.text) && looksLikeName(prev.text));
    rows.push({
      author: author?.text ?? '',
      text: node.text,
      replyPoint: { x: reply.bounds.cx, y: reply.bounds.cy },
    });
  }
  return rows;
}

/** Post a top-level comment on the current video. */
export async function postComment(serial, text, { dryRun = false } = {}) {
  let nodes = await dumpUi(serial);
  let input = nodes.find((node) => node.cls.includes('EditText'));

  if (input) {
    // 点开编辑器（内联输入条 → 全屏编辑页）
    await tapPoint(serial, { x: input.bounds.cx, y: input.bounds.cy });
    await sleepMs(1400);
    nodes = await dumpUi(serial);
    input = nodes.find((node) => node.focused && node.cls.includes('EditText')) ?? nodes.find((node) => node.cls.includes('EditText'));
    if (input) {
      await tapPoint(serial, { x: input.bounds.cx, y: input.bounds.cy });
      await sleepMs(700);
    }
  } else if (!findNodes(nodes, { text: '发送' }).length) {
    throw new Error('comment_bar_missing');
  }

  await withAdbKeyboard(serial, async () => inputText(serial, text));
  await sleepMs(900);

  nodes = await dumpUi(serial);
  const send = findNodes(nodes, { text: '发送' }).pop();
  if (!send) throw new Error('comment_send_missing');
  if (dryRun) {
    await adbShell(serial, 'input keyevent 4');
    await sleepMs(500);
    return { dryRun: true, text, sendPoint: { x: send.bounds.cx, y: send.bounds.cy } };
  }
  await tapPoint(serial, { x: send.bounds.cx, y: send.bounds.cy });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await sleepMs(1200);
    const after = await dumpUi(serial);
    const stillTyping = after.some((node) => node.cls.includes('EditText') && node.text?.includes(text.slice(0, 6)));
    const composerGone = !after.some((node) => node.text === '发送');
    if (after.some((node) => node.text?.includes(text.slice(0, 6))) && !stillTyping) return { sent: true };
    if (composerGone && !stillTyping) return { sent: true, verified: 'composer_closed' };
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
  messagesTab: { x: 940, y: 2757 },
  interactions: { x: 277, y: 692 },
  homeTab: { x: 119, y: 2730 },
};

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
    if (panel.some((node) => /有什么想法|发条评论|展开说说/u.test(`${node.text}${node.desc}`)) || parseComments(panel).length) {
      return panel;
    }
  }
  throw new Error('comment_panel_not_open');
}

/** Open the search page from the feed. */
export async function openSearch(serial) {
  await tapPoint(serial, DOUYIN_NAV.searchIcon);
  await sleepMs(1600);
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
  const tab = first.find((node) => node.text === '用户' && node.clickable);
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
      // 用户名列表在部分版本是自绘的，dump 里拿不到文字：按卡片几何位置点头像。
      for (let row = 0; row < 3; row += 1) {
        await tapPoint(serial, { x: 190, y: 628 + row * 296 });
        await sleepMs(2800);
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
  return nodes
    .filter((node) => node.clickable && node.bounds.w >= 280 && node.bounds.w <= 620 && node.bounds.h >= 380 && node.bounds.h <= 900)
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
  return { sent: final.some((node) => node.text.includes(text.slice(0, 6))) };
}
