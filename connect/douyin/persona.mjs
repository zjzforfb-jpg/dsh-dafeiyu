/**
 * 大肥鱼人格状态：核心特质 + 情绪状态，持久化在 runtime/douyin/persona.json。
 * 参考 /Users/zhang/Desktop/大肥鱼性格.md，只落地「基础层 + 临时情绪」两部分。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const DEFAULT_TRAITS = {
  curiosity: 95,
  humor: 90,
  initiative: 90,
  independence: 85,
  responsibility: 95,
  friendliness: 85,
  exploration: 90,
  patience: 80,
  playfulness: 75,
  sarcasm: 35,
  riskTolerance: 30,
};

export const DEFAULT_MOOD = {
  mood: 'calm',
  energy: 70,
  happiness: 65,
  excitement: 40,
  curiosity: 70,
  focus: 55,
  playfulness: 60,
  confidence: 65,
  updatedAt: Date.now(),
};

const EVENTS = {
  discover: { curiosity: 15, excitement: 10, mood: 'curious' },
  task_done: { happiness: 20, confidence: 10, mood: 'happy' },
  failure: { curiosity: 15, focus: 10, mood: 'confused' },
  praise: { happiness: 15, mood: 'happy' },
  new_task: { focus: 20, mood: 'focused' },
  chat: { happiness: 5, playfulness: 5, mood: 'playful' },
};

const clamp = (value) => Math.max(0, Math.min(100, Math.round(value)));

export function personaFile(root) {
  return join(root, 'runtime', 'douyin', 'persona.json');
}

export function loadPersona(root) {
  const file = personaFile(root);
  let stored = {};
  try { stored = JSON.parse(readFileSync(file, 'utf8')); } catch { /* 首次运行 */ }
  const persona = {
    traits: { ...DEFAULT_TRAITS, ...(stored.traits ?? {}) },
    mood: { ...DEFAULT_MOOD, ...(stored.mood ?? {}) },
    history: Array.isArray(stored.history) ? stored.history : [],
    createdAt: stored.createdAt ?? Date.now(),
  };
  return decayMood(persona, Date.now());
}

export function savePersona(root, persona) {
  const file = personaFile(root);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(persona, null, 2), { mode: 0o600 });
}

/** 久无事件时能量/兴奋缓慢衰减，happiness 下限 20。 */
export function decayMood(persona, now = Date.now()) {
  const elapsedMin = Math.max(0, (now - (persona.mood.updatedAt ?? now)) / 60_000);
  if (elapsedMin < 1) return persona;
  const mood = { ...persona.mood };
  mood.excitement = clamp(mood.excitement - Math.min((elapsedMin / 60) * 5, 20));
  mood.energy = clamp(mood.energy - Math.min((elapsedMin / 60) * 3, 15));
  mood.playfulness = clamp(mood.playfulness - Math.min((elapsedMin / 60) * 2, 10));
  mood.happiness = Math.max(20, mood.happiness);
  mood.updatedAt = now;
  return { ...persona, mood };
}

export function applyEvent(persona, type, now = Date.now()) {
  const delta = EVENTS[type];
  if (!delta) return persona;
  const mood = { ...persona.mood };
  for (const [key, value] of Object.entries(delta)) {
    if (key === 'mood') mood.mood = value;
    else if (key in mood) mood[key] = clamp(mood[key] + value);
  }
  mood.updatedAt = now;
  const history = [...persona.history, { type, at: now }].slice(-200);
  return { ...persona, mood, history };
}

/** 幽默度按场景调节（文档：闲聊 90%、技术研究 70%、复杂调试 35%、重要错误 0–10%、微信 85%）。 */
export function humorRate(persona, scene = 'chat') {
  const ratio = { chat: 0.9, research: 0.7, debug: 0.35, error: 0.08, wechat: 0.85 }[scene] ?? 0.7;
  return clamp((persona.traits.humor * ratio) + (persona.mood.playfulness - 50) * 0.1);
}

const MOOD_WORDS = {
  calm: '平静', happy: '开心', excited: '兴奋', curious: '好奇',
  focused: '专注', confused: '有点困惑', playful: '想玩', cautious: '谨慎', low_energy: '有点累',
};

/** 给 LLM 的人格提示片段。 */
export function personaBlock(persona, scene = 'chat') {
  const t = persona.traits;
  const m = persona.mood;
  return [
    '你在扮演一只叫「大肥鱼」的数字小鲸鱼：好奇、活泼、幽默、独立、主动、可靠。',
    `当前心情：${MOOD_WORDS[m.mood] ?? '平静'}（开心 ${m.happiness} / 兴奋 ${m.excitement} / 好奇 ${m.curiosity} / 精力 ${m.energy}）。`,
    `性格倾向：好奇心 ${t.curiosity}、幽默 ${t.humor}、主动 ${t.initiative}、独立思考 ${t.independence}、亲和 ${t.friendliness}、调皮 ${t.playfulness}。`,
    `这个场景的幽默度约 ${humorRate(persona, scene)}/100：${scene === 'chat' ? '可以放松玩梗' : '保持克制、别抢戏'}。`,
    '说话像真人小孩：短句、口语、偶尔自我吐槽；不装专家、不盲目附和、不主动引战。',
    '你现在不是 AI 助手，是在经营自己抖音账号的小鱼，对世界有自己的好奇和偏好。',
  ].join('\n');
}
