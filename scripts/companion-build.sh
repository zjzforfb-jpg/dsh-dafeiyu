#!/bin/sh
set -eu
project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-$project_root/runtime/build-tools/sdk}"
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$project_root/runtime/build-tools/gradle-home}"
if [ ! -f "$ANDROID_HOME/platforms/android-35/android.jar" ]; then
  echo '缺少 Android SDK 35；请按 docs/CONNECT_M0.md 配置 ANDROID_HOME。' >&2
  exit 1
fi
if [ -x "$project_root/runtime/build-tools/gradle-8.11.1/bin/gradle" ]; then
  exec "$project_root/runtime/build-tools/gradle-8.11.1/bin/gradle" -p "$project_root/android/DaFeiYuCompanion" assembleDebug --console=plain
fi
cd "$project_root/android/DaFeiYuCompanion"
exec ./gradlew assembleDebug --console=plain
