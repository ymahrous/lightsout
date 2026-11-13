// Boot one game server. Run as many of these as you like behind a load balancer.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadConfig, log as defaultLog } from './config.js';
import { Metrics } from './metrics.js';
import { Rooms } from './rooms.js';
import { createGateway } from './gateway.js';
import { createHttpHandler } from './http.js';
import { MemoryStore } from './store/memory.js';
import { MemoryBus } from './bus/memory.js';

/**
 * Start a server. `parts` lets tests inject a shared store or bus; by default they are
 * chosen from the configuration: Postgres when DATABASE_URL is set, memory otherwise.
 */
export async function startServer(overrides = {}, parts = {}) {
  const config = { ...loadConfig(), ...overrides };
  const log = parts.log || defaultLog;
  const metrics = new Metrics();
  const onError = e => { metrics.inc('backend_errors'); log('error', 'backend error', { error: String(e && e.message || e) }); };

  let store = parts.store, bus = parts.bus;
  if (!store) {
    if (config.databaseUrls.length) {
      const { PostgresStore } = await import('./store/postgres.js');
      store = new PostgresStore(config.databaseUrls, { poolSize: config.pgPoolSize, retentionDays: config.gamesRetentionDays, onError });
    } else store = new MemoryStore();
  }
  // Moves reach the players on this server directly. Players on other servers pick them up
  // from PostgreSQL through the resync loop (see docs/ARCHITECTURE.md, "Running several servers").
  if (!bus) bus = new MemoryBus();
  await store.init();
  if (!await bus.init()) log('warn', 'message bus not reachable yet; servers will fall back to resync until it is');

  const rooms = new Rooms({ store, bus, metrics, timings: config.timings, log });
  const ready = async () => { try { await Promise.all([store.ping(), bus.ping()]); return true; } catch { return false; } };
  const handler = await createHttpHandler({ metrics, production: config.production, ready });
  const server = createServer(handler);
  server.keepAliveTimeout = 65000;
  const gateway = createGateway({ server, rooms, metrics, config, log });
  rooms.start();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    // With no HOST, Node listens on every interface, IPv6 and IPv4. Hosts with IPv6 private networks need that.
    if (config.host) server.listen(config.port, config.host, resolve); else server.listen(config.port, resolve);
  });
  const port = server.address().port;
  log('info', 'listening', {
    node: config.nodeId, port,
    store: store.constructor.name + (config.databaseUrls.length > 1 ? ` x${config.databaseUrls.length}` : ''),
    bus: bus.constructor.name
  });
  if (store instanceof MemoryStore) log('warn', 'no DATABASE_URL: rooms live in memory and are lost on restart');

  return {
    port, config, rooms, gateway, metrics, store, bus,
    async close({ keepBackends = false } = {}) {
      rooms.stop();
      await gateway.close();
      await new Promise(r => { server.close(r); server.closeAllConnections(); });
      if (!keepBackends) { await bus.close(); await store.close(); }
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await startServer().catch(e => { defaultLog('error', 'failed to start', { error: String(e && e.stack || e) }); process.exit(1); });
  let stopping = false;
  const stop = async sig => {
    if (stopping) return; stopping = true;
    defaultLog('info', 'shutting down', { signal: sig });
    setTimeout(() => process.exit(1), 10000).unref();
    await app.close(); process.exit(0);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}
