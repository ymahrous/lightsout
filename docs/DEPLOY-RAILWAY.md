# Deploying on Railway

[Railway](https://railway.com) runs the full stack with very little setup: the game server built from this repo's `Dockerfile` and a PostgreSQL database. Railway provides HTTPS and a public address, so Caddy is not used here.

> This setup was checked against Railway's documentation and its config package (`railway` 3.16, CLI 5.71) in November 2026. The config file evaluates cleanly with that package, but it has not been applied to a live Railway project. Read the plan Railway shows you before confirming it.

## What it costs

Railway is not free past the first month. Prices as of November 2026 ([pricing](https://railway.com/pricing)):

| Plan | Price | What you get |
| --- | --- | --- |
| Trial | $0 | $5 of credit for 30 days. No card. |
| Free | $0 | $1 of credit a month, 0.5 GB per service, one copy of each service. Too little to keep this stack running all month. |
| Hobby | $5 a month | $5 of usage included, up to 6 copies of a service. |

You pay for what the services use: about $10 per GB of memory per month and $20 per CPU per month. A small deployment of this game (one game server and PostgreSQL) is estimated at $2 to $4 a month, mostly memory. That is an estimate from Railway's rates, not a measured bill. Watch the usage page during your first weeks.

## Route A: the dashboard

No tools to install. Use this if you are not comfortable with a terminal.

1. Put this repo on GitHub.
2. In Railway, create a **New Project** and choose **Deploy from GitHub repo**. Pick the repo. Railway finds the `Dockerfile` and builds it. Rename the service to `web` if you like.
3. Add a database: **Create**, **Database**, **PostgreSQL**.
4. Open the game service, go to **Variables**, and add:

   | Name | Value |
   | --- | --- |
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
   | `TRUST_PROXY` | `x-real-ip` |

   `${{Postgres.DATABASE_URL}}` is a reference. `Postgres` must match the name of the database service on your canvas.
5. In the service **Settings**, set the health check path to `/readyz`, then generate a public domain under **Networking**.
6. Deploy. Open the domain.

## Route B: the config file

`.railway/railway.ts` describes the same two services (`web` and `Postgres`) in code. It uses Railway's current format; the older `railway.json` stops being read on 2026-12-01.

You need the [Railway CLI](https://docs.railway.com/cli) (5.42.1 or newer) and this repo's dev dependencies (`npm install`).

```sh
railway login                    # sign in
railway init                     # create a project and link this folder to it
railway config plan              # preview: should list web and Postgres as new
railway config apply             # create them
railway up --service web         # build the Dockerfile and deploy
railway domain --service web     # generate a public address
```

After that, `railway up --service web` redeploys the game, and `railway config plan` followed by `railway config apply` applies any change you make to the file. To redeploy on every push instead, set `source: github("your-name/lights-out-mafia")` in the file.

## Check that it works

- `https://<your-domain>/readyz` answers `ready` when the server can reach PostgreSQL.
- Open a room, then open the invite link in a private window and join it.
- Redeploy while a game is running. Players should see "Reconnecting" for a moment and keep their seats.

## Scaling

Keep one copy of the game service. Without a relay between servers, players on different copies see each other's moves up to 5 seconds late (see "Running several servers" in [ARCHITECTURE.md](ARCHITECTURE.md)). Give the one copy more memory instead if it needs it.

On a redeploy Railway briefly runs the old and new copies together (`overlapSeconds` in the config). Players still on the old copy for those few seconds may see moves late, then the old copy tells them to reconnect and they join the new one.

Railway's edge allows 10,000 concurrent connections and keeps WebSockets open indefinitely ([limits](https://docs.railway.com/networking/public-networking/specs-and-limits)).

## What is different on Railway

- **Player addresses come from `X-Real-IP`.** All traffic reaches the server from Railway's proxy. Without `TRUST_PROXY=x-real-ip` every player would look like one address, and the per-address limit of 60 connections would cap the whole site.
- **Private network over IPv6 and IPv4.** The server listens on both by default. Leave `HOST` unset.
- **PostgreSQL 18.** Railway's current image. The test suite was run on PostgreSQL 16; the SQL used is plain.
- **`/metrics` is public.** There is no proxy of your own in front to hide it. It exposes counters only, no player data. If you mind, put the service behind a proxy that blocks that path.

## If something goes wrong

| Symptom | Likely cause |
| --- | --- |
| Deploy never becomes healthy | `/readyz` cannot reach PostgreSQL. Check the `DATABASE_URL` reference and that the service name in it matches. |
| Logs show `no DATABASE_URL: rooms live in memory` | The variable is missing on the game service. Rooms will be lost on every redeploy. |
| New players are refused once about 60 are connected | `TRUST_PROXY` is not set to `x-real-ip`. |
| Players do not see each other's moves for a few seconds | More than one copy of the game service is running. Set replicas back to 1. |
| `railway config plan` stops and mentions Config as Code | The service still has a `railway.json` path set. Run `railway config migrate` first. |
