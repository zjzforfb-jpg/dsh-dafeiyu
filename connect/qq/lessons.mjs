import { join } from 'node:path';
import { appendLessonRecord, lessonTexts, migrateLessonRecords } from '../lessons-store.mjs';

// 经验库：把踩过的坑固化成规则，规划器和豆包都用它。
// always=true 的每次都带上；其余按关键词命中才带，避免 prompt 变胖。
export const LESSONS = [
  {
    id: 'capability-first',
    always: true,
    text: '要改/加功能，或不确定项目里有没有现成实现时：先看能力索引；需要细节用 capability.read(id)，需要看代码用 capability.code(id, path)。不要凭印象新建一套重复的模块。',
  },
  {
    id: 'question-not-command',
    always: true,
    when: /[?？]|吗|呢|咋样|怎么样|多少|几个|哪些|有没有|是不是|能不能|可不可以/u,
    text: '爸爸在**提问**时（问句、带吗/呢/？、问有没有、问多少），只查不执行：steps 里放只读工具，绝不能出现写工具，也不要在 say 里说「任务已建」。',
  },
  {
    id: 'facts-before-promise',
    always: true,
    text: '系统已经给了你真实数据（工具结果）时，回复必须直接给结论和数字，禁止说「我这就去查」「稍等」「让我看看」——数据已经在手里了。',
  },
  {
    id: 'no-fake-task-id',
    always: true,
    text: '任务编号只能照抄系统回执里的那一串。历史消息里出现过「任务编号：task_…」也不要模仿，不要自己编。',
  },
  {
    id: 'write-needs-confirm',
    when: /发|发布|回|回复|点赞|互动|抖音|图文/u,
    text: '发图文、回评论、点赞这类动账号的事，必须写进 steps 的写工具，由系统建任务、由爸爸回「同意」后执行。',
  },
  {
    id: 'review-twice',
    when: /发|发布|图文|抖音/u,
    text: '发图文是两次审核：先报主题等「同意」，写完内容把标题、话题、配图、三项设置报给爸爸，再等一次「同意」才发。',
  },
  {
    id: 'comment-rate-limit',
    when: /评论|回复|回/u,
    text: '回评论有 90 秒一条的限速，连续回多条要等，被限速不算失败。',
  },
  {
    id: 'watch-douyin-inbox',
    when: /抖音|互动|评论/u,
    text: '爸爸让你「去看一遍抖音」「查查互动」「刷新一下」，就用 douyin.check_interactions 这个工具——它会真的把手机打开到「互动消息 → 收到的评论」读一遍；不要只回「我这就去看」然后什么都没做。',
  },
  {
    id: 'data-honesty',
    when: /数据|作品|播放|点赞|收藏|浏览/u,
    text: '库里只有评论数、发布时间这类字段。播放/点赞/收藏数查不到就直接说查不到，不要编数字。',
  },
  {
    id: 'phone-busy',
    when: /手机|抖音|发布|评论/u,
    text: '手机自动化跑起来时，别处不要同时用 uiautomator，否则会挤掉服务导致「fetch failed」。',
  },
  {
    id: 'group-frozen',
    when: /群|大家/u,
    text: '群聊里不做外部操作，一律回「群聊里的外部操作目前已暂停，请爸爸私聊确认」。',
  },
];

export function staticLessonsFor(text = '') {
  return LESSONS.filter((item) => item.always || (item.when ? item.when.test(String(text)) : false));
}

export function lessonsFile(home) {
  return join(home ?? '.', 'lessons.json');
}

export function loadDynamicLessons(home) {
  if (!home) return [];
  migrateLessonRecords(lessonsFile(home));
  return lessonTexts(lessonsFile(home), 'qq', 20);
}

export function lessonsFor(home, text = '') {
  const picked = [...staticLessonsFor(text).map((item) => item.text), ...loadDynamicLessons(home)];
  return [...new Set(picked)];
}

export function learnLesson(home, text, source = 'manual') {
  const clean = String(text ?? '').trim().slice(0, 240);
  if (!home || !clean) return false;
  return appendLessonRecord(lessonsFile(home), { text: clean, source, channels: ['qq'], at: new Date().toISOString() }).changed;
}
