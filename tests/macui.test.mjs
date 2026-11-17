import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QQ_LAYOUT,
  acceptPoint,
  callIconPoint,
  classifyCallText,
  chatRowPoint,
  findCallWindow,
  findMainWindow,
  hangupPoint,
} from '../connect/macui/qq.mjs';

test('QQ chat rows map to stable global points', () => {
  const bounds = { x: 1541, y: 219 };
  assert.deepEqual(chatRowPoint(bounds, 0), { x: 1661, y: 347 });
  assert.deepEqual(chatRowPoint(bounds, 1), { x: 1661, y: 405 });
});

test('QQ call and hangup points follow the window origin', () => {
  const bounds = { x: 1541, y: 219 };
  assert.deepEqual(callIconPoint(bounds), { x: 2279, y: 284 });
  assert.deepEqual(hangupPoint({ x: 1946, y: 284 }), { x: 2241, y: 779 });
});

test('incoming call accept button sits on the left of the call window', () => {
  assert.deepEqual(acceptPoint({ x: 1946, y: 284 }), { x: 2056, y: 779 });
});

test('window lookup separates the main window from a call window', () => {
  const windows = [
    { id: 7295, name: 'QQ', x: 0, y: 0, width: 960, height: 949 },
    { id: 7386, name: '语音通话', x: 1946, y: 284, width: 360, height: 640 },
  ];
  assert.equal(findMainWindow(windows)?.id, 7295);
  assert.equal(findCallWindow(windows)?.id, 7386);
  assert.equal(findCallWindow([windows[0]]), null);
});

test('call window matcher accepts video calls too', () => {
  assert.match('视频通话', QQ_LAYOUT.callWindow);
  assert.doesNotMatch('大肥鱼小可爱', QQ_LAYOUT.callWindow);
});

test('读不到窗口标题时按尺寸兜底识别来电窗口', () => {
  // launchd 拉起的进程缺屏幕录制权限：所有窗口 name 都是空串。
  const blind = [
    { id: 15470, name: '', x: 1034, y: 316, width: 960, height: 949 },
    { id: 16001, name: '', x: 1946, y: 284, width: 360, height: 640 },
  ];
  assert.equal(findCallWindow(blind)?.id, 16001);
  // 只有主窗口时不能误判。
  assert.equal(findCallWindow([blind[0]]), null);
  // 有标题权限时不做尺寸兜底，避免把小面板当来电。
  const namedPanel = [
    { id: 1, name: 'QQ', x: 0, y: 0, width: 960, height: 949 },
    { id: 2, name: '表情', x: 10, y: 10, width: 320, height: 420 },
  ];
  assert.equal(findCallWindow(namedPanel), null);
});

test('通话结局能分清楚：拨出没接通 / 已接通 / 被拒接，不再一律算「结束了」', () => {
  // 响铃态：只有「接听/挂断」和邀请语。
  assert.equal(classifyCallText('七海 邀请你语音通话 接听 挂断'), 'ringing');
  assert.equal(classifyCallText('正在等待对方接听 取消'), 'ringing');
  // 接通态：窗口里出现通话计时。
  assert.equal(classifyCallText('七海 00:07 挂断 静音'), 'connected');
  assert.equal(classifyCallText('1:23:45 挂断'), 'connected');
  // 被拒 / 取消。
  assert.equal(classifyCallText('对方已拒绝 通话结束'), 'rejected');
  assert.equal(classifyCallText('通话已取消'), 'cancelled');
  // 读不到文字时不瞎猜。
  assert.equal(classifyCallText(''), 'unknown');
  assert.equal(classifyCallText('   '), 'unknown');
});
