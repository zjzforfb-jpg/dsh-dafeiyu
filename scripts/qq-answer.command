#!/bin/bash
# QQ 呼入自动接听的看护壳：在终端里跑，watcher 退了就 5 秒后重启。
#
# 为什么要有这个壳：CGWindowList 读窗口标题要「屏幕录制」权限、模拟点击要
# 「辅助功能」权限，launchd 直接拉起的 node 这两个都没有；终端.app 通常已经
# 授权，所以由 LaunchAgent 用 `open -a Terminal` 把它交给终端跑。
cd "$(dirname "$0")/.." || exit 1
export PATH="/opt/homebrew/bin:/opt/homebrew/opt/node@24/bin:/usr/local/bin:/usr/bin:/bin"
LOG="$HOME/Library/Logs/DaFeiYu/qq-answer.log"
mkdir -p "$(dirname "$LOG")"
# 同时写日志和终端窗口：日志给 status 看，窗口给现场看。
exec > >(tee -a "$LOG") 2>&1
echo "==== $(date '+%F %T') 看护启动（pid $$）===="
while :; do
  node scripts/qq-answer.mjs
  code=$?
  echo "[看护] watcher 退出（code=$code），5 秒后重启…"
  sleep 5
done
