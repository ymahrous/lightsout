// Lights Out Mafia: the browser client.
//
// Online, this file only draws what the server sends and reports what the player taps.
// In one-phone mode there is no server: the same rules engine runs right here.
import * as E from '/shared/engine.js';
import { createScene } from './scene.js';
import { createSound } from './sound.js';
import { createNet } from './net.js';
import { createInstall } from './install.js';

/* ---------- utilities ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const now = () => Date.now();
const rnd = n => Math.floor(Math.random() * n);
const pick = a => a[rnd(a.length)];
const area = f => { try { return f(); } catch (e) { return null; } };
const SS = area(() => window.sessionStorage), LS = area(() => window.localStorage);
// Storage can be missing or throw (private windows, blocked site data), so every access is guarded.
const store = {
  get(k, a = SS) { try { return JSON.parse(a.getItem('lom.' + k)); } catch (e) { return null; } },
  set(k, v, a = SS) { try { v == null ? a.removeItem('lom.' + k) : a.setItem('lom.' + k, JSON.stringify(v)); } catch (e) {} }
};
const fmt = ms => { const s = Math.ceil(Math.max(0, ms) / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const newToken = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
const mix = E.mix;
const mixText = m => ['M', 'D', 'H', 'V'].filter(k => m[k]).map(k => m[k] + ' ' + (m[k] > 1 ? ROLE[k].plural : ROLE[k].name)).join(', ');
const keyOf = p => p.gid + p.ph + p.rd;

const TINTS = ['#d9b36a', '#d98a8a', '#6fb5a8', '#8fa8d8', '#b59ad8', '#e0946a', '#a8bf7a', '#e5dcc8'];
const TINT_NAMES = ['Brass', 'Rose', 'Verdigris', 'Moonlight', 'Lilac', 'Ember', 'Sage', 'Bone'];
const ALIASES = ['Lamplighter', 'Night Owl', 'Locksmith', 'Baker', 'Tailor', 'Florist', 'Barber', 'Cabbie', 'Pianist', 'Bookbinder', 'Milkman', 'Clockmaker', 'Grocer', 'Postman', 'Glazier', 'Chimney Sweep'];
const ROLE = {
  M: { name: 'Mafia', plural: 'Mafia', blurb: 'Each night, choose a window to put out. By day, look innocent.', verb: 'Choose who goes dark', night: 'The town wakes to one less light. If partners disagree, the most picked name goes.' },
  D: { name: 'Detective', plural: 'Detective', blurb: 'Each night, check one player. At dawn you learn if they are Mafia.', verb: 'Choose someone to investigate', night: 'At dawn you learn whether they are Mafia. Only you see the answer.' },
  H: { name: 'Doctor', plural: 'Doctor', blurb: 'Each night, guard one player. If the Mafia picks them, they live.', verb: 'Choose someone to guard', night: 'If the Mafia comes for them tonight, they live. You cannot guard the same person two nights running.' },
  V: { name: 'Townsperson', plural: 'Townspeople', blurb: 'No night power, but your whisper counts. Each night, name who you suspect.', verb: 'Whisper who you suspect', night: 'The town hears the count at dawn. It also hides who is really at work tonight.' },
  R: { name: 'Referee', plural: 'Referee', blurb: 'You run the game and play no side. You see every card and every night move. Keep a straight face and move things on.' }
};
const art = r => ({ M: 'Mafia', D: 'the Detective', H: 'the Doctor', V: 'a Townsperson' }[r] || 'unknown');
const sv = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const RICON = {
  M: sv('<path d="M12 2.5l2.4 10h-4.8z"/><path d="M7.5 12.5h9M12 12.5V19M10 21.5h4"/>'),
  D: sv('<path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/>'),
  H: sv('<path d="M9.5 3h5v6.5H21v5h-6.5V21h-5v-6.5H3v-5h6.5z"/>'),
  V: sv('<path d="M4 11l8-7 8 7v9H4z"/><path d="M10 20v-5h4v5"/>'),
  R: sv('<path d="M7 3h10M12 3v4"/><rect x="5" y="7" width="14" height="14" rx="2"/><path d="M9 12h6M9 16h4"/>')
};
const ICON = {
  on: sv('<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M15.5 9a4 4 0 010 6M18 6.5a7.5 7.5 0 010 11"/>'),
  off: sv('<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>'),
  speak: sv('<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M15.5 9a4 4 0 010 6"/>'),
  share: sv('<path d="M12 3v12M7.5 7.5L12 3l4.5 4.5"/><path d="M6 11H5v10h14V11h-1"/>'),
  plus: sv('<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8.5v7M8.5 12h7"/>'),
  install: sv('<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5"/><path d="M5 19h14"/>')
};

/* ---------- state ---------- */
const savedTable = store.get('table', LS) || {};
const S = {
  screen: 'home', name: store.get('name', LS) || '', alias: store.get('alias') || '', tint: store.get('tint', LS), sound: store.get('sound', LS) !== false,
  // The token is this tab's secret seat ticket. The server derives the public player id from it.
  token: store.get('tok') || newToken(), me: null, code: '', codeIn: '', err: '', busy: false, restoring: false, link: 'idle', linkSince: 0,
  sel: null, editing: false, sealed: null, myVote: null, ready: null, peek: false, notes: false, confirmLeave: false, sheet: null,
  // One-phone table, remembered between games on this device.
  localNames: Array.isArray(savedTable.names) && savedTable.names.length >= E.MIN_PLAYERS ? savedTable.names.slice(0, E.MAX_PLAYERS) : ['', '', '', '', ''],
  localDisc: E.DISCUSSION.includes(savedTable.disc) ? savedTable.disc : 90,
  localMode: savedTable.mode === 'ref' ? 'ref' : 'pass',
  voice: !!savedTable.voice, loc: null, tally: {}, resume: null
};
if (typeof S.tint !== 'number') S.tint = rnd(TINTS.length);
store.set('tok', S.token);
let G = null;                               // one-phone game: the whole table lives in this browser
const V = { pub: null, priv: {}, dl: 0 };   // online game: what the server last told this player
let Scene = { mood() {}, windows() {}, pulse() {}, demo() {} };
const Snd = createSound(() => S.sound);
const install = createInstall(() => render(), () => S.screen === 'home' && !S.busy && !S.sheet);
const myName = () => {
  if (S.name.trim()) return S.name.trim().slice(0, 14);
  if (!S.alias) { S.alias = pick(ALIASES); store.set('alias', S.alias); }
  return S.alias;
};
const saveTable = () => store.set('table', { names: S.localNames, disc: S.localDisc, mode: S.localMode, voice: S.voice }, LS);

/* ---------- online play ---------- */
const setHash = code => { try { if (code) location.hash = 'room-' + code.toLowerCase(); else if (location.hash) history.replaceState(null, '', location.pathname); } catch (e) {} };
const net = createNet({
  onJoined(m) {
    // The server may hand a fresh tab the seat this browser held before. Keep that seat's token from now on.
    if (m.adopted) { const prev = store.get('prev', LS); if (prev && prev.token) { S.token = prev.token; store.set('tok', S.token); net.setProfile({ token: S.token, prev: undefined }); } }
    S.me = m.id; S.code = m.code; S.busy = false; S.restoring = false; S.err = ''; S.screen = 'room';
    store.set('sess', { code: m.code }); store.set('prev', { code: m.code, token: S.token }, LS);
    setHash(m.code); render();
  },
  onState(m) {
    V.pub = m.pub; V.priv = m.priv || {};
    V.dl = m.pub.dl ? now() + (m.pub.dl - m.now) : 0;   // deadlines arrive on the server's clock; convert to ours
    render();
  },
  onError(e, m) {
    if (e === 'no_room' || e === 'room_closed' || e === 'bad_token') {
      const quiet = S.restoring, code = S.code || S.codeIn;
      goHome();
      if (e === 'room_closed') toast('That room has closed.');
      else if (!quiet) S.err = `No open room with code ${code}. Check it with your host.`;
      return render();
    }
    if (e === 'slow_down') {
      if (S.busy) { goHome(); S.err = 'Too many rooms opened from this connection. Wait a minute and try again.'; render(); }
      else toast('Slow down a little.');
      return;
    }
    if (e === 'unavailable' || e === 'busy') toast('The server is busy. Try that again.');
    if (e === 'too_few') toast('Mafia needs at least 4 players, not counting the referee.');
    if (m.a) { S.sealed = null; S.myVote = null; S.ready = null; render(); }   // the move was refused: forget the optimistic copy
  },
  onStatus(st) {
    S.link = st; S.linkSince = now();
    if (st === 'retrying') { setTimeout(render, 2100); if (S.busy) S.err = navigator.onLine === false ? 'You are offline. One-phone play still works.' : 'Cannot reach the game server. Still trying.'; }
    render();
  }
});
const profile = () => ({ token: S.token, name: myName(), tint: S.tint });
function createRoom() { S.busy = true; S.restoring = false; S.err = ''; net.create(profile()); }
function joinRoom(code, quiet) {
  S.busy = true; S.restoring = !!quiet; S.err = ''; S.code = code;
  const prev = store.get('prev', LS);
  net.join(code, { ...profile(), prev: prev && prev.code === code && prev.token !== S.token ? prev.token : undefined });
}
function goHome() {
  net.leave(false); store.set('sess', null);
  V.pub = null; V.priv = {}; V.dl = 0;
  Object.assign(S, { screen: 'home', code: '', me: null, busy: false, restoring: false });
  setHash('');
}
function leaveRoom() {
  if (G) { G = null; S.loc = null; store.set('L', null, LS); S.resume = null; S.screen = 'home'; }
  else { net.leave(true); goHome(); }
}
// Show the move at once, then let the server's answer confirm or correct it.
function sendAction(kind, t) {
  const c = ctx(); if (!c.pub) return;
  const key = keyOf(c.pub);
  if (kind === 'ready') S.ready = key; else if (kind === 'vote') S.myVote = { key, t }; else if (kind === 'night') S.sealed = { key, t };
  if (!net.act(kind, t)) { S.ready = S.myVote = S.sealed = null; toast('Not connected. Try again in a moment.'); }
}
function pushName() { const n = myName(); net.setProfile({ name: n }); net.act('rename', n); }

/* ---------- one-phone play ---------- */
// The game is kept in local storage, so closing the app (or the phone killing it) loses nothing.
function dirty() { store.set('L', { G, loc: S.loc }, LS); render(); }
function startLocal() {
  const names = S.localNames.map((n, i) => n.trim() || 'Player ' + (i + 1));
  G = E.newRoom('TABLE', { local: true }); G.st.disc = S.localDisc; G.st.mode = S.localMode;
  names.forEach((n, i) => E.join(G, { id: 'p' + i, name: n, tint: i }, now()));
  E.startGame(G, now()); passOrder(G.ps); S.screen = 'room'; saveTable(); dirty();
}
const refMode = () => !!(G && G.st.mode === 'ref');
/** Hand the phone to each of these players in turn. */
function passOrder(list) { S.loc = { kind: 'pass', order: (list || E.alive(G)).map(p => p.id), i: 0, step: 'pass' }; }
/** The referee's script for one night: everyone sleeps, each role is called, the town wakes. */
function startScript() {
  const has = r => G.ps.some(p => p.role === r);
  // Every role is called every night, even once its player is out, so the call itself gives nothing away.
  const steps = ['sleep', 'M'].concat(has('H') ? ['H'] : [], has('D') ? ['D'] : [], ['dawn']);
  S.loc = { kind: 'script', steps, k: 0, picks: {} };
  speakStep();
}
function nightBegins() { if (refMode()) startScript(); else passOrder(); }
function locNext() {
  const L = S.loc; L.i++; L.step = 'pass'; S.peek = false; S.sel = null;
  if (L.i >= L.order.length) {
    if (G.ph === 'reveal') { E.toNight(G, now()); nightBegins(); }
    else if (G.ph === 'night') E.resolveNight(G, now());
  }
  dirty();
}
const SCRIPT = {
  sleep: { say: 'Everyone, close your eyes.', do: 'Wait until every head is down.', next: 'All eyes are closed' },
  M: { say: 'Mafia, open your eyes, and silently point at your target.', next: 'Mafia, close your eyes' },
  H: { say: 'Doctor, open your eyes, and point at someone to protect.', next: 'Doctor, close your eyes' },
  D: { say: 'Detective, open your eyes, and point at someone you suspect.', next: 'Detective, close your eyes' },
  dawn: { say: 'Everyone, open your eyes.', do: 'Then read out what happened.', next: 'Wake the town' }
};
function speak(text) {
  try {
    const ss = window.speechSynthesis; if (!ss) return;
    ss.cancel(); const u = new SpeechSynthesisUtterance(text); u.rate = 0.92; u.pitch = 0.9; ss.speak(u);
  } catch (e) {}
}
function speakStep() { if (S.voice && S.loc && S.loc.kind === 'script') speak(SCRIPT[S.loc.steps[S.loc.k]].say); }
function wakeTown() {
  const picks = S.loc.picks;
  for (const p of E.alive(G)) { const t = picks[p.role]; if (t && p.role !== 'V') E.submitNight(G, p.id, t); }
  E.resolveNight(G, now());
}
/** Hand count: most hands goes out; a tie, or no hands, sends nobody. The same rule as online. */
function tallyOutcome() {
  const e = Object.entries(S.tally).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (!e.length) return { out: null, tie: false };
  if (e.length > 1 && e[1][1] === e[0][1]) return { out: null, tie: true };
  return { out: e[0][0], tie: false };
}

/* ---------- views ---------- */
// Everything a view needs: the public state, this player's secrets, and who "this player" is.
function ctx() {
  const local = !!G;
  const pub = local ? E.pubOf(G) : V.pub;
  const me = local ? (S.loc && S.loc.kind === 'pass' && S.loc.step === 'show' ? S.loc.order[S.loc.i] : null) : S.me;
  const priv = local ? (me ? E.privOf(G, me) : {}) : (V.priv || {});
  const meP = pub ? pub.ps.find(p => p.i === me) : null;
  return { pub, priv, me, local, host: local || !!(pub && pub.host === me), dl: local ? G.dl : V.dl, meP, ref: !local && !!(meP && meP.ref), lref: local && refMode() };
}
const pOf = (c, id) => c.pub.ps.find(p => p.i === id);
const nameOf = (c, id) => { const p = pOf(c, id); return p ? p.n : 'someone'; };
const tg = (t, cls) => `<span class="tag ${cls || ''}">${t}</span>`;
const initial = n => { n = (n || '?').trim(); const m = n.match(/^Player (\d+)$/); return m ? m[1] : ([...n][0] || '?').toUpperCase(); };
const win = (p, cls) => `<span class="win ${cls || ''}${p.al === 0 ? ' out' : ''}${p.ref ? ' refw' : ''}" style="--t:${TINTS[(p.a | 0) % 8]}" aria-hidden="true">${esc(initial(p.n))}</span>`;
/** A role this screen is allowed to show: public (dead, or game over), or known to a referee or ghost. */
function knownRole(c, q) {
  if (q.rl) return q.rl;
  const all = c.priv && c.priv.all; if (!all) return null;
  const r = all[c.pub.ps.indexOf(q)];
  return r && r !== 'R' && ROLE[r] ? r : null;
}
function baseTags(p, c) {
  const t = [];
  if (!c.local && p.i === c.me) t.push(tg('You', 'you'));
  if (!c.local && p.i === c.pub.host) t.push(tg('Host'));
  if (p.ref) t.push(tg('Referee', 'rR'));
  if (p.b) t.push(tg('Bot')); if (p.off) t.push(tg('Away'));
  const r = knownRole(c, p); if (r) t.push(tg(ROLE[r].name, 'r' + r));
  return t;
}
function tile(p, c, o) {
  o = o || {};
  const inner = `${win(p)}<span class="tn">${esc(p.n)}</span><span class="tags">${(o.tags || []).join('')}</span>${o.extra || ''}`;
  const cls = `tile${o.on ? ' on' : ''}${o.cls ? ' ' + o.cls : ''}`;
  return o.act ? `<button type="button" class="${cls}" data-k="${p.i}" data-act="${o.act}" data-id="${p.i}"${o.dis ? ' disabled' : ''} aria-pressed="${!!o.on}">${inner}</button>` : `<div class="${cls}" data-k="${p.i}">${inner}</div>`;
}
const blank = (label, o) => { const inner = `<span class="win out" aria-hidden="true"></span><span class="tn">${label}</span><span class="tags"></span>${o.extra || ''}`; return o.act ? `<button type="button" class="tile${o.on ? ' on' : ''}" data-k="${o.id}" data-act="${o.act}" data-id="${o.id}" aria-pressed="${!!o.on}">${inner}</button>` : `<div class="tile" data-k="${o.id}">${inner}</div>`; };
const seated = c => c.pub.ps.filter(q => !q.ref);
const roster = (c, title = 'The town') => `<section><div class="sec-h"><h2>${title}</h2><span class="muted">${seated(c).filter(q => q.al).length} lit</span></div><div class="grid">${c.pub.ps.map(q => tile(q, c, { tags: baseTags(q, c) })).join('')}</div></section>`;
const waitPanel = (h, t) => `<section class="panel"><p class="eyebrow">Watching</p><h2>${h}</h2><p class="muted">${t}</p></section>`;
const timer = (dl, du) => { const left = Math.max(0, dl - now()); return `<span class="timer${left < 10000 ? ' low' : ''}" data-dl="${dl}" data-du="${du}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle class="trk" cx="12" cy="12" r="9"/><circle class="arc" cx="12" cy="12" r="9" style="stroke-dashoffset:${(56.5 * (1 - Math.min(1, left / (du || 1)))).toFixed(1)}"/></svg><b>${fmt(left)}</b></span>`; };
const iAmReady = c => !!c.priv.r || S.ready === keyOf(c.pub);
const seg = (label, opts, cur, act) => `<div class="seg" role="radiogroup" aria-label="${label}">${opts.map(([v, t]) => `<button type="button" role="radio" aria-checked="${cur === v}" class="${cur === v ? 'on' : ''}" data-act="${act}" data-id="${v}">${t}</button>`).join('')}</div>`;
const segDisc = (cur, act) => seg('Daytime talk', E.DISCUSSION.map(s => [s, s < 120 ? s + ' s' : (s / 60) + ' min']), cur, act);
const progress = (i, n) => `<div class="dots" role="img" aria-label="${i + 1} of ${n}">${Array.from({ length: n }, (_, k) => `<span class="${k < i ? 'done' : k === i ? 'now' : ''}"></span>`).join('')}</div>`;

function vHome() {
  const r = S.resume;
  return `<main class="wrap home" data-k="home">
  <header class="hero">
    <p class="eyebrow">Mafia for 4 to 12 players</p>
    <h1 class="mark"><span>Lights</span><em>Out</em></h1>
    <p class="lede">Everyone gets a lit window in town. Each night the Mafia puts one out. Talk, bluff and vote before the whole street goes dark.</p>
  </header>
  <section class="panel join" aria-label="Start playing">
    ${r ? `<div class="banner opt resume"><span>A one-phone game is in progress: ${esc(r)}.</span><span class="row"><button type="button" class="btn primary" data-act="resume">Resume</button><button type="button" class="btn ghost" data-act="discard">Discard</button></span></div>` : ''}
    <div class="namefield">${win({ n: S.name || '?', a: S.tint })}<div class="field"><label for="nm">Your name, optional</label><input id="nm" class="input" maxlength="14" autocomplete="nickname" enterkeyhint="done" placeholder="Leave blank to get one" value="${esc(S.name)}"></div></div>
    <div class="field"><span class="label" id="tl">Your window light</span><div class="tints" role="radiogroup" aria-labelledby="tl">${TINTS.map((t, i) => `<button type="button" class="tint${i === S.tint ? ' on' : ''}" role="radio" aria-checked="${i === S.tint}" aria-label="${TINT_NAMES[i]}" data-act="tint" data-id="${i}" style="--t:${t}"></button>`).join('')}</div></div>
    <button type="button" class="btn primary big" data-act="create"${S.busy ? ' disabled' : ''}>${S.busy ? 'Connecting…' : 'Open a room'}</button>
    <div class="or"><span>or join one</span></div>
    <div class="joinrow"><input id="code" class="input codein" maxlength="5" inputmode="text" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="go" placeholder="CODE" aria-label="Room code" value="${esc(S.codeIn)}"><button type="button" class="btn" data-act="join"${S.busy ? ' disabled' : ''}>Join</button></div>
    <p class="err" role="alert">${esc(S.err)}</p>
    <div class="or"><span>in one room</span></div>
    <button type="button" class="btn big" data-act="local">Play on one phone</button>
    ${install.available() ? `<button type="button" class="link install" data-act="install">${ICON.plus}<span>Add Lights Out to your home screen</span></button>` : ''}
  </section>
  <ul class="facts">
      <li><span><b>No accounts.</b> Pick a name and share a link or a five-letter code.</span></li>
      <li><span><b>A referee if you want one.</b> Someone runs the game, sees every card, and plays no side.</span></li>
      <li><span><b>Everyone taps at night.</b> Townspeople whisper a suspect, so a busy thumb gives nothing away.</span></li>
      <li><span><b>One phone is enough.</b> Pass it around, or let a referee hold it and run the night out loud.</span></li>
  </ul>
  <section class="roles" aria-label="The roles">${['M', 'D', 'H', 'V', 'R'].map(k => `<div class="rolecard r${k}">${RICON[k]}<h3>${ROLE[k].name}</h3><p>${ROLE[k].blurb}</p></div>`).join('')}</section>
  </main>`;
}
function vLocalSetup() {
  const n = S.localNames.length, ref = S.localMode === 'ref';
  const canSpeak = typeof window.speechSynthesis !== 'undefined';
  return `<main class="wrap game" data-k="ls"><header class="bar"><span class="mini">Lights <em>Out</em></span><span class="chip">One phone</span><span class="grow"></span><button type="button" class="iconbtn txt" data-act="back">Back</button></header>
  <div class="stage">
  <section class="panel"><p class="eyebrow">How you play</p>
    ${seg('How you play', [['pass', 'Pass the phone'], ['ref', 'With a referee']], S.localMode, 'lmode')}
    <p class="muted">${ref
      ? 'The referee holds the phone and does not play. At night everyone closes their eyes, each role wakes and points, and the referee taps it in. Only the cards go round.'
      : 'Everyone plays. The phone goes round for cards and for every night move, so nobody can tell who is busy. You talk and vote out loud.'}</p>
    ${ref && canSpeak ? `<label class="check"><input type="checkbox" id="voice"${S.voice ? ' checked' : ''}><span>Read the referee's lines aloud</span></label>` : ''}
  </section>
  <section class="panel"><p class="eyebrow">${ref ? 'Players, not counting the referee' : 'Players'}</p><h2>Who is at the table?</h2>
  <div class="names">${S.localNames.map((v, i) => `<div class="namerow" data-k="n${i}">${win({ n: v || String(i + 1), a: i })}<input class="input" id="lp${i}" data-idx="${i}" maxlength="14" autocomplete="off" autocapitalize="words" enterkeyhint="next" placeholder="Player ${i + 1}" aria-label="Player ${i + 1} name" value="${esc(v)}">${n > 4 ? `<button type="button" class="btn sq ghost" data-act="lrem" data-id="${i}" aria-label="Remove player ${i + 1}">×</button>` : '<span></span>'}</div>`).join('')}</div>
  <div class="row"><button type="button" class="btn" data-act="ladd"${n >= 12 ? ' disabled' : ''}>Add a player</button><button type="button" class="btn ghost" data-act="lshuffle">Shuffle the order</button></div>
  <p class="hint">Names are kept on this phone for next time. The phone is passed in this order.</p>
  </section>
  <section class="panel">
  <div class="opt"><span class="label">Daytime talk</span>${segDisc(S.localDisc, 'ldisc')}</div>
  <p class="hint">${n} players: ${mixText(mix(n))}.</p>
  <button type="button" class="btn primary big" data-act="lstart">Deal the cards</button></section></div></main>`;
}
function vBar(c) {
  const p = c.pub, label = { lobby: 'Lobby', reveal: 'The deal', night: 'Night ' + p.rd, day: 'Day ' + p.rd, vote: 'Vote ' + p.rd, verdict: 'Verdict', end: 'Case closed' }[p.ph];
  return `<header class="bar${p.ph === 'lobby' ? '' : ' ingame'}"><span class="mini">Lights <em>Out</em></span>${c.local ? `<span class="chip code">One phone</span>` : `<button type="button" class="chip code" data-act="copycode" aria-label="Copy room code ${p.c}">${esc(p.c)}</button>`}<span class="chip">${label}</span>${c.ref || c.lref ? `<span class="chip ref">Referee</span>` : ''}<span class="grow"></span>${c.dl ? timer(c.dl, p.du) : ''}<button type="button" class="iconbtn" data-act="sound" aria-pressed="${S.sound}" aria-label="Sound">${S.sound ? ICON.on : ICON.off}</button><button type="button" class="iconbtn txt" data-act="leave">${S.confirmLeave ? 'Sure?' : 'Leave'}</button></header>`;
}
function vBanner(c) {
  if (c.local) return ''; const p = c.pub, b = [];
  if (S.link !== 'open' && now() - S.linkSince > 2000) b.push(`<div class="banner warn">Connection lost. Reconnecting, and your seat is safe.</div>`);
  if (p.ph !== 'lobby' && !c.meP) b.push(`<div class="banner">A game is under way. You are watching, and you are in for the next deal.</div>`);
  if (p.ph === 'lobby' && !c.meP && p.ps.length >= 12) b.push(`<div class="banner warn">This table is full.</div>`);
  if (p.ph === 'lobby' && !c.meP && p.ps.length < 12) b.push(`<div class="banner opt">You are not seated at this table.<button type="button" class="btn" data-act="sit">Take a seat</button></div>`);
  return b.join('');
}
function vLobby(c) {
  const p = c.pub, n = p.ps.length, players = seated(c).length, hostP = pOf(c, p.host), show = Math.min(12, Math.max(6, n + 1)), bots = p.ps.filter(q => q.b).length;
  const refP = p.ps.find(q => q.ref);
  const seats = p.ps.map(q => tile(q, c, { tags: baseTags(q, c), extra: c.host && q.i !== c.me ? `<button type="button" class="kick" data-act="kick" data-id="${q.i}" aria-label="Remove ${esc(q.n)}">×</button>` : '' })).join('') + Array.from({ length: show - n }, (_, i) => `<div class="tile empty" data-k="e${i}"><span class="win out" aria-hidden="true"></span><span class="tn">Open seat</span><span class="tags"></span></div>`).join('');
  const mixLine = players < 4 ? `Mafia needs at least 4 players${refP ? ', not counting the referee' : ''}. ${4 - players} more to go.` : `${players} players: ${mixText(mix(players))}.`;
  const refSel = `<label class="opt" for="refsel"><span class="label">Referee</span><select id="refsel" class="input select"><option value="">Nobody, everyone plays</option>${p.ps.filter(q => !q.b).map(q => `<option value="${q.i}"${q.ref ? ' selected' : ''}>${esc(q.n)}${q.i === c.me ? ' (you)' : ''}</option>`).join('')}</select></label>`;
  return `<section class="panel share"><p class="eyebrow">Room code</p>
    <div class="bigcode" role="img" aria-label="Room code ${esc(p.c.split('').join(' '))}">${p.c.split('').map(x => `<span>${esc(x)}</span>`).join('')}</div>
    <div class="row center"><button type="button" class="btn" data-act="copyinvite">Copy invite link</button><button type="button" class="btn ghost" data-act="copycode">Copy code</button></div>
    <p class="hint">Send the link, or read out the code. Nobody makes an account.</p></section>
  <section aria-label="Seats"><div class="sec-h"><h2>At the table</h2><span class="muted">${n} of 12</span></div><div class="grid">${seats}</div>${c.meP ? `<div class="rename"><label for="rn">Your name</label><input id="rn" class="input" maxlength="14" autocomplete="nickname" enterkeyhint="done" placeholder="${esc(c.meP.n)}" value="${esc(S.name)}"></div>` : ''}</section>
  <section class="panel">${c.host ? `
    ${refSel}
    <p class="hint">${refP ? `${esc(refP.n)} runs the game: no card, sees everything, moves things on.` : 'A referee runs the game instead of playing. They see every card and can move each phase on.'}</p>
    <div class="opt"><span class="label">Bots</span><div class="stepper"><button type="button" class="btn sq" data-act="rembot" aria-label="Remove a bot"${bots ? '' : ' disabled'}>−</button><b>${bots}</b><button type="button" class="btn sq" data-act="addbot" aria-label="Add a bot"${n >= 12 ? ' disabled' : ''}>+</button></div></div>
    <div class="opt"><span class="label">Daytime talk</span>${segDisc(p.st.disc, 'disc')}</div>
    <p class="hint">${mixLine}</p>
    <button type="button" class="btn primary big" data-act="start"${players < 4 ? ' disabled' : ''}>Deal the cards</button>`
    : `<p class="eyebrow">Waiting</p><h3>${esc(hostP ? hostP.n : 'The host')} deals when everyone is in</h3><p class="hint">${refP ? `${esc(refP.n)} is the referee. ` : ''}${mixLine}</p>`}</section>`;
}
const passScreen = (c, p, line) => {
  const L = S.loc;
  return `<section class="panel pass"><p class="eyebrow">Pass the phone · ${L.i + 1} of ${L.order.length}</p>${progress(L.i, L.order.length)}${win(p, 'xl')}<h2>${esc(p.n)}</h2><p class="muted">${line}</p><button type="button" class="btn primary big" data-act="iam">I'm ${esc(p.n)}</button></section>`;
};
function roleFace(c) {
  const k = c.priv.rl, r = ROLE[k]; if (!r) return '<span class="rblurb">Opening your card…</span>';
  const mates = (c.priv.mt || []).map(id => esc(nameOf(c, id)));
  return `<span class="ricon">${RICON[k]}</span><span class="rname">${r.name}</span><span class="rblurb">${r.blurb}</span>${k === 'M' ? `<span class="rmates">${mates.length ? 'With you: ' + mates.join(', ') : 'You work alone.'}</span>` : ''}`;
}

// ----- the online referee's screens -----
const ADVANCE = { reveal: 'Start the night', night: 'End the night now', day: 'Call the vote now', vote: 'Close the vote now', verdict: 'Carry on' };
const refControls = (c, note) => `<section class="panel refbar"><div class="opt"><p class="eyebrow">Referee</p>${ADVANCE[c.pub.ph] ? `<button type="button" class="btn primary" data-act="advance">${ADVANCE[c.pub.ph]}</button>` : ''}</div>${note ? `<p class="hint">${note}</p>` : ''}</section>`;
function refReveal(c) {
  const humans = seated(c).filter(q => !q.b).length;
  return `<section class="panel refcard"><span class="ricon rR">${RICON.R}</span><p class="eyebrow">Your job</p><h2>You are the referee</h2><p class="muted">${ROLE.R.blurb}</p></section>
    ${refControls(c, `${c.pub.rc} of ${humans} players have seen their card. The night starts by itself once they all have.`)}
    ${roster(c, 'Every card')}`;
}
function refNight(c) {
  const p = c.pub, na = c.priv.na || {}, al = p.ps.filter(q => q.al && !q.ref);
  const marks = {};
  const add = (t, label, cls) => { (marks[t] = marks[t] || []).push(tg(label, cls)); };
  const whispers = {};
  for (const [actor, t] of Object.entries(na)) {
    const r = knownRole(c, pOf(c, actor));
    if (r === 'M') add(t, `${esc(nameOf(c, actor))}'s target`, 'rM');
    else if (r === 'H') add(t, 'Guarded', 'rH');
    else if (r === 'D') add(t, 'Checked', 'rD');
    else whispers[t] = (whispers[t] || 0) + 1;
  }
  for (const [t, n] of Object.entries(whispers)) add(t, `${n} whisper${n > 1 ? 's' : ''}`);
  const tiles = p.ps.filter(q => !q.ref).map(q => tile(q, c, { tags: baseTags(q, c).concat(q.al && na[q.i] ? [tg('Chose', 'you')] : [], marks[q.i] || []), cls: q.al ? '' : 'gone' })).join('');
  return `<section class="panel"><p class="eyebrow">Night ${p.rd} · Referee</p><h2>The town is choosing</h2><p class="muted">Moves appear here as they are made. The night ends by itself when everyone has chosen.</p></section>
    ${refControls(c, `${p.ac} of ${al.length} have chosen.`)}
    <div class="grid">${tiles}</div>`;
}

function vReveal(c) {
  if (c.local && S.loc.kind === 'pass' && S.loc.step === 'pass') return passScreen(c, pOf(c, S.loc.order[S.loc.i]), c.lref ? 'Your card is next. The referee looks away.' : 'Your card is next. Keep the screen to yourself.');
  if (c.ref) return refReveal(c);
  if (!c.meP) return waitPanel('Cards are going round', 'You will be dealt in next game.');
  const ready = !c.local && iAmReady(c), humans = seated(c).filter(q => !q.b).length;
  return `<section class="reveal"><p class="eyebrow">Your card</p>
    <button type="button" class="card3d r${c.priv.rl || 'V'}${S.peek ? ' flip' : ''}" data-hold="1" aria-label="Hold to look at your card"><span class="in"><span class="face back"><span class="backmark">${win({ n: c.meP.n, a: c.meP.a })}<span>Hold to look</span></span></span><span class="face front">${roleFace(c)}</span></span></button>
    <p class="hint center">Press and hold. Let go and it hides again.</p>
    ${c.local ? `<button type="button" class="btn primary big" data-act="ldone">Hidden. Pass it on</button>` : `<button type="button" class="btn primary big" data-act="ready"${ready ? ' disabled' : ''}>${ready ? 'Waiting for the others' : 'I know who I am'}</button><p class="hint center">${c.pub.rc} of ${humans} ready</p>`}</section>`;
}
function ghost(c, line) {
  return `<section class="panel"><p class="eyebrow">Ghost</p><h2>Your light is out</h2><p class="muted">${line} You can see every card now. Keep it to yourself.</p></section><div class="grid">${c.pub.ps.map(q => tile(q, c, { tags: baseTags(q, c) })).join('')}</div>`;
}
// ----- the one-phone referee's night script -----
function localScript(c) {
  const L = S.loc, step = L.steps[L.k], sc = SCRIPT[step], p = c.pub;
  const holders = r => G.ps.filter(q => q.role === r);
  const aliveHolders = r => holders(r).filter(q => q.al);
  let body = '', ready = true;
  if (step === 'M' || step === 'H' || step === 'D') {
    const who = holders(step), live = aliveHolders(step);
    const names = who.map(q => esc(q.n) + (q.al ? '' : ' (out)')).join(', ');
    if (!live.length) {
      body = `<p class="hint">${ROLE[step].name}: ${names}. They are out, but call them anyway and wait a few seconds, so nobody can tell.</p>`;
    } else {
      const targets = step === 'M' ? E.alive(G).filter(q => q.role !== 'M') : step === 'H' ? E.alive(G).filter(q => q.id !== G.lastSave) : E.alive(G).filter(q => q.role !== 'D');
      const chosen = L.picks[step];
      ready = !!chosen;
      body = `<p class="hint">${step === 'M' ? 'Mafia' : ROLE[step].name}: <b>${names}</b>. Tap who they point at.${step === 'H' && G.lastSave ? ` They cannot guard ${esc(nameOf(c, G.lastSave))} again tonight.` : ''}</p>
        <div class="grid">${targets.map(q => tile(pOf(c, q.id), c, { act: 'rpick', on: chosen === q.id })).join('')}</div>`;
      if (step === 'D' && chosen) {
        const isM = G.ps.find(q => q.id === chosen).role === 'M';
        body += `<div class="banner ${isM ? 'warn' : ''} verdictline"><b>${esc(nameOf(c, chosen))} ${isM ? 'is Mafia' : 'is not Mafia'}.</b> Show the Detective a thumbs ${isM ? 'up' : 'down'}.</div>`;
      }
    }
  }
  const doLine = sc.do ? `<p class="muted">${sc.do}</p>` : '';
  return `<section class="panel script"><p class="eyebrow">Night ${p.rd} · ${L.k + 1} of ${L.steps.length}</p>${progress(L.k, L.steps.length)}
      <p class="say">“${sc.say}”</p>${doLine}
      <div class="row"><button type="button" class="btn ghost" data-act="rsay">${ICON.speak}<span>Read it aloud</span></button>${L.k ? `<button type="button" class="btn ghost" data-act="rback">Back</button>` : ''}</div></section>
    ${body}
    <button type="button" class="btn primary big" data-act="rnext"${ready ? '' : ' disabled'}>${sc.next}</button>`;
}
function vNight(c) {
  const p = c.pub, key = keyOf(p), al = p.ps.filter(q => q.al && !q.ref);
  if (c.local && S.loc.kind === 'script') return localScript(c);
  if (c.local && S.loc.step === 'pass') return passScreen(c, pOf(c, S.loc.order[S.loc.i]), `Night ${p.rd}. Everyone takes a turn, so nobody learns anything from who is tapping.`);
  if (c.ref) return refNight(c);
  if (!c.meP) return waitPanel('Night ' + p.rd, 'The town is asleep.') + roster(c);
  if (!c.meP.al) return ghost(c, `Night ${p.rd}. The living are choosing.`);
  const rl = c.priv.rl, r = ROLE[rl]; if (!r) return `<section class="panel"><p class="eyebrow">Night ${p.rd}</p><h2>Opening your card…</h2></section>`;
  const mates = c.priv.mt || [], intel = Object.fromEntries(c.priv.in || []), mp = c.priv.mp || {};
  const sealed = S.editing ? null : ((S.sealed && S.sealed.key === key) ? S.sealed.t : (c.priv.my || null));
  const tiles = al.map(q => {
    const tags = []; let dis = false;
    if (q.i === c.me) { if (rl !== 'H') dis = true; tags.push(tg('You', 'you')); }
    if (rl === 'M' && mates.includes(q.i)) { dis = true; tags.push(tg('Partner', 'rM')); }
    if (rl === 'H' && c.priv.ls === q.i) { dis = true; tags.push(tg('Guarded last night')); }
    if (rl === 'D' && q.i in intel) tags.push(intel[q.i] ? tg('Mafia', 'rM') : tg('Clear', 'rH'));
    for (const m in mp) if (mp[m] === q.i) tags.push(tg(esc(nameOf(c, m)) + "'s pick", 'rM'));
    const on = sealed ? sealed === q.i : S.sel === q.i;
    if (sealed && on) tags.push(tg('Sealed', 'you'));
    return tile(q, c, { act: 'pick', on, dis: dis || !!sealed, tags });
  }).join('');
  return `<section class="panel"><p class="eyebrow">Night ${p.rd} · ${r.name}${c.local ? ` · ${S.loc.i + 1} of ${S.loc.order.length}` : ''}</p><h2>${r.verb}</h2><p class="muted">${r.night}</p></section>
    <div class="grid">${tiles}</div>
    <div class="row">${sealed ? `<button type="button" class="btn ghost big" data-act="change">Change my mind</button>` : `<button type="button" class="btn primary big" data-act="seal"${S.sel ? '' : ' disabled'}>Seal my choice</button>`}</div>
    ${c.local ? '' : `<p class="hint center">${sealed ? 'Sealed. ' : ''}${p.ac} of ${al.length} have chosen</p>`}`;
}
function vDay(c) {
  const p = c.pub, nw = p.news || {}, k = nw.k && pOf(c, nw.k), al = seated(c).filter(q => q.al), humans = al.filter(q => !q.b && !q.off).length, ready = iAmReady(c), intel = c.priv.in || [];
  const head = k ? `<h2>${esc(k.n)}'s window went dark</h2><p class="big">${esc(k.n)} was ${art(k.rl)}.</p>` : `<h2>Every window is still lit</h2><p class="big">${nw.sv ? 'The Mafia came for someone. The Doctor got there first.' : 'The Mafia picked nobody last night.'}</p>`;
  const wh = nw.w && nw.w.length ? `Townspeople whispered about ${nw.w.map(e => `<b>${esc(nameOf(c, e[0]))}</b> (${e[1]})`).join(' and ')} last night.` : 'No whispers last night.';
  const playing = c.meP && c.meP.al && !c.meP.ref;
  let actions;
  if (c.local) actions = `<button type="button" class="btn primary big" data-act="callvote">Go to the vote</button>`;
  else actions = `${playing ? `<button type="button" class="btn primary big" data-act="ready"${ready ? ' disabled' : ''}>${ready ? `Ready. ${p.rc} of ${humans}` : 'Ready to vote'}</button>` : ''}${c.host && !c.ref ? `<button type="button" class="btn ghost big" data-act="callvote">Call the vote now</button>` : ''}`;
  return `<section class="panel" aria-live="polite"><p class="eyebrow">Dawn, day ${p.rd}${c.lref ? ' · read this out' : ''}</p>${head}</section>
    ${c.lref ? '' : `<section class="panel slim"><p class="eyebrow">Whispers</p><p>${wh}</p></section>`}
    ${c.ref ? refControls(c, `${p.rc} of ${humans} players are ready to vote.`) : ''}
    ${intel.length && !c.local && !c.ref ? `<section class="panel slim"><div class="opt"><p class="eyebrow">Your case notes</p><button type="button" class="btn ghost" data-act="notes" aria-expanded="${S.notes}">${S.notes ? 'Hide' : 'Show'}</button></div>${S.notes ? `<ul class="notes">${intel.map(e => `<li><b>${esc(nameOf(c, e[0]))}</b>${e[1] ? tg('Mafia', 'rM') : tg('Not Mafia', 'rH')}</li>`).join('')}</ul>` : ''}</section>` : ''}
    ${c.lref ? localRefSheet(c) : ''}
    ${roster(c)}
    <div class="row col">${actions}</div>`;
}
/** On one phone the referee can check the cards by holding a button, out of the table's sight. */
function localRefSheet(c) {
  const rows = G.ps.map(q => `<li><span>${esc(q.n)}${q.al ? '' : ' (out)'}</span>${tg(ROLE[q.role].name, 'r' + q.role)}</li>`).join('');
  return `<section class="panel slim"><div class="opt"><p class="eyebrow">Referee's sheet</p><button type="button" class="btn ghost" data-hold="1">Hold to see every card</button></div>${S.peek ? `<ul class="notes sheet">${rows}</ul>` : ''}</section>`;
}
function vVote(c) {
  const p = c.pub, key = keyOf(p), al = seated(c).filter(q => q.al);
  if (c.local) {
    const res = tallyOutcome(), max = al.length;
    const tiles = al.map(q => {
      const n = S.tally[q.i] || 0;
      return `<div class="trow${n ? ' on' : ''}" data-k="${q.i}">${win(q, 'sm')}<span class="tn">${esc(q.n)}</span><span class="stepper"><button type="button" class="btn sq" data-act="tminus" data-id="${q.i}" aria-label="One fewer vote for ${esc(q.n)}"${n ? '' : ' disabled'}>−</button><b aria-live="polite">${n}</b><button type="button" class="btn sq" data-act="tplus" data-id="${q.i}" aria-label="One more vote for ${esc(q.n)}"${n >= max ? ' disabled' : ''}>+</button></span></div>`;
    }).join('');
    const line = res.out ? `<b>${esc(nameOf(c, res.out))}</b> goes out.` : res.tie ? 'A tie. Nobody goes.' : 'No hands yet. Nobody goes.';
    return `<section class="panel"><p class="eyebrow">Vote, day ${p.rd}</p><h2>Count the hands</h2><p class="muted">Name each player in turn and count the hands raised. Most hands goes out. A tie sends nobody.</p></section>
      <div class="tally-list">${tiles}</div>
      <div class="banner verdictline" aria-live="polite">${line}</div>
      <div class="row"><button type="button" class="btn primary big" data-act="lverdict">Confirm the verdict</button></div>`;
  }
  const vt = Object.assign({}, p.vt || {}), can = !!(c.meP && c.meP.al && !c.meP.ref);
  if (can && S.myVote && S.myVote.key === key) vt[c.me] = S.myVote.t;
  const mine = vt[c.me], by = {}, skips = [];
  for (const v in vt) { if (vt[v] === 'skip') skips.push(v); else (by[vt[v]] = by[vt[v]] || []).push(v); }
  const voters = ids => `<span class="voters">${ids.map(id => { const q = pOf(c, id); return q ? win(q, 'xs') : ''; }).join('')}</span>`;
  const extra = ids => `<span class="count${ids.length ? ' has' : ''}">${ids.length}</span>${voters(ids)}`;
  const tiles = al.map(q => tile(q, c, { act: can ? 'vote' : null, on: mine === q.i, dis: q.i === c.me, tags: baseTags(q, c), extra: extra(by[q.i] || []) })).join('');
  const skip = blank('Skip', { id: 'skip', act: can ? 'vote' : null, on: mine === 'skip', extra: extra(skips) });
  return `<section class="panel"><p class="eyebrow">Vote, day ${p.rd}</p><h2>Who goes dark?</h2><p class="muted">Most votes is out, and their card is shown. A tie, or more skips than the leader has votes, and nobody goes.</p></section>
    ${c.ref ? refControls(c, `${Object.keys(vt).length} of ${al.length} have voted. The vote closes by itself when everyone has.`) : ''}
    <div class="grid">${tiles}${skip}</div><p class="hint center">${Object.keys(vt).length} of ${al.length} voted${can ? '. Tap another name to change.' : ''}</p>`;
}
function vVerdict(c) {
  const p = c.pub, vd = p.vd || {}, out = vd.out && pOf(c, vd.out);
  const chips = Object.entries(vd.t || {}).sort((a, b) => b[1] - a[1]).map(e => tg(esc(nameOf(c, e[0])) + ' ' + e[1])).join('');
  return `<section class="panel verdict"><p class="eyebrow">Verdict, day ${p.rd}</p>${out ? `${win(Object.assign({}, out, { al: 1 }), 'xl')}<h2>${esc(out.n)} is out</h2><p class="big">${esc(out.n)} was ${art(out.rl)}.</p>` : `<h2>Nobody goes</h2><p class="big">${vd.tie ? 'The vote tied.' : 'The town could not agree.'}</p>`}<div class="tags">${chips}</div>${c.local ? `<button type="button" class="btn primary big" data-act="lcont">Carry on</button>` : c.ref ? `<button type="button" class="btn primary big" data-act="advance">Carry on</button>` : ''}</section>`;
}
function vEnd(c) {
  const p = c.pub, town = p.win === 'T', N = id => esc(nameOf(c, id)), aw = p.aw;
  const file = (p.hist || []).map(h => {
    const L = [h.k ? `The Mafia went for <b>${N(h.k)}</b>.` : 'The Mafia chose nobody.'];
    if (h.h) L.push(`The Doctor guarded <b>${N(h.h)}</b>.`);
    if (h.k) L.push(h.x ? `${N(h.k)} did not wake up.` : `${N(h.k)} lived.`);
    if (h.d) L.push(`The Detective checked <b>${N(h.d)}</b>: ${h.dr ? 'Mafia' : 'not Mafia'}.`);
    if (h.w && h.w.length) L.push(`Whispers named ${h.w.map(e => N(e[0]) + ' (' + e[1] + ')').join(' and ')}.`);
    const o = h.o && pOf(c, h.o);
    const D = h.o === undefined ? '' : (o ? `The town voted out <b>${N(h.o)}</b>, ${art(o.rl)}.` : (h.tie ? 'The vote tied. Nobody left.' : 'Nobody was voted out.'));
    return `<li><h4>Night ${h.r}</h4><p>${L.join(' ')}</p>${D ? `<h4>Day ${h.r}</h4><p>${D}</p>` : ''}</li>`;
  }).join('');
  return `<section class="panel end ${town ? 'town' : 'maf'}"><p class="eyebrow">Case closed</p><h1>${town ? 'The town keeps its lights' : 'The street goes dark'}</h1><p class="big">${town ? 'Every Mafia member is out.' : 'The Mafia now matches the town, vote for vote.'}</p>${aw ? `<p class="award"><b>Sharpest whisper:</b> ${N(aw[0])} named real Mafia on ${aw[1]} of ${aw[2]} nights.</p>` : ''}</section>
    <section><div class="sec-h"><h2>Every card</h2></div><div class="grid">${p.ps.map(q => tile(q, c, { tags: baseTags(q, c), cls: q.rl === 'M' ? 'maf' : '' })).join('')}</div></section>
    <section class="panel"><p class="eyebrow">The case file</p><ol class="file">${file}</ol></section>
    <div class="row col">${c.host ? `<button type="button" class="btn primary big" data-act="${c.local ? 'lagain' : 'again'}">Deal again, same table</button>` : `<p class="hint center">The host can deal again.</p>`}${c.local ? `<button type="button" class="btn big" data-act="lnew">Change players</button>` : ''}<button type="button" class="btn ghost big" data-act="leave">${c.local ? 'Back to start' : 'Leave the room'}</button></div>`;
}
const VIEWS = { lobby: vLobby, reveal: vReveal, night: vNight, day: vDay, vote: vVote, verdict: vVerdict, end: vEnd };
function vRoom(c) {
  const p = c.pub;
  if (!p) return `<main class="wrap game"><div class="stage"><section class="panel"><p class="eyebrow">One moment</p><h2>Finding the room…</h2></section></div></main>`;
  const L = S.loc, sub = c.local && L ? (L.kind === 'pass' ? L.step + L.i : 's' + L.k) : '';
  return `<main class="wrap game">${vBar(c)}${vBanner(c)}<div class="stage" data-k="${esc(keyOf(p))}${sub}">${(VIEWS[p.ph] || (() => ''))(c)}</div></main>`;
}
function vSheet() {
  if (S.sheet !== 'ios') return '';
  return `<div class="sheet-back" data-act="closesheet"></div><section class="panel sheetbox" role="dialog" aria-modal="true" aria-labelledby="sh-t">
    <p class="eyebrow">Add to home screen</p><h2 id="sh-t">Keep Lights Out one tap away</h2>
    <ol class="steps">
      <li><span class="ic">${ICON.share}</span><span>Tap <b>Share</b> in Safari's toolbar.</span></li>
      <li><span class="ic">${ICON.plus}</span><span>Scroll down and tap <b>Add to Home Screen</b>.</span></li>
      <li><span class="ic">${ICON.install}</span><span>Tap <b>Add</b>. Lights Out opens full screen from its icon, and one-phone games work offline.</span></li>
    </ol>
    <p class="hint">On iPhone this only works in Safari. In another browser, open this page in Safari first.</p>
    <button type="button" class="btn primary big" data-act="closesheet">Got it</button></section>`;
}

/* ---------- render ---------- */
const app = $('#app');
function morph(from, to) {
  for (const a of Array.from(from.attributes)) if (!to.hasAttribute(a.name)) from.removeAttribute(a.name);
  for (const a of Array.from(to.attributes)) if (from.getAttribute(a.name) !== a.value) from.setAttribute(a.name, a.value);
  const tc = Array.from(to.childNodes);
  for (let i = 0; i < tc.length; i++) {
    const t = tc[i], f = from.childNodes[i];
    if (!f) { from.appendChild(t.cloneNode(true)); continue; }
    if (f.nodeType !== t.nodeType || f.nodeName !== t.nodeName || (f.nodeType === 1 && f.getAttribute('data-k') !== t.getAttribute('data-k'))) { from.replaceChild(t.cloneNode(true), f); continue; }
    if (f.nodeType === 1) {
      morph(f, t);
      // Form state lives on properties, not attributes: keep them in step with the markup.
      if (f.tagName === 'SELECT' && f.value !== t.value) f.value = t.value;
      if (f.tagName === 'INPUT' && f.type === 'checkbox') f.checked = t.hasAttribute('checked');
    } else if (f.nodeValue !== t.nodeValue) f.nodeValue = t.nodeValue;
  }
  while (from.childNodes.length > tc.length) from.removeChild(from.lastChild);
}
let lastKey = null;
function curtain(kicker, title, sub) {
  const el = $('#curtain');
  el.innerHTML = `<p class="eyebrow">${esc(kicker)}</p><h2>${esc(title)}</h2><p>${esc(sub)}</p>`;
  el.classList.remove('show'); void el.offsetWidth; el.classList.add('show'); document.body.classList.add('curtained');
  clearTimeout(curtain.t); curtain.t = setTimeout(() => { el.classList.remove('show'); document.body.classList.remove('curtained'); }, 2400);
}
function onPhase(c) {
  const inRoom = S.screen === 'room' && c.pub, key = inRoom ? keyOf(c.pub) : S.screen;
  if (key === lastKey) return false; lastKey = key;
  S.sel = null; S.editing = false; S.peek = false; S.notes = false; S.confirmLeave = false; S.tally = {};
  if (!inRoom) return true; const p = c.pub;
  if (p.ph === 'reveal') { curtain('The deal', 'Cards are out', c.ref ? 'You are the referee.' : 'Look at yours. Tell nobody.'); Snd.play('deal'); }
  else if (p.ph === 'night') { curtain('Night ' + p.rd, 'Lights low', 'The town sleeps. Some of it.'); Snd.play('night'); }
  else if (p.ph === 'day') { const k = p.news && p.news.k && pOf(c, p.news.k); curtain('Day ' + p.rd, 'Dawn', k ? k.n + ' did not wake up.' : 'Everyone woke up.'); Snd.play(k ? 'out' : 'day'); }
  else if (p.ph === 'vote') { curtain('Day ' + p.rd, 'The vote', c.local ? 'Count the hands.' : 'Point at someone. Or skip.'); Snd.play('vote'); }
  else if (p.ph === 'verdict') { Snd.play(p.vd && p.vd.out ? 'out' : 'tap'); Scene.pulse(); }
  else if (p.ph === 'end') { curtain('Case closed', p.win === 'T' ? 'Town wins' : 'Mafia wins', p.win === 'T' ? 'The last of the Mafia is gone.' : 'There are not enough honest votes left.'); Snd.play(p.win === 'T' ? 'win' : 'lose'); }
  return true;
}
function syncScene(c) {
  let mood = 'dusk', wins, demo = false;
  if (S.screen === 'room' && c.pub) {
    const p = c.pub, ps = p.ps.filter(q => !q.ref); mood = { lobby: 'dusk', reveal: 'dusk', night: 'night', day: 'day', vote: 'vote', verdict: 'vote', end: p.win === 'T' ? 'town' : 'mafia' }[p.ph] || 'dusk';
    wins = ps.map(q => ({ t: TINTS[(q.a | 0) % 8], on: q.al !== 0, me: !c.local && q.i === S.me }));
    if (p.ph === 'end' && p.win === 'M') wins = ps.map(q => ({ t: '#d8455f', on: q.rl === 'M' }));
  } else if (S.screen === 'localSetup') wins = S.localNames.map((n, i) => ({ t: TINTS[i % 8], on: true }));
  else { wins = TINTS.concat(TINTS.slice(0, 4)).map(t => ({ t, on: true })); demo = true; }
  Scene.demo(demo); Scene.mood(mood); Scene.windows(wins);
}
function render() {
  let c = ctx();
  if (onPhase(c)) c = ctx();
  const html = (S.screen === 'home' ? vHome() : S.screen === 'localSetup' ? vLocalSetup() : vRoom(c)) + vSheet();
  const tmp = document.createElement('div'); tmp.id = 'app'; tmp.innerHTML = html;
  morph(app, tmp); syncScene(c);
}
function toast(msg) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; $('#toasts').appendChild(t); setTimeout(() => t.remove(), 3200); }
function copy(text, ok) {
  const no = () => toast(text);
  try { navigator.clipboard.writeText(text).then(() => toast(ok), no); } catch (e) { no(); }
}

/* ---------- input ---------- */
const ACT = {
  tint(id) { S.tint = +id; store.set('tint', S.tint, LS); },
  create() { createRoom(); },
  join() {
    const code = S.codeIn.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 5) { S.err = 'Room codes are five characters.'; return; }
    joinRoom(code);
  },
  local() { S.err = ''; S.screen = 'localSetup'; },
  back() { S.screen = 'home'; },
  install() { if (install.prompt() === 'ios') S.sheet = 'ios'; },
  closesheet() { S.sheet = null; },
  resume() { const saved = store.get('L', LS); if (saved && saved.G) { G = saved.G; S.loc = saved.loc; S.screen = 'room'; S.resume = null; lastKey = keyOf(G); } },
  discard() { store.set('L', null, LS); S.resume = null; },
  ladd() { if (S.localNames.length < E.MAX_PLAYERS) S.localNames.push(''); saveTable(); },
  lrem(id) { S.localNames.splice(+id, 1); saveTable(); },
  lshuffle() { const a = S.localNames; for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } saveTable(); },
  ldisc(id) { S.localDisc = +id; saveTable(); },
  lmode(id) { S.localMode = id === 'ref' ? 'ref' : 'pass'; saveTable(); },
  lstart() { startLocal(); },
  lnew() { G = null; S.loc = null; store.set('L', null, LS); S.screen = 'localSetup'; },
  copycode() { copy(ctx().pub.c, 'Code copied'); },
  copyinvite() { copy(`${location.origin}/#room-${ctx().pub.c.toLowerCase()}`, 'Invite link copied'); },
  sound() { S.sound = !S.sound; store.set('sound', S.sound, LS); if (S.sound) Snd.play('tap'); },
  leave() {
    const c = ctx(), ph = c.pub && c.pub.ph;
    if (S.confirmLeave || !ph || ph === 'lobby' || ph === 'end') return leaveRoom();
    S.confirmLeave = true; setTimeout(() => { S.confirmLeave = false; render(); }, 3500);
  },
  addbot() { net.act('addbot'); },
  rembot() { net.act('rembot'); },
  kick(id) { net.act('kick', id); },
  disc(id) { net.act('disc', +id); },
  start() { net.act('start'); },
  again() { net.act('again'); },
  advance() { net.act('advance'); Snd.play('tap'); },
  sit() { joinRoom(S.code); },
  ready() { sendAction('ready'); },
  pick(id) { S.sel = id; Snd.play('tap'); },
  seal() {
    if (!S.sel) return;
    const t = S.sel; S.editing = false;
    if (G) { E.submitNight(G, ctx().me, t); return locNext(); }
    sendAction('night', t);
  },
  change() { const c = ctx(); S.sel = (S.sealed && S.sealed.t) || c.priv.my || null; S.editing = true; },
  vote(id) { Snd.play('tap'); sendAction('vote', id); },
  notes() { S.notes = !S.notes; },
  callvote() { if (!G) return net.act('callvote'); if (G.ph === 'day') { E.toVote(G, now()); dirty(); } },
  iam() { S.loc.step = 'show'; dirty(); },
  ldone() { locNext(); },
  rpick(id) { S.loc.picks[S.loc.steps[S.loc.k]] = id; Snd.play('tap'); dirty(); },
  rsay() { speak(SCRIPT[S.loc.steps[S.loc.k]].say); },
  rback() { if (S.loc.k > 0) { S.loc.k--; dirty(); } },
  rnext() {
    const L = S.loc;
    if (L.steps[L.k] === 'dawn') { wakeTown(); return dirty(); }
    L.k++; speakStep(); dirty();
  },
  tplus(id) { const al = E.alive(G).length; S.tally[id] = Math.min(al, (S.tally[id] || 0) + 1); Snd.play('tap'); },
  tminus(id) { S.tally[id] = Math.max(0, (S.tally[id] || 0) - 1); },
  lverdict() {
    const res = tallyOutcome();
    E.resolveVote(G, res.out, now());
    G.vd.t = Object.fromEntries(Object.entries(S.tally).filter(([, n]) => n > 0)); G.vd.tie = res.tie ? 1 : 0;
    const rec = G.hist[G.hist.length - 1]; if (rec) rec.tie = G.vd.tie;
    dirty();
  },
  lcont() { E.afterVerdict(G, now()); if (G.ph === 'night') nightBegins(); dirty(); },
  lagain() { E.startGame(G, now()); passOrder(G.ps); dirty(); }
};
let wake = null;
const keepAwake = () => {
  try {
    if (S.screen === 'room' && !wake && navigator.wakeLock && document.visibilityState === 'visible')
      navigator.wakeLock.request('screen').then(w => { wake = w; w.addEventListener('release', () => { wake = null; }); }).catch(() => {});
  } catch (e) {}
};
document.addEventListener('visibilitychange', keepAwake);
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el || el.disabled) return;
  const fn = ACT[el.dataset.act]; if (!fn) return;
  fn(el.dataset.id); render(); keepAwake();
  if (el.dataset.act === 'lrem' || el.dataset.act === 'ladd' || el.dataset.act === 'lshuffle') document.querySelectorAll('.names input').forEach(i => { i.value = S.localNames[+i.dataset.idx] || ''; });
});
let renameTimer = null;
document.addEventListener('input', e => {
  const el = e.target;
  if (el.id === 'nm') { S.name = el.value; store.set('name', S.name, LS); S.err = ''; render(); }
  else if (el.id === 'code') { S.codeIn = el.value.toUpperCase(); S.err = ''; }
  else if (el.id === 'rn') { S.name = el.value; store.set('name', S.name, LS); clearTimeout(renameTimer); renameTimer = setTimeout(pushName, 350); }
  else if (el.dataset.idx) { S.localNames[+el.dataset.idx] = el.value; saveTable(); render(); }
});
document.addEventListener('change', e => {
  const el = e.target;
  if (el.id === 'refsel') net.act('referee', el.value);
  else if (el.id === 'voice') { S.voice = el.checked; saveTable(); if (S.voice) speak('I will read the lines.'); render(); }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'code') { ACT.join(); render(); }
  if (e.key === 'Enter' && e.target.dataset && e.target.dataset.idx) { const next = document.getElementById('lp' + (+e.target.dataset.idx + 1)); if (next) { e.preventDefault(); next.focus(); } }
  if (e.key === 'Escape' && S.sheet) { S.sheet = null; render(); }
  if ((e.key === ' ' || e.key === 'Enter') && e.target.closest && e.target.closest('[data-hold]') && !S.peek) { e.preventDefault(); S.peek = true; render(); }
});
document.addEventListener('keyup', e => { if (S.peek && (e.key === ' ' || e.key === 'Enter')) { S.peek = false; render(); } });
// Cards (and the one-phone referee's sheet) show only while held, so a glance at the phone gives nothing away.
document.addEventListener('pointerdown', e => { if (e.target.closest('[data-hold]')) { S.peek = true; render(); } });
const unpeek = () => { if (S.peek) { S.peek = false; render(); } };
window.addEventListener('pointerup', unpeek); window.addEventListener('pointercancel', unpeek); window.addEventListener('blur', unpeek);
document.addEventListener('contextmenu', e => { if (e.target.closest('[data-hold]')) e.preventDefault(); });
if (matchMedia('(hover: hover)').matches) document.addEventListener('pointermove', e => {
  const t = e.target.closest && e.target.closest('.tile');
  if (t) { const r = t.getBoundingClientRect(); t.style.setProperty('--mx', (e.clientX - r.left) + 'px'); t.style.setProperty('--my', (e.clientY - r.top) + 'px'); }
}, { passive: true });
let lastTick = 0;
setInterval(() => {
  document.querySelectorAll('.timer').forEach(el => {
    const left = Math.max(0, +el.dataset.dl - now()), du = +el.dataset.du || 1;
    el.querySelector('b').textContent = fmt(left);
    el.querySelector('.arc').style.strokeDashoffset = (56.5 * (1 - Math.min(1, left / du))).toFixed(1);
    el.classList.toggle('low', left < 10000);
    const s = Math.ceil(left / 1000); if (s <= 5 && s > 0 && s !== lastTick) { lastTick = s; Snd.play('tick'); }
  });
}, 250);

/* ---------- boot ---------- */
const invite = (location.hash || '').match(/^#room-([a-z0-9]{5})$/i);
if (invite) S.codeIn = invite[1].toUpperCase();
const savedLocal = store.get('L', LS), sess = store.get('sess');
if (savedLocal && savedLocal.G && savedLocal.G.local && savedLocal.G.ph !== 'end') {
  // A reload continues the game straight away; a fresh visit (or the app reopened later) offers to resume it.
  const reloaded = area(() => performance.getEntriesByType('navigation')[0].type === 'reload');
  if (reloaded && !invite) { G = savedLocal.G; S.loc = savedLocal.loc; S.screen = 'room'; lastKey = keyOf(G); }
  else S.resume = `${savedLocal.G.ps.length} players, ${savedLocal.G.ph === 'reveal' ? 'dealing' : savedLocal.G.ph + ' ' + savedLocal.G.rd}`;
}
render();
// The town is drawn once the page is up, so the first screen never waits for it.
const idle = window.requestIdleCallback || (f => setTimeout(f, 200));
idle(() => createScene($('#sky')).then(s => { Scene = s; syncScene(ctx()); }));
// A reload mid-game walks straight back to the same seat.
if (!G && sess && sess.code && (!invite || S.codeIn === sess.code)) joinRoom(sess.code, true);
