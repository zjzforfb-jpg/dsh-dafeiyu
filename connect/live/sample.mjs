// 「样本够不够」：这是本项目最容易被忽略的可信度问题。
//
// 一个动作跑了 1 次成功 → verdict=confirmed，但它和跑了 200 次都成功，
// 可信度不是一回事。这里只做标注，不改判定：判定仍是 confirmed/failed，
// 人看到「样本少」自己会多留一分心。

export const THIN_SAMPLE = 3;

/** @returns {{thin:boolean,label:string,tip:string}} */
export function sampleNote(runs) {
  const count = Number(runs ?? 0);
  if (count <= 0) return { thin: true, label: '', tip: '还没按「真实业务」跑过（页面手动跑不算）' };
  if (count < THIN_SAMPLE) {
    return { thin: true, label: `样本 ${count} 次`, tip: `只跑过 ${count} 次：确认过也不代表稳定，至少再跑 ${THIN_SAMPLE - count} 次再看` };
  }
  return { thin: false, label: '', tip: '' };
}
