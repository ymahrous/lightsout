// In-process store with the same contract as the Postgres store.
// For development and tests: nothing survives a restart, and nodes cannot share it across processes.
export class MemoryStore {
  constructor() { this.rooms = new Map(); this.games = []; }
  async init() {}
  async ping() {}
  async close() {}

  /** Insert a new room at version 1. False when the code is taken. */
  async create(code, json, deadline, expires) {
    if (this.rooms.has(code)) return false;
    this.rooms.set(code, { v: 1, s: json, deadline, expires });
    return true;
  }

  async load(code) {
    const r = this.rooms.get(code);
    return r ? { v: r.v, G: JSON.parse(r.s) } : null;
  }

  /** Compare-and-set: write only if the room is still at version `v`. */
  async save(code, v, json, deadline, expires, archive) {
    const r = this.rooms.get(code);
    if (!r || r.v !== v) return false;
    r.v = v + 1; r.s = json; r.deadline = deadline; r.expires = expires;
    if (archive) this.games.push(archive);
    return true;
  }

  /** Claim rooms whose deadline has passed, hiding them from other sweepers for `leaseMs`. */
  async leaseDue(limit, leaseMs) {
    const now = Date.now(), out = [];
    for (const [code, r] of this.rooms) {
      if (r.deadline === null || r.deadline === undefined || r.deadline > now) continue;
      r.deadline = now + leaseMs;
      out.push({ code, v: r.v, G: JSON.parse(r.s), now });
      if (out.length >= limit) break;
    }
    return out;
  }

  async release(code, v, deadline) { const r = this.rooms.get(code); if (r && r.v === v) r.deadline = deadline; }

  async versions(codes) {
    const m = new Map();
    for (const c of codes) { const r = this.rooms.get(c); if (r) m.set(c, r.v); }
    return m;
  }

  async gc() {
    const now = Date.now(); let n = 0;
    for (const [code, r] of this.rooms) if (r.expires < now) { this.rooms.delete(code); n++; }
    return n;
  }
}
