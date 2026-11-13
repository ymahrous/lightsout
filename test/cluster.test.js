// Consistency and durability of the room service when several servers share one store.
// Runs against the in-memory store by default, and against Postgres when
// TEST_DATABASE_URL is set (see README, "Testing").
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MemoryStore } from '../server/store/memory.js';
import { MemoryBus } from '../server/bus/memory.js';
import { Rooms } from '../server/rooms.js';
import { Metrics } from '../server/metrics.js';
import { node, seat, sleep, until, playTurn, FAST } from './helpers.js';
import * as E from '../shared/engine.js';

const PG = process.env.TEST_DATABASE_URL;
const backends = [{ name: 'memory', make: async () => { const store = new MemoryStore(), hub = new EventEmitter(); return { store, mk: () => node(store, hub), end: async () => {} }; } }];
if (PG) backends.push({
  name: 'postgres',
  make: async () => {
    const { PostgresStore } = await import('../server/store/postgres.js');
    const store = new PostgresStore(PG.split(','), { poolSize: 6 }); await store.init();
    const buses = [], hub = new EventEmitter();
    const mk = () => {
      const metrics = new Metrics();
      const bus = new MemoryBus(hub);
      buses.push(bus);
      return { rooms: new Rooms({ store, bus, metrics, timings: FAST }), metrics };
    };
    return { store, mk, end: async () => { for (const b of buses) await b.close(); await store.close(); } };
  }
});

for (const backend of backends) {
  test(`[${backend.name}] two servers, one room: everyone converges on the same state`, async () => {
    const { mk, end } = await backend.make(); const A = mk(), B = mk();
    try {
      const code = await A.rooms.create();
      const a = await seat(A.rooms, code, 'ann'), b = await seat(B.rooms, code, 'bob'), c = await seat(A.rooms, code, 'cat'), d = await seat(B.rooms, code, 'dan');
      await b.act('rename', 'Robert');           // a change made on server B...
      await until(() => a.state().pub.ps.some(p => p.n === 'Robert'), 3000, 'fan-out to server A');   // ...reaches players on server A
      assert.equal((await b.act('start')).err, 'not_allowed', 'rules are enforced on every server');
      await a.act('start');
      await until(() => [a, b, c, d].every(s => s.state().pub.ph === 'reveal'), 3000, 'deal');
      const v = a.state().v;
      assert.ok([b, c, d].every(s => s.state().v === v), 'same version everywhere');
      const roles = [a, b, c, d].map(s => s.state().priv.rl).sort().join('');
      assert.equal(roles, 'DMVV', 'each player received exactly their own card');
    } finally { await end(); }
  });

  test(`[${backend.name}] simultaneous actions from different servers: no update is lost`, async () => {
    const { store, mk, end } = await backend.make(); const nodes = [mk(), mk(), mk()];
    try {
      const code = await nodes[0].rooms.create();
      const ps = [];
      for (let i = 0; i < 12; i++) ps.push(await seat(nodes[i % 3].rooms, code, 'p' + i));
      await ps[0].act('start');
      // Twelve players on three servers all press "ready" in the same instant.
      await Promise.all(ps.map(p => p.act('ready')));
      const fin = await store.load(code);
      assert.equal(fin.G.ph, 'night', 'all twelve were counted, so the phase advanced');
      // Then all twelve seal a night move at once; every one must be recorded.
      await until(() => ps.every(p => p.state().v >= fin.v && p.state().priv.rl), 3000, 'night state');
      const before = (await store.load(code)).v;
      const results = await Promise.all(ps.map(p => { p.done = null; return playTurn(p); }));
      assert.deepEqual(results.map(r => r && r.err).filter(Boolean), [], 'no action was refused');
      const after = await store.load(code);
      const acted = Object.keys(after.G.na).length, mustAct = after.G.ps.filter(p => p.al).length;
      assert.ok(after.G.ph !== 'night' || acted === mustAct, `all night moves recorded (${acted}/${mustAct})`);
      assert.ok(after.v > before);
      const conflicts = nodes.reduce((n, x) => n + x.metrics.get('cas_conflicts'), 0);
      assert.ok(conflicts > 0, 'the servers really did collide, and the version check sorted it out');
      assert.equal(nodes.reduce((n, x) => n + x.metrics.get('transitions_abandoned'), 0), 0);
    } finally { await end(); }
  });

  test(`[${backend.name}] timers fire exactly once however many servers sweep`, async () => {
    const { store, mk, end } = await backend.make(); const nodes = [mk(), mk(), mk()];
    try {
      const code = await nodes[0].rooms.create();
      const host = await seat(nodes[0].rooms, code, 'host');
      for (let i = 0; i < 5; i++) await host.act('addbot');
      await host.act('start');
      // The host walks away from the table, so only timers and bots move the game.
      await nodes[0].rooms.mutate(code, (G, now) => { E.disconnect(G, 'host', host.cid, now); });
      // Every server sweeps as fast as it can.
      let stop = false;
      const sweepers = nodes.map(async n => { while (!stop) { await n.rooms.sweep(); await sleep(5); } });
      try { await until(async () => (await store.load(code)).G.ph === 'end', 20000, 'game over by timers alone'); }
      finally { stop = true; await Promise.all(sweepers); }
      const fin = await store.load(code);
      assert.ok(fin.G.win === 'T' || fin.G.win === 'M');
      assert.deepEqual(fin.G.hist.map(h => h.r), fin.G.hist.map((_, i) => i + 1), 'each round was resolved once, in order');
      await until(() => host.state().pub.ph === 'end', 2000, 'host told');
      assert.equal(host.state().v, fin.v, 'the player holds the final version');
      if (store.games) assert.equal(store.games.length, 1, 'archived once');
      else { const r = await store.pool(code).query('SELECT count(*)::int AS n FROM games WHERE code = $1', [code]); assert.equal(r.rows[0].n, 1, 'archived exactly once'); }
    } finally { await end(); }
  });

  test(`[${backend.name}] a server dies mid-game: nothing is lost, play continues elsewhere`, async () => {
    const { store, mk, end } = await backend.make(); let A = mk(); const B = mk();
    try {
      const code = await A.rooms.create();
      const tableA = [await seat(A.rooms, code, 'ann'), await seat(A.rooms, code, 'bob')];
      const tableB = [await seat(B.rooms, code, 'cat'), await seat(B.rooms, code, 'dan')];
      await tableA[0].act('start');
      await Promise.all([...tableA, ...tableB].map(p => p.act('ready')));
      const mid = await store.load(code);
      assert.equal(mid.G.ph, 'night');
      const roles = Object.fromEntries(mid.G.ps.map(p => [p.id, p.role]));
      // Server A vanishes without a goodbye: no disconnects are recorded, its memory is gone.
      A.rooms.stop(); A = null;
      // Its players reconnect to server B and find the game exactly where it was.
      const ann = await seat(B.rooms, code, 'ann'), bob = await seat(B.rooms, code, 'bob');
      assert.equal(ann.kind, 'in'); assert.equal(ann.state().pub.ph, 'night');
      assert.equal(ann.state().priv.rl, roles.ann); assert.equal(bob.state().priv.rl, roles.bob);
      const all = [ann, bob, ...tableB];
      let stop = false; const sweeper = (async () => { while (!stop) { await B.rooms.sweep(); await sleep(10); } })();
      try { await until(async () => { all.forEach(playTurn); return (await store.load(code)).G.ph === 'end'; }, 20000, 'game finished on the surviving server'); }
      finally { stop = true; await sweeper; }
      const fin = await store.load(code);
      assert.deepEqual(Object.fromEntries(fin.G.ps.map(p => [p.id, p.role])), roles, 'the cards never changed');
    } finally { await end(); }
  });

  test(`[${backend.name}] a dropped broadcast is repaired from the store`, async () => {
    const { mk, end } = await backend.make(); const A = mk(), B = mk();
    try {
      const code = await A.rooms.create();
      const a = await seat(A.rooms, code, 'ann'), b = await seat(B.rooms, code, 'bob');
      await B.rooms.bus.unsubscribe(code);         // server B goes deaf
      await a.act('rename', 'Annabel');
      await sleep(150);
      assert.ok(!b.state().pub.ps.some(p => p.n === 'Annabel'), 'server B missed the broadcast');
      await B.rooms.resync();
      assert.ok(b.state().pub.ps.some(p => p.n === 'Annabel'), 'the resync caught it up');
      assert.equal(b.state().v, a.state().v);
      assert.equal(B.metrics.get('resync_repairs'), 1);
    } finally { await end(); }
  });
}
