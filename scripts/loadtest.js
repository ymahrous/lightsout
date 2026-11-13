#!/usr/bin/env node
// Fill a running deployment with real WebSocket players and play whole games.
//
//   node scripts/loadtest.js --url ws://localhost:8080/ws --rooms 200 --players 8
//   node scripts/loadtest.js --url ws://a:8080/ws,ws://b:8080/ws --rooms 500 --ramp 50
//
// It reports latency and throughput, and it fails (exit 1) if any table ends up
// inconsistent: players disagreeing on the final state, a version going backwards,
// or a role being shown to someone who should not see it.
import WebSocket from 'ws';
import { randomBytes } from 'node:crypto';

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map(a => { const [k, ...v] = a.trim().split(/\s+/); return [k, v.join(' ') || true]; }));
const URLS = String(args.url || 'ws://localhost:8080/ws').split(',');
const ROOMS = +args.rooms || 50, PLAYERS = Math.max(4, Math.min(12, +args.players || 8)), RAMP = +args.ramp || 25, TIMEOUT = (+args.timeout || 300) * 1000;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const lat = [], problems = [];
let msgsIn = 0, msgsOut = 0, opened = 0, reconnects = 0, refused = 0;
const flag = m => { if (problems.length < 20) problems.push(m); };

function player(url, name) {
  const p = { name, token: randomBytes(16).toString('hex'), id: null, code: null, st: null, done: null, pending: null, role: null, ws: null };
  p.connect = first => new Promise((resolve, reject) => {
    const ws = p.ws = new WebSocket(url); let settled = false;
    ws.on('open', () => { opened++; ws.send(JSON.stringify(first)); msgsOut++; });
    ws.on('message', d => {
      msgsIn++;
      const m = JSON.parse(d.toString());
      if (m.t === 'joined') { p.id = m.id; p.code = m.code; }
      else if (m.t === 'state') {
        if (p.st && m.v < p.st.v) flag(`${p.code}: version went backwards for ${name} (${p.st.v} -> ${m.v})`);
        if (p.pending && m.v > p.pending.v) { lat.push(performance.now() - p.pending.t); p.pending = null; }
        for (const q of m.pub.ps) if (q.rl && q.al && m.pub.ph !== 'end') flag(`${p.code}: a living role was broadcast`);
        if (m.priv.rl) { if (p.role && p.role !== m.priv.rl) flag(`${p.code}: ${name}'s role changed`); p.role = m.priv.rl; }
        p.st = m;
        if (!settled) { settled = true; resolve(p); }
        p.onState && p.onState();
      } else if (m.t === 'err') { if (m.e === 'slow_down' || m.e === 'busy' || m.e === 'unavailable') refused++; if (!settled) { settled = true; reject(new Error(m.e)); } }
    });
    ws.on('unexpected-response', (_, r) => { if (!settled) { settled = true; reject(new Error('http ' + r.statusCode)); } });
    ws.on('error', e => { if (!settled) { settled = true; reject(e); } });
    ws.on('close', () => { if (settled && !p.finished) { reconnects++; setTimeout(() => p.connect({ t: 'join', code: p.code, token: p.token, name }).catch(() => {}), 200 + Math.random() * 500); } });
  });
  p.act = (a, v) => { if (p.ws.readyState !== 1) return; if (!p.pending) p.pending = { t: performance.now(), v: p.st.v }; p.ws.send(JSON.stringify({ t: 'act', a, v })); msgsOut++; };
  // Do whatever the current phase asks of this player, once per phase.
  p.turn = () => {
    const { pub, priv } = p.st, me = pub.ps.find(q => q.i === p.id); if (!me) return;
    const key = pub.gid + pub.ph + pub.rd; if (p.done === key) return;
    const others = pub.ps.filter(q => q.al && q.i !== p.id), any = a => a[Math.floor(Math.random() * a.length)];
    if (pub.ph === 'reveal' || (pub.ph === 'day' && me.al)) { p.done = key; p.act('ready'); }
    else if (pub.ph === 'night' && me.al && priv.rl) {
      const mates = priv.mt || [];
      const ok = priv.rl === 'M' ? others.filter(q => !mates.includes(q.i)) : priv.rl === 'H' ? pub.ps.filter(q => q.al && q.i !== priv.ls) : others;
      p.done = key; if (ok.length) p.act('night', any(ok).i);
    } else if (pub.ph === 'vote' && me.al) { p.done = key; p.act('vote', Math.random() < 0.1 ? 'skip' : any(others).i); }
  };
  return p;
}

async function playTable(n) {
  const url = i => URLS[(n + i) % URLS.length];
  const ps = [];
  const host = player(url(0), `h${n}`);
  await host.connect({ t: 'create', token: host.token, name: host.name, tint: n });
  ps.push(host);
  await Promise.all(Array.from({ length: PLAYERS - 1 }, async (_, i) => {
    const p = player(url(i + 1), `p${n}_${i}`);
    await p.connect({ t: 'join', code: host.code, token: p.token, name: p.name, tint: i });
    ps.push(p);
  }));
  const over = new Promise(resolve => {
    const check = () => { if (ps.every(p => p.st && p.st.pub.ph === 'end')) resolve(); };
    for (const p of ps) p.onState = () => { if (p.st.pub.ph !== 'lobby' && p.st.pub.ph !== 'end') p.turn(); check(); };
  });
  host.act('start');
  await over;
  await sleep(300);   // let the last broadcast settle everywhere
  const v = host.st.v, win = host.st.pub.win, roles = Object.fromEntries(host.st.pub.ps.map(q => [q.i, q.rl]));
  for (const p of ps) {
    if (p.st.v !== v || p.st.pub.win !== win) flag(`${host.code}: ${p.name} ended at v${p.st.v}/${p.st.pub.win}, host at v${v}/${win}`);
    if (p.role !== roles[p.id]) flag(`${host.code}: ${p.name} was told ${p.role} but the table shows ${roles[p.id]}`);
    p.finished = true; p.ws.close();
  }
  return { transitions: v, rounds: host.st.pub.rd };
}

const pct = (a, q) => a.length ? a[Math.min(a.length - 1, Math.floor(a.length * q))] : 0;
const t0 = performance.now();
console.log(`${ROOMS} tables x ${PLAYERS} players = ${ROOMS * PLAYERS} sockets across ${URLS.length} server address(es), starting ${RAMP} tables per second`);
const guard = setTimeout(() => { console.error('timed out'); process.exit(2); }, TIMEOUT);
const results = await Promise.allSettled(Array.from({ length: ROOMS }, async (_, n) => { await sleep(n / RAMP * 1000); return playTable(n); }));
clearTimeout(guard);
const secs = (performance.now() - t0) / 1000, ok = results.filter(r => r.status === 'fulfilled').map(r => r.value), failed = results.filter(r => r.status === 'rejected');
lat.sort((a, b) => a - b);
const transitions = ok.reduce((n, r) => n + r.transitions, 0);
console.log(JSON.stringify({
  tables_finished: ok.length, tables_failed: failed.length, seconds: +secs.toFixed(1),
  sockets_opened: opened, reconnects, refused,
  committed_transitions: transitions, transitions_per_second: +(transitions / secs).toFixed(0),
  messages_sent: msgsOut, messages_received: msgsIn, messages_per_second: +((msgsIn + msgsOut) / secs).toFixed(0),
  action_to_state_ms: { p50: +pct(lat, 0.5).toFixed(1), p95: +pct(lat, 0.95).toFixed(1), p99: +pct(lat, 0.99).toFixed(1), max: +(lat.at(-1) || 0).toFixed(1) },
  consistency_violations: problems.length
}, null, 2));
if (failed.length) console.log('first failure:', String(failed[0].reason && failed[0].reason.message || failed[0].reason));
if (problems.length) console.log(problems.join('\n'));
process.exit(problems.length || failed.length ? 1 : 0);
