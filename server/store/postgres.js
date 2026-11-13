// PostgreSQL is the system of record. Every room is one row; every transition is one
// conditional UPDATE (compare-and-set on `version`), so two servers can never both win.
import pg from 'pg';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  code        text PRIMARY KEY,
  version     integer NOT NULL,
  state       jsonb NOT NULL,
  deadline_ms bigint,
  expires_ms  bigint NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rooms_deadline ON rooms (deadline_ms) WHERE deadline_ms IS NOT NULL;
CREATE INDEX IF NOT EXISTS rooms_expires ON rooms (expires_ms);
CREATE TABLE IF NOT EXISTS games (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code     text NOT NULL,
  ended_at timestamptz NOT NULL DEFAULT now(),
  winner   text NOT NULL,
  rounds   integer NOT NULL,
  players  jsonb NOT NULL,
  history  jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS games_ended ON games (ended_at);
`;
const NOW_MS = `(extract(epoch from clock_timestamp()) * 1000)::bigint`;
const LOCK = 72727401;

// FNV-1a: a stable hash, so every server maps a room code to the same shard.
const fnv = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };

export class PostgresStore {
  constructor(urls, { poolSize = 10, retentionDays = 30, onError = () => {} } = {}) {
    if (!urls.length) throw new Error('PostgresStore needs at least one connection URL');
    this.retentionDays = retentionDays;
    this.pools = urls.map(connectionString => {
      const pool = new pg.Pool({ connectionString, max: poolSize, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 });
      pool.on('error', onError);   // an idle connection died; the pool replaces it
      return pool;
    });
  }

  pool(code) { return this.pools[fnv(code) % this.pools.length]; }

  async init() {
    for (const pool of this.pools) {
      const c = await pool.connect();
      try {
        await c.query(`SELECT pg_advisory_lock(${LOCK})`);   // servers booting together run the DDL one at a time
        await c.query(SCHEMA);
      } finally {
        await c.query(`SELECT pg_advisory_unlock(${LOCK})`).catch(() => {});
        c.release();
      }
    }
  }

  async ping() { await Promise.all(this.pools.map(p => p.query('SELECT 1'))); }
  async close() { await Promise.all(this.pools.map(p => p.end())); }

  async create(code, json, deadline, expires) {
    const r = await this.pool(code).query(
      'INSERT INTO rooms (code, version, state, deadline_ms, expires_ms) VALUES ($1, 1, $2::jsonb, $3, $4) ON CONFLICT (code) DO NOTHING',
      [code, json, deadline, expires]);
    return r.rowCount === 1;
  }

  async load(code) {
    const r = await this.pool(code).query('SELECT version, state FROM rooms WHERE code = $1', [code]);
    return r.rowCount ? { v: r.rows[0].version, G: r.rows[0].state } : null;
  }

  async save(code, v, json, deadline, expires, archive) {
    const set = 'UPDATE rooms SET state = $3::jsonb, version = version + 1, deadline_ms = $4, expires_ms = $5, updated_at = now() WHERE code = $1 AND version = $2';
    if (!archive) return (await this.pool(code).query(set, [code, v, json, deadline, expires])).rowCount === 1;
    // The finished game is archived in the same statement, so it exists exactly when the final state does.
    const r = await this.pool(code).query(
      `WITH u AS (${set} RETURNING code)
       INSERT INTO games (code, winner, rounds, players, history) SELECT code, $6, $7, $8::jsonb, $9::jsonb FROM u`,
      [code, v, json, deadline, expires, archive.winner, archive.rounds, JSON.stringify(archive.players), JSON.stringify(archive.history)]);
    return r.rowCount === 1;
  }

  async leaseDue(limit, leaseMs) {
    const per = Math.max(1, Math.ceil(limit / this.pools.length));
    const sets = await Promise.all(this.pools.map(pool => pool.query(
      `UPDATE rooms r SET deadline_ms = n.now_ms + $2
         FROM (SELECT code FROM rooms WHERE deadline_ms <= ${NOW_MS} ORDER BY deadline_ms LIMIT $1 FOR UPDATE SKIP LOCKED) d,
              (SELECT ${NOW_MS} AS now_ms) n
        WHERE r.code = d.code
        RETURNING r.code, r.version, r.state, n.now_ms`, [per, leaseMs])));
    return sets.flatMap(s => s.rows.map(row => ({ code: row.code, v: row.version, G: row.state, now: Number(row.now_ms) })));
  }

  async release(code, v, deadline) {
    await this.pool(code).query('UPDATE rooms SET deadline_ms = $3 WHERE code = $1 AND version = $2', [code, v, deadline]);
  }

  async versions(codes) {
    const groups = new Map();
    for (const c of codes) { const p = this.pool(c); if (!groups.has(p)) groups.set(p, []); groups.get(p).push(c); }
    const m = new Map();
    await Promise.all([...groups].map(async ([pool, list]) => {
      const r = await pool.query('SELECT code, version FROM rooms WHERE code = ANY($1)', [list]);
      for (const row of r.rows) m.set(row.code, row.version);
    }));
    return m;
  }

  async gc() {
    let n = 0;
    for (const pool of this.pools) {
      n += (await pool.query(`DELETE FROM rooms WHERE expires_ms < ${NOW_MS}`)).rowCount;
      await pool.query(`DELETE FROM games WHERE ended_at < now() - make_interval(days => $1)`, [this.retentionDays]);
    }
    return n;
  }
}
