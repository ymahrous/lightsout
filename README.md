# Lights Out Mafia

A real-time game of Mafia for 4 to 12 players. Open a room, send the link, play. Nobody makes an account.

Every player owns a lit window in a 3D town. Each night the Mafia puts one out.

![The home screen](docs/img/home.png)

## What is different about it

- **No accounts.** A room is a five-character code and a link. Names are optional.
- **Everyone taps at night.** Townspeople whisper a suspect while the Mafia, Doctor and Detective act, so nobody can read roles from who is busy. The whisper count is announced at dawn.
- **Sealed cards.** The server deals. Each role is sent to its owner's screen and to nobody else, and the card only shows while you hold it.
- **Your seat survives.** Reload, lose signal or close the tab: the room lives in the database, and you return to the same seat with the same card.
- **Never short of players.** The host can seat bots. Eliminated players become ghosts who see every card.
- **A referee, if you want one.** The host can name any seated player as referee. They are dealt no card, see every card and every night move as it happens, and can end each phase when the table is ready.
- **One-phone mode, two ways.** Pass a single phone around the table, or let a referee hold it: everyone closes their eyes, each role wakes and points, the referee taps it in, and the phone can read the lines aloud. Votes are counted by show of hands. Names are remembered, and a game survives the app being closed.
- **Installable.** Add it to the home screen on Android, iPhone or desktop. It opens full screen, and one-phone games work with no connection.
- **A case file.** The end screen replays every night and every vote.

| Lobby, with a referee | The referee's night | One phone, with a referee |
| --- | --- | --- |
| ![Lobby](docs/img/lobby.png) | ![The referee sees every move](docs/img/referee-night.png) | ![The referee's script](docs/img/one-phone-referee.png) |

## Run it

You need [Node.js](https://nodejs.org) 22 or newer.

```sh
npm install
npm start
```

Open <http://localhost:8080>. To try a table on your own, open the invite link in a few private windows, or seat bots.

With nothing else configured the server keeps rooms in memory: one process, and rooms are lost on restart. That is fine for trying it out and wrong for the public internet.

## Run it for real

The production stack is PostgreSQL (where rooms live), one game server, and Caddy in front. All of it is open source and self-hosted.

```sh
docker compose up --build                             # http://localhost
SITE_ADDRESS=play.example.com docker compose up -d    # public site with automatic HTTPS
```

Set `POSTGRES_PASSWORD` to something of your own before exposing it.

Without Docker, install PostgreSQL, then start the server behind any reverse proxy that speaks WebSocket:

```sh
export NODE_ENV=production
export DATABASE_URL=postgres://lom:secret@localhost:5432/lom
export TRUST_PROXY=1
node server/index.js
```

The tables are created on first start. You can restart the server at any time without ending a game: players reconnect to the same seats.

You can run several game servers against the same database and every game stays correct, but players on different servers see each other's moves up to 5 seconds late. See "Running several servers" in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### On Railway

`.railway/railway.ts` describes the game server and PostgreSQL for [Railway](https://railway.com). Step-by-step instructions, including a route that needs no command line, are in [docs/DEPLOY-RAILWAY.md](docs/DEPLOY-RAILWAY.md).

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT`, `HOST` | `8080`, all interfaces | Where the server listens. With `HOST` unset it accepts IPv6 and IPv4. |
| `NODE_ENV` | | `production` caches and pre-compresses the static files. |
| `DATABASE_URL` | none | PostgreSQL connection. Unset means in-memory rooms. |
| `DATABASE_URLS` | none | Several comma-separated PostgreSQL servers. Rooms are spread across them by code. |
| `PG_POOL_SIZE` | `10` | Connections per server process, per database. |
| `TRUST_PROXY` | off | Behind a proxy, where to read the player's address. `1` means `X-Forwarded-For` (Caddy, HAProxy). Otherwise name the header, such as `x-real-ip` on Railway. |
| `ALLOWED_ORIGINS` | any | Comma-separated origins allowed to open a game socket. |
| `MAX_CONN_PER_IP` | `60` | Sockets one address may hold on one server. |
| `CREATE_PER_MINUTE` | `12` | Rooms one address may open per minute on one server. |
| `GAMES_RETENTION_DAYS` | `30` | How long finished games stay in the `games` archive table. |

### Installing on phones

The site is a progressive web app: a manifest (`public/manifest.webmanifest`), icons (`public/icons/`) and a service worker (`public/sw.js`) that keeps the app's files on the device. On Android and desktop Chrome or Edge, the home screen shows an "Add Lights Out to your home screen" button that opens the browser's install prompt. On iPhone and iPad it shows the Safari steps instead.

Browsers only install over HTTPS (or on `localhost`). Caddy and Railway both provide HTTPS.

When you deploy, the server stamps the service worker with a hash of every file it caches, so installed copies notice the change and update the next time the player is on the home screen. They never switch versions in the middle of a game.

### Operating it

- `GET /healthz` answers while the process is up. `GET /readyz` also checks PostgreSQL.
- `GET /metrics` is Prometheus text: connections, transitions, write conflicts, repair counts, a latency histogram. Keep it off the public internet at your proxy.
- `SIGTERM` tells every connected player to reconnect and exits. Their browsers rejoin as soon as a server is up again.
- Back up PostgreSQL. It is the only component that holds anything you cannot lose.

## How it is built

- [docs/STACK.md](docs/STACK.md): why this stack, and what was turned down.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how consistency and durability are achieved, what happens when each part fails, the wire protocol, and how to scale.

```
shared/engine.js     the rules: pure functions over plain JSON, used by server and browser
server/rooms.js      compare-and-set transitions, fan-out, timers, repair
server/gateway.js    WebSocket sessions, identity, rate limits
server/store/        PostgreSQL and in-memory stores (same contract)
server/bus/memory.js in-process fan-out, and the interface a relay between servers would implement
server/http.js       static files, health, metrics
public/              the client: plain ES modules, no build step, plus the manifest, icons and service worker
test/                rules, store contract, multi-server consistency, end-to-end sockets
scripts/loadtest.js  thousands of scripted players against a running deployment
.railway/railway.ts  the stack described for Railway
```

There is no build step and no framework. The browser loads the same `shared/engine.js` the server runs.

## Testing

```sh
npm test
```

This runs the rules tests, the store contract tests, the multi-server consistency tests and the socket tests against an in-memory store. Point it at a disposable database to run the same suite on PostgreSQL:

```sh
TEST_DATABASE_URL=postgres://lom:lom@localhost:5432/lom_test npm test
```

Use a throwaway database: the store tests leave rows behind.

To load a running deployment with scripted players:

```sh
npm run loadtest -- --url ws://localhost:8080/ws --rooms 200 --players 8
```

Raise `MAX_CONN_PER_IP` and `CREATE_PER_MINUTE` on the servers first, because every simulated player comes from your one address. The script exits non-zero if any table ends inconsistent.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The principles every change has to keep are in [CONSTITUTION.md](CONSTITUTION.md), and coding agents read [AGENTS.md](AGENTS.md).

## Licence

MIT. See [LICENSE](LICENSE).

Bundled and served from your own origin, each under its own licence: [three.js](https://threejs.org) (MIT), and the typefaces Bodoni Moda, Manrope and DM Mono (SIL Open Font Licence 1.1) via [Fontsource](https://fontsource.org). Server libraries: `ws`, `pg` (both MIT).
