from __future__ import annotations

import os
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import pandas as pd
from .currency import normalize_revenue_catcher


CACHE_TTL_SECONDS = 180
MAX_TRANSACTION_CACHE_ENTRIES = 8
_CACHE: dict[tuple[str, str], tuple[float, pd.DataFrame]] = {}
_CHATTER_GRADE_CACHE: tuple[float, pd.DataFrame] | None = None
_TARGET_CACHE: tuple[float, pd.DataFrame] | None = None
_CREATOR_TIER_CACHE: tuple[float, pd.DataFrame] | None = None
_CREATOR_ACCOUNT_CACHE: tuple[float, pd.DataFrame] | None = None
_FLOW_TEAM_RULE_CACHE: tuple[float, pd.DataFrame] | None = None


def configured_database_url() -> str:
    return (
        os.environ.get("REVENUE_CATCHER_DATABASE_URL")
        or os.environ.get("GAZE_DATABASE_URL")
        or ""
    ).strip()


def database_enabled() -> bool:
    return bool(configured_database_url())


def _ssl_url(database_url: str) -> str:
    parsed = urlparse(database_url)
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    query.setdefault("sslmode", "require")
    return urlunparse(parsed._replace(query=urlencode(query)))


def _read_sql(query: str, database_url: str, params: dict | None = None) -> pd.DataFrame:
    try:
        import psycopg
    except ImportError as exc:
        raise RuntimeError("Install psycopg[binary] to use the PostgreSQL data source.") from exc
    with psycopg.connect(_ssl_url(database_url), connect_timeout=4, options="-c statement_timeout=7000") as conn:
        with conn.cursor() as cur:
            cur.execute(query, params or {})
            columns = [desc.name for desc in cur.description]
            return pd.DataFrame(cur.fetchall(), columns=columns)


def _read_sql_or_empty(label: str, query: str, database_url: str, params: dict | None = None) -> pd.DataFrame:
    try:
        return _read_sql(query, database_url, params)
    except Exception as exc:
        print(f"GAZE PostgreSQL source skipped {label}: {exc}")
        return pd.DataFrame()


def load_postgres_transactions(start: date | None = None, end: date | None = None, force_refresh: bool = False) -> pd.DataFrame:
    global _CACHE
    database_url = configured_database_url()
    if not database_url:
        return pd.DataFrame()
    cache_key = (start.isoformat() if start else "", end.isoformat() if end else "")
    now = time.time()
    _CACHE = {key: value for key, value in _CACHE.items() if now - value[0] < CACHE_TTL_SECONDS}
    if not force_refresh and cache_key in _CACHE:
        return _CACHE[cache_key][1].copy()
    params = {"start": start, "end": end} if start and end else None
    transaction_sql = TRANSACTION_SQL + "\nWHERE local_date BETWEEN %(start)s AND %(end)s" if params else TRANSACTION_SQL
    shift_sql = SHIFT_SQL + "\n  AND COALESCE(timezone('Europe/Sarajevo', s.clock_in)::date, s.date) BETWEEN %(start)s AND %(end)s" if params else SHIFT_SQL
    inactivity_sql = INACTIVITY_SQL + "\n  AND timezone('Europe/Sarajevo', ie.started_at)::date BETWEEN %(start)s AND %(end)s" if params else INACTIVITY_SQL
    queries = [
        ("transactions", transaction_sql),
        ("shifts", shift_sql),
        ("inactivity", inactivity_sql),
    ]
    with ThreadPoolExecutor(max_workers=len(queries)) as executor:
        frames = list(executor.map(lambda item: _read_sql_or_empty(item[0], item[1], database_url, params), queries))
    available_frames = [frame for frame in frames if not frame.empty]
    result = pd.concat(available_frames, ignore_index=True) if available_frames else pd.DataFrame()
    if not result.empty:
        result = normalize_revenue_catcher(result)
        result["source_name"] = "RevenueCatcher PostgreSQL"
    _CACHE[cache_key] = (time.time(), result.copy())
    if len(_CACHE) > MAX_TRANSACTION_CACHE_ENTRIES:
        oldest_key = min(_CACHE, key=lambda key: _CACHE[key][0])
        _CACHE.pop(oldest_key, None)
    return result


def load_postgres_flow_manager_transactions(start: date, end: date) -> pd.DataFrame:
    """Load Flow's company-visible revenue rows for its Manager Dashboard.

    ``visible_transactions`` is Flow's database view.  It removes revenue
    whose commission structure says the company gets no cut, plus refunds and
    chargebacks, before any dashboard totals are calculated.
    """
    database_url = configured_database_url()
    if not database_url:
        return pd.DataFrame()
    rows = _read_sql_or_empty(
        "flow_manager_transactions",
        FLOW_MANAGER_TRANSACTION_SQL,
        database_url,
        {"start": start, "end": end},
    )
    if rows.empty:
        return rows
    rows = normalize_revenue_catcher(rows)
    rows["source_type"] = "postgres_flow_manager_transactions"
    return rows


def load_postgres_scheduled_shifts(start: date, end: date) -> pd.DataFrame:
    """Load the planned weekly schedule used as Performance Hub capacity."""
    database_url = configured_database_url()
    if not database_url:
        return pd.DataFrame()
    rows = _read_sql_or_empty(
        "scheduled_shifts",
        SCHEDULED_SHIFT_SQL + "\n  AND timezone('Europe/Sarajevo', ss.starts_at)::date BETWEEN %(start)s AND %(end)s",
        database_url,
        {"start": start, "end": end},
    )
    # Flow can contain duplicate materialised schedule entries for the same
    # chatter and exact interval. They represent one payable shift, not
    # separate work blocks.
    duplicate_key = [column for column in ["chatter_id", "timestamp", "scheduled_end"] if column in rows]
    if len(duplicate_key) == 3:
        rows = rows.drop_duplicates(subset=duplicate_key, keep="first")
    return rows


def load_postgres_chatter_grades(force_refresh: bool = False) -> pd.DataFrame:
    global _CHATTER_GRADE_CACHE
    database_url = configured_database_url()
    if not database_url:
        return pd.DataFrame()
    if not force_refresh and _CHATTER_GRADE_CACHE and time.time() - _CHATTER_GRADE_CACHE[0] < CACHE_TTL_SECONDS:
        return _CHATTER_GRADE_CACHE[1].copy()
    rows = _read_sql_or_empty("chatter_grades", CHATTER_GRADES_SQL, database_url)
    if not rows.empty:
        rows.attrs["source"] = "RevenueCatcher Chatter Grades"
    _CHATTER_GRADE_CACHE = (time.time(), rows.copy())
    return rows


def _identifier(name: str) -> str:
    clean = str(name or "")
    if not clean.replace("_", "").isalnum() or not clean:
        raise ValueError(f"Unsafe SQL identifier: {name}")
    return '"' + clean.replace('"', '""') + '"'


def _table_columns(database_url: str, table: str) -> set[str]:
    rows = _read_sql_or_empty(
        f"columns:{table}",
        """
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = %(table)s
        """,
        database_url,
        {"table": table},
    )
    return set(rows["column_name"].astype(str)) if not rows.empty and "column_name" in rows else set()


def _first_existing(columns: set[str], candidates: list[str]) -> str | None:
    for candidate in candidates:
        if candidate in columns:
            return candidate
    return None


def _creator_tier_query(table: str, columns: set[str]) -> str | None:
    tier_col = _first_existing(columns, ["tier", "current_tier", "creator_tier", "model_tier", "revenue_tier"])
    name_col = _first_existing(columns, ["name", "creator_name", "display_name", "username"])
    creator_col = _first_existing(columns, ["creator_id"])
    platform_col = _first_existing(columns, ["platform"])
    id_col = _first_existing(columns, ["id"])
    if not tier_col or not (name_col or creator_col or id_col):
        return None
    table_sql = _identifier(table)
    tier_sql = _identifier(tier_col)
    name_sql = _identifier(name_col) if name_col else None
    creator_sql = _identifier(creator_col) if creator_col else None
    platform_sql = _identifier(platform_col) if platform_col else None
    id_sql = _identifier(id_col) if id_col else None
    if table == "creator_accounts":
        creator_id_expr = f"ca.{creator_sql}::text" if creator_sql else "c.id::text"
        creator_name_expr = "COALESCE(c.name, " + (f"ca.{name_sql}" if name_sql else "NULL") + ")"
        platform_expr = f"upper(ca.{platform_sql})" if platform_sql else "upper(ca.platform)"
        return f"""
        SELECT
            {creator_name_expr} AS creator,
            {creator_id_expr} AS creator_id,
            {platform_expr} AS platform,
            ca.{tier_sql}::text AS creator_tier,
            '{table}' AS tier_source
        FROM {table_sql} ca
        LEFT JOIN creators c ON c.id = ca.{creator_sql if creator_sql else id_sql}
        WHERE COALESCE(ca.{tier_sql}::text, '') <> ''
        """
    creator_id_expr = f"t.{id_sql}::text" if id_sql else f"t.{creator_sql}::text"
    creator_name_expr = f"t.{name_sql}" if name_sql else "NULL::text"
    platform_expr = f"upper(t.{platform_sql})" if platform_sql else "NULL::text"
    return f"""
    SELECT
        {creator_name_expr} AS creator,
        {creator_id_expr} AS creator_id,
        {platform_expr} AS platform,
        t.{tier_sql}::text AS creator_tier,
        '{table}' AS tier_source
    FROM {table_sql} t
    WHERE COALESCE(t.{tier_sql}::text, '') <> ''
    """


def load_postgres_creator_tiers(force_refresh: bool = False) -> pd.DataFrame:
    global _CREATOR_TIER_CACHE
    database_url = configured_database_url()
    if not database_url:
        return pd.DataFrame()
    if not force_refresh and _CREATOR_TIER_CACHE and time.time() - _CREATOR_TIER_CACHE[0] < CACHE_TTL_SECONDS:
        return _CREATOR_TIER_CACHE[1].copy()
    frames = []
    for table in ["creators", "creator_accounts"]:
        columns = _table_columns(database_url, table)
        if not columns:
            continue
        query = _creator_tier_query(table, columns)
        if not query:
            continue
        rows = _read_sql_or_empty(f"creator_tiers:{table}", query, database_url)
        if not rows.empty:
            frames.append(rows)
    result = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(columns=["creator", "creator_id", "platform", "creator_tier", "tier_source"])
    if not result.empty:
        result.attrs["source"] = "RevenueCatcher creator tiers"
    _CREATOR_TIER_CACHE = (time.time(), result.copy())
    return result


def load_postgres_creator_accounts(force_refresh: bool = False) -> pd.DataFrame:
    global _CREATOR_ACCOUNT_CACHE
    database_url = configured_database_url()
    if not database_url:
        return pd.DataFrame()
    if not force_refresh and _CREATOR_ACCOUNT_CACHE and time.time() - _CREATOR_ACCOUNT_CACHE[0] < CACHE_TTL_SECONDS:
        return _CREATOR_ACCOUNT_CACHE[1].copy()
    columns = _table_columns(database_url, "creator_accounts")
    if not columns:
        return pd.DataFrame(columns=["model", "creator_id", "platform_label", "agency", "tier", "current_subs", "updated_at", "status"])
    current_subs_expr = "ca.current_subs::float" if "current_subs" in columns else "0::float"
    updated_expr = "ca.updated_at::text" if "updated_at" in columns else "NULL::text"
    status_expr = "ca.status::text" if "status" in columns else "NULL::text"
    tier_expr = "ca.tier::text" if "tier" in columns else "NULL::text"
    rows = _read_sql_or_empty(
        "creator_accounts",
        f"""
        SELECT
            COALESCE(c.name, ca.username, ca.creator_id::text) AS model,
            ca.creator_id::text AS creator_id,
            upper(ca.platform) AS platform_label,
            COALESCE(c.agency, 'Unknown') AS agency,
            {tier_expr} AS tier,
            {current_subs_expr} AS current_subs,
            {updated_expr} AS updated_at,
            {status_expr} AS status
        FROM creator_accounts ca
        LEFT JOIN creators c ON c.id = ca.creator_id
        """,
        database_url,
    )
    if rows.empty:
        rows = pd.DataFrame(columns=["model", "creator_id", "platform_label", "agency", "tier", "current_subs", "updated_at", "status"])
    else:
        rows.attrs["source"] = "RevenueCatcher creator accounts"
    _CREATOR_ACCOUNT_CACHE = (time.time(), rows.copy())
    return rows


def load_postgres_flow_team_rules(force_refresh: bool = False) -> pd.DataFrame:
    """Load Flow's team-level bonus configuration."""
    global _FLOW_TEAM_RULE_CACHE
    database_url = configured_database_url()
    if not database_url:
        return pd.DataFrame(columns=["team", "commission_basis", "bonus_rule_type", "bonus_rule_config"])
    if not force_refresh and _FLOW_TEAM_RULE_CACHE and time.time() - _FLOW_TEAM_RULE_CACHE[0] < CACHE_TTL_SECONDS:
        return _FLOW_TEAM_RULE_CACHE[1].copy()
    rows = _read_sql_or_empty(
        "flow_team_rules",
        "SELECT name AS team, commission_basis, bonus_rule_type, bonus_rule_config FROM teams",
        database_url,
    )
    _FLOW_TEAM_RULE_CACHE = (time.time(), rows.copy())
    return rows


def _target_table_query(table: str, columns: set[str]) -> str | None:
    amount_col = _first_existing(columns, [
        "target_amount", "daily_target", "daily_revenue_target", "amount", "target", "value",
        "goal_amount", "revenue_target", "target_revenue", "target_per_day",
    ])
    account_col = _first_existing(columns, ["creator_account_id", "account_id", "model_account_id"])
    creator_col = _first_existing(columns, ["creator_id", "model_id"])
    account_name_col = _first_existing(columns, ["account_username", "account", "username", "handle"])
    model_name_col = _first_existing(columns, ["model", "model_name", "creator_name", "name"])
    platform_col = _first_existing(columns, ["platform"])
    if not amount_col or not (account_col or creator_col or account_name_col or model_name_col):
        return None
    order_col = _first_existing(columns, ["effective_at", "effective_from", "valid_from", "updated_at", "created_at", "id"])
    table_sql = _identifier(table)
    amount_sql = _identifier(amount_col)
    platform_sql = _identifier(platform_col) if platform_col else None
    account_sql = _identifier(account_col) if account_col else None
    creator_sql = _identifier(creator_col) if creator_col else None
    account_name_sql = _identifier(account_name_col) if account_name_col else None
    model_name_sql = _identifier(model_name_col) if model_name_col else None
    order_sql = _identifier(order_col) if order_col else amount_sql
    id_sql = _identifier("id") if "id" in columns else None
    partition_account = f"t.{account_sql}" if account_sql else (f"t.{account_name_sql}" if account_name_sql else "NULL")
    partition_creator = f"t.{creator_sql}" if creator_sql else (f"t.{model_name_sql}" if model_name_sql else "NULL")
    partition_platform = f"t.{platform_sql}" if platform_sql else "NULL::text"
    outer_account = f"t.{account_sql}" if account_sql else "NULL"
    outer_creator = f"t.{creator_sql}" if creator_sql else "NULL"
    outer_platform = f"t.{platform_sql}" if platform_sql else "NULL::text"
    outer_id = f"t.{id_sql}" if id_sql else "NULL::text"
    outer_order = f"t.{order_sql}"
    outer_amount = f"t.{amount_sql}"
    account_join = f"LEFT JOIN creator_accounts ca ON ca.id = {outer_account}" if account_sql else "LEFT JOIN creator_accounts ca ON FALSE"
    creator_join_key = f"{outer_creator}" if creator_sql else "ca.creator_id"
    creator_join = f"LEFT JOIN creators c ON c.id = {creator_join_key}"
    account_name = f"t.{account_name_sql}::text" if account_name_sql else "NULL::text"
    model_name = f"t.{model_name_sql}::text" if model_name_sql else "NULL::text"
    creator_account_id = f"ca.id::text" if account_sql else "NULL::text"
    creator_id = f"c.id::text" if (account_sql or creator_sql) else "NULL::text"
    return f"""
    WITH ranked AS (
        SELECT
            t.*,
            row_number() OVER (
                PARTITION BY COALESCE({partition_account}::text, ''), COALESCE({partition_creator}::text, ''), COALESCE({partition_platform}::text, '')
                ORDER BY t.{order_sql} DESC NULLS LAST
            ) AS rn
        FROM {table_sql} t
    )
    SELECT
        COALESCE(ca.username, {account_name}, c.name, {model_name}) AS account,
        COALESCE(ca.username, {account_name}) AS account_username,
        COALESCE(c.name, {model_name}) AS model,
        {creator_account_id} AS creator_account_id,
        {creator_id} AS creator_id,
        upper(COALESCE({outer_platform}, ca.platform, '')) AS platform,
        {outer_amount}::float AS current_target,
        {outer_id}::text AS target_id,
        {outer_order}::text AS target_updated_at,
        '{table}' AS source_table
    FROM ranked t
    {account_join}
    {creator_join}
    WHERE rn = 1
      AND COALESCE({outer_amount}, 0) > 0
    """


def _discover_target_tables(database_url: str) -> list[str]:
    """Find target-bearing Flow tables without hard-coding a single schema name."""
    rows = _read_sql_or_empty(
        "target_table_discovery",
        """
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_type IN ('BASE TABLE', 'VIEW')
          AND table_name ILIKE '%target%'
        ORDER BY table_name
        """,
        database_url,
    )
    if rows.empty or "table_name" not in rows:
        return []
    return [str(name) for name in rows["table_name"].dropna().tolist()]


def _target_source_priority(table: str) -> tuple[int, str]:
    """Prefer explicit Flow targets when the same account has several target sources."""
    normalized = str(table or "").lower()
    if "flow" in normalized:
        return (0, normalized)
    if any(part in normalized for part in ("daily", "account", "model")):
        return (1, normalized)
    return (2, normalized)


def load_postgres_account_targets(force_refresh: bool = False) -> pd.DataFrame:
    global _TARGET_CACHE
    database_url = configured_database_url()
    if not database_url:
        return pd.DataFrame()
    if not force_refresh and _TARGET_CACHE and time.time() - _TARGET_CACHE[0] < CACHE_TTL_SECONDS:
        return _TARGET_CACHE[1].copy()
    known_tables = [
        "flow_creator_account_targets",
        "flow_account_targets",
        "flow_model_targets",
        "flow_targets",
        "creator_account_targets",
        "account_targets",
        "creator_targets",
        "creator_account_daily_targets",
        "targets",
    ]
    candidate_tables = list(dict.fromkeys(known_tables + _discover_target_tables(database_url)))
    frames = []
    for table in sorted(candidate_tables, key=_target_source_priority):
        columns = _table_columns(database_url, table)
        if not columns:
            continue
        query = _target_table_query(table, columns)
        if not query:
            continue
        rows = _read_sql_or_empty(f"targets:{table}", query, database_url)
        if not rows.empty:
            frames.append(rows)
    if frames:
        result = pd.concat(frames, ignore_index=True)
        result["_account_key"] = result["account"].fillna("").astype(str).str.strip().str.lower()
        result["_platform_key"] = result["platform"].fillna("").astype(str).str.strip().str.lower()
        result = result.drop_duplicates(subset=["_account_key", "_platform_key"], keep="first").drop(columns=["_account_key", "_platform_key"])
        result.attrs["source"] = "Shared Flow/Revenue Catcher targets"
        _TARGET_CACHE = (time.time(), result.copy())
        return result
    result = pd.DataFrame(columns=[
        "account", "account_username", "model", "creator_account_id", "creator_id",
        "platform", "current_target", "target_id", "target_updated_at", "source_table",
    ])
    _TARGET_CACHE = (time.time(), result.copy())
    return result

TRANSACTION_SQL = """
WITH enriched AS (
    SELECT
        t.id,
        timezone('Europe/Sarajevo', t.occurred_at)::date AS local_date,
        t.occurred_at,
        t.creator_id,
        COALESCE(c.name, ca.username) AS creator_name,
        COALESCE(t.chatter_id, shift_match.chatter_id) AS resolved_chatter_id,
        COALESCE(u.name, shift_user.name) AS resolved_chatter_name,
        team_match.name AS resolved_team,
        rate_match.pct::float AS flow_chatter_commission_pct,
        manager_match.pct::float AS flow_manager_commission_pct,
        manager_match.manager_name AS flow_manager_name,
        rate_match.pool_name AS flow_commission_pool,
        t.creator_account_id,
        ca.username AS account_username,
        t.platform,
        t.type,
        t.status,
        t.gross_amount,
        t.net_amount,
        COALESCE(NULLIF(upper(trim(t.currency)), ''), CASE WHEN lower(t.platform) IN ('of', 'knky') THEN 'USD' ELSE 'EUR' END) AS currency,
        t.platform_transaction_id,
        t.fan_username,
        t.attribution_source,
        NULL::numeric AS md_net_amount,
        NULL::numeric AS partner_net_amount,
        NULL::numeric AS other_net_amount,
        NULL::numeric AS chatter_net_amount
    FROM transactions t
    LEFT JOIN creators c ON c.id = t.creator_id
    LEFT JOIN creator_accounts ca ON ca.id = t.creator_account_id
    LEFT JOIN users u ON u.id = t.chatter_id
    LEFT JOIN LATERAL (
        SELECT s.chatter_id
        FROM shifts s
        WHERE s.creator_id = t.creator_id
          AND lower(s.platform) = lower(t.platform)
          AND t.occurred_at >= s.clock_in
          AND t.occurred_at <= COALESCE(s.clock_out, now())
        ORDER BY s.clock_in DESC
        LIMIT 1
    ) shift_match ON TRUE
    LEFT JOIN users shift_user ON shift_user.id = shift_match.chatter_id
    -- Team membership is effective-dated in Flow.  Resolve it on the date of
    -- each transaction so historical payouts remain in their actual team.
    LEFT JOIN LATERAL (
        SELECT team.id AS team_id, team.name
        FROM chatter_team_assignments cta
        JOIN teams team ON team.id = cta.team_id
        WHERE cta.chatter_id = COALESCE(t.chatter_id, shift_match.chatter_id)
          AND (cta.effective_from IS NULL OR cta.effective_from <= timezone('Europe/Sarajevo', t.occurred_at)::date)
          AND (cta.effective_until IS NULL OR cta.effective_until >= timezone('Europe/Sarajevo', t.occurred_at)::date)
        ORDER BY cta.effective_from DESC NULLS LAST, cta.created_at DESC
        LIMIT 1
    ) team_match ON TRUE
    -- Flow stores the chatter rate per chatter / creator / platform.  Prefer
    -- a rate active on the transaction date; a preceding recorded rate is a
    -- safer historical fallback than Gaze's generic default percentage.
    LEFT JOIN LATERAL (
        SELECT ccr.pct, pool.name AS pool_name
        FROM chatter_commission_rates ccr
        LEFT JOIN commission_pools pool ON pool.id = ccr.pool_id
        WHERE ccr.chatter_id = COALESCE(t.chatter_id, shift_match.chatter_id)
          AND ccr.creator_id = t.creator_id
          AND lower(ccr.platform) = lower(t.platform)
          AND (ccr.effective_from IS NULL OR ccr.effective_from <= timezone('Europe/Sarajevo', t.occurred_at)::date)
        ORDER BY
            CASE WHEN ccr.effective_until IS NULL OR ccr.effective_until >= timezone('Europe/Sarajevo', t.occurred_at)::date THEN 0 ELSE 1 END,
            ccr.effective_from DESC NULLS LAST,
            ccr.created_at DESC
        LIMIT 1
    ) rate_match ON TRUE
    LEFT JOIN LATERAL (
        SELECT tma.pct, manager.name AS manager_name
        FROM team_manager_assignments tma
        LEFT JOIN users manager ON manager.id = tma.manager_id
        WHERE tma.team_id = team_match.team_id
          AND (tma.effective_from IS NULL OR tma.effective_from <= timezone('Europe/Sarajevo', t.occurred_at)::date)
          AND (tma.effective_until IS NULL OR tma.effective_until >= timezone('Europe/Sarajevo', t.occurred_at)::date)
        ORDER BY tma.effective_from DESC NULLS LAST, tma.created_at DESC
        LIMIT 1
    ) manager_match ON TRUE
    WHERE t.occurred_at IS NOT NULL
      AND COALESCE(t.gross_amount, 0) <> 0
      -- Revenue Catcher's manager totals exclude records still marked "done".
      -- Keeping them here made Gaze count an extra revenue stream.
      AND lower(COALESCE(t.status, '')) <> 'done'
)
SELECT
    local_date AS date,
    occurred_at AS timestamp,
    creator_name AS creator,
    creator_id::text AS creator_id,
    creator_account_id::text AS creator_account_id,
    account_username AS account_username,
    resolved_chatter_name AS chatter,
    resolved_chatter_id::text AS chatter_id,
    upper(platform) AS platform,
    resolved_team AS team,
    NULL::text AS language,
    lower(type) AS transaction_type,
    gross_amount::float AS revenue,
    currency,
    CASE WHEN lower(type) = 'ppv' THEN gross_amount::float END AS unlock_amount,
    CASE WHEN lower(type) = 'subscription' THEN gross_amount::float END AS subscription_revenue,
    CASE WHEN lower(type) = 'tip' THEN gross_amount::float END AS tip_revenue,
    CASE WHEN lower(type) = 'message' THEN gross_amount::float END AS message_revenue,
    NULL::text AS shift_id,
    NULL::text AS shift_start,
    NULL::text AS shift_end,
    NULL::float AS shift_hours,
    NULL::float AS messages_sent,
    NULL::float AS active_hours,
    NULL::float AS inactive_minutes,
    id::text AS transaction_id,
    platform_transaction_id,
    status,
    net_amount::float AS net_amount,
    md_net_amount::float AS md_net_amount,
    partner_net_amount::float AS partner_net_amount,
    other_net_amount::float AS other_net_amount,
    chatter_net_amount::float AS chatter_net_amount,
    flow_chatter_commission_pct,
    flow_manager_commission_pct,
    flow_manager_name,
    flow_commission_pool,
    fan_username,
    attribution_source,
    'postgres_transactions' AS source_type,
    id::text AS transaction_key
FROM enriched
"""


FLOW_MANAGER_TRANSACTION_SQL = """
SELECT
    timezone('Europe/Sarajevo', t.occurred_at)::date AS date,
    t.occurred_at AS timestamp,
    lower(t.type) AS transaction_type,
    lower(COALESCE(t.status, '')) AS status,
    upper(t.platform) AS platform,
    t.creator_id::text AS creator_id,
    t.creator_account_id::text AS creator_account_id,
    t.chatter_id::text AS chatter_id,
    t.gross_amount::float AS revenue,
    t.net_amount::float AS net_amount,
    t.currency
FROM visible_transactions t
WHERE t.occurred_at IS NOT NULL
  AND timezone('Europe/Sarajevo', t.occurred_at)::date BETWEEN %(start)s AND %(end)s
  -- Flow's Manager Dashboard does not count records still marked done.
  AND lower(COALESCE(t.status, '')) <> 'done'
"""


SHIFT_SQL = """
SELECT
    COALESCE(timezone('Europe/Sarajevo', s.clock_in)::date, s.date) AS date,
    s.clock_in AS timestamp,
    c.name AS creator,
    s.creator_id::text AS creator_id,
    NULL::text AS creator_account_id,
    NULL::text AS account_username,
    u.name AS chatter,
    s.chatter_id::text AS chatter_id,
    upper(s.platform) AS platform,
    team_match.name AS team,
    NULL::text AS language,
    'shift_summary' AS transaction_type,
    NULL::float AS revenue,
    'EUR' AS currency,
    NULL::float AS unlock_amount,
    NULL::float AS subscription_revenue,
    NULL::float AS tip_revenue,
    NULL::float AS message_revenue,
    s.id::text AS shift_id,
    s.clock_in::text AS shift_start,
    s.clock_out::text AS shift_end,
    CASE
        WHEN s.clock_in IS NULL THEN NULL::float
        ELSE GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(s.clock_out, now()) - s.clock_in)) / 3600.0)::float
    END AS shift_hours,
    NULL::float AS messages_sent,
    CASE
        WHEN s.clock_in IS NULL THEN NULL::float
        ELSE GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(s.clock_out, now()) - s.clock_in)) / 3600.0)::float
    END AS active_hours,
    NULL::float AS inactive_minutes,
    NULL::text AS transaction_id,
    NULL::text AS platform_transaction_id,
    NULL::text AS status,
    NULL::float AS net_amount,
    NULL::float AS md_net_amount,
    NULL::float AS partner_net_amount,
    NULL::float AS other_net_amount,
    NULL::float AS chatter_net_amount,
    NULL::text AS fan_username,
    NULL::text AS attribution_source,
    'postgres_shifts' AS source_type,
    'shift|' || s.id::text AS transaction_key
FROM shifts s
LEFT JOIN creators c ON c.id = s.creator_id
LEFT JOIN users u ON u.id = s.chatter_id
LEFT JOIN LATERAL (
    SELECT team.name
    FROM chatter_team_assignments cta
    JOIN teams team ON team.id = cta.team_id
    WHERE cta.chatter_id = s.chatter_id
      AND (cta.effective_from IS NULL OR cta.effective_from <= timezone('Europe/Sarajevo', s.clock_in)::date)
      AND (cta.effective_until IS NULL OR cta.effective_until >= timezone('Europe/Sarajevo', s.clock_in)::date)
    ORDER BY cta.effective_from DESC NULLS LAST, cta.created_at DESC
    LIMIT 1
) team_match ON TRUE
WHERE s.clock_in IS NOT NULL
"""


SCHEDULED_SHIFT_SQL = """
SELECT
    timezone('Europe/Sarajevo', ss.starts_at)::date AS date,
    ss.starts_at AS timestamp,
    ss.ends_at AS scheduled_end,
    u.name AS chatter,
    ss.chatter_id::text AS chatter_id,
    team_match.name AS team,
    'scheduled_shift' AS transaction_type,
    GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(ss.ends_at, ss.starts_at) - ss.starts_at)) / 3600.0)::float AS scheduled_hours,
    'RevenueCatcher schedule' AS capacity_source
FROM scheduled_shifts ss
LEFT JOIN users u ON u.id = ss.chatter_id
LEFT JOIN LATERAL (
    SELECT t.name
    FROM chatter_team_assignments cta
    JOIN teams t ON t.id = cta.team_id
    WHERE cta.chatter_id = ss.chatter_id
      AND (cta.effective_from IS NULL OR cta.effective_from <= timezone('Europe/Sarajevo', ss.starts_at)::date)
      AND (cta.effective_until IS NULL OR cta.effective_until >= timezone('Europe/Sarajevo', ss.starts_at)::date)
    ORDER BY cta.effective_from DESC NULLS LAST, cta.created_at DESC
    LIMIT 1
) team_match ON TRUE
WHERE ss.starts_at IS NOT NULL
  AND ss.ends_at IS NOT NULL
"""


INACTIVITY_SQL = """
SELECT
    timezone('Europe/Sarajevo', ie.started_at)::date AS date,
    ie.started_at AS timestamp,
    c.name AS creator,
    ca.creator_id::text AS creator_id,
    ca.id::text AS creator_account_id,
    ca.username AS account_username,
    u.name AS chatter,
    iec.chatter_id::text AS chatter_id,
    upper(ie.platform) AS platform,
    ie.team,
    COALESCE(iec.money_wasted_eur, COALESCE(ie.orange_money_wasted_eur, 0) + COALESCE(ie.red_money_wasted_eur, 0))::float AS inactivity_money_wasted,
    ie.peak_unread_chats::float AS peak_unread_chats,
    NULL::text AS language,
    'inactivity' AS transaction_type,
    NULL::float AS revenue,
    'EUR' AS currency,
    NULL::float AS unlock_amount,
    NULL::float AS subscription_revenue,
    NULL::float AS tip_revenue,
    NULL::float AS message_revenue,
    NULL::text AS shift_id,
    ie.started_at::text AS shift_start,
    ie.ended_at::text AS shift_end,
    NULL::float AS shift_hours,
    NULL::float AS messages_sent,
    NULL::float AS active_hours,
    COALESCE(
        iec.minutes,
        COALESCE(ie.orange_minutes, 0) + COALESCE(ie.red_minutes, 0) + COALESCE(ie.dormant_minutes, 0)
    )::float AS inactive_minutes,
    NULL::text AS transaction_id,
    NULL::text AS platform_transaction_id,
    NULL::text AS status,
    NULL::float AS net_amount,
    NULL::float AS md_net_amount,
    NULL::float AS partner_net_amount,
    NULL::float AS other_net_amount,
    NULL::float AS chatter_net_amount,
    NULL::text AS fan_username,
    NULL::text AS attribution_source,
    'postgres_inactivity' AS source_type,
    'inactivity|' || ie.id::text || '|' || COALESCE(iec.chatter_id::text, '') AS transaction_key
FROM inactivity_episodes ie
LEFT JOIN creator_accounts ca ON ca.id = ie.creator_account_id
LEFT JOIN creators c ON c.id = ca.creator_id
LEFT JOIN inactivity_episode_chatters iec ON iec.episode_id = ie.id
LEFT JOIN users u ON u.id = iec.chatter_id
WHERE ie.started_at IS NOT NULL
"""


CHATTER_GRADES_SQL = """
WITH ranked AS (
    SELECT
        cg.*,
        u.name AS chatter_name,
        u.status AS chatter_status,
        NULL::text AS chatter_team,
        grader.name AS grader_name,
        row_number() OVER (
            PARTITION BY cg.chatter_id
            ORDER BY cg.graded_at DESC NULLS LAST, cg.id DESC
        ) AS rn
    FROM chatter_grades cg
    LEFT JOIN users u ON u.id = cg.chatter_id
    LEFT JOIN users grader ON grader.id = cg.graded_by
)
SELECT
    chatter_name AS "Full Name",
    'Chatter' AS "Role",
    chatter_status AS "Status",
    chatter_team AS "Team",
    chat_quality_score::float AS "Chat Quality",
    activity_score::float AS "Activity / Behaviour",
    (chat_quality_score::float * 0.65 + activity_score::float * 0.35) AS "Skill Grade",
    graded_at AS "Latest Grade Date",
    grader_name AS "Graded By",
    notes AS "Notes"
FROM ranked
WHERE rn = 1
  AND chatter_name IS NOT NULL
"""






