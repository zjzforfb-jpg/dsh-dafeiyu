#!/usr/bin/env node
/**
 * 每日计划：按性格/心情挑今天想做的事，先在群里问爸爸/妈妈，同意了才去做。
 *   node scripts/day-plan.mjs --generate          只生成并打印
 *   node scripts/day-plan.mjs --ask               生成后在群里发问，等同意
 *   node scripts/day-plan.mjs --ask --run         同意后立刻执行
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { addPlan, runPlan } from '../connect/plans.mjs';
import { sendApprovalRequest, waitApproval } from '../connect/approvals.mjs';
import { ACTIONS } from '../connect/actions.mjs';

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const root = process.cwd();

const MENU = ['douyin.browse', 'douyin.check_interactions', 'douyin.reply_comments', 'douyin.comment_latest'];
const MOODS = ['calm', 'happy', 'curious', 'playful', 'focused', 'low_energy'];

function readJson(file, fallback) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } }

async function generate() {
  const moodFile = readJson(join(root, 'runtime', 'persona', 'mood.json'), {});
  const mood = MOODS.includes(moodFile.mood) ? moodFile.mood : MOODS[Math.floor(Math.random() * MOODS.length)];
  const menu = MENU.map((name, index) => `${index + 1}. ${name} - ${ACTIONS[name].label}`).join('\n');
  const prompt = `你是大肥鱼，一只蓝色的数字小鲸鱼。今天心情是「${mood}」。
从下面能做的事里挑 2–3 件排成今天的计划，按你此刻的心情和好奇心，不要全挑，也不要挑重复的。
${menu}
只输出 JSON：{"mood":"${mood}","reason":"一句为什么这么安排","steps":["动作名",...]}`;
  const settings = JSON.parse(readFileSync(join(root, 'runtime', 'dsh-home', 'dsh-pet', 'standalone-ai.json'), 'utf8'));
  const response = await fetch('http://127.0.0.1:3110/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.apiKey}` },
    body: JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user', content: prompt }], max_tokens: 320, thinking: { type: 'disabled' } }),
  });
  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content ?? '';
  const match = text.match(/\{[\s\S]*\}/);
  const plan = match ? JSON.parse(match[0]) : { mood, reason: '', steps: ['douyin.browse'] };
  plan.steps = (plan.steps ?? []).filter((name) => MENU.includes(name)).slice(0, 3);
  if (!plan.steps.length) plan.steps = ['douyin.browse'];
  return plan;
}

const plan = await generate();
const lines = plan.steps.map((name, index) => `${index + 1}. ${ACTIONS[name].label}（${name}）`);
const caption = `今天心情：${plan.mood}\n${plan.reason ? `想法：${plan.reason}\n` : ''}计划：\n${lines.join('\n')}`;
console.log(JSON.stringify(plan, null, 2));
if (!has('ask')) process.exit(0);

const sent = await sendApprovalRequest({ root, target: '大肥鱼小可爱', title: '今天的计划', caption, note: '同意我就照这个来，不行你直接说想改哪条。', operations: plan.steps });
const result = await waitApproval({ root, requestId: sent.requestId, timeoutMs: 15 * 60_000 });
if (!result?.approved) { console.log(JSON.stringify({ approved: false })); process.exit(1); }
console.log(JSON.stringify({ approved: true, reply: result.text }));
if (!has('run')) process.exit(0);

const stored = addPlan(root, { steps: plan.steps.map((name) => ({ name })), origin: 'day-plan', title: '每日计划', approvalRequestId: sent.requestId });
const done = await runPlan(root, stored, { log: (line) => console.log(line) });
console.log(JSON.stringify(done));
