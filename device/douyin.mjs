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
  await tapPoint(serial, DOUYIN.commentInput);
  await sleepMs(1200);
  let nodes = await dumpUi(serial);
  const input = nodes.find((node) => node.focused && node.cls.includes('EditText'));
  if (!input) throw new Error('comment_input_missing');
  await withAdbKeyboard(serial, async () => inputText(serial, text));
  await sleepMs(700);
  nodes = await dumpUi(serial);
  const typed = nodes.some((node) => node.text.includes(text.slice(0, 8)));
  if (!typed) throw new Error('comment_text_missing');
  const send = findNodes(nodes, { text: '发送' }).pop();
  if (!send) throw new Error('comment_send_missing');
  if (dryRun) {
    await adbShell(serial, 'input keyevent 4');
    await sleepMs(500);
    return { dryRun: true, text, sendPoint: { x: send.bounds.cx, y: send.bounds.cy } };
  }
  await tapPoint(serial, { x: send.bounds.cx, y: send.bounds.cy });
  await sleepMs(1600);
  const after = await dumpUi(serial);
  return { sent: after.some((node) => node.text.includes(text.slice(0, 8))) };
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
