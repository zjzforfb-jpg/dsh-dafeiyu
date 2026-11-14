import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const here = import.meta.dirname;

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Compile the Swift helpers on first use (about 1–2s each). */
export function ensureBinaries(root) {
  const dir = resolve(root, 'runtime/macui/bin');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const targets = [
    ['windows.swift', 'windows'],
    ['click.swift', 'click'],
    ['ocr.swift', 'ocr'],
  ];
  for (const [source, name] of targets) {
    const bin = resolve(dir, name);
    if (!existsSync(bin)) {
      execFileSync('swiftc', ['-O', resolve(here, source), '-o', bin], { stdio: 'inherit' });
      chmodSync(bin, 0o700);
    }
  }
  return {
    windows: resolve(dir, 'windows'),
    click: resolve(dir, 'click'),
    ocr: resolve(dir, 'ocr'),
  };
}

/** Every on-screen window owned by `owner`, with global bounds. */
export function listWindows(bins, owner) {
  const out = execFileSync(bins.windows, [owner], { encoding: 'utf8' });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Bring the app to the front; synthetic clicks only land on a key window. */
export function activate(app) {
  try {
    execFileSync('osascript', ['-e', `tell application "${app}" to activate`], { stdio: 'ignore' });
  } catch {
    // Activation is best effort: the click below still focuses the window.
  }
}

export function click(bins, x, y) {
  execFileSync(bins.click, [String(Math.round(x)), String(Math.round(y))], { stdio: 'ignore' });
}

export async function waitFor(fn, { timeoutMs = 15_000, intervalMs = 400 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - started >= timeoutMs) return null;
    await sleep(intervalMs);
  }
}

