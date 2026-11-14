/** 运行期联系人/设备标识：默认空，用 runtime/connect/targets.json 或环境变量覆盖，避免把个人 ID 写进代码。 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadTargets(root = process.cwd(), env = process.env) {
  let file = {};
  try {
    const path = join(root, 'runtime', 'connect', 'targets.json');
    if (existsSync(path)) file = JSON.parse(readFileSync(path, 'utf8'));
  } catch {}
  const qq = file.qq ?? {};
  return {
    deviceSerial: env.DSH_DEVICE_SERIAL ?? file.deviceSerial ?? '',
    qq: {
      dad: env.DSH_QQ_DAD ?? qq.dad ?? '',
      mom: env.DSH_QQ_MOM ?? qq.mom ?? '',
      group: env.DSH_QQ_GROUP ?? qq.group ?? '',
    },
  };
}
