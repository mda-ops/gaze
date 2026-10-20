# Gaze currency integration handover

Repository: `amdeganck/gaze-dashboard`. Python HTTP application in `app/web.py`,
Pandas analytics, Revenue Catcher PostgreSQL as the primary production source,
and API/JSON imports as alternative sources. Railway serves `adggaze.up.railway.app`.

## Currency correction, September 2026

Revenue Catcher stores native transaction amounts: F2F in EUR, OF/KNKY in USD.
Its UI offers converted EUR/USD totals. Gaze reports in EUR; raw USD must never
be formatted or summed as EUR.

`app/currency.py` normalizes monetary fields before analytics and source caching.
It reads the latest `fx_rate_cache.eur_usd_rate` ordered by `fetched_at` from the
same database. This is USD per EUR, so divide USD amounts by the rate. The rate
is not hard-coded. Without a database, the adapter uses `/api/shifts/fx-rate`.
Missing/invalid rates fail rather than silently assuming parity.

The legacy `/api/revenue/summary` endpoint returns unlabeled scalar aggregates.
These are rejected rather than labeled EUR. Live loading skips that response and
retains transaction detail. Chatter revenue cards also retain detailed EUR metrics
when creator detail is present instead of overriding them with summary totals.

Explicit row currency takes precedence, with platform-based inference only for
missing currency. New `{eur, usd}` summary values use their EUR member directly.
Gross, net components, transaction-type revenue, and shift commissions share the
same conversion. Hours, counts, percentages, and already-EUR inactivity costs do
not change. Conversion happens before aggregation without per-row rounding.

Source transactions are never rewritten. Historical views loaded from PostgreSQL
use the current Revenue Catcher rate, matching its current display convention.
Old local SQLite imports are not migrated by this change and should be reimported
from the updated adapter if used outside the production PostgreSQL configuration.

Revenue Catcher's manager revenue also excludes transactions whose status is
`done`. The PostgreSQL source applies that eligibility rule before conversion and
aggregation, so those in-progress records cannot inflate Gaze totals.

Tests: `python -m unittest discover -s tests -v`. Currency regressions cover native
EUR/USD, negative and missing amounts, gross/net consistency, dual-currency
summaries, API shifts/transactions, invalid rates, and cache idempotence.

Preserve the existing dashboard design, attribution, deduplication, commission
rules, and performance features. Do not rebuild the app or change source data to
fix display currency. Keep this file updated with important integration changes.
