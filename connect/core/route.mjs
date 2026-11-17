// 计划 P0-B-2：把「规则还是模型来管这句话」这���开关收敛到一处。
//
// 以前这个判断散在 connect/qq/service.mjs 的三处（正则意图、planner 是否介入、
// [DO:...] 标记是否还能用），每处各写各的。现在统一成一个 routePolicy()，
// 输入一句话 + 当前上下文，输出一个明确的 route，纯函数、可单测。

import { intentFromText } from './task.mjs';

/** 同意 / 拒绝的原话。 */
export const APPROVE_WORDS = /^(同意|确认|执行|可以|好的|好|发|发布|发吧|发咯|发出去)$/u;
// 「拒绝」这类否定说法原来不在表里：说了等于没说，任务会一直挂在待确认。
export const DECLINE_WORDS = /^(算了|算了算|不用了?|不要了?|不要|不发了?|不打了?|不了|不行|别了|别打|别拨|不拨|取消|先别|先不要|等一下|等等|拒绝|拒绝吧|不同意|不确认)$/u;

/** 草稿阶段的逐条改稿：改 1：标题 / 改 2：正文 / 改 3：话题。 */
export const REVISE_PATTERN = /^改\s*([1-3])\s*[：:，,\s]+([\s\S]+)$/u;

/** 学习闭环的命令。 */
export const LEARNING_LIST_WORDS = /^(提案|经验|学习清单|学习提案|有什么提案)$/u;
export const LEARNING_APPROVE_PATTERN = /^(?:批准|通过|采纳)\s*R?([0-9a-zA-Z_-]{2,10})$/u;
export const LEARNING_REJECT_PATTERN = /^(?:驳回|跳过|不改)\s*R?([0-9a-zA-Z_-]{2,10})$/u;

/** 斜杠命令。 */
export const COMMAND_PATTERNS = Object.freeze([
  { command: 'call_start', pattern: /^\/(?:通话|打电话)(?:[：:，,\s]|$)/u },
  { command: 'call_end', pattern: /^\/(?:挂断|结束通话)(?:[：:，,\s]|$)/u },
  { command: 'memory_list', pattern: /^\/记忆$/u },
  { command: 'memory_save', pattern: /^\/记住[：:，,\s]+(.+)$/u },
  { command: 'memory_revise', pattern: /^\/更正记忆\s*#?(\d+)[：:，,\s]+(.+)$/u },
  { command: 'memory_forget', pattern: /^\/忘记记忆\s*#?(\d+)$/u },
  { command: 'voice_toggle', pattern: /^\/语音\s*(开|关)$/u },
]);

/** 记忆类命令需要 owner 私聊。 */
export const MEMORY_COMMANDS = Object.freeze(['memory_list', 'memory_save', 'memory_revise', 'memory_forget']);

export const ROUTES = Object.freeze({
  decline: 'decline',
  revise: 'revise',
  approve: 'approve',
  learning_list: 'learning_list',
  learning_approve: 'learning_approve',
  learning_reject: 'learning_reject',
  external_intent: 'external_intent',
  hold: 'hold',
  ignore: 'ignore',
  command: 'command',
  chat: 'chat',
});

/**
 * 斜杠命令解析。
 * @returns {{command:string,args:Record<string,string>}|null}
 */
export function parseSlashCommand(text) {
  const command = String(text ?? '').trim();
  for (const { command: name, pattern } of COMMAND_PATTERNS) {
    const matched = pattern.exec(command);
    if (!matched) continue;
    const args = {};
    if (name === 'memory_save') args.content = matched[1] ?? '';
    if (name === 'memory_revise') { args.id = matched[1] ?? ''; args.content = matched[2] ?? ''; }
    if (name === 'memory_forget') args.id = matched[1] ?? '';
    if (name === 'voice_toggle') args.enabled = matched[1] === '开';
    return { command: name, args };
  }
  return null;
}

/**
 * 统一路由决策。
 *
 * @param {string} text
 * @param {object} context
 *   kind            'c2c' | 'group'
 *   hasPlanner      有没有决策脑（有的话意图交给模型判，正则只兜底）
 *   pendingTask     当前会话有没有待确认任务
 *   canApprove      这个人有没有批准权（策略判定结果）
 *   canPropose      这个人能不能提任务
 *   allowed         peer 行（enabled / autoReply / voiceReply）
 *   atMe / mentionOthers / mentionAll
 * @returns {{route:string, command?:string, args?:object, token?:string, intent?:object, rationale:string}}
 */
export function routePolicy(text, context = {}) {
  const raw = String(text ?? '').trim();
  const {
    kind = 'c2c',
    hasPlanner = false,
    pendingTask = null,
    canApprove = false,
    canPropose = false,
    canReadMemory = null,
    allowed = null,
    atMe = kind !== 'group',
    mentionOthers = false,
    mentionAll = false,
  } = context;
  // 记忆命令的权限单独给（默认跟批准权一致，两者都是 owner 私聊才成立）。
  const canRead = canReadMemory === null ? canApprove : Boolean(canReadMemory);

  // ① 有待确认任务时，先看是不是在回应它：拒绝 / 改稿 / 同意。
  if (pendingTask && canApprove) {
    if (DECLINE_WORDS.test(raw)) {
      return { route: ROUTES.decline, rationale: '命中拒绝词，且该会话有待确认任务' };
    }
    const revise = REVISE_PATTERN.exec(raw);
    if (revise) {
      return {
        route: ROUTES.revise,
        args: { field: revise[1] === '1' ? 'title' : revise[1] === '2' ? 'caption' : 'topics', value: revise[2].trim() },
        rationale: '命中改稿命令，且该会话有待确认任务',
      };
    }
    if (APPROVE_WORDS.test(raw)) {
      return { route: ROUTES.approve, rationale: '命中同意词，且该会话有待确认任务' };
    }
  }

  // ② 学习闭环命令（只有能批准的人看得到提案）。
  if (canApprove) {
    if (LEARNING_LIST_WORDS.test(raw)) {
      return { route: ROUTES.learning_list, rationale: '命中学习提案列表命令' };
    }
    const approveLearning = LEARNING_APPROVE_PATTERN.exec(raw);
    if (approveLearning) {
      return { route: ROUTES.learning_approve, token: approveLearning[1], rationale: '命中学习提案批准命令' };
    }
    const rejectLearning = LEARNING_REJECT_PATTERN.exec(raw);
    if (rejectLearning) {
      return { route: ROUTES.learning_reject, token: rejectLearning[1], rationale: '命中学习提案驳回命令' };
    }
  }

  // ③ 有决策脑且是私聊时，意图交给模型；否则用正则兜底（只看操作动词）。
  if (!hasPlanner || kind !== 'c2c') {
    const intent = intentFromText(raw);
    if (intent && canPropose) {
      return { route: ROUTES.external_intent, intent, requires_confirmation: true, rationale: '规则识别到外部动作意图' };
    }
  }

  // ④ 这个会话允许大肥鱼开口吗？
  if (!allowed || !allowed.enabled || !allowed.autoReply) {
    return { route: ROUTES.hold, rationale: '该联系人未开启自动回复' };
  }

  // ⑤ 群聊里不插嘴。
  if (kind === 'group') {
    if (mentionOthers) {
      return { route: ROUTES.ignore, reason: 'addressed_to_others', rationale: '这条 @ 的是别人' };
    }
    if (!atMe) {
      if (mentionAll && !/大肥鱼|肥鱼|鱼鱼/u.test(raw)) {
        return { route: ROUTES.ignore, reason: 'mention_all_skip', rationale: '@全体 但没提到大肥鱼' };
      }
      return { route: ROUTES.ignore, reason: 'ambient_skip', rationale: '群聊里没被点名，需要判断要不要插话' };
    }
  }

  // ⑥ 斜杠命令。记忆类命令只能在 owner 私聊里用。
  const memoryScope = /^\/(?:记忆|记住|更正记忆|忘记记忆)(?:[：:，,\s]|$)/u;
  const command = parseSlashCommand(raw);
  if (command && MEMORY_COMMANDS.includes(command.command) && !canRead) {
    return { route: ROUTES.hold, reason: 'memory_scope_denied', command: command.command, rationale: '记忆命令只能在 owner 私聊里用' };
  }
  if (!command && memoryScope.test(raw) && !canRead) {
    return { route: ROUTES.hold, reason: 'memory_scope_denied', rationale: '记忆命令只能在 owner 私聊里用' };
  }
  if (command) {
    return { route: ROUTES.command, command: command.command, args: command.args, rationale: '命中斜杠命令' };
  }

  return { route: ROUTES.chat, rationale: '普通聊天' };
}
