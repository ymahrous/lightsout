import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../shared/engine.js';

/** A lobby with n humans (p0 is host) and some bots. */
function table(n, bots = 0, timings) {
  const G = E.newRoom('TEST2', { timings });
  for (let i = 0; i < n; i++) E.join(G, { id: 'p' + i, name: 'P' + i, tint: i, cid: 'c' + i }, 0);
  for (let i = 0; i < bots; i++) assert.equal(E.act(G, 'p0', 'addbot', undefined, 0), null);
  return G;
}
/** Deal with fixed roles so outcomes are predictable. */
function deal(G, roles) {
  assert.equal(E.act(G, 'p0', 'start', undefined, 1000), null);
  roles.split('').forEach((r, i) => { G.ps[i].role = r; });
  E.toNight(G, 2000);
  return G;
}
const noLeak = G => {
  const pub = E.pubOf(G);
  for (const p of pub.ps) if (p.al && G.ph !== 'end') assert.equal(p.rl, undefined, 'a living role leaked into the public view');
  assert.ok(!JSON.stringify(pub).includes('"role"'));
};

test('role mix always fits the table and keeps the Mafia a minority', () => {
  for (let n = E.MIN_PLAYERS; n <= E.MAX_PLAYERS; n++) {
    const m = E.mix(n);
    assert.equal(m.M + m.D + m.H + m.V, n);
    assert.ok(m.M >= 1 && m.M * 2 < n, `mafia must be a minority at ${n}`);
    assert.equal(m.D, 1);
  }
});

test('lobby: seats, names, host powers', () => {
  const G = table(3);
  assert.equal(G.host, 'p0');
  assert.equal(E.join(G, { id: 'x1', name: 'P1', tint: 2 }, 0), 'in');
  assert.equal(E.player(G, 'x1').n, 'P1 2', 'duplicate names are told apart');
  assert.equal(E.join(G, { id: 'x2', name: '  <b>Zed</b>\n ', tint: 99 }, 0), 'in');
  assert.equal(E.player(G, 'x2').n, 'bZed/b', 'markup characters are stripped');
  assert.equal(E.player(G, 'x2').a, 99 % E.TINTS);
  assert.equal(E.act(G, 'p1', 'start', undefined, 0), 'not_allowed', 'only the host deals');
  assert.equal(E.act(G, 'p1', 'addbot', undefined, 0), 'not_allowed');
  assert.equal(E.act(G, 'p1', 'rename', 'Mira', 0), null);
  assert.equal(E.player(G, 'p1').n, 'Mira');
  assert.equal(E.act(G, 'p0', 'kick', 'x2', 0), null);
  assert.equal(E.player(G, 'x2'), undefined);
  assert.equal(E.act(G, 'p0', 'kick', 'p0', 0), 'not_allowed');
  for (let i = G.ps.length; i < E.MAX_PLAYERS; i++) assert.equal(E.act(G, 'p0', 'addbot', undefined, 0), null);
  assert.equal(E.act(G, 'p0', 'addbot', undefined, 0), 'full');
  assert.equal(E.join(G, { id: 'late', name: 'Late' }, 0), 'watch', 'a full table can only be watched');
  assert.equal(new Set(G.ps.map(p => p.n)).size, G.ps.length, 'every name is unique');
});

test('a game needs four players, and away players are not dealt in', () => {
  const G = table(4);
  E.disconnect(G, 'p3', 'c3', 0);
  assert.equal(E.act(G, 'p0', 'start', undefined, 1), 'too_few');
  E.join(G, { id: 'p3', cid: 'c3b' }, 2);
  assert.equal(E.act(G, 'p0', 'start', undefined, 3), null);
  assert.equal(G.ph, 'reveal');
});

test('dealing gives the promised roles and each screen only its own secrets', () => {
  const G = table(8);
  E.act(G, 'p0', 'start', undefined, 0);
  const counts = {}; G.ps.forEach(p => { counts[p.role] = (counts[p.role] || 0) + 1; });
  assert.deepEqual(counts, { M: 2, D: 1, H: 1, V: 4 });
  noLeak(G);
  const maf = G.ps.filter(p => p.role === 'M'), town = G.ps.find(p => p.role === 'V');
  assert.deepEqual(E.privOf(G, maf[0].id).mt, [maf[1].id], 'Mafia see their partners');
  assert.deepEqual(E.privOf(G, town.id), { rl: 'V' }, 'a townsperson learns only their own role');
  assert.deepEqual(E.privOf(G, 'stranger'), {}, 'a watcher learns nothing');
});

test('night: who may be picked', () => {
  const G = deal(table(6), 'MMDHVV');   // forced roles
  assert.equal(E.act(G, 'p0', 'night', 'p1', 3000), 'bad_target', 'Mafia cannot pick a partner');
  assert.equal(E.act(G, 'p4', 'night', 'p4', 3000), 'bad_target', 'no self-whisper');
  assert.equal(E.act(G, 'p3', 'night', 'p3', 3000), null, 'the Doctor may guard themselves');
  assert.equal(E.act(G, 'p0', 'night', 'nobody', 3000), 'bad_target');
  assert.equal(E.act(G, 'ghost', 'night', 'p1', 3000), 'not_seated');
});

test('night: the Doctor saves, the Detective learns, whispers are counted', () => {
  const G = deal(table(6), 'MDHVVV');
  E.act(G, 'p0', 'night', 'p3', 3000);   // Mafia goes for p3
  E.act(G, 'p2', 'night', 'p3', 3000);   // Doctor guards p3
  E.act(G, 'p1', 'night', 'p0', 3000);   // Detective checks the Mafia
  E.act(G, 'p3', 'night', 'p0', 3000); E.act(G, 'p4', 'night', 'p0', 3000); E.act(G, 'p5', 'night', 'p4', 3000);
  E.resolveNight(G, 4000);
  assert.equal(G.ph, 'day');
  assert.deepEqual(G.news, { k: null, sv: 1, w: [['p0', 2]] });
  assert.ok(G.ps.every(p => p.al), 'nobody died');
  assert.deepEqual(E.privOf(G, 'p1').in, [['p0', 1]], 'the Detective has a case note');
  assert.equal(E.privOf(G, 'p4').in, undefined, 'nobody else does');
  noLeak(G);
  // Next night the Doctor cannot guard the same player.
  E.toVote(G, 5000); E.resolveVote(G, undefined, 6000); E.afterVerdict(G, 7000);
  assert.equal(G.ph, 'night');
  assert.equal(E.act(G, 'p2', 'night', 'p3', 8000), 'bad_target');
  E.act(G, 'p0', 'night', 'p3', 8000);
  E.resolveNight(G, 9000);
  assert.equal(E.player(G, 'p3').al, 0);
  assert.equal(E.pubOf(G).ps.find(p => p.i === 'p3').rl, 'V', 'a dead player\'s card is shown');
  assert.equal(E.privOf(G, 'p3').all, 'MDHVVV', 'a ghost sees every card');
});

test('vote: most votes is out, ties and heavy skips send nobody', () => {
  const run = votes => {
    const G = deal(table(6), 'MDHVVV'); E.resolveNight(G, 3000); E.toVote(G, 4000);
    for (const [who, t] of Object.entries(votes)) assert.equal(E.act(G, who, 'vote', t, 5000), null);
    E.resolveVote(G, undefined, 6000); return G;
  };
  let G = run({ p1: 'p0', p2: 'p0', p3: 'p4', p4: 'skip' });
  assert.equal(G.vd.out, 'p0'); assert.equal(E.player(G, 'p0').al, 0);
  G = run({ p1: 'p0', p2: 'p0', p3: 'p4', p5: 'p4' });
  assert.equal(G.vd.out, null); assert.equal(G.vd.tie, 1);
  G = run({ p1: 'p0', p2: 'skip', p3: 'skip', p4: 'skip' });
  assert.equal(G.vd.out, null); assert.equal(G.vd.tie, 0);

  G = deal(table(6), 'MDHVVV'); E.resolveNight(G, 3000); E.toVote(G, 4000);
  assert.equal(E.act(G, 'p1', 'vote', 'p1', 5000), 'bad_target', 'no voting for yourself');
  G.ps[5].al = 0;
  assert.equal(E.act(G, 'p5', 'vote', 'p0', 5000), 'bad_target', 'the dead do not vote');
  assert.equal(E.act(G, 'p1', 'vote', 'p5', 5000), 'bad_target', 'nor can they be voted for');
});

test('the game ends when the Mafia is gone or can no longer be outvoted', () => {
  let G = deal(table(4), 'MDVV'); E.resolveNight(G, 3000); E.toVote(G, 4000);
  ['p1', 'p2', 'p3'].forEach(p => E.act(G, p, 'vote', 'p0', 5000));
  E.resolveVote(G, undefined, 6000); E.afterVerdict(G, 7000);
  assert.equal(G.ph, 'end'); assert.equal(G.win, 'T');
  assert.equal(E.pubOf(G).ps.every(p => p.rl), true, 'every card is face up at the end');

  G = deal(table(4), 'MDVV');
  E.act(G, 'p0', 'night', 'p1', 3000); E.resolveNight(G, 4000);   // 1 Mafia v 2 town
  assert.equal(G.ph, 'day');
  E.toVote(G, 5000); E.resolveVote(G, undefined, 6000); E.afterVerdict(G, 7000);
  E.act(G, 'p0', 'night', 'p2', 8000); E.resolveNight(G, 9000);   // 1 v 1
  assert.equal(G.ph, 'end'); assert.equal(G.win, 'M');
});

test('actions are idempotent', () => {
  const G = deal(table(6), 'MDHVVV');
  E.act(G, 'p0', 'night', 'p3', 3000);
  const once = JSON.stringify(G);
  E.act(G, 'p0', 'night', 'p3', 3000);
  assert.equal(JSON.stringify(G), once);
});

test('time: deadlines drive every phase without anyone acting', () => {
  const G = table(1, 5);
  E.act(G, 'p0', 'start', undefined, 0);
  assert.equal(E.nextDeadline(G), 30000);
  assert.equal(E.tick(G, 29999), false);
  assert.equal(E.tick(G, 30000), true);
  assert.equal(G.ph, 'night');
  // Run the clock forward from deadline to deadline, as the server's sweeper does.
  let now = 30000, steps = 0;
  while (G.ph !== 'end') {
    const d = E.nextDeadline(G);
    assert.ok(d !== null && d >= now, `a running game always has a next deadline (phase ${G.ph})`);
    now = d; assert.equal(E.tick(G, now), true, `the deadline at ${G.ph} did something`);
    noLeak(G);
    assert.ok(++steps < 400, 'the game terminates');
  }
  assert.ok(G.win === 'T' || G.win === 'M');
  assert.equal(E.nextDeadline(G), null);
});

test('time: phases end early once everyone present has acted', () => {
  const G = table(4, 0, { graceNight: 1, graceVote: 1 });
  E.act(G, 'p0', 'start', undefined, 0);
  ['p0', 'p1', 'p2'].forEach(p => E.act(G, p, 'ready', undefined, 100));
  assert.equal(E.tick(G, 100), false, 'still waiting for p3');
  E.disconnect(G, 'p3', 'c3', 200);
  assert.equal(E.tick(G, 200), true, 'an away player is not waited for');
  assert.equal(G.ph, 'night');
  for (const p of E.alive(G)) if (p.id !== 'p3') E.act(G, p.id, 'night', E.targetsFor(G, p)[0].id, 300);
  assert.equal(E.tick(G, 300), true);
  assert.equal(G.grace, 1300, 'a short pause before dawn');
  assert.equal(E.nextDeadline(G), 1300);
  E.tick(G, 1300);
  assert.ok(G.ph === 'day' || G.ph === 'end');
});

test('bots vote on a schedule and the host can call the vote', () => {
  const G = deal(table(2, 4), 'MDHVVV');
  E.resolveNight(G, 3000);
  assert.equal(E.act(G, 'p1', 'callvote', undefined, 4000), 'not_allowed');
  assert.equal(E.act(G, 'p0', 'callvote', undefined, 4000), null);
  assert.equal(G.ph, 'vote');
  const bots = E.alive(G).filter(p => p.b);
  assert.equal(Object.keys(G.bv).length, bots.length);
  const first = Math.min(...Object.values(G.bv));
  assert.equal(E.nextDeadline(G), first);
  E.tick(G, first);
  assert.equal(Object.keys(G.vt).length, 1, 'exactly the bot that was due has voted');
});

test('connections: stale disconnects are ignored, empty lobby seats are freed, host powers move on', () => {
  const G = table(3);
  E.join(G, { id: 'p1', cid: 'new' }, 10);            // p1 reconnects on a new socket
  E.disconnect(G, 'p1', 'c1', 20);                    // the old socket's close arrives late
  assert.equal(E.player(G, 'p1').off, 0);
  E.disconnect(G, 'p0', 'c0', 1000);
  assert.equal(E.hostOf(G), 'p1', 'the next present player holds host powers');
  assert.equal(E.nextDeadline(G), 21000);
  E.tick(G, 21000);
  assert.equal(E.player(G, 'p0'), undefined);
  assert.equal(G.host, 'p1');
  E.quit(G, 'p2', 22000);
  assert.deepEqual(G.ps.map(p => p.id), ['p1']);

  // Leaving a running game keeps the seat (the role must stay in play) but stops the table waiting.
  const R = table(4); E.act(R, 'p0', 'start', undefined, 0);
  E.quit(R, 'p3', 10);
  assert.equal(E.player(R, 'p3').off, 1);
  ['p0', 'p1', 'p2'].forEach(p => E.act(R, p, 'ready', undefined, 20));
  assert.equal(E.tick(R, 20), true); assert.equal(R.ph, 'night');
});

test('five hundred random tables all finish with a winner and never leak a role', () => {
  for (let g = 0; g < 500; g++) {
    const humans = 1 + Math.floor(Math.random() * 3), seats = E.MIN_PLAYERS + Math.floor(Math.random() * 9);
    const G = table(Math.min(humans, seats), Math.max(0, seats - humans));
    E.act(G, 'p0', 'start', undefined, 0);
    let now = 0, steps = 0;
    while (G.ph !== 'end') {
      // Humans act at random; sometimes they do nothing and the clock decides.
      for (const p of G.ps.filter(q => !q.b && q.al)) {
        if (Math.random() < 0.3) continue;
        if (G.ph === 'reveal' || G.ph === 'day') E.act(G, p.id, 'ready', undefined, now);
        if (G.ph === 'night') { const t = E.targetsFor(G, p); if (t.length) E.act(G, p.id, 'night', t[Math.floor(Math.random() * t.length)].id, now); }
        if (G.ph === 'vote') { const t = E.alive(G).filter(q => q.id !== p.id); E.act(G, p.id, 'vote', Math.random() < 0.15 ? 'skip' : t[Math.floor(Math.random() * t.length)].id, now); }
      }
      E.tick(G, now);
      if (G.ph === 'end') break;
      now = Math.max(now, E.nextDeadline(G)); E.tick(G, now);
      noLeak(G);
      const a = E.alive(G);
      assert.ok(a.length >= 1 && a.length <= seats);
      assert.ok(++steps < 600, 'the game terminates');
    }
    const maf = E.alive(G).filter(p => p.role === 'M').length, town = E.alive(G).length - maf;
    assert.equal(G.win, maf === 0 ? 'T' : 'M');
    if (G.win === 'M') assert.ok(maf >= town);
    assert.ok(G.hist.length >= 1 && G.hist.length === G.rd);
  }
});

test('referee: picked by the host, dealt no card, never targeted or counted', () => {
  const G = table(6);
  assert.equal(E.act(G, 'p1', 'referee', 'p2', 0), 'not_allowed', 'only the host picks the referee');
  assert.equal(E.act(G, 'p0', 'referee', 'p5', 0), null);
  assert.equal(E.act(G, 'p0', 'referee', 'p2', 0), null, 'picking again moves the job');
  assert.deepEqual(G.ps.filter(p => p.ref).map(p => p.id), ['p2']);
  E.act(G, 'p0', 'addbot', undefined, 0);
  assert.equal(E.act(G, 'p0', 'referee', G.ps.at(-1).id, 0), 'bad_target', 'a bot cannot referee');
  assert.equal(E.act(G, 'p0', 'start', undefined, 0), null);
  assert.equal(E.player(G, 'p2').role, undefined, 'the referee has no card');
  assert.equal(E.players(G).length, 6, 'six players are dealt in: five humans and the bot');
  assert.deepEqual(Object.keys(Object.fromEntries(E.players(G).map(p => [p.role, 1]))).sort(), ['D', 'H', 'M', 'V']);
  assert.ok(!E.alive(G).some(p => p.ref));
  const pub = E.pubOf(G);
  assert.equal(pub.ps.find(p => p.i === 'p2').ref, 1);
  noLeak(G);
  // The deal does not wait for the referee.
  E.players(G).filter(p => !p.b).forEach(p => E.act(G, p.id, 'ready', undefined, 10));
  assert.equal(E.act(G, 'p2', 'ready', undefined, 10), 'not_allowed');
  E.tick(G, 10);
  assert.equal(G.ph, 'night');
  // Nobody can pick the referee, and the referee cannot pick anyone.
  const maf = E.players(G).find(p => p.role === 'M');
  assert.equal(E.act(G, maf.id, 'night', 'p2', 20), 'bad_target');
  assert.equal(E.act(G, 'p2', 'night', maf.id, 20), 'bad_target');
});

test('referee: sees every card and live night move; others learn nothing new', () => {
  const G = table(6);
  E.act(G, 'p0', 'referee', 'p5', 0);
  E.act(G, 'p0', 'start', undefined, 0);
  E.players(G).forEach((p, i) => { p.role = 'MDHVV'[i]; });     // p0..p4
  E.toNight(G, 100);
  E.act(G, 'p0', 'night', 'p3', 200);
  const ref = E.privOf(G, 'p5');
  assert.equal(ref.ref, 1);
  assert.equal(ref.all, 'MDHVVR', 'one letter per seat, the referee as R');
  assert.deepEqual(ref.na, { p0: 'p3' }, 'night moves as they are made');
  assert.equal(ref.rl, undefined);
  for (const id of ['p0', 'p1', 'p2', 'p3', 'p4']) { const o = E.privOf(G, id); assert.equal(o.na, undefined); assert.equal(o.all, undefined); }
  // A ghost's view of every card stays aligned with the seats when a referee sits among them.
  E.resolveNight(G, 300);
  assert.equal(E.privOf(G, 'p3').all, 'MDHVVR');
});

test('referee: moves every phase on, and cannot vote or be voted for', () => {
  const G = table(5);
  E.act(G, 'p0', 'referee', 'p0', 0);          // the host referees
  E.act(G, 'p0', 'addbot', undefined, 0);
  assert.equal(E.act(G, 'p0', 'start', undefined, 0), null);
  assert.equal(E.act(G, 'p1', 'advance', undefined, 1), 'not_allowed', 'only the referee moves things on');
  const seen = [];
  for (let i = 0; i < 40 && G.ph !== 'end'; i++) {
    seen.push(G.ph);
    if (G.ph === 'vote') {
      assert.equal(E.act(G, 'p0', 'vote', 'p1', 5), 'bad_target', 'the referee does not vote');
      assert.equal(E.act(G, 'p1', 'vote', 'p0', 5), 'bad_target', 'nobody votes for the referee');
      const voters = E.alive(G);
      const target = voters.find(p => p.role === 'M') || voters[0];
      voters.filter(p => p.id !== target.id).forEach(p => E.act(G, p.id, 'vote', target.id, 5));
    }
    assert.equal(E.act(G, 'p0', 'advance', undefined, 10 + i), null, `advance from ${G.ph}`);
  }
  assert.equal(G.ph, 'end');
  assert.deepEqual([...new Set(seen)].sort(), ['day', 'night', 'reveal', 'verdict', 'vote']);
  assert.equal(E.player(G, 'p0').al, 1, 'the referee is never eliminated');
  assert.ok(E.pubOf(G).ps.every(p => p.ref || p.rl), 'every player card shows at the end; the referee has none');
  assert.equal(E.act(G, 'p0', 'advance', undefined, 99), 'not_allowed', 'nothing to advance once it ends');
});

test('referee: a table of four players plus a referee can start; three plus a referee cannot', () => {
  const G = table(4); E.act(G, 'p0', 'referee', 'p3', 0);
  assert.equal(E.act(G, 'p0', 'start', undefined, 0), 'too_few');
  E.join(G, { id: 'p4', name: 'P4' }, 0);
  assert.equal(E.act(G, 'p0', 'start', undefined, 0), null);
  assert.equal(E.act(G, 'p0', 'referee', '', 0), 'not_allowed', 'the referee is fixed once dealt');
});
