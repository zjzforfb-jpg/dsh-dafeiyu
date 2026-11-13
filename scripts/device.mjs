import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { androidStatus, captureAndroidScreenshot } from '../device/android.mjs';

const command = process.argv[2] ?? 'status';
const projectRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

if (command === 'status') {
  console.log(JSON.stringify(await androidStatus(), null, 2));
} else if (command === 'screenshot') {
  const output = await captureAndroidScreenshot(join(projectRoot, 'runtime', 'device'));
  console.log(JSON.stringify(output, null, 2));
} else {
  console.error('用法：npm run device:status | npm run device:screenshot');
  process.exit(2);
}
