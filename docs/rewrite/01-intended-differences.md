# Rewrite: intended differences from the Python app

Where v2 deliberately does **not** reproduce the Python app, and why. Everything
else is meant to match the Python app's numbers. Each rebuilt page has a parity
test against the captured reference (`v2/reference/2026-10-15`).

## Data and numbers

| Where | Python app | v2 | Why |
|---|---|---|---|
| All pages | When the transaction query exceeds its 7 s `statement_timeout`, every transaction is dropped and pages show EUR 0 revenue (`/insights` crashes). | Queries finish in about 1-2 s; a failure is an error, never a silent EUR 0. | Silent data loss. |
| Commissions | If loading the EUR/USD rate, Flow bonus rules or account targets fails, the page silently uses a rate of 1.0 and no bonus (seen in the 2026-10-01 capture). | A failed query is an error. | Silent wrong payouts. |
| Commissions | A chatter's revenue without a Flow rate for the date is paid at Gaze's own commission plan (8%). The Commission Plan table and the `/settings` editor maintain those plans. Without Flow net amounts, the first plan's percentages fill the external splits and team costs. | Like Flow: no rate pays 0%, labelled "No Flow rate (0%)" and still listed in the audit table. Gaze has no commission plans; without net amounts the splits stay unknown. | Commission plans live in Flow; Gaze copies them so both apps agree (decided with the Gaze developer, 2026-10-19). Effect: chatter base commission EUR -52 in September, EUR -312 for 1-18 October. |
| Commissions | English day-level bonus (`flat_day_threshold`) is never paid (reads `thresholdUsd`/`rate` from the top level of a config that keeps them in `tiers`). | As Flow: the highest tier whose USD threshold the chatter's day net clears pays its rate on the whole day's net. | Same outcome as Flow. No English chatter reached USD 1,000 net in a day in September, so no change yet. |
| Transactions with two shifts starting at the same instant | The resolved chatter is arbitrary. | The shift with the lower id wins. | Deterministic results. The Python query's own pick for the known case (2026-07-30) was the same. |

## Display

| Where | Python app | v2 | Why |
|---|---|---|---|
| Model Revenue cards | "nan" badges when a model or platform has no Flow account (e.g. "A / nan"). | Missing agency or tier shows nothing. | Display bug (pandas NaN printed as text). |
| Transactions, Commissions | "Data coverage note" about Revenue Catcher endpoints. | Removed. | Describes the old HTTP data source, not the database Gaze reads. |
| Tables | Clicking a column header throws a JavaScript error; no sorting. | Sorting works, on the unrounded values. | Bug in `app.js` (cell text passed where a cell was expected). |

## Behaviour

| Where | Python app | v2 | Why |
|---|---|---|---|
| Login | Shared `APP_PASSWORD` logs anyone in as admin "anne"; `VIEWER_PASSWORD` works for any viewer. | Personal passwords only. Existing personal password hashes keep working. | Shared passwords cannot be revoked per person. |
| Login | No limit on attempts. | 10 failed attempts per client and name per 15 minutes. | Brute-force protection. |
| Transactions | The type/threshold form resets the period to "Today". | The period is kept. | The form had no hidden period fields. |
| Account | An uploaded photo is saved as a file on the server (`/static/profile-photos/`), which a Railway redeploy deletes. | Saved in Gaze's database and served from `/api/account/photos/`. Photo links imported from the Python app that point to `/static/profile-photos/` will not load in v2: re-upload them. | v2 has no persistent disk; a stack change, not a feature. |
| Account | Two people can end up with the same username (login then picks one of them). | A username used by another person is refused with a message. | The v2 users table requires unique usernames. |
| Transactions export | Writes a file on the server and shows its path; filters on a non-existent "unlock" type, so it is empty. | "Export CSV" downloads the shown table (admins). No Excel export: the CSV opens in Excel. | The export never reached the user. |

## Notes

- /architecture shows a copy of the repository's `ARCHITECTURE.md` bundled
  into the frontend (`v2/frontend/src/content/ARCHITECTURE.md`), because the
  v2 service is built from `v2/` only. Copy the file again if the original
  changes.

## Not carried over

- Revenue Catcher HTTP API fallback, CSV/XLSX and JSON uploads, Google Sheet
  master imports, demo data and the /data-quality page (which listed those
  imports): they do not affect any page while the Flow database is configured
  (see `00-baseline-and-inventory.md`). Dropped with the Gaze developer's
  agreement (2026-10-19): an import fallback could show numbers that conflict
  with Flow. /data-sources keeps only its links.
- /settings keeps only the settings a page reads. Dropped: the Master Sheet ID
  and tab gids, the Revenue Catcher start date and API key (import-only), and
  `inactivity_threshold_minutes`, `low_revenue_per_hour_threshold` and
  `high_revenue_per_hour_threshold`, which the form saved but no page read.
- "Revenue Catcher Chatter/Creator Directory" tables on /chatters and
  /creators: they list the Python app's local lookup tables, filled only by the
  Revenue Catcher API sync above. They were empty when the reference was
  captured, so the pages showed no directory. To be confirmed with the Gaze
  developer.

- The `calculated_metrics` records /revenue-tiers writes on every view: the
  Python app stores them in its local database but nothing ever reads them.
  (Its Revenue Catcher HTTP fallback for ranges without database rows falls
  under the first point.)

## Known Python-app issues kept for now (decide at sign-off)

- **Inactivity team filter is case-sensitive.** Inactivity episodes carry the
  team in lower case (`dutch`), shifts and transactions in title case
  (`Dutch`). The team list offers both, and picking "Dutch" drops every
  inactivity episode. v2 reproduces this so the numbers match; making team
  matching case-insensitive is a one-line change.
- **Inactivity "exact hour" rates are uncapped.** When a model's shift covers
  only seconds of a clock hour that has revenue, that hour's rate becomes
  revenue / seconds of work (e.g. EUR 312,058/h for Emma on 2026-09-16), and
  an inactivity minute in that hour is priced at it. This inflates "money
  wasted" for a few chatters (Jeffrey: EUR 633/h on average in September).
  v2 reproduces the formula exactly.
- **Target table discovery always fails** in the Python app (psycopg reads the
  `%` in `ILIKE '%target%'` as a placeholder). No effect on numbers: its fixed
  list includes `account_targets`, the only usable table. v2 reads
  `account_targets` directly.
- **Performance Hub drops some shifts from hours.** pandas parses shift times without a format, guesses it from the first value, and turns timestamps without fractional seconds (exactly 0 microseconds) into NaT, so those shifts drop out of the hour union (e.g. 14 of 490 in the week of 2026-09-05). v2 reproduces this.
- **Order of rows with equal values in sorted tables and charts** (/revenue,
  /chatters, /creators, /platforms, the Looker/Hub pages). pandas sorts with
  NumPy's unstable quicksort, whose order for equal values depends on the CPU
  (the same data can come out differently on another machine), e.g. chatters
  with EUR 0 revenue, or models with 0 new fans. On /chatters it also decides
  their rank, and on OF New Fans which of several equal models is "Top
  Model". v2 keeps equal rows in name order. The values are the same.
- **Asking on /ask resets the period and filters.** The Python form sends
  only the question, so the answer is for "Today" with no filters, whatever
  was selected. v2 reproduces this.
