// The room service: how a server changes a room and how every player hears about it.
//
// A server never owns a room. It reads the row, applies the rules, and writes back only
// if nobody else wrote first (compare-and-set). The loser re-reads and tries again, so
// any number of servers can act on the same room and exactly one order of events wins.
import { randomInt } from 'node:crypto';
import { newRoom, tick, nextDeadline, pubOf, privOf, player } from '../shared/engine.js';

const CODE_AB = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no I, L, O, 0, 1
export const CODE_RE = /^[A-HJKMNP-Z2-9]{5}$/;
const genCode = () => Array.from({ length: 5 }, () => CODE_AB[randomInt(CODE_AB.length)]).join('');

const SWEEP_MS = 250, LEASE_MS = 3000, RESYNC_MS = 5000, GC_MS = 60000;
const LIVE_TTL = 2 * 3600e3, IDLE_TTL = 10 * 60e3, MAX_ATTEMPTS = 16;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const stateMsg = (v, G, pubJson, pid) => `{"t":"state","v":${v},"now":${Date.now()},"pub":${pubJson},"priv":${JSON.stringify(pid ? privOf(G, pid) : {})}}`;

export class Rooms {
  constructor({ store, bus, metrics, timings, log = () => {} }) {
    Object.assign(this, { store, bus, metrics, timings, log });
    this.local = new Map();    // code -> { v, G, socks } for rooms with players connected to this server
    this.chains = new Map();   // code -> tail of this server's queue of changes to that room
    this.timers = [];
    bus.onMessage = (code, v, G) => this.deliver(code, v, G);
  }

  start() {
    const loop = (ms, fn, name) => {
      let busy = false;
      const t = setInterval(async () => {
        if (busy) return; busy = true;
        try { await fn(); } catch (e) { this.metrics.inc('loop_errors'); this.log('error', name + ' failed', { error: String(e && e.message || e) }); }
        busy = false;
      }, ms);
      this.timers.push(t);
    };
    loop(SWEEP_MS, () => this.sweep(), 'sweep');
    loop(RESYNC_MS, () => this.resync(), 'resync');
    loop(GC_MS, () => this.store.gc(), 'gc');
  }
  stop() { this.timers.forEach(clearInterval); this.timers = []; }

  expiry(G, now) { return now + (G.ps.some(p => !p.b && !p.off) ? LIVE_TTL : IDLE_TTL); }

  /** Reserve a fresh code and store an empty lobby. */
  async create() {
    for (let i = 0; i < 10; i++) {
      const code = genCode(), now = Date.now();
      if (await this.store.create(code, JSON.stringify(newRoom(code, { timings: this.timings })), null, now + IDLE_TTL)) {
        this.metrics.inc('rooms_created'); return code;
      }
    }
    throw new Error('could not allocate a room code');
  }

  /**
   * Change a room. `fn(G, now)` mutates a private copy and may return `{ err }` to abort.
   * Changes to one room from this server run one after another; changes from other servers
   * are caught by the version check and retried on fresh state.
   */
  mutate(code, fn, opts = {}) {
    const prev = this.chains.get(code) || Promise.resolve();
    const run = prev.then(() => this.#mutate(code, fn, opts));
    const tail = run.catch(() => {});
    this.chains.set(code, tail);
    tail.then(() => { if (this.chains.get(code) === tail) this.chains.delete(code); });
    return run;
  }

  async #mutate(code, fn, opts) {
    const t0 = performance.now();
    let base = opts.base || null, leased = !!opts.leased;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      let cached = false;
      if (!base) {
        const r = this.local.get(code);
        if (attempt === 0 && r && r.G) { base = { v: r.v, G: r.G }; cached = true; }
        else base = await this.store.load(code);
      }
      if (!base) return { err: 'no_room' };
      const G = structuredClone(base.G), now = Math.max(Date.now(), opts.now || 0);
      let out;
      try {
        out = fn ? fn(G, now) : null;
        if (out && out.err) {
          if (cached) { base = null; continue; }   // never refuse on a possibly stale copy
          return out;
        }
        tick(G, now);
      } catch (e) { e.rules = true; throw e; }     // the rules threw: this state is damaged, not the database
      const json = JSON.stringify(G);
      if (json === JSON.stringify(base.G)) {
        if (leased) await this.store.release(code, base.v, nextDeadline(G));
        this.deliver(code, base.v, base.G);
        return { v: base.v, G: base.G };
      }
      const archive = base.G.ph !== 'end' && G.ph === 'end'
        ? { winner: G.win, rounds: G.rd, players: G.ps.map(p => ({ n: p.n, role: p.role, al: p.al ? 1 : 0, b: p.b ? 1 : 0 })), history: G.hist }
        : null;
      if (await this.store.save(code, base.v, json, nextDeadline(G), this.expiry(G, now), archive)) {
        const v = base.v + 1;
        this.metrics.inc('transitions'); this.metrics.observe('transition', performance.now() - t0);
        this.deliver(code, v, G);
        this.bus.publish(code, v, json).catch(() => this.metrics.inc('bus_publish_errors'));
        return { v, G };
      }
      this.metrics.inc('cas_conflicts');
      base = null; leased = false;
      // Another server wrote first. Wait a random moment so colliding servers fall out of step, then retry on fresh state.
      await sleep(Math.random() * Math.min(4 * 2 ** attempt, 100));
    }
    this.metrics.inc('transitions_abandoned');
    return { err: 'busy' };
  }

  // ---------- sockets on this server ----------

  async attach(session, code) {
    let r = this.local.get(code);
    if (!r) { r = { v: 0, G: null, socks: new Set() }; this.local.set(code, r); }
    r.socks.add(session);
    if (r.socks.size === 1) await this.bus.subscribe(code);
  }

  detach(session, code = session.code) {
    const r = this.local.get(code); if (!r) return;
    r.socks.delete(session);
    if (!r.socks.size) { this.local.delete(code); this.bus.unsubscribe(code).catch(() => {}); }
  }

  /** The cached copy of a player, for cheap checks that need no database read. */
  peek(code, pid) { const r = this.local.get(code); return r && r.G ? player(r.G, pid) : null; }

  /** Send one session the latest state this server knows. */
  push(session) {
    const r = this.local.get(session.code);
    if (r && r.G) session.sendRaw(stateMsg(r.v, r.G, JSON.stringify(pubOf(r.G)), session.pid));
  }

  /** A newer committed state arrived (from this server or the bus): cache it and tell local players. */
  deliver(code, v, G) {
    const r = this.local.get(code);
    if (!r || v <= r.v) return;
    r.v = v; r.G = G;
    if (!r.socks.size) return;
    const pubJson = JSON.stringify(pubOf(G));
    for (const s of r.socks) if (s.live) s.sendRaw(stateMsg(v, G, pubJson, s.pid));
  }

  // ---------- background loops ----------

  /** Run timers: phase deadlines, bot votes, freeing abandoned lobby seats. Safe to run on every server at once. */
  async sweep() {
    const due = await this.store.leaseDue(200, LEASE_MS);
    if (!due.length) return;
    this.metrics.inc('sweeper_leased', due.length);
    await Promise.all(due.map(d => this.mutate(d.code, null, { base: { v: d.v, G: d.G }, now: d.now, leased: true }).catch(async e => {
      this.metrics.inc('timer_errors');
      this.log('error', 'timer failed', { code: d.code, error: String(e && e.message || e) });
      // A store error is retried when the lease runs out. A damaged room is parked so it cannot spin forever.
      if (e && e.rules) await this.store.release(d.code, d.v, null).catch(() => {});
    })));
  }

  /** Repair anything the bus dropped by comparing versions with the store. */
  async resync() {
    const codes = [...this.local.keys()];
    for (let i = 0; i < codes.length; i += 500) {
      const chunk = codes.slice(i, i + 500), versions = await this.store.versions(chunk);
      for (const code of chunk) {
        const r = this.local.get(code); if (!r) continue;
        const v = versions.get(code);
        if (v === undefined) { if (r.G) this.closeRoom(code); continue; }
        if (v > r.v) { this.metrics.inc('resync_repairs'); const cur = await this.store.load(code); if (cur) this.deliver(code, cur.v, cur.G); }
      }
    }
  }

  closeRoom(code) {
    const r = this.local.get(code); if (!r) return;
    for (const s of [...r.socks]) { s.sendRaw('{"t":"err","e":"room_closed"}'); s.code = null; s.live = false; this.detach(s, code); }
  }
}
