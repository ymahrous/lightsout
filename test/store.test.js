// One contract, every backend. Postgres is exercised when
// TEST_DATABASE_URL points at a disposable database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../server/store/memory.js';
import { MemoryBus } from '../server/bus/memory.js';
import { EventEmitter } from 'node:events';
import { sleep, until } from './helpers.js';

const PG = process.env.TEST_DATABASE_URL;
const code = () => 'T' + Math.random().toString(36).slice(2, 6).toUpperCase();
const json = o => JSON.stringify(o);

const stores = [{ name: 'memory', make: async () => new MemoryStore() }];
if (PG) stores.push({ name: 'postgres', make: async () => { const { PostgresStore } = await import('../server/store/postgres.js'); const s = new PostgresStore(PG.split(','), { poolSize: 4 }); await s.init(); return s; } });

for (const { name, make } of stores) {
  test(`[${name}] store: create, load, compare-and-set`, async () => {
    const s = await make(); const c = code(), far = Date.now() + 60000;
    try {
      assert.equal(await s.create(c, json({ n: 1 }), null, far), true);
      assert.equal(await s.create(c, json({ n: 99 }), null, far), false, 'a code can be claimed once');
      assert.deepEqual(await s.load(c), { v: 1, G: { n: 1 } });
      assert.equal(await s.load('NOPE1'), null);
      assert.equal(await s.save(c, 1, json({ n: 2 }), null, far), true);
      assert.equal(await s.save(c, 1, json({ n: 3 }), null, far), false, 'a stale writer loses');
      assert.deepEqual(await s.load(c), { v: 2, G: { n: 2 } });
      // Twenty writers race from the same version: exactly one wins.
      const wins = (await Promise.all(Array.from({ length: 20 }, (_, i) => s.save(c, 2, json({ n: 100 + i }), null, far)))).filter(Boolean).length;
      assert.equal(wins, 1);
      assert.equal((await s.load(c)).v, 3);
      assert.deepEqual([...(await s.versions([c, 'NOPE1']))], [[c, 3]]);
    } finally { await s.close(); }
  });

  test(`[${name}] store: due rooms are leased to one sweeper at a time`, async () => {
    const s = await make(); const a = code(), b = code(), far = Date.now() + 60000;
    try {
      await s.create(a, json({ id: 'a' }), Date.now() - 5, far);
      await s.create(b, json({ id: 'b' }), Date.now() + 60000, far);
      // Ten sweepers ask at once; the due room is handed out exactly once.
      const got = (await Promise.all(Array.from({ length: 10 }, () => s.leaseDue(50, 400)))).flat().filter(r => r.code === a || r.code === b);
      assert.equal(got.length, 1); assert.equal(got[0].code, a); assert.equal(got[0].v, 1);
      assert.ok(Math.abs(got[0].now - Date.now()) < 5000, 'the store reports its own clock');
      assert.equal((await s.leaseDue(50, 400)).filter(r => r.code === a).length, 0, 'hidden while leased');
      await sleep(450);
      assert.equal((await s.leaseDue(50, 400)).filter(r => r.code === a).length, 1, 'an abandoned lease expires and another sweeper picks it up');
      await s.release(a, 1, null);
      await sleep(450);
      assert.equal((await s.leaseDue(50, 400)).filter(r => r.code === a).length, 0, 'no deadline, no work');
    } finally { await s.close(); }
  });

  test(`[${name}] store: expired rooms are collected, finished games archived with the final write`, async () => {
    const s = await make(); const dead = code(), live = code();
    try {
      await s.create(dead, json({}), null, Date.now() - 1000);
      await s.create(live, json({}), null, Date.now() + 60000);
      assert.ok(await s.gc() >= 1);
      assert.equal(await s.load(dead), null);
      assert.ok(await s.load(live));
      const archive = { winner: 'T', rounds: 2, players: [{ n: 'Ann', role: 'V' }], history: [{ r: 1 }] };
      assert.equal(await s.save(live, 7, json({ ph: 'end' }), null, Date.now() + 60000, archive), false);
      assert.equal(await s.save(live, 1, json({ ph: 'end' }), null, Date.now() + 60000, archive), true);
      const n = s.games ? s.games.length : (await s.pool(live).query('SELECT count(*)::int AS n FROM games WHERE code = $1', [live])).rows[0].n;
      assert.equal(n, 1, 'archived once: not by the failed write, once by the successful one');
    } finally { await s.close(); }
  });
}

const buses = [{ name: 'memory', make: () => { const hub = new EventEmitter(); return () => new MemoryBus(hub); } }];

for (const { name, make } of buses) {
  test(`[${name}] bus: a publish reaches every subscribed server and nobody else`, async () => {
    const mk = make(); const a = await mk(), b = await mk(), c = await mk();
    const got = { a: [], b: [], c: [] };
    a.onMessage = (...m) => got.a.push(m); b.onMessage = (...m) => got.b.push(m); c.onMessage = (...m) => got.c.push(m);
    try {
      await Promise.all([a.init(), b.init(), c.init()]); await a.ping();
      const room = code();
      await a.subscribe(room); await b.subscribe(room); await c.subscribe(code());
      await sleep(50);
      await b.publish(room, 5, json({ hello: 'town' }));
      await until(() => got.a.length && got.b.length, 2000, 'delivery');
      assert.deepEqual(got.a, [[room, 5, { hello: 'town' }]]);
      assert.deepEqual(got.b, [[room, 5, { hello: 'town' }]]);
      assert.deepEqual(got.c, []);
      await a.unsubscribe(room);
      await b.publish(room, 6, json({}));
      await until(() => got.b.length === 2, 2000, 'second delivery');
      assert.equal(got.a.length, 1, 'unsubscribed servers hear nothing');
    } finally { await a.close(); await b.close(); await c.close(); }
  });
}
