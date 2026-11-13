# AGENTS.md

Guidance for coding agents working in this repository. People are welcome to read it too; [CONTRIBUTING.md](CONTRIBUTING.md) is the human-facing version.

Lights Out Mafia is a real-time Mafia party game for 4 to 12 players. The server is Node.js 22 with `ws`, PostgreSQL holds the rooms, and the browser client is plain ES modules with three.js. There is no build step, no framework and no TypeScript (the one exception is `.railway/railway.ts`).

**Read [CONSTITUTION.md](CONSTITUTION.md) before changing behaviour.** Its principles override anything here.

## Commands

```sh
npm install
npm run dev                      # http://localhost:8080; restarts when server code changes; rooms in memory
npm start                        # same, without the restart on changes
npm test                         # the full suite on the in-memory store, about 10 seconds
node --test test/engine.test.js  # one file
TEST_DATABASE_URL=postgres://lom:lom@localhost:5432/lom_test npm test   # the same suite on PostgreSQL
```

`TEST_DATABASE_URL` must point at a throwaway database: the store tests leave rows behind.

## Where things live

| Path | What it is |
| --- | --- |
| `shared/engine.js` | Every game rule. Pure functions over the room state `G` (plain JSON, changed in place). Time is passed in. Used by the server and by one-phone mode in the browser. |
| `server/rooms.js` | Compare-and-set transitions, the per-room queue, fan-out to players, the deadline sweeper and the 5-second resync. |
| `server/gateway.js` | WebSocket messages, token to player id, rate limits. |
| `server/store/memory.js`, `server/store/postgres.js` | Two stores with one contract, checked by `test/store.test.js`. |
| `server/bus/memory.js` | In-process fan-out, and the interface a relay between servers would implement. |
| `server/http.js` | Static files (the route list is built at boot), clean URLs, `/healthz`, `/readyz`, `/metrics`, security headers. |
| `server/config.js` | Every environment variable. |
| `public/index.html`, `public/js/` | The game: `app.js` (screens and one-phone mode), `net.js` (the socket), `scene.js` (the 3D town), `install.js` (install prompt and service-worker updates), `sound.js`. |
| `public/sw.js` | The service worker. Serves `/` from the cache. Every other page comes from the server, with a cached copy as the offline fallback. |
| `public/faq.html`, `privacy.html`, `terms.html`, `404.html` | The other pages, styled by `public/legal.css`. |
| `test/` | `node:test` suites. `helpers.js` has `FAST` timings, `client()` for a scripted socket player and `node()` for an in-process server. |
| `docs/ARCHITECTURE.md` | The guarantees and the test that checks each one, failure modes, the wire protocol, and scaling. |
| `.railway/railway.ts` | Railway config as code. Railway stops reading `railway.json` on 2026-12-01, so do not add one. |

## Rules that are easy to break

- **Game logic goes in `shared/engine.js` only.** Do not add rules to `rooms.js`, `gateway.js` or `app.js`. The engine must not import anything, do I/O, read the clock or start timers.
- **State reaches a client only through `pubOf` and `privOf`.** A new secret field goes in `privOf`, for its owner only. Add a test that checks other players never receive it.
- **Actions are idempotent.** Applying the same action twice must leave the same state (test: "actions are idempotent").
- **Game timing is data.** A new phase or delay is a deadline that `nextDeadline` returns and `tick` handles. Never a `setTimeout`.
- **Change both stores together.** When the store contract changes, update `memory.js` and `postgres.js`, and run the store tests on PostgreSQL.
- **Player text is escaped.** Insert it into HTML only through `esc()` in `app.js`. The engine cleans names with `cleanName`.
- **The Content Security Policy in `server/http.js` stays strict.** No inline executable scripts (a JSON-LD data block is fine), and no outside URLs. Browser libraries and fonts are served through the `VENDOR` map from `node_modules`.
- **Keep one copy of the game server.** `replicas: 1` in `.railway/railway.ts` and `compose.yaml`. With no relay between servers, more copies lag each other by up to 5 seconds.

## Common changes, with every step

### Add a page

1. Create `public/<name>.html` with the same structure as `public/faq.html`, linking `/legal.css`.
2. In `server/http.js`, add the clean address: `routes.set('/<name>', routes.get('/<name>.html'));`
3. In `public/sw.js`, add `'/<name>'` to `SHELL` so the page opens offline. A test checks that every `SHELL` address returns 200.
4. In `test/server.test.js`, add the page to the loop that checks each page's title and trailing-slash redirect.
5. Link it from the `<nav aria-label="Information">` in `public/index.html` and in each subpage.
6. Restart the server. The route list is built at boot, and `npm run dev` does not watch `public/`.

### Add a game action

1. Handle it in `act()` in `shared/engine.js`: validate who may do it and when, and keep it idempotent.
2. Test it in `test/engine.test.js`. If it touches secrets, also test it over sockets in `test/server.test.js`.
3. Send it from the client (`app.js`, through `net.js`). For one-phone mode, the client calls the engine directly.
4. Add the action name to the wire protocol table in `docs/ARCHITECTURE.md`.

### Add a setting

1. Read it in `loadConfig()` in `server/config.js`, with a default.
2. Add it to `.env.example` and to the configuration table in `README.md`.

### Add a browser library or font

1. Add it as an npm dependency.
2. Add its file to the `VENDOR` map in `server/http.js`.
3. If the game needs it offline, add its address to `SHELL` in `public/sw.js`.

### Add a file the server needs at runtime

The `Dockerfile` copies only `shared/`, `server/` and `public/`. Anything else needs its own `COPY` line. `.dockerignore` leaves out `docs/`, `test/`, `scripts/` and every `*.md` file.

## Checking your change

- Run `npm test` for every change.
- If you touched `server/rooms.js`, `server/store/` or the cluster or store tests, also run them on PostgreSQL if one is available.
- **Service-worker and `install.js` changes need a real browser.** The tests check the `SHELL` list but not the fetch handler. An old worker keeps answering until it updates, so test in a fresh profile or a private window, or unregister it in DevTools.
- For client changes, run `npm run dev` and open the game in two or three private windows, or seat bots. Check a phone-width window too.
- With `NODE_ENV` unset, static files are read from disk on every request. With `NODE_ENV=production`, they are cached and compressed at boot, and the service worker's version is a hash of every file served.

## Style

- ES modules, Node.js 22 or newer, two-space indentation, single quotes, semicolons. No linter or formatter is configured, so match the file you are in.
- Each file starts with a comment saying what it is for. Comments explain why, in full sentences. Exported functions get a `/** */` line.
- Short, dense code is normal here. Do not split a file or add a layer unless the change needs it.
- Docs use plain, short sentences, tables for reference, and absolute dates. A number says whether it was measured or estimated.
- Commits follow Conventional Commits, with a lowercase imperative subject: `feat: add referee mode`, `fix: add clean routes for legal subpages`, `docs: …`, `test: …`.
- When a change alters something the README or `docs/` describe, update them in the same commit.

## Do not

- Commit `.env`, secrets, or a database URL with a real password.
- Add a build step, a framework, TypeScript or a CDN link.
- Raise the game server above one copy.
- Add `railway.json`.
- Point `TEST_DATABASE_URL` at a database you care about.
