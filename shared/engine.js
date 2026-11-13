// The rules of the game, and nothing else.
//
// This file has no I/O, no timers and no dependencies. The server runs it to
// decide every transition; the browser runs the same file for one-phone play.
// Every function takes the room state `G` (plain JSON) and mutates it in place.
// Time is always passed in, so a transition can be replayed or retried safely.

export const MIN_PLAYERS = 4;
export const MAX_PLAYERS = 12;
export const TINTS = 8;
export const DISCUSSION = [60, 90, 120, 180];

// Seconds. A room copies these at creation so tests and load tests can shorten them.
export const TIMINGS = Object.freeze({
  reveal: 30, night: 45, vote: 45, verdict: 8,
  graceNight: 1.8, graceVote: 1.5,   // pause after the last player acts
  emptyDay: 6,                       // day length when no human is present
  gone: 20,                          // lobby seat is freed this long after a disconnect
  botMin: 2.5, botMax: 11.5          // bots vote at a random moment in this window
});

const BOT_NAMES = ['Otto', 'Vera', 'Nico', 'Lola', 'Bruno', 'Ines', 'Hugo', 'Zelda', 'Milo', 'Greta', 'Enzo'];
const ID_AB = 'abcdefghjkmnpqrstuvwxyz23456789';

const rnd = n => Math.floor(Math.random() * n);
const pick = a => a[rnd(a.length)];
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const rid = n => Array.from({ length: n }, () => pick(ID_AB)).join('');

export const cleanName = s => (typeof s === 'string' ? s : '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 14);
const cleanTint = a => ((Number(a) | 0) % TINTS + TINTS) % TINTS;

/** How many of each role for n players. M Mafia, D Detective, H Doctor, V Townsperson. */
export function mix(n) {
  const M = n >= 10 ? 3 : n >= 7 ? 2 : 1, D = n >= 4 ? 1 : 0, H = n >= 5 ? 1 : 0;
  return { M, D, H, V: Math.max(0, n - M - D - H) };
}

export function newRoom(code, { local = false, timings } = {}) {
  return {
    code, local, gid: '', ph: 'lobby', rd: 0, dl: 0, du: 0, grace: 0,
    ps: [], st: { disc: 90 }, tm: Object.assign({}, TIMINGS, timings),
    na: {}, vt: {}, rdy: {}, bv: {}, news: null, vd: null, intel: [], lastSave: null, hist: [], win: null, eye: {}, host: null
  };
}

export const player = (G, id) => G.ps.find(p => p.id === id);
/** Everyone dealt into the game: every seat except the referee's. */
export const players = G => G.ps.filter(p => !p.ref);
export const alive = G => G.ps.filter(p => p.al && !p.ref);
export const phaseKey = G => G.gid + G.ph + G.rd;
const present = p => !p.b && !p.off;

/** The player holding host powers right now: the creator, or the first present human if they are away. */
export function hostOf(G) {
  const h = player(G, G.host);
  if (h && present(h)) return h.id;
  const next = G.ps.find(present);
  return next ? next.id : G.host;
}

function uniqueName(G, name, id) {
  let out = name, k = 2;
  while (G.ps.some(p => p.id !== id && p.n === out)) out = name.slice(0, 12) + ' ' + k++;
  return out;
}

// ---------- seats ----------

/**
 * A device arrives (first join or a reconnect). Returns 'in' when the player
 * holds a seat, 'watch' when they can only spectate (game running, or table full).
 */
export function join(G, { id, name, tint, cid }, now) {
  let p = player(G, id);
  if (p) {
    p.off = 0; delete p.gone; if (cid) p.cid = cid;
    if (G.ph === 'lobby') { const n = cleanName(name); if (n) p.n = uniqueName(G, n, id); if (tint !== undefined) p.a = cleanTint(tint); }
    return 'in';
  }
  if (G.ph !== 'lobby' || G.ps.length >= MAX_PLAYERS) return 'watch';
  p = { id, n: uniqueName(G, cleanName(name) || 'Guest', id), a: cleanTint(tint), al: 1, off: 0 };
  if (cid) p.cid = cid;
  G.ps.push(p);
  if (!player(G, G.host) || !G.host) G.host = id;
  return 'in';
}

/** A connection dropped. Ignored when a newer connection (another cid) has taken over. */
export function disconnect(G, id, cid, now) {
  const p = player(G, id);
  if (!p || p.b || (cid && p.cid && p.cid !== cid)) return;
  p.off = 1;
  if (G.ph === 'lobby') p.gone = now;
}

/** The player chose to leave. In the lobby the seat is freed at once. */
export function quit(G, id, now) {
  const p = player(G, id); if (!p) return;
  if (G.ph === 'lobby') { G.ps = G.ps.filter(q => q.id !== id); fixHost(G); }
  else p.off = 1;
}

function fixHost(G) { if (!player(G, G.host)) { const h = G.ps.find(p => !p.b); G.host = h ? h.id : null; } }

// ---------- actions ----------

/**
 * One player action. Returns null on success or a short error code.
 * Every action is idempotent: sending it twice leaves the same state.
 */
export function act(G, id, a, v, now) {
  const p = player(G, id);
  if (!p) return 'not_seated';
  const isHost = hostOf(G) === id;
  switch (a) {
    case 'rename': { if (G.ph !== 'lobby') return 'locked'; const n = cleanName(v); if (!n) return 'bad_name'; p.n = uniqueName(G, n, id); return null; }
    case 'tint': if (G.ph !== 'lobby') return 'locked'; p.a = cleanTint(v); return null;
    case 'addbot': {
      if (!isHost || G.ph !== 'lobby') return 'not_allowed'; if (G.ps.length >= MAX_PLAYERS) return 'full';
      const used = G.ps.map(q => q.n); let bid; do { bid = 'b' + rid(5); } while (player(G, bid));
      G.ps.push({ id: bid, n: uniqueName(G, BOT_NAMES.find(n => !used.includes(n)) || 'Bot', bid), a: rnd(TINTS), al: 1, b: 1 });
      return null;
    }
    case 'rembot': {
      if (!isHost || G.ph !== 'lobby') return 'not_allowed';
      for (let i = G.ps.length - 1; i >= 0; i--) if (G.ps[i].b) { G.ps.splice(i, 1); break; }
      return null;
    }
    case 'referee': {
      // The host names one seated person as referee (or nobody, with an empty value). The referee is
      // dealt no card, sees every card and every night move, and can move the game on.
      if (!isHost || G.ph !== 'lobby') return 'not_allowed';
      if (v) { const q = player(G, v); if (!q || q.b) return 'bad_target'; }
      for (const q of G.ps) { if (q.id === v) q.ref = 1; else delete q.ref; }
      return null;
    }
    case 'advance': {
      if (!p.ref || G.ph === 'lobby' || G.ph === 'end') return 'not_allowed';
      if (G.ph === 'reveal') toNight(G, now);
      else if (G.ph === 'night') resolveNight(G, now);
      else if (G.ph === 'day') toVote(G, now);
      else if (G.ph === 'vote') resolveVote(G, undefined, now);
      else if (G.ph === 'verdict') afterVerdict(G, now);
      return null;
    }
    case 'kick': {
      if (!isHost || G.ph !== 'lobby' || v === id) return 'not_allowed';
      G.ps = G.ps.filter(q => q.id !== v); return null;
    }
    case 'disc': if (!isHost || G.ph !== 'lobby' || !DISCUSSION.includes(v)) return 'not_allowed'; G.st.disc = v; return null;
    case 'start': {
      if (!isHost || G.ph !== 'lobby') return 'not_allowed';
      G.ps = G.ps.filter(q => q.b || !q.off);            // nobody is dealt in while away
      if (players(G).length < MIN_PLAYERS) return 'too_few';
      startGame(G, now); return null;
    }
    case 'ready': if (p.ref) return 'not_allowed'; if (G.ph === 'reveal' || (G.ph === 'day' && p.al)) { G.rdy[id] = 1; return null; } return 'wrong_phase';
    case 'night': return submitNight(G, id, v) ? null : 'bad_target';
    case 'vote': return castVote(G, id, v) ? null : 'bad_target';
    case 'callvote': if (!(isHost || p.ref) || G.ph !== 'day') return 'not_allowed'; toVote(G, now); return null;
    case 'again': {
      if (!isHost || G.ph !== 'end') return 'not_allowed';
      for (const q of G.ps) { q.al = 1; delete q.role; if (q.off) q.gone = now; }
      Object.assign(G, { ph: 'lobby', rd: 0, dl: 0, du: 0, grace: 0, win: null, news: null, vd: null, hist: [], na: {}, vt: {}, rdy: {}, bv: {} });
      return null;
    }
    default: return 'unknown_action';
  }
}

// ---------- phases ----------

function setPhase(G, ph, secs, now) {
  G.ph = ph; G.du = (secs || 0) * 1000;
  G.dl = secs && (!G.local || ph === 'day') ? now + secs * 1000 : 0;
  G.rdy = {}; G.bv = {}; G.grace = 0;
}

export function startGame(G, now) {
  const dealt = players(G), m = mix(dealt.length); let roles = [];
  for (const k in m) for (let i = 0; i < m[k]; i++) roles.push(k);
  roles = shuffle(roles);
  dealt.forEach((p, i) => { p.role = roles[i]; p.al = 1; delete p.gone; });
  for (const p of G.ps) if (p.ref) { delete p.role; p.al = 1; delete p.gone; }
  Object.assign(G, { gid: rid(3), rd: 1, na: {}, vt: {}, news: null, vd: null, intel: [], lastSave: null, hist: [], win: null, eye: {} });
  setPhase(G, 'reveal', G.tm.reveal, now);
}

/** Who this player may pick at night. */
export function targetsFor(G, p) {
  const a = alive(G);
  if (p.role === 'M') return a.filter(q => q.role !== 'M');
  if (p.role === 'H') return a.filter(q => q.id !== G.lastSave);
  return a.filter(q => q.id !== p.id);
}

export function toNight(G, now) {
  G.na = {}; setPhase(G, 'night', G.tm.night, now);
  for (const p of alive(G)) if (p.b) { const t = targetsFor(G, p); if (t.length) G.na[p.id] = pick(t).id; }
}

export function submitNight(G, id, target) {
  const p = player(G, id);
  if (G.ph !== 'night' || !p || !p.al || p.ref) return false;
  if (!targetsFor(G, p).some(q => q.id === target)) return false;
  G.na[id] = target; return true;
}

const topOf = list => {
  const c = {}; list.forEach(t => { c[t] = (c[t] || 0) + 1; });
  const e = Object.entries(c); if (!e.length) return null;
  const mx = Math.max(...e.map(x => x[1]));
  return pick(e.filter(x => x[1] === mx))[0];
};

export function resolveNight(G, now) {
  const a = alive(G), maf = a.filter(p => p.role === 'M');
  // Human Mafia decide; bots only break the silence when no human Mafia chose.
  let picks = maf.filter(p => !p.b && G.na[p.id]).map(p => G.na[p.id]);
  if (!picks.length) picks = maf.filter(p => G.na[p.id]).map(p => G.na[p.id]);
  const target = topOf(picks);
  const doc = a.find(p => p.role === 'H'), det = a.find(p => p.role === 'D');
  const guarded = (doc && G.na[doc.id]) || null, checked = (det && G.na[det.id]) || null;
  if (checked) G.intel.push([checked, player(G, checked).role === 'M' ? 1 : 0]);
  const tally = {};
  for (const p of a) if (p.role === 'V' && G.na[p.id]) {
    const t = G.na[p.id]; tally[t] = (tally[t] || 0) + 1;
    const e = G.eye[p.id] || (G.eye[p.id] = [0, 0]); e[1]++; if (player(G, t).role === 'M') e[0]++;
  }
  const ranked = Object.entries(tally).sort((x, y) => y[1] - x[1]);
  const whispers = ranked.length ? ranked.filter(e => e[1] === ranked[0][1]).slice(0, 2) : null;
  const saved = !!(target && guarded === target), died = target && !saved ? target : null;
  if (died) player(G, died).al = 0;
  G.lastSave = guarded;
  G.news = { k: died, sv: saved ? 1 : 0, w: whispers };
  const rec = { r: G.rd, k: target || null, x: died };
  if (guarded) rec.h = guarded;
  if (checked) { rec.d = checked; rec.dr = player(G, checked).role === 'M' ? 1 : 0; }
  if (whispers) rec.w = whispers;
  G.hist.push(rec);
  if (!checkEnd(G, now)) setPhase(G, 'day', G.st.disc, now);
}

export function toVote(G, now) {
  G.vt = {}; setPhase(G, 'vote', G.tm.vote, now);
  if (!G.local) for (const p of alive(G)) if (p.b) G.bv[p.id] = Math.round(now + (G.tm.botMin + Math.random() * (G.tm.botMax - G.tm.botMin)) * 1000);
}

export function castVote(G, id, target) {
  const p = player(G, id);
  if (G.ph !== 'vote' || !p || !p.al || p.ref) return false;
  if (target !== 'skip') { const q = player(G, target); if (!q || !q.al || q.ref || target === id) return false; }
  G.vt[id] = target; return true;
}

/** `forced` is the table's spoken verdict in one-phone play: a player id, or null for nobody. */
export function resolveVote(G, forced, now) {
  let out = null, tie = false; const tally = {};
  if (forced !== undefined) out = forced;
  else {
    let skip = 0;
    for (const v in G.vt) { const p = player(G, v); if (!p || !p.al) continue; const t = G.vt[v]; if (t === 'skip') skip++; else tally[t] = (tally[t] || 0) + 1; }
    const e = Object.entries(tally).sort((x, y) => y[1] - x[1]);
    if (e.length) { if (e.length > 1 && e[1][1] === e[0][1]) tie = true; else if (e[0][1] >= skip) out = e[0][0]; }
  }
  if (out) player(G, out).al = 0;
  G.vd = { out, tie: tie ? 1 : 0, t: tally };
  const rec = G.hist[G.hist.length - 1]; if (rec) { rec.o = out; rec.tie = tie ? 1 : 0; }
  setPhase(G, 'verdict', G.tm.verdict, now);
}

export function afterVerdict(G, now) { if (!checkEnd(G, now)) { G.rd++; toNight(G, now); } }

function checkEnd(G, now) {
  const a = alive(G), m = a.filter(p => p.role === 'M').length, t = a.length - m;
  const w = m === 0 ? 'T' : m >= t ? 'M' : null;
  if (w) { G.win = w; setPhase(G, 'end', 0, now); return true; }
  return false;
}

function award(G) {
  let best = null;
  for (const id in G.eye) { const e = G.eye[id]; if (e[0] > 0 && (!best || e[0] > best[1])) best = [id, e[0], e[1]]; }
  return best;
}

function botVote(G, p) {
  const a = alive(G).filter(q => q.id !== p.id), pool = p.role === 'M' ? a.filter(q => q.role !== 'M') : a;
  if (!pool.length) return 'skip';
  const tally = {}; for (const v in G.vt) if (G.vt[v] !== 'skip') tally[G.vt[v]] = (tally[G.vt[v]] || 0) + 1;
  const lead = Object.entries(tally).sort((x, y) => y[1] - x[1])[0];
  const whisper = G.news && G.news.w && G.news.w[0] && G.news.w[0][0];
  if (lead && pool.some(q => q.id === lead[0]) && Math.random() < 0.4) return lead[0];
  if (whisper && pool.some(q => q.id === whisper) && Math.random() < 0.5) return whisper;
  if (Math.random() < 0.08) return 'skip';
  return pick(pool).id;
}

// ---------- time ----------

function stepOnce(G, now) {
  if (G.local || G.ph === 'end') return false;
  if (G.ph === 'lobby') {
    const n = G.ps.length;
    G.ps = G.ps.filter(p => !(p.gone && now - p.gone >= G.tm.gone * 1000));
    if (G.ps.length === n) return false;
    fixHost(G); return true;
  }
  const waitFor = alive(G).filter(p => p.b || !p.off);
  if (G.ph === 'reveal') {
    const hs = players(G).filter(present);
    if ((hs.length && hs.every(p => G.rdy[p.id])) || now >= G.dl) { toNight(G, now); return true; }
    return false;
  }
  if (G.ph === 'night') {
    if ((G.grace && now >= G.grace) || now >= G.dl) { resolveNight(G, now); return true; }
    if (!G.grace && waitFor.every(p => G.na[p.id] || !targetsFor(G, p).length)) { G.grace = Math.round(now + G.tm.graceNight * 1000); return true; }
    return false;
  }
  if (G.ph === 'day') {
    const hs = alive(G).filter(present);
    const go = hs.length ? hs.every(p => G.rdy[p.id]) : now >= G.dl - G.du + G.tm.emptyDay * 1000;
    if (go || now >= G.dl) { toVote(G, now); return true; }
    return false;
  }
  if (G.ph === 'vote') {
    let changed = false;
    for (const id of Object.keys(G.bv)) if (now >= G.bv[id]) {
      const p = player(G, id); delete G.bv[id]; changed = true;
      if (p && p.al && !G.vt[id]) castVote(G, id, botVote(G, p));
    }
    if ((G.grace && now >= G.grace) || now >= G.dl) { resolveVote(G, undefined, now); return true; }
    if (!G.grace && waitFor.every(p => G.vt[p.id])) { G.grace = Math.round(now + G.tm.graceVote * 1000); return true; }
    return changed;
  }
  if (G.ph === 'verdict') { if (now >= G.dl) { afterVerdict(G, now); return true; } return false; }
  return false;
}

/** Apply everything that is due at `now`. Returns true when the state changed. */
export function tick(G, now) {
  let changed = false;
  for (let i = 0; i < 16 && stepOnce(G, now); i++) changed = true;
  return changed;
}

/** The next moment (ms) at which tick() will have work to do, or null. */
export function nextDeadline(G) {
  if (G.local || G.ph === 'end') return null;
  if (G.ph === 'lobby') { const g = G.ps.filter(p => p.gone).map(p => p.gone + G.tm.gone * 1000); return g.length ? Math.min(...g) : null; }
  let d = G.dl || null;
  const add = t => { if (t && (d === null || t < d)) d = t; };
  add(G.grace);
  if (G.ph === 'vote') for (const id in G.bv) add(G.bv[id]);
  if (G.ph === 'day' && !alive(G).some(present)) add(G.dl - G.du + G.tm.emptyDay * 1000);
  return d;
}

// ---------- views: what each screen is allowed to know ----------

/** Everything every player may see. Roles appear only for the dead, and for all once the game ends. */
export function pubOf(G) {
  const end = G.ph === 'end';
  const o = {
    c: G.code, ph: G.ph, rd: G.rd, gid: G.gid, dl: G.dl, du: G.du, st: G.st, host: hostOf(G), lo: G.local ? 1 : 0,
    rc: Object.keys(G.rdy).length,
    ac: G.ph === 'night' ? alive(G).filter(p => G.na[p.id]).length : 0,
    ps: G.ps.map(p => {
      const q = { i: p.id, n: p.n, a: p.a, al: p.al ? 1 : 0 };
      if (p.b) q.b = 1; if (p.off) q.off = 1; if (p.ref) q.ref = 1;
      if (G.ph !== 'lobby' && (end || !p.al)) q.rl = p.role;
      return q;
    })
  };
  if (G.ph === 'day' || G.ph === 'vote') o.news = G.news;
  if (G.ph === 'vote' || G.ph === 'verdict') o.vt = G.vt;
  if (G.ph === 'verdict') o.vd = G.vd;
  if (end) { o.win = G.win; o.hist = G.hist; o.aw = award(G); }
  return o;
}

/** What only this player may see: their role, partners, case notes; every card once they are a ghost. */
export function privOf(G, id) {
  const p = player(G, id);
  if (!p || G.ph === 'lobby') return {};
  // One letter per seat, in seat order: M, D, H, V, or R for the referee.
  const cards = () => G.ps.map(q => q.ref ? 'R' : (q.role || '-')).join('');
  if (p.ref) {
    // The referee sees the whole table: every card, every night move as it is made, every case note.
    const o = { ref: 1, all: cards(), in: G.intel };
    if (G.lastSave) o.ls = G.lastSave;
    if (G.ph === 'night') o.na = { ...G.na };
    return o;
  }
  if (!p.role) return {};
  const o = { rl: p.role };
  if (p.role === 'M') {
    o.mt = G.ps.filter(q => q.role === 'M' && q.id !== id).map(q => q.id);
    if (G.ph === 'night') { o.mp = {}; for (const q of G.ps) if (q.role === 'M' && q.id !== id && q.al && !q.b && G.na[q.id]) o.mp[q.id] = G.na[q.id]; }
  }
  if (p.role === 'D') o.in = G.intel;
  if (p.role === 'H' && G.lastSave) o.ls = G.lastSave;
  if (G.ph === 'night' && G.na[id]) o.my = G.na[id];
  if (G.rdy[id]) o.r = 1;
  if (!p.al) o.all = cards();
  return o;
}
