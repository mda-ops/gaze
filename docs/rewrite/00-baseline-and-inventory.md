# Rewrite: baseline and route inventory

Starting point for the TypeScript rewrite on the `rewrite` branch. Numbers were
measured on 2026-10-15 against the Flow database (read-only role), for the
range 2026-09-01 to 2026-10-14, the range a typical page loads (current month plus
comparison month).

## Database access

- The Gaze role has `SELECT` only, on 90 tables, with no superuser, create-role or create-db rights.
- The rewrite also connects with `default_transaction_read_only=on`, so a
  write fails even if grants change later.
- The transactions table holds 134,656 rows (2026-05-19 to today).

## Page-load baseline (current Python app)

| Step | Time |
|---|---|
| `load_postgres_transactions` end to end (3 parallel queries + pandas) | **8.44 s** |
| Opening a fresh Postgres connection (paid per query, no pool) | 1.83 s each |
| Transaction query, server execution | 2.31 s (39,207 rows) |
| Shift query, server execution | 0.03 s (3,279 rows) |
| Inactivity query, server execution | 0.03 s (9,130 rows) |

This is before any pandas aggregation or HTML rendering, and many pages load
more than one range.

### Where the transaction query spends its time

The sequential scan of `transactions` costs only 66 ms. About 1.6 s of the 2.3 s
goes to the `shift_match` LATERAL in `TRANSACTION_SQL`, which runs once per
transaction (39,207 times). Each run uses `idx_shifts_creator_id` and reads about
333 shift rows of that creator's full history. It also runs for transactions that
already have a `chatter_id`, where its result is discarded by the `COALESCE`.

A set-based rewrite does the following:

- matches only transactions with no `chatter_id` (24,536 of 39,207);
- considers only shifts that overlap the window;
- uses one hash join, keeping the latest `clock_in` the same way
  `ORDER BY clock_in DESC LIMIT 1` does.

With that rewrite, the shift-match step goes from 1.51 s to **0.33 s**. Every one
of the 39,207 transactions resolves to the same chatter. The rewrite needs no
new index.

### Ported transaction query (v2)

`v2/backend/src/queries/transactions.ts`, with the shift-match rewrite above and
the date range applied to `occurred_at` before the joins.
`transactions.parity.test.ts` checks it returns identical rows and columns to the
Python query for three ranges (105,034 rows over the full history).

| Range 2026-09-01 to 2026-10-14 | Python query | v2 query |
|---|---|---|
| Server execution | 2.3-2.8 s | **1.13-1.24 s** (with `jit=off`) |

- **JIT:** the v2 pool sets `jit=off`. JIT compilation cost about 0.74 s per run
  of the v2 query and saved less than that. The Python query, with its
  per-row lookups, is slightly faster with JIT, which is why it isn't a general
  rule.
- **Transfer is now the main cost.** One typical page range is 39,207 rows,
  about 39.5 MB as JSON. Fetching it over Railway's public proxy took 4-10 s
  with either query, varying from run to run. Pages must aggregate in Postgres
  and return small results, never the raw rows.
- **Tied shifts:** two shifts on the same creator/platform with an identical
  `clock_in` (seen 2026-07-30) made the Python query's chosen chatter
  arbitrary. Both queries now break the tie on the lower shift id, which is
  what the Python query returned for those rows.

## Reference numbers

Captured 2026-10-15 from the Python app running locally with default settings
(no production `settings.json` yet). The captured pages are gitignored in
`v2/reference/<date>/`, because they contain real revenue figures.
`v2/tools/extract_reference.py` turns them into `numbers.json` (cards, tables
with unrounded values, chart data). Captured ranges: September 2026, the week
2026-10-02 to 2026-10-08, and the day 2026-10-01, each compared with the
previous period. All 116 page loads returned 200.

### The Python app silently drops all revenue on a timeout

The Python app reads Postgres with `statement_timeout=7000`. The transaction
query for September plus its comparison period took 13.7-17.3 s and was
cancelled in 2 of 3 runs. When that happens, `_read_sql_or_empty` logs the
error and returns no rows. Shifts and inactivity still load, so pages render
normally with **EUR 0 revenue**. The empty result is then cached for 180 s.

- Example: the Executive Overview for September showed Total Revenue EUR 0.00
  (correct: EUR 710,662.61).
- `/insights` crashes in that state (`app/insights.py:34` formats a missing
  revenue share).
- 36 of the pages in a first capture were affected.

The reference capture therefore runs through
`v2/tools/run_legacy_for_reference.py`. It raises only the timeout (to 180 s)
and stops the capture loudly on a timeout instead of recording EUR 0 pages.
Whether production hits this too depends on how fast it reaches the database.
The timeout also counts the time spent streaming rows, so the slower the link,
the more often it fires.

### Slowest pages in the Python app (seconds, without timeouts)

| Page | Month | Week | Day |
|---|---|---|---|
| `/c-hub` | 131.9 | 38.2 | 14.8 |
| `/c-hub/inactivity` | 118.4 | 25.8 | 3.9 |
| `/inactivity` | 117.2 | 34.4 | 4.0 |
| `/c-hub/commissions` | 65.1 | 54.2 | (stalled run, discarded) |
| `/commissions` | 61.2 | 23.5 | 21.3 |
| `/c-hub/executive-overview` | 33.3 | 22.0 | 23.8 |
| `/c-hub/revenue` | 29.5 | 8.8 | 8.3 |

Pages were loaded one after another, so some loads were served from the app's
180 s cache and look faster than a cold load.

## What production actually uses

When `REVENUE_CATCHER_DATABASE_URL` is set (production, per
`PROJECT_HANDOVER.md`):

- `load_transactions` returns Postgres data and never reads SQLite
  (`app/database.py:175`).
- The Revenue Catcher HTTP API (`flow-api*` below) is called only when Postgres
  returns no revenue (`merge_live_revenue_catcher`, `app/web.py:704`).
- As a result, CSV/XLSX uploads, Google Sheet master imports, demo data and the
  `/import-*-api` actions do not affect any analysis page in production. They
  appear only on Data Sources and Data Quality.
- The exception is the creator/chatter lookup tables (filled by
  `/upload-creators-json` and `/upload-chatters-json`), which Chatters and
  Creators still read.
- `flow_manager_dashboard_summary` (`app/web.py:3708`) calls Flow's HTTP endpoint
  `/api/dashboard/revenue-summary` when `FLOW_MANAGER_AUTH_TOKEN` or
  `FLOW_MANAGER_API_KEY` is set. To be checked against Gaze's Railway variables.

## Route inventory

There are 65 routes: 45 GET pages and 20 POST actions. The data sources and settings
listed for each route are the ones reachable through its call graph (generated
statically from `app/*.py`). `flow-api*` is the fallback described above.
`site_blocks` is read by every page through the shared shell.

| Method | Route | Handler | Data sources | Settings read |
|---|---|---|---|---|
| GET | `/` | `welcome` (web.py:4145) | - | site_blocks |
| GET | `/revenue` | `revenue` (web.py:4262) | flow-api*, flow-db:fx_rate, flow-db, sqlite-fallback | default_currency, reporting_week_start, revenue_catcher_api_key, revenue_catcher_base_url, site_blocks, timezone |
| GET | `/chatters` | `chatters` (web.py:4274) | flow-api*, flow-db:fx_rate, flow-db, sqlite:creator/chatter lookup, sqlite-fallback | default_currency, reporting_week_start, revenue_catcher_api_key, revenue_catcher_base_url, site_blocks, timezone |
| GET | `/creators` | `creators` (web.py:4289) | flow-api*, flow-db:fx_rate, flow-db, sqlite:creator/chatter lookup, sqlite-fallback | default_currency, reporting_week_start, revenue_catcher_api_key, revenue_catcher_base_url, site_blocks, timezone |
| GET | `/platforms` | `platforms` (web.py:4301) | flow-api*, flow-db:fx_rate, flow-db, sqlite-fallback | default_currency, reporting_week_start, revenue_catcher_api_key, revenue_catcher_base_url, site_blocks, timezone |
| GET | `/inactivity` | `inactivity` (web.py:4311) | flow-api*, flow-db:creator_tiers, flow-db:fx_rate, flow-db, sqlite-fallback | default_currency, reporting_week_start, revenue_catcher_api_key, revenue_catcher_base_url, site_blocks, timezone |
| GET | `/transactions` | `transactions` (web.py:4399) | flow-api*, flow-db:fx_rate, flow-db, sqlite-fallback | default_currency, reporting_week_start, revenue_catcher_api_key, revenue_catcher_base_url, site_blocks, timezone, unlock_threshold |
| GET | `/commissions` | `commissions` (web.py:4412) | flow-api*, flow-db:account_targets, flow-db:fx_rate, flow-db:scheduled_shifts, flow-db:team_rules, flow-db, sqlite-fallback | commission_rules, default_currency, english_chatter_salary_usd_per_hour, operating_expenses, reporting_week_start, revenue_catcher_api_key, revenue_catcher_base_url, site_blocks, timezone |
| GET | `/insights` | `insights` (web.py:4533) | flow-api*, flow-db:fx_rate, flow-db, sqlite-fallback | anomaly_revenue_drop_pct, anomaly_revenue_spike_pct, default_currency, reporting_week_start, revenue_catcher_api_key, revenue_catcher_base_url, site_blocks, timezone |
| GET | `/revenue-tiers` | `revenue_tiers` (web.py:4541) | flow-api*, flow-db:fx_rate, flow-db, sqlite-fallback | default_currency, reporting_week_start, revenue_catcher_api_key, revenue_catcher_base_url, site_blocks, timezone |
| GET | `/weekly-report` | `weekly_report_page` (web.py:4611) | flow-api*, flow-db:fx_rate, flow-db, google_sheets, looker_csv_snapshot, sqlite-fallback | default_currency, reporting_week_start, revenue_catcher_api_key, revenue_catcher_base_url, site_blocks, timezone |
| GET | `/monthly-report` | `monthly_report_page` (web.py:4619) | flow-api*, flow-db:fx_rate, flow-db, google_sheets, looker_csv_snapshot, sqlite-fallback | default_currency, reporting_week_start, revenue_catcher_api_key, revenue_catcher_base_url, site_blocks, timezone |
| GET | `/ask` | `ask` (web.py:4627) | flow-api*, flow-db:fx_rate, flow-db, sqlite-fallback | default_currency, reporting_week_start, revenue_catcher_api_key, revenue_catcher_base_url, site_blocks, timezone |
| GET | `/data-quality` | `data_quality` (web.py:4645) | sqlite:imports/quality | site_blocks |
| GET | `/data-sources` | `data_sources` (web.py:4651) | - | revenue_catcher_api_key, revenue_catcher_base_url, revenue_catcher_start_date, site_blocks |
| GET | `/settings` | `settings` (web.py:4715) | - | site_blocks |
| GET | `/edit-site` | `edit_site` (web.py:4727) | - | site_blocks |
| GET | `/account` | `account` (web.py:4857) | - | site_blocks |
| GET | `/permission-groups` | `permission_groups` (web.py:4918) | - | site_blocks |
| GET | `/people-access` | `people_access` (web.py:4921) | - | site_blocks |
| GET | `/metric-definitions` | `metric_definitions` (web.py:4997) | - | site_blocks |
| GET | `/inactivity-computation` | `inactivity_computation` (web.py:5008) | - | site_blocks |
| GET | `/architecture` | `architecture` (web.py:5071) | - | site_blocks |
| GET | `/c-hub` | `c_hub` (web.py:5089) | flow-api*, flow-db:creator_tiers, flow-db:fx_rate, flow-db, google_sheets, looker_csv_snapshot, notion_api, sqlite-fallback | default_currency, reporting_week_start, revenue_catcher_api_key, revenue_catcher_base_url, site_blocks, timezone |
| GET | `/c-hub/executive-overview` | `c_hub_executive_overview` (web.py:5176) | flow-api*, flow-db:fx_rate, flow-db:manager_transactions(visible_transactions), flow-db, sqlite-fallback | default_currency, reporting_week_start, revenue_catcher_api_key, revenue_catcher_base_url, site_blocks, timezone |
| GET | `/c-hub/revenue` | `c_hub_revenue` (web.py:5185) | flow-api*, flow-db:creator_accounts, flow-db:fx_rate, flow-db, sqlite-fallback | default_currency, reporting_week_start, revenue_catcher_api_key, revenue_catcher_base_url, site_blocks, timezone |
| GET | `/c-hub/chatter-revenue` | `c_hub_chatter_revenue` (web.py:5255) | flow-api*, flow-db:fx_rate, flow-db, sqlite-fallback | default_currency, reporting_week_start, revenue_catcher_api_key, revenue_catcher_base_url, site_blocks, timezone |
| GET | `/c-hub/inactivity` | `c_hub_inactivity` (web.py:5301) | flow-api*, flow-db:creator_tiers, flow-db:fx_rate, flow-db, sqlite-fallback | default_currency, reporting_week_start, revenue_catcher_api_key, revenue_catcher_base_url, site_blocks, timezone |
| GET | `/c-hub/transactions` | `c_hub_transactions` (web.py:5179) | flow-api*, flow-db:fx_rate, flow-db, sqlite-fallback | default_currency, reporting_week_start, revenue_catcher_api_key, revenue_catcher_base_url, site_blocks, timezone, unlock_threshold |
| GET | `/c-hub/commissions` | `c_hub_commissions` (web.py:5182) | flow-api*, flow-db:account_targets, flow-db:fx_rate, flow-db:scheduled_shifts, flow-db:team_rules, flow-db, sqlite-fallback | commission_rules, default_currency, english_chatter_salary_usd_per_hour, operating_expenses, reporting_week_start, revenue_catcher_api_key, revenue_catcher_base_url, site_blocks, timezone |
| GET | `/c-hub/performance` | `c_hub_performance` (web.py:5413) | flow-db:chatter_grades, flow-db:creator_tiers, flow-db:fx_rate, flow-db, notion_api, notion_snapshot_csv, sqlite-fallback | reporting_week_start, revenue_catcher_api_key, revenue_catcher_base_url, site_blocks, timezone |
| GET | `/c-hub/performance-2` | `c_hub_performance_2` (web.py:5502) | flow-db:chatter_grades, flow-db:creator_tiers, flow-db:fx_rate, flow-db:scheduled_shifts, flow-db, notion_api, notion_snapshot_csv, sqlite-fallback | reporting_week_start, revenue_catcher_api_key, revenue_catcher_base_url, site_blocks, timezone |
| GET | `/c-hub/compliance` | `c_hub_compliance` (web.py:5617) | looker_csv_snapshot | reporting_week_start, site_blocks, timezone |
| GET | `/c-hub/marketing-ads` | `c_hub_marketing_ads` (web.py:5637) | google_sheets, looker_csv_snapshot | reporting_week_start, site_blocks, timezone |
| GET | `/c-hub/models-socials` | `c_hub_models_socials` (web.py:5675) | looker_csv_snapshot | reporting_week_start, site_blocks, timezone |
| GET | `/c-hub/of-new-fans` | `c_hub_of_new_fans` (web.py:5706) | google_sheets, looker_csv_snapshot | reporting_week_start, site_blocks, timezone |
| GET | `/c-hub/ads-performance` | `c_hub_ads_performance` (web.py:5726) | google_sheets, looker_csv_snapshot | reporting_week_start, site_blocks, timezone |
| GET | `/c-hub/tickets` | `c_hub_tickets` (web.py:5755) | looker_csv_snapshot, notion_api | reporting_week_start, site_blocks, timezone |
| GET | `/c-hub/chatter-revenue-tier` | `c_hub_chatter_revenue_tier` (web.py:5304) | flow-db:fx_rate, flow-db, sqlite-fallback | reporting_week_start, revenue_catcher_api_key, revenue_catcher_base_url, site_blocks, timezone |
| GET | `/c-hub/target-monitoring` | `c_hub_target_monitoring` (web.py:5371) | flow-db:account_targets, flow-db:fx_rate, flow-db, sqlite-fallback | reporting_week_start, revenue_catcher_api_key, revenue_catcher_base_url, site_blocks, timezone |
| GET | `/compliance-dash` | `compliance_dash` (web.py:5779) | looker_csv_snapshot | reporting_week_start, site_blocks, timezone |
| GET | `/marketing` | `marketing` (web.py:5791) | google_sheets, looker_csv_snapshot | reporting_week_start, site_blocks, timezone |
| GET | `/models-socials` | `models_socials` (web.py:5807) | looker_csv_snapshot | reporting_week_start, site_blocks, timezone |
| GET | `/of-new-fan-growth` | `of_new_fan_growth` (web.py:5820) | google_sheets, looker_csv_snapshot | reporting_week_start, site_blocks, timezone |
| GET | `/ads-performance` | `ads_performance` (web.py:5832) | google_sheets, looker_csv_snapshot | reporting_week_start, site_blocks, timezone |
| GET | `/notion-tickets` | `notion_tickets` (web.py:5845) | looker_csv_snapshot, notion_api | reporting_week_start, site_blocks, timezone |
| POST | `/login` | `login` (web.py:4108) | - | site_blocks |
| POST | `/account` | `save_account` (web.py:4863) | settings.json:write | - |
| POST | `/account-password` | `save_account_password` (web.py:4900) | settings.json:write | site_blocks |
| POST | `/import-master-sheet` | `import_master_sheet` (web.py:6019) | google_sheets, sqlite:imports/quality | master_google_sheet_id, master_revenue_gid |
| POST | `/import-master-shifts-sheet` | `import_master_shifts_sheet` (web.py:6033) | google_sheets, sqlite:imports/quality | master_google_sheet_id, master_shifts_gid |
| POST | `/save-revenue-catcher-settings` | `save_revenue_catcher_settings` (web.py:5910) | settings.json:write | revenue_catcher_api_key |
| POST | `/upload` | `upload` (web.py:5858) | sqlite:imports/quality | - |
| POST | `/upload-revenue-catcher-json` | `upload_revenue_catcher_json` (web.py:5873) | sqlite:imports/quality | - |
| POST | `/upload-creators-json` | `upload_creators_json` (web.py:5888) | sqlite:creator/chatter lookup | - |
| POST | `/upload-chatters-json` | `upload_chatters_json` (web.py:5899) | sqlite:creator/chatter lookup | - |
| POST | `/import-revenue-catcher-api` | `import_revenue_catcher_api` (web.py:5923) | sqlite:imports/quality | revenue_catcher_api_key, revenue_catcher_base_url, revenue_catcher_start_date |
| POST | `/import-revenue-api` | `import_revenue_api` (web.py:5950) | sqlite:imports/quality | revenue_catcher_api_key, revenue_catcher_base_url, revenue_catcher_start_date |
| POST | `/import-revenue-summary-api` | `import_revenue_summary_api` (web.py:5977) | sqlite:imports/quality | revenue_catcher_api_key, revenue_catcher_base_url, revenue_catcher_start_date |
| POST | `/import-active-shifts-api` | `import_active_shifts_api` (web.py:6004) | sqlite:imports/quality | - |
| POST | `/edit-site` | `save_site_block` (web.py:4803) | settings.json:write | site_blocks |
| POST | `/delete-site-block` | `delete_site_block` (web.py:4828) | settings.json:write | site_blocks |
| POST | `/move-site-block` | `move_site_block` (web.py:4838) | settings.json:write | site_blocks |
| POST | `/permission-groups` | `save_permission_groups` (web.py:4978) | settings.json:write | - |
| POST | `/people-access` | `save_people_access` (web.py:4981) | settings.json:write | - |

## Open before cutover: FLOW database access (decided 2026-10-17: do at the end)

Gaze's read-only FLOW login (`anne`) can read every table, including user,
creator-account and platform-agency passwords, 2FA secrets and live agency
session cookies, and default privileges give it (and `finance`) every new
table automatically. Both Gaze apps need about 17 tables and, from `users`
and `creator_accounts`, only non-secret columns. Plan: a new least-privilege
role with table and column grants, verified against v2's tests and the old
app, both apps switched to it, `anne` dropped, default privileges removed,
and the exposed agency sessions and 2FA secrets rotated.
