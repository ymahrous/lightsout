# Constitution

The principles every change to Lights Out Mafia has to keep. They are written down from the design as it stands (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)), so they describe what the project already is, not what it hopes to be.

When this file disagrees with any other document, this file wins. A change that breaks a principle is turned down, or it amends this file in the same pull request (see [Amending](#amending)).

Version 1.0, adopted 13 November 2026.

## 1. The rules exist once

Every rule of the game lives in `shared/engine.js`. The server decides every online move with it, and one-phone mode runs the same file in the browser. No rule is written a second time anywhere else: not in the server, not in the client.

The engine has no I/O, no timers and no dependencies. It works on plain JSON, and time is always passed in, so any transition can be replayed or retried.

**Why:** two copies of the rules are the classic cause of "my screen showed one thing and the server did another".

## 2. The server decides, and a secret reaches only its owner

Clients say what a player wants to do. The server decides what happens. Everything a player receives is built by `pubOf` (what everyone may see) and `privOf` (what that one player may see). A role, a Mafia partner, a Detective's note or a night move is never sent to someone who should not see it. Hiding it in the client is not enough: it must not be sent at all.

**Checked by:** "five hundred random tables all finish with a winner and never leak a role", "a full game over real sockets, and nobody is ever sent a secret that is not theirs", and the referee tests.

## 3. An acknowledged move is never lost or applied twice

PostgreSQL is the source of truth. A move is committed with a compare-and-set on the room's version before any player hears about it. Game servers hold only a cache and may be destroyed at any moment. Every action is idempotent. Phase timers are data (`nextDeadline`), never a `setTimeout` that dies with the process.

**Checked by:** `test/cluster.test.js` and `test/store.test.js`, on the in-memory store and on PostgreSQL.

## 4. A game in progress is never broken

Deploys, restarts, dropped connections and app updates keep every player in their seat with their card. A player whose connection drops is marked away, not removed. An installed app switches to a new version only when the player is on the home screen.

## 5. No accounts, and only the data the game needs

A room is a code and a link. There is no sign-up, no email address, no analytics, no advertising and no tracker, and the browser makes no request to anyone but the game's own server. IP addresses are used for abuse limits only.

What the game keeps is described in `public/privacy.html`. A change that keeps something new updates that page in the same pull request.

## 6. Free to run on machines you control

Every part of the stack is open source. No account with any vendor is needed to run it, and `docker compose up` runs the whole thing on one machine. Hosted platforms such as Railway are a convenience, never a requirement.

Third-party browser files (three.js, the fonts) are served from the game's own origin, straight out of `node_modules`. Nothing loads from a CDN.

## 7. Small on purpose

There is no build step and no framework: the browser loads plain ES modules, and the server is plain Node.js. The runtime dependencies are `ws`, `pg`, three.js and three typefaces. A new dependency needs a reason in its pull request: what it does, and why writing that part ourselves would be worse.

## 8. It works on the phone in your hand

Phones come first: the 3D town draws a lighter scene on them. Without WebGL the game still works over a plain gradient. Once the app is installed, one-phone games work with no connection. When something is missing, the game degrades. It does not fail.

## 9. A small, fixed attack surface

The server serves a list of files fixed when it starts, so no request path can reach outside it. Every client message is size-limited, rate-limited and validated, names are cleaned, and the client inserts player text only as escaped text. The Content Security Policy stays strict: no inline executable scripts and no outside origins.

## 10. Every promise is tested, and every number has a source

When the docs promise something (consistency, secrecy, durability), a test checks it, and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) names that test. Numbers in the docs say whether they were measured or estimated, on what, and when. Docs say plainly what has not been tried, as the Railway guide does.

## Amending

- A pull request that changes a principle edits this file, and says what changes, why, and what it costs.
- Bump the version: major when a principle is removed or reversed, minor when one is added or its meaning changes, patch for wording only.
- Add a line to [History](#history).

## History

- **1.0** (13 November 2026): first version, written down from the existing design.
