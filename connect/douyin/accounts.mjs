import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function loadAccounts(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { accounts: [] };
  }
}

export function saveAccounts(file, data) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/** Merge discovered authors into the benchmark list (keep first-seen, refresh latest work). */
export function upsertAccounts(data, cards, topic, now = Date.now()) {
  const accounts = data.accounts ?? [];
  for (const card of cards) {
    if (!card.author) continue;
    const existing = accounts.find((item) => item.name === card.author);
    if (existing) {
      existing.topics = Array.from(new Set([...(existing.topics ?? []), topic]));
      existing.lastWork = card.title;
      existing.lastSeenAt = now;
      existing.lastLikes = card.likes;
    } else {
      accounts.push({
        name: card.author,
        topics: [topic],
        lastWork: card.title,
        lastLikes: card.likes,
        firstSeenAt: now,
        lastSeenAt: now,
      });
    }
  }
  return { ...data, accounts };
}
