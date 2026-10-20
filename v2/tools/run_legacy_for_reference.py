"""Run the Python Gaze app for reference captures, with a longer query timeout.

The Python app reads Postgres with statement_timeout=7000. Over Railway's
public proxy the transaction query for a month plus its comparison month often
exceeds that; the app then drops every transaction silently and pages show
EUR 0 revenue. For a trustworthy reference this launcher raises only that
timeout (to 180 s). Nothing in app/ is modified.

Usage (repo root, with REVENUE_CATCHER_DATABASE_URL set):
    .venv/Scripts/python v2/tools/run_legacy_for_reference.py
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.getcwd())

import pandas as pd  # noqa: E402

from app import postgres_source  # noqa: E402

TIMEOUT_MS = 180_000


def _read_sql_long_timeout(query: str, database_url: str, params: dict | None = None) -> pd.DataFrame:
    import psycopg

    options = f"-c statement_timeout={TIMEOUT_MS} -c default_transaction_read_only=on"
    with psycopg.connect(postgres_source._ssl_url(database_url), connect_timeout=10, options=options) as conn:
        with conn.cursor() as cur:
            cur.execute(query, params or {})
            columns = [desc.name for desc in cur.description]
            return pd.DataFrame(cur.fetchall(), columns=columns)


postgres_source._read_sql = _read_sql_long_timeout

# A timeout must fail loudly instead of silently recording EUR 0 pages. Other
# errors keep the app's own behaviour (log and continue with no rows), since
# some queries probe optional tables on purpose.
def _read_sql_or_empty_unless_timeout(label: str, query: str, database_url: str, params: dict | None = None) -> pd.DataFrame:
    import psycopg

    try:
        return _read_sql_long_timeout(query, database_url, params)
    except psycopg.errors.QueryCanceled:
        raise
    except Exception as exc:
        print(f"GAZE PostgreSQL source skipped {label}: {exc}", flush=True)
        return pd.DataFrame()


postgres_source._read_sql_or_empty = _read_sql_or_empty_unless_timeout

from app import web  # noqa: E402

if __name__ == "__main__":
    web.run(host="127.0.0.1", port=int(os.environ.get("PORT", "8766")))
