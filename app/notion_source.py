from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from typing import Any

import pandas as pd


DEFAULT_EMPLOYEE_DATABASE_ID = "2e237e28afbc81ef9689f809a8ced303"
DEFAULT_TICKETS_DATABASE_ID = "35137e28afbc80a08b7ef92bfe4eb247"
NOTION_VERSION = "2022-06-28"
CACHE_SECONDS = 300

_EMPLOYEE_CACHE: tuple[float, pd.DataFrame] | None = None
_TICKET_CACHE: tuple[float, pd.DataFrame] | None = None
_DATABASE_SEARCH_CACHE: tuple[float, list[dict[str, Any]]] | None = None


def _database_id() -> str:
    value = os.environ.get("NOTION_EMPLOYEE_DATABASE_ID", DEFAULT_EMPLOYEE_DATABASE_ID).strip()
    return value.replace("-", "")


def _first_env(*names: str) -> str:
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return ""


def _token() -> str:
    return _first_env(
        "NOTION_TOKEN",
        "NOTION_API_KEY",
        "NOTION_INTEGRATION_TOKEN",
        "NOTION_INTERNAL_INTEGRATION_TOKEN",
    )


def _ticket_token() -> str:
    return (
        _first_env(
            "NOTION_TICKETS_TOKEN",
            "NOTION_TICKET_TOKEN",
            "NOTION_TICKETS_API_KEY",
            "NOTION_TICKET_API_KEY",
        )
        or _token()
    )


def _ticket_database_id() -> str:
    value = (
        os.environ.get("NOTION_TICKETS_DATABASE_ID", "")
        or os.environ.get("NOTION_TICKET_DATABASE_ID", "")
        or DEFAULT_TICKETS_DATABASE_ID
    ).strip()
    return value.replace("-", "")


def _plain_text(items: list[dict[str, Any]] | None) -> str:
    return "".join(str(item.get("plain_text", "")) for item in (items or [])).strip()


def _property_value(prop: dict[str, Any]) -> Any:
    kind = prop.get("type")
    value = prop.get(kind) if kind else None
    if kind == "title":
        return _plain_text(value)
    if kind == "rich_text":
        return _plain_text(value)
    if kind in {"select", "status"}:
        return (value or {}).get("name", "")
    if kind == "multi_select":
        return ", ".join(item.get("name", "") for item in (value or []) if item.get("name"))
    if kind == "people":
        return ", ".join(item.get("name", "") for item in (value or []) if item.get("name"))
    if kind == "date":
        return (value or {}).get("start", "")
    if kind == "formula":
        return _property_value(value or {})
    if kind == "rollup":
        rollup_type = (value or {}).get("type")
        rollup_value = (value or {}).get(rollup_type)
        if rollup_type == "array":
            return ", ".join(str(_property_value(item)) for item in rollup_value or [])
        return rollup_value
    if kind in {"number", "checkbox", "email", "phone_number", "url", "created_time", "last_edited_time"}:
        return value
    if kind == "relation":
        return ", ".join(item.get("id", "") for item in (value or []) if item.get("id"))
    return "" if value is None else str(value)


def _query_database(database_id: str, token: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    cursor = None
    url = f"https://api.notion.com/v1/databases/{database_id}/query"
    while True:
        body: dict[str, Any] = {"page_size": 100}
        if cursor:
            body["start_cursor"] = cursor
        request = urllib.request.Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Notion-Version": NOTION_VERSION,
            },
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            payload = json.loads(response.read().decode("utf-8"))
        rows.extend(payload.get("results", []))
        if not payload.get("has_more"):
            return rows
        cursor = payload.get("next_cursor")
        if not cursor:
            return rows


def _database_title(database: dict[str, Any]) -> str:
    return _plain_text(database.get("title") or [])


def _search_databases(token: str, force: bool = False) -> list[dict[str, Any]]:
    global _DATABASE_SEARCH_CACHE
    now = time.time()
    if not force and _DATABASE_SEARCH_CACHE and now - _DATABASE_SEARCH_CACHE[0] < CACHE_SECONDS:
        return list(_DATABASE_SEARCH_CACHE[1])

    rows: list[dict[str, Any]] = []
    cursor = None
    while True:
        body: dict[str, Any] = {
            "page_size": 100,
            "filter": {"property": "object", "value": "database"},
        }
        if cursor:
            body["start_cursor"] = cursor
        request = urllib.request.Request(
            "https://api.notion.com/v1/search",
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Notion-Version": NOTION_VERSION,
            },
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            payload = json.loads(response.read().decode("utf-8"))
        rows.extend(payload.get("results", []))
        if not payload.get("has_more"):
            _DATABASE_SEARCH_CACHE = (now, list(rows))
            return rows
        cursor = payload.get("next_cursor")
        if not cursor:
            _DATABASE_SEARCH_CACHE = (now, list(rows))
            return rows


def _database_property_names(database: dict[str, Any]) -> set[str]:
    return {str(name).strip().lower() for name in (database.get("properties") or {})}


def _ticket_database_shape_score(database: dict[str, Any]) -> int:
    title = _database_title(database).lower()
    props = _database_property_names(database)
    score = 0
    title_score = 0
    if "ticket" in title:
        title_score += 10
    if "internal" in title:
        title_score += 2
    if "report" in title:
        title_score += 1
    if "request" in title:
        title_score += 1
    if "task" in title:
        title_score += 1

    # Notion database titles are easy to rename, so also identify ticket
    # databases by their visible properties.
    ticket_fields = {
        "ticket subject",
        "name",
        "subject",
        "title",
        "task",
        "status",
        "ticket status",
        "department",
        "responsible department",
        "assignee",
        "assigned to",
        "owner",
        "urgency",
        "priority",
        "created",
        "created time",
        "created at",
        "first touch time",
        "requestor",
        "resolution sla status",
        "ticket age",
    }
    field_hits = sum(1 for field in props if field in ticket_fields)
    if not title_score and field_hits < 3:
        return 0
    score += title_score
    score += field_hits * 3
    return score


def _ticket_candidate_database_ids(token: str) -> list[str]:
    configured = _ticket_database_id()
    candidates: list[str] = []
    if configured:
        candidates.append(configured)
    databases = _search_databases(token)
    scored: list[tuple[int, str]] = []
    for database in databases:
        score = _ticket_database_shape_score(database)
        if score >= 9:
            scored.append((score, database.get("id", "").replace("-", "")))
    scored.sort(reverse=True)
    for _, database_id in scored:
        if database_id and database_id not in candidates:
            candidates.append(database_id)
    return candidates


def _ticket_records_from_pages(pages: list[dict[str, Any]]) -> pd.DataFrame:
    records = []
    for page in pages:
        record = {
            "notion_page_id": page.get("id", ""),
            "Created": page.get("created_time", ""),
            "Last Edited": page.get("last_edited_time", ""),
        }
        for name, prop in page.get("properties", {}).items():
            record[name] = _property_value(prop)
        records.append(record)
    return pd.DataFrame(records)


def _ticket_freshness_score(rows: pd.DataFrame) -> tuple[int, pd.Timestamp, int]:
    if rows.empty:
        return (0, pd.Timestamp.min.tz_localize("UTC"), 0)
    normalized = {str(col).strip().lower(): col for col in rows.columns}
    date_col = next(
        (
            normalized.get(name)
            for name in ["created", "created time", "created at", "date", "last edited"]
            if normalized.get(name) is not None
        ),
        None,
    )
    parsed = pd.to_datetime(rows[date_col], errors="coerce", utc=True) if date_col else pd.Series(dtype="datetime64[ns, UTC]")
    latest = parsed.max() if not parsed.empty else pd.NaT
    if pd.isna(latest):
        latest = pd.Timestamp.min.tz_localize("UTC")
    useful_fields = {
        "ticket subject",
        "name",
        "subject",
        "title",
        "task",
        "status",
        "ticket status",
        "department",
        "responsible department",
        "assignee",
        "assigned to",
        "owner",
        "urgency",
        "priority",
        "created",
        "created time",
        "created at",
    }
    field_score = sum(1 for col in normalized if col in useful_fields)
    return (field_score, latest, len(rows))


def load_employee_rows(force: bool = False) -> pd.DataFrame:
    global _EMPLOYEE_CACHE
    now = time.time()
    if not force and _EMPLOYEE_CACHE and now - _EMPLOYEE_CACHE[0] < CACHE_SECONDS:
        return _EMPLOYEE_CACHE[1].copy()

    token = _token()
    if not token:
        return pd.DataFrame()

    try:
        pages = _query_database(_database_id(), token)
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError, OSError) as exc:
        print(f"GAZE Notion source skipped: {exc}")
        return pd.DataFrame()

    records = []
    for page in pages:
        record = {"notion_page_id": page.get("id", "")}
        for name, prop in page.get("properties", {}).items():
            record[name] = _property_value(prop)
        records.append(record)

    rows = pd.DataFrame(records)
    rows.attrs["source"] = "Notion API"
    _EMPLOYEE_CACHE = (now, rows.copy())
    return rows


def load_ticket_rows(force: bool = False) -> pd.DataFrame:
    global _TICKET_CACHE
    now = time.time()
    if not force and _TICKET_CACHE and now - _TICKET_CACHE[0] < CACHE_SECONDS:
        return _TICKET_CACHE[1].copy()

    token = _ticket_token()
    if not token:
        return pd.DataFrame()

    try:
        candidate_ids = _ticket_candidate_database_ids(token)
        if not candidate_ids:
            return pd.DataFrame()
        best_rows = pd.DataFrame()
        best_score = (0, pd.Timestamp.min.tz_localize("UTC"), 0)
        for database_id in candidate_ids[:8]:
            pages = _query_database(database_id, token)
            candidate_rows = _ticket_records_from_pages(pages)
            score = _ticket_freshness_score(candidate_rows)
            if score > best_score:
                best_score = score
                best_rows = candidate_rows
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError, OSError) as exc:
        print(f"GAZE Notion ticket source skipped: {exc}")
        return pd.DataFrame()

    rows = best_rows
    rows.attrs["source"] = "Notion API"
    _TICKET_CACHE = (now, rows.copy())
    return rows
