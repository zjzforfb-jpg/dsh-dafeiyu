/** 二审消息：标题 + 话题 + 三项设置，配图另外单发。 */
export function formatReview(prepared) {
  const title = prepared?.title || '（标题没拿到）';
  const topics = Array.isArray(prepared?.topics) && prepared.topics.length ? prepared.topics.join(' ') : '（话题没拿到）';
  const s = prepared?.settings ?? {};
  const on = (v) => (v === true ? '已开 ✓' : v === false ? '没开 ✗' : '未确认 ⚠️');
  const off = (v) => (v === true ? '已关 ✓' : v === false ? '没关 ✗' : '未确认 ⚠️');
  return [
    '写好了，先给你审：',
    '',
    `标题：${title}`,
    `话题：${topics}`,
    `三项设置：内容由 AI 生成 ${on(s.aiDeclared)}｜允许下载 ${off(s.downloadOff)}｜发布后保存至相册 ${off(s.saveAlbumOff)}`,
    '',
    '配图我单独发你一张。回「发」我就点发布；想改文案回「改：…」。',
  ].join('\n');
}

/** 内容草稿审核（发布前先审，编号方便爸爸逐条改）。 */
export function formatDraftReview(draft) {
  const title = draft?.title || '（标题没拿到）';
  const caption = draft?.caption || '（正文没拿到）';
  const topics = Array.isArray(draft?.topics) && draft.topics.length ? draft.topics.join(' ') : '（话题没拿到）';
  return [
    '想发一条日常，先给你审内容：',
    '',
    `1. 标题：${title}`,
    `2. 正文：${caption}`,
    `3. 话题：${topics}`,
    '4. 三项设置：内容由 AI 生成 开｜允许下载 关｜发布后保存至相册 关',
    '5. 配图：见下（单独发一张）',
    '',
    '回「同意」或「发」我就去抖音发；想改回「改 2：……」，不要了回「算了」。',
  ].join('\n');
}
