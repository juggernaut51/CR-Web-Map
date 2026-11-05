# CR Web Map

An interactive campus map for College of the Redwoods, with a public map view and an
admin editor for buildings, rooms, entrances, stairwells, parking lots and walkways.

- **Public map** (`/`) — Leaflet map with search, routing between entrances, and a
  bug-report form.
- **Admin editor** (`/admin`, password-protected) — draw and edit campus features and
  the walkway network, with bulk select/delete, polygon erase, and a GeoJSON export.

The server is Express + PostgreSQL (`server.js`, `db.js`, `store.js`, `walkwayStore.js`,
`bugStore.js`). Feature and walkway data is stored in Postgres; `data/features.json` and
`data/walkways.json` are the seed data used to populate an empty database.

## Local development (docker-compose)

```
docker-compose up
```

This starts a Postgres container and the app (via `npm run dev`, which runs the server
under `nodemon`) on `http://localhost:5000`. `docker-compose.yml` already sets everything
needed for local use:

- `COOKIE_SECURE: "false"` — the admin login cookie is marked `Secure` by default, which
  requires HTTPS. Running over plain `http://localhost`, the cookie would be rejected by
  the browser unless this is set to `"false"`.
- `ADMIN_PASSWORD: ${ADMIN_PASSWORD:-admin}` — the dev admin password defaults to `admin`
  unless overridden in the environment.
- `SEED_FROM_JSON: "true"` — on first run, with an empty database, the app loads
  `data/features.json` and `data/walkways.json` automatically (see **Seeding** below).

Log in at `/` with the admin password, then open `/admin`.

## Environment variables

Every environment variable the code reads (`grep -o "process.env.[A-Z_]*"` across the
repository), its purpose, and whether it's required:

| Variable | Required? | Purpose |
|---|---|---|
| `ADMIN_PASSWORD` | **Required** | Shared password checked by `/login` for admin access. The server refuses to start without it. |
| `SESSION_SECRET` | **Required** | Secret used to sign the session cookie. The server refuses to start without it. |
| `POSTGRES_HOST` | Required for a working DB connection | Postgres host. |
| `POSTGRES_PORT` | Optional (default `5432`) | Postgres port. |
| `POSTGRES_POST` | Optional | Legacy alias for `POSTGRES_PORT`, only read if `POSTGRES_PORT` is unset. Prefer `POSTGRES_PORT`. |
| `POSTGRES_USER` | Required for a working DB connection | Postgres user. |
| `POSTGRES_PASS` | Required for a working DB connection | Postgres password. |
| `POSTGRES_DB` | Optional (default `postgres`) | Postgres database name. |
| `POSTGRES_SSL` | Optional (default off) | Set to the string `"true"` to connect to Postgres over SSL (with `rejectUnauthorized: false`). Any other value, or unset, disables SSL. |
| `SEED_FROM_JSON` | Optional (default off) | Set to the string `"true"` to import `data/features.json` and `data/walkways.json` into empty `features`/`walkways` tables on startup. See **Seeding**. |
| `PORT` | Optional (default `5000`) | Port the server listens on. |
| `COOKIE_SECURE` | Optional (default secure) | Set to the string `"false"` to allow the admin session cookie over plain HTTP (needed for local development). Any other value, or unset, marks the cookie `Secure` (HTTPS only). |
| `SESSION_COOKIE_MS` | Optional (default 7 days, in milliseconds) | Session cookie max age. |
| `DISCORD_WEBHOOK_URL` | Optional | If set, new bug reports (from the public map's bug-report form) are also posted to this Discord webhook URL. |
| `RAILWAY_GIT_COMMIT_SHA` | Optional | Set automatically by Railway; used as a cache-busting suffix (`?v=`) on static asset URLs. Falls back to the current timestamp when unset. |

## Railway notes

The app deploys from the repository's `Dockerfile` (`node:20-alpine`, `npm ci`, then
`node server.js`), listening on the port Railway provides via `PORT`.

Railway's Postgres plugin exposes its own connection variables (host, port, user,
password, database, and a connection URL) under its own names. This app does not read a
connection URL — it reads the individual `POSTGRES_HOST` / `POSTGRES_PORT` /
`POSTGRES_USER` / `POSTGRES_PASS` / `POSTGRES_DB` variables listed above, so these need
to be set in the app service's environment, pointing at the Postgres plugin's values
(e.g. referencing `<postgres-service>.PGHOST`, `<postgres-service>.PGPORT`, etc. in
Railway's variable editor — the exact reference names are shown in Railway's dashboard
for your project).

At minimum, set: `ADMIN_PASSWORD`, `SESSION_SECRET`, and the `POSTGRES_*` variables.
Optionally set `POSTGRES_SSL=true` if Railway's Postgres requires SSL, and
`DISCORD_WEBHOOK_URL` for bug-report notifications. Leave `COOKIE_SECURE` unset in
production (Railway serves over HTTPS, so the cookie should stay `Secure`).

## Seeding

On startup, the server ensures the `features` and `walkways` tables exist. If
`SEED_FROM_JSON=true`, it then checks whether each table is still empty
(`SELECT COUNT(*)`); only when a table has zero rows does it import the matching file
(`data/features.json` into `features`, `data/walkways.json` into `walkways`). If a table
already has any rows, the import is skipped — this only ever populates a fresh,
empty database, and never overwrites existing data.

## Backup and restore

There are two kinds of backup:

### Full database backup (includes bug reports)

A full `pg_dump` is the only backup that also includes bug reports (the `bug_reports`
table) — the JSON backups below only cover `features` and `walkways`.

```
pg_dump "<DATABASE_PUBLIC_URL>" -Fc -f cr-map.dump
```

To restore into an empty database:

```
pg_restore --clean --no-owner -d "<DATABASE_PUBLIC_URL>" cr-map.dump
```

### JSON backup (features and walkways only)

Two lighter-weight options, both producing the same `{ "features": [...] }` shape as
`data/features.json` / `data/walkways.json`, and both restored the same way:

- **Quick backup** — with the server running, save
  `https://<your-site>/api/features` and `https://<your-site>/api/walkways` from the
  browser (e.g. "Save Page As" on each URL).
- **Admin export** — in `/admin`, use "Download GeoJSON" to download `features.json`
  and `walkways.json` directly (see below).

**To restore either one:** put the two files in `data/` (replacing the existing
`features.json` and `walkways.json`), point the server at an **empty** database, and
start it with `SEED_FROM_JSON=true`. The server will import them on startup, as
described in **Seeding** above.

### Admin export ("Download GeoJSON")

The admin editor's "Download GeoJSON" button downloads two files, `features.json` and
`walkways.json`, each shaped exactly like the corresponding file in `data/`. The browser
may ask once to allow multiple downloads from the page — allow it so both files save.

## Tests

`npm test` runs a Playwright suite (`tests/`) that drives the real app — both pages, in a
real browser — against a local Postgres database, replaying the checks that were done by
hand after each round of fixes (auth redirects, the admin draw/edit/delete tools, routing
distances, bug reports, XSS escaping, and more).

```
npm ci
npx playwright install chromium   # once per machine
npm test
```

- The tests never touch the app's own `POSTGRES_*` variables or the app's database.
  They read their own `TEST_POSTGRES_HOST` (default `localhost`), `TEST_POSTGRES_PORT`
  (default `5432`), `TEST_POSTGRES_USER` and `TEST_POSTGRES_PASS`, and always use a
  database named `crmap_test`, which each spec file drops and recreates from scratch
  before seeding it from `data/*.json`. The Postgres user named by `TEST_POSTGRES_USER`
  needs the `CREATEDB` privilege for this.
- The suite refuses to run at all unless `TEST_POSTGRES_HOST` resolves to `localhost`,
  `127.0.0.1` or `::1` — it will not run against a remote or production database.
- The map libraries the pages load from unpkg (Leaflet, Leaflet.draw, Turf, and
  leaflet-path-drag) are served from `node_modules` instead during tests, and every
  other external host (map tiles, fonts, the campus logo) is answered locally too, so
  the suite needs no internet access and `npm ci` does not download a browser — only
  `npx playwright install chromium` does, and only needs to run once per machine.
- Tests run with a single worker, in the order the spec files are listed, since each
  spec file's tests share one freshly seeded database and one `node server.js` instance
  for that file.
