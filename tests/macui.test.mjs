import test from 'node:test';
import assert from 'node:assert/strict';
import { QQ_LAYOUT, chatRowPoint, callIconPoint, hangupPoint, findMainWindow, findCallWindow } from '../connect/macui/qq.mjs';

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
