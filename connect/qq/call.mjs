const KEY = (kind, id) => `${kind}:${id}`;

export class CallSessions {
  constructor({ timeoutMs = 60000, now = () => Date.now(), maxTurns = 30 } = {}) {
    Object.assign(this, { timeoutMs, now, maxTurns });
    this.sessions = new Map();
  }

  start(kind, id) {
    const key = KEY(kind, id);
    const session = { key, kind, id, startedMs: this.now(), lastMs: this.now(), turns: 0 };
    this.sessions.set(key, session);
    return { ...session, started: true };
  }

  active(kind, id) {
    const session = this.sessions.get(KEY(kind, id));
    if (!session) return null;
    if (this.now() - session.lastMs > this.timeoutMs || session.turns >= this.maxTurns) { this.sessions.delete(session.key); return null; }
    return session;
  }

  touch(kind, id) {
    const session = this.active(kind, id);
    if (!session) return null;
    session.lastMs = this.now();
    session.turns += 1;
    return session;
  }

  end(kind, id) {
    return this.sessions.delete(KEY(kind, id));
  }

  sweep() {
    const expired = [];
    for (const session of this.sessions.values()) {
      if (this.now() - session.lastMs > this.timeoutMs || session.turns >= this.maxTurns) expired.push({ kind: session.kind, id: session.id });
    }
    for (const { kind, id } of expired) this.sessions.delete(KEY(kind, id));
    return expired;
  }

  list() {
    return [...this.sessions.values()].map(s => ({ kind: s.kind, id: s.id, startedMs: s.startedMs, lastMs: s.lastMs, turns: s.turns, remainingMs: Math.max(0, this.timeoutMs - (this.now() - s.lastMs)) }));
  }
}
