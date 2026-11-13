// The WebSocket edge: one JSON message in, one rule applied, state out.
// It keeps no game state of its own, so any server can serve any player.
import { WebSocketServer } from 'ws';
import { createHash, randomBytes } from 'node:crypto';
import { join as seat, disconnect, quit, act, player } from '../shared/engine.js';
import { CODE_RE } from './rooms.js';

const TOKEN_RE = /^[a-f0-9]{32}$/;
// A player's public id is derived from their secret token, so knowing an id never lets you act as that player.
const pidOf = token => createHash('sha256').update(token).digest('hex').slice(0, 8);
const BURST = 30, REFILL_PER_SEC = 8, HEARTBEAT_MS = 30000, MAX_BUFFERED = 1 << 20;

const STATUS = { 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests', 503: 'Service Unavailable' };
const refuse = (socket, code) => { socket.write(`HTTP/1.1 ${code} ${STATUS[code]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); socket.destroy(); };

/** The player's address: from the configured proxy header when there is one, otherwise the socket. */
export function clientIp(req, proxyHeader) {
  if (proxyHeader) { const h = req.headers[proxyHeader]; if (typeof h === 'string' && h) return h.split(',')[0].trim(); }
  return req.socket.remoteAddress || 'unknown';
}

export function createGateway({ server, rooms, metrics, config, log }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2048, perMessageDeflate: false });
  const sessions = new Set(), perIp = new Map(), creates = new Map();
  let closing = false;
  metrics.gauge('connections', () => sessions.size);
  metrics.gauge('rooms_local', () => rooms.local.size);

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    if ((req.url || '').split('?')[0] !== '/ws') return refuse(socket, 404);
    if (closing) return refuse(socket, 503);
    if (config.allowedOrigins.length && !config.allowedOrigins.includes(req.headers.origin)) return refuse(socket, 403);
    const ip = clientIp(req, config.proxyHeader);
    if ((perIp.get(ip) || 0) >= config.maxConnPerIp) { metrics.inc('refused_connections'); return refuse(socket, 429); }
    wss.handleUpgrade(req, socket, head, ws => open(ws, ip));
  });

  function open(ws, ip) {
    const s = {
      ws, ip, cid: randomBytes(4).toString('hex'), code: null, pid: null, live: false, alive: true,
      tokens: BURST, stamp: Date.now(), q: Promise.resolve(),
      sendRaw(str) {
        if (ws.readyState !== 1) return;
        if (ws.bufferedAmount > MAX_BUFFERED) { metrics.inc('slow_consumers'); return ws.terminate(); }
        ws.send(str); metrics.inc('messages_out');
      },
      send(o) { this.sendRaw(JSON.stringify(o)); },
      err(e, extra) { this.send(Object.assign({ t: 'err', e }, extra)); }
    };
    sessions.add(s); perIp.set(ip, (perIp.get(ip) || 0) + 1);
    ws.on('pong', () => { s.alive = true; });
    ws.on('error', () => {});
    ws.on('message', (data, binary) => {
      metrics.inc('messages_in');
      if (binary) return ws.close(1003, 'text only');
      const t = Date.now();
      s.tokens = Math.min(BURST, s.tokens + (t - s.stamp) / 1000 * REFILL_PER_SEC); s.stamp = t;
      if (s.tokens < 1) { metrics.inc('rate_limited'); s.err('slow_down'); return ws.close(1008, 'rate limit'); }
      s.tokens -= 1;
      let m; try { m = JSON.parse(data.toString()); } catch { return s.err('bad_message'); }
      if (!m || typeof m !== 'object' || typeof m.t !== 'string') return s.err('bad_message');
      // One message at a time per socket, in arrival order.
      s.q = s.q.then(() => handle(s, m)).catch(e => { log('error', 'message failed', { error: String(e && e.message || e) }); s.err('unavailable'); });
    });
    ws.on('close', () => { s.q = s.q.then(() => cleanup(s)).catch(() => {}); });
  }

  function allowCreate(ip) {
    const now = Date.now(); let c = creates.get(ip);
    if (!c || now > c.reset) { c = { n: 0, reset: now + 60000 }; creates.set(ip, c); }
    return ++c.n <= config.createPerMinute;
  }

  async function handle(s, m) {
    switch (m.t) {
      case 'ping': s.send({ t: 'pong', now: Date.now() }); heal(s); return;
      case 'create': {
        if (!TOKEN_RE.test(m.token)) return s.err('bad_token');
        if (!allowCreate(s.ip)) { metrics.inc('rate_limited'); return s.err('slow_down'); }
        return enter(s, await rooms.create(), m);
      }
      case 'join': {
        const code = typeof m.code === 'string' ? m.code.toUpperCase() : '';
        if (!CODE_RE.test(code)) return s.err('no_room');
        if (!TOKEN_RE.test(m.token)) return s.err('bad_token');
        return enter(s, code, m);
      }
      case 'act': {
        if (!s.code || !s.live) return s.err('not_in_room');
        const a = typeof m.a === 'string' ? m.a.slice(0, 16) : '';
        const v = typeof m.v === 'string' ? m.v.slice(0, 32) : (typeof m.v === 'number' && Number.isFinite(m.v) ? m.v : undefined);
        const res = await rooms.mutate(s.code, (G, now) => { const e = act(G, s.pid, a, v, now); return e ? { err: e } : null; });
        if (res.err) s.err(res.err, { a });
        return;
      }
      case 'leave': {
        if (s.code) {
          const code = s.code, pid = s.pid;
          rooms.detach(s); s.code = null; s.live = false;
          await rooms.mutate(code, (G, now) => { quit(G, pid, now); });
        }
        return s.send({ t: 'left' });
      }
      default: return s.err('bad_message');
    }
  }

  // Seat this socket in a room: a first join, a reconnect, or a watcher.
  async function enter(s, code, m) {
    if (s.code) await drop(s);
    s.code = code; s.live = false;
    await rooms.attach(s, code);
    const own = pidOf(m.token), prev = TOKEN_RE.test(m.prev) ? pidOf(m.prev) : null;
    let kind = 'watch';
    const res = await rooms.mutate(code, (G, now) => {
      let id = own;
      // A new tab may take over the seat this browser held before, but only while that seat is away.
      if (!player(G, own) && prev && prev !== own) { const q = player(G, prev); if (q && q.off) id = prev; }
      s.pid = id;
      kind = seat(G, { id, name: m.name, tint: m.tint, cid: s.cid }, now);
    });
    if (res.err) { rooms.detach(s); s.code = null; s.pid = null; return s.err(res.err); }
    s.send({ t: 'joined', code, id: s.pid, seat: kind, adopted: s.pid !== own });
    s.live = true;
    rooms.push(s);
  }

  // The socket stopped being in its room without the player choosing to leave.
  async function drop(s) {
    const code = s.code, pid = s.pid;
    rooms.detach(s); s.code = null; s.live = false;
    if (!closing && pid) await rooms.mutate(code, (G, now) => { disconnect(G, pid, s.cid, now); });
  }

  async function cleanup(s) {
    if (!sessions.delete(s)) return;
    const n = (perIp.get(s.ip) || 1) - 1; if (n > 0) perIp.set(s.ip, n); else perIp.delete(s.ip);
    if (s.code) await drop(s);
  }

  // If the room thinks a connected player is away (their other tab closed, or a server died), put them back.
  function heal(s) {
    if (!s.live) return;
    const p = rooms.peek(s.code, s.pid);
    if (p && (p.off || p.gone)) rooms.mutate(s.code, (G, now) => { if (player(G, s.pid)) seat(G, { id: s.pid, cid: s.cid }, now); }).catch(() => {});
  }

  const beat = setInterval(() => {
    const now = Date.now();
    for (const s of sessions) { if (!s.alive) { s.ws.terminate(); continue; } s.alive = false; try { s.ws.ping(); } catch {} }
    for (const [ip, c] of creates) if (now > c.reset) creates.delete(ip);
  }, HEARTBEAT_MS);

  return {
    sessions,
    /** Tell every client to reconnect elsewhere, then close. Rooms are untouched: they live in the store. */
    async close() {
      closing = true; clearInterval(beat);
      for (const s of sessions) { s.sendRaw('{"t":"bye"}'); s.ws.close(1012, 'restart'); }
      await new Promise(r => setTimeout(r, 300));
      for (const s of sessions) s.ws.terminate();
      wss.close();
    }
  };
}
