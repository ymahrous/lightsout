import { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { Rooms } from '../server/rooms.js';
import { Metrics } from '../server/metrics.js';
import { MemoryBus } from '../server/bus/memory.js';
import * as E from '../shared/engine.js';

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const until = async (fn, ms = 5000, label = 'condition') => {
  const t = Date.now();
  while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(10); }
  throw new Error('timed out waiting for ' + label);
};

// Short phases so a whole game takes a second or two.
export const FAST = { reveal: 0.4, night: 0.5, vote: 0.5, verdict: 0.1, graceNight: 0.05, graceVote: 0.05, emptyDay: 0.05, gone: 0.3, botMin: 0.05, botMax: 0.2 };

/** One "server" of the room service. Several nodes given the same store and hub behave like a cluster. */
export function node(store, hub = new EventEmitter(), timings = FAST) {
  const metrics = new Metrics();
  const rooms = new Rooms({ store, bus: new MemoryBus(hub), metrics, timings });
  return { rooms, metrics };
}

/** A stand-in for a connected socket, wired the way the gateway wires real ones. */
export async function seat(rooms, code, id, name = id) {
  const s = { code, pid: id, live: false, cid: 'c-' + id + '-' + Math.random().toString(36).slice(2, 6), msgs: [], sendRaw(str) { this.msgs.push(JSON.parse(str)); } };
  s.state = () => s.msgs.filter(m => m.t === 'state').at(-1);
  s.act = (a, v) => rooms.mutate(code, (G, now) => { const e = E.act(G, id, a, v, now); return e ? { err: e } : null; });
  await rooms.attach(s, code);
  const res = await rooms.mutate(code, (G, now) => { s.kind = E.join(G, { id, name, tint: 0, cid: s.cid }, now); });
  if (res.err) throw new Error(res.err);
  s.live = true; rooms.push(s);
  return s;
}

export const token = () => randomBytes(16).toString('hex');
export const pidOf = t => createHash('sha256').update(t).digest('hex').slice(0, 8);

/** A real WebSocket client that records what the server tells it. */
export function client(port, name) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const c = { ws, name, token: token(), msgs: [], id: null, code: null, closed: false };
  ws.on('message', d => { const m = JSON.parse(d.toString()); c.msgs.push(m); if (m.t === 'joined') { c.id = m.id; c.code = m.code; } });
  ws.on('close', () => { c.closed = true; });
  ws.on('error', () => {});
  c.open = new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  c.send = o => ws.send(JSON.stringify(o));
  c.state = () => c.msgs.filter(m => m.t === 'state').at(-1);
  c.errors = () => c.msgs.filter(m => m.t === 'err').map(m => m.e);
  c.act = (a, v) => c.send({ t: 'act', a, v });
  c.create = async () => { await c.open; c.send({ t: 'create', token: c.token, name, tint: 1 }); await until(() => c.state(), 3000, 'create'); return c.code; };
  c.join = async (code, extra) => { await c.open; c.send({ t: 'join', code, token: c.token, name, tint: 2, ...extra }); await until(() => c.state() || c.errors().length, 3000, 'join'); return c; };
  return c;
}

/** Make whichever move the current phase asks of this player. Works for stand-ins and real clients. */
export function playTurn(p) {
  const st = p.state(); if (!st) return;
  const pub = st.pub, me = pub.ps.find(q => q.i === (p.id || p.pid));
  if (!me) return;
  const key = pub.gid + pub.ph + pub.rd;
  if (p.done === key) return;
  const others = pub.ps.filter(q => q.al && q.i !== me.i);
  if (pub.ph === 'reveal' || (pub.ph === 'day' && me.al)) { p.done = key; return p.act('ready'); }
  if (pub.ph === 'night' && me.al && st.priv.rl) {
    const mates = st.priv.mt || [];
    const ok = st.priv.rl === 'M' ? others.filter(q => !mates.includes(q.i)) : st.priv.rl === 'H' ? pub.ps.filter(q => q.al && q.i !== st.priv.ls) : others;
    p.done = key; if (ok.length) return p.act('night', ok[Math.floor(Math.random() * ok.length)].i);
  }
  if (pub.ph === 'vote' && me.al) { p.done = key; return p.act('vote', others[Math.floor(Math.random() * others.length)].i); }
}
