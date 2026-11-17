// 回复评论要「带着作品上下文」：同样是「好看」，在一条讲做饭的图文下面和在一条
// 讲球赛的视频下面，该接的话完全不一样；同一条帖子下面第 3 条评论和第 1 条评论，
// 语气也不该一个样。这个模块只做两件事：
//   1. 把散落在各处的上下文（作品、评论、评论线程、我之前的回复）整理成一份确定的形状；
//   2. 把它压成一段给模型看的文字（有长度上限，且不带任何需要模型猜的东西）。
// 纯函数，不碰数据库、不碰设备，方便直接单测。

const MAX_CAPTION = 300;
const MAX_THREAD = 6;
const MAX_TEXT = 600;

/** 把任意输入压成单行短文本。 */
function clean(value, max = 120) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * 作品类型：设备层会给出 'video' | 'image' | 'unknown'，
 * 也接受中文「视频」「图文」「图集」以及带 #话题 的标题串。
 */
export function workKindOf(value) {
  const text = String(value ?? '').toLowerCase();
  if (!text) return 'unknown';
  if (/图文|图集|image|photo|album/u.test(text)) return 'image';
  if (/视频|video|movie/u.test(text)) return 'video';
  return 'unknown';
}

/**
 * 整理一次「回复这条评论」需要的全部上下文。
 *
 * @param {object} input
 * @param {object} [input.work]    作品：{title, caption, kind, author}
 * @param {object} input.comment   要回的那条评论：{author, text}
 * @param {Array}  [input.thread]  同帖评论链（从旧到新）：[{author, text, isMine, isParent}]
 * @param {Array}  [input.earlier] 我之前在该帖下的回复：[{author, text}]
 * @returns {{mode:string, work:object|null, comment:object, thread:Array, earlier:Array}}
 */
export function buildReplyContext({ work, comment, thread = [], earlier = [] } = {}) {
  const target = {
    author: clean(comment?.author, 24),
    text: clean(comment?.text, 200),
  };
  const workInfo = work
    ? {
      title: clean(work.title, 80),
      caption: clean(work.caption, MAX_CAPTION),
      kind: workKindOf(work.kind ?? work.title ?? work.caption),
      author: clean(work.author, 24),
    }
    : null;
  const hasWork = Boolean(workInfo && (workInfo.title || workInfo.caption));
  const chain = (Array.isArray(thread) ? thread : [])
    .map((item) => ({
      author: clean(item?.author, 24),
      text: clean(item?.text, 120),
      isMine: item?.isMine === true,
      isParent: item?.isParent === true,
    }))
    .filter((item) => item.text)
    .slice(-MAX_THREAD);
  const past = (Array.isArray(earlier) ? earlier : [])
    .map((item) => ({ author: clean(item?.author, 24), text: clean(item?.text, 120) }))
    .filter((item) => item.text)
    .slice(-4);
  const mode = hasWork ? (chain.length >= 2 ? 'work+thread' : 'work_only') : 'comment_only';
  return { mode, work: hasWork ? workInfo : null, comment: target, thread: chain, earlier: past };
}

/** 类型说人话，给提示词用。 */
export function kindLabel(kind) {
  if (kind === 'video') return '视频';
  if (kind === 'image') return '图文';
  return '作品';
}

/**
 * 压成提示词里那段「你现在站在什么语境里」。
 * 抓不到作品时明确写「没读到作品内容」，让模型别编。
 */
export function contextText(context, { max = MAX_TEXT } = {}) {
  if (!context) return '';
  const lines = [];
  if (context.work) {
    const kind = kindLabel(context.work.kind);
    const head = [context.work.title, context.work.author ? `作者 ${context.work.author}` : ''].filter(Boolean).join(' · ');
    lines.push(`作品（${kind}）：${head || '（标题没读到）'}`);
    if (context.work.caption) lines.push(`作品正文节选：${context.work.caption}`);
  } else {
    lines.push('作品内容：没读到（不要假装看过这条作品，也不要提作品里的细节）');
  }
  if (context.thread?.length) {
    const chain = context.thread
      .map((item) => `${item.isMine ? '我' : item.author || '网友'}：${item.text}`)
      .join(' / ');
    lines.push(`这条评论所在的那串对话：${chain}`);
  }
  if (context.earlier?.length) {
    const mine = context.earlier.map((item) => item.text).join(' / ');
    lines.push(`我之前在这个帖子下说过：${mine}`);
  }
  lines.push(`现在要回的是：${context.comment.author || '网友'} 说「${context.comment.text}」`);
  const text = lines.join('\n');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
