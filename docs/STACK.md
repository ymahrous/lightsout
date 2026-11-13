# Stack decision

Written November 2026. Versions and licences below were checked then.

## What was asked for

1. Handle very large traffic at all times, with **consistency** (every player sees the same game, no action is lost or applied twice) and **durability** (a crash or deploy never loses a game).
2. Be **entirely free**: no paid services and no "free tier" of somebody's hosted product.

## What "entirely free" can mean

Every piece of software here is open source and runs on machines you control. No account with any vendor is needed to run it.

What cannot be free is the machine itself. Traffic needs CPU, memory and bandwidth, and someone owns those: your own hardware, or a rented server. A domain name costs money too. HTTPS certificates are free from Let's Encrypt, a non-profit certificate authority that Caddy talks to automatically; that is optional and is the only outside party the stack ever contacts.

## The shape of the problem

A Mafia room is a small, self-contained state machine:

- 4 to 12 players, a few kilobytes of state, alive for minutes.
- A handful of writes per minute. Most of the time every socket is idle.
- Rooms never interact with each other.

So "massive" here means a very large number of small, independent rooms and mostly idle sockets. The design problem is keeping each room correct while any server can touch it, and being able to add capacity by adding machines. Raw language speed matters far less than that.

## The decision

| Layer | Choice | Licence | Why |
| --- | --- | --- | --- |
| Source of truth | **PostgreSQL** | PostgreSQL Licence | ACID, write-ahead log, synchronous replication when you want it. One row per room, one conditional `UPDATE` per move. |
| Game server | **Node.js** with `ws` | MIT | Holds no game state. The rules engine is one JavaScript file shared with the browser. |
| Edge | **Caddy** | Apache-2.0 | TLS and load balancing in a ten-line config. No sticky sessions needed. |
| Client | Plain ES modules, **three.js** | MIT | No build step. Fonts and libraries are served from your origin, not a CDN. |
| Packaging | Docker Compose | Apache-2.0 | One command for the whole stack. Optional: everything also runs as plain processes. |

## Runtime: Node.js, Go or Elixir

| | Node.js | Go | Elixir (Phoenix) |
| --- | --- | --- | --- |
| Idle sockets per machine | Good. One process per core, tens of thousands each. | Better. | Best. The BEAM was built for this. |
| One rules engine for server and browser | **Yes.** Same file. | No. Rules written twice, or compiled to WebAssembly. | No. Rules written twice. |
| People who can maintain it | Most | Many | Fewer |
| Fit with the existing game | It is already JavaScript | Rewrite | Rewrite |

Elixir would carry the most connections per machine and Go would use the least memory per connection. Node.js won for one reason that bears directly on consistency: **the rules exist exactly once**. The server decides every move with `shared/engine.js`, and one-phone mode runs that same file in the browser. Two implementations of the rules in two languages is the classic source of "the client showed one thing and the server did another".

The cost is machines: for the same number of sockets, Node.js needs more of them than Go or Elixir. Because servers hold no game state, that cost is linear and predictable once a relay between servers is added back (see below). If one box ever has to hold millions of sockets, the gateway (`server/gateway.js`, about 150 lines) is the part to port; the store, the protocol and the consistency model carry over unchanged.

## Database: why PostgreSQL holds the rooms

The requirement is that an acknowledged move is never lost and that two servers can never both "win" the same moment in a room.

- **PostgreSQL** gives that with one statement: `UPDATE rooms SET ... WHERE code = $1 AND version = $2`. Exactly one writer succeeds; the others re-read and retry. Commits are on disk before they are acknowledged.
- **Valkey or Redis as the source of truth** was turned down. It is an in-memory store whose default persistence can lose the last second of writes, and whose replication is asynchronous, so a failover can drop acknowledged moves.
- **CockroachDB** was turned down on licence: it dropped its open-source core in 2024.
- **YugabyteDB** (Apache-2.0) and **Citus** (AGPL) are free, PostgreSQL-compatible ways to scale one logical database. They are reasonable later steps. They were not chosen as the default because rooms never join across each other, so plain sharding does the same job with nothing new to operate: set `DATABASE_URLS` to several independent PostgreSQL servers and rooms are spread across them by code.

## Fan-out between servers: removed

The first version used Valkey pub/sub to relay each move to the other game servers. It was removed on 2026-11-13 to cut a service to run and pay for.

What that trades:

- **Kept:** consistency and durability. Every move is still one compare-and-set in PostgreSQL, and every server still compares versions with PostgreSQL every five seconds and catches up.
- **Lost:** fast scale-out. With several game servers, a player sees moves made through another server up to five seconds late. The supported setup is now one game server, which holds tens of thousands of game sockets.

If one server stops being enough, add a relay back behind the interface in `server/bus/memory.js`. The options considered:

- **Valkey or NATS pub/sub:** sub-millisecond, scales out. One more service.
- **PostgreSQL `LISTEN/NOTIFY`:** no new service, fine at a handful of servers. Turned down for large scale because `NOTIFY` takes a global lock at commit, which serialises every writer on the database under load.

## Edge: Caddy

Caddy gets HTTPS right with no configuration. HAProxy is the better choice once you are tuning for hundreds of thousands of connections per balancer.

## What would change this decision

- **More players than one game server can hold:** add a relay between servers (see above), then add servers.
- **Millions of concurrent sockets on few machines:** port the gateway to Go or Elixir.
- **One PostgreSQL primary is not enough and you do not want to run several:** move to YugabyteDB or Citus. The SQL used is plain.
- **A voice or video feature:** that needs a media server (for example LiveKit, Apache-2.0), which is a separate system.

## Sources

- [PostgreSQL: current releases](https://www.postgresql.org/)
- [Node.js release lines](https://endoflife.date/nodejs)
- [CockroachDB drops its open-source core](https://www.theregister.com/2024/08/19/cockroachdb_abandons_open_core/)
- [Postgres LISTEN/NOTIFY does not scale](https://recall.ai/blog/postgres-listen-notify-does-not-scale)
