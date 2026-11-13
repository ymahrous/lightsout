# Contributing to Lights Out Mafia

Thanks for helping. This page covers how to set up, how to make a change that can be merged, and how to report a problem.

## Before you start

- **Read [CONSTITUTION.md](CONSTITUTION.md).** It is a short list of what the game must keep: one copy of the rules, secrets sent only to their owner, no lost moves, no accounts or tracking, no CDN or build step. A pull request that breaks one of them is turned down, unless it also amends the constitution and explains why.
- **For anything bigger than a bug fix, open an issue first.** Say what you want to change and why. That way nobody spends a weekend on something that cannot go in.

## Set up

You need [Node.js](https://nodejs.org) 22 or newer.

```sh
npm install
npm run dev
```

Open <http://localhost:8080>. Rooms are kept in memory and the server restarts when you change its code. To play a table on your own, open the invite link in a few private windows, or seat bots from the lobby.

If you add a file to `public/`, restart the server: the list of files it serves is built when it starts.

## Run the tests

```sh
npm test
```

This runs every suite against the in-memory store in about ten seconds. If you change the server's storage or room handling, run the suite on PostgreSQL too. With Docker:

```sh
docker run --rm -d --name lom-test -p 5432:5432 \
  -e POSTGRES_USER=lom -e POSTGRES_PASSWORD=lom -e POSTGRES_DB=lom_test postgres:17
TEST_DATABASE_URL=postgres://lom:lom@localhost:5432/lom_test npm test
docker stop lom-test
```

Only use a throwaway database: the tests leave rows behind.

| You changed | Add or update tests in |
| --- | --- |
| Game rules (`shared/engine.js`) | `test/engine.test.js` |
| A store (`server/store/`) | `test/store.test.js`, which runs on both stores |
| How servers share rooms (`server/rooms.js`) | `test/cluster.test.js` |
| Pages, sockets, limits (`server/http.js`, `server/gateway.js`) | `test/server.test.js` |

The tests do not cover the browser. If you change anything in `public/`, try it in a browser, in a phone-width window too. If you change `public/sw.js` or `public/js/install.js`, use a private window. An installed older version keeps serving until it updates.

## Making a change

1. Branch from `main`.
2. Keep each pull request to one change.
3. Match the style of the file you are editing. There is no formatter. Each file starts with a comment saying what it is for, and comments explain why rather than what.
4. Update the docs in the same pull request when behaviour changes. That means the README's configuration table, the wire protocol and guarantees in `docs/ARCHITECTURE.md`, and `public/privacy.html` if the game starts keeping something new.
5. [AGENTS.md](AGENTS.md) lists the exact steps for common changes, such as adding a page, a setting or a game action. It is written for coding agents, but it works just as well for people.

### Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org) with a short, lowercase, imperative subject:

```
feat: add branded custom 404 page
fix: stop service worker from replacing subpages with the homepage
docs: explain the referee's view
test: cover seat takeover after a reload
```

Add a body when the reason for the change is not obvious from the subject.

### Pull request checklist

- [ ] `npm test` passes, and on PostgreSQL if you touched `server/rooms.js` or `server/store/`.
- [ ] New behaviour has a test.
- [ ] Docs are updated.
- [ ] No new dependency, or the pull request says why it is needed.
- [ ] Nothing loads from another site, and nothing new is tracked or stored.
- [ ] No secrets or real passwords in the diff.
- [ ] If you changed `public/`, you tried it in a browser.

## Reporting a bug

Open an issue and include:

- what you did, what you expected, and what happened instead;
- the browser and device;
- whether it was an online game or one-phone mode, how many players, and whether there were bots or a referee;
- if you run your own server, the log lines from around that time (the server logs one JSON object per line).

## Security problems

Do not open a public issue. Use **Security → Report a vulnerability** on the GitHub repository, which reaches the maintainers privately.

## Licence

Lights Out Mafia is MIT-licensed (see [LICENSE](LICENSE)). By contributing, you agree that your contribution is released under the same licence.
