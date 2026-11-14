/**
 * 大肥鱼的形象与画风规范（角色一致性用）。
 * 参考：抖音「壹琳」的大肥鱼+克劳德视频（flat 2D anime pasted into photoreal room）、
 *      用户提供的角色设定表 runtime/douyin/refs/dafeiyu-ref.png。
 */
export const CHARACTER = [
  'super-deformed chibi girl, 2.5 heads tall, huge round head, tiny body',
  'round face, tiny nose and mouth, soft pink blush',
  'large glossy blue-gradient eyes with bold highlights and glass texture',
  'dark navy-blue hair fading to light cyan tips, wavy',
  'white frilled lace headband with light blue bows',
  'navy-blue maid dress with white lace apron, small whale embroidery, gold buttons',
  'small blue whale tail behind her',
  'white stockings, navy shoes',
].join('; ');

export const STYLE = [
  'FLAT 2D hand-drawn anime character pasted into a REAL PHOTOGRAPH of a cozy living room',
  'like a Japanese short-video VTuber cut-out',
  'crisp black ink lineart, cel shading with simple gradient shadows, flat colors',
  'no 3D rendering, not a plastic figurine, no plastic shine',
  'photoreal warm interior, beige carpet, blurred sofa and teddy bear, golden lamp light',
  'cinematic color grading, slight film grain, character standing on the carpet like a sticker',
  'no text, no watermark',
].join('; ');

export function buildPrompt(pose, scene = '') {
  return `Character: ${CHARACTER}.\nArt direction: ${STYLE}.\nPose: ${pose}.${scene ? `\nScene: ${scene}.` : ''}`;
}

/** 固定封面模板提示词：大肥鱼占比大 + 爆款封面文字。 */
export function coverPrompt(title, { mood = 'happy', ratio = '3:4' } = {}) {
  return [
    'Vertical social-media cover for a cute anime account, aspect ' + ratio + '.',
    'The chibi character takes about 70% of the frame, big expressive face, playful ' + mood + ' expression, waving at the camera.',
    `Character: ${CHARACTER}.`,
    'Style: ' + STYLE + '.',
    'Composition: warm living room background, soft depth of field, leave the top-left area slightly calmer for text.',
    `Add big bold Chinese cover text: "${title}". Use a chunky rounded font, white fill with dark navy outline and a soft warm glow, placed in the upper third, very legible on a phone.`,
    'No other text, no watermark.',
  ].join('\n');
}
