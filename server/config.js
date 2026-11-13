// All configuration comes from the environment. See .env.example for the full list.
import { randomBytes } from 'node:crypto';

const env = process.env;
const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const list = v => (v || '').split(',').map(s => s.trim()).filter(Boolean);
export const proxyHeader = v => { v = (v || '').trim().toLowerCase(); return !v || v === '0' || v === 'false' ? '' : v === '1' || v === 'true' ? 'x-forwarded-for' : v; };

export function loadConfig() {
  return {
    port: int(env.PORT, 8080),
    host: env.HOST || '',                          // empty = all interfaces, IPv6 and IPv4
    production: env.NODE_ENV === 'production',
    nodeId: env.NODE_ID || randomBytes(3).toString('hex'),

    // One URL, or several comma-separated URLs to spread rooms across independent Postgres servers.
    databaseUrls: list(env.DATABASE_URLS || env.DATABASE_URL),
    pgPoolSize: int(env.PG_POOL_SIZE, 10),
    gamesRetentionDays: int(env.GAMES_RETENTION_DAYS, 30),

    // Which header carries the player's address when a proxy is in front. '1' means X-Forwarded-For
    // (Caddy, HAProxy); otherwise name the header, for example x-real-ip on Railway. Empty: use the socket.
    proxyHeader: proxyHeader(env.TRUST_PROXY),
    allowedOrigins: list(env.ALLOWED_ORIGINS),    // empty = accept any Origin
    maxConnPerIp: int(env.MAX_CONN_PER_IP, 60),
    createPerMinute: int(env.CREATE_PER_MINUTE, 12),

    // JSON object overriding shared/engine.js TIMINGS, for tests and load tests.
    timings: env.LOM_TIMINGS ? JSON.parse(env.LOM_TIMINGS) : undefined
  };
}

export function log(level, msg, extra) {
  const line = Object.assign({ t: new Date().toISOString(), level, msg }, extra);
  (level === 'error' ? process.stderr : process.stdout).write(JSON.stringify(line) + '\n');
}
