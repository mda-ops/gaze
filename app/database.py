from __future__ import annotations

import sqlite3
from pathlib import Path
import json

import pandas as pd

from .config import DB_PATH, ensure_dirs
from .postgres_source import database_enabled, load_postgres_transactions


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_name TEXT NOT NULL,
    source_type TEXT NOT NULL,
    imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    row_count INTEGER NOT NULL,
    is_demo INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS raw_rows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id INTEGER NOT NULL,
    row_number INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    FOREIGN KEY(import_id) REFERENCES imports(id)
);

CREATE TABLE IF NOT EXISTS processed_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id INTEGER NOT NULL,
    row_number INTEGER NOT NULL,
    date TEXT,
    timestamp TEXT,
    creator TEXT,
    creator_id TEXT,
    chatter TEXT,
    chatter_id TEXT,
    platform TEXT,
    team TEXT,
    language TEXT,
    transaction_type TEXT,
    revenue REAL,
    currency TEXT,
    unlock_amount REAL,
    subscription_revenue REAL,
    tip_revenue REAL,
    message_revenue REAL,
    shift_id TEXT,
    shift_start TEXT,
    shift_end TEXT,
    shift_hours REAL,
    messages_sent REAL,
    active_hours REAL,
    inactive_minutes REAL,
    transaction_key TEXT,
    FOREIGN KEY(import_id) REFERENCES imports(id)
);

CREATE TABLE IF NOT EXISTS data_quality_issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id INTEGER NOT NULL,
    row_number INTEGER,
    severity TEXT NOT NULL,
    issue_type TEXT NOT NULL,
    field TEXT,
    message TEXT NOT NULL,
    FOREIGN KEY(import_id) REFERENCES imports(id)
);

CREATE TABLE IF NOT EXISTS calculated_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    metric_name TEXT NOT NULL,
    period_start TEXT,
    period_end TEXT,
    value REAL,
    details_json TEXT,
    calculated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS creator_lookup (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    agency TEXT,
    platforms_json TEXT,
    is_active INTEGER,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chatter_lookup (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT,
    created_at TEXT,
    has2fa INTEGER,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"""


def connect(path: Path = DB_PATH) -> sqlite3.Connection:
    ensure_dirs()
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


def init_db(path: Path = DB_PATH) -> None:
    with connect(path) as conn:
        conn.executescript(SCHEMA_SQL)


def record_calculated_metric(metric_name: str, period_start: str, period_end: str, value: float, details: dict | list | None = None) -> None:
    init_db()
    details_json = json.dumps(details or {}, default=str)
    with connect() as conn:
        conn.execute(
            "DELETE FROM calculated_metrics WHERE metric_name = ? AND period_start = ? AND period_end = ?",
            (metric_name, period_start, period_end),
        )
        conn.execute(
            """INSERT INTO calculated_metrics(metric_name, period_start, period_end, value, details_json)
               VALUES (?, ?, ?, ?, ?)""",
            (metric_name, period_start, period_end, float(value or 0), details_json),
        )


def insert_import(source_name: str, source_type: str, raw_df: pd.DataFrame, processed_df: pd.DataFrame, issues: list[dict], is_demo: bool = False) -> int:
    init_db()
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO imports(source_name, source_type, row_count, is_demo) VALUES (?, ?, ?, ?)",
            (source_name, source_type, len(raw_df), int(is_demo)),
        )
        import_id = int(cur.lastrowid)
        for index, row in raw_df.reset_index(drop=True).iterrows():
            conn.execute(
                "INSERT INTO raw_rows(import_id, row_number, payload_json) VALUES (?, ?, ?)",
                (import_id, index + 1, row.to_json(date_format="iso")),
            )
        if not processed_df.empty:
            processed = processed_df.copy()
            processed["import_id"] = import_id
            processed["row_number"] = range(1, len(processed) + 1)
            columns = [
                "import_id", "row_number", "date", "timestamp", "creator", "creator_id", "chatter",
                "chatter_id", "platform", "team", "language", "transaction_type", "revenue", "currency",
                "unlock_amount", "subscription_revenue", "tip_revenue", "message_revenue", "shift_id",
                "shift_start", "shift_end", "shift_hours", "messages_sent", "active_hours",
                "inactive_minutes", "transaction_key",
            ]
            for column in columns:
                if column not in processed.columns:
                    processed[column] = None
            processed[columns].to_sql("processed_transactions", conn, if_exists="append", index=False)
        for issue in issues:
            conn.execute(
                """INSERT INTO data_quality_issues(import_id, row_number, severity, issue_type, field, message)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (
                    import_id,
                    issue.get("row_number"),
                    issue.get("severity", "warning"),
                    issue.get("issue_type", "data_quality"),
                    issue.get("field"),
                    issue.get("message", ""),
                ),
            )
        return import_id


def load_transactions(start=None, end=None) -> pd.DataFrame:
    if database_enabled():
        return load_postgres_transactions(start=start, end=end)
    init_db()
    with connect() as conn:
        df = pd.read_sql_query(
            """SELECT p.*, i.source_name, i.source_type, i.imported_at
               FROM processed_transactions p
               LEFT JOIN imports i ON i.id = p.import_id""",
            conn,
        )
    if df.empty:
        return df
    df["date"] = pd.to_datetime(df["date"], errors="coerce").dt.date
    if start and end:
        df = df[(df["date"] >= start) & (df["date"] <= end)].copy()
    df["timestamp"] = pd.to_datetime(df["timestamp"], errors="coerce", utc=True, format="mixed")
    for col in ["revenue", "unlock_amount", "subscription_revenue", "tip_revenue", "message_revenue", "shift_hours", "messages_sent", "active_hours", "inactive_minutes"]:
        if col in df:
            df[col] = pd.to_numeric(df[col], errors="coerce")
    return df


def load_quality_issues() -> pd.DataFrame:
    init_db()
    with connect() as conn:
        return pd.read_sql_query(
            """SELECT q.*, i.source_name, i.imported_at
               FROM data_quality_issues q
               LEFT JOIN imports i ON i.id = q.import_id
               ORDER BY q.id DESC""",
            conn,
        )


def load_imports() -> pd.DataFrame:
    init_db()
    with connect() as conn:
        return pd.read_sql_query("SELECT * FROM imports ORDER BY imported_at DESC", conn)


def upsert_creator_lookup(creators_df: pd.DataFrame) -> int:
    init_db()
    if creators_df.empty:
        return 0
    with connect() as conn:
        count = 0
        for _, row in creators_df.iterrows():
            conn.execute(
                """INSERT INTO creator_lookup(id, name, agency, platforms_json, is_active, updated_at)
                   VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                   ON CONFLICT(id) DO UPDATE SET
                     name = excluded.name,
                     agency = excluded.agency,
                     platforms_json = excluded.platforms_json,
                     is_active = excluded.is_active,
                     updated_at = CURRENT_TIMESTAMP""",
                (
                    int(row["id"]),
                    str(row["name"]),
                    row.get("agency"),
                    json.dumps(row.get("platforms", [])),
                    int(bool(row.get("is_active"))),
                ),
            )
            count += 1
        return count


def load_creator_lookup() -> pd.DataFrame:
    init_db()
    with connect() as conn:
        df = pd.read_sql_query("SELECT * FROM creator_lookup ORDER BY name", conn)
    if df.empty:
        return df
    df["platforms"] = df["platforms_json"].apply(lambda value: ", ".join(json.loads(value or "[]")))
    return df.drop(columns=["platforms_json"])


def upsert_chatter_lookup(chatters_df: pd.DataFrame) -> int:
    init_db()
    if chatters_df.empty:
        return 0
    with connect() as conn:
        count = 0
        for _, row in chatters_df.iterrows():
            conn.execute(
                """INSERT INTO chatter_lookup(id, name, status, created_at, has2fa, updated_at)
                   VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                   ON CONFLICT(id) DO UPDATE SET
                     name = excluded.name,
                     status = excluded.status,
                     created_at = excluded.created_at,
                     has2fa = excluded.has2fa,
                     updated_at = CURRENT_TIMESTAMP""",
                (
                    int(row["id"]),
                    str(row["name"]),
                    row.get("status"),
                    row.get("created_at"),
                    int(bool(row.get("has2fa"))),
                ),
            )
            count += 1
        return count


def load_chatter_lookup() -> pd.DataFrame:
    init_db()
    with connect() as conn:
        return pd.read_sql_query("SELECT * FROM chatter_lookup ORDER BY name", conn)


def delete_demo_imports() -> int:
    init_db()
    with connect() as conn:
        ids = [row["id"] for row in conn.execute("SELECT id FROM imports WHERE is_demo = 1").fetchall()]
        if not ids:
            return 0
        placeholders = ",".join("?" for _ in ids)
        for table in ["raw_rows", "processed_transactions", "data_quality_issues"]:
            conn.execute(f"DELETE FROM {table} WHERE import_id IN ({placeholders})", ids)
        conn.execute(f"DELETE FROM imports WHERE id IN ({placeholders})", ids)
        return len(ids)
