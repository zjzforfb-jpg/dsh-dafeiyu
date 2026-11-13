import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const LABEL = 'com.dafeiyu.pet';

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

export function nodeForService(currentPath, executablePath) {
  if (currentPath && existsSync(currentPath) && basename(currentPath) === 'node') return currentPath;
  return executablePath;
}

export function launchAgentPlist({ root, nodePath, username, logDir }) {
  const safeRoot = xml(root);
  const safeNode = xml(nodePath);
  const safeUser = xml(username);
  const safePath = xml(`${dirname(nodePath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${safeNode}</string><string>${safeRoot}/scripts/run-pet.mjs</string></array>
  <key>WorkingDirectory</key><string>${safeRoot}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>EnvironmentVariables</key><dict>
    <key>USER</key><string>${safeUser}</string>
    <key>PATH</key><string>${safePath}</string>
  </dict>
  <key>StandardOutPath</key><string>${xml(join(logDir, 'pet.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logDir, 'pet-error.log'))}</string>
</dict></plist>
`;
}
