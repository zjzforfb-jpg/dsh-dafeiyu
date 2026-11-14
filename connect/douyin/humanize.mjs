/** 像人一样：随机停顿、看完再走、滑动带抖动。 */

export function rand(min, max) { return Math.round(min + Math.random() * (max - min)); }

export function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/** 一条视频要停多久：多数 12–40 秒，偶尔早划走或看很久。 */
export function watchDelayMs() {
  const roll = Math.random();
  if (roll < 0.12) return rand(4_000, 7_000);      // 不想看，划走
  if (roll < 0.82) return rand(12_000, 38_000);    // 正常看
  if (roll < 0.95) return rand(40_000, 65_000);    // 看入迷
  return rand(70_000, 110_000);                    // 特别感兴趣
}

/** 看完之后、动手之前的犹豫。 */
export function beforeActionMs() { return rand(1_200, 4_500); }

/** 读评论/打字时的停顿。 */
export function typingPauseMs() { return rand(600, 2_000); }

/** 带抖动的滑动参数（起止点随机偏移，速度随机）。 */
export function swipeJitter({ x = 656, y0 = 2100, y1 = 800 } = {}) {
  const dx = rand(-90, 90);
  return [x + dx, y0 + rand(-120, 120), x + dx + rand(-60, 60), y1 + rand(-120, 120), rand(260, 520)];
}
