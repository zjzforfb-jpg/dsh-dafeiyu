/**
 * 爆款链路：去别人的爆款视频底下，挑点赞最高的评论留言。
 *
 * 用户要求（m02626）：「最火的评论就是在爆款视频下方找 5-10 个，筛选点赞最多的，
 * 或者评论最多的，然后看着回复」。所以流程是：
 *   1) 搜索关键词 → 按点赞筛出 10 个爆款视频（≥1 万赞）
 *   2) 进视频评论区读前 10 条左右，按点赞自己排序（不依赖官方「最热」开关）
 *   3) 每个视频挑点赞最高的 2 条回复
 */
import { dumpUi } from '../../device/uia.mjs';
import {
  adbShell,
  backToFeed,
  currentActivity,
  openSearch,
  openSearchCard,
  onSearchResults,
  openVideoComments,
  parseCommentsWithLikes,
  parseSearchHotVideos,
  replyToComment,
  resetDouyin,
  searchKeyword,
  topComments,
  waitForHome,
} from '../../device/douyin.mjs';

/** 平时刷的关键词，配合大肥鱼「AI 小伙伴」的人设。 */
/** 抖音经常恢复上一次的横屏视频流；先退回主界面再点搜索，最多试 3 次。 */
async function ensureSearch(serial) {
  // 抖音冷启动会停在 SplashActivity，这时点搜索坐标是打空的；先等它真的到首页。
  await waitForHome(serial, { timeoutMs: 25_000 }).catch(() => {});
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await backToFeed(serial);
    await openSearch(serial);
    await new Promise((resolve) => setTimeout(resolve, 1800));
    const nodes = await dumpUi(serial);
    // 搜索页有两种形态：结果列表，或者第一条视频自动全屏播放（顶部只有搜索条）。
    // 后者退一层就回到列表，直接判失败会白跑一轮。
    if (nodes.some((node) => /^(综合|视频|用户|商品)$/u.test((node.text ?? '').trim()))) return;
    const cards = parseSearchHotVideos(nodes);
    if (cards.length) return;
    await adbShell(serial, 'input keyevent 4');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const after = await dumpUi(serial);
    if (parseSearchHotVideos(after).length || after.some((node) => /^(综合|视频|用户|商品)$/u.test((node.text ?? '').trim()))) return;
  }
  throw new Error(`search_unreachable:${await currentActivity(serial)}`);
}

export const HOT_KEYWORDS = ['程序员', 'AI 编程', '打工人', '猫咪', '美食'];

/** 爆款门槛：一万赞。 */
export const HOT_LIKES_MIN = 10_000;

/** 太沉重/敏感的题材不凑热闹，免得在别人的难过底下卖萌。 */
export const SKIP_TOPIC = /(去世|走了|死亡|轻生|自杀|抑郁|癌症|病房|手术|化疗|离婚|分手|被裁|裁员|失业|求职失败|负债|网贷|打官司|事故|遇难|地震|洪水)/u;

/** 搜索并挑出爆款视频（按点赞降序，最多 limit 条）。 */
export async function discoverHotVideos({ serial, keywords = HOT_KEYWORDS, minLikes = HOT_LIKES_MIN, limit = 10 }) {
  const found = [];
  for (const keyword of keywords) {
    if (found.length >= limit) break;
    await resetDouyin(serial);
    await ensureSearch(serial);
    const nodes = await searchKeyword(serial, keyword);
    const cards = parseSearchHotVideos(nodes).filter((card) => card.likes >= minLikes);
    for (const card of cards) {
      if (found.some((item) => item.title === card.title)) continue;
      found.push({ ...card, keyword });
      if (found.length >= limit) break;
    }
  }
  return found.sort((a, b) => b.likes - a.likes).slice(0, limit);
}

/**
 * 跑一轮：搜索关键词 → 按点赞取爆款 → 进视频 → 评论区按点赞挑最火的几条回复。
 * 回调 onVideo(卡片, 评论行) / onComment(卡片, 结果行) 用来落库。
 */
export async function runHotCommentRound({
  serial, keywords = HOT_KEYWORDS, videosPerRound = 2, perVideo = 2, minLikes = HOT_LIKES_MIN,
  generate = false, dryRun = false, gate = null, generateText = null, onVideo = null, onComment = null,
}) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const rounds = [];
  for (const keyword of keywords) {
    if (rounds.length >= videosPerRound) break;
    await resetDouyin(serial);
    await ensureSearch(serial);
    let nodes = await searchKeyword(serial, keyword);
    let cards = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      cards = parseSearchHotVideos(nodes).filter((card) => card.likes >= minLikes && !SKIP_TOPIC.test(card.title));
      if (cards.length) break;
      await sleep(2000);
      nodes = await dumpUi(serial);
    }
    for (let index = 0; index < cards.length && rounds.length < videosPerRound; index += 1) {
      const card = cards[index];
      const round = {
        video: { title: card.title, keyword, likes: card.likes, likesText: card.likesText, date: card.date },
        comments: [],
        error: null,
      };
      try {
        const fresh = parseSearchHotVideos(await dumpUi(serial));
        const target = fresh.find((item) => item.title.slice(0, 10) === card.title.slice(0, 10)) ?? card;
        let activity = '';
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await adbShell(serial, `input tap ${target.point.x} ${target.point.y}`);
          await sleep(4200);
          activity = await currentActivity(serial);
          if (/DetailActivity|FlowPageActivity|LandscapeFeedActivity/u.test(activity)) break;
        }
        if (/FlowPageActivity/u.test(activity)) throw new Error('photo_post');
        if (!/DetailActivity|LandscapeFeedActivity/u.test(activity)) throw new Error(`detail_not_opened:${activity}`);
        await openVideoComments(serial);
        let rows = [];
        for (let attempt = 0; attempt < 6; attempt += 1) {
          if (attempt === 1 || attempt === 3) {
            await adbShell(serial, 'input swipe 656 1400 656 2350 420');
            await sleep(1500);
          }
          const panel = await dumpUi(serial);
          const got = topComments(parseCommentsWithLikes(panel), Math.max(10, perVideo));
          if (got.length > rows.length) rows = got;
          if (rows.length && rows[0].likes >= 100) break;
          await sleep(1600);
        }
        if (!rows.length) throw new Error('comments_empty');
        if (onVideo) onVideo(round.video, rows);
        for (const row of rows.slice(0, perVideo)) {
          const entry = { author: row.author, text: row.text, likes: row.likes, reply: '', sent: false };
          try {
            let reply = '';
            if (generate && generateText) reply = await generateText({ caption: `${card.title}\n有人在这条视频下面评论：${row.text}`, keyword });
            if (!reply) reply = pickCute();
            let verdict = gate ? gate(reply, { caption: card.title, comment: row.text }) : { ok: true };
            if (!verdict?.ok && verdict?.id === 'too_fast' && !dryRun) {
              await sleep(96_000);
              verdict = gate ? gate(reply, { caption: card.title, comment: row.text }) : { ok: true };
            }
            if (!verdict?.ok && !dryRun) throw new Error(`gate:${verdict?.id ?? 'blocked'}`);
            const result = await replyToComment(serial, { match: row.text, reply, dryRun });
            entry.reply = reply;
            entry.sent = dryRun ? true : Boolean(result?.sent);
            entry.verified = result?.verified ?? null;
          } catch (error) {
            entry.error = String(error.message ?? error);
          }
          round.comments.push(entry);
          if (onComment) onComment(round.video, entry);
          await sleep(2500);
        }
      } catch (error) {
        const message = String(error.message ?? error);
        if (message === 'photo_post') round.skipped = 'photo_post';
        else round.error = message;
      }
      rounds.push(round);
      try {
        await adbShell(serial, 'input keyevent 4');
        await sleep(1200);
        await adbShell(serial, 'input keyevent 4');
        await sleep(1500);
      } catch {}
    }
  }
  return { rounds };
}

function pickCute() {
  const list = ['🐟', '🐠✨', '🐳🥹', '😆💙', '🫧🐟'];
  return list[Math.floor(Math.random() * list.length)];
}
