from __future__ import annotations

import json
from pathlib import Path
from urllib import request
from urllib.error import HTTPError, URLError
from datetime import datetime, timezone

import pandas as pd

from .schema import STANDARD_FIELDS
from .currency import normalize_revenue_catcher


class DataConnector:
    name = "Base connector"

    def load(self) -> pd.DataFrame:
        raise NotImplementedError


class CSVXLSXConnector(DataConnector):
    name = "CSV/XLSX upload"

    def __init__(self, path: str | Path):
        self.path = Path(path)

    def load(self) -> pd.DataFrame:
        if self.path.suffix.lower() == ".csv":
            return pd.read_csv(self.path)
        if self.path.suffix.lower() in [".xlsx", ".xls"]:
            return pd.read_excel(self.path)
        raise ValueError("Upload must be a CSV or Excel file.")


class GoogleSheetsConnector(DataConnector):
    name = "Google Sheets connector"

    def __init__(self, spreadsheet_id: str, gid: str | int):
        self.spreadsheet_id = spreadsheet_id
        self.gid = str(gid)

    @property
    def export_url(self) -> str:
        return f"https://docs.google.com/spreadsheets/d/{self.spreadsheet_id}/export?format=csv&gid={self.gid}"

    def load(self) -> pd.DataFrame:
        try:
            return pd.read_csv(self.export_url)
        except HTTPError as exc:
            if exc.code == 401:
                raise RuntimeError(
                    "Google blocked the import because the master Sheet is private for direct CSV export. "
                    "Either share/publish the Revenue tab for link-based CSV export, connect Google OAuth/API access later, "
                    "or export the tab as CSV/XLSX and upload it manually."
                ) from exc
            raise RuntimeError(f"Google Sheet import failed with HTTP {exc.code}.") from exc
        except Exception as exc:
            raise RuntimeError(
                "Could not import the Google Sheet. Make sure the sheet is accessible to anyone with the link, "
                "or export the tab as CSV/XLSX and upload it manually."
            ) from exc


class RevenueCatcherConnector(DataConnector):
    name = "Revenue Catcher connector"

    def __init__(self, url: str | None = None, headers: dict | None = None):
        self.url = url
        self.headers = headers or {}

    def load(self) -> pd.DataFrame:
        if not self.url:
            raise RuntimeError("Revenue Catcher API URL is missing.")
        req = request.Request(self.url, headers={"Accept": "application/json", **self.headers})
        try:
            with request.urlopen(req, timeout=45) as response:
                data = json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            if exc.code in [401, 403]:
                raise RuntimeError(
                    "Revenue Catcher blocked the API request. Save the correct x-api-key on Data Sources, "
                    "or set REVENUE_CATCHER_API_KEY before starting the app."
                ) from exc
            raise RuntimeError(f"Revenue Catcher API failed with HTTP {exc.code}.") from exc
        except URLError as exc:
            raise RuntimeError(f"Revenue Catcher API could not be reached: {exc.reason}") from exc
        return revenue_catcher_to_frame(data)


class RevenueCatcherJSONConnector(DataConnector):
    name = "Revenue Catcher JSON response"

    def __init__(self, path: str | Path):
        self.path = Path(path)

    def load(self) -> pd.DataFrame:
        return revenue_catcher_to_frame(json.loads(self.path.read_text(encoding="utf-8")))


def revenue_catcher_to_frame(data: dict) -> pd.DataFrame:
    if isinstance(data, dict) and "dailySeries" in data:
        return revenue_catcher_summary_to_frame(data)
    if isinstance(data, dict) and "summary" in data:
        return revenue_catcher_external_summary_to_frame(data)
    if isinstance(data, dict) and "results" in data:
        results = data.get("results") or []
        if results and any(key in results[0] for key in ["occurred_at", "gross_amount", "platform_transaction_id"]):
            return revenue_catcher_external_transactions_to_frame(data)
        return revenue_catcher_shifts_to_frame(results)
    if isinstance(data, dict) and "creators" in data:
        return revenue_catcher_creators_to_frame(data)
    if isinstance(data, dict) and "accounts" in data:
        return revenue_catcher_creator_accounts_to_frame(data)
    if isinstance(data, dict) and "chatters" in data:
        return revenue_catcher_chatters_to_frame(data)
    return revenue_catcher_shifts_to_frame(data)


def revenue_catcher_external_transactions_to_frame(data: dict) -> pd.DataFrame:
    rows = []
    for tx in data.get("results", []):
        rows.append({
            "date": tx.get("occurred_at"),
            "timestamp": tx.get("occurred_at"),
            "creator": tx.get("creator_name"),
            "creator_id": tx.get("creator_id"),
            "chatter": tx.get("chatter_name"),
            "chatter_id": tx.get("chatter_id"),
            "platform": str(tx.get("platform") or "").upper(),
            "team": None,
            "language": None,
            "transaction_type": tx.get("type"),
            "revenue": tx.get("gross_amount"),
            "currency": tx.get("currency"),
            "unlock_amount": tx.get("gross_amount") if tx.get("type") == "ppv" else None,
            "subscription_revenue": tx.get("gross_amount") if tx.get("type") == "subscription" else None,
            "tip_revenue": tx.get("gross_amount") if tx.get("type") == "tip" else None,
            "message_revenue": tx.get("gross_amount") if tx.get("type") == "message" else None,
            "shift_id": None,
            "shift_start": None,
            "shift_end": None,
            "shift_hours": None,
            "messages_sent": None,
            "active_hours": None,
            "inactive_minutes": None,
            "transaction_id": tx.get("id"),
            "platform_transaction_id": tx.get("platform_transaction_id"),
            "status": tx.get("status"),
            "net_amount": tx.get("net_amount"),
            "platform_net_amount": tx.get("platform_net_amount"),
            "creator_net_amount": tx.get("creator_net_amount"),
            "md_net_amount": tx.get("md_net_amount"),
            "partner_net_amount": tx.get("partner_net_amount"),
            "other_net_amount": tx.get("other_net_amount"),
            "chatter_net_amount": tx.get("chatter_net_amount"),
            "manager_net_amount": tx.get("manager_net_amount"),
            "fan_username": tx.get("fan_username"),
            "attribution_source": tx.get("attribution_source"),
            "assigned_by_name": tx.get("assigned_by_name"),
            "of_employee_id": tx.get("of_employee_id"),
            "last_synced_at": data.get("lastSyncedAt"),
        })
    return normalize_revenue_catcher(pd.DataFrame(rows))


def revenue_catcher_external_summary_to_frame(data: dict) -> pd.DataFrame:
    rows = []
    for item in data.get("summary", []):
        # The legacy summary endpoint aggregates native amounts across platforms.
        # An unlabeled scalar total cannot safely be assumed to be EUR.
        amount = item.get("gross_amount")
        currency = item.get("currency") or data.get("currency")
        if amount is not None and not isinstance(amount, dict) and not currency:
            raise ValueError("Revenue Catcher summary has no currency; use transaction detail or a EUR/USD summary.")
        rows.append({
            "date": item.get("period"),
            "timestamp": item.get("period"),
            "creator": None,
            "creator_id": None,
            "chatter": None,
            "chatter_id": None,
            "platform": "Revenue Catcher",
            "team": None,
            "language": None,
            "transaction_type": "summary",
            "revenue": item.get("gross_amount"),
            "currency": currency or "EUR",
            "unlock_amount": None,
            "subscription_revenue": None,
            "tip_revenue": None,
            "message_revenue": None,
            "shift_id": None,
            "shift_start": None,
            "shift_end": None,
            "shift_hours": None,
            "messages_sent": None,
            "active_hours": None,
            "inactive_minutes": None,
            "source_count": item.get("count"),
            "net_amount": item.get("net_amount"),
            "last_synced_at": data.get("lastSyncedAt"),
        })
    return normalize_revenue_catcher(pd.DataFrame(rows))


def revenue_catcher_creators_to_frame(data: dict) -> pd.DataFrame:
    rows = []
    for creator in data.get("creators", []):
        rows.append({
            "id": creator.get("id"),
            "name": creator.get("name"),
            "agency": creator.get("agency"),
            "platforms": creator.get("platforms", []),
            "is_active": creator.get("is_active"),
        })
    return pd.DataFrame(rows)


def revenue_catcher_creator_accounts_to_frame(data: dict) -> pd.DataFrame:
    rows = []
    for account in data.get("accounts", []):
        rows.append({
            "id": account.get("id"),
            "creator_id": account.get("creator_id"),
            "creator": account.get("creator_name"),
            "platform": account.get("platform"),
            "tier": account.get("tier"),
            "status": account.get("status"),
            "current_subs": account.get("current_subs"),
            "updated_at": account.get("updated_at"),
        })
    return pd.DataFrame(rows)


def revenue_catcher_chatters_to_frame(data: dict) -> pd.DataFrame:
    rows = []
    for chatter in data.get("chatters", []):
        rows.append({
            "id": chatter.get("id"),
            "name": chatter.get("name"),
            "status": chatter.get("status"),
            "created_at": chatter.get("created_at"),
            "has2fa": chatter.get("has2fa"),
        })
    return pd.DataFrame(rows)


def revenue_catcher_summary_to_frame(data: dict) -> pd.DataFrame:
    rows = []
    for day in data.get("dailySeries", []):
        for revenue_type, amount in (day.get("totals") or {}).items():
            rows.append({
                "date": day.get("date"),
                "timestamp": day.get("date"),
                "creator": None,
                "creator_id": None,
                "chatter": None,
                "chatter_id": None,
                "platform": "Revenue Catcher",
                "team": None,
                "language": None,
                "transaction_type": revenue_type,
                "revenue": amount,
                "currency": day.get("currency") or data.get("currency") or "EUR",
                "unlock_amount": amount if revenue_type == "ppv" else None,
                "subscription_revenue": amount if revenue_type == "subscription" else None,
                "tip_revenue": amount if revenue_type == "tip" else None,
                "message_revenue": amount if revenue_type == "message" else None,
                "shift_id": None,
                "shift_start": None,
                "shift_end": None,
                "shift_hours": None,
                "messages_sent": None,
                "active_hours": None,
                "inactive_minutes": None,
                "source_total": day.get("total"),
            })
    return normalize_revenue_catcher(pd.DataFrame(rows))


def revenue_catcher_shifts_to_frame(data: dict) -> pd.DataFrame:
    if isinstance(data, list):
        shifts = data
    elif isinstance(data, dict):
        shifts = data.get("shifts") or data.get("active_shifts") or data.get("active") or data.get("data") or []
    else:
        shifts = []
    rows = []
    for shift in shifts:
        clean = {key: value for key, value in shift.items() if key != "creator_avatar"}
        clock_in = pd.to_datetime(clean.get("clock_in"), errors="coerce", utc=True)
        clock_out = pd.to_datetime(clean.get("clock_out"), errors="coerce", utc=True)
        hours = None
        if pd.notna(clock_in) and pd.notna(clock_out):
            hours = max(0, (clock_out - clock_in).total_seconds() / 3600)
        row = {
            "date": clean.get("date"),
            "timestamp": clean.get("clock_in"),
            "creator": clean.get("creator_name"),
            "creator_id": clean.get("creator_id"),
            "chatter": clean.get("chatter_name"),
            "chatter_id": clean.get("chatter_id"),
            "platform": str(clean.get("platform") or "").upper(),
            "team": None,
            "language": None,
            "transaction_type": "shift_summary",
            "revenue": clean.get("gross_revenue"),
            "currency": clean.get("currency"),
            "unlock_amount": None,
            "subscription_revenue": None,
            "tip_revenue": clean.get("tip_revenue"),
            "message_revenue": clean.get("message_revenue"),
            "shift_id": clean.get("id"),
            "shift_start": clean.get("clock_in"),
            "shift_end": clean.get("clock_out"),
            "shift_hours": hours,
            "messages_sent": None,
            "active_hours": hours,
            "inactive_minutes": None,
            "commission_pct": clean.get("commission_pct"),
            "commission_earned": clean.get("commission_earned"),
            "salary_cost": clean.get("salary_cost", clean.get("salary", clean.get("chatter_salary"))),
            "commission_plan": clean.get("commission_plan", clean.get("commission_structure_name")),
            "transaction_count": clean.get("transaction_count"),
            "overlapping_shift": clean.get("overlapping_shift"),
        }
        rows.append(row)
    return normalize_revenue_catcher(pd.DataFrame(rows))


def guess_mapping(columns: list[str]) -> dict[str, str]:
    normalized = {col.lower().strip().replace(" ", "_").replace("-", "_"): col for col in columns}
    mapping = {}
    aliases = {
        "date": ["date", "date_(cet)", "transaction_date"],
        "timestamp": ["timestamp", "date_(cet)", "time", "transaction_time", "created_at"],
        "creator": ["creator", "model", "model_name", "creator_name"],
        "chatter": ["chatter", "chatter_name", "agent", "sales_rep"],
        "platform": ["platform", "site"],
        "team": ["team"],
        "language": ["language", "lang"],
        "transaction_type": ["transaction_type", "type"],
        "revenue": ["revenue", "revenue_eur", "amount_(eur)", "amount", "gross_revenue", "total_revenue"],
        "currency": ["currency"],
        "unlock_amount": ["unlock_amount", "unlock_revenue", "unlocks"],
        "subscription_revenue": ["subscription_revenue", "subscriptions"],
        "tip_revenue": ["tip_revenue", "tips"],
        "message_revenue": ["message_revenue", "messages_revenue"],
        "shift_id": ["shift_id", "id"],
        "shift_start": ["shift_start", "clock_in"],
        "shift_end": ["shift_end", "clock_out"],
        "shift_hours": ["shift_hours", "hours", "worked_hours"],
        "messages_sent": ["messages_sent", "messages", "transactions"],
        "active_hours": ["active_hours"],
        "inactive_minutes": ["inactive_minutes", "inactivity", "inactive"],
        "salary_cost": ["salary_cost", "salary", "chatter_salary", "base_salary"],
    }
    for standard, options in aliases.items():
        for option in options:
            if option in normalized:
                mapping[standard] = normalized[option]
                break
    for field in STANDARD_FIELDS:
        mapping.setdefault(field, "")
    return mapping


def apply_mapping(df: pd.DataFrame, mapping: dict[str, str]) -> pd.DataFrame:
    processed = pd.DataFrame()
    for standard_field in STANDARD_FIELDS:
        incoming = mapping.get(standard_field)
        if incoming and incoming in df.columns:
            processed[standard_field] = df[incoming]
        else:
            processed[standard_field] = None
    processed["date"] = pd.to_datetime(processed["date"], errors="coerce").dt.date
    processed["timestamp"] = pd.to_datetime(processed["timestamp"], errors="coerce")
    numeric_cols = [
        "revenue", "unlock_amount", "subscription_revenue", "tip_revenue", "message_revenue",
        "shift_hours", "messages_sent", "active_hours", "inactive_minutes",
    ]
    for col in numeric_cols:
        processed[col] = pd.to_numeric(processed[col], errors="coerce")
    text_cols = [col for col in processed.columns if col not in numeric_cols and col not in ["date", "timestamp"]]
    for col in text_cols:
        processed[col] = processed[col].where(processed[col].notna(), None)
        processed[col] = processed[col].apply(lambda value: str(value).strip() if value is not None else None)
        processed[col] = processed[col].replace({"": None, "nan": None, "None": None})
    processed["transaction_key"] = processed.apply(
        lambda row: "|".join([
            str(row.get("timestamp") or row.get("date") or ""),
            str(row.get("creator") or ""),
            str(row.get("chatter") or ""),
            str(row.get("platform") or ""),
            str(row.get("transaction_type") or ""),
            str(row.get("revenue") or ""),
        ]),
        axis=1,
    )
    return processed
