# Rewrite: handover

State of the TypeScript rewrite when it was handed over (2026-10-20), how to
work on it, and everything still left to do. Read this first; the other two
files in this folder are the details:

- `00-baseline-and-inventory.md`: why the old app was slow, and every route of
  the Python app with its data sources.
- `01-intended-differences.md`: where v2 deliberately differs from the Python
  app, what was not carried over, and the Python bugs v2 still reproduces.

## Where things stand

- All 44 pages of the Python app are rebuilt in `v2/` (the 45th, /data-quality,
  was dropped on purpose; see `01-intended-differences.md`).
- Every page with numbers has a parity test that compares v2 with numbers
  captured from the Python app (see "Tests" below).
- v2 runs on Railway in its own environment of the Gaze project and works there
  (confirmed 2026-10-19). The Python app is still the live one: Railway builds it
  from the repository root, and v2 from `v2/` only (`v2/railway.json`).
- Test run on 2026-10-20: frontend 17/17 pass; backend 165/168 pass. The 3
  failures are listed as the first open task below.
- Everything is on the `rewrite` branch, pushed. Nothing is merged into `main`.

## Layout

```
v2/
  package.json          backend dependencies and all npm scripts
  railway.json          Railway build/start/health check for the v2 service
  .env                  local secrets (gitignored), see "Running locally"
  reference/            captured Python-app numbers (gitignored), see "Tests"
  backend/src/
    server.ts           starts Fastify, runs Gaze DB migrations first
    app.ts              registers plugins and routes
    db/                 flow-db.ts (read-only Flow pool), gaze-db.ts, migrations.ts
    queries/            shared SQL: transactions, page-rows (PAGE_ROWS_CTE), fx rate,
                        finance inputs, activity; legacy/ = frozen Python SQL for tests
    pages/              one file per page (or page group): <page>.ts builds the
                        page data in SQL, <page>.parity.test.ts compares it
    lib/                shared logic: period/filters, inactivity cost, Looker
                        sources (lib/looker), py-format (Python-style number text),
                        rich-text (site blocks), auth, passwords, settings
    routes/             HTTP routes; pages.routes.ts serves /api/pages/<page>
    scripts/            import-settings, set-password
    test-support/       reference.ts: reads v2/reference for the parity tests
  frontend/src/
    App.tsx, pages.ts   page list and routing (PAGES)
    pages/              one React page per Python page (or group)
    components/         shared UI: tables, cards, charts, filters
    lib/                format.ts (Python-identical number formatting),
                        pythonTable.ts (column formats by Python's rules), csv
    gaze.css            the Python app's styles.css, ported
    content/ARCHITECTURE.md  copy of the root ARCHITECTURE.md for /architecture
  tools/                Python scripts run against the OLD app (capture references,
                        export settings); run them from the repo root with .venv
```

Stack: Node 20+, TypeScript, Fastify + zod + pg on the backend, React + Vite +
TanStack Query on the frontend. No CSS framework: the look is the old
`app/static/styles.css`.

## Databases

- **Flow** (`FLOW_DATABASE_URL`): Flow's Postgres, strictly read-only. The pool
  also sets `default_transaction_read_only=on` and `jit=off`. v2 never writes
  there.
- **Gaze** (`GAZE_DATABASE_URL`): Gaze's own small Postgres for users, sessions,
  permissions, site blocks, settings and profile photos (replaces the Python
  app's `data/settings.json` and static photo files). Migrations live in
  `backend/src/db/migrations.ts` and run automatically on start. Add a new
  migration at the end of the list; never edit an applied one.

## Running locally

1. Postgres for Gaze's own DB (any local Postgres; create an empty database).
2. `v2/.env`:
   ```
   FLOW_DATABASE_URL=postgres://<read-only role>:...@.../...
   GAZE_DATABASE_URL=postgres://...@localhost:5432/gaze_dev
   ```
   `PORT` is optional (default 8767; the Python app uses 8766).
3. In `v2/`: `npm install`, then `npm run serve` (builds backend and frontend,
   starts on http://localhost:8767).
4. Users: import the Python app's settings (below) or create one and run
   `npm run set-password -- <key or username>`.
5. Frontend development with hot reload: `npm run serve` in `v2/`, plus
   `npm run dev` in `v2/frontend/` (Vite proxies `/api` to 8767).

Importing the Python app's users, permissions, site blocks and settings:

```
# repo root, with the Python app's .venv
.venv/Scripts/python v2/tools/export_settings.py data/settings.json > settings-export.json
# v2/
npm run import-settings -- ../settings-export.json
```

This **replaces** users, site blocks and settings in the target Gaze DB. Do not
commit `settings-export.json` (it holds password hashes).

## Tests

- Backend: `npm run test:backend` in `v2/`. Frontend: `npm test` in
  `v2/frontend/`.
- Parity tests (`*.parity.test.ts`) need `FLOW_DATABASE_URL` and the captured
  references in `v2/reference/`. That folder is gitignored (real revenue data),
  so it is not in the repository: get a copy privately. Without it the parity
  tests are skipped, not failed.
- Captures used: `2026-10-15` (full), `2026-10-16` (re-capture of the
  2026-10-01 pages; the 2026-10-01 commissions capture is invalid and excluded),
  `looker/` (Looker source outputs). `2026-10-15_with-timeouts` is kept only as
  evidence of the old app's silent EUR 0 bug.
- Flow's miner corrects recent days after the fact, so the tests compare only
  days before `SETTLED_BEFORE` (2026-10-10, in `test-support/reference.ts`).
  Flow keeps only the latest EUR/USD rate, so tests pass the capture's rate
  (`fx-rate.json`) to the page.
- HR status and other live Flow data drift since the capture; tests that touch
  them compare sets or "still contains" instead of exact lists (see comments in
  the tests).
- New captures: the steps are in the docstring of
  `v2/tools/capture_reference.py` (start the Python app with
  `run_legacy_for_reference.py`, which raises its 7 s query timeout; a timeout
  must fail loudly, never produce EUR 0).

## Adding or changing a page

The pattern every page follows:

1. `backend/src/pages/<page>.ts`: the page data, aggregated in SQL on top of
   `PAGE_ROWS_CTE` (`queries/page-rows.ts`). Never send raw transaction rows to
   the browser.
2. A route in `backend/src/routes/pages.routes.ts` (`/api/pages/<page>`), with
   the page's access checked like the others (`requirePage`).
3. `frontend/src/pages/<Page>.tsx`, registered in `PAGES`.
4. A parity test next to the page file when it shows numbers.
5. Any deliberate difference from the Python app goes into
   `01-intended-differences.md`.

Gotchas that already cost time:

- Number text must match Python: use `format.ts` (`pyFixed`, `grouped`) on the
  frontend and `lib/py-format.ts` on the backend, never `toLocaleString`
  (Python rounds the exact binary value, ties to even).
- When summing money where a median of two values matters, sum as `numeric`
  and cast to float at the end.
- Inactivity timestamps are integer epoch microseconds; float milliseconds
  drift.
- Rows with equal values: v2 orders them by name (pandas' order depends on the
  CPU). Tests compare ties as sets.
- Never select password, TOTP, session-cookie or token columns from Flow.
- Git Bash rewrites arguments starting with `/`: prefix with
  `MSYS_NO_PATHCONV=1`.

## Deployment (Railway)

- Gaze's Railway project, separate environment for v2, config path
  `/v2/railway.json`. Health check: `GET /api/health`.
- Variables: `FLOW_DATABASE_URL` (read-only role, over Flow's public proxy) and
  `GAZE_DATABASE_URL` (the Gaze Postgres in the same environment). Railway sets
  `PORT`.
- Server errors are logged with an `[error]` prefix and show in Railway's logs.
- Migrations run on every start, before the server accepts requests.

## What is left, in order

### 1. Performance Hub 2 parity: 3 failing tests

`backend/src/pages/performance-hub.parity.test.ts`, "hub 2" for all three
ranges: the "HR Data Coverage" note says "5 missing capacity" where the capture
says "6 missing capacity". Every other value on the page matches. Not
investigated. The likely cause is live HR data in Flow changing since the
capture (the same test already allows for Xaviera's HR status changing). To
confirm: list the chatters with zero capacity in the latest week now and
compare with the capture's Chatter Capacity table. If it is drift, relax that
one assertion like the HR status one; if not, fix the count.

### 2. Notion is not ported

The Python app reads Notion live when a Notion token is set
(`app/notion_source.py`; variables `NOTION_TOKEN` / `NOTION_API_KEY` /
`NOTION_TICKETS_TOKEN` and others, `NOTION_EMPLOYEE_DATABASE_ID`,
`NOTION_TICKETS_DATABASE_ID`):

- /c-hub/tickets and /notion-tickets: live Notion tickets. v2 shows only the
  cached snapshot `notion_tickets.csv` (`lib/looker/sources.ts`, `ticketsData`).
- /c-hub/performance and /c-hub/performance-2 (and the /c-hub landing): HR
  status, team and tier from the Notion employee roster override Flow's
  chatter grades. v2 uses Flow's chatter grades only.

The references were captured without a Notion token, so v2 matches the Python
app as it ran then. **Check whether the production Python app on Railway has a
Notion token set.** If it does, production shows different tickets and HR data
than v2, and the Notion reading must be ported before cutover.

### 3. Sign-off on the differences

Go through `01-intended-differences.md` with the person who signs off on the
numbers:

- "Data and numbers", "Display" and "Behaviour": changes v2 already makes.
  Each needs a yes or a revert. Commissions taking plans only from Flow is
  already agreed (2026-10-19).
- "Known Python-app issues kept for now": bugs v2 still reproduces on purpose
  so the numbers match (case-sensitive inactivity team filter, uncapped
  "exact hour" rates, Performance Hub dropping shifts, /ask resetting filters,
  tie order). Decide fix or keep for each; most are one-line changes.
- "Not carried over": confirm that dropping the "Revenue Catcher
  Chatter/Creator Directory" tables on /chatters and /creators is fine.

### 4. Production settings and users

- Export production's `data/settings.json` with `export_settings.py` and import
  it into the v2 Gaze DB on Railway (`npm run import-settings`, run locally with
  `GAZE_DATABASE_URL` pointing at Railway's Gaze Postgres).
- v2 has no shared `APP_PASSWORD` / `VIEWER_PASSWORD` login. Everyone who has
  logged in only through those needs a personal password
  (`npm run set-password`), or they cannot log in after cutover.
- Profile photos: photo links from the old app point to files on the old
  server; people may need to upload them again on /account.

### 5. Flow database access (before cutover)

Already described in `00-baseline-and-inventory.md` ("Open before cutover"):
Gaze's read-only Flow login can read far more than Gaze needs, including
secrets. Needs the Flow database owner. Steps:

1. Create a new least-privilege role with grants on only the tables Gaze reads,
   and on `users` and `creator_accounts` only the non-secret columns.
2. Remove the default privileges that give the current Gaze role (and
   `finance`) every new table.
3. Run v2's backend tests and the Python app against the new role.
4. Switch both apps' `FLOW_DATABASE_URL` / `REVENUE_CATCHER_DATABASE_URL` to it,
   then drop the old role.
5. Rotate the exposed agency sessions and 2FA secrets.

### 6. Cutover

1. Point people at the v2 service (Railway domain), or move the domain over.
2. Keep the Python service running, unused, for a short while as a fallback,
   then remove it.
3. Merge `rewrite` into `main`.
4. Once the Python service is removed, delete the old app (not before:
   Railway builds the live Python app from the repository root):
   - The Python app: `app/`, `tests/`, `tools/`, `requirements.txt`,
     `runtime.txt`, `Procfile`, `.railwayignore`, `START_REVENUE_ANALYTICS.bat`,
     `import_history_sample.py`, `import_revenue_summary_sample.py`,
     `import_rosters.py`, and `.env.example` (it lists the Python app's
     variables).
   - `data/`: the demo CSV and `column_mappings.json` belong to the dropped
     imports; `data/looker_sources/` is the Python app's copy (v2 reads its
     own, `v2/backend/data/looker_sources/`). Production's `data/settings.json`
     is not in git; keep a private copy until its import into v2 is checked.
   - `v2/tools/`: these scripts run against the Python app. Capture any last
     reference numbers before removing the app, then delete them.
   - Root `README.md`, `ARCHITECTURE.md`, `DEPLOYMENT.md`,
     `PROJECT_HANDOVER.md`: they describe the old app. Replace them with a v2
     README (this document is a good start), and change
     `v2/frontend/src/content/ARCHITECTURE.md` (shown on /architecture) to
     describe v2.
   - Optional: move `v2/` to the repository root, and change the Railway
     config path from `/v2/railway.json` to match.
   - The capture `v2/reference/2026-10-15_with-timeouts` (local only) is not
     used by any test; it only documents the old app's EUR 0 bug.

### 7. After launch

- A "Data Health" page (asked for 2026-10-19): last sync, latest transaction
  date, missing platform data, accounts with no recent revenue.
- Fix the kept Python issues chosen in step 3.
