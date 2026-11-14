import { join } from 'node:path';
import { openMemory } from '../brain/memory.mjs';
import { publishDesktopActivity } from '../desktop/activity.mjs';

/** Display only a generic notification; private previews stay in the Connect inbox. */
export async function announceConnectEvent(home, event) {
  if (event.kind !== 'wechat.notification') return;
  const db = openMemory(join(home, 'dafeiyu-memory.sqlite'));
  try {
    await publishDesktopActivity({ db, home, eventKey: `connect:${event.device_id}:${event.id}`,
      event: { source: 'system', activity: 'phone', phase: 'done', message: '爸爸，有一条白名单微信通知到啦～' } });
  } finally { db.close(); }
}
