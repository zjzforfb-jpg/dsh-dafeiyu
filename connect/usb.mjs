import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
export function maintainUsbTunnel(root) {
  let busy = false;
  const tick = () => {
    if (busy) return;
    let serial;
    try { serial = JSON.parse(readFileSync(join(root, 'usb-device.json'), 'utf8')).serial; } catch { return; }
    if (typeof serial !== 'string' || !serial) return;
    busy = true;
    execFile('/opt/homebrew/bin/adb', ['-s', serial, 'reverse', 'tcp:8765', 'tcp:8765'], { timeout: 5000 }, () => { busy = false; });
  };
  tick();
  const timer = setInterval(tick, 10000); timer.unref();
  return () => clearInterval(timer);
}
