import { spawn } from 'node:child_process';

// 微信 / QQ 的通话窗口标题（macOS 版）：语音聊天、视频聊天、语音通话、视频通话
export const CALL_WINDOW = /语音聊天|视频聊天|语音通话|视频通话/;

export function parseWindowLine(line) {
  return String(line)
    .split('|')
    .map((title) => title.trim())
    .filter(Boolean);
}

export function callActive(titles) {
  return titles.some((title) => CALL_WINDOW.test(title));
}

/**
 * 起 callwatch 子进程，每秒收一行窗口标题。
 * 在「通话开始 / 通话结束」时各回调一次（状态去抖）。
 */
export function watchCalls({ bin, log = () => {}, onStart, onEnd }) {
  const child = spawn(bin, [], { stdio: ['ignore', 'pipe', 'inherit'] });
  let active = false;
  let buffer = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const now = callActive(parseWindowLine(line));
      if (now === active) continue;
      active = now;
      if (now) {
        log('检测到通话窗口，进入通话模式');
        onStart?.();
      } else {
        log('通话窗口消失，退出通话模式');
        onEnd?.();
      }
    }
  });

  child.on('exit', (code) => log(`callwatch 退出（${code ?? 0}）`));

  return {
    get active() {
      return active;
    },
    stop() {
      child.kill('SIGTERM');
    },
  };
}

/** 主动呼叫用的 AppleScript：打开微信 → 搜索联系人 → 点「语音通话」。 */
export function dialWechatScript(contact) {
  const escape = (value) => String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return `
tell application "微信" to activate
delay 0.6
tell application "System Events"
  tell process "微信"
    keystroke "f" using command down
    delay 0.4
    keystroke "${escape(contact)}"
    delay 1.2
    key code 36
    delay 0.8
  end tell
end tell
`;
}
