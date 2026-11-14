/**
 * 图文日常：按「人格 + 当前心情」想主题 → 生成配图 → 写文案。
 * 不负责发布；发布走 scripts/douyin.mjs 的相册流程。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { personaBlock, loadPersona, applyEvent, savePersona, humorRate } from './persona.mjs';
import { generateImageAuto } from './image.mjs';

function settings(home) {
  const file = join(home, 'dsh-pet', 'standalone-ai.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  return { baseUrl: 'http://127.0.0.1:3110', apiKey: config.apiKey, model: config.model ?? 'deepseek-flash' };
}

async function chat(home, messages, { maxTokens = 700 } = {}) {
  const config = settings(home);
  const response = await fetch(`${config.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({ model: config.model, messages, max_tokens: maxTokens, temperature: 0.9 }),
  });
  if (!response.ok) throw new Error(`poster_brain_${response.status}`);
  const payload = await response.json();
  const message = payload?.choices?.[0]?.message ?? {};
  const content = String(message.content ?? '').trim();
  if (content) return content;
  const reasoning = String(message.reasoning_content ?? '');
  const quoted = reasoning.match(/[「“"]([^」”"]{6,120})[」”"]/);
  return quoted ? quoted[1] : '';
}

export const THEMES = [
  '今天在窗边晒太阳，尾巴一摆一摆',
  '刚学会打字，想跟人类聊两句',
  '偷看爸爸敲代码，被屏幕光晃到',
  'emo 一下：网络好慢，等得好着急',
  '吃到好吃的小饼干，开心到转圈',
];

/** 生成一条图文日常：{ caption, imagePrompt, imageFile, mood, humor }。 */
export async function composePost({ root = process.cwd(), home, theme, dryRun = false } = {}) {
  let persona = loadPersona(root);
  const selectedTheme = theme || THEMES[Math.floor(Math.random() * THEMES.length)];
  const scene = 'chat';

  const planned = await chat(home, [
    { role: 'system', content: personaBlock(persona, scene) },
    {
      role: 'user',
      content: [
        `今天想发一条抖音图文日常，主题是：${selectedTheme}。`,
        `请给出两个结果，严格用两行：`,
        `第一行 CAPTION: 一句文案（15–40 字，第一人称，可爱但不做作，可带 1 个 emoji，不带话题）。`,
        `第二行 IMAGE: 一句英文绘图提示词（画面里有蓝色头发的小鲸鱼少女玩偶/小鲸鱼元素，日系插画或生活感摄影，温暖，不用文字）。`,
      ].join('\n'),
    },
  ]);

  const caption = planned.match(/CAPTION[:：]\s*(.+)/u)?.[1]?.trim() ?? planned.split('\n')[0].replace(/^CAPTION[:：]\s*/u, '').trim();
  const imagePrompt = planned.match(/IMAGE[:：]\s*(.+)/u)?.[1]?.trim()
    ?? `cute anime chibi whale girl toy, blue hair, cozy home, warm light, no text`;

  persona = applyEvent(persona, 'discover');
  const result = { caption, imagePrompt, theme: selectedTheme, mood: persona.mood.mood, humor: humorRate(persona, scene) };

  if (!dryRun) {
    const image = await generateImageAuto(imagePrompt, { root, aspect: '3:4' });
    result.imageFile = image.file;
    result.imageBytes = image.bytes;
    result.imageProvider = image.provider ?? 'unknown';
  }

  savePersona(root, persona);
  return result;
}
