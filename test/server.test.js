// The whole server over real HTTP and WebSocket connections.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';
import { MemoryStore } from '../server/store/memory.js';
import { MemoryBus } from '../server/bus/memory.js';
import { client, until, sleep, playTurn, FAST, token, pidOf } from './helpers.js';

const quiet = () => {};
const boot = (over = {}, parts = {}) => startServer({ port: 0, host: '127.0.0.1', timings: FAST, databaseUrls: [], production: false, ...over }, { log: quiet, ...parts });
const get = (app, path, headers) => fetch(`http://127.0.0.1:${app.port}${path}`, { headers });

test('http: the site, health checks and metrics', async () => {
  const app = await boot();
  try {
    let r = await get(app, '/');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(await r.text(), /<title>Lights Out Mafia<\/title>/);
    const etag = r.headers.get('etag');
    assert.equal((await get(app, '/', { 'If-None-Match': etag })).status, 304);
    for (const p of ['/js/app.js', '/js/scene.js', '/js/net.js', '/js/sound.js', '/shared/engine.js', '/styles.css', '/favicon.svg', '/vendor/three/three.module.js', '/vendor/three/three.core.js', '/vendor/fonts/manrope.woff2']) {
      r = await get(app, p); assert.equal(r.status, 200, p); await r.arrayBuffer();
    }
    r = await get(app, '/js/app.js', { 'Accept-Encoding': 'gzip' });
    assert.equal(r.headers.get('content-encoding'), 'gzip');
    assert.equal((await get(app, '/healthz')).status, 200);
    assert.equal((await get(app, '/readyz')).status, 200);
    assert.match(await (await get(app, '/metrics')).text(), /lom_connections \d+/);
    // Nothing outside the published files can be fetched.
    for (const p of ['/server/index.js', '/package.json', '/..%2fpackage.json', '/js/../../package.json', '/.env', '/node_modules/ws/package.json']) assert.equal((await get(app, p)).status, 404, p);
    assert.equal((await fetch(`http://127.0.0.1:${app.port}/`, { method: 'POST' })).status, 405);
    // Every page opens at its clean address, and a trailing slash leads to the same page.
    for (const [p, title] of [['/faq', 'FAQ'], ['/privacy', 'Privacy Policy'], ['/terms', 'Terms of Service']]) {
      r = await get(app, p); assert.equal(r.status, 200, p); assert.match(await r.text(), new RegExp(`<title>${title} — `), p);
      r = await fetch(`http://127.0.0.1:${app.port}${p}/?ref=x`, { redirect: 'manual' });
      assert.equal(r.status, 301, p + '/'); assert.equal(r.headers.get('location'), p + '?ref=x');
    }
    r = await get(app, '/no-such-page'); assert.equal(r.status, 404); assert.match(await r.text(), /<title>Page not found/);
    // Installable: a manifest, icons, and a service worker stamped with the current version.
    r = await get(app, '/manifest.webmanifest');
    assert.match(r.headers.get('content-type'), /application\/manifest\+json/);
    const man = await r.json();
    for (const i of man.icons) assert.equal((await get(app, i.src)).status, 200, i.src);
    const sw = await (await get(app, '/sw.js')).text();
    const stamp = sw.match(/const VERSION = '([^']*)'/)[1];
    assert.match(stamp, /^[0-9a-f]{12}$/, 'the service worker carries a real version');
    for (const u of sw.match(/const SHELL = \[([\s\S]*?)\];/)[1].match(/'[^']+'/g).map(x => x.slice(1, -1))) assert.equal((await get(app, u)).status, 200, 'cached file exists: ' + u);
  } finally { await app.close(); }
});

test('rooms: create, join by code, and the errors a player can hit', async () => {
  const app = await boot();
  try {
    const ann = client(app.port, 'Ann'); const code = await ann.create();
    assert.match(code, /^[A-HJKMNP-Z2-9]{5}$/);
    assert.equal(ann.id, pidOf(ann.token), 'the public id is derived from the secret token');
    const bob = await client(app.port, 'Ann').join(code.toLowerCase());   // codes are case-insensitive
    await until(() => ann.state().pub.ps.length === 2, 2000, 'second seat');
    assert.deepEqual(ann.state().pub.ps.map(p => p.n), ['Ann', 'Ann 2']);
    assert.equal(ann.state().pub.host, ann.id);
    assert.ok(!JSON.stringify(ann.msgs).includes(bob.token), 'tokens are never sent to other players');

    const lost = await client(app.port, 'X').join('ZZZZZ');
    assert.deepEqual(lost.errors(), ['no_room']);
    const bad = client(app.port, 'Y'); await bad.open;
    bad.send({ t: 'join', code, token: 'not-a-token' }); bad.ws.send('{{{'); bad.send({ t: 'act', a: 'start' }); bad.send({ t: 'nope' });
    await until(() => bad.errors().length === 4, 2000, 'four errors');
    assert.deepEqual(bad.errors().sort(), ['bad_message', 'bad_message', 'bad_token', 'not_in_room']);

    bob.act('start');
    await until(() => bob.errors().includes('not_allowed'), 2000, 'guest cannot start');
    ann.act('start');
    await until(() => ann.errors().includes('too_few'), 2000, 'two is not enough');
    [ann, bob, lost, bad].forEach(c => c.ws.close());
  } finally { await app.close(); }
});

test('a full game over real sockets, and nobody is ever sent a secret that is not theirs', async () => {
  const app = await boot();
  try {
    const host = client(app.port, 'Host'); const code = await host.create();
    const players = [host, await client(app.port, 'Mira').join(code), await client(app.port, 'Bruno').join(code)];
    const watcher = await client(app.port, 'Late').join(code); watcher.send({ t: 'leave' });
    host.act('addbot'); host.act('addbot'); host.act('addbot');
    await until(() => host.state().pub.ps.length === 6, 2000, 'six seats');
    host.act('start');
    const spy = await (async () => { await until(() => host.state().pub.ph !== 'lobby', 2000, 'dealt'); return client(app.port, 'Spy').join(code); })();
    await until(() => { players.forEach(playTurn); return players.every(p => p.state().pub.ph === 'end'); }, 30000, 'the end of the game');

    const fin = host.state();
    assert.ok(fin.pub.win === 'T' || fin.pub.win === 'M');
    assert.ok(players.every(p => p.state().v === fin.v), 'everyone holds the same final version');
    const roleAtEnd = Object.fromEntries(fin.pub.ps.map(p => [p.i, p.rl]));

    for (const c of [...players, spy]) {
      const states = c.msgs.filter(m => m.t === 'state');
      assert.ok(states.every((m, i) => i === 0 || m.v >= states[i - 1].v), 'versions never go backwards');
      for (const m of states) {
        for (const p of m.pub.ps) if (p.rl) assert.ok(!p.al || m.pub.ph === 'end', 'a living player\'s role was broadcast');
        assert.ok(!('na' in m.pub) && !('intel' in m.pub) && !JSON.stringify(m.pub).includes('"role"'));
        if (m.priv.rl) assert.equal(m.priv.rl, roleAtEnd[c.id], 'a player was told a role that is not theirs');
        if (m.priv.mt) assert.equal(roleAtEnd[c.id], 'M', 'only Mafia learn the Mafia');
        if (m.priv.in) assert.equal(roleAtEnd[c.id], 'D', 'only the Detective gets case notes');
        if (m.priv.all) assert.equal(m.pub.ps.find(p => p.i === c.id).al, 0, 'only ghosts see every card');
      }
    }
    assert.ok(spy.msgs.filter(m => m.t === 'state').every(m => Object.keys(m.priv).length === 0), 'a watcher is told nothing private');
    assert.equal(app.store.games.length, 1, 'the finished game was archived');
    assert.equal(app.store.games[0].winner, fin.pub.win);
    [...players, spy, watcher].forEach(c => c.ws.close());
  } finally { await app.close(); }
});

test('dropping the connection keeps the seat; a new tab can take it over only while it is empty', async () => {
  const app = await boot({ timings: { ...FAST, reveal: 30, night: 30 } });
  try {
    const host = client(app.port, 'Host'); const code = await host.create();
    const mira = await client(app.port, 'Mira').join(code), bruno = await client(app.port, 'Bruno').join(code), zed = await client(app.port, 'Zed').join(code);
    host.act('start');
    await until(() => mira.state().priv.rl, 2000, 'cards');
    const card = mira.state().priv.rl;

    // A thief with Mira's public id but not her token gets nowhere: ids are not credentials.
    const thief = await client(app.port, 'Thief').join(code, { prev: token() });
    assert.notEqual(thief.id, mira.id);
    assert.deepEqual(thief.state().priv, {});
    // Even with her real token as `prev`, a second tab cannot take the seat while she is connected.
    const twin = await client(app.port, 'Twin').join(code, { prev: mira.token });
    assert.notEqual(twin.id, mira.id, 'no takeover of an occupied seat');

    mira.ws.close();
    await until(() => host.state().pub.ps.find(p => p.i === mira.id).off === 1, 2000, 'marked away');
    // Same tab reconnects (same token): same seat, same card.
    const back = client(app.port, 'Mira'); back.token = mira.token; await back.join(code);
    assert.equal(back.id, mira.id);
    assert.equal(back.state().priv.rl, card);
    await until(() => !host.state().pub.ps.find(p => p.i === mira.id).off, 2000, 'back at the table');

    // The tab is closed for good; a fresh tab in the same browser presents the old token as `prev`.
    back.ws.close();
    await until(() => host.state().pub.ps.find(p => p.i === mira.id).off === 1, 2000, 'away again');
    const fresh = await client(app.port, 'Mira').join(code, { prev: mira.token });
    assert.equal(fresh.msgs.find(m => m.t === 'joined').adopted, true);
    assert.equal(fresh.id, mira.id);
    assert.equal(fresh.state().priv.rl, card);
    [host, bruno, zed, thief, twin, fresh].forEach(c => c.ws.close());
  } finally { await app.close(); }
});

test('two servers behind one store: a graceful restart loses nothing', async () => {
  const store = new MemoryStore(), hub = new EventEmitter();
  const A = await boot({}, { store, bus: new MemoryBus(hub) }), B = await boot({}, { store, bus: new MemoryBus(hub) });
  try {
    const ann = client(A.port, 'Ann'); const code = await ann.create();
    const bob = await client(B.port, 'Bob').join(code);          // a different server, the same room
    await until(() => ann.state().pub.ps.length === 2, 2000, 'cross-server join');
    ann.act('addbot'); ann.act('addbot'); ann.act('addbot');
    await until(() => bob.state().pub.ps.length === 5, 2000, 'cross-server fan-out');
    ann.act('start');
    await until(() => bob.state().pub.ph === 'reveal' && ann.state().priv.rl, 2000, 'deal');
    const card = ann.state().priv.rl, before = ann.state().v;

    await A.close({ keepBackends: true });                       // deploy: server A goes away
    await until(() => ann.closed, 2000, 'client told to move');
    assert.ok(ann.msgs.some(m => m.t === 'bye'));
    const ann2 = client(B.port, 'Ann'); ann2.token = ann.token; await ann2.join(code);
    assert.equal(ann2.id, ann.id);
    assert.equal(ann2.state().priv.rl, card, 'same card after the move');
    assert.ok(ann2.state().v >= before);
    assert.ok(!ann2.state().pub.ps.find(p => p.i === ann.id).off, 'a planned restart never marks players away');
    const two = [ann2, bob];
    await until(() => { two.forEach(playTurn); return two.every(p => p.state().pub.ph === 'end'); }, 30000, 'finish on server B');
    two.forEach(c => c.ws.close());
  } finally { await B.close(); }
});

test('behind a proxy, limits follow the address in the configured header, not the proxy\'s own', async () => {
  const app = await boot({ maxConnPerIp: 1, proxyHeader: 'x-real-ip' });
  const dial = ip => new Promise(res => { const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`, { headers: { 'X-Real-IP': ip } }); ws.on('open', () => res(ws)); ws.on('unexpected-response', (_, r) => res(r.statusCode)); ws.on('error', () => {}); });
  try {
    // Every connection arrives from the same socket address (the "proxy"), yet two players are two addresses.
    const a = await dial('203.0.113.7'), b = await dial('203.0.113.8');
    assert.ok(a instanceof WebSocket && b instanceof WebSocket, 'different players are not lumped together');
    assert.equal(await dial('203.0.113.7'), 429, 'the same player is still limited');
    a.close(); b.close(); await sleep(50);
  } finally { await app.close(); }
});

test('abuse limits: message floods, oversized frames, too many sockets, too many rooms', async () => {
  const app = await boot({ maxConnPerIp: 4, createPerMinute: 2 });
  try {
    const flood = client(app.port, 'Flood'); await flood.open;
    for (let i = 0; i < 200; i++) flood.send({ t: 'ping' });
    await until(() => flood.closed, 3000, 'flooder disconnected');
    assert.ok(flood.errors().includes('slow_down'));

    const big = client(app.port, 'Big'); await big.open;
    big.ws.send(JSON.stringify({ t: 'create', token: token(), name: 'x'.repeat(5000) }));
    await until(() => big.closed, 3000, 'oversized frame closes the socket');

    const maker = client(app.port, 'Maker'); await maker.open;
    for (let i = 0; i < 3; i++) maker.send({ t: 'create', token: maker.token, name: 'M' });
    await until(() => maker.errors().includes('slow_down'), 3000, 'room creation is rationed');
    assert.equal(maker.msgs.filter(m => m.t === 'joined').length, 2);

    const socks = []; for (let i = 0; i < 3; i++) { const c = client(app.port, 'S' + i); await c.open; socks.push(c); }
    const refused = await new Promise(res => { const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`); ws.on('unexpected-response', (_, r) => res(r.statusCode)); ws.on('open', () => res('opened')); ws.on('error', () => {}); });
    assert.equal(refused, 429, 'the fifth socket from one address is refused');
    [maker, ...socks].forEach(c => c.ws.close());
    await sleep(50);
  } finally { await app.close(); }
});

test('referee over real sockets: only the referee is sent every card, and the referee runs the clock', async () => {
  const app = await boot({ timings: { ...FAST, reveal: 60, night: 60, vote: 60, verdict: 60 } });
  try {
    const host = client(app.port, 'Host'); const code = await host.create();
    const ref = await client(app.port, 'Ref').join(code);
    const others = [await client(app.port, 'Ann').join(code), await client(app.port, 'Bob').join(code), await client(app.port, 'Cy').join(code)];
    await until(() => host.state().pub.ps.length === 5, 2000, 'five seats');
    host.act('referee', ref.id);
    await until(() => host.state().pub.ps.find(p => p.i === ref.id).ref === 1, 2000, 'referee named');
    host.act('start');
    await until(() => ref.state().pub.ph === 'reveal' && ref.state().priv.all, 2000, 'deal');
    assert.equal(ref.state().priv.all.length, 5);
    assert.equal(ref.state().priv.all[ref.state().pub.ps.findIndex(p => p.i === ref.id)], 'R');
    for (const c of [host, ...others]) assert.ok(c.state().priv.rl && !c.state().priv.all && !c.state().priv.na, 'players get only their own card');
    const phases = [];
    for (let i = 0; i < 4; i++) { const before = ref.state().v; phases.push(ref.state().pub.ph); ref.act('advance'); await until(() => ref.state().v > before, 2000, 'advance'); }
    assert.deepEqual(phases, ['reveal', 'night', 'day', 'vote']);
    assert.equal(ref.state().pub.ph, 'verdict');
    host.act('advance');
    await until(() => host.errors().includes('not_allowed'), 2000, 'a player cannot advance');
    [host, ref, ...others].forEach(c => c.ws.close());
  } finally { await app.close(); }
});
