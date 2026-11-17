/**
 * 毕业项目《大肥鱼的第一次独立创作者挑战》——12 项里程碑。
 * 全部用真实战绩判定，不靠人工打勾。
 */
import { certify, collectEvidence } from './levels.mjs';

const M = (key, label, detail, ok, progress, target) => ({ key, label, detail, done: Boolean(ok), progress, target });

export function graduationState(db, root, now = Date.now()) {
  const e = collectEvidence(db, root, now);
  const cert = certify(db, root, now, { persist: false });
  const rate = e.comments >= 5 ? e.commentsReplied / e.comments : 0;
  const items = [
    M('m01', '发出第一个编号作品', '拿到 DFY-0001', e.works >= 1, e.works, 1),
    M('m02', '累计三个作品', '作品库里有 3 条自己的内容', e.works >= 3, e.works, 3),
    M('m03', '连续三天在创作', '至少 3 个不同日子发布过作品', e.publishDays >= 3, e.publishDays, 3),
    M('m04', '收到第一条评论', '有人愿意跟你说话', e.comments >= 1, e.comments, 1),
    M('m05', '累计十条评论', '评论区开始有讨论', e.comments >= 10, e.comments, 10),
    M('m06', '回复率达到 80%', '至少 5 条评论、回复率 ≥80%', e.comments >= 5 && rate >= 0.8, Math.round(rate * 100), 80),
    M('m07', '在爆款下回复 5 条', '去别人的热门评论区参与', e.hotReplied >= 5, e.hotReplied, 5),
    M('m08', '认识五个粉丝', '回复过至少 5 个不同的人', e.fans >= 5, e.fans, 5),
    M('m09', '学完三门课', '先立住自己', e.coursesDone >= 3, e.coursesDone, 3),
    M('m10', '学完全部十二门课', '四个阶段全部走完', e.coursesDone >= 12, e.coursesDone, 12),
    M('m11', '通过 Lv2 认证', '真实任务能独立完成', cert.level >= 2, cert.level, 2),
    M('m12', '留下经验和复盘', '至少 5 条经验、3 条复盘', e.lessons >= 5 && e.reviews >= 3, Math.min(e.lessons, e.reviews), 5),
  ];
  const done = items.filter((item) => item.done).length;
  return { items, done, total: items.length, percent: Math.round((done / items.length) * 100), evidence: e, certification: cert };
}
