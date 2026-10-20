from __future__ import annotations

import html
import hmac
import hashlib
import json
import mimetypes
import os
import re
import calendar
import secrets
import shutil
import time
from contextvars import ContextVar
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from html.parser import HTMLParser
from urllib.parse import parse_qs, urlencode, urlparse
from urllib import request
from urllib.error import HTTPError, URLError
from zoneinfo import ZoneInfo
import cgi

import pandas as pd

from .analytics import (
    commission_analysis,
    comparison_range,
    creator_performance,
    date_range_for,
    executive_metrics,
    filter_period,
    group_performance,
    inactivity_analysis,
    safe_pct_change,
    transaction_analysis,
    trend,
)
from .config import APP_DIR, DATA_DIR, load_mappings, load_settings, save_mappings, save_settings
from .connectors import CSVXLSXConnector, GoogleSheetsConnector, RevenueCatcherConnector, RevenueCatcherJSONConnector, apply_mapping, guess_mapping, revenue_catcher_to_frame
from .currency import revenue_catcher_rate
from .database import delete_demo_imports, init_db, insert_import, load_chatter_lookup, load_creator_lookup, load_imports, load_quality_issues, load_transactions, record_calculated_metric, upsert_chatter_lookup, upsert_creator_lookup
from .exports import export_table
from .financials import METRIC_REGISTRY, financial_ledger, metric_definition, metric_key_for_label
from .chatter_revenue_tier import build_chatter_revenue_tier_matrix, monthly_tier_thresholds
from .insights import anomalies, factual_insights
from .looker_sources import ads_data, compliance_data, inactivity_monitor_rows, inactivity_monitor_summary, model_socials_data, of_new_fans_data, source_summary, tickets_data
from .performance_hub import build_performance_hub, build_performance_hub_v2, week_windows
from .reports import formatted_report, generate_report, management_summary
from .revenue_tiers import build_revenue_tiers
from .target_monitoring import build_target_monitoring
from .sample_data import create_demo_csv
from .postgres_source import load_postgres_account_targets, load_postgres_creator_accounts, load_postgres_creator_tiers, load_postgres_flow_manager_transactions, load_postgres_flow_team_rules, load_postgres_scheduled_shifts, load_postgres_transactions
from .schema import METRIC_DEFINITIONS, STANDARD_FIELDS
from .validation import validate_transactions

STATIC_DIR = APP_DIR / "app" / "static"
TEMPLATE_PATH = APP_DIR / "app" / "templates" / "layout.html"
UPLOAD_DIR = DATA_DIR / "uploads"
PROFILE_PHOTO_DIR = STATIC_DIR / "profile-photos"
SESSION_COOKIE = "revenue_analytics_session"
WELCOME_BOT_BY_USER = {
    "anne": "/static/welcome-bots/anne.png",
    "dusan": "/static/welcome-bots/dusan.png",
    "atamay": "/static/welcome-bots/atamay.png",
    "damian": "/static/welcome-bots/damian.png",
    "myron": "/static/welcome-bots/myron.png",
    "faruk": "/static/welcome-bots/faruk.png",
}
DEFAULT_WELCOME_BOT = "/static/gaze-ai-bot-cutout.png"
REQUEST_ROLE: ContextVar[str] = ContextVar("REQUEST_ROLE", default="admin")
REQUEST_USER: ContextVar[str] = ContextVar("REQUEST_USER", default="anne")
REQUEST_PATH: ContextVar[str] = ContextVar("REQUEST_PATH", default="/")
DISPLAY_CURRENCY: ContextVar[str] = ContextVar("DISPLAY_CURRENCY", default="EUR")
DISPLAY_FX_RATE: ContextVar[float] = ContextVar("DISPLAY_FX_RATE", default=1.0)
ADMIN_ROUTES = {
    "/",
    "/revenue",
    "/chatters",
    "/creators",
    "/platforms",
    "/inactivity",
    "/transactions",
    "/commissions",
    "/insights",
    "/revenue-tiers",
    "/weekly-report",
    "/monthly-report",
    "/ask",
    "/data-quality",
    "/data-sources",
    "/settings",
    "/edit-site",
    "/people-access",
    "/permission-groups",
    "/metric-definitions",
    "/inactivity-computation",
    "/architecture",
}
C_HUB_PAGE = ("/c-hub", "Marketing & Operations Overview")
C_HUB_GROUPS = [
    ("", [
        ("/c-hub/executive-overview", "Executive Overview"),
    ]),
    ("Chat Dept", [
        ("/c-hub/revenue", "Model Revenue Overview"),
        ("/c-hub/chatter-revenue", "Chatter Revenue Overview"),
        ("/c-hub/inactivity", "Inactivity"),
        ("/c-hub/performance", "Performance Hub"),
        ("/c-hub/performance-2", "Performance Hub 2"),
    ]),
    ("Finance", [
        ("/c-hub/commissions", "Commissions"),
        ("/c-hub/transactions", "Transactions"),
        ("/c-hub/target-monitoring", "Target Monitoring"),
        ("/c-hub/chatter-revenue-tier", "Chatting Revenue Tier"),
    ]),
    ("Ops", [
        C_HUB_PAGE,
        ("/c-hub/compliance", "Compliance"),
        ("/c-hub/tickets", "Interdepartmental Tickets"),
    ]),
    ("Mktg", [
        ("/c-hub/marketing-ads", "Marketing | Ads"),
        ("/c-hub/models-socials", "Models Socials"),
        ("/c-hub/of-new-fans", "OF New Fan Growth"),
        ("/c-hub/ads-performance", "Ads Performance"),
    ]),
]
C_HUB_PAGES = [page for _, pages in C_HUB_GROUPS for page in pages]
WELCOME_PAGE = ("/", "Welcome")
HUB_PAGES = [
    ("/compliance-dash", "Compliance Dash"),
    ("/marketing", "Marketing"),
    ("/models-socials", "Models Socials"),
    ("/of-new-fan-growth", "OF New Fan Growth"),
    ("/ads-performance", "Ads Performance"),
    ("/notion-tickets", "Notion Tickets"),
]
LOOKER_ROUTES = {path for path, _ in C_HUB_PAGES} | {path for path, _ in HUB_PAGES}
CORE_PAGES = [
    ("/revenue", "Revenue"),
    ("/chatters", "Chatters"),
    ("/creators", "Creators"),
    ("/platforms", "Platforms"),
]
REPORT_PAGES = [
    ("/insights", "Insights"),
    ("/revenue-tiers", "Revenue Tiers"),
    ("/weekly-report", "Weekly Report"),
    ("/monthly-report", "Monthly Report"),
    ("/ask", "Ask Your Data"),
]
SHAREABLE_ROUTES = {path for path, _ in CORE_PAGES} | {path for path, _ in REPORT_PAGES} | LOOKER_ROUTES | {WELCOME_PAGE[0]}


def shared_people() -> dict:
    settings = load_settings()
    people = settings.get("shared_people")
    return people if isinstance(people, dict) else {}


def person_profile(user_key: str | None = None) -> dict:
    people = shared_people()
    key = user_key or REQUEST_USER.get()
    profile = people.get(key, {})
    name = str(profile.get("name") or "Anne")
    return {
        "key": key or "anne",
        "name": name,
        "title": str(profile.get("title") or ("Admin" if key == "anne" else "Shared Viewer")),
        "role": str(profile.get("role") or ("admin" if key == "anne" else "viewer")),
        "username": str(profile.get("username") or name.lower().replace(" ", ".")),
        "email": str(profile.get("email") or ""),
        "photo_url": str(profile.get("photo_url") or ""),
    }


def default_viewer_routes() -> set[str]:
    settings = load_settings()
    configured = settings.get("viewer_allowed_routes")
    valid = SHAREABLE_ROUTES
    if not isinstance(configured, list):
        return valid
    allowed = {str(path) for path in configured if str(path) in valid}
    return allowed


def viewer_allowed_routes(user_key: str | None = None) -> set[str]:
    valid = SHAREABLE_ROUTES
    profile = shared_people().get(user_key or REQUEST_USER.get())
    if isinstance(profile, dict):
        configured = profile.get("allowed_routes")
        if configured == ["*"]:
            return valid
        if isinstance(configured, list):
            allowed = {str(path) for path in configured if str(path) in valid}
            allowed.add(WELCOME_PAGE[0])
            return allowed
    allowed = default_viewer_routes()
    allowed.add(WELCOME_PAGE[0])
    return allowed


def current_allowed_routes(role: str) -> set[str]:
    return SHAREABLE_ROUTES if role == "admin" else viewer_allowed_routes()


def hub_pages_for_role(role: str) -> list[tuple[str, str]]:
    allowed = current_allowed_routes(role)
    return [(path, label) for path, label in HUB_PAGES if path in allowed]


def can_see_c_hub(role: str) -> bool:
    return bool(c_hub_pages_for_role(role))


def c_hub_pages_for_role(role: str) -> list[tuple[str, str]]:
    allowed = current_allowed_routes(role)
    return [(path, label) for path, label in C_HUB_PAGES if path in allowed]


def c_hub_grouped_pages_for_role(role: str) -> list[tuple[str, list[tuple[str, str]]]]:
    allowed = current_allowed_routes(role)
    groups: list[tuple[str, list[tuple[str, str]]]] = []
    for group_label, pages in C_HUB_GROUPS:
        visible = [(path, label) for path, label in pages if path in allowed]
        if visible:
            groups.append((group_label, visible))
    return groups


def core_pages_for_role(role: str) -> list[tuple[str, str]]:
    allowed = current_allowed_routes(role)
    return [(path, label) for path, label in CORE_PAGES if path in allowed]


def report_pages_for_role(role: str) -> list[tuple[str, str]]:
    allowed = current_allowed_routes(role)
    return [(path, label) for path, label in REPORT_PAGES if path in allowed]


def editable_pages() -> list[tuple[str, str]]:
    return CORE_PAGES + REPORT_PAGES + C_HUB_PAGES + HUB_PAGES


def editable_page_label(path: str) -> str:
    return dict(editable_pages()).get(path, path)


def site_blocks() -> list[dict]:
    settings = load_settings()
    blocks = settings.get("site_blocks")
    return blocks if isinstance(blocks, list) else []


class RichTextCleaner(HTMLParser):
    allowed_tags = {
        "b", "strong", "i", "em", "u", "br", "p", "div", "span", "ul", "ol", "li",
        "h2", "h3", "h4", "blockquote", "a",
    }

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]):
        tag = tag.lower()
        if tag in {"script", "style"}:
            self.skip_depth += 1
            return
        if self.skip_depth:
            return
        if tag not in self.allowed_tags:
            return
        if tag == "a":
            href = next((value for name, value in attrs if name.lower() == "href" and value), "")
            if href and (href.startswith("http://") or href.startswith("https://") or href.startswith("/")):
                self.parts.append(f'<a href="{html.escape(href, quote=True)}">')
                return
        self.parts.append(f"<{tag}>")

    def handle_endtag(self, tag: str):
        tag = tag.lower()
        if tag in {"script", "style"} and self.skip_depth:
            self.skip_depth -= 1
            return
        if self.skip_depth:
            return
        if tag in self.allowed_tags and tag != "br":
            self.parts.append(f"</{tag}>")

    def handle_data(self, data: str):
        if self.skip_depth:
            return
        self.parts.append(html.escape(data))

    def get_html(self) -> str:
        return "".join(self.parts)


def clean_rich_text(value: str) -> str:
    cleaner = RichTextCleaner()
    cleaner.feed(str(value or ""))
    return cleaner.get_html()


def render_site_blocks(path: str) -> str:
    blocks = [
        block for block in site_blocks()
        if block.get("page") == path and block.get("enabled", True)
    ]
    if not blocks:
        return ""
    blocks = sorted(blocks, key=lambda block: int(block.get("order", 0)))
    parts = []
    for block in blocks:
        title = str(block.get("title") or "").strip()
        body = clean_rich_text(str(block.get("body") or ""))
        style = str(block.get("style") or "note")
        title_html = f"<h2>{html.escape(title)}</h2>" if title else ""
        parts.append(f"<section class='panel editable-block editable-block-{html.escape(style)}'>{title_html}<div class='editable-block-body'>{body}</div></section>")
    return "".join(parts)


def first_viewer_route() -> str:
    allowed = viewer_allowed_routes()
    for path in ["/c-hub/revenue", "/c-hub", "/c-hub/executive-overview"]:
        if path in allowed:
            return path
    for path, _ in CORE_PAGES:
        if path in allowed:
            return path
    for path, _ in REPORT_PAGES:
        if path in allowed:
            return path
    for path, _ in C_HUB_PAGES:
        if path in allowed:
            return path
    for path, _ in HUB_PAGES:
        if path in allowed:
            return path
    return "/account"


def enter_gaze_route(role: str) -> str:
    allowed = current_allowed_routes(role)
    for path in ["/c-hub/revenue", "/c-hub", "/c-hub/executive-overview"]:
        if path in allowed:
            return path
    for path, _ in C_HUB_PAGES + CORE_PAGES + REPORT_PAGES + HUB_PAGES:
        if path in allowed:
            return path
    return "/account"


def fmt_money(value) -> str:
    if value is None or pd.isna(value):
        return "n/a"
    amount = float(value)
    if DISPLAY_CURRENCY.get() == "USD":
        return f"${amount * DISPLAY_FX_RATE.get():,.2f}"
    return f"\u20ac{amount:,.2f}"


def set_display_currency(value: object, settings: dict | None = None) -> str:
    currency = str(value or (settings or {}).get("default_currency", "EUR")).upper().strip()
    currency = currency if currency in {"EUR", "USD"} else "EUR"
    fx_rate = 1.0
    if currency == "USD":
        try:
            fx_rate = revenue_catcher_rate()
        except Exception:
            currency = "EUR"
    DISPLAY_CURRENCY.set(currency)
    DISPLAY_FX_RATE.set(fx_rate)
    return currency


def business_today(settings: dict | None = None) -> date:
    timezone = (settings or {}).get("timezone", "Europe/Amsterdam")
    try:
        return datetime.now(ZoneInfo(timezone)).date()
    except Exception:
        return date.today()


DATE_RANGE_LABELS = ["Today", "Yesterday", "This week", "Last week", "Last 7 days", "Last 30 days", "This month", "Last month", "Custom"]


def date_range_options_html(selected: str, settings: dict | None = None) -> str:
    settings = settings or load_settings()
    today = business_today(settings)
    week_start = settings.get("reporting_week_start", "Friday")
    options = []
    for label in DATE_RANGE_LABELS:
        attrs = []
        if label == selected:
            attrs.append("selected")
        if label != "Custom":
            start, end = date_range_for(label, today=today, week_start=week_start)
            attrs.extend([f'data-start="{start.isoformat()}"', f'data-end="{end.isoformat()}"'])
        attr_text = f" {' '.join(attrs)}" if attrs else ""
        options.append(f"<option{attr_text}>{html.escape(label)}</option>")
    return "".join(options)


def median_revenue_per_entity(frame: pd.DataFrame, entity: str) -> float | None:
    if frame is None or frame.empty or entity not in frame or "revenue" not in frame:
        return None
    working = frame[[entity, "revenue"]].copy()
    labels = working[entity].fillna("").astype(str).str.strip()
    working = working[labels.ne("") & ~labels.str.lower().isin({"unknown", "none", "nan"})].copy()
    if working.empty:
        return None
    working[entity] = labels.loc[working.index]
    working["revenue"] = pd.to_numeric(working["revenue"], errors="coerce").fillna(0)
    totals = working.groupby(entity, dropna=False)["revenue"].sum()
    totals = totals[totals.gt(0)]
    if totals.empty:
        return None
    return float(totals.median())


def fmt_num(value) -> str:
    if value is None or pd.isna(value):
        return "n/a"
    return f"{float(value):,.1f}"


def fmt_int(value) -> str:
    if value is None or pd.isna(value):
        return "0"
    return f"{int(float(value)):,.0f}"


def fmt_pct(value) -> str:
    if value is None or pd.isna(value):
        return "n/a"
    sign = "+" if value > 0 else ""
    return f"{sign}{float(value):.1f}%"


def fmt_table_number(value) -> str:
    if value is None or pd.isna(value):
        return ""
    return f"{float(value):,.2f}".rstrip("0").rstrip(".")


def compare_note(current, previous) -> str:
    if previous is None or pd.isna(previous) or float(previous) == 0:
        return "no previous data"
    change = (float(current) - float(previous)) / float(previous) * 100
    return f"{fmt_pct(change)} vs previous"


def delta_note_class(text: str) -> str:
    if text.startswith("% \u0394 +") or text.startswith("+"):
        return "delta-positive"
    if text.startswith("% \u0394 -") or text.startswith("-"):
        return "delta-negative"
    return ""


def kpi_value_class(value: object, metric_key: str | None = None) -> str:
    """Apply colour only when the metric has an unambiguous performance meaning."""
    if (metric_definition(metric_key) or {}).get("colour") != "profit_loss":
        return ""
    text = str(value or "").strip().replace("−", "-")
    # Keep only the characters needed for the leading formatted number.  This
    # supports Gaze's money, percentage, and compact number formatters while
    # leaving labels such as "n/a" and "needs shifts" neutral.
    match = re.search(r"[-+]?\s*[€$£]?\s*[\d][\d,]*(?:\.\d+)?", text)
    if not match:
        return ""
    try:
        numeric = float(match.group(0).replace("€", "").replace("$", "").replace("£", "").replace(",", "").replace(" ", ""))
    except ValueError:
        return ""
    return "kpi-positive" if numeric > 0 else "kpi-negative" if numeric < 0 else ""


def metric_tooltip_html(metric_key: str | None) -> str:
    metric = metric_definition(metric_key)
    if not metric:
        return ""
    description = metric["definition"] + (f" Formula: {metric['formula']}." if metric.get("formula") else "")
    return (
        "<span class='metric-tooltip-wrap'>"
        f"<button type='button' class='metric-tooltip' aria-label='About {html.escape(metric['label'])}' data-tooltip='{html.escape(description, quote=True)}'>i</button>"
        "</span>"
    )


def kpi_card_html(label: str, value: str, note: str, metric_key: str | None = None) -> str:
    metric_key = metric_key or metric_key_for_label(label)
    # Directional movement is informational unless a metric explicitly says it
    # is a business-performance signal.
    note_class = delta_note_class(str(note)) if (metric_definition(metric_key) or {}).get("colour") == "profit_loss" else ""
    class_attr = f" class='{note_class}'" if note_class else ""
    value_class = kpi_value_class(value, metric_key)
    card_class = f" kpi {value_class}".rstrip()
    return (
        f"<div class='{card_class}'>"
        f"<span>{html.escape(str(label))}{metric_tooltip_html(metric_key)}</span>"
        f"<strong>{html.escape(str(value))}</strong>"
        f"<em{class_attr}>{html.escape(str(note))}</em>"
        "</div>"
    )


def table_html(df: pd.DataFrame, max_rows: int = 200) -> str:
    if df is None or df.empty:
        return '<div class="empty">No rows for the selected filters.</div>'
    # Render the complete filtered dataset so client sorting is always applied
    # before any user-facing row selection.  The former head(max_rows) made a
    # "Revenue ↓" click sort only the first rendered slice.
    source = df.copy()
    display = source.copy()
    display = display.where(pd.notna(display), "")
    for col in display.columns:
        col_key = str(col).lower()
        if col == "change_pct":
            display[col] = display[col].apply(lambda x: "" if x == "" or pd.isna(x) else f"{fmt_table_number(x)}%")
        elif "pct" in col_key:
            display[col] = display[col].apply(lambda x: "" if x == "" or pd.isna(x) else f"{fmt_table_number(x)}%")
        elif any(key in col_key for key in ["revenue", "amount", "payout", "commission", "money", "cost", "salary", "gross_rev", "net_rev", "profit", "loss"]):
            display[col] = display[col].apply(lambda x: "" if x == "" or pd.isna(x) else fmt_money(x) if isinstance(x, (int, float)) else x)
        elif pd.api.types.is_numeric_dtype(source[col]):
            display[col] = display[col].apply(lambda x: "" if x == "" or pd.isna(x) else fmt_table_number(x))
    rename_map = {
        "change_pct": "% \u0394",
        "change_amount": "\u0394 Amount",
        "previous_revenue": "Previous Revenue",
        "revenue_share_pct": "Revenue Share %",
        "revenue_per_hour": "Revenue / Hour",
        "messages_per_hour": "Messages / Hour",
        "average_revenue_per_day": "Avg Revenue / Day",
        "average_transaction_value": "Avg Transaction",
        "selected_revenue": "Tips + Messages Revenue",
        "tier_revenue": "Tier Pace Revenue",
        "line_item": "Line Item",
        "share_pct": "Share %",
        "source": "Source",
        "profit_loss_line": "Profit / Loss Line",
        "gross_rev": "Gross Rev",
        "net_rev": "Net Rev",
        "creator_share": "Creator Share",
        "partner_share": "Partner Share",
        "other_share": "Other Share",
        "chatter_commission": "Chatter Commission",
        "manager_commission": "Manager Commission",
        "platform_share": "Platform Share",
    }
    columns = [(col, rename_map.get(col, col)) for col in display.columns]
    header = "".join(f"<th>{html.escape(str(label))}</th>" for _, label in columns)
    body_rows = []
    for idx, row in display.iterrows():
        cells = []
        for original, _ in columns:
            value = row.get(original)
            text = "" if value == "" or pd.isna(value) else str(value)
            raw_value = source.loc[idx, original]
            raw_text = "" if pd.isna(raw_value) else str(raw_value)
            raw_type = "text"
            if pd.api.types.is_numeric_dtype(source[original]):
                raw_type = "number"
            elif pd.api.types.is_datetime64_any_dtype(source[original]) or "date" in str(original).lower() or "time" in str(original).lower():
                raw_type = "date"
            attrs = f" data-sort-value='{html.escape(raw_text, quote=True)}' data-sort-type='{raw_type}'"
            if original == "change_pct":
                raw = source.loc[idx, original]
                if pd.isna(raw):
                    cells.append(f"<td{attrs}></td>")
                else:
                    cls = "delta-positive" if float(raw) > 0 else "delta-negative" if float(raw) < 0 else "delta-neutral"
                    cells.append(f"<td{attrs}><span class='{cls}'>{html.escape(text)}</span></td>")
            else:
                cells.append(f"<td{attrs}>{html.escape(text)}</td>")
        body_rows.append("<tr>" + "".join(cells) + "</tr>")
    return f"<table class='data-table'><thead><tr>{header}</tr></thead><tbody>{''.join(body_rows)}</tbody></table>"


LIVE_REVENUE_CATCHER_CACHE: dict[tuple[str, str, str, str], tuple[float, pd.DataFrame]] = {}
LIVE_REVENUE_CATCHER_DIRECTORY_CACHE: dict[tuple[str, str], tuple[float, pd.DataFrame]] = {}
FLOW_MANAGER_SUMMARY_CACHE: dict[tuple[str, str, str, str, str], tuple[float, dict]] = {}
LIVE_REVENUE_CATCHER_TTL_SECONDS = 300
LIVE_REVENUE_CATCHER_TIMEOUT_SECONDS = 6
MAX_LIVE_REVENUE_CATCHER_CACHE_ENTRIES = 12


def _fetch_revenue_catcher_endpoint(base_url: str, api_key: str, source_type: str, endpoint: str, start: date, end: date) -> pd.DataFrame:
    query = {
        "dateFrom": start.isoformat(),
        "dateTo": end.isoformat(),
    }
    if endpoint.endswith("/summary"):
        query["period"] = "daily"
    url = f"{base_url}{endpoint}?{urlencode(query)}"
    req = request.Request(url, headers={"Accept": "application/json", "x-api-key": api_key})
    try:
        with request.urlopen(req, timeout=LIVE_REVENUE_CATCHER_TIMEOUT_SECONDS) as response:
            data = json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError):
        return pd.DataFrame()
    live = revenue_catcher_to_frame(data)
    if not live.empty:
        live["source_type"] = source_type
    return live


def _fetch_revenue_catcher_static_endpoint(base_url: str, api_key: str, source_type: str, endpoint: str) -> pd.DataFrame:
    url = f"{base_url}{endpoint}"
    req = request.Request(url, headers={"Accept": "application/json", "x-api-key": api_key})
    try:
        with request.urlopen(req, timeout=LIVE_REVENUE_CATCHER_TIMEOUT_SECONDS) as response:
            data = json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError):
        return pd.DataFrame()
    if endpoint.endswith("/commission-structures"):
        live = revenue_catcher_commission_structures_to_frame(data)
    elif endpoint.endswith("/platform-fee-rates"):
        live = revenue_catcher_platform_fee_rates_to_frame(data)
    else:
        live = revenue_catcher_to_frame(data)
    if not live.empty:
        live["source_type"] = source_type
    return live


def live_revenue_catcher_frame(settings: dict, start: date, end: date) -> pd.DataFrame:
    api_key = os.environ.get("REVENUE_CATCHER_API_KEY") or settings.get("revenue_catcher_api_key") or ""
    if not api_key:
        return pd.DataFrame()
    base_url = settings.get("revenue_catcher_base_url", "https://revenuecatcher-production.up.railway.app").rstrip("/")
    cache_key = (base_url, start.isoformat(), end.isoformat(), api_key[-8:])
    cached = LIVE_REVENUE_CATCHER_CACHE.get(cache_key)
    if cached and time.time() - cached[0] < LIVE_REVENUE_CATCHER_TTL_SECONDS:
        return cached[1].copy()
    endpoints = [
        ("revenue_catcher_live_revenue", "/api/revenue"),
        ("revenue_catcher_live_shifts", "/api/shifts/export"),
        ("revenue_catcher_live_shift_history", "/api/shifts/history"),
        ("revenue_catcher_live_summary", "/api/revenue/summary"),
    ]
    frames = []
    with ThreadPoolExecutor(max_workers=len(endpoints)) as executor:
        futures = [
            executor.submit(_fetch_revenue_catcher_endpoint, base_url, api_key, source_type, endpoint, start, end)
            for source_type, endpoint in endpoints
        ]
        for future in as_completed(futures):
            try:
                live = future.result()
            except Exception:
                continue
            if not live.empty:
                frames.append(live)
    result = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
    LIVE_REVENUE_CATCHER_CACHE[cache_key] = (time.time(), result.copy())
    if len(LIVE_REVENUE_CATCHER_CACHE) > MAX_LIVE_REVENUE_CATCHER_CACHE_ENTRIES:
        oldest_key = min(LIVE_REVENUE_CATCHER_CACHE, key=lambda key: LIVE_REVENUE_CATCHER_CACHE[key][0])
        LIVE_REVENUE_CATCHER_CACHE.pop(oldest_key, None)
    return result


def live_revenue_catcher_directory_frame(settings: dict) -> pd.DataFrame:
    api_key = os.environ.get("REVENUE_CATCHER_API_KEY") or settings.get("revenue_catcher_api_key") or ""
    if not api_key:
        return pd.DataFrame()
    base_url = settings.get("revenue_catcher_base_url", "https://revenuecatcher-production.up.railway.app").rstrip("/")
    cache_key = (base_url, api_key[-8:])
    cached = LIVE_REVENUE_CATCHER_DIRECTORY_CACHE.get(cache_key)
    if cached and time.time() - cached[0] < LIVE_REVENUE_CATCHER_TTL_SECONDS:
        return cached[1].copy()
    endpoints = [
        ("revenue_catcher_live_creators", "/api/creators"),
        ("revenue_catcher_live_creator_accounts", "/api/creator-accounts"),
        ("revenue_catcher_live_commission_structures", "/api/commission-structures"),
        ("revenue_catcher_live_platform_fee_rates", "/api/platform-fee-rates"),
    ]
    frames = []
    with ThreadPoolExecutor(max_workers=len(endpoints)) as executor:
        futures = [
            executor.submit(_fetch_revenue_catcher_static_endpoint, base_url, api_key, source_type, endpoint)
            for source_type, endpoint in endpoints
        ]
        for future in as_completed(futures):
            try:
                live = future.result()
            except Exception:
                continue
            if not live.empty:
                frames.append(live)
    result = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
    LIVE_REVENUE_CATCHER_DIRECTORY_CACHE[cache_key] = (time.time(), result.copy())
    return result


def merge_live_revenue_catcher(df: pd.DataFrame, settings: dict, start: date, end: date, comp_start: date, comp_end: date) -> pd.DataFrame:
    has_postgres_rows = False
    if not df.empty and "source_type" in df:
        source_type = df["source_type"].fillna("").astype(str)
        has_postgres_rows = source_type.str.startswith("postgres_").any()
        revenue = pd.to_numeric(df.get("revenue", pd.Series(0, index=df.index)), errors="coerce")
        has_postgres_revenue = has_postgres_rows and revenue.notna().any() and revenue.fillna(0).ne(0).any()
        if has_postgres_revenue:
            return df
    live_start = min(start, comp_start)
    live_end = max(end, comp_end)
    live = live_revenue_catcher_frame(settings, live_start, live_end)
    if live.empty:
        return df
    live = analytics_frame(live)
    if has_postgres_rows and "transaction_type" in live:
        live = live[~live["transaction_type"].fillna("").astype(str).str.strip().isin({"shift_summary", "inactivity"})].copy()
    live_dates = set(live["date"].dropna()) if "date" in live else set()
    if df.empty:
        return live
    base = df.copy()
    if live_dates and "date" in base:
        source_type = base.get("source_type", pd.Series(index=base.index, dtype=object))
        transaction_type = base.get("transaction_type", pd.Series(index=base.index, dtype=object)).fillna("").astype(str)
        platform = base.get("platform", pd.Series(index=base.index, dtype=object))
        revenue_catcher_mask = (
            source_type.fillna("").astype(str).str.contains("revenue_catcher", case=False, na=False)
            | platform.eq("Revenue Catcher")
            | transaction_type.isin(["summary", "tip", "message", "ppv", "subscription", "shift_summary"])
        )
        base = base[~(revenue_catcher_mask & base["date"].isin(live_dates))].copy()
    return pd.concat([base, live], ignore_index=True)


def current_context(params: dict) -> dict:
    settings = load_settings()
    display_currency = set_display_currency(params.get("currency", [settings.get("default_currency", "EUR")])[0], settings)
    label = params.get("range", ["Today"])[0]
    start_raw = params.get("start", [""])[0]
    end_raw = params.get("end", [""])[0]
    if start_raw and end_raw:
        try:
            start, end = date.fromisoformat(start_raw), date.fromisoformat(end_raw)
        except ValueError:
            start, end = date_range_for(label, week_start=settings.get("reporting_week_start", "Friday"))
    else:
        start, end = date_range_for(label, week_start=settings.get("reporting_week_start", "Friday"))
    compare_label = params.get("compare", ["Previous period"])[0]
    comp_start, comp_end = comparison_range(start, end, compare_label)
    filters = {
        field: [value for value in params.get(field, []) if value]
        for field in ["platform", "team", "creator", "chatter"]
    }
    filters["transaction_type"] = [value for value in params.get("transaction_type", []) if value]
    load_start = min(start, comp_start)
    load_end = max(end, comp_end)
    df = analytics_frame(load_transactions(load_start, load_end))
    df = merge_live_revenue_catcher(df, settings, start, end, comp_start, comp_end)
    current = filter_period(df, start, end, filters)
    previous = filter_period(df, comp_start, comp_end, filters)
    return {
        "settings": settings,
        "range_label": label,
        "compare_label": compare_label,
        "start": start,
        "end": end,
        "comp_start": comp_start,
        "comp_end": comp_end,
        "filters": filters,
        "display_currency": display_currency,
        "all_data": df,
        "current": current,
        "previous": previous,
    }


def analytics_frame(df: pd.DataFrame, preserve_shift_revenue: bool = False) -> pd.DataFrame:
    if df.empty:
        return df.copy()
    prepared = df.copy()
    for col in ["source_type", "transaction_type", "platform", "creator", "chatter"]:
        if col not in prepared:
            prepared[col] = None
    for col in [
        "revenue",
        "hours",
        "messages",
        "inactivity",
        "transactions",
        "commission_earned",
        "salary_cost",
        "shift_hours",
        "messages_sent",
        "active_hours",
        "inactive_minutes",
        "inactivity_money_wasted",
        "peak_unread_chats",
        "unlock_amount",
        "subscription_revenue",
        "tip_revenue",
        "message_revenue",
        "net_amount",
        "platform_net_amount",
        "creator_net_amount",
        "md_net_amount",
        "partner_net_amount",
        "other_net_amount",
        "chatter_net_amount",
        "manager_net_amount",
    ]:
        if col in prepared:
            prepared[col] = pd.to_numeric(prepared[col], errors="coerce")
    if "timestamp" in prepared:
        revenue_api_mask = prepared["source_type"].isin(["revenue_catcher_revenue_api", "revenue_catcher_live_revenue"])
        if revenue_api_mask.any():
            prepared["date"] = prepared["date"].astype(object)
            local_dates = pd.to_datetime(prepared.loc[revenue_api_mask, "timestamp"], errors="coerce", utc=True).dt.tz_convert("Europe/Sarajevo").dt.date
            prepared.loc[revenue_api_mask, "date"] = local_dates
    summary_sources = ["revenue_catcher_summary_api", "revenue_catcher_summary_json", "revenue_catcher_live_summary"]
    live_or_summary_mask = prepared["source_type"].isin(summary_sources)
    if "date" in prepared and live_or_summary_mask.any():
        prepared["date"] = prepared["date"].astype(object)
        prepared.loc[live_or_summary_mask, "date"] = pd.to_datetime(
            prepared.loc[live_or_summary_mask, "date"], errors="coerce"
        ).dt.date
    if "date" in prepared:
        prepared["date"] = pd.to_datetime(prepared["date"], errors="coerce").dt.date
    summary_mask = (
        live_or_summary_mask
        | prepared["transaction_type"].eq("summary")
        | (
            prepared["platform"].eq("Revenue Catcher")
            & prepared["creator"].isna()
            & prepared["chatter"].isna()
        )
    )
    shift_mask = prepared["transaction_type"].eq("shift_summary")
    if not preserve_shift_revenue:
        prepared.loc[shift_mask, "revenue"] = pd.NA

    detail_mask = prepared["revenue"].notna() & ~summary_mask & ~shift_mask
    detailed_dates = set(prepared.loc[detail_mask, "date"].dropna())
    if detailed_dates:
        prepared = prepared[~(summary_mask & prepared["date"].isin(detailed_dates))].copy()

    if "source_type" in prepared and "date" in prepared:
        summary_priority = {
            "revenue_catcher_live_summary": 3,
            "revenue_catcher_summary_api": 2,
            "revenue_catcher_summary_json": 1,
        }
        summary_rows = prepared["source_type"].isin(summary_priority)
        if summary_rows.any():
            priorities = prepared.loc[summary_rows, "source_type"].map(summary_priority)
            best_by_date = priorities.groupby(prepared.loc[summary_rows, "date"]).transform("max")
            duplicate_summary = summary_rows.copy()
            duplicate_summary.loc[summary_rows] = priorities.lt(best_by_date).to_numpy()
            prepared = prepared[~duplicate_summary].copy()

    if "transaction_key" in prepared:
        detail_mask = prepared["revenue"].notna() & ~prepared["transaction_type"].eq("shift_summary")
        detail_rows = prepared[detail_mask].copy()
        other_rows = prepared[~detail_mask].copy()
        if not detail_rows.empty:
            detail_rows = detail_rows.drop_duplicates(subset=["transaction_key"], keep="last")
        prepared = pd.concat([other_rows, detail_rows], ignore_index=True)

    if "shift_id" in prepared:
        shift_mask = prepared["transaction_type"].eq("shift_summary")
        shift_rows = prepared[shift_mask].copy()
        other_rows = prepared[~shift_mask].copy()
        if not shift_rows.empty:
            with_id = shift_rows[shift_rows["shift_id"].notna()].drop_duplicates(subset=["shift_id"], keep="last")
            without_id = shift_rows[shift_rows["shift_id"].isna()]
            shift_rows = pd.concat([without_id, with_id], ignore_index=True)
        prepared = pd.concat([other_rows, shift_rows], ignore_index=True)
    return prepared


def has_model_revenue_rows(df: pd.DataFrame) -> bool:
    if df is None or df.empty or "creator" not in df:
        return False
    creators = df["creator"].fillna("").astype(str).str.strip()
    transaction_type = df.get("transaction_type", pd.Series("", index=df.index)).fillna("").astype(str).str.lower().str.strip()
    revenue = pd.to_numeric(df.get("revenue", pd.Series(0, index=df.index)), errors="coerce").fillna(0)
    tip_revenue = pd.to_numeric(df.get("tip_revenue", pd.Series(0, index=df.index)), errors="coerce").fillna(0)
    message_revenue = pd.to_numeric(df.get("message_revenue", pd.Series(0, index=df.index)), errors="coerce").fillna(0)
    tier_revenue = pd.Series(0.0, index=df.index)
    tier_revenue.loc[transaction_type.isin(["tip", "tips", "message", "messages", "subscription", "subscriptions", "ppv"])] = revenue
    tier_revenue.loc[transaction_type.eq("shift_summary")] = tip_revenue + message_revenue
    return bool((creators.ne("") & ~creators.isin(["Unknown", "None", "nan"]) & tier_revenue.gt(0)).any())


def model_revenue_source(df: pd.DataFrame) -> pd.DataFrame:
    if df is None or df.empty or "transaction_type" not in df:
        return pd.DataFrame()
    rows = df.copy()
    transaction_type = rows["transaction_type"].fillna("").astype(str).str.lower().str.strip()
    detailed = rows[transaction_type.isin(["tip", "tips", "message", "messages", "subscription", "subscriptions", "ppv"])].copy()
    if has_model_revenue_rows(detailed):
        return detailed
    shift_rows = rows[transaction_type.eq("shift_summary")].copy()
    if has_model_revenue_rows(shift_rows):
        return shift_rows
    return pd.DataFrame()


def selectable_transaction_types(df: pd.DataFrame) -> list[str]:
    if df.empty or "transaction_type" not in df:
        return []
    hidden = {"shift_summary", "summary", "inactivity", ""}
    values = {str(value).strip() for value in df["transaction_type"].dropna().unique()}
    return sorted(value for value in values if value and value not in hidden)


def revenue_catcher_commission_structures_to_frame(data: dict) -> pd.DataFrame:
    rows = []
    for structure in data.get("structures", []):
        for line in structure.get("lines") or []:
            rows.append({
                "id": structure.get("id"),
                "creator_id": structure.get("creator_id"),
                "creator": structure.get("creator_name"),
                "platform": structure.get("platform"),
                "transaction_type": line.get("transaction_type"),
                "creator_pct": line.get("creator_pct"),
                "external_partner_pct": line.get("external_partner_pct"),
                "other_commission_pct": line.get("other_commission_pct"),
                "effective_from": structure.get("effective_from"),
                "effective_until": structure.get("effective_until"),
            })
    return pd.DataFrame(rows)


def revenue_catcher_platform_fee_rates_to_frame(data: dict) -> pd.DataFrame:
    rows = []
    for rate in data.get("rates", []):
        rows.append({
            "id": rate.get("id"),
            "platform": rate.get("platform"),
            "platform_fee_pct": rate.get("pct"),
            "effective_from": rate.get("effective_from"),
            "effective_until": rate.get("effective_until"),
        })
    return pd.DataFrame(rows)


MODEL_REVENUE_TRANSACTION_TYPES = ["message", "tip", "subscription", "ppv"]
MODEL_REVENUE_AGENCIES = ["Mucho Dinero Agency", "YS Agency", "Aljaz"]


def agency_display_name(value) -> str:
    label = str(value or "").strip()
    key = label.lower()
    if key in {"md", "mucho dinero", "mucho dinero agency"}:
        return "Mucho Dinero Agency"
    if key in {"ys", "ys agency"}:
        return "YS Agency"
    if key in {"aljaz", "aljaz agency", "aljaž", "aljaž agency"}:
        return "Aljaz"
    return label or "Unknown"


def model_account_metadata(settings: dict) -> pd.DataFrame:
    postgres_accounts = load_postgres_creator_accounts()
    if not postgres_accounts.empty:
        rows = postgres_accounts.copy()
        rows["model"] = rows.get("model", pd.Series("", index=rows.index)).fillna("").astype(str).str.strip()
        rows = rows[rows["model"].ne("")].copy()
        rows["platform_label"] = rows.get("platform_label", pd.Series("", index=rows.index)).fillna("").astype(str).str.strip().apply(platform_display_name)
        rows["agency"] = rows.get("agency", pd.Series("Unknown", index=rows.index)).apply(agency_display_name)
        rows["current_subs"] = pd.to_numeric(rows.get("current_subs", pd.Series(0, index=rows.index)), errors="coerce").fillna(0)
        for column in ["tier", "updated_at"]:
            if column not in rows:
                rows[column] = None
        return rows[["model", "platform_label", "agency", "tier", "current_subs", "updated_at"]]
    directory = live_revenue_catcher_directory_frame(settings)
    if directory.empty:
        return pd.DataFrame(columns=["model", "platform_label", "agency", "tier", "current_subs", "updated_at"])
    creators = directory[directory.get("source_type", pd.Series("", index=directory.index)).eq("revenue_catcher_live_creators")].copy()
    accounts = directory[directory.get("source_type", pd.Series("", index=directory.index)).eq("revenue_catcher_live_creator_accounts")].copy()
    agency_by_id = {}
    agency_by_name = {}
    if not creators.empty:
        if "id" in creators and "agency" in creators:
            agency_by_id = dict(creators[["id", "agency"]].dropna(subset=["id"]).itertuples(index=False, name=None))
        if "name" in creators and "agency" in creators:
            agency_by_name = {
                str(name).strip().lower(): agency
                for name, agency in creators[["name", "agency"]].dropna(subset=["name"]).itertuples(index=False, name=None)
            }
    if accounts.empty:
        return pd.DataFrame(columns=["model", "platform_label", "agency", "tier", "current_subs", "updated_at"])
    rows = accounts.copy()
    rows["model"] = rows.get("creator", pd.Series("", index=rows.index)).fillna("").astype(str).str.strip()
    rows = rows[rows["model"].ne("")].copy()
    rows["platform_label"] = rows.get("platform", pd.Series("", index=rows.index)).fillna("").astype(str).str.strip().apply(platform_display_name)
    rows["current_subs"] = pd.to_numeric(rows.get("current_subs", pd.Series(0, index=rows.index)), errors="coerce").fillna(0)
    rows["agency"] = rows.get("creator_id", pd.Series(index=rows.index)).map(agency_by_id)
    rows["agency"] = rows["agency"].fillna(rows["model"].str.lower().map(agency_by_name)).apply(agency_display_name)
    for column in ["tier", "updated_at"]:
        if column not in rows:
            rows[column] = None
    return rows[["model", "platform_label", "agency", "tier", "current_subs", "updated_at"]]


def model_filter_values(params: dict) -> dict[str, list[str]]:
    return {
        "creator": [value for value in params.get("model_creator", []) if value],
        "platform": [value for value in params.get("model_platform", []) if value],
        "agency": [agency_display_name(value) for value in params.get("model_agency", []) if value],
        "team": [value for value in params.get("model_team", []) if value],
        "transaction_type": [value for value in params.get("model_transaction_type", []) if value],
    }


def apply_model_revenue_filters(df: pd.DataFrame, filters: dict[str, list[str]]) -> pd.DataFrame:
    rows = df.copy()
    selected_creators = filters.get("creator") or []
    selected_platforms = filters.get("platform") or []
    selected_teams = filters.get("team") or []
    selected_types = filters.get("transaction_type") or []
    if selected_creators and "creator" in rows:
        rows = rows[rows["creator"].fillna("").astype(str).str.strip().isin(selected_creators)].copy()
    if selected_platforms and "platform" in rows:
        platform_labels = rows["platform"].fillna("").astype(str).str.strip().apply(platform_display_name)
        rows = rows[platform_labels.isin(selected_platforms)].copy()
    if selected_teams and "team" in rows:
        rows = rows[rows["team"].fillna("Unknown").astype(str).str.strip().isin(selected_teams)].copy()
    if selected_types and "transaction_type" in rows:
        tx = rows["transaction_type"].fillna("").astype(str).str.lower().str.strip()
        rows = rows[tx.isin(selected_types)].copy()
    return rows


def filter_model_card_rows(rows: pd.DataFrame, filters: dict[str, list[str]]) -> pd.DataFrame:
    if rows.empty:
        return rows
    filtered = rows.copy()
    selected_creators = filters.get("creator") or []
    selected_platforms = filters.get("platform") or []
    selected_agencies = filters.get("agency") or []
    if selected_creators and "model" in filtered:
        filtered = filtered[filtered["model"].fillna("").astype(str).str.strip().isin(selected_creators)].copy()
    if selected_platforms and "platform_label" in filtered:
        filtered = filtered[filtered["platform_label"].fillna("").astype(str).isin(selected_platforms)].copy()
    if selected_agencies and "agency" in filtered:
        filtered = filtered[filtered["agency"].apply(agency_display_name).isin(selected_agencies)].copy()
    return filtered


def model_card_sort_values(params: dict) -> tuple[str, str]:
    sort_by = str(params.get("model_sort", ["revenue"])[0]).strip().lower()
    sort_by = sort_by if sort_by in {"revenue", "subscriptions", "model"} else "revenue"
    direction = str(params.get("model_sort_direction", ["desc"])[0]).strip().lower()
    direction = direction if direction in {"asc", "desc"} else "desc"
    return sort_by, direction


def chatter_filter_values(params: dict) -> dict[str, list[str]]:
    return {
        "chatter": [value for value in params.get("chatter_name", []) if value],
        "platform": [value for value in params.get("chatter_platform", []) if value],
        "team": [value for value in params.get("chatter_team", []) if value],
        "creator": [value for value in params.get("chatter_creator", []) if value],
        "transaction_type": [value for value in params.get("chatter_transaction_type", []) if value],
    }


def apply_chatter_revenue_filters(df: pd.DataFrame, filters: dict[str, list[str]]) -> pd.DataFrame:
    rows = df.copy()
    for field in ["chatter", "team", "creator", "transaction_type"]:
        selected = filters.get(field) or []
        if selected and field in rows:
            values = rows[field].fillna("Unknown").astype(str).str.strip()
            values = values.str.lower() if field == "transaction_type" else values
            selected_values = [value.lower() for value in selected] if field == "transaction_type" else selected
            rows = rows[values.isin(selected_values)].copy()
    selected_platforms = filters.get("platform") or []
    if selected_platforms and "platform" in rows:
        labels = rows["platform"].fillna("").astype(str).str.strip().apply(platform_display_name)
        rows = rows[labels.isin(selected_platforms)].copy()
    return rows


def chatter_card_sort_values(params: dict) -> tuple[str, str]:
    sort_by = str(params.get("chatter_sort", ["revenue"])[0]).strip().lower()
    sort_by = sort_by if sort_by in {"revenue", "chatter"} else "revenue"
    direction = str(params.get("chatter_sort_direction", ["desc"])[0]).strip().lower()
    return sort_by, direction if direction in {"asc", "desc"} else "desc"


def chatter_filter_form(ctx: dict, source_rows: pd.DataFrame, filters: dict[str, list[str]], sort_by: str, sort_direction: str) -> str:
    def options(values: list[str], selected: list[str], labels: dict[str, str] | None = None) -> str:
        selected_set = set(selected)
        labels = labels or {}
        return '<option value="">All</option>' + "".join(
            f'<option value="{html.escape(value)}" {"selected" if value in selected_set else ""}>{html.escape(labels.get(value, value))}</option>'
            for value in values
        )

    def values(field: str) -> list[str]:
        if source_rows.empty or field not in source_rows:
            return []
        return sorted({str(value).strip() for value in source_rows[field].dropna() if str(value).strip() and str(value).strip() != "Unknown"}, key=str.lower)

    hidden_inputs = "".join(
        f'<input type="hidden" name="{name}" value="{html.escape(str(value))}">' for name, value in [
            ("range", ctx.get("range_label", "Today")), ("start", ctx["start"]), ("end", ctx["end"]),
            ("compare", ctx.get("compare_label", "Previous period")), ("currency", ctx.get("display_currency", "EUR")),
        ]
    )
    tx_labels = {"message": "Messages", "tip": "Tips"}
    return (
        "<form class='filters model-card-filters' method='get'>"
        f"{hidden_inputs}"
        f"<label>Chatter<select name='chatter_name' multiple>{options(values('chatter'), filters.get('chatter') or [])}</select></label>"
        f"<label>Platform<select name='chatter_platform' multiple>{options(CORE_REVENUE_PLATFORMS, filters.get('platform') or [])}</select></label>"
        f"<label>Team<select name='chatter_team' multiple>{options(values('team'), filters.get('team') or [])}</select></label>"
        f"<label>Creator<select name='chatter_creator' multiple>{options(values('creator'), filters.get('creator') or [])}</select></label>"
        f"<label>Transaction Type<select name='chatter_transaction_type' multiple>{options(['tip', 'message'], filters.get('transaction_type') or [], tx_labels)}</select></label>"
        "<label>Sort By<select name='chatter_sort'>"
        f"<option value='revenue' {'selected' if sort_by == 'revenue' else ''}>Revenue</option>"
        f"<option value='chatter' {'selected' if sort_by == 'chatter' else ''}>Chatter Name</option>"
        "</select></label>"
        "<label>Direction<select name='chatter_sort_direction'>"
        f"<option value='desc' {'selected' if sort_direction == 'desc' else ''}>High to Low</option>"
        f"<option value='asc' {'selected' if sort_direction == 'asc' else ''}>Low to High</option>"
        "</select></label><button type='submit'>Apply</button></form>"
    )


def model_filter_form(ctx: dict, rows: pd.DataFrame, metadata: pd.DataFrame, filters: dict[str, list[str]], source_rows: pd.DataFrame, sort_by: str, sort_direction: str) -> str:
    def hidden(name: str, value) -> str:
        return f'<input type="hidden" name="{html.escape(name)}" value="{html.escape(str(value))}">'

    def options(values: list[str], selected: list[str], labels: dict[str, str] | None = None) -> str:
        selected_set = set(selected)
        labels = labels or {}
        return '<option value="">All</option>' + "".join(
            f'<option value="{html.escape(value)}" {"selected" if value in selected_set else ""}>{html.escape(labels.get(value, value))}</option>'
            for value in values
        )

    creators = []
    if not rows.empty and "model" in rows:
        creators = sorted({str(value).strip() for value in rows["model"].dropna() if str(value).strip()}, key=str.lower)
    platforms = CORE_REVENUE_PLATFORMS
    teams = [] if source_rows.empty or "team" not in source_rows else sorted(
        {str(value).strip() for value in source_rows["team"].dropna() if str(value).strip() and str(value).strip() != "Unknown"},
        key=str.lower,
    )
    agencies = sorted(
        dict.fromkeys([
            *MODEL_REVENUE_AGENCIES,
            *([] if metadata.empty or "agency" not in metadata else [agency_display_name(value) for value in metadata["agency"].dropna() if agency_display_name(value) != "Unknown"]),
        ]),
        key=str.lower,
    )
    tx_labels = {"message": "Messages", "tip": "Tips", "subscription": "Subscriptions", "ppv": "PPV"}
    hidden_inputs = "".join([
        hidden("range", ctx.get("range_label", "Today")),
        hidden("start", ctx["start"]),
        hidden("end", ctx["end"]),
        hidden("compare", ctx.get("compare_label", "Previous period")),
        hidden("currency", ctx.get("display_currency", "EUR")),
    ])
    return (
        "<form class='filters model-card-filters' method='get'>"
        f"{hidden_inputs}"
        f"<label>Creator<select name='model_creator' multiple>{options(creators, filters.get('creator') or [])}</select></label>"
        f"<label>Platform<select name='model_platform' multiple>{options(platforms, filters.get('platform') or [])}</select></label>"
        f"<label>Agency<select name='model_agency' multiple>{options(agencies, filters.get('agency') or [])}</select></label>"
        f"<label>Team<select name='model_team' multiple>{options(teams, filters.get('team') or [])}</select></label>"
        f"<label>Transaction Type<select name='model_transaction_type' multiple>{options(MODEL_REVENUE_TRANSACTION_TYPES, filters.get('transaction_type') or [], tx_labels)}</select></label>"
        "<label>Sort By<select name='model_sort'>"
        f"<option value='revenue' {'selected' if sort_by == 'revenue' else ''}>Revenue</option>"
        f"<option value='subscriptions' {'selected' if sort_by == 'subscriptions' else ''}>Subscription Revenue</option>"
        f"<option value='model' {'selected' if sort_by == 'model' else ''}>Model Name</option>"
        "</select></label>"
        "<label>Direction<select name='model_sort_direction'>"
        f"<option value='desc' {'selected' if sort_direction == 'desc' else ''}>High to Low</option>"
        f"<option value='asc' {'selected' if sort_direction == 'asc' else ''}>Low to High</option>"
        "</select></label>"
        "<button type='submit'>Apply</button>"
        "</form>"
    )


FINANCE_SPLIT_COLUMNS = [
    "platform_net_amount",
    "creator_net_amount",
    "partner_net_amount",
    "other_net_amount",
    "chatter_net_amount",
    "manager_net_amount",
    "md_net_amount",
    "net_amount",
]
FINANCE_PAYOUT_COLUMNS = [column for column in FINANCE_SPLIT_COLUMNS if column not in {"md_net_amount", "net_amount"}]


def _finance_detail_rows(df: pd.DataFrame) -> pd.DataFrame:
    if df is None or df.empty:
        return pd.DataFrame()
    rows = df.copy()
    transaction_type = rows.get("transaction_type", pd.Series("", index=rows.index)).fillna("").astype(str).str.lower().str.strip()
    revenue = pd.to_numeric(rows.get("revenue", pd.Series(0, index=rows.index)), errors="coerce")
    rows = rows[revenue.notna() & revenue.fillna(0).ne(0) & ~transaction_type.isin({"summary", "shift_summary", "inactivity", ""})].copy()
    return rows


def _has_finance_split_fields(df: pd.DataFrame) -> bool:
    if df is None or df.empty:
        return False
    for column in FINANCE_PAYOUT_COLUMNS:
        if column in df and pd.to_numeric(df[column], errors="coerce").fillna(0).abs().gt(0).any():
            return True
    return False


def _has_revenue_catcher_net_amount(df: pd.DataFrame) -> bool:
    if df is None or df.empty or "net_amount" not in df:
        return False
    return pd.to_numeric(df["net_amount"], errors="coerce").notna().any()


def finance_source_frame(ctx: dict) -> pd.DataFrame:
    current = _finance_detail_rows(ctx["current"])
    if _has_finance_split_fields(current) or _has_revenue_catcher_net_amount(current):
        return current
    live = live_revenue_catcher_frame(ctx["settings"], ctx["start"], ctx["end"])
    if live.empty:
        return current
    live = analytics_frame(live)
    live_current = filter_period(live, ctx["start"], ctx["end"], ctx["filters"])
    live_current = _finance_detail_rows(live_current)
    if _has_finance_split_fields(live_current) or _has_revenue_catcher_net_amount(live_current):
        return live_current
    return current


def revenue_catcher_structure_finance_breakdown(rows: pd.DataFrame, settings: dict) -> dict | None:
    reference = live_revenue_catcher_directory_frame(settings)
    if reference.empty:
        return None
    source_type = reference.get("source_type", pd.Series("", index=reference.index)).fillna("").astype(str)
    structures = reference[source_type.eq("revenue_catcher_live_commission_structures")].copy()
    fee_rates = reference[source_type.eq("revenue_catcher_live_platform_fee_rates")].copy()
    if structures.empty and fee_rates.empty:
        return None

    platform_fee_by_platform = {}
    if not fee_rates.empty:
        fee_rates["platform_label"] = fee_rates.get("platform", pd.Series("", index=fee_rates.index)).fillna("").astype(str).str.strip().apply(platform_display_name)
        fee_rates["platform_fee_pct"] = pd.to_numeric(fee_rates.get("platform_fee_pct", pd.Series(0, index=fee_rates.index)), errors="coerce").fillna(0)
        platform_fee_by_platform = dict(fee_rates.drop_duplicates("platform_label")[["platform_label", "platform_fee_pct"]].itertuples(index=False, name=None))

    structure_by_key = {}
    if not structures.empty:
        structures["platform_label"] = structures.get("platform", pd.Series("", index=structures.index)).fillna("").astype(str).str.strip().apply(platform_display_name)
        structures["tx_type"] = structures.get("transaction_type", pd.Series("", index=structures.index)).fillna("").astype(str).str.lower().str.strip()
        structures["creator_key"] = structures.get("creator", pd.Series("", index=structures.index)).fillna("").astype(str).str.strip().str.lower()
        for _, structure in structures.iterrows():
            key = (structure.get("creator_key"), structure.get("platform_label"), structure.get("tx_type"))
            if key not in structure_by_key:
                structure_by_key[key] = structure

    result = {
        "platform_share": 0.0,
        "creator_share": 0.0,
        "partner_share": 0.0,
        "other_share": 0.0,
        "matched_rows": 0,
    }
    for _, row in rows.iterrows():
        gross = float(row.get("revenue") or 0)
        if gross == 0:
            continue
        platform = platform_display_name(str(row.get("platform") or ""))
        tx_type = str(row.get("transaction_type") or "").lower().strip()
        creator_key = str(row.get("creator") or "").strip().lower()
        platform_pct = float(platform_fee_by_platform.get(platform, 0) or 0)
        platform_share = gross * platform_pct / 100
        post_platform = gross - platform_share
        structure = structure_by_key.get((creator_key, platform, tx_type))
        if structure is None:
            continue
        result["matched_rows"] += 1
        result["platform_share"] += platform_share
        result["creator_share"] += post_platform * float(structure.get("creator_pct") or 0) / 100
        result["partner_share"] += post_platform * float(structure.get("external_partner_pct") or 0) / 100
        result["other_share"] += post_platform * float(structure.get("other_commission_pct") or 0) / 100
    return result if result["matched_rows"] else None


def finance_breakdown(df: pd.DataFrame, settings: dict) -> dict:
    rows = _finance_detail_rows(df)
    result = {
        "source": "No transaction rows",
        "gross_revenue": 0.0,
        "platform_share": 0.0,
        "creator_share": 0.0,
        "partner_share": 0.0,
        "other_share": 0.0,
        "chatter_commission": 0.0,
        "manager_commission": 0.0,
        "revenue_catcher_deductions": 0.0,
        "gross_profit": 0.0,
        "net_revenue": 0.0,
        "total_payouts_costs": 0.0,
        "net_margin_pct": None,
        "profit_loss": 0.0,
        "uses_split_fields": False,
    }
    if rows.empty:
        return financial_ledger(gross_revenue=None, source="No transaction rows")

    revenue = pd.to_numeric(rows.get("revenue", pd.Series(0, index=rows.index)), errors="coerce").fillna(0)
    result["gross_revenue"] = float(revenue.sum())
    uses_split_fields = _has_finance_split_fields(rows)
    uses_net_amount = _has_revenue_catcher_net_amount(rows)
    result["uses_split_fields"] = uses_split_fields
    result["source"] = "RevenueCatcher split fields" if uses_split_fields else "RevenueCatcher net amount" if uses_net_amount else "Fallback commission rules"

    if uses_split_fields:
        for source_column, target in [
            ("platform_net_amount", "platform_share"),
            ("creator_net_amount", "creator_share"),
            ("partner_net_amount", "partner_share"),
            ("other_net_amount", "other_share"),
            ("chatter_net_amount", "chatter_commission"),
            ("manager_net_amount", "manager_commission"),
        ]:
            if source_column in rows:
                result[target] = float(pd.to_numeric(rows[source_column], errors="coerce").fillna(0).sum())
        if "md_net_amount" in rows and pd.to_numeric(rows["md_net_amount"], errors="coerce").notna().any():
            result["net_revenue"] = float(pd.to_numeric(rows["md_net_amount"], errors="coerce").fillna(0).sum())
        elif uses_net_amount:
            result["net_revenue"] = float(pd.to_numeric(rows["net_amount"], errors="coerce").fillna(0).sum())
        else:
            result["net_revenue"] = result["gross_revenue"] - sum(result[key] for key in [
                "platform_share",
                "creator_share",
                "partner_share",
                "other_share",
                "chatter_commission",
                "manager_commission",
            ])
    elif uses_net_amount:
        result["net_revenue"] = float(pd.to_numeric(rows["net_amount"], errors="coerce").fillna(0).sum())
    else:
        structure_finance = revenue_catcher_structure_finance_breakdown(rows, settings)
        if structure_finance:
            result["source"] = "RevenueCatcher commission structures"
            result["platform_share"] = structure_finance["platform_share"]
            result["creator_share"] = structure_finance["creator_share"]
            result["partner_share"] = structure_finance["partner_share"]
            result["other_share"] = structure_finance["other_share"]
            rule = (settings.get("commission_rules") or [{}])[0]
            result["chatter_commission"] = result["gross_revenue"] * float(rule.get("chatter_commission_pct", 0)) / 100
        else:
            rule = (settings.get("commission_rules") or [{}])[0]
            result["creator_share"] = result["gross_revenue"] * float(rule.get("creator_pct", 0)) / 100
            result["partner_share"] = result["gross_revenue"] * float(rule.get("external_partner_pct", 0)) / 100
            result["other_share"] = result["gross_revenue"] * float(rule.get("other_commission_pct", 0)) / 100
            result["chatter_commission"] = result["gross_revenue"] * float(rule.get("chatter_commission_pct", 0)) / 100
        result["net_revenue"] = result["gross_revenue"] - sum(result[key] for key in [
            "platform_share",
            "creator_share",
            "partner_share",
            "other_share",
            "chatter_commission",
        ])

    # A Flow net amount without its bucketed deductions cannot be safely
    # relabelled as Agency Revenue, Net Revenue, or P&L.  Keep it as a reported
    # reference, but leave classification unavailable rather than deducting
    # chatter costs again from an already-net number.
    classified = uses_split_fields or not uses_net_amount
    ledger = financial_ledger(
        gross_revenue=result["gross_revenue"],
        platform_fees=result["platform_share"] if classified else None,
        creator_share=result["creator_share"] if classified else None,
        partner_share=result["partner_share"] if classified else None,
        other_external=result["other_share"] if classified else None,
        chatter_commission=result["chatter_commission"] if classified else None,
        manager_commission=result["manager_commission"] if classified else None,
        chatter_bonus=0.0 if classified else None,
        chatter_salary=0.0 if classified else None,
        other_direct_costs=0.0 if classified else None,
        operating_expenses=None,
        source=result["source"],
    )
    ledger["reported_flow_net_amount"] = result["net_revenue"] if uses_net_amount else None
    ledger["uses_split_fields"] = uses_split_fields
    # Compatibility aliases keep existing non-P&L detail views working while
    # all financial presentation moves to the standard ledger keys.
    ledger["gross_profit"] = ledger["agency_revenue"]
    ledger["total_payouts_costs"] = (
        ledger["external_revenue_splits"] + ledger["direct_revenue_costs"]
        if ledger["external_revenue_splits"] is not None and ledger["direct_revenue_costs"] is not None else None
    )
    ledger["net_margin_pct"] = ledger["net_revenue_margin_pct"]
    ledger["revenue_catcher_deductions"] = None
    return ledger


def finance_cards_html(finance: dict) -> str:
    if not finance.get("is_complete"):
        return (
            "<section class='notice compact-source'><strong>P&amp;L status:</strong> "
            "Flow has not supplied classified external revenue splits for this scope, so GAZE keeps the detailed costs visible but does not present an unconfirmed P&amp;L.</section>"
        )
    completeness = "complete tracked P&L" if finance.get("is_complete") else "incomplete: Flow cost buckets are not fully classified"
    cards = [
        ("Gross Revenue", fmt_money(finance.get("gross_revenue")), finance.get("source", ""), "gross_revenue"),
        ("External Revenue Splits", fmt_money(finance.get("external_revenue_splits")), "platform, creator, partner, other", "external_revenue_splits"),
        ("Agency Revenue", fmt_money(finance.get("agency_revenue")), "gross less external splits", "agency_revenue"),
        ("Direct Revenue Costs", fmt_money(finance.get("direct_revenue_costs")), "chatter and chat-manager costs", "direct_revenue_costs"),
        ("Net Revenue", fmt_money(finance.get("net_revenue")), completeness, "net_revenue"),
        ("P&L Profit/Loss", fmt_money(finance.get("profit_loss")), completeness, "profit_loss"),
        ("Profit Margin", fmt_pct(finance.get("profit_margin_pct")), "P&L / gross revenue", "profit_margin"),
    ]
    return '<section class="kpi-grid finance-kpi-grid">' + "".join(kpi_card_html(a, b, c, key) for a, b, c, key in cards) + "</section>"


def finance_breakdown_tables(finance: dict) -> tuple[pd.DataFrame, pd.DataFrame]:
    gross = float(finance.get("gross_revenue") or 0)

    def share(value: float) -> float | None:
        return value / gross * 100 if gross else None

    breakdown = pd.DataFrame([
        {"line_item": "Gross Revenue", "amount": finance.get("gross_revenue"), "share_pct": share(float(finance.get("gross_revenue") or 0)), "source": finance.get("source")},
        {"line_item": "Platform share / fees", "amount": finance.get("platform_share"), "share_pct": share(float(finance.get("platform_share") or 0)), "source": "platform fee rate"},
        {"line_item": "Creator share", "amount": finance.get("creator_share"), "share_pct": share(float(finance.get("creator_share") or 0)), "source": "model profile split"},
        {"line_item": "Partner share", "amount": finance.get("partner_share"), "share_pct": share(float(finance.get("partner_share") or 0)), "source": "model profile split"},
        {"line_item": "Other share", "amount": finance.get("other_share"), "share_pct": share(float(finance.get("other_share") or 0)), "source": "model profile split"},
        {"line_item": "Agency Revenue", "amount": finance.get("agency_revenue"), "share_pct": share(float(finance.get("agency_revenue") or 0)), "source": "gross less external revenue splits"},
        {"line_item": "Chatter commission", "amount": finance.get("chatter_commission"), "share_pct": share(float(finance.get("chatter_commission") or 0)), "source": "chatter commission structure"},
        {"line_item": "Chat manager commission", "amount": finance.get("manager_commission"), "share_pct": share(float(finance.get("manager_commission") or 0)), "source": "manager commission routing"},
        {"line_item": "Direct Revenue Costs", "amount": finance.get("direct_revenue_costs"), "share_pct": share(float(finance.get("direct_revenue_costs") or 0)), "source": "tracked direct costs"},
        {"line_item": "Net Revenue", "amount": finance.get("net_revenue"), "share_pct": share(float(finance.get("net_revenue") or 0)), "source": "agency revenue less direct costs"},
    ])
    pnl = pd.DataFrame([
        {"profit_loss_line": "Gross Revenue", "amount": finance.get("gross_revenue")},
        {"profit_loss_line": "Less External Revenue Splits", "amount": -float(finance.get("external_revenue_splits") or 0) if finance.get("external_revenue_splits") is not None else None},
        {"profit_loss_line": "Agency Revenue", "amount": finance.get("agency_revenue")},
        {"profit_loss_line": "Less Direct Revenue Costs", "amount": -float(finance.get("direct_revenue_costs") or 0) if finance.get("direct_revenue_costs") is not None else None},
        {"profit_loss_line": "Net Revenue", "amount": finance.get("net_revenue")},
        {"profit_loss_line": "Less Operating Expenses", "amount": -float(finance.get("operating_expenses") or 0) if finance.get("operating_expenses") is not None else None},
        {"profit_loss_line": "P&L Profit/Loss", "amount": finance.get("profit_loss")},
    ])
    return breakdown, pnl


def flow_bonus_by_chatter(finance_rows: pd.DataFrame) -> pd.DataFrame:
    """Reproduce Flow's daily team bonus rules in Gaze's EUR reporting currency."""
    columns = ["team", "chatter", "flow_bonus"]
    rows = _finance_detail_rows(finance_rows).copy()
    if rows.empty:
        return pd.DataFrame(columns=columns)
    team = rows.get("team", pd.Series("", index=rows.index)).fillna("").astype(str).str.strip()
    chatter = rows.get("chatter", pd.Series("", index=rows.index)).fillna("").astype(str).str.strip()
    valid = team.ne("") & chatter.ne("") & ~chatter.str.casefold().isin({"unknown", "none", "nan", "unassigned"})
    rows = rows[valid].copy()
    if rows.empty:
        return pd.DataFrame(columns=columns)
    rules = load_postgres_flow_team_rules()
    if rules.empty:
        return pd.DataFrame(columns=columns)
    rules = rules.copy()
    rules["team_key"] = rules["team"].fillna("").astype(str).str.casefold()
    rows["team_key"] = rows["team"].fillna("").astype(str).str.casefold()
    rows = rows.merge(rules[["team_key", "bonus_rule_type", "bonus_rule_config"]], on="team_key", how="left")
    rows["revenue"] = pd.to_numeric(rows.get("revenue", 0), errors="coerce").fillna(0)
    rows["net_amount"] = pd.to_numeric(rows.get("net_amount", rows["revenue"]), errors="coerce").fillna(rows["revenue"])
    rows["platform_key"] = rows.get("platform", pd.Series("", index=rows.index)).fillna("").astype(str).str.upper()
    rows["creator_key"] = rows.get("creator_id", pd.Series("", index=rows.index)).fillna("").astype(str)
    rows["day"] = pd.to_datetime(rows.get("date"), errors="coerce").dt.date
    rows = rows[rows["day"].notna()].copy()
    if rows.empty:
        return pd.DataFrame(columns=columns)
    try:
        fx_rate = revenue_catcher_rate()
    except Exception:
        fx_rate = 1.0
    targets = load_postgres_account_targets()
    target_by_account: dict[tuple[str, str], float] = {}
    if not targets.empty:
        for _, target in targets.iterrows():
            amount = pd.to_numeric(target.get("current_target"), errors="coerce")
            if pd.isna(amount) or float(amount) <= 0:
                continue
            platform = str(target.get("platform") or "").upper()
            adjusted = float(amount) / fx_rate if platform in {"OF", "KNKY"} else float(amount)
            target_by_account[(str(target.get("creator_id") or ""), platform)] = adjusted

    account_daily = rows.groupby(["day", "creator_key", "platform_key"], dropna=False)["revenue"].sum().to_dict()
    bonuses: list[dict] = []
    tier_rows = rows[rows["bonus_rule_type"].eq("per_account_tiered")]
    for (day, team_name, chatter_name, creator_key, platform_key), group in tier_rows.groupby(["day", "team", "chatter", "creator_key", "platform_key"], dropna=False):
        config = group.iloc[0].get("bonus_rule_config") or {}
        if isinstance(config, str):
            try:
                config = json.loads(config)
            except json.JSONDecodeError:
                config = {}
        target = target_by_account.get((str(creator_key), str(platform_key)))
        if not target:
            continue
        account_revenue = float(account_daily.get((day, creator_key, platform_key), 0))
        matched = [tier for tier in config.get("tiers", []) if account_revenue >= target * float(tier.get("thresholdMultiplier", 0) or 0)]
        if matched:
            rate = max(matched, key=lambda tier: float(tier.get("thresholdMultiplier", 0) or 0)).get("rate", 0)
            bonuses.append({"team": team_name, "chatter": chatter_name, "flow_bonus": float(group["revenue"].sum()) * float(rate or 0)})

    flat_rows = rows[rows["bonus_rule_type"].eq("flat_day_threshold")]
    for (day, team_name, chatter_name), group in flat_rows.groupby(["day", "team", "chatter"], dropna=False):
        config = group.iloc[0].get("bonus_rule_config") or {}
        if isinstance(config, str):
            try:
                config = json.loads(config)
            except json.JSONDecodeError:
                config = {}
        threshold_eur = float(config.get("thresholdUsd", 0) or 0) / fx_rate
        net = float(group["net_amount"].sum())
        if threshold_eur and net >= threshold_eur:
            bonuses.append({"team": team_name, "chatter": chatter_name, "flow_bonus": net * float(config.get("rate", 0) or 0)})
    if not bonuses:
        return pd.DataFrame(columns=columns)
    return pd.DataFrame(bonuses).groupby(["team", "chatter"], dropna=False)["flow_bonus"].sum().reset_index()


def commission_cost_breakdown(finance_rows: pd.DataFrame, all_rows: pd.DataFrame, settings: dict, scheduled_data: pd.DataFrame | None = None) -> tuple[dict, pd.DataFrame, pd.DataFrame]:
    """Calculate chatter commission before and after salary, grouped by team and chatter."""
    revenue_rows = _finance_detail_rows(finance_rows)
    empty = pd.DataFrame(columns=["team", "chatter", "commission_plan", "pre_salary_commission", "salary_cost", "post_salary_commission"])
    summary = {"pre_salary_commission": 0.0, "salary_cost": 0.0, "post_salary_commission": 0.0}
    if revenue_rows.empty:
        return summary, empty, empty

    calculated = commission_analysis(revenue_rows, settings)
    calculated["team"] = calculated.get("team", pd.Series("", index=calculated.index)).fillna("").astype(str).str.strip().replace("", "Unassigned")
    calculated["chatter"] = calculated.get("chatter", pd.Series("", index=calculated.index)).fillna("").astype(str).str.strip().replace("", "Unassigned")
    # A transaction with no attributed chatter is company revenue awaiting
    # attribution, not a payable chatter commission.  Charging the generic
    # fallback rate here was the source of the large false "Unassigned" cost.
    calculated = calculated[calculated["chatter"].ne("Unassigned")].copy()
    if calculated.empty:
        return summary, empty, empty
    # Flow's individual chatter rate is authoritative for a payout whenever it
    # is available.  Gaze's configurable plan is retained only for historical
    # rows that have no Flow rate, rather than overwriting a real payout rate.
    actual = pd.to_numeric(calculated.get("chatter_net_amount", pd.Series(pd.NA, index=calculated.index)), errors="coerce")
    flow_pct = pd.to_numeric(calculated.get("flow_chatter_commission_pct", pd.Series(pd.NA, index=calculated.index)), errors="coerce")
    flow_commission = pd.to_numeric(calculated.get("revenue", pd.Series(0, index=calculated.index)), errors="coerce").fillna(0) * flow_pct / 100
    calculated["pre_salary_commission"] = actual.where(actual.notna(), flow_commission.where(flow_pct.notna(), calculated["chatter_payout"]))
    flow_pool = calculated.get("flow_commission_pool", pd.Series("", index=calculated.index)).fillna("").astype(str).str.strip()
    flow_plan = flow_pct.map(lambda pct: f"Flow rate {pct:g}%" if pd.notna(pct) else "")
    flow_plan = flow_plan.where(flow_pool.eq(""), flow_plan + " · " + flow_pool)
    calculated["commission_plan"] = flow_plan.where(flow_pct.notna(), calculated["commission_plan"])

    salaries = pd.DataFrame(columns=["team", "chatter", "salary_cost"])
    if all_rows is not None and not all_rows.empty:
        shift_type = all_rows.get("transaction_type", pd.Series("", index=all_rows.index)).fillna("").astype(str).str.lower()
        shifts = all_rows[shift_type.eq("shift_summary")].copy()
        if not shifts.empty:
            shifts = commission_analysis(shifts, settings)
            shifts["team"] = shifts.get("team", pd.Series("", index=shifts.index)).fillna("").astype(str).str.strip().replace("", "Unassigned")
            shifts["chatter"] = shifts.get("chatter", pd.Series("", index=shifts.index)).fillna("").astype(str).str.strip().replace("", "Unassigned")
            recorded_salary = pd.to_numeric(shifts.get("salary_cost", pd.Series(pd.NA, index=shifts.index)), errors="coerce")
            hours = pd.to_numeric(shifts.get("shift_hours", pd.Series(0, index=shifts.index)), errors="coerce").fillna(0)
            english = shifts["team"].map(cost_team_name).eq("English")
            try:
                fx_rate = revenue_catcher_rate()
            except Exception:
                fx_rate = 1.0
            english_hourly_eur = float(settings.get("english_chatter_salary_usd_per_hour", 2.0) or 0) / fx_rate
            # Policy: English chatters earn $2/hour; Dutch chatters are paid
            # exclusively through commission.  Any recorded Flow salary still
            # takes precedence when it exists for a particular shift.
            calculated_salary = hours.where(english, 0.0) * english_hourly_eur
            shifts["salary_cost"] = recorded_salary.where(recorded_salary.notna(), calculated_salary)
            salaries = shifts.groupby(["team", "chatter"], dropna=False)["salary_cost"].sum().reset_index()

    # Flow currently has no closed English shifts in some periods although the
    # schedule is present. Use scheduled English hours only when there is no
    # closed English salary record, so payroll remains complete without
    # double-counting worked hours.
    has_english_salary = not salaries.empty and salaries["team"].map(cost_team_name).eq("English").any()
    if not has_english_salary and scheduled_data is not None and not scheduled_data.empty:
        schedule = scheduled_data.copy()
        schedule["team"] = schedule.get("team", pd.Series("", index=schedule.index)).fillna("").astype(str).str.strip()
        schedule["chatter"] = schedule.get("chatter", pd.Series("", index=schedule.index)).fillna("").astype(str).str.strip()
        schedule["scheduled_hours"] = pd.to_numeric(schedule.get("scheduled_hours", pd.Series(0, index=schedule.index)), errors="coerce").fillna(0)
        schedule = schedule[schedule["team"].map(cost_team_name).eq("English") & schedule["chatter"].ne("")]
        if not schedule.empty:
            try:
                fx_rate = revenue_catcher_rate()
            except Exception:
                fx_rate = 1.0
            hourly_eur = float(settings.get("english_chatter_salary_usd_per_hour", 2.0) or 0) / fx_rate
            schedule["salary_cost"] = schedule["scheduled_hours"] * hourly_eur
            salaries = schedule.groupby(["team", "chatter"], dropna=False)["salary_cost"].sum().reset_index()

    chatter = (
        calculated.groupby(["team", "chatter"], dropna=False)
        .agg(
            pre_salary_commission=("pre_salary_commission", "sum"),
            commission_plan=("commission_plan", lambda values: ", ".join(sorted(set(str(value) for value in values if value)))),
        )
        .reset_index()
        .merge(salaries, on=["team", "chatter"], how="left")
    )
    chatter = chatter.rename(columns={"pre_salary_commission": "base_commission"})
    bonuses = flow_bonus_by_chatter(revenue_rows)
    chatter = chatter.merge(bonuses, on=["team", "chatter"], how="left")
    chatter["flow_bonus"] = pd.to_numeric(chatter["flow_bonus"], errors="coerce").fillna(0.0)
    chatter["pre_salary_commission"] = chatter["base_commission"] + chatter["flow_bonus"]
    chatter["salary_cost"] = pd.to_numeric(chatter["salary_cost"], errors="coerce").fillna(0.0)
    chatter["post_salary_commission"] = chatter["pre_salary_commission"] - chatter["salary_cost"]
    chatter = chatter.sort_values("pre_salary_commission", ascending=False)
    team = (
        chatter.groupby("team", dropna=False)[["base_commission", "flow_bonus", "pre_salary_commission", "salary_cost", "post_salary_commission"]]
        .sum()
        .reset_index()
        .sort_values("pre_salary_commission", ascending=False)
    )
    summary = {key: float(chatter[key].sum()) for key in summary}
    return summary, team, chatter


def commission_attribution_audit(finance_rows: pd.DataFrame) -> pd.DataFrame:
    """Expose the revenue that is safely payable and the Flow records needing action."""
    rows = _finance_detail_rows(finance_rows).copy()
    columns = ["status", "transactions", "revenue", "meaning"]
    if rows.empty:
        return pd.DataFrame(columns=columns)
    revenue = pd.to_numeric(rows.get("revenue", pd.Series(0, index=rows.index)), errors="coerce").fillna(0)
    chatter = rows.get("chatter", pd.Series("", index=rows.index)).fillna("").astype(str).str.strip()
    team = rows.get("team", pd.Series("", index=rows.index)).fillna("").astype(str).str.strip()
    flow_rate = pd.to_numeric(rows.get("flow_chatter_commission_pct", pd.Series(pd.NA, index=rows.index)), errors="coerce")
    missing_chatter = chatter.eq("") | chatter.str.casefold().isin({"unknown", "none", "nan", "unassigned"})
    assigned = ~missing_chatter
    groups = [
        ("Payable: chatter, team, and Flow rate", assigned & team.ne("") & flow_rate.notna(), "Used in the Dutch or English Flow payout calculation."),
        ("Payable: team assignment missing", assigned & team.eq(""), "A chatter is known, but Flow has no effective team assignment for this date."),
        ("Payable: Flow rate missing", assigned & flow_rate.isna(), "A chatter is known; Gaze used its legacy plan until a Flow rate is recorded."),
        ("Not payable: chatter attribution missing", missing_chatter, "Revenue is retained in finance totals but excluded from chatter commission until Flow assigns a chatter."),
    ]
    result = []
    for status, mask, meaning in groups:
        result.append({"status": status, "transactions": int(mask.sum()), "revenue": float(revenue[mask].sum()), "meaning": meaning})
    return pd.DataFrame(result, columns=columns)


def management_allocation_breakdown(finance_rows: pd.DataFrame, finance: dict) -> tuple[dict, pd.DataFrame]:
    """Summarise Flow chat-manager cuts separately from retained company funds."""
    rows = _finance_detail_rows(finance_rows).copy()
    empty = pd.DataFrame(columns=["team", "chat_manager", "manager_cut", "manager_cut_pct", "attributed_revenue"])
    reported_pool = finance.get("net_revenue") if finance.get("net_revenue") is not None else finance.get("reported_flow_net_amount")
    if rows.empty:
        return {"chat_manager_cuts": 0.0, "admin_management_pool": float(reported_pool or 0)}, empty
    revenue = pd.to_numeric(rows.get("revenue", pd.Series(0, index=rows.index)), errors="coerce").fillna(0)
    manager_pct = pd.to_numeric(rows.get("flow_manager_commission_pct", pd.Series(pd.NA, index=rows.index)), errors="coerce")
    team = rows.get("team", pd.Series("", index=rows.index)).fillna("").astype(str).str.strip()
    manager = rows.get("flow_manager_name", pd.Series("", index=rows.index)).fillna("").astype(str).str.strip()
    applicable = manager_pct.notna() & team.ne("")
    working = pd.DataFrame({
        "team": team[applicable],
        "chat_manager": manager[applicable].replace("", "Unassigned manager"),
        "manager_cut": revenue[applicable] * manager_pct[applicable] / 100,
        "attributed_revenue": revenue[applicable],
    })
    if working.empty:
        return {"chat_manager_cuts": 0.0, "admin_management_pool": float(reported_pool or 0)}, empty
    detail = (
        working.groupby(["team", "chat_manager"], dropna=False)
        .agg(manager_cut=("manager_cut", "sum"), attributed_revenue=("attributed_revenue", "sum"))
        .reset_index()
    )
    detail["manager_cut_pct"] = detail.apply(
        lambda row: row["manager_cut"] / row["attributed_revenue"] * 100 if row["attributed_revenue"] else 0.0,
        axis=1,
    )
    detail = detail.sort_values("manager_cut", ascending=False)
    manager_cuts = float(detail["manager_cut"].sum())
    # Flow has no recorded admin-payroll or owner-payout table.  Its net
    # company amount is therefore shown as the available admin/management
    # pool, after the separately recorded manager cuts, never as paid salary.
    available = float(reported_pool or 0) - manager_cuts
    return {"chat_manager_cuts": manager_cuts, "admin_management_pool": available}, detail


def operating_expense_breakdown(settings: dict, start: date, end: date) -> tuple[dict, pd.DataFrame]:
    """Accrue recurring department personnel fees over the selected calendar period."""
    expenses = pd.DataFrame(settings.get("operating_expenses") or [])
    columns = ["department", "monthly_eur", "monthly_usd", "period_eur", "period_usd", "period_eur_reporting"]
    empty = pd.DataFrame(columns=columns)
    if expenses.empty or start > end:
        return {"monthly_eur": 0.0, "monthly_usd": 0.0, "period_eur": 0.0, "period_usd": 0.0, "period_eur_reporting": 0.0}, empty
    for column, fallback in [("department", "Unassigned"), ("person", ""), ("currency", "EUR"), ("monthly_amount", 0.0)]:
        if column not in expenses:
            expenses[column] = fallback
    expenses["currency"] = expenses["currency"].fillna("EUR").astype(str).str.upper().str.strip()
    expenses["monthly_amount"] = pd.to_numeric(expenses["monthly_amount"], errors="coerce").fillna(0.0)
    # Each row is accrued independently so ranges spanning months use each
    # month’s true day count rather than a fixed 30-day assumption.
    def accrued(amount: float) -> float:
        total = 0.0
        cursor = start
        while cursor <= end:
            days_in_month = calendar.monthrange(cursor.year, cursor.month)[1]
            month_end = date(cursor.year, cursor.month, days_in_month)
            included_end = min(end, month_end)
            total += amount * (((included_end - cursor).days + 1) / days_in_month)
            cursor = included_end + timedelta(days=1)
        return total
    expenses["period_amount"] = expenses["monthly_amount"].apply(accrued)
    expenses["monthly_eur"] = expenses["monthly_amount"].where(expenses["currency"].eq("EUR"), 0.0)
    expenses["monthly_usd"] = expenses["monthly_amount"].where(expenses["currency"].eq("USD"), 0.0)
    expenses["period_eur"] = expenses["period_amount"].where(expenses["currency"].eq("EUR"), 0.0)
    expenses["period_usd"] = expenses["period_amount"].where(expenses["currency"].eq("USD"), 0.0)
    try:
        fx_rate = revenue_catcher_rate()
    except Exception:
        fx_rate = 1.0
    expenses["period_eur_reporting"] = expenses["period_eur"] + expenses["period_usd"] / fx_rate
    by_department = expenses.groupby("department", dropna=False)[columns[1:]].sum().reset_index().sort_values("period_eur_reporting", ascending=False)
    summary = {key: float(expenses[key].sum()) for key in columns[1:]}
    return summary, by_department


def commission_plan_table(settings: dict) -> pd.DataFrame:
    plans = pd.DataFrame(settings.get("commission_rules") or [])
    columns = ["name", "platform", "creator", "chatter", "team", "effective_from", "effective_until", "chatter_commission_pct", "salary_per_hour"]
    if plans.empty:
        return pd.DataFrame(columns=columns)
    for column in columns:
        if column not in plans:
            plans[column] = "" if column not in {"chatter_commission_pct", "salary_per_hour"} else 0.0
    return plans[columns].rename(columns={"chatter_commission_pct": "commission_pct"})


def cost_team_name(value: object) -> str:
    """Map stored team labels to the two finance cost groups."""
    team = str(value or "").strip().casefold()
    if team in {"nl", "dutch"} or "dutch" in team:
        return "Dutch"
    if team in {"en", "english"} or "english" in team:
        return "English"
    return ""


def dutch_english_cost_breakdown(finance_rows: pd.DataFrame, all_rows: pd.DataFrame, settings: dict, scheduled_data: pd.DataFrame | None = None) -> pd.DataFrame:
    """Return an explicit Dutch/English cost split for the commission page."""
    _, team_commissions, _ = commission_cost_breakdown(finance_rows, all_rows, settings, scheduled_data)
    commission_by_team = {}
    if not team_commissions.empty:
        working = team_commissions.copy()
        working["cost_team"] = working["team"].map(cost_team_name)
        working = working[working["cost_team"].ne("")]
        if not working.empty:
            commission_by_team = {
                name: values for name, values in working.groupby("cost_team")[["pre_salary_commission", "salary_cost", "post_salary_commission"]].sum().iterrows()
            }

    rows = _finance_detail_rows(finance_rows).copy()
    if not rows.empty:
        rows["cost_team"] = rows.get("team", pd.Series("", index=rows.index)).map(cost_team_name)
    result = []
    for team in ("Dutch", "English"):
        selected = rows[rows["cost_team"].eq(team)] if not rows.empty else pd.DataFrame()
        finance = finance_breakdown(selected, settings)
        commission = commission_by_team.get(team, {})
        pre_salary = float(commission.get("pre_salary_commission", 0.0))
        salary = float(commission.get("salary_cost", 0.0))
        total_payouts = finance.get("total_payouts_costs")
        # A Flow aggregate net amount does not identify which share belongs to
        # non-chatter costs. Keep that cell unavailable instead of treating it
        # as a confirmed zero or crashing the commissions page.
        non_chatter_costs = max(0.0, float(total_payouts) - pre_salary) if total_payouts is not None else None
        result.append({
            "team": team,
            "gross_revenue": finance.get("gross_revenue"),
            "non_chatter_costs": non_chatter_costs,
            "chatter_commission_pre_salary": pre_salary,
            "salary_cost": salary,
            "total_cost_including_salary": non_chatter_costs + pre_salary + salary if non_chatter_costs is not None else None,
            "chatter_commission_post_salary": float(commission.get("post_salary_commission", 0.0)),
        })
    return pd.DataFrame(result)




def _schedule_matched_inactivity_rows(df: pd.DataFrame, rows: pd.DataFrame) -> pd.DataFrame:
    if rows.empty or df.empty or "transaction_type" not in df:
        return rows
    transaction_type = df["transaction_type"].fillna("").astype(str)
    shifts = df[transaction_type.eq("shift_summary")].copy()
    if shifts.empty:
        return rows.iloc[0:0].copy()

    for frame in [rows, shifts]:
        if "chatter_id" not in frame:
            frame["chatter_id"] = ""
        if "chatter" not in frame:
            frame["chatter"] = ""
        if "shift_start" not in frame:
            frame["shift_start"] = pd.NaT
        if "shift_end" not in frame:
            frame["shift_end"] = pd.NaT

    inactivity = rows.copy()
    inactivity["_start"] = pd.to_datetime(inactivity["shift_start"], errors="coerce", utc=True, format="mixed")
    inactivity["_end"] = pd.to_datetime(inactivity["shift_end"], errors="coerce", utc=True, format="mixed")
    inactivity = inactivity[inactivity["_start"].notna()].copy()
    if inactivity.empty:
        return rows.iloc[0:0].copy()
    inactivity["_end"] = inactivity["_end"].fillna(inactivity["_start"])
    inactivity["_match_id"] = inactivity["chatter_id"].fillna("").astype(str).str.strip()
    inactivity["_match_name"] = inactivity["chatter"].fillna("").astype(str).str.strip().str.lower()

    shift_rows = shifts.copy()
    shift_rows["_start"] = pd.to_datetime(shift_rows["shift_start"], errors="coerce", utc=True, format="mixed")
    shift_rows["_end"] = pd.to_datetime(shift_rows["shift_end"], errors="coerce", utc=True, format="mixed")
    if "shift_hours" in shift_rows:
        hours = pd.to_numeric(shift_rows["shift_hours"], errors="coerce")
        estimated_end = shift_rows["_start"] + pd.to_timedelta(hours.fillna(0), unit="h")
        shift_rows["_end"] = shift_rows["_end"].fillna(estimated_end)
    shift_rows = shift_rows[shift_rows["_start"].notna() & shift_rows["_end"].notna()].copy()
    if shift_rows.empty:
        return rows.iloc[0:0].copy()
    shift_rows["_match_id"] = shift_rows["chatter_id"].fillna("").astype(str).str.strip()
    shift_rows["_match_name"] = shift_rows["chatter"].fillna("").astype(str).str.strip().str.lower()

    matched_indexes: set[int] = set()
    scheduled_minutes: dict[int, float] = {}
    for idx, event in inactivity.iterrows():
        if event["_match_id"]:
            candidates = shift_rows[shift_rows["_match_id"].eq(event["_match_id"])]
        else:
            candidates = shift_rows[shift_rows["_match_name"].eq(event["_match_name"])]
        if candidates.empty:
            continue
        overlaps = candidates[(candidates["_start"] <= event["_end"]) & (candidates["_end"] >= event["_start"])]
        if not overlaps.empty:
            matched_indexes.add(idx)
            minutes = 0.0
            for _, shift in overlaps.iterrows():
                overlap_start = max(event["_start"], shift["_start"])
                overlap_end = min(event["_end"], shift["_end"])
                minutes += max(0.0, (overlap_end - overlap_start).total_seconds() / 60)
            reported_minutes = pd.to_numeric(pd.Series([event.get("inactive_minutes")]), errors="coerce").fillna(0).iloc[0]
            scheduled_minutes[idx] = min(float(reported_minutes), minutes) if reported_minutes else minutes

    cleanup_cols = ["_start", "_end", "_match_id", "_match_name"]
    matched = inactivity.loc[sorted(matched_indexes)].copy()
    matched["scheduled_inactive_minutes"] = matched.index.map(lambda idx: scheduled_minutes.get(idx, 0.0))
    return matched.drop(columns=[col for col in cleanup_cols if col in matched], errors="ignore")


def _creator_key(value) -> str:
    return str(value or "").strip().lower()


def _normalise_creator_tier_for_inactivity(value) -> str:
    text = str(value or "").strip().upper()
    if "A" in text:
        return "A"
    if "B" in text:
        return "B"
    if "C" in text:
        return "C"
    return ""


def _creator_tier_maps() -> tuple[dict[str, str], dict[str, str]]:
    tiers = load_postgres_creator_tiers()
    if tiers.empty:
        return {}, {}
    tiers = tiers.copy()
    for column in ["creator_id", "creator", "creator_tier"]:
        if column not in tiers:
            tiers[column] = ""
    tiers["creator_tier"] = tiers["creator_tier"].apply(_normalise_creator_tier_for_inactivity)
    tiers = tiers[tiers["creator_tier"].ne("")].copy()
    tier_rank = {"A": 3, "B": 2, "C": 1}
    tiers["_rank"] = tiers["creator_tier"].map(tier_rank).fillna(0)
    tiers = tiers.sort_values(["_rank", "creator"], ascending=[False, True])
    by_id = {
        str(row["creator_id"]).strip(): row["creator_tier"]
        for _, row in tiers.iterrows()
        if str(row["creator_id"]).strip()
    }
    by_name = {
        _creator_key(row["creator"]): row["creator_tier"]
        for _, row in tiers.iterrows()
        if _creator_key(row["creator"])
    }
    return by_id, by_name


def _revenue_amount_for_model_cost(rows: pd.DataFrame) -> pd.Series:
    if rows.empty:
        return pd.Series(dtype=float)
    transaction_type = rows.get("transaction_type", pd.Series("", index=rows.index)).fillna("").astype(str).str.lower().str.strip()
    revenue = pd.to_numeric(rows.get("revenue", pd.Series(0, index=rows.index)), errors="coerce").fillna(0)
    tips = pd.to_numeric(rows.get("tip_revenue", pd.Series(0, index=rows.index)), errors="coerce").fillna(0)
    messages = pd.to_numeric(rows.get("message_revenue", pd.Series(0, index=rows.index)), errors="coerce").fillna(0)
    amount = pd.Series(0.0, index=rows.index)
    amount.loc[transaction_type.isin(["tip", "tips", "message", "messages"])] = revenue
    amount.loc[transaction_type.eq("shift_summary")] = tips + messages
    return amount


def _local_hour(value) -> int | None:
    parsed = pd.to_datetime(pd.Series([value]), errors="coerce", utc=True, format="mixed").iloc[0]
    if pd.isna(parsed):
        return None
    return int(parsed.tz_convert("Europe/Sarajevo").hour)


def _interval_hour_segments(start, end) -> list[tuple[int, float]]:
    start_ts = pd.to_datetime(pd.Series([start]), errors="coerce", utc=True, format="mixed").iloc[0]
    end_ts = pd.to_datetime(pd.Series([end]), errors="coerce", utc=True, format="mixed").iloc[0]
    if pd.isna(start_ts) or pd.isna(end_ts) or end_ts <= start_ts:
        return []
    segments: list[tuple[int, float]] = []
    cursor = start_ts
    while cursor < end_ts:
        next_hour = cursor.floor("h") + pd.Timedelta(hours=1)
        segment_end = min(next_hour, end_ts)
        hours = max(0.0, (segment_end - cursor).total_seconds() / 3600)
        if hours:
            segments.append((int(cursor.tz_convert("Europe/Sarajevo").hour), hours))
        cursor = segment_end
    return segments


def _reprice_inactivity_money_wasted(df: pd.DataFrame, rows: pd.DataFrame) -> pd.DataFrame:
    if rows.empty:
        return rows
    repriced = rows.copy()
    if "scheduled_inactive_minutes" not in repriced:
        repriced["scheduled_inactive_minutes"] = repriced["inactive_minutes"]
    repriced["scheduled_inactive_minutes"] = pd.to_numeric(repriced["scheduled_inactive_minutes"], errors="coerce").fillna(0)

    transaction_type = df.get("transaction_type", pd.Series("", index=df.index)).fillna("").astype(str).str.lower().str.strip()
    shifts = df[transaction_type.eq("shift_summary")].copy()
    if shifts.empty:
        repriced["inactivity_money_wasted"] = 0.0
        repriced["inactivity_hourly_rate"] = 0.0
        return repriced

    for column in ["creator_id", "creator"]:
        if column not in shifts:
            shifts[column] = ""
    shifts["creator_id"] = shifts["creator_id"].fillna("").astype(str).str.strip()
    shifts["creator_key"] = shifts["creator"].apply(_creator_key)
    shifts["shift_hours"] = pd.to_numeric(shifts.get("shift_hours", pd.Series(0, index=shifts.index)), errors="coerce").fillna(0)

    revenue_rows = model_revenue_source(df)
    if revenue_rows.empty:
        revenue_rows = shifts.copy()
    revenue_rows = revenue_rows.copy()
    for column in ["creator_id", "creator"]:
        if column not in revenue_rows:
            revenue_rows[column] = ""
    revenue_rows["creator_id"] = revenue_rows["creator_id"].fillna("").astype(str).str.strip()
    revenue_rows["creator_key"] = revenue_rows["creator"].apply(_creator_key)
    revenue_rows["cost_revenue"] = _revenue_amount_for_model_cost(revenue_rows)
    revenue_rows["local_hour"] = revenue_rows.get("timestamp", pd.Series("", index=revenue_rows.index)).apply(_local_hour)

    revenue_by_id = revenue_rows[revenue_rows["creator_id"].ne("")].groupby("creator_id")["cost_revenue"].sum().to_dict()
    revenue_by_name = revenue_rows[revenue_rows["creator_key"].ne("")].groupby("creator_key")["cost_revenue"].sum().to_dict()
    hours_by_id = shifts[shifts["creator_id"].ne("")].groupby("creator_id")["shift_hours"].sum().to_dict()
    hours_by_name = shifts[shifts["creator_key"].ne("")].groupby("creator_key")["shift_hours"].sum().to_dict()

    tier_by_id, tier_by_name = _creator_tier_maps()
    creator_rates: list[dict[str, float | str]] = []
    for _, shift in shifts[["creator_id", "creator", "creator_key"]].drop_duplicates().iterrows():
        creator_id = str(shift.get("creator_id") or "").strip()
        creator_key = str(shift.get("creator_key") or "").strip()
        revenue = float(revenue_by_id.get(creator_id, revenue_by_name.get(creator_key, 0.0)))
        hours = float(hours_by_id.get(creator_id, hours_by_name.get(creator_key, 0.0)))
        if hours <= 0:
            continue
        tier = tier_by_id.get(creator_id, tier_by_name.get(creator_key, ""))
        creator_rates.append({
            "creator_id": creator_id,
            "creator_key": creator_key,
            "tier": tier,
            "hourly_rate": max(0.0, revenue / hours),
        })
    rates = pd.DataFrame(creator_rates)
    if rates.empty:
        repriced["inactivity_money_wasted"] = 0.0
        repriced["inactivity_hourly_rate"] = 0.0
        return repriced

    shift_hour_records: list[dict[str, float | int | str]] = []
    for _, shift in shifts.iterrows():
        for local_hour, hours in _interval_hour_segments(shift.get("shift_start"), shift.get("shift_end")):
            shift_hour_records.append({
                "creator_id": str(shift.get("creator_id") or "").strip(),
                "creator_key": str(shift.get("creator_key") or "").strip(),
                "local_hour": local_hour,
                "hours": hours,
            })
    shift_hours_by_hour = pd.DataFrame(shift_hour_records)
    hourly_rates = pd.DataFrame()
    if not shift_hours_by_hour.empty and "local_hour" in revenue_rows:
        hourly_revenue = revenue_rows[revenue_rows["local_hour"].notna()].copy()
        hourly_revenue["local_hour"] = hourly_revenue["local_hour"].astype(int)
        revenue_hour_id = hourly_revenue[hourly_revenue["creator_id"].ne("")].groupby(["creator_id", "local_hour"])["cost_revenue"].sum().reset_index()
        revenue_hour_name = hourly_revenue[hourly_revenue["creator_key"].ne("")].groupby(["creator_key", "local_hour"])["cost_revenue"].sum().reset_index()
        shift_hour_id = shift_hours_by_hour[shift_hours_by_hour["creator_id"].ne("")].groupby(["creator_id", "local_hour"])["hours"].sum().reset_index()
        shift_hour_name = shift_hours_by_hour[shift_hours_by_hour["creator_key"].ne("")].groupby(["creator_key", "local_hour"])["hours"].sum().reset_index()
        id_rates = revenue_hour_id.merge(shift_hour_id, on=["creator_id", "local_hour"], how="inner")
        id_rates["creator_key"] = ""
        name_rates = revenue_hour_name.merge(shift_hour_name, on=["creator_key", "local_hour"], how="inner")
        name_rates["creator_id"] = ""
        hourly_rates = pd.concat([id_rates, name_rates], ignore_index=True)
        if not hourly_rates.empty:
            hourly_rates["hourly_rate"] = hourly_rates.apply(lambda row: float(row["cost_revenue"]) / float(row["hours"]) if float(row["hours"] or 0) else 0.0, axis=1)
            hourly_rates = hourly_rates[hourly_rates["hourly_rate"].ge(0)].copy()

    tier_medians = rates[rates["tier"].ne("")].groupby("tier")["hourly_rate"].median().to_dict() if "tier" in rates else {}
    overall_median = float(rates["hourly_rate"].median()) if not rates.empty else 0.0
    hourly_rates_by_id = {}
    hourly_rates_by_name = {}
    tier_hour_medians = {}
    overall_hour_medians = {}
    if not hourly_rates.empty:
        if "creator_id" in hourly_rates:
            hourly_rates_by_id = {
                (str(row["creator_id"]), int(row["local_hour"])): float(row["hourly_rate"])
                for _, row in hourly_rates.iterrows()
                if str(row["creator_id"])
            }
        if "creator_key" in hourly_rates:
            hourly_rates_by_name = {
                (str(row["creator_key"]), int(row["local_hour"])): float(row["hourly_rate"])
                for _, row in hourly_rates.iterrows()
                if str(row["creator_key"])
            }
        hourly_with_tiers = hourly_rates.copy()
        hourly_with_tiers["tier"] = hourly_with_tiers.apply(
            lambda row: tier_by_id.get(str(row.get("creator_id") or ""), tier_by_name.get(str(row.get("creator_key") or ""), "")),
            axis=1,
        )
        if not hourly_with_tiers.empty:
            tier_hour_medians = hourly_with_tiers[hourly_with_tiers["tier"].ne("")].groupby(["tier", "local_hour"])["hourly_rate"].median().to_dict()
            overall_hour_medians = hourly_with_tiers.groupby("local_hour")["hourly_rate"].median().to_dict()
    tier_caps = {}
    for tier, subset in rates.groupby("tier"):
        if not tier:
            continue
        median = float(subset["hourly_rate"].median())
        q75 = float(subset["hourly_rate"].quantile(0.75))
        tier_caps[tier] = max(q75, median * 2)
    overall_cap = max(float(rates["hourly_rate"].quantile(0.90)), overall_median * 2)

    rate_by_id = {str(row["creator_id"]): float(row["hourly_rate"]) for _, row in rates.iterrows() if str(row["creator_id"])}
    rate_by_name = {str(row["creator_key"]): float(row["hourly_rate"]) for _, row in rates.iterrows() if str(row["creator_key"])}

    def event_rate(event) -> float:
        creator_id = str(event.get("creator_id") or "").strip()
        creator_key = _creator_key(event.get("creator"))
        tier = tier_by_id.get(creator_id, tier_by_name.get(creator_key, ""))
        rate = rate_by_id.get(creator_id, rate_by_name.get(creator_key))
        if rate is None:
            rate = tier_medians.get(tier, overall_median)
        cap = tier_caps.get(tier, overall_cap)
        return max(0.0, min(float(rate), float(cap)))

    def event_hour_rate(event, local_hour: int) -> float:
        creator_id = str(event.get("creator_id") or "").strip()
        creator_key = _creator_key(event.get("creator"))
        tier = tier_by_id.get(creator_id, tier_by_name.get(creator_key, ""))
        rate = hourly_rates_by_id.get((creator_id, local_hour))
        exact_model_hour = rate is not None
        if rate is None:
            rate = hourly_rates_by_name.get((creator_key, local_hour))
            exact_model_hour = rate is not None
        if rate is None:
            rate = tier_hour_medians.get((tier, local_hour))
        if rate is None:
            rate = overall_hour_medians.get(local_hour)
        if rate is None:
            rate = event_rate(event)
        if exact_model_hour:
            return max(0.0, float(rate))
        cap = tier_caps.get(tier, overall_cap)
        return max(0.0, min(float(rate), float(cap)))

    def event_tier(event) -> str:
        creator_id = str(event.get("creator_id") or "").strip()
        creator_key = _creator_key(event.get("creator"))
        return tier_by_id.get(creator_id, tier_by_name.get(creator_key, "")) or "Unassigned"

    repriced["creator_tier"] = repriced.apply(event_tier, axis=1)
    totals = []
    blended_rates = []
    for _, event in repriced.iterrows():
        segments = _interval_hour_segments(event.get("shift_start"), event.get("shift_end"))
        scheduled_hours = float(event.get("scheduled_inactive_minutes") or 0) / 60
        if scheduled_hours and segments:
            raw_segment_hours = sum(hours for _, hours in segments)
            scale = min(1.0, scheduled_hours / raw_segment_hours) if raw_segment_hours else 1.0
            total = sum(hours * scale * event_hour_rate(event, local_hour) for local_hour, hours in segments)
        else:
            total = scheduled_hours * event_rate(event)
        totals.append(total)
        blended_rates.append(total / scheduled_hours if scheduled_hours else 0.0)
    repriced["inactivity_hourly_rate"] = blended_rates
    repriced["inactivity_money_wasted"] = totals
    repriced["inactive_minutes"] = repriced["scheduled_inactive_minutes"]
    return repriced


def postgres_inactivity_rows(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty or "transaction_type" not in df:
        return pd.DataFrame()
    rows = df[df["transaction_type"].eq("inactivity")].copy()
    if rows.empty:
        return rows
    rows = _schedule_matched_inactivity_rows(df, rows)
    if rows.empty:
        return rows
    for col in ["inactive_minutes", "inactivity_money_wasted", "peak_unread_chats"]:
        if col in rows:
            rows[col] = pd.to_numeric(rows[col], errors="coerce").fillna(0)
        else:
            rows[col] = 0
    for col in ["chatter", "creator", "platform", "team"]:
        if col not in rows:
            rows[col] = "Unknown"
        rows[col] = rows[col].fillna("Unknown").replace("", "Unknown")
    return _reprice_inactivity_money_wasted(df, rows)


def assigned_inactivity_rows(rows: pd.DataFrame) -> pd.DataFrame:
    if rows.empty or "chatter" not in rows:
        return pd.DataFrame()
    chatter = rows["chatter"].fillna("").astype(str).str.strip()
    return rows[chatter.ne("") & chatter.str.lower().ne("unknown")].copy()


def postgres_inactivity_summary(rows: pd.DataFrame) -> dict:
    rows = assigned_inactivity_rows(rows)
    if rows.empty:
        return {
            "events": 0,
            "total_hours": 0.0,
            "money_wasted": 0.0,
            "peak_unread": 0,
            "worst_name": "n/a",
            "worst_money": 0.0,
        }
    grouped = postgres_inactivity_table(rows)
    worst = grouped.sort_values("money_wasted", ascending=False).head(1)
    worst_row = worst.iloc[0] if not worst.empty else None
    return {
        "events": int(len(rows)),
        "total_hours": float(rows["inactive_minutes"].sum() / 60),
        "money_wasted": float(rows["inactivity_money_wasted"].sum()),
        "peak_unread": int(rows["peak_unread_chats"].max()) if not rows.empty else 0,
        "worst_name": str(worst_row["chatter"]) if worst_row is not None else "n/a",
        "worst_money": float(worst_row["money_wasted"]) if worst_row is not None else 0.0,
    }


def postgres_inactivity_table(rows: pd.DataFrame) -> pd.DataFrame:
    rows = assigned_inactivity_rows(rows)
    if rows.empty:
        return pd.DataFrame()
    grouped = rows.groupby("chatter", dropna=False).agg(
        events=("transaction_key", "count"),
        creators=("creator", pd.Series.nunique),
        platforms=("platform", lambda values: ", ".join(sorted({str(v) for v in values if str(v) and str(v) != "Unknown"})) or "Unknown"),
        peak_unread=("peak_unread_chats", "max"),
        total_hours=("inactive_minutes", lambda values: float(values.sum()) / 60),
        max_hours=("inactive_minutes", lambda values: float(values.max()) / 60),
        money_wasted=("inactivity_money_wasted", "sum"),
    ).reset_index()
    grouped["avg_cost_per_hour"] = grouped.apply(lambda row: row["money_wasted"] / row["total_hours"] if row["total_hours"] else 0, axis=1)
    return grouped.sort_values("money_wasted", ascending=False).reset_index(drop=True)


def postgres_inactivity_tier_table(rows: pd.DataFrame, all_data: pd.DataFrame | None = None) -> pd.DataFrame:
    rows = assigned_inactivity_rows(rows)
    if rows.empty:
        return pd.DataFrame()
    rows = rows.copy()
    if "creator_tier" not in rows:
        rows["creator_tier"] = "Unassigned"
    rows["creator_tier"] = rows["creator_tier"].fillna("").replace("", "Unassigned")
    rows["scheduled_hours"] = pd.to_numeric(rows.get("inactive_minutes", pd.Series(0, index=rows.index)), errors="coerce").fillna(0) / 60
    rows["money_wasted"] = pd.to_numeric(rows.get("inactivity_money_wasted", pd.Series(0, index=rows.index)), errors="coerce").fillna(0)
    grouped = rows.groupby("creator_tier", dropna=False).agg(
        events=("transaction_key", "count"),
        models=("creator", pd.Series.nunique),
        scheduled_hours=("scheduled_hours", "sum"),
        money_wasted=("money_wasted", "sum"),
    ).reset_index()
    grouped["shift_hours"] = 0.0
    if all_data is not None and not all_data.empty and "transaction_type" in all_data:
        tier_by_id, tier_by_name = _creator_tier_maps()
        transaction_type = all_data["transaction_type"].fillna("").astype(str).str.lower().str.strip()
        shifts = all_data[transaction_type.eq("shift_summary")].copy()
        if not shifts.empty:
            for column in ["creator_id", "creator", "shift_hours"]:
                if column not in shifts:
                    shifts[column] = ""
            shifts["creator_id"] = shifts["creator_id"].fillna("").astype(str).str.strip()
            shifts["creator_key"] = shifts["creator"].apply(_creator_key)
            shifts["creator_tier"] = shifts.apply(
                lambda row: tier_by_id.get(str(row.get("creator_id") or "").strip(), tier_by_name.get(str(row.get("creator_key") or ""), "")) or "Unassigned",
                axis=1,
            )
            shifts["shift_hours"] = pd.to_numeric(shifts["shift_hours"], errors="coerce").fillna(0)
            shift_totals = shifts.groupby("creator_tier")["shift_hours"].sum().to_dict()
            grouped["shift_hours"] = grouped["creator_tier"].map(shift_totals).fillna(0.0)
    grouped["inactivity_pct"] = grouped.apply(lambda row: row["scheduled_hours"] / row["shift_hours"] * 100 if row["shift_hours"] else 0, axis=1)
    grouped["avg_cost_per_hour"] = grouped.apply(lambda row: row["money_wasted"] / row["scheduled_hours"] if row["scheduled_hours"] else 0, axis=1)
    order = {"A": 0, "B": 1, "C": 2, "Unassigned": 3}
    grouped["_order"] = grouped["creator_tier"].map(order).fillna(9)
    return grouped.sort_values(["_order", "creator_tier"]).drop(columns="_order").reset_index(drop=True)


def inactivity_context_data(ctx: dict, start: date, end: date) -> pd.DataFrame:
    filters = dict(ctx.get("filters") or {})
    filters.pop("transaction_type", None)
    return filter_period(ctx["all_data"], start, end, filters)


def period_label(start: date, end: date) -> str:
    if start == end:
        return start.strftime("%d %b %Y")
    return f"{start.strftime('%d %b %Y')} - {end.strftime('%d %b %Y')}"


def comparison_revenue_total(frame) -> float | None:
    if frame is None or getattr(frame, "empty", True) or "revenue" not in frame:
        return None
    revenue = pd.to_numeric(frame["revenue"], errors="coerce").fillna(0)
    return float(revenue.sum())


def fmt_signed_money(value) -> str:
    if value is None or pd.isna(value):
        return "n/a"
    amount = float(value)
    sign = "+" if amount > 0 else "-" if amount < 0 else ""
    return f"{sign}\u20ac{abs(amount):,.2f}"


def comparison_context_html(ctx: dict) -> str:
    compare_label = html.escape(ctx.get("compare_label", "Previous period"))
    selected = html.escape(period_label(ctx["start"], ctx["end"]))
    compared = html.escape(period_label(ctx["comp_start"], ctx["comp_end"]))
    current_total = comparison_revenue_total(ctx.get("current"))
    previous_total = comparison_revenue_total(ctx.get("previous"))
    metric_html = ""
    note = "This page uses the selected range and comparison range shown above."

    if current_total is not None and previous_total is not None:
        delta = current_total - previous_total
        delta_pct = safe_pct_change(current_total, previous_total)
        if delta > 0:
            delta_class = "comparison-context__delta--positive"
        elif delta < 0:
            delta_class = "comparison-context__delta--negative"
        else:
            delta_class = "comparison-context__delta--neutral"
        metric_html = f"""
      <span class="comparison-context__metric">
        <span class="comparison-context__label">Selected revenue</span>
        <strong>{fmt_money(current_total)}</strong>
      </span>
      <span class="comparison-context__metric">
        <span class="comparison-context__label">Compared revenue</span>
        <strong>{fmt_money(previous_total)}</strong>
      </span>
      <span class="comparison-context__metric">
        <span class="comparison-context__label">Change</span>
        <strong class="{delta_class}">{fmt_signed_money(delta)} · {fmt_pct(delta_pct)}</strong>
      </span>
        """
        note = "% \u0394 cards and change columns use this same comparison."

    return f"""
    <div class="comparison-context">
      <span class="comparison-context__metric">
        <span class="comparison-context__label">Selected range</span>
        <strong>{selected}</strong>
      </span>
      <span class="comparison-context__metric">
        <span class="comparison-context__label">Compared with</span>
        <strong>{compare_label} · {compared}</strong>
      </span>
      {metric_html}
      <span class="comparison-context__note">{html.escape(note)}</span>
    </div>
    """


def filter_bar(ctx: dict, include_transaction_type: bool = True) -> str:
    options = date_range_options_html(ctx["range_label"], ctx.get("settings"))
    compares = ["Previous period", "Previous week", "Previous month"]
    compare_options = "".join(f'<option {"selected" if r == ctx.get("compare_label", "Previous period") else ""}>{r}</option>' for r in compares)
    filter_inputs = []
    data = ctx["all_data"]
    fields = ["platform", "team", "creator", "chatter"]
    if include_transaction_type:
        fields.append("transaction_type")
    for field in fields:
        if field == "transaction_type":
            values = selectable_transaction_types(data)
        else:
            values = [] if data.empty or field not in data else sorted([str(v) for v in data[field].dropna().unique()])
            if field == "team":
                lower_values = {v.lower() for v in values}
                for required in ["Dutch", "English"]:
                    if required.lower() not in lower_values:
                        values.append(required)
                values = sorted(values, key=lambda v: v.lower())
        selected = ctx["filters"].get(field)
        selected_values = selected if isinstance(selected, list) else [selected]
        opts = '<option value="">All</option>' + "".join(f'<option value="{html.escape(v)}" {"selected" if v in selected_values else ""}>{html.escape(v)}</option>' for v in values)
        multiple = " multiple" if field in {"platform", "team", "creator", "chatter", "transaction_type"} else ""
        help_text = ""
        filter_inputs.append(f'<label>{field.replace("_", " ").title()}<select name="{field}"{multiple}>{opts}</select>{help_text}</label>')
    return f"""
    <form class="filters" method="get">
      <label>Date Range<select name="range">{options}</select></label>
      <label>Start<input type="date" name="start" value="{ctx['start']}"></label>
      <label>End<input type="date" name="end" value="{ctx['end']}"></label>
      <label>Compare<select name="compare">{compare_options}</select></label>
      <label>Display Currency<select name="currency"><option value="EUR" {"selected" if ctx.get("display_currency") == "EUR" else ""}>EUR</option><option value="USD" {"selected" if ctx.get("display_currency") == "USD" else ""}>USD</option></select></label>
      {''.join(filter_inputs)}
      <button type="submit">Apply</button>
    </form>
    {comparison_context_html(ctx)}
    """


def date_selector_context(params: dict, default_label: str = "This month", default_start: date | None = None, default_end: date | None = None) -> dict:
    settings = load_settings()
    label = params.get("range", [default_label])[0]
    compare_label = params.get("compare", ["Previous period"])[0]
    start_raw = params.get("start", [""])[0]
    end_raw = params.get("end", [""])[0]
    if start_raw and end_raw:
        try:
            start, end = date.fromisoformat(start_raw), date.fromisoformat(end_raw)
        except ValueError:
            start, end = date_range_for(label, week_start=settings.get("reporting_week_start", "Friday"))
    elif label == "Custom" and default_start and default_end:
        start, end = default_start, default_end
    else:
        start, end = date_range_for(label, week_start=settings.get("reporting_week_start", "Friday"))
    comp_start, comp_end = comparison_range(start, end, compare_label)
    return {
        "range_label": label,
        "compare_label": compare_label,
        "start": start,
        "end": end,
        "comp_start": comp_start,
        "comp_end": comp_end,
    }


def report_context(params: dict, kind: str) -> dict:
    page_params = dict(params)
    if "range" not in page_params:
        page_params["range"] = ["Last week" if kind == "weekly" else "This month"]
    elif kind == "weekly" and page_params.get("range", [""])[0] == "This week" and "start" not in page_params and "end" not in page_params:
        page_params["range"] = ["Last week"]
    return current_context(page_params)


def looker_date_bar(ctx: dict) -> str:
    options = date_range_options_html(ctx["range_label"], ctx.get("settings"))
    compares = ["Previous period", "Previous week", "Previous month"]
    compare_options = "".join(f'<option {"selected" if r == ctx.get("compare_label", "Previous period") else ""}>{r}</option>' for r in compares)
    return f"""
    <form class="filters looker-filters" method="get">
      <label>Date Range<select name="range">{options}</select></label>
      <label>Start<input type="date" name="start" value="{ctx['start']}"></label>
      <label>End<input type="date" name="end" value="{ctx['end']}"></label>
      <label>Compare<select name="compare">{compare_options}</select></label>
      <button type="submit">Apply</button>
    </form>
    {comparison_context_html(ctx)}
    """


TICKET_STATUS_COLORS = {
    "Completed": "#f4d46f",
    "In progress": "#d2a746",
    "Declined": "#b2853a",
    "New": "#8e662a",
    "Cancelled": "#5d401d",
    "Unknown": "#7b6a47",
}


TICKET_STATUS_GRADIENTS = {
    "Completed": ("#fff0a9", "#f4d46f", "#b8872d"),
    "In progress": ("#e5bf64", "#d2a746", "#8e662a"),
    "Declined": ("#c79a4d", "#a77832", "#68491f"),
    "New": ("#aa7a35", "#80591f", "#3c2913"),
    "Cancelled": ("#7a5528", "#4e3417", "#1b1209"),
    "Unknown": ("#a49468", "#7b6a47", "#312616"),
}


def ticket_status_gradient(status: str) -> str:
    top, middle, bottom = TICKET_STATUS_GRADIENTS.get(status, ("#e5bf64", "#9f7531", "#342413"))
    return f"linear-gradient(180deg, {top} 0%, {middle} 48%, {bottom} 100%)"


def ticket_department_chart(rows: pd.DataFrame) -> str:
    if rows.empty:
        return '<div class="empty">No department rows for the selected dates.</div>'
    departments = list(rows["Department"].dropna().unique())
    statuses = [status for status in TICKET_STATUS_COLORS if status in set(rows["Status"])]
    max_total = max(1, int(rows.groupby("Department")["tickets"].sum().max()))
    bars = []
    for department in departments:
        subset = rows[rows["Department"] == department]
        total = int(subset["tickets"].sum())
        segments = []
        labels = []
        for status in statuses:
            count = int(subset.loc[subset["Status"] == status, "tickets"].sum())
            if not count:
                continue
            height = max(8, count / max_total * 150)
            text_color = "#100d08" if status in {"Completed", "In progress", "Declined"} else "#fff4cf"
            segments.append(f"<span class='stack-segment' style='height:{height:.1f}px;background:{ticket_status_gradient(status)};color:{text_color}' title='{html.escape(status)}: {count}'>{count}</span>")
            labels.append(status)
        bars.append(
            "<div class='stack-bar-wrap'>"
            f"<div class='stack-bar'>{''.join(segments)}</div>"
            f"<span class='stack-label'>{html.escape(str(department))}</span>"
            f"<small>{total}</small>"
            "</div>"
        )
    legend = "".join(f"<span><i style='background:{ticket_status_gradient(status)}'></i>{html.escape(status)}</span>" for status in TICKET_STATUS_COLORS if status in statuses)
    return f"<div class='ticket-legend'>{legend}</div><div class='stacked-chart'>{''.join(bars)}</div>"


def ticket_status_donut(rows: pd.DataFrame) -> str:
    if rows.empty:
        return '<div class="empty">No status rows for the selected dates.</div>'
    total = max(1, int(rows["tickets"].sum()))
    angle = 0.0
    gradient_parts = []
    legend = []
    for _, row in rows.iterrows():
        status = str(row["status"])
        count = int(row["tickets"])
        color = TICKET_STATUS_COLORS.get(status, "#9b8b62")
        next_angle = angle + count / total * 360
        gradient_parts.append(f"{color} {angle:.1f}deg {next_angle:.1f}deg")
        legend.append(f"<span><i style='background:{ticket_status_gradient(status)}'></i>{html.escape(status)} <strong>{count}</strong></span>")
        angle = next_angle
    return (
        "<div class='donut-layout'>"
        f"<div class='donut-chart' style='background:conic-gradient({', '.join(gradient_parts)})'><span>{total}</span></div>"
        f"<div class='ticket-legend vertical'>{''.join(legend)}</div>"
        "</div>"
    )


def safe_sum(df: pd.DataFrame, column: str) -> float:
    if df is None or df.empty or column not in df:
        return 0.0
    return float(pd.to_numeric(df[column], errors="coerce").fillna(0).sum())


def first_value(df: pd.DataFrame, label_col: str, value_col: str, default: str = "n/a") -> str:
    if df is None or df.empty or label_col not in df or value_col not in df:
        return default
    ranked = df.copy()
    ranked[value_col] = pd.to_numeric(ranked[value_col], errors="coerce").fillna(0)
    ranked = ranked.sort_values(value_col, ascending=False)
    return str(ranked.iloc[0][label_col]) if not ranked.empty else default


def fmt_compact(value: float, prefix: str = "", suffix: str = "") -> str:
    value = float(value or 0)
    abs_value = abs(value)
    if abs_value >= 1_000_000:
        number = f"{value / 1_000_000:.1f}M"
    elif abs_value >= 1_000:
        number = f"{value / 1_000:.1f}K"
    elif abs_value == int(abs_value):
        number = f"{value:,.0f}"
    else:
        number = f"{value:,.1f}"
    return f"{prefix}{number}{suffix}"


def delta_markup(current: float, previous: float) -> tuple[str, str]:
    if previous is None or float(previous or 0) == 0:
        return "no prior range", "delta-neutral"
    change = (float(current or 0) - float(previous)) / float(previous) * 100
    cls = "delta-positive" if change > 0 else "delta-negative" if change < 0 else "delta-neutral"
    return f"{fmt_pct(change)} vs previous range", cls


def c_metric_card(label: str, value: str, note: str, href: str, delta_class: str = "delta-neutral") -> str:
    return (
        f"<a class='c-metric-card' href='{html.escape(href)}'>"
        f"<span>{html.escape(label)}</span>"
        f"<strong>{html.escape(value)}</strong>"
        f"<em class='{html.escape(delta_class)}'>{html.escape(note)}</em>"
        "</a>"
    )


def c_horizontal_chart(rows: pd.DataFrame, label_col: str, value_col: str, href: str, formatter=None, limit: int = 6) -> str:
    if rows is None or rows.empty or label_col not in rows or value_col not in rows:
        return '<div class="empty">No chart data for this date range.</div>'
    chart_rows = rows.copy()
    chart_rows[value_col] = pd.to_numeric(chart_rows[value_col], errors="coerce").fillna(0)
    chart_rows = chart_rows.sort_values(value_col, ascending=False).head(limit)
    max_value = max(1.0, float(chart_rows[value_col].max()))
    items = []
    for _, row in chart_rows.iterrows():
        label = str(row[label_col])
        value = float(row[value_col])
        width = max(4.0, value / max_value * 100)
        shown = formatter(value) if formatter else fmt_compact(value)
        items.append(
            f"<a class='c-bar-row' href='{html.escape(href)}' title='{html.escape(label)}: {html.escape(shown)}'>"
            f"<span>{html.escape(label)}</span>"
            f"<i><b style='width:{width:.1f}%'></b></i>"
            f"<strong>{html.escape(shown)}</strong>"
            "</a>"
        )
    return "<div class='c-horizontal-chart'>" + "".join(items) + "</div>"


def c_column_chart(rows: pd.DataFrame, label_col: str, value_col: str, href: str, formatter=None, limit: int = 7) -> str:
    if rows is None or rows.empty or label_col not in rows or value_col not in rows:
        return '<div class="empty">No chart data for this date range.</div>'
    chart_rows = rows.copy()
    chart_rows[value_col] = pd.to_numeric(chart_rows[value_col], errors="coerce").fillna(0)
    chart_rows = chart_rows.sort_values(value_col, ascending=False).head(limit)
    max_value = max(1.0, float(chart_rows[value_col].max()))
    bars = []
    for _, row in chart_rows.iterrows():
        label = str(row[label_col])
        value = float(row[value_col])
        height = max(9.0, value / max_value * 100)
        shown = formatter(value) if formatter else fmt_compact(value)
        bars.append(
            f"<a class='c-column' href='{html.escape(href)}' title='{html.escape(label)}: {html.escape(shown)}'>"
            f"<i style='height:{height:.1f}%'></i>"
            f"<strong>{html.escape(shown)}</strong>"
            f"<span>{html.escape(label)}</span>"
            "</a>"
        )
    return "<div class='c-column-chart'>" + "".join(bars) + "</div>"


def c_donut_chart(rows: pd.DataFrame, label_col: str, value_col: str, href: str) -> str:
    if rows is None or rows.empty or label_col not in rows or value_col not in rows:
        return '<div class="empty">No chart data for this date range.</div>'
    total = max(1.0, safe_sum(rows, value_col))
    angle = 0.0
    gradients = []
    legend = []
    palette = ["#f4d46f", "#d2a746", "#b2853a", "#8e662a", "#6f5023", "#4d371a"]
    for idx, (_, row) in enumerate(rows.iterrows()):
        label = str(row[label_col])
        value = float(pd.to_numeric(pd.Series([row[value_col]]), errors="coerce").fillna(0).iloc[0])
        if value <= 0:
            continue
        color = TICKET_STATUS_COLORS.get(label, palette[idx % len(palette)])
        next_angle = angle + value / total * 360
        gradients.append(f"{color} {angle:.1f}deg {next_angle:.1f}deg")
        pct = value / total * 100
        swatch = ticket_status_gradient(label) if label in TICKET_STATUS_GRADIENTS else f"linear-gradient(180deg, #fff0a9, {color} 58%, #3a2814)"
        legend.append(f"<a href='{html.escape(href)}'><i style='background:{swatch}'></i><span>{html.escape(label)}</span><strong>{pct:.1f}%</strong></a>")
        angle = next_angle
    if not gradients:
        return '<div class="empty">No chart data for this date range.</div>'
    return (
        "<div class='c-donut-wrap'>"
        f"<a class='c-donut' href='{html.escape(href)}' title='Click to open details' style='background:conic-gradient({', '.join(gradients)})'><span>{fmt_compact(total)}</span></a>"
        f"<div class='c-donut-legend'>{''.join(legend)}</div>"
        "</div>"
    )


def tier_roster(assignments: pd.DataFrame) -> str:
    if assignments is None or assignments.empty or "tier" not in assignments or "model" not in assignments:
        return "<div class='tier-roster empty'>No tier assignments for this date range.</div>"
    rows = assignments.copy()
    if "tier_revenue" in rows:
        rows["tier_revenue"] = pd.to_numeric(rows["tier_revenue"], errors="coerce").fillna(0)
        rows = rows.sort_values(["tier", "tier_revenue", "model"], ascending=[True, False, True])
    cards = []
    for tier in ["Tier A", "Tier B", "Tier C"]:
        tier_rows = rows[rows["tier"].astype(str).eq(tier)]
        names = [
            f"<li>{html.escape(str(row['model']))}</li>"
            for _, row in tier_rows.iterrows()
            if str(row["model"]).strip()
        ]
        if not names:
            names = ["<li class='muted'>No models</li>"]
        cards.append(
            "<div class='tier-roster-card'>"
            f"<h3>{html.escape(tier)}</h3>"
            f"<ol>{''.join(names)}</ol>"
            "</div>"
        )
    return "<div class='tier-roster'>" + "".join(cards) + "</div>"


def c_strength_requirement_chart(rows: pd.DataFrame) -> str:
    if rows is None or rows.empty:
        return '<div class="empty">No weekly strength rows yet.</div>'
    chart_rows = rows.copy()
    for column in ["team_strength", "model_requirement", "gap"]:
        chart_rows[column] = pd.to_numeric(chart_rows[column], errors="coerce").fillna(0)
    max_value = max(1.0, float(chart_rows[["team_strength", "model_requirement"]].max().max()))
    items = []
    for _, row in chart_rows.iterrows():
        strength = float(row["team_strength"])
        requirement = float(row["model_requirement"])
        gap = float(row["gap"])
        strength_height = max(5.0, strength / max_value * 100) if strength > 0 else 0
        requirement_height = max(5.0, requirement / max_value * 100) if requirement > 0 else 0
        requirement_bar = (
            f"<i class='requirement-shadow' style='height:{requirement_height:.1f}%'><em>{fmt_compact(requirement)}</em></i>"
            if requirement > 0
            else ""
        )
        gap_class = "delta-positive" if gap >= 0 else "delta-negative"
        date_label = f"{row['start'].strftime('%b %d')} - {row['end'].strftime('%b %d')}"
        items.append(
            "<div class='strength-week'>"
            f"<div class='strength-bars' title='{html.escape(str(row['week']))}: strength {fmt_compact(strength)}, requirement {fmt_compact(requirement)}'>"
            f"{requirement_bar}"
            f"<i class='strength-main' style='height:{strength_height:.1f}%'><strong>{fmt_compact(strength)}</strong></i>"
            "</div>"
            f"<span>{html.escape(str(row['week']))}</span>"
            f"<small>{html.escape(date_label)}</small>"
            f"<b class='{gap_class}'>{html.escape(fmt_compact(gap, prefix='+' if gap >= 0 else ''))}</b>"
            "</div>"
        )
    legend = (
        "<div class='strength-legend'>"
        "<span><i class='legend-strength'></i>Team strength</span>"
        "<span><i class='legend-requirement'></i>Model requirement</span>"
        "</div>"
    )
    return legend + "<div class='strength-chart'>" + "".join(items) + "</div>"


def c_page_header(title: str, ctx: dict, kicker: str = "MD Agency") -> str:
    return (
        "<section class='c-suite-header'>"
        "<img class='md-suite-mark' src='/static/md-logo-cropped.png' alt='MD Agency'>"
        "<div>"
        f"<span>{html.escape(kicker)}</span>"
        f"<h2>{html.escape(title)}</h2>"
        f"<em>{html.escape(str(ctx['start']))} - {html.escape(str(ctx['end']))}</em>"
        "</div>"
        "</section>"
    )


def c_stat_strip(cards: list[tuple[str, str, str]]) -> str:
    tiles = []
    for label, value, note in cards:
        tiles.append(
            "<div class='c-stat-tile'>"
            f"<span>{html.escape(str(label))}</span>"
            f"<strong>{html.escape(str(value))}</strong>"
            f"<em>{html.escape(str(note))}</em>"
            "</div>"
        )
    return "<section class='c-stat-strip'>" + "".join(tiles) + "</section>"


def raw_numeric_total(df: pd.DataFrame, candidates: list[str]) -> float:
    if df is None or df.empty:
        return 0.0
    for column in candidates:
        if column in df:
            clean = df[column].astype(str).str.replace(r"[^0-9.\-]", "", regex=True).replace("", "0")
            return float(pd.to_numeric(clean, errors="coerce").fillna(0).sum())
    return 0.0


def compact_axis_label(label) -> str:
    parsed = pd.to_datetime(pd.Series([label]), errors="coerce").iloc[0]
    if not pd.isna(parsed):
        return f"{parsed.strftime('%b')} {parsed.day}"
    text = str(label)
    return text[:12] + "..." if len(text) > 15 else text


def c_line_chart(points: list[tuple[str, float]], href: str = "#") -> str:
    if not points:
        return '<div class="empty">No line chart data for this range.</div>'
    width, height = 620, 220
    pad_x, pad_y = 42, 28
    values = [float(value or 0) for _, value in points]
    max_value = max(max(values), 1.0)
    step = (width - pad_x * 2) / max(len(points) - 1, 1)
    coords = []
    dots = []
    labels = []
    max_ticks = min(6, len(points))
    tick_indices = {round(i * (len(points) - 1) / max(max_ticks - 1, 1)) for i in range(max_ticks)}
    for index, (label, value) in enumerate(points):
        x = pad_x + step * index
        y = height - pad_y - (float(value or 0) / max_value * (height - pad_y * 2))
        coords.append(f"{x:.1f},{y:.1f}")
        dots.append(f"<circle cx='{x:.1f}' cy='{y:.1f}' r='4'><title>{html.escape(str(label))}: {value:g}</title></circle>")
        if index in tick_indices:
            anchor = "start" if index == 0 else "end" if index == len(points) - 1 else "middle"
            labels.append(f"<text x='{x:.1f}' y='{height - 7}' text-anchor='{anchor}'>{html.escape(compact_axis_label(label))}</text>")
    grid = "".join(f"<line x1='{pad_x}' x2='{width - pad_x}' y1='{pad_y + i * 38}' y2='{pad_y + i * 38}' />" for i in range(5))
    return (
        f"<a class='c-line-chart' href='{html.escape(href)}'>"
        f"<svg viewBox='0 0 {width} {height}' role='img' aria-label='Line chart'>"
        "<defs><linearGradient id='gaze-line-gradient' x1='0%' y1='0%' x2='100%' y2='0%'><stop offset='0%' stop-color='#f2d36b'/><stop offset='72%' stop-color='#c89b3c'/><stop offset='100%' stop-color='#080705'/></linearGradient></defs>"
        f"<g class='c-line-grid'>{grid}</g>"
        f"<polyline points='{' '.join(coords)}'></polyline>"
        f"<g class='c-line-dots'>{''.join(dots)}</g>"
        f"<g class='c-line-labels'>{''.join(labels)}</g>"
        "</svg>"
        "</a>"
    )


def c_dashboard_page(title: str, ctx: dict, body: str, kicker: str = "MD Agency", show_header: bool = False) -> bytes:
    content = looker_date_bar(ctx)
    content += "<div class='c-suite-page'>"
    if show_header:
        content += c_page_header(title, ctx, kicker)
    content += body
    content += "</div>"
    return page_shell(title, content)


def profile_avatar_html(profile: dict, class_name: str = "profile-avatar") -> str:
    photo_url = str(profile.get("photo_url") or "").strip()
    name = str(profile.get("name") or "User")
    if photo_url:
        return f'<span class="{class_name} image-avatar"><img src="{html.escape(photo_url)}" alt="{html.escape(name)}"></span>'
    return f'<span class="{class_name}">{html.escape(name[:1].upper())}</span>'


def insight_item(text: str, tone: str = "neutral") -> str:
    return f"<li class='insight-{html.escape(tone)}'>{html.escape(text)}</li>"


def page_shell(title: str, content: str, params: dict | None = None) -> bytes:
    template = TEMPLATE_PATH.read_text(encoding="utf-8")
    asset_version = str(int(max(
        (STATIC_DIR / "styles.css").stat().st_mtime,
        (STATIC_DIR / "app.js").stat().st_mtime,
    )))
    role = REQUEST_ROLE.get()
    profile = person_profile()
    body_class = "login-mode" if title == "Login" else ("viewer-mode" if role == "viewer" else "admin-mode")
    viewer_note = "<span class='access-pill'>Shared view</span>" if role == "viewer" else ""
    c_hub_nav = ""
    if can_see_c_hub(role):
        c_hub_links = ""
        for group_label, pages in c_hub_grouped_pages_for_role(role):
            if group_label:
                c_hub_links += f"<span class='nav-subheading'>{html.escape(group_label)}</span>"
            c_hub_links += "".join(f'<a href="{path}">{html.escape(label)}</a>' for path, label in pages)
        c_hub_nav = f"""
      <div class="nav-group" data-nav-group="c-hub">
        <button type="button" class="nav-section nav-toggle" aria-expanded="false">C Hub<span></span></button>
        <div class="nav-items">
          {c_hub_links}
        </div>
      </div>
        """
    hub_links = "".join(f'<a href="{path}">{html.escape(label)}</a>' for path, label in hub_pages_for_role(role))
    hub_group = ""
    if hub_links:
        hub_group = f"""
      <div class="nav-group" data-nav-group="looker">
        <button type="button" class="nav-section nav-toggle" aria-expanded="false">Hub<span></span></button>
        <div class="nav-items">
          {hub_links}
        </div>
      </div>
    """
    hub_nav = hub_group
    core_links = "".join(f'<a href="{path}">{html.escape(label)}</a>' for path, label in core_pages_for_role(role))
    reports_links = "".join(f'<a href="{path}">{html.escape(label)}</a>' for path, label in report_pages_for_role(role))
    core_group = f"""
      <div class="nav-group" data-nav-group="core">
        <button type="button" class="nav-section nav-toggle" aria-expanded="false">Core<span></span></button>
        <div class="nav-items">
          {core_links}
        </div>
      </div>
    """ if core_links else ""
    reports_group = f"""
      <div class="nav-group" data-nav-group="reports">
        <button type="button" class="nav-section nav-toggle" aria-expanded="false">Reports<span></span></button>
        <div class="nav-items">
          {reports_links}
        </div>
      </div>
    """ if reports_links else ""
    admin_extra = "" if role == "viewer" else """
      <div class="nav-group" data-nav-group="admin">
        <button type="button" class="nav-section nav-toggle" aria-expanded="false">Admin<span></span></button>
        <div class="nav-items">
          <a href="/data-quality">Data Quality</a>
          <a href="/data-sources">Data Sources</a>
          <a href="/settings">Settings</a>
          <a href="/edit-site">Edit Site</a>
          <a href="/people-access">People Access</a>
          <a href="/metric-definitions">Metric Definitions</a>
          <a href="/inactivity-computation">Inactivity Computation</a>
          <a href="/architecture">Architecture</a>
        </div>
      </div>
    """
    admin_nav = c_hub_nav + core_group + reports_group + admin_extra
    profile_panel = f"""
      <div class="profile-menu-wrap">
        <button type="button" class="profile-panel profile-trigger" aria-haspopup="true" aria-expanded="false">
          {profile_avatar_html(profile)}
          <span>
            <strong>{html.escape(profile["name"])}</strong>
            <em>{html.escape(profile["title"])}</em>
          </span>
        </button>
        <div class="profile-menu" role="menu">
          <div class="profile-menu-head">
            {profile_avatar_html(profile, "profile-avatar menu-avatar")}
            <span>
              <strong>{html.escape(profile["name"])}</strong>
              <em>@{html.escape(profile["username"])}</em>
            </span>
          </div>
          <a href="/account" role="menuitem">Account Settings</a>
          <a href="/account#photo" role="menuitem">Add Photo</a>
          <a href="/account#security" role="menuitem">Change Password</a>
          {'<a href="/people-access" role="menuitem">People Access</a>' if role == 'admin' else ''}
          <a class="logout-link" href="/logout" role="menuitem">Log Out</a>
        </div>
      </div>
    """
    page_blocks = "" if title == "Login" else render_site_blocks(REQUEST_PATH.get())
    return (
        template
        .replace("{{title}}", title)
        .replace("{{body_class}}", body_class)
        .replace("{{viewer_note}}", viewer_note)
        .replace("{{admin_nav}}", admin_nav)
        .replace("{{hub_nav}}", hub_nav)
        .replace("{{profile_panel}}", profile_panel)
        .replace("{{content}}", content + page_blocks)
        .replace("{{asset_version}}", asset_version)
        .encode("utf-8")
    )


def account_page_content(profile: dict, saved: bool = False, password_saved: bool = False) -> str:
    saved_note = "<p class='success-note'>Profile saved.</p>" if saved else ""
    password_note = "<p class='success-note'>Password updated for this profile.</p>" if password_saved else ""
    display_email = profile["email"] or "Add an email address"
    return f"""
    <section class="account-hero panel">
      <div class="account-cover"></div>
      <div class="account-identity">
        {profile_avatar_html(profile, "profile-avatar account-avatar")}
        <span>
          <strong>{html.escape(profile["name"])}</strong>
          <em>@{html.escape(profile["username"])}</em>
        </span>
      </div>
      <div class="account-actions">
        <a class="button ghost" href="/logout">Log Out</a>
      </div>
      <div class="account-stats">
        <div><span>Access</span><strong>{html.escape(profile["role"].title())}</strong></div>
        <div><span>Role</span><strong>{html.escape(profile["title"])}</strong></div>
        <div><span>Email</span><strong>{html.escape(display_email)}</strong></div>
      </div>
    </section>
    <section class="account-grid">
      <form method="post" action="/account" enctype="multipart/form-data" class="panel account-card" id="profile">
        <h2>Profile</h2>
        {saved_note}
        <label>Name<input name="name" value="{html.escape(profile["name"])}"></label>
        <label>Username<input name="username" value="{html.escape(profile["username"])}"></label>
        <label>Email<input type="email" name="email" value="{html.escape(profile["email"])}" placeholder="name@company.com"></label>
        <label id="photo">Add Photo<input type="file" name="photo_file" accept="image/png,image/jpeg,image/webp,image/gif"></label>
        <label>Photo Link<input name="photo_url" value="{html.escape(profile["photo_url"])}" placeholder="Optional image link"></label>
        <button>Save Profile</button>
      </form>
      <form method="post" action="/account-password" class="panel account-card" id="security">
        <h2>Security</h2>
        {password_note}
        <label>New Password<span class="password-field"><input type="password" name="new_password" autocomplete="new-password"><button type="button" class="password-toggle" aria-label="Show password">Show</button></span></label>
        <label>Confirm Password<span class="password-field"><input type="password" name="confirm_password" autocomplete="new-password"><button type="button" class="password-toggle" aria-label="Show password">Show</button></span></label>
        <button>Change Password</button>
        <p class="note">Password changes are saved for this selected person. Admin access still uses the private admin password.</p>
      </form>
    </section>
    """


def app_secret() -> str:
    return os.environ.get("APP_SECRET", "local-development-secret-change-before-hosting")


def app_password() -> str | None:
    return os.environ.get("APP_PASSWORD")


def viewer_password() -> str | None:
    return os.environ.get("VIEWER_PASSWORD")


def auth_enabled() -> bool:
    return bool(app_password() or viewer_password())


def hash_profile_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 120000).hex()
    return f"pbkdf2_sha256${salt}${digest}"


def verify_profile_password(password: str, stored: str | None) -> bool:
    if not stored or not stored.startswith("pbkdf2_sha256$"):
        return False
    try:
        _, salt, digest = stored.split("$", 2)
    except ValueError:
        return False
    candidate = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 120000).hex()
    return hmac.compare_digest(candidate, digest)


def make_session_token(role: str, user_key: str = "anne") -> str:
    timestamp = str(int(time.time()))
    nonce = secrets.token_urlsafe(16)
    payload = f"{timestamp}:{role}:{user_key}:{nonce}"
    signature = hmac.new(app_secret().encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{payload}:{signature}"


def session_from_token(token: str | None) -> tuple[str, str] | None:
    if not token:
        return None
    parts = token.split(":")
    if len(parts) == 3:
        timestamp, nonce, signature = parts
        role = "admin"
        user_key = "anne"
        payload = f"{timestamp}:{nonce}"
    elif len(parts) == 4:
        timestamp, role, nonce, signature = parts
        if role not in {"admin", "viewer"}:
            return None
        user_key = "anne" if role == "admin" else "damian"
        payload = f"{timestamp}:{role}:{nonce}"
    elif len(parts) == 5:
        timestamp, role, user_key, nonce, signature = parts
        if role not in {"admin", "viewer"}:
            return None
        payload = f"{timestamp}:{role}:{user_key}:{nonce}"
    else:
        return None
    expected = hmac.new(app_secret().encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        return None
    if int(time.time()) - int(timestamp) >= 60 * 60 * 24 * 14:
        return None
    if user_key not in shared_people():
        user_key = "anne" if role == "admin" else "damian"
    return role, user_key


def session_role_from_token(token: str | None) -> str | None:
    session = session_from_token(token)
    return session[0] if session else None


def has_entity_revenue(df: pd.DataFrame, entity: str) -> bool:
    if df.empty or entity not in df or "revenue" not in df:
        return False
    rows = df[df[entity].notna() & df[entity].astype(str).str.strip().ne("")]
    return (
        not rows.empty
        and rows["revenue"].dropna().gt(0).any()
    )


def has_real_platform_revenue(df: pd.DataFrame) -> bool:
    return (
        not df.empty
        and "platform" in df
        and "revenue" in df
        and df["revenue"].dropna().gt(0).any()
        and df["platform"].dropna().astype(str).str.strip().ne("Revenue Catcher").any()
    )


def has_shift_detail(df: pd.DataFrame) -> bool:
    return not df.empty and "shift_hours" in df and df["shift_hours"].dropna().gt(0).any()


def revenue_type_breakdown(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty or "transaction_type" not in df or "revenue" not in df:
        return pd.DataFrame()
    real_rows = df[~df["transaction_type"].fillna("").astype(str).str.strip().isin({"shift_summary", "summary"})].copy()
    if real_rows.empty:
        return pd.DataFrame()
    return (
        real_rows.groupby("transaction_type", dropna=False)
        .agg(revenue=("revenue", "sum"), days=("date", pd.Series.nunique), rows=("revenue", "count"))
        .reset_index()
        .sort_values("revenue", ascending=False)
    )


def platform_display_name(platform) -> str:
    raw = str(platform or "").strip()
    key = raw.lower()
    if "f2f" in key:
        return "F2F"
    if "knky" in key or "kinky" in key:
        return "KNKY"
    if key == "of" or "onlyfans" in key or key == "only fans":
        return "OF"
    return raw or "Unknown"


def platform_color_class(platform) -> str:
    label = platform_display_name(platform).lower()
    if label == "f2f":
        return "platform-f2f"
    if label == "knky":
        return "platform-knky"
    if label == "of":
        return "platform-of"
    return "platform-other"


CORE_REVENUE_PLATFORMS = ["F2F", "KNKY", "OF"]
CHATTER_TEAM_PLATFORM_DEFAULTS = {
    "dutch": ["F2F", "KNKY"],
    "english": ["OF"],
}
CHATTER_PLATFORM_DEFAULTS = {
    "aaliyah": ["OF"],
    "brigit": ["OF"],
    "daryll": ["OF"],
    "franz": ["OF"],
    "jacinta": ["OF"],
    "jyuanez": ["OF"],
    "julianne": ["OF"],
    "kianna": ["OF"],
    "maureen": ["OF"],
    "phina": ["OF"],
    "xavier": ["OF"],
    "yvan": ["OF"],
}
MODEL_PLATFORM_DEFAULTS = {
    "Anna": ["F2F", "OF"],
    "Annie": ["OF"],
    "Bibi": ["F2F"],
    "Delisha": ["F2F", "KNKY"],
    "Demi": ["F2F", "OF"],
    "Emilia": ["OF"],
    "Emma": ["F2F", "KNKY", "OF"],
    "Famke": ["F2F"],
    "Francis": ["F2F", "OF"],
    "Gabriële": ["F2F"],
    "Gigi": ["F2F", "OF"],
    "Jane": ["F2F", "KNKY", "OF"],
    "Jill": ["F2F", "OF"],
    "Jolie": ["OF"],
    "Kim": ["F2F"],
    "Kimmy": ["F2F", "OF"],
    "Kirsten": ["F2F", "OF"],
    "Larissa": ["F2F"],
    "Lesley": ["F2F", "OF"],
    "Lianne": ["F2F"],
    "Lisa": ["F2F", "OF"],
    "Nadine": ["F2F", "OF"],
    "Raluca": ["F2F"],
    "Romee": ["F2F"],
    "Rosalie": ["F2F"],
    "Sebine": ["F2F", "KNKY", "OF"],
    "Sophie": ["F2F"],
    "Vivian": ["F2F", "OF"],
    "Ylona": ["F2F", "OF"],
    "Zoe": ["F2F"],
}


def model_roster(df: pd.DataFrame) -> list[str]:
    default_names = list(MODEL_PLATFORM_DEFAULTS.keys())
    if df.empty or "creator" not in df:
        return sorted(default_names, key=lambda name: name.lower())
    names = df["creator"].fillna("").astype(str).str.strip()
    names = names[names.ne("") & ~names.str.lower().isin({"unknown", "nan", "none"})]
    return sorted(dict.fromkeys([*default_names, *names.tolist()]), key=lambda name: name.lower())


def chatter_roster(df: pd.DataFrame) -> list[str]:
    if df.empty or "chatter" not in df:
        return []
    names = df["chatter"].fillna("").astype(str).str.strip()
    names = names[names.ne("") & ~names.str.lower().isin({"unknown", "nan", "none"})]
    return sorted(dict.fromkeys(names.tolist()), key=lambda name: name.lower())


def chatter_team_lookup(df: pd.DataFrame) -> dict[str, str]:
    if df.empty or "chatter" not in df or "team" not in df:
        return {}
    rows = df[["chatter", "team"]].copy()
    rows["chatter"] = rows["chatter"].fillna("").astype(str).str.strip()
    rows["team"] = rows["team"].fillna("").astype(str).str.strip()
    rows = rows[
        rows["chatter"].ne("")
        & ~rows["chatter"].str.lower().isin({"unknown", "nan", "none"})
        & rows["team"].ne("")
        & ~rows["team"].str.lower().isin({"unknown", "nan", "none"})
    ]
    if rows.empty:
        return {}
    counts = rows.groupby(["chatter", "team"]).size().reset_index(name="count")
    counts = counts.sort_values(["chatter", "count", "team"], ascending=[True, False, True])
    return dict(counts.drop_duplicates("chatter")[["chatter", "team"]].itertuples(index=False, name=None))


def chatter_default_platforms(team: str, chatter: str = "") -> list[str]:
    chatter_key = str(chatter or "").strip().lower()
    if chatter_key in CHATTER_PLATFORM_DEFAULTS:
        return list(CHATTER_PLATFORM_DEFAULTS[chatter_key])
    team_key = str(team or "").strip().lower()
    for label, platforms in CHATTER_TEAM_PLATFORM_DEFAULTS.items():
        if label in team_key:
            return list(platforms)
    return ["F2F"]


def chatter_platform_roster(df: pd.DataFrame) -> dict[str, list[str]]:
    teams = chatter_team_lookup(df)
    roster = {chatter: chatter_default_platforms(team, chatter) for chatter, team in teams.items()}
    if not df.empty and "chatter" in df:
        for chatter in chatter_roster(df):
            roster.setdefault(chatter, chatter_default_platforms(teams.get(chatter, ""), chatter))
    return roster


def model_platform_roster(df: pd.DataFrame) -> dict[str, list[str]]:
    default_roster = {model: list(platforms) for model, platforms in MODEL_PLATFORM_DEFAULTS.items()}
    if df.empty or "creator" not in df or "platform" not in df:
        return default_roster
    rows = df.copy()
    rows["model"] = rows["creator"].fillna("").astype(str).str.strip()
    rows = rows[rows["model"].ne("") & ~rows["model"].str.lower().isin({"unknown", "nan", "none"})].copy()
    if rows.empty:
        return default_roster
    rows["platform_label"] = rows["platform"].fillna("").astype(str).str.strip().apply(platform_display_name)
    rows = rows[rows["platform_label"].isin(CORE_REVENUE_PLATFORMS)]
    if rows.empty:
        return default_roster
    order = {platform: index for index, platform in enumerate(CORE_REVENUE_PLATFORMS)}
    roster = default_roster
    for model, group in rows.groupby("model"):
        platforms = sorted(dict.fromkeys([*roster.get(model, []), *group["platform_label"].tolist()]), key=lambda platform: order.get(platform, 9))
        roster[model] = platforms
    return roster


def empty_model_platform_grid(roster: list[str], platform_roster: dict[str, list[str]] | None = None) -> pd.DataFrame:
    return pd.DataFrame(
        [
            {"model": model, "platform": platform, "platform_label": platform, "revenue": 0.0, "subscription_revenue": 0.0, "current_subs": 0.0, "agency": "Unknown", "tier": None}
            for model in roster
            for platform in (platform_roster or {}).get(model, ["F2F"])
        ],
        columns=["model", "platform", "platform_label", "revenue", "subscription_revenue", "current_subs", "agency", "tier"],
    )


def empty_chatter_platform_grid(roster: list[str], platform_roster: dict[str, list[str]] | None = None) -> pd.DataFrame:
    platform_roster = platform_roster or {}
    return pd.DataFrame(
        [
            {"chatter": chatter, "platform": platform, "platform_label": platform, "revenue": 0.0}
            for chatter in roster
            for platform in platform_roster.get(chatter, ["F2F"])
        ],
        columns=["chatter", "platform", "platform_label", "revenue"],
    )


def model_platform_revenue(
    df: pd.DataFrame,
    roster: list[str] | None = None,
    platform_roster: dict[str, list[str]] | None = None,
    account_metadata: pd.DataFrame | None = None,
) -> pd.DataFrame:
    roster = roster or []
    platform_roster = {model: list(platforms) for model, platforms in (platform_roster or {}).items()}
    if df.empty or "creator" not in df or "revenue" not in df:
        return empty_model_platform_grid(roster, platform_roster)
    rows = df.copy()
    rows["model"] = rows["creator"].fillna("").astype(str).str.strip()
    rows = rows[rows["model"].ne("") & ~rows["model"].str.lower().isin({"unknown", "nan", "none"})].copy()
    if rows.empty:
        return empty_model_platform_grid(roster, platform_roster)
    if "platform" not in rows:
        rows["platform"] = "Unknown"
    rows["platform"] = rows["platform"].fillna("Unknown").astype(str).str.strip().replace("", "Unknown")
    rows["revenue"] = pd.to_numeric(rows["revenue"], errors="coerce").fillna(0)
    rows["platform_label"] = rows["platform"].apply(platform_display_name)
    rows = rows[rows["platform_label"].isin(CORE_REVENUE_PLATFORMS)].copy()
    transaction_type = rows.get("transaction_type", pd.Series("", index=rows.index)).fillna("").astype(str).str.lower().str.strip()
    subscription_amount = pd.to_numeric(rows.get("subscription_revenue", pd.Series(0, index=rows.index)), errors="coerce").fillna(0)
    rows["subscription_revenue"] = subscription_amount.where(subscription_amount.ne(0), rows["revenue"].where(transaction_type.isin(["subscription", "subscriptions"]), 0))
    roster = sorted(dict.fromkeys([*roster, *rows["model"].tolist()]), key=lambda name: name.lower())
    if not roster:
        return pd.DataFrame(columns=["model", "platform", "platform_label", "revenue", "subscription_revenue", "current_subs", "agency", "tier"])
    for model, group in rows.groupby("model"):
        known_platforms = platform_roster.setdefault(model, [])
        for platform in group["platform_label"].dropna().unique().tolist():
            if platform not in known_platforms:
                known_platforms.append(platform)
    grouped = (
        rows.groupby(["model", "platform_label"], dropna=False)
        .agg(revenue=("revenue", "sum"), subscription_revenue=("subscription_revenue", "sum"))
        .reset_index()
    )
    order = {platform: index for index, platform in enumerate(CORE_REVENUE_PLATFORMS)}
    grid = pd.DataFrame(
        [
            {"model": model, "platform_label": platform}
            for model in roster
            for platform in sorted(platform_roster.get(model, ["F2F"]), key=lambda item: order.get(item, 9))
        ]
    )
    complete = grid.merge(grouped, on=["model", "platform_label"], how="left")
    complete["revenue"] = pd.to_numeric(complete["revenue"], errors="coerce").fillna(0)
    complete["subscription_revenue"] = pd.to_numeric(complete["subscription_revenue"], errors="coerce").fillna(0)
    complete["platform"] = complete["platform_label"]
    metadata = account_metadata.copy() if account_metadata is not None else pd.DataFrame()
    if not metadata.empty:
        metadata = metadata.copy()
        metadata["model"] = metadata["model"].fillna("").astype(str).str.strip()
        metadata["platform_label"] = metadata["platform_label"].fillna("").astype(str).str.strip().apply(platform_display_name)
        metadata["current_subs"] = pd.to_numeric(metadata.get("current_subs", pd.Series(0, index=metadata.index)), errors="coerce").fillna(0)
        metadata = (
            metadata.groupby(["model", "platform_label"], as_index=False)
            .agg(
                current_subs=("current_subs", "sum"),
                agency=("agency", lambda values: next((str(value) for value in values if str(value).strip() and str(value) != "Unknown"), "Unknown")),
                tier=("tier", lambda values: next((str(value) for value in values if str(value).strip() and str(value) != "None"), None)),
            )
        )
        complete = complete.merge(metadata, on=["model", "platform_label"], how="left")
    else:
        complete["current_subs"] = 0.0
        complete["agency"] = "Unknown"
        complete["tier"] = None
    complete["current_subs"] = pd.to_numeric(complete["current_subs"], errors="coerce").fillna(0)
    complete["agency"] = complete["agency"].apply(agency_display_name)
    complete["platform_order"] = complete["platform_label"].map({"F2F": 0, "KNKY": 1, "OF": 2}).fillna(9)
    complete["total_revenue"] = complete.groupby("model")["revenue"].transform("sum")
    return (
        complete.sort_values(["total_revenue", "model", "platform_order"], ascending=[False, True, True])
        .drop(columns=["platform_order", "total_revenue"])
        .reset_index(drop=True)
    )


def chatter_platform_revenue(
    df: pd.DataFrame,
    roster: list[str] | None = None,
    platform_roster: dict[str, list[str]] | None = None,
) -> pd.DataFrame:
    roster = roster or []
    platform_roster = {chatter: list(platforms) for chatter, platforms in (platform_roster or {}).items()}
    if df.empty or "chatter" not in df or "revenue" not in df:
        return empty_chatter_platform_grid(roster, platform_roster)
    rows = df.copy()
    rows["chatter"] = rows["chatter"].fillna("").astype(str).str.strip()
    rows = rows[rows["chatter"].ne("") & ~rows["chatter"].str.lower().isin({"unknown", "nan", "none"})].copy()
    if rows.empty:
        return empty_chatter_platform_grid(roster, platform_roster)
    if "platform" not in rows:
        rows["platform"] = "Unknown"
    rows["platform"] = rows["platform"].fillna("Unknown").astype(str).str.strip().replace("", "Unknown")
    rows["revenue"] = pd.to_numeric(rows["revenue"], errors="coerce").fillna(0)
    rows["platform_label"] = rows["platform"].apply(platform_display_name)
    rows = rows[rows["platform_label"].isin(CORE_REVENUE_PLATFORMS)].copy()
    roster = sorted(dict.fromkeys([*roster, *rows["chatter"].tolist()]), key=lambda name: name.lower())
    if not roster:
        return pd.DataFrame(columns=["chatter", "platform", "platform_label", "revenue"])
    if "team" in rows:
        for chatter, team in chatter_team_lookup(rows).items():
            platform_roster.setdefault(chatter, chatter_default_platforms(team, chatter))
    for chatter, group in rows[pd.to_numeric(rows["revenue"], errors="coerce").fillna(0).ne(0)].groupby("chatter"):
        known_platforms = platform_roster.setdefault(chatter, ["F2F"])
        for platform in group["platform_label"].dropna().unique().tolist():
            if platform not in known_platforms:
                known_platforms.append(platform)
    grouped = (
        rows.groupby(["chatter", "platform_label"], dropna=False)
        .agg(revenue=("revenue", "sum"))
        .reset_index()
    )
    order = {platform: index for index, platform in enumerate(CORE_REVENUE_PLATFORMS)}
    grid = pd.DataFrame(
        [
            {"chatter": chatter, "platform_label": platform}
            for chatter in roster
            for platform in sorted(platform_roster.get(chatter, ["F2F"]), key=lambda item: order.get(item, 9))
        ]
    )
    complete = grid.merge(grouped, on=["chatter", "platform_label"], how="left")
    complete["revenue"] = pd.to_numeric(complete["revenue"], errors="coerce").fillna(0)
    complete["platform"] = complete["platform_label"]
    complete["platform_order"] = complete["platform_label"].map({"F2F": 0, "KNKY": 1, "OF": 2}).fillna(9)
    complete["total_revenue"] = complete.groupby("chatter")["revenue"].transform("sum")
    return (
        complete.sort_values(["total_revenue", "chatter", "platform_order"], ascending=[False, True, True])
        .drop(columns=["platform_order", "total_revenue"])
        .reset_index(drop=True)
    )


def c_platform_totals_strip(rows: pd.DataFrame) -> str:
    if rows.empty or "platform_label" not in rows or "revenue" not in rows:
        totals = pd.DataFrame(columns=["platform_label", "revenue"])
    else:
        totals = rows.groupby("platform_label", as_index=False).agg(revenue=("revenue", "sum"))
    total_map = {str(row["platform_label"]): float(row["revenue"] or 0) for _, row in totals.iterrows()}
    grand_total = sum(total_map.get(platform, 0.0) for platform in CORE_REVENUE_PLATFORMS)
    cards = []
    for platform in CORE_REVENUE_PLATFORMS:
        amount = total_map.get(platform, 0.0)
        share = 0 if grand_total <= 0 else amount / grand_total * 100
        color_class = platform_color_class(platform)
        cards.append(
            "<article class='platform-total-card'>"
            f"<span class='{color_class}'>{html.escape(platform)}</span>"
            f"<strong class='{color_class}'>{fmt_money(amount)}</strong>"
            f"<em>{fmt_pct(share)} of selected revenue</em>"
            "</article>"
        )
    return "<div class='platform-total-strip'>" + "".join(cards) + "</div>"


def c_revenue_breakdown_cards(
    rows: pd.DataFrame,
    entity: str,
    empty_label: str,
    header_metrics: dict | None = None,
    sort_by: str = "revenue",
    sort_direction: str = "desc",
) -> str:
    if rows.empty:
        return f'<div class="empty">No {html.escape(empty_label)} revenue rows for the selected filters.</div>'
    aggregate_columns = {"total_revenue": ("revenue", "sum")}
    if "subscription_revenue" in rows:
        aggregate_columns["subscription_revenue"] = ("subscription_revenue", "sum")
    totals = rows.groupby(entity, as_index=False).agg(**aggregate_columns)
    if "subscription_revenue" not in totals:
        totals["subscription_revenue"] = 0.0
    sort_columns = {
        "revenue": "total_revenue",
        "subscriptions": "subscription_revenue",
        entity: entity,
    }
    primary_sort = sort_columns.get(sort_by, "total_revenue")
    if primary_sort == entity:
        totals["_model_sort"] = totals[entity].fillna("").astype(str).str.lower()
        totals = totals.sort_values("_model_sort", ascending=sort_direction == "asc").drop(columns="_model_sort")
    else:
        totals = totals.sort_values([primary_sort, entity], ascending=[sort_direction == "asc", True])
    cards = []
    platform_order = {"F2F": 0, "KNKY": 1, "OF": 2}
    for _, total_row in totals.iterrows():
        name = str(total_row[entity])
        total = float(total_row["total_revenue"] or 0)
        metric = (header_metrics or {}).get(name, {})
        rate = metric.get("revenue_per_hour")
        model_subset = rows[rows[entity].eq(name)].copy()
        subscription_total = float(pd.to_numeric(model_subset.get("subscription_revenue", pd.Series(dtype=float)), errors="coerce").fillna(0).sum())
        current_subs = int(pd.to_numeric(model_subset.get("current_subs", pd.Series(dtype=float)), errors="coerce").fillna(0).sum())
        agencies = []
        if "agency" in model_subset:
            agencies = [agency_display_name(value) for value in model_subset["agency"].dropna().unique() if agency_display_name(value) != "Unknown"]
        tier_values = []
        if "tier" in model_subset:
            tier_rows = model_subset.copy()
            tier_rows["order"] = tier_rows["platform_label"].map(platform_order).fillna(9)
            tier_rows = tier_rows.sort_values(["order", "platform_label"])
            tier_values = [
                str(row.get("tier"))
                for _, row in tier_rows.iterrows()
                if str(row.get("tier") or "").strip() and str(row.get("tier")) != "None"
            ]
        rate_html = ""
        if rate is not None:
            rate_html = (
                "<span class='model-revenue-rate'>"
                f"{fmt_money(rate)}/hr"
                "</span>"
            )
        badges = []
        if agencies:
            badges.append(html.escape(" / ".join(sorted(dict.fromkeys(agencies)))))
        if tier_values:
            badges.append(html.escape(" / ".join(dict.fromkeys(tier_values))))
        meta_html = f"<div class='model-revenue-meta'>{''.join(f'<span>{badge}</span>' for badge in badges)}</div>" if badges else ""
        subs_total_html = f"<span class='model-revenue-subs-total'>{fmt_int(current_subs)} subs</span>" if current_subs else ""
        subs_html = f"<span class='model-subscription-total'>Subscriptions {fmt_money(subscription_total)}</span>" if subscription_total else ""
        splits = model_subset
        splits["order"] = splits["platform_label"].map(platform_order).fillna(9)
        splits = splits.sort_values(["order", "revenue"], ascending=[True, False])
        split_html = []
        for _, split in splits.iterrows():
            amount = float(split["revenue"] or 0)
            pct = 0 if total <= 0 else amount / total * 100
            platform = split["platform_label"]
            color_class = platform_color_class(platform)
            split_subs = int(float(split.get("current_subs") or 0))
            subs_count_html = f"<em>{fmt_int(split_subs)} subs</em>" if split_subs else "<em></em>"
            split_html.append(
                "<div class='model-platform-row'>"
                f"<span class='{color_class}'>{html.escape(platform)}</span>"
                f"<strong class='{color_class}'>{fmt_money(amount)}</strong>"
                f"{subs_count_html}"
                "<div class='model-platform-track'>"
                f"<i class='{color_class}' style='width:{pct:.1f}%'></i>"
                "</div>"
                "</div>"
            )
        cards.append(
            "<article class='model-revenue-card'>"
            "<div class='model-revenue-card-head'>"
            f"<h3>{html.escape(name)}</h3>"
            f"{subs_total_html or rate_html}"
            "</div>"
            f"{meta_html}"
            f"<strong>{fmt_money(total)}</strong>"
            f"{subs_html}"
            f"<div class='model-platform-splits'>{''.join(split_html)}</div>"
            "</article>"
        )
    return "<section class='model-revenue-grid'>" + "".join(cards) + "</section>"


def c_model_revenue_cards(rows: pd.DataFrame, sort_by: str = "revenue", sort_direction: str = "desc") -> str:
    return c_revenue_breakdown_cards(rows, "model", "model", sort_by=sort_by, sort_direction=sort_direction)


def c_chatter_revenue_cards(
    rows: pd.DataFrame,
    header_metrics: dict | None = None,
    sort_by: str = "revenue",
    sort_direction: str = "desc",
) -> str:
    return c_revenue_breakdown_cards(rows, "chatter", "chatter", header_metrics, sort_by, sort_direction)


def c_scheduled_chatter_cards(rows: pd.DataFrame) -> str:
    if rows is None or rows.empty:
        return '<div class="empty">No scheduled chatter rows for the selected period.</div>'

    def grade_date_label(value) -> str:
        if value is None or (isinstance(value, float) and pd.isna(value)):
            return "Not graded"
        parsed = pd.to_datetime(value, errors="coerce")
        if pd.isna(parsed):
            return "Not graded"
        return parsed.strftime("%d %b %Y")

    cards = []
    for _, row in rows.head(80).iterrows():
        chatter = str(row.get("chatter", "Unknown") or "Unknown")
        tier = str(row.get("tier", "Pending score") or "Pending score")
        team = str(row.get("team", "Unknown") or "Unknown")
        pending = bool(row.get("score_pending", 0))
        matched = bool(row.get("hr_profile_found", 0))
        skill = float(row.get("skill_grade", 0) or 0)
        chat_quality = float(row.get("chat_quality", 0) or 0)
        behaviour = float(row.get("activity_behaviour", 0) or 0)
        hours = float(row.get("scheduled_hours", 0) or 0)
        potential = float(row.get("operating_potential", 0) or 0)
        revenue = float(row.get("revenue", 0) or 0)
        rev_per_hour = float(row.get("rev_per_hour", 0) or 0)
        tier_class = f"tier-{tier.lower()}" if tier in {"A", "B", "C"} else "tier-pending"
        last_graded = grade_date_label(row.get("latest_grade_date"))
        status = "Pending score" if pending else "Matched HR" if matched else "Needs HR profile"
        cards.append(
            "<article class='scheduled-chatter-card'>"
            "<div class='scheduled-chatter-head'>"
            f"<div><h3>{html.escape(chatter)}</h3><span>{html.escape(team)}</span></div>"
            f"<div class='scheduled-tier-lockup'><strong class='{tier_class}'>{html.escape(tier)}</strong><small>Last graded<br>{html.escape(last_graded)}</small></div>"
            "</div>"
            "<div class='scheduled-chatter-main'>"
            f"<div><span>Operating Potential</span><strong>{fmt_compact(potential)}</strong></div>"
            f"<div><span>Scheduled Hours</span><strong>{fmt_num(hours)}</strong></div>"
            f"<div><span>Revenue</span><strong>{fmt_money(revenue)}</strong></div>"
            f"<div><span>Rev / Hour</span><strong>{fmt_money(rev_per_hour)}</strong></div>"
            "</div>"
            "<div class='scheduled-score-grid'>"
            f"<span>Skill <strong>{fmt_num(skill)}</strong></span>"
            f"<span>Chat Quality <strong>{fmt_num(chat_quality)}</strong></span>"
            f"<span>Activity / Behaviour <strong>{fmt_num(behaviour)}</strong></span>"
            "</div>"
            f"<em class='scheduled-status'>{html.escape(status)}</em>"
            "</article>"
        )
    return "<section class='scheduled-chatter-grid'>" + "".join(cards) + "</section>"


def c_capacity_chatter_cards(rows: pd.DataFrame) -> str:
    if rows is None or rows.empty:
        return '<div class="empty">No chatter rows for the current week.</div>'

    def grade_date_label(value) -> str:
        if value is None or (isinstance(value, float) and pd.isna(value)):
            return "Not graded"
        parsed = pd.to_datetime(value, errors="coerce")
        if pd.isna(parsed):
            return "Not graded"
        return parsed.strftime("%d %b %Y")

    cards = []
    for _, row in rows.head(80).iterrows():
        chatter = str(row.get("chatter", "Unknown") or "Unknown")
        tier = str(row.get("tier", "Pending score") or "Pending score")
        team = str(row.get("team", "Unknown") or "Unknown")
        pending = bool(row.get("score_pending", 0))
        matched = bool(row.get("hr_profile_found", 0))
        capacity_missing = bool(row.get("capacity_missing", 0))
        skill = float(row.get("skill_grade", 0) or 0)
        chat_quality = float(row.get("chat_quality", 0) or 0)
        behaviour = float(row.get("activity_behaviour", 0) or 0)
        weekly_capacity = float(row.get("weekly_capacity_hours", 0) or 0)
        scheduled = float(row.get("scheduled_hours", 0) or 0)
        unused = float(row.get("capacity_gap_hours", 0) or 0)
        utilization = float(row.get("utilization_pct", 0) or 0)
        strength = float(row.get("quality_adjusted_capacity", 0) or 0)
        revenue = float(row.get("revenue", 0) or 0)
        tier_class = f"tier-{tier.lower()}" if tier in {"A", "B", "C"} else "tier-pending"
        last_graded = grade_date_label(row.get("latest_grade_date"))
        capacity_label = "Missing capacity" if capacity_missing else f"{fmt_num(weekly_capacity)}h"
        capacity_source = str(row.get("capacity_source", "Profile capacity") or "Profile capacity")
        status = "Missing weekly capacity" if capacity_missing else f"Capacity: {capacity_source}" if capacity_source == "RevenueCatcher schedule" else "Pending score" if pending else "Matched HR" if matched else "Needs HR profile"
        cards.append(
            "<article class='scheduled-chatter-card capacity-chatter-card'>"
            "<div class='scheduled-chatter-head'>"
            f"<div><h3>{html.escape(chatter)}</h3><span>{html.escape(team)}</span></div>"
            f"<div class='scheduled-tier-lockup'><strong class='{tier_class}'>{html.escape(tier)}</strong><small>Last graded<br>{html.escape(last_graded)}</small></div>"
            "</div>"
            "<div class='scheduled-chatter-main'>"
            f"<div><span>Weekly Capacity</span><strong>{html.escape(capacity_label)}</strong></div>"
            f"<div><span>Chatter Hours</span><strong>{fmt_num(scheduled)}h</strong></div>"
            f"<div><span>Unused Capacity</span><strong>{fmt_num(unused)}h</strong></div>"
            f"<div><span>Utilization</span><strong>{fmt_num(utilization)}%</strong></div>"
            f"<div><span>Team Strength</span><strong>{fmt_num(strength)}h</strong></div>"
            f"<div><span>Revenue</span><strong>{fmt_money(revenue)}</strong></div>"
            "</div>"
            "<div class='scheduled-score-grid'>"
            f"<span>Skill <strong>{fmt_num(skill)}</strong></span>"
            f"<span>Chat Quality <strong>{fmt_num(chat_quality)}</strong></span>"
            f"<span>Activity / Behaviour <strong>{fmt_num(behaviour)}</strong></span>"
            "</div>"
            f"<em class='scheduled-status'>{html.escape(status)}</em>"
            "</article>"
        )
    return "<section class='scheduled-chatter-grid'>" + "".join(cards) + "</section>"


def daily_trend_rows(df: pd.DataFrame, start: date, end: date, split_df: pd.DataFrame | None = None) -> list[dict]:
    rows_by_date = {row["date"]: row["revenue"] for row in trend(df)}
    platform_splits: dict[str, list[dict]] = {}
    split_source = split_df if split_df is not None else df
    if split_source is not None and not split_source.empty and {"date", "platform", "revenue"}.issubset(split_source.columns):
        split_rows = split_source.copy()
        split_rows["revenue"] = pd.to_numeric(split_rows["revenue"], errors="coerce").fillna(0)
        split_rows["platform_label"] = split_rows["platform"].apply(platform_display_name)
        split_rows = split_rows[split_rows["revenue"].gt(0)]
        if not split_rows.empty:
            grouped = (
                split_rows.groupby(["date", "platform_label"], dropna=False)
                .agg(revenue=("revenue", "sum"))
                .reset_index()
            )
            platform_order = {"F2F": 0, "KNKY": 1, "OF": 2}
            for day, day_rows in grouped.groupby("date"):
                ordered = day_rows.copy()
                ordered["order"] = ordered["platform_label"].map(platform_order).fillna(9)
                ordered = ordered.sort_values(["order", "revenue"], ascending=[True, False])
                platform_splits[str(day)] = [
                    {"platform": str(row["platform_label"]), "revenue": float(row["revenue"] or 0)}
                    for _, row in ordered.iterrows()
                ]
    rows = []
    cursor = start
    while cursor <= end:
        key = cursor.isoformat()
        revenue = float(rows_by_date.get(key, 0) or 0)
        splits = platform_splits.get(key, [])
        split_total = sum(float(item.get("revenue") or 0) for item in splits)
        if revenue > split_total > 0 and revenue - split_total > 0.01:
            splits = [*splits, {"platform": "Other", "revenue": revenue - split_total}]
        rows.append({"date": key, "revenue": revenue, "platforms": splits})
        cursor += timedelta(days=1)
    return rows


def revenue_sum(df: pd.DataFrame) -> float:
    if df is None or df.empty or "revenue" not in df:
        return 0.0
    return float(pd.to_numeric(df["revenue"], errors="coerce").dropna().sum())


def flow_manager_dashboard_totals(rows: pd.DataFrame) -> dict[str, float | None]:
    """Match Flow Manager Dashboard totals using only rows with an MD cut.

    Some Flow exports call this amount ``md_net_amount``. Older records expose
    the same manager-facing amount as ``net_amount``, so that is a deliberate
    compatibility fallback rather than a wider all-transaction total.
    """
    if rows is None or rows.empty:
        return {"gross": None, "net": None, "eligible_rows": 0, "source": "No Flow rows"}
    detail = rows.copy()
    tx_type = detail.get("transaction_type", pd.Series("", index=detail.index)).fillna("").astype(str)
    detail = detail[~tx_type.isin(["shift_summary", "inactivity", "summary"])].copy()
    if detail.empty:
        return {"gross": None, "net": None, "eligible_rows": 0, "source": "No Flow revenue rows"}
    md_amount = pd.to_numeric(detail.get("md_net_amount", pd.Series(index=detail.index, dtype=float)), errors="coerce")
    source = "MD agency amount"
    if not md_amount.notna().any():
        md_amount = pd.to_numeric(detail.get("net_amount", pd.Series(index=detail.index, dtype=float)), errors="coerce")
        source = "Flow net amount (MD-cut fallback)"
    eligible = md_amount.notna() & md_amount.ne(0)
    tx_type = detail.get("transaction_type", pd.Series("", index=detail.index)).fillna("").astype(str).str.strip().str.lower()
    # Flow's Manager Dashboard reports tips, messages, and subscriptions from
    # its company-visible view.  That view already excludes no-company-cut,
    # refund, and chargeback rows; subscriptions are included in every Flow
    # dashboard status (paid-pending-balance, loading, and completed). PPV is
    # not included.
    realised_types = tx_type.isin(["tip", "message", "subscription"])
    eligible = eligible & realised_types
    detail = detail[eligible].copy()
    if detail.empty:
        return {"gross": 0.0, "net": 0.0, "eligible_rows": 0, "source": source}
    return {
        "gross": revenue_sum(detail),
        "net": float(md_amount.loc[eligible].sum()),
        "eligible_rows": int(len(detail)),
        "source": source,
    }


def _flow_currency_amount(value: object, currency: str) -> float | None:
    """Read a Flow {eur, usd} money pair without applying Gaze's FX rate again."""
    if not isinstance(value, dict):
        return None
    try:
        amount = float(value.get(currency.lower()))
    except (TypeError, ValueError):
        return None
    return amount if pd.notna(amount) else None


def fmt_native_money(value: float | None, currency: str) -> str:
    if value is None or pd.isna(value):
        return "n/a"
    return f"${float(value):,.2f}" if currency == "USD" else f"€{float(value):,.2f}"


def flow_manager_dashboard_summary(settings: dict, start: date, end: date, filters: dict | None = None) -> dict:
    """Fetch Flow's own Manager Dashboard aggregation when service access exists.

    This endpoint embodies Flow's realised-revenue rules, which cannot be
    recreated faithfully from transaction exports. It intentionally returns no
    estimated values when the service credential is not authorised.
    """
    filters = filters or {}
    if any(filters.get(field) for field in ["platform", "team", "creator", "chatter", "transaction_type"]):
        return {"available": False, "reason": "Flow manager total is available for the unfiltered company view only."}
    base_url = os.environ.get("FLOW_MANAGER_BASE_URL", "https://md-flow.up.railway.app").rstrip("/")
    auth_token = os.environ.get("FLOW_MANAGER_AUTH_TOKEN", "").strip()
    api_key = os.environ.get("FLOW_MANAGER_API_KEY", "").strip()
    if not auth_token and not api_key:
        return {"available": False, "reason": "Direct Flow manager access is not configured."}
    credential_marker = (auth_token or api_key)[-8:]
    cache_key = (base_url, start.isoformat(), end.isoformat(), credential_marker, DISPLAY_CURRENCY.get())
    cached = FLOW_MANAGER_SUMMARY_CACHE.get(cache_key)
    if cached and time.time() - cached[0] < LIVE_REVENUE_CATCHER_TTL_SECONDS:
        return cached[1].copy()
    url = f"{base_url}/api/dashboard/revenue-summary?{urlencode({'dateFrom': start.isoformat(), 'dateTo': end.isoformat()})}"
    headers = {"Accept": "application/json"}
    if auth_token:
        headers["X-Auth-Token"] = auth_token
    if api_key:
        headers["x-api-key"] = api_key
    try:
        req = request.Request(url, headers=headers)
        with request.urlopen(req, timeout=LIVE_REVENUE_CATCHER_TIMEOUT_SECONDS) as response:
            payload = json.loads(response.read().decode("utf-8"))
        current = payload.get("curr", {})
        currency = DISPLAY_CURRENCY.get()
        gross = _flow_currency_amount(current.get("grand"), currency)
        net = _flow_currency_amount(current.get("netGrand"), currency)
        if gross is None or net is None:
            raise ValueError("Flow response omitted manager totals")
        result = {"available": True, "gross": gross, "net": net, "currency": currency}
    except (HTTPError, URLError, TimeoutError, ValueError, json.JSONDecodeError):
        result = {"available": False, "reason": "Flow manager endpoint did not authorise the service credential."}
    FLOW_MANAGER_SUMMARY_CACHE[cache_key] = (time.time(), result.copy())
    if len(FLOW_MANAGER_SUMMARY_CACHE) > MAX_LIVE_REVENUE_CATCHER_CACHE_ENTRIES:
        oldest_key = min(FLOW_MANAGER_SUMMARY_CACHE, key=lambda key: FLOW_MANAGER_SUMMARY_CACHE[key][0])
        FLOW_MANAGER_SUMMARY_CACHE.pop(oldest_key, None)
    return result


def entity_filters_active(filters: dict) -> bool:
    return any(filters.get(field) for field in ["platform", "team", "creator", "chatter"])


def revenue_summary_period_from_frame(frame: pd.DataFrame, start: date, end: date, filters: dict | None = None) -> pd.DataFrame:
    filters = filters or {}
    if frame.empty or "source_type" not in frame:
        return pd.DataFrame()
    source_type = frame["source_type"].fillna("").astype(str)
    summary = frame[source_type.isin(["revenue_catcher_live_summary", "revenue_catcher_summary_api", "revenue_catcher_summary_json"])].copy()
    if summary.empty:
        return pd.DataFrame()
    summary = analytics_frame(summary)
    summary_filters = {"transaction_type": filters.get("transaction_type", [])}
    return filter_period(summary, start, end, summary_filters)


def live_summary_period(settings: dict, start: date, end: date, filters: dict | None = None) -> pd.DataFrame:
    filters = filters or {}
    if entity_filters_active(filters):
        return pd.DataFrame()
    live = live_revenue_catcher_frame(settings, start, end)
    return revenue_summary_period_from_frame(live, start, end, filters)


def apply_summary_revenue(metrics: dict, current_summary: pd.DataFrame, previous_summary: pd.DataFrame) -> dict:
    if current_summary.empty:
        return metrics
    updated = dict(metrics)
    revenue = revenue_sum(current_summary)
    previous = revenue_sum(previous_summary)
    hours = updated.get("total_hours") or 0
    chatters = updated.get("active_chatters") or 0
    creators = updated.get("active_creators") or 0
    updated["total_revenue"] = revenue
    updated["previous_revenue"] = previous
    updated["revenue_change_pct"] = ((revenue - previous) / previous * 100) if previous else None
    updated["revenue_per_hour"] = revenue / hours if hours else None
    updated["avg_revenue_per_chatter"] = revenue / chatters if chatters else None
    updated["avg_revenue_per_creator"] = revenue / creators if creators else None
    return updated


def scheduled_shift_rows(df: pd.DataFrame, start: date, end: date, filters: dict | None = None) -> pd.DataFrame:
    if df is None or df.empty or "date" not in df or "shift_hours" not in df:
        return pd.DataFrame()
    rows = df[(df["date"] >= start) & (df["date"] <= end)].copy()
    if rows.empty:
        return rows
    source_type = rows.get("source_type", pd.Series("", index=rows.index)).fillna("").astype(str)
    transaction_type = rows.get("transaction_type", pd.Series("", index=rows.index)).fillna("").astype(str)
    rows = rows[source_type.str.contains("shift", case=False, na=False) | transaction_type.eq("shift_summary")].copy()
    if rows.empty:
        return rows
    filters = filters or {}
    for field in ["platform", "team", "creator", "chatter"]:
        value = filters.get(field)
        if value and field in rows:
            if isinstance(value, list):
                rows = rows[rows[field].fillna("Unknown").isin(value)]
            else:
                rows = rows[rows[field].fillna("Unknown") == value]
    if "chatter" in rows:
        chatter = rows["chatter"].fillna("").astype(str).str.strip()
        rows = rows[chatter.ne("") & ~chatter.str.lower().isin({"unknown", "none", "nan"})].copy()
    rows["shift_hours"] = pd.to_numeric(rows["shift_hours"], errors="coerce").fillna(0)
    rows = rows[rows["shift_hours"].gt(0)].copy()
    if rows.empty:
        return rows
    if "shift_id" in rows and rows["shift_id"].notna().any():
        rows = rows.sort_values("shift_hours", ascending=False).drop_duplicates(subset=["shift_id"], keep="first")
    else:
        dedupe_cols = [col for col in ["date", "shift_start", "shift_end", "platform", "creator", "chatter"] if col in rows]
        if dedupe_cols:
            rows = rows.sort_values("shift_hours", ascending=False).drop_duplicates(subset=dedupe_cols, keep="first")
    return rows


def apply_scheduled_hours(metrics: dict, all_data: pd.DataFrame, start: date, end: date, filters: dict | None = None) -> dict:
    rows = scheduled_shift_rows(all_data, start, end, filters)
    if rows.empty:
        return metrics
    updated = dict(metrics)
    hours = float(rows["shift_hours"].sum())
    revenue = updated.get("total_revenue") or 0
    updated["total_hours"] = hours
    updated["revenue_per_hour"] = revenue / hours if hours else None
    return updated


def revenue_per_hour_by_chatter(revenue_rows: pd.DataFrame, all_data: pd.DataFrame, start: date, end: date, filters: dict | None = None) -> dict:
    if revenue_rows.empty or "chatter" not in revenue_rows:
        return {}
    revenue = (
        revenue_rows.assign(revenue=pd.to_numeric(revenue_rows["revenue"], errors="coerce").fillna(0))
        .groupby("chatter", dropna=False)["revenue"]
        .sum()
    )
    hours = scheduled_shift_rows(all_data, start, end, filters)
    if hours.empty or "chatter" not in hours:
        return {}
    hours_by_chatter = hours.groupby("chatter", dropna=False)["shift_hours"].sum()
    metrics = {}
    for chatter, total_revenue in revenue.items():
        total_hours = float(hours_by_chatter.get(chatter, 0) or 0)
        if total_hours > 0:
            metrics[str(chatter)] = {
                "revenue_per_hour": float(total_revenue) / total_hours,
                "hours": total_hours,
            }
    return metrics


def previous_month_same_days(start: date, end: date) -> tuple[date, date]:
    previous_month_last_day = start - timedelta(days=1)
    previous_start = date(previous_month_last_day.year, previous_month_last_day.month, 1)
    previous_end_day = min(end.day, previous_month_last_day.day)
    previous_end = date(previous_month_last_day.year, previous_month_last_day.month, previous_end_day)
    return previous_start, previous_end


def coverage_notice(kind: str) -> str:
    messages = {
        "overview": "Revenue totals are loaded from Revenue Catcher's revenue-summary endpoint. Active chatters, active creators, hours, inactivity, concentration, and entity rankings need detailed Revenue Catcher endpoints as well.",
        "chatters": "Chatter rankings need a Revenue Catcher response that includes chatter names and revenue by chatter. The revenue-summary endpoint only gives company totals by revenue type.",
        "creators": "Creator rankings need a Revenue Catcher response that includes creator names and revenue by creator. The current revenue-summary response only includes top creator IDs, not names or full creator rows.",
        "transactions": "Transaction analysis needs transaction-level rows with amount, type, creator, chatter, and timestamp. The revenue-summary endpoint cannot identify individual unlocks or responsible chatters.",
        "hours": "Hours are loaded from Revenue Catcher's official shifts/export endpoint. Inactivity minutes are not included in the official external API yet, so inactivity is shown as n/a until an inactivity-capable endpoint is available.",
        "platforms": "Platform performance needs revenue rows tagged to real platforms such as F2F, OF, or Kinky. The revenue-summary endpoint only gives total revenue by type.",
        "commissions": "Commission analysis needs detailed revenue rows and commission rules by creator, chatter, team, platform, or effective period. Summary totals are not enough for accurate payouts.",
    }
    return f"<section class='notice'><strong>Data coverage note:</strong> {messages[kind]}</section>"


def revenue_catcher_headers(settings: dict) -> dict:
    api_key = os.environ.get("REVENUE_CATCHER_API_KEY") or settings.get("revenue_catcher_api_key") or ""
    return {"x-api-key": api_key} if api_key else {}


def api_key_status(settings: dict) -> str:
    if os.environ.get("REVENUE_CATCHER_API_KEY"):
        return "set from environment"
    if settings.get("revenue_catcher_api_key"):
        return "saved locally"
    return "missing"


class RevenueAnalyticsHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith("/static/"):
            return self.static_file(parsed.path)
        if parsed.path == "/login":
            return self.respond(self.login_page())
        if parsed.path == "/logout":
            self.send_response(HTTPStatus.SEE_OTHER)
            self.send_header("Location", "/login")
            self.send_header("Set-Cookie", f"{SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax")
            self.end_headers()
            return
        role = self.session_role()
        if not role:
            return self.redirect("/login")
        REQUEST_ROLE.set(role)
        REQUEST_USER.set(self.session_user())
        REQUEST_PATH.set(parsed.path)
        if role == "viewer" and parsed.path == "/" and "/" not in viewer_allowed_routes(self.session_user()):
            return self.redirect(first_viewer_route())
        params = parse_qs(parsed.query)
        routes = {
            "/": self.welcome,
            "/revenue": self.revenue,
            "/chatters": self.chatters,
            "/creators": self.creators,
            "/platforms": self.platforms,
            "/inactivity": self.inactivity,
            "/transactions": self.transactions,
            "/commissions": self.commissions,
            "/insights": self.insights,
            "/revenue-tiers": self.revenue_tiers,
            "/weekly-report": self.weekly_report_page,
            "/monthly-report": self.monthly_report_page,
            "/ask": self.ask,
            "/data-quality": self.data_quality,
            "/data-sources": self.data_sources,
            "/settings": self.settings,
            "/edit-site": self.edit_site,
            "/account": self.account,
            "/permission-groups": self.permission_groups,
            "/people-access": self.people_access,
            "/metric-definitions": self.metric_definitions,
            "/inactivity-computation": self.inactivity_computation,
            "/architecture": self.architecture,
            "/c-hub": self.c_hub,
            "/c-hub/executive-overview": self.c_hub_executive_overview,
            "/c-hub/revenue": self.c_hub_revenue,
            "/c-hub/chatter-revenue": self.c_hub_chatter_revenue,
            "/c-hub/inactivity": self.c_hub_inactivity,
            "/c-hub/transactions": self.c_hub_transactions,
            "/c-hub/commissions": self.c_hub_commissions,
            "/c-hub/performance": self.c_hub_performance,
            "/c-hub/performance-2": self.c_hub_performance_2,
            "/c-hub/compliance": self.c_hub_compliance,
            "/c-hub/marketing-ads": self.c_hub_marketing_ads,
            "/c-hub/models-socials": self.c_hub_models_socials,
            "/c-hub/of-new-fans": self.c_hub_of_new_fans,
            "/c-hub/ads-performance": self.c_hub_ads_performance,
            "/c-hub/tickets": self.c_hub_tickets,
            "/c-hub/chatter-revenue-tier": self.c_hub_chatter_revenue_tier,
            "/c-hub/target-monitoring": self.c_hub_target_monitoring,
            "/compliance-dash": self.compliance_dash,
            "/marketing": self.marketing,
            "/models-socials": self.models_socials,
            "/of-new-fan-growth": self.of_new_fan_growth,
            "/ads-performance": self.ads_performance,
            "/notion-tickets": self.notion_tickets,
        }
        if parsed.path.startswith("/export/"):
            if role != "admin":
                return self.respond("Not found", HTTPStatus.NOT_FOUND)
            return self.export(parsed.path, params)
        handler = routes.get(parsed.path)
        if not handler:
            return self.respond("Not found", HTTPStatus.NOT_FOUND)
        if role != "admin" and parsed.path not in viewer_allowed_routes(self.session_user()):
            if parsed.path == "/account":
                return self.respond(handler(params))
            return self.respond("Not found", HTTPStatus.NOT_FOUND)
        return self.respond(handler(params))

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/login":
            return self.login()
        role = self.session_role()
        if not role:
            return self.redirect("/login")
        REQUEST_ROLE.set(role)
        REQUEST_USER.set(self.session_user())
        REQUEST_PATH.set(parsed.path)
        if parsed.path == "/account":
            return self.save_account()
        if parsed.path == "/account-password":
            return self.save_account_password()
        if role != "admin":
            return self.respond("Not found", HTTPStatus.NOT_FOUND)
        if parsed.path == "/load-demo":
            demo_path = create_demo_csv()
            raw = CSVXLSXConnector(demo_path).load()
            mapping = guess_mapping(list(raw.columns))
            save_mappings(mapping)
            processed = apply_mapping(raw, mapping)
            issues = validate_transactions(processed)
            insert_import("DEMO DATA - GAZE sample", "csv", raw, processed, issues, is_demo=True)
            return self.redirect("/?loaded=demo")
        if parsed.path == "/clear-demo":
            delete_demo_imports()
            return self.redirect("/data-quality?cleared=demo")
        if parsed.path == "/import-master-sheet":
            return self.import_master_sheet()
        if parsed.path == "/import-master-shifts-sheet":
            return self.import_master_shifts_sheet()
        if parsed.path == "/save-revenue-catcher-settings":
            return self.save_revenue_catcher_settings()
        if parsed.path == "/upload":
            return self.upload()
        if parsed.path == "/upload-revenue-catcher-json":
            return self.upload_revenue_catcher_json()
        if parsed.path == "/upload-creators-json":
            return self.upload_creators_json()
        if parsed.path == "/upload-chatters-json":
            return self.upload_chatters_json()
        if parsed.path == "/import-revenue-catcher-api":
            return self.import_revenue_catcher_api()
        if parsed.path == "/import-revenue-api":
            return self.import_revenue_api()
        if parsed.path == "/import-revenue-summary-api":
            return self.import_revenue_summary_api()
        if parsed.path == "/import-active-shifts-api":
            return self.import_active_shifts_api()
        if parsed.path == "/settings":
            length = int(self.headers.get("Content-Length", 0))
            form = parse_qs(self.rfile.read(length).decode("utf-8"))
            settings = load_settings()
            for key in ["reporting_week_start", "default_currency", "timezone", "unlock_threshold", "inactivity_threshold_minutes", "low_revenue_per_hour_threshold", "high_revenue_per_hour_threshold", "anomaly_revenue_drop_pct", "anomaly_revenue_spike_pct", "master_google_sheet_url", "master_google_sheet_id", "master_revenue_gid", "master_shifts_gid", "master_modelmap_gid", "revenue_catcher_base_url", "revenue_catcher_start_date", "revenue_catcher_api_key"]:
                if key in form:
                    value = form[key][0]
                    numeric_keys = ["unlock_threshold", "inactivity_threshold_minutes", "low_revenue_per_hour_threshold", "high_revenue_per_hour_threshold", "anomaly_revenue_drop_pct", "anomaly_revenue_spike_pct"]
                    settings[key] = float(value) if key in numeric_keys else value
            if "commission_rules_json" in form:
                try:
                    rules = json.loads(form["commission_rules_json"][0])
                    if not isinstance(rules, list) or not all(isinstance(rule, dict) for rule in rules):
                        raise ValueError
                except (json.JSONDecodeError, ValueError):
                    return self.respond("Commission plans must be a JSON list of plan objects.", HTTPStatus.BAD_REQUEST)
                settings["commission_rules"] = rules
            save_settings(settings)
            return self.redirect("/settings?saved=1")
        if parsed.path == "/edit-site":
            return self.save_site_block()
        if parsed.path == "/delete-site-block":
            return self.delete_site_block()
        if parsed.path == "/move-site-block":
            return self.move_site_block()
        if parsed.path == "/permission-groups":
            return self.save_permission_groups()
        if parsed.path == "/people-access":
            return self.save_people_access()
        return self.respond("Not found", HTTPStatus.NOT_FOUND)

    def session_role(self) -> str | None:
        session = self.session_context()
        return session[0] if session else None

    def session_user(self) -> str:
        session = self.session_context()
        return session[1] if session else "anne"

    def session_context(self) -> tuple[str, str] | None:
        if not auth_enabled():
            return "admin", "anne"
        cookies = self.headers.get("Cookie", "")
        for cookie in cookies.split(";"):
            if "=" not in cookie:
                continue
            name, value = cookie.strip().split("=", 1)
            if name == SESSION_COOKIE:
                return session_from_token(value)
        return None

    def is_authenticated(self) -> bool:
        return bool(self.session_role())

    def login_page(self, error: str = ""):
        message = f"<p class='login-error'>{html.escape(error)}</p>" if error else ""
        return page_shell(
            "Login",
            f"""
            <section class="login-panel">
              <img class="login-mark" src="/static/favicon.png" alt="GAZE">
              <h2>GAZE</h2>
              <p>Your business seer</p>
              {message}
              <form method="post" action="/login" class="login-form">
                <label>Username<input name="username" autocomplete="username" autofocus placeholder="anne"></label>
                <label>Password<span class="password-field"><input type="password" name="password" autocomplete="current-password"><button type="button" class="password-toggle" aria-label="Show password">Show</button></span></label>
                <button>Sign In</button>
              </form>
              <footer>MD Agency &middot; internal command hub</footer>
            </section>
            """,
        )

    def login(self):
        length = int(self.headers.get("Content-Length", 0))
        form = parse_qs(self.rfile.read(length).decode("utf-8"))
        password = form.get("password", [""])[0]
        username = form.get("username", [""])[0].strip().lower()
        people = shared_people()
        user_key = next(
            (
                key for key, profile in people.items()
                if username in {key.lower(), str(profile.get("username", "")).lower(), str(profile.get("name", "")).lower()}
            ),
            username,
        )
        role = None
        profile = people.get(user_key, {})
        profile_match = isinstance(profile, dict) and verify_profile_password(password, profile.get("password_hash"))
        if profile_match:
            role = str(profile.get("role") or "viewer")
        elif app_password() and hmac.compare_digest(password, app_password() or ""):
            role = "admin"
            user_key = "anne"
        else:
            shared_match = bool(viewer_password() and hmac.compare_digest(password, viewer_password() or ""))
            if shared_match:
                role = str(profile.get("role") or "viewer") if isinstance(profile, dict) else "viewer"
            if role == "admin":
                user_key = "anne"
            elif role == "viewer" and (user_key not in shared_people() or shared_people().get(user_key, {}).get("role") == "admin"):
                user_key = "damian"
        if not role:
            return self.respond(self.login_page("Incorrect password."), HTTPStatus.UNAUTHORIZED)
        token = make_session_token(role, user_key)
        self.send_response(HTTPStatus.SEE_OTHER)
        self.send_header("Location", "/")
        self.send_header("Set-Cookie", f"{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax")
        self.end_headers()

    def welcome(self, params):
        profile = person_profile()
        enter_href = "/c-hub/executive-overview"
        bot_src = WELCOME_BOT_BY_USER.get(profile["key"], DEFAULT_WELCOME_BOT)
        content = f"""
        <section class="welcome-page">
          <div class="welcome-layout">
            <div class="welcome-bot-wrap" aria-hidden="true">
              <img class="welcome-bot" src="{html.escape(bot_src)}" alt="">
            </div>
            <div class="welcome-copy">
              <p class="welcome-greeting"><span class="wave-hand" aria-hidden="true">👋</span> Hi, {html.escape(profile["name"])}.</p>
              <h2>Welcome to GAZE.</h2>
              <h3>Ready to see the bigger picture?</h3>
              <p>Get a clear view of what&rsquo;s happening across the business - performance, revenue, teams, and key insights, all in one place.</p>
              <a class="welcome-logo-link" href="{html.escape(enter_href)}" aria-label="Enter GAZE and open Executive Overview">
                <img src="/static/gaze-wordmark.png" alt="Enter GAZE">
              </a>
            </div>
          </div>
        </section>
        """
        return page_shell("Welcome to GAZE", content)

    def overview(self, params):
        ctx = current_context(params)
        current_summary = live_summary_period(ctx["settings"], ctx["start"], ctx["end"], ctx["filters"])
        previous_summary = live_summary_period(ctx["settings"], ctx["comp_start"], ctx["comp_end"], ctx["filters"])
        m = executive_metrics(ctx["current"], ctx["previous"])
        m = apply_scheduled_hours(m, ctx["all_data"], ctx["start"], ctx["end"], ctx["filters"])
        summary_only = not has_entity_revenue(ctx["current"], "creator") and ctx["current"]["revenue"].dropna().gt(0).any() if not ctx["current"].empty else False
        if summary_only:
            m = apply_summary_revenue(m, current_summary, previous_summary)
        median_chatter_revenue = median_revenue_per_entity(ctx["current"], "chatter")
        revenue_delta = fmt_pct(m["revenue_change_pct"])
        # Use Flow's server-side Manager Dashboard aggregation. Transaction
        # exports are retained for Gaze analysis, but are not substituted here:
        # their status and agency-cut rules do not reproduce Flow's totals.
        flow_manager = flow_manager_dashboard_summary(ctx["settings"], ctx["start"], ctx["end"], ctx["filters"])
        if flow_manager.get("available"):
            flow_manager_gross = fmt_native_money(flow_manager.get("gross"), flow_manager.get("currency", DISPLAY_CURRENCY.get()))
            flow_manager_net = fmt_native_money(flow_manager.get("net"), flow_manager.get("currency", DISPLAY_CURRENCY.get()))
            flow_manager_note = "exact Flow Manager Dashboard total"
        else:
            manager_rows = load_postgres_flow_manager_transactions(ctx["start"], ctx["end"])
            manager_rows = filter_period(manager_rows, ctx["start"], ctx["end"], ctx["filters"]) if not manager_rows.empty else manager_rows
            manager_totals = flow_manager_dashboard_totals(manager_rows)
            flow_manager_gross = fmt_money(manager_totals.get("gross"))
            flow_manager_net = fmt_money(manager_totals.get("net"))
            flow_manager_note = "Flow database · company-cut and settlement rules"
        cards = [
            ("Total Revenue", fmt_money(m["total_revenue"]), f"% \u0394 {revenue_delta}" if revenue_delta != "n/a" else "% \u0394 n/a"),
            ("Flow Manager Gross", flow_manager_gross, flow_manager_note),
            ("Flow Manager Net", flow_manager_net, flow_manager_note),
            ("Revenue / Hour", "needs shifts" if summary_only else fmt_money(m["revenue_per_hour"]), "hours endpoint" if summary_only else "selected period"),
            ("Active Chatters", "needs shifts" if summary_only else str(m["active_chatters"]), "shifts/export" if summary_only else "distinct"),
            ("Active Creators", "needs detail" if summary_only else str(m["active_creators"]), "creator endpoint" if summary_only else "distinct"),
            ("Total Hours", fmt_num(m["total_hours"]), "shift hours"),
            ("Total Inactivity", fmt_num((m["total_inactivity"] or 0) / 60) if m["total_inactivity"] is not None else "n/a", "inactive hours"),
            ("Median / Chatter", "needs detail" if summary_only else fmt_money(median_chatter_revenue), "median"),
            ("Avg / Creator", "needs detail" if summary_only else fmt_money(m["avg_revenue_per_creator"]), "average"),
        ]
        today = business_today(ctx["settings"])
        mtd_start = date(today.year, today.month, 1)
        prev_month_start, prev_month_end = previous_month_same_days(mtd_start, today)
        trend_filters = {}
        trend_data = merge_live_revenue_catcher(
            analytics_frame(load_transactions(prev_month_start, today)),
            ctx["settings"],
            mtd_start,
            today,
            prev_month_start,
            prev_month_end,
        )
        mtd_data = trend_data
        prev_month_data = trend_data
        mtd_current = filter_period(mtd_data, mtd_start, today, trend_filters)
        prev_month_current = filter_period(prev_month_data, prev_month_start, prev_month_end, trend_filters)
        current_trend_summary = revenue_summary_period_from_frame(trend_data, mtd_start, today, trend_filters)
        previous_trend_summary = revenue_summary_period_from_frame(trend_data, prev_month_start, prev_month_end, trend_filters)
        chart_data = {
            "trend": daily_trend_rows(current_trend_summary if not current_trend_summary.empty else mtd_current, mtd_start, today, mtd_current),
            "previousMonthTrend": daily_trend_rows(previous_trend_summary if not previous_trend_summary.empty else prev_month_current, prev_month_start, prev_month_end, prev_month_current),
            "previousMonthLabel": f"{prev_month_start:%b} {prev_month_start.day} - {prev_month_end:%b} {prev_month_end.day}",
            "platform": trend(ctx["current"], "platform"),
            "team": trend(ctx["current"], "team"),
            "language": trend(ctx["current"], "language"),
        }
        content = filter_bar(ctx)
        if flow_manager.get("available"):
            content += (
                "<section class='notice compact-source'><strong>Flow Manager Gross / Net:</strong> "
                "these are the exact totals returned by Flow's Manager Dashboard for the selected company-wide date range.</section>"
            )
        else:
            content += (
                "<section class='notice compact-source'><strong>Flow Manager Gross / Net:</strong> "
                "these totals come directly from Flow's company-visible transaction view, using its company-cut, refund, "
                "chargeback, and settlement rules.</section>"
            )
        if summary_only:
            content += coverage_notice("overview")
        content += '<section class="kpi-grid">' + "".join(kpi_card_html(a, b, c) for a, b, c in cards) + "</section>"
        content += (
            "<section class='panel trend-panel'>"
            "<div class='panel-heading-row'>"
            "<div><h2>Revenue Trend</h2>"
            f"<p class='note'>Month to date: {mtd_start} to {today}</p></div>"
            "<button class='button ghost trend-compare-toggle' type='button' data-compare-label='Previous month'>Compare to Previous Month</button>"
            "</div>"
            "<div id='trendChart' class='chart trend-chart'></div>"
            "</section>"
        )
        content += "<section class='panel'><h2>Revenue by Type</h2>" + table_html(revenue_type_breakdown(ctx["current"])) + "</section>"
        content += f"<script>window.chartData={json.dumps(chart_data, default=str)};</script>"
        return page_shell("Executive Overview", content)

    def revenue(self, params):
        ctx = current_context(params)
        content = filter_bar(ctx)
        if not has_entity_revenue(ctx["current"], "creator") or not has_entity_revenue(ctx["current"], "chatter"):
            content += coverage_notice("overview")
        creator_rows = group_performance(ctx["current"], ctx["previous"], "creator") if has_entity_revenue(ctx["current"], "creator") else pd.DataFrame()
        chatter_rows = group_performance(ctx["current"], ctx["previous"], "chatter") if has_entity_revenue(ctx["current"], "chatter") else pd.DataFrame()
        content += "<section class='panel'><h2>Revenue by Type</h2>" + table_html(revenue_type_breakdown(ctx["current"])) + "</section>"
        content += "<section class='stacked-panels'><div class='panel'><h2>By Creator</h2>" + table_html(creator_rows) + "</div>"
        content += "<div class='panel'><h2>By Chatter</h2>" + table_html(chatter_rows) + "</div></section>"
        return page_shell("Revenue", content)

    def chatters(self, params):
        ctx = current_context(params)
        perf = group_performance(ctx["current"], ctx["previous"], "chatter").reset_index(drop=True)
        if not perf.empty:
            perf.insert(0, "rank", range(1, len(perf) + 1))
        content = filter_bar(ctx)
        if not has_entity_revenue(ctx["current"], "chatter"):
            content += coverage_notice("chatters")
        content += "<section class='panel'><h2>Chatter Performance</h2>" + table_html(perf if has_entity_revenue(ctx["current"], "chatter") else pd.DataFrame()) + "</section>"
        lookup = load_chatter_lookup()
        if not lookup.empty:
            content += "<section class='panel'><h2>Revenue Catcher Chatter Directory</h2>" + table_html(lookup, 300) + "</section>"
        content += "<p class='note'>Use revenue/hour, inactivity, and change columns to spot top performers, improvements, declines, high hours with low revenue, and high inactivity.</p>"
        return page_shell("Chatters", content)

    def creators(self, params):
        ctx = current_context(params)
        content = filter_bar(ctx)
        if not has_entity_revenue(ctx["current"], "creator"):
            content += coverage_notice("creators")
        rows = creator_performance(ctx["current"], ctx["previous"]) if has_entity_revenue(ctx["current"], "creator") else pd.DataFrame()
        content += "<section class='panel'><h2>Creator Performance</h2>" + table_html(rows) + "</section>"
        lookup = load_creator_lookup()
        if not lookup.empty:
            content += "<section class='panel'><h2>Revenue Catcher Creator Directory</h2>" + table_html(lookup, 200) + "</section>"
        return page_shell("Creators", content)

    def platforms(self, params):
        ctx = current_context(params)
        content = filter_bar(ctx)
        if not has_real_platform_revenue(ctx["current"]):
            content += coverage_notice("platforms")
        rows = group_performance(ctx["current"], ctx["previous"], "platform") if has_real_platform_revenue(ctx["current"]) else pd.DataFrame()
        content += "<section class='panel'><h2>Platform Performance</h2>" + table_html(rows) + "</section>"
        content += "<section class='panel'><h2>Revenue by Type</h2>" + table_html(revenue_type_breakdown(ctx["current"])) + "</section>"
        return page_shell("Platforms", content)

    def inactivity(self, params):
        ctx = current_context(params)
        current_data = inactivity_context_data(ctx, ctx["start"], ctx["end"])
        previous_data = inactivity_context_data(ctx, ctx["comp_start"], ctx["comp_end"])
        current_rows = postgres_inactivity_rows(current_data)
        previous_rows = postgres_inactivity_rows(previous_data)
        monitor = postgres_inactivity_summary(current_rows)
        previous_monitor = postgres_inactivity_summary(previous_rows)
        base_url = ctx["settings"].get("revenue_catcher_base_url", "https://revenuecatcher-production.up.railway.app").rstrip("/")
        manager_url = f"{base_url}/manager/inactivity?from={ctx['start']}&to={ctx['end']}"
        cards = [
            ("Events", f"{monitor['events']:,}", compare_note(monitor["events"], previous_monitor["events"])),
            ("Peak Unread", f"{monitor['peak_unread']:,}", compare_note(monitor["peak_unread"], previous_monitor["peak_unread"])),
            ("Total Hours", f"{monitor['total_hours']:,.1f}h", compare_note(monitor["total_hours"], previous_monitor["total_hours"])),
            ("Money Wasted", fmt_money(monitor["money_wasted"]), compare_note(monitor["money_wasted"], previous_monitor["money_wasted"])),
            ("Highest Risk", monitor["worst_name"], fmt_money(monitor["worst_money"])),
        ]
        table = postgres_inactivity_table(current_rows).rename(columns={
            "chatter": "Chatter",
            "events": "Events",
            "creators": "Creators",
            "platforms": "Platforms",
            "peak_unread": "Peak unread",
            "total_hours": "Total hours",
            "max_hours": "Max hours",
            "avg_cost_per_hour": "Avg cost / hour",
            "money_wasted": "Money wasted",
        })
        tier_table = postgres_inactivity_tier_table(current_rows, current_data).rename(columns={
            "creator_tier": "Creator tier",
            "events": "Events",
            "models": "Models",
            "shift_hours": "Shift hours",
            "scheduled_hours": "Scheduled inactive hours",
            "inactivity_pct": "Inactivity %",
            "avg_cost_per_hour": "Avg cost / hour",
            "money_wasted": "Money wasted",
        })
        if not table.empty:
            table["Total hours"] = table["Total hours"].apply(lambda value: f"{float(value):,.1f}h")
            table["Max hours"] = table["Max hours"].apply(lambda value: f"{float(value):,.1f}h")
        if not tier_table.empty:
            tier_table["Shift hours"] = tier_table["Shift hours"].apply(lambda value: f"{float(value):,.1f}h")
            tier_table["Scheduled inactive hours"] = tier_table["Scheduled inactive hours"].apply(lambda value: f"{float(value):,.1f}h")
            tier_table["Inactivity %"] = tier_table["Inactivity %"].apply(lambda value: f"{float(value):,.1f}%")
        insights = []
        if not current_rows.empty:
            grouped = postgres_inactivity_table(current_rows)
            top_money = grouped.sort_values("money_wasted", ascending=False).iloc[0]
            top_unread = grouped.sort_values("peak_unread", ascending=False).iloc[0]
            top_hours = grouped.sort_values("total_hours", ascending=False).iloc[0]
            insights = [
                f"{top_money['chatter']} has the highest estimated money wasted at {fmt_money(top_money['money_wasted'])}.",
                f"{top_unread['chatter']} has the highest peak unread count at {int(top_unread['peak_unread']):,}.",
                f"{top_hours['chatter']} has the largest inactivity duration at {float(top_hours['total_hours']):,.1f} hours.",
            ]
            insights.append(f"Money wasted is {compare_note(monitor['money_wasted'], previous_monitor['money_wasted'])}.")
        else:
            insights.append("No PostgreSQL inactivity episodes were found for the selected filters/date range.")
        content = filter_bar(ctx, include_transaction_type=False)
        content += (
            "<p><a class='button ghost' "
            f"href='{html.escape(manager_url)}' target='_blank' rel='noopener'>Open RevenueCatcher Inactivity</a></p>"
        )
        content += (
            "<section class='notice compact-source'>"
            "<strong>Money wasted calculation:</strong> "
            "only inactivity minutes that overlap a scheduled shift are counted. "
            "Main formula: scheduled inactive hours x model tips + messages per scheduled hour for the same CET sales interval. "
            "Per-tier formula: sum each tier's hourly scheduled inactive time x that tier's weighted average model revenue/hour for that CET interval. "
            "If a model has too little revenue history for the selected period, GAZE uses the RevenueCatcher creator tier as fallback/cap context so the estimate stays realistic."
            "</section>"
        )
        content += self.kpi_cards(cards)
        content += "<section class='grid-2'>"
        content += (
            "<div class='panel'><h2>Summary</h2>"
            "<p class='answer'>This period shows "
            + html.escape(fmt_money(monitor["money_wasted"]))
            + " in estimated money wasted across "
            + html.escape(f"{monitor['total_hours']:,.1f}")
            + " scheduled inactivity hours. GAZE recalculates this from the portion of each inactivity episode that overlaps a real shift, then prices it from the model's selected-period tips + messages per scheduled hour, using the RevenueCatcher creator tier only as a fallback/cap when needed.</p></div>"
        )
        content += "<div class='panel'><h2>Insights</h2><ul class='insight-list'>" + "".join(f"<li>{html.escape(item)}</li>" for item in insights) + "</ul></div>"
        content += "</section>"
        content += "<section class='panel inactivity-board'><h2>Tier Computation</h2>" + table_html(tier_table) + "</section>"
        content += "<section class='panel inactivity-board'><h2>Inactivity Analysis</h2>" + table_html(table) + "</section>"
        return page_shell("Inactivity", content)
    def transactions(self, params):
        ctx = current_context(params)
        threshold = float(params.get("threshold", [ctx["settings"].get("unlock_threshold", 199)])[0])
        tx_type = [value for value in params.get("tx_type", ["tip", "message"]) if value]
        rows = transaction_analysis(ctx["current"], threshold, tx_type) if has_entity_revenue(ctx["current"], "creator") or has_entity_revenue(ctx["current"], "chatter") else pd.DataFrame()
        content = filter_bar(ctx) + coverage_notice("transactions")
        values = selectable_transaction_types(ctx["all_data"])
        opts = "".join(f"<option value='{html.escape(v)}' {'selected' if v in tx_type else ''}>{html.escape(v)}</option>" for v in values)
        content += f"<form class='filters'><label>Transaction Type<select name='tx_type' multiple size='4'>{opts}</select><span class='field-help'>Hold Ctrl to pick more than one</span></label><label>Amount Threshold<input type='number' name='threshold' value='{threshold}' step='1'></label><button>Find</button></form>"
        content += "<section class='panel'><h2>High-Value Transactions</h2>" + table_html(rows[["creator", "date", "timestamp", "amount", "transaction_type", "chatter", "chatter_status", "platform"]] if not rows.empty else rows) + "</section>"
        content += "<p><a class='button' href='/export/transactions?format=csv'>Export CSV</a> <a class='button' href='/export/transactions?format=xlsx'>Export Excel</a></p>"
        return page_shell("Transactions", content)

    def commissions(self, params):
        ctx = current_context(params)
        finance_rows = finance_source_frame(ctx)
        finance = finance_breakdown(finance_rows, ctx["settings"])
        scheduled_salary_rows = load_postgres_scheduled_shifts(ctx["start"], ctx["end"])
        commission_costs, team_commissions, chatter_commissions = commission_cost_breakdown(finance_rows, ctx["current"], ctx["settings"], scheduled_salary_rows)
        flow_bonus_total = float(pd.to_numeric(chatter_commissions.get("flow_bonus", pd.Series(dtype=float)), errors="coerce").fillna(0).sum())
        base_commission_total = float(pd.to_numeric(chatter_commissions.get("base_commission", pd.Series(dtype=float)), errors="coerce").fillna(0).sum())
        management_allocations, chat_manager_cuts = management_allocation_breakdown(finance_rows, finance)
        operating_expenses, department_expenses = operating_expense_breakdown(ctx["settings"], ctx["start"], ctx["end"])
        # Salary is a direct revenue cost, never an operating expense as well.
        total_operating_expenses = operating_expenses["period_eur_reporting"]
        reported_flow_net_amount = finance.get("reported_flow_net_amount")
        finance = financial_ledger(
            gross_revenue=finance.get("gross_revenue"),
            platform_fees=finance.get("platform_share"),
            creator_share=finance.get("creator_share"),
            partner_share=finance.get("partner_share"),
            other_external=finance.get("other_share"),
            chatter_commission=base_commission_total,
            chatter_bonus=flow_bonus_total,
            chatter_salary=commission_costs["salary_cost"],
            manager_commission=management_allocations["chat_manager_cuts"],
            other_direct_costs=0.0,
            operating_expenses=total_operating_expenses,
            source=finance.get("source", ""),
        )
        finance["reported_flow_net_amount"] = reported_flow_net_amount
        breakdown, pnl = finance_breakdown_tables(finance)
        attribution_audit = commission_attribution_audit(finance_rows)
        md_earnings_after_expenses = management_allocations["admin_management_pool"] - total_operating_expenses
        dutch_english_costs = dutch_english_cost_breakdown(finance_rows, ctx["current"], ctx["settings"], scheduled_salary_rows)
        plans = commission_plan_table(ctx["settings"])
        content = filter_bar(ctx) + coverage_notice("commissions")
        content += finance_cards_html(finance)
        content += '<section class="kpi-grid finance-kpi-grid">' + "".join([
            kpi_card_html("Chatter Base Commission", fmt_money(base_commission_total), "Flow chatter rates", "chatter_commission"),
            kpi_card_html("Flow Chatter Bonus", fmt_money(flow_bonus_total), "daily Flow bonus rules", "chatter_bonus"),
            kpi_card_html("Chatter Commission", fmt_money(commission_costs["pre_salary_commission"]), "base commission plus Flow bonus", "chatter_commission"),
            kpi_card_html("Chatter Salary", fmt_money(commission_costs["salary_cost"]), "recorded salary or plan hourly rate", "chatter_salary"),
            kpi_card_html("Commission After Salary", fmt_money(commission_costs["post_salary_commission"]), "commission less salary cost"),
            kpi_card_html("Chat Manager Cuts", fmt_money(management_allocations["chat_manager_cuts"]), "Flow's dated team-manager rate", "manager_commission"),
            kpi_card_html("Admin & Management Pool", fmt_money(management_allocations["admin_management_pool"]), "company net less recorded chat-manager cuts"),
            kpi_card_html("Operating Expenses", fmt_money(total_operating_expenses), f"fixed department costs only · €{operating_expenses['period_eur']:,.2f} + ${operating_expenses['period_usd']:,.2f}", "operating_expenses"),
            kpi_card_html("MD Earnings After Expenses", fmt_money(md_earnings_after_expenses), "management allocation view; not a P&L", "md_earnings_after_expenses"),
        ]) + "</section>"
        content += (
            "<section class='panel'><div class='panel-heading-row'><div><h2>Gross and Net Rev Breakdown</h2>"
            "<p class='note'>Gross Rev is total money earned. Net Rev is the MD/company share after tracked RevenueCatcher splits, chatter commission, and manager commission.</p></div></div>"
            + table_html(breakdown)
            + "</section>"
        )
        content += (
            "<section class='panel'><div class='panel-heading-row'><div><h2>Profit and Loss</h2>"
            "<p class='note'>P&L uses tracked RevenueCatcher split fields first; when they are unavailable, GAZE falls back to the configured commission rules.</p></div></div>"
            + table_html(pnl)
            + "</section>"
        )
        content += (
            "<section class='panel'><div class='panel-heading-row'><div><h2>Chatter Commission by Team</h2>"
            "<p class='note'>Flow's dated chatter rate and team assignment are used first. A Gaze plan is used only when Flow has no rate. Revenue with no attributed chatter is never treated as a payable commission.</p></div></div>"
            + table_html(team_commissions)
            + "</section>"
        )
        content += (
            "<section class='panel'><div class='panel-heading-row'><div><h2>Flow Payout Attribution Audit</h2>"
            "<p class='note'>This separates payable commission from transactions Flow has not attributed. It prevents unassigned revenue from inflating team costs and makes the remaining data fixes explicit.</p></div></div>"
            + table_html(attribution_audit)
            + "</section>"
        )
        content += (
            "<section class='panel'><div class='panel-heading-row'><div><h2>Chat Manager Allocation</h2>"
            "<p class='note'>Manager cuts are calculated from Flow's effective-dated team-manager percentage. The Admin &amp; Management Pool is retained company net after those cuts; it is not presented as paid payroll because Flow has no admin-payroll payout record.</p></div></div>"
            + table_html(chat_manager_cuts)
            + "</section>"
        )
        content += (
            "<section class='panel'><div class='panel-heading-row'><div><h2>Department Operating Expenses</h2>"
            "<p class='note'>Monthly personnel costs are shown in their original EUR and USD currencies. Selected-period cost is accrued by actual calendar days and converted to EUR at Flow’s reporting FX rate. English chatter salary is calculated separately at $2 per worked hour; Dutch chatters are commission-only. Maurice is excluded here because he is paid by commission.</p></div></div>"
            + table_html(department_expenses)
            + "</section>"
        )
        content += (
            "<section class='panel'><div class='panel-heading-row'><div><h2>Dutch and English Team Costs</h2>"
            "<p class='note'>Total cost includes non-chatter tracked costs, chatter commission before salary, and salary cost. Team rows are always shown separately, even when no revenue is recorded for one team.</p></div></div>"
            + table_html(dutch_english_costs)
            + "</section>"
        )
        content += "<section class='panel'><h2>Chatter Commission Detail</h2>" + table_html(chatter_commissions) + "</section>"
        content += "<section class='panel'><h2>Commission Plan</h2><p class='note'>The most specific active plan matching platform, creator, chatter, and team is used.</p>" + table_html(plans) + "</section>"
        rows = commission_analysis(ctx["current"], ctx["settings"]) if has_entity_revenue(ctx["current"], "creator") else pd.DataFrame()
        if not finance_rows.empty and "creator" in finance_rows:
            creator_working = finance_rows.copy()
            for column in ["revenue", "net_amount", "md_net_amount", "creator_net_amount", "partner_net_amount", "other_net_amount", "chatter_net_amount", "manager_net_amount", "platform_net_amount"]:
                if column not in creator_working:
                    creator_working[column] = 0
                creator_working[column] = pd.to_numeric(creator_working[column], errors="coerce").fillna(0)
            if not creator_working["md_net_amount"].abs().gt(0).any() and creator_working["net_amount"].abs().gt(0).any():
                creator_working["md_net_amount"] = creator_working["net_amount"]
            creator_summary = (
                creator_working.groupby("creator", dropna=False)[["revenue", "md_net_amount", "creator_net_amount", "partner_net_amount", "other_net_amount", "chatter_net_amount", "manager_net_amount", "platform_net_amount"]]
                .sum()
                .reset_index()
                .rename(columns={
                    "revenue": "gross_rev",
                    "md_net_amount": "net_rev",
                    "creator_net_amount": "creator_share",
                    "partner_net_amount": "partner_share",
                    "other_net_amount": "other_share",
                    "chatter_net_amount": "chatter_commission",
                    "manager_net_amount": "manager_commission",
                    "platform_net_amount": "platform_share",
                })
                .sort_values("gross_rev", ascending=False)
            )
            content += "<section class='panel'><h2>Creator Gross and Net Rev</h2>" + table_html(creator_summary) + "</section>"
        elif not rows.empty:
            summary = rows[["revenue", "creator_commission", "external_partner_commission", "other_commission", "chatter_payout", "company_net_revenue"]].sum().to_frame("amount").reset_index()
            content += "<section class='panel'><h2>Fallback Commission Summary</h2>" + table_html(summary) + "</section>"
        return page_shell("Commissions", content)

    def insights(self, params):
        ctx = current_context(params)
        facts = factual_insights(ctx["current"], ctx["previous"])
        flags = anomalies(ctx["current"], ctx["previous"], ctx["settings"])
        content = filter_bar(ctx) + "<section class='panel'><h2>Deterministic Insights</h2><ul>" + "".join(f"<li>{html.escape(x)}</li>" for x in facts) + "</ul></section>"
        content += "<section class='panel'><h2>Anomaly Flags</h2>" + ("".join(f"<p><strong>{f['area']} - {html.escape(str(f['name']))}:</strong> {html.escape(f['message'])}<br><span>{html.escape(f['why'])}</span></p>" for f in flags) or "<p>No anomalies flagged.</p>") + "</section>"
        return page_shell("Insights", content)

    def revenue_tiers(self, params):
        ctx = current_context(params)
        tier_source = model_revenue_source(ctx["current"])
        source_note = "Revenue tiers are using detailed database tip and message revenue rows for this date range."
        if tier_source.empty:
            live = live_revenue_catcher_frame(ctx["settings"], ctx["start"], ctx["end"])
            if not live.empty:
                live = analytics_frame(live, preserve_shift_revenue=True)
                live_current = filter_period(live, ctx["start"], ctx["end"], ctx["filters"])
                live_source = model_revenue_source(live_current)
                if not live_source.empty:
                    tier_source = live_source
                    live_type = live_source["transaction_type"].fillna("").astype(str).str.lower().str.strip()
                    if live_type.eq("shift_summary").all():
                        source_note = "Revenue tiers are using Revenue Catcher shift-history tips and messages because detailed database transactions were not available for this range."
                    else:
                        source_note = "Revenue tiers are using Revenue Catcher detailed tip and message rows for this range."
        data = build_revenue_tiers(tier_source, ctx["start"], ctx["end"])
        for record in data["metric_records"]:
            try:
                record_calculated_metric(
                    record["metric_name"],
                    ctx["start"].isoformat(),
                    ctx["end"].isoformat(),
                    record["value"],
                    record["details"],
                )
            except Exception:
                pass

        by_model = data["by_model"].copy()
        total_revenue = float(by_model["selected_revenue"].sum()) if not by_model.empty else 0.0
        tier_a = int((by_model["weekly_tier"] == "A").sum()) if not by_model.empty else 0
        tier_b = int((by_model["weekly_tier"] == "B").sum()) if not by_model.empty else 0
        tier_c = int((by_model["weekly_tier"] == "C").sum()) if not by_model.empty else 0
        strongest = by_model.iloc[0]["model"] if not by_model.empty else "n/a"

        content = filter_bar(ctx)
        content += (
            "<section class='panel tier-note'>"
            "<strong>Tier guide:</strong> Based on tips + messages only. Daily A starts at EUR 1,430, weekly A starts at EUR 10,000, and monthly A starts at EUR 40,000. "
            "The page converts the selected date range into daily, weekly, and monthly pace so every model is recorded by tier. "
            f"{html.escape(source_note)}"
            "</section>"
        )
        content += self.kpi_cards(
            [
                ("Tier Revenue", fmt_money(total_revenue), f"tips + messages only, {data['days']} days"),
                ("Weekly Tier A", str(tier_a), "models pacing at EUR 10k+"),
                ("Weekly Tier B", str(tier_b), "models pacing EUR 5k-10k"),
                ("Weekly Tier C", str(tier_c), "models below EUR 5k"),
                ("Top Model Pace", str(strongest), "ranked by weekly revenue pace"),
            ]
        )
        content += "<section class='grid-2'>"
        content += "<article class='panel c-chart-card tier-mix-panel'><h2>Weekly Tier Mix</h2><div class='tier-mix-content'>" + c_donut_chart(data["weekly_mix"], "tier", "models", "/revenue-tiers") + tier_roster(data["tier_assignments"]["weekly"]) + "</div></article>"
        content += "<article class='panel c-chart-card'><h2>Top Weekly Model Pace</h2>" + c_column_chart(data["top_models"], "model", "weekly_revenue", "/revenue-tiers", fmt_money, 12) + "</article>"
        content += "</section>"
        content += "<section class='grid-2'>"
        content += "<article class='panel'><h2>Tier Thresholds</h2>" + table_html(data["thresholds"], 20) + "</article>"
        content += "<article class='panel'><h2>Tier Summary</h2>" + table_html(data["tier_summary"], 20) + "</article>"
        content += "</section>"
        content += "<section class='grid-3'>"
        content += "<article class='panel'><h2>Daily Model Assignments</h2>" + table_html(data["tier_assignments"]["daily"], 300) + "</article>"
        content += "<article class='panel'><h2>Weekly Model Assignments</h2>" + table_html(data["tier_assignments"]["weekly"], 300) + "</article>"
        content += "<article class='panel'><h2>Monthly Model Assignments</h2>" + table_html(data["tier_assignments"]["monthly"], 300) + "</article>"
        content += "</section>"
        content += "<section class='panel'><h2>Model Revenue Tiers</h2>" + table_html(by_model, 300) + "</section>"
        return page_shell("Revenue Tiers", content)

    def weekly_report_page(self, params):
        ctx = report_context(params, "weekly")
        report = generate_report(ctx["current"], ctx["previous"], ctx["settings"], ctx["start"], ctx["end"], "weekly")
        content = filter_bar(ctx)
        content += "<section class='panel'><h2>Management Summary</h2><pre class='report'>" + html.escape(management_summary(report)) + "</pre></section>"
        content += "<section class='panel'><h2>Weekly Report</h2><pre class='report'>" + html.escape(formatted_report(report)) + "</pre></section>"
        return page_shell("Weekly Report", content)

    def monthly_report_page(self, params):
        ctx = report_context(params, "monthly")
        report = generate_report(ctx["current"], ctx["previous"], ctx["settings"], ctx["start"], ctx["end"], "monthly")
        content = filter_bar(ctx)
        content += "<section class='panel'><h2>Management Summary</h2><pre class='report'>" + html.escape(management_summary(report)) + "</pre></section>"
        content += "<section class='panel'><h2>Monthly Report</h2><pre class='report'>" + html.escape(formatted_report(report)) + "</pre></section>"
        return page_shell("Monthly Report", content)

    def ask(self, params):
        ctx = current_context(params)
        question = params.get("question", ["Who improved the most?"])[0]
        chatter = group_performance(ctx["current"], ctx["previous"], "chatter")
        answer = "No data available for the selected period."
        if not chatter.empty:
            if "improved" in question.lower():
                row = chatter.sort_values("change_amount", ascending=False).iloc[0]
                answer = f"{row['chatter']} improved the most, up {fmt_money(row['change_amount'])}."
            elif "high hours" in question.lower():
                row = chatter.sort_values(["hours", "revenue_per_hour"], ascending=[False, True]).iloc[0]
                answer = f"{row['chatter']} has high hours with relatively low revenue/hour: {fmt_num(row['hours'])} hours and {fmt_money(row['revenue_per_hour'])}/hour."
            elif "highest revenue per hour" in question.lower():
                row = chatter.sort_values("revenue_per_hour", ascending=False).iloc[0]
                answer = f"{row['chatter']} has the highest revenue/hour at {fmt_money(row['revenue_per_hour'])}."
        content = filter_bar(ctx) + f"<section class='panel'><h2>Ask Your Data</h2><form><input class='wide' name='question' value='{html.escape(question)}'><button>Ask</button></form><p class='answer'>{html.escape(answer)}</p></section>"
        return page_shell("Ask Your Data", content)

    def data_quality(self, params):
        issues = load_quality_issues()
        imports = load_imports()
        content = "<section class='grid-2'><div class='panel'><h2>Imports</h2>" + table_html(imports, 50) + "</div><div class='panel'><h2>Issues</h2>" + table_html(issues, 300) + "</div></section>"
        return page_shell("Data Quality", content)

    def data_sources(self, params):
        settings = load_settings()
        mappings = load_mappings()
        rows = "".join(f"<tr><td>{field}</td><td>{STANDARD_FIELDS[field]}</td><td>{html.escape(str(mappings.get(field, '')))}</td></tr>" for field in STANDARD_FIELDS)
        start_date = settings.get("revenue_catcher_start_date", "2026-05-20")
        end_date = date.today().isoformat()
        base_url = settings.get("revenue_catcher_base_url", "https://revenuecatcher-production.up.railway.app").rstrip("/")
        revenue_summary_url = (
            f"{base_url}/api/revenue/summary"
            f"?dateFrom={start_date}&dateTo={end_date}&period=daily"
        )
        revenue_url = f"{base_url}/api/revenue?dateFrom={start_date}&dateTo={end_date}"
        shifts_url = f"{base_url}/api/shifts/export?dateFrom={start_date}&dateTo={end_date}"
        content = f"""
        <section class="panel"><h2>Data Sources</h2>
        <form method="post" action="/save-revenue-catcher-settings" class="settings-form">
          <label>Revenue Catcher Base URL<input name="revenue_catcher_base_url" value="{html.escape(base_url)}"></label>
          <label>Revenue Catcher API Key<input name="revenue_catcher_api_key" type="password" placeholder="{html.escape(api_key_status(settings))}"></label>
          <label>Start Date<input name="revenue_catcher_start_date" type="date" value="{html.escape(start_date)}"></label>
          <button>Save Revenue Catcher API</button>
        </form>
        <form method="post" action="/load-demo"><button>Load DEMO DATA</button></form>
        <form method="post" action="/clear-demo"><button class="danger">Clear DEMO DATA</button></form>
        <form method="post" action="/import-master-sheet"><button>Import Master Google Sheet</button></form>
        <form method="post" action="/import-master-shifts-sheet"><button>Import Master Shifts Sheet</button></form>
        <form method="post" action="/upload" enctype="multipart/form-data"><input type="file" name="file" accept=".csv,.xlsx,.xls"><button>Upload CSV/XLSX</button></form>
        <form method="post" action="/upload-revenue-catcher-json" enctype="multipart/form-data"><input type="file" name="file" accept=".json,.txt"><button>Upload Revenue Catcher JSON</button></form>
        <form method="post" action="/upload-creators-json" enctype="multipart/form-data"><input type="file" name="file" accept=".json,.txt"><button>Upload Creators Directory JSON</button></form>
        <form method="post" action="/upload-chatters-json" enctype="multipart/form-data"><input type="file" name="file" accept=".json,.txt"><button>Upload Chatters Directory JSON</button></form>
        <form method="post" action="/import-revenue-summary-api" class="inline-form">
          <input name="date_from" type="date" value="{html.escape(start_date)}">
          <input name="date_to" type="date" value="{html.escape(end_date)}">
          <button>Import Official Revenue Summary</button>
        </form>
        <p class="note"><strong>Revenue totals endpoint:</strong> <code>{html.escape(revenue_summary_url)}</code></p>
        <form method="post" action="/import-revenue-api" class="inline-form">
          <input name="date_from" type="date" value="{html.escape(start_date)}">
          <input name="date_to" type="date" value="{html.escape(end_date)}">
          <button>Import Official Revenue Rows</button>
        </form>
        <p class="note"><strong>Revenue rows endpoint:</strong> <code>{html.escape(revenue_url)}</code></p>
        <p class="note">The official Revenue Catcher API uses <code>x-api-key</code>. API key status: <strong>{html.escape(api_key_status(settings))}</strong>. Dates default to May 20, 2026 through today's date, so the end date keeps moving forward automatically.</p>
        <form method="post" action="/import-revenue-catcher-api" class="inline-form">
          <input name="date_from" type="date" value="{html.escape(start_date)}">
          <input name="date_to" type="date" value="{html.escape(end_date)}">
          <button>Import Official Closed Shifts</button>
        </form>
        <p class="note"><strong>Closed shifts endpoint:</strong> <code>{html.escape(shifts_url)}</code></p>
        <form method="post" action="/import-active-shifts-api" class="inline-form">
          <input name="url" class="wide" value="https://revenuecatcher-production.up.railway.app/api/shifts/active">
          <button>Import Active Shifts</button>
        </form>
        <p><strong>Master DB:</strong> <a href="https://docs.google.com/spreadsheets/d/1m9dt-YmwTQM58JdXDfVslzxysnSUEWFjlGU3A4FxasQ/edit?gid=759629051#gid=759629051">MD Master Revenue DB</a></p>
        <p><strong>Master Shifts:</strong> <a href="https://docs.google.com/spreadsheets/d/1m9dt-YmwTQM58JdXDfVslzxysnSUEWFjlGU3A4FxasQ/edit?gid=2108008269#gid=2108008269">MD Master Shifts tab</a></p>
        <p><strong>Looker Studio:</strong> <a href="https://datastudio.google.com/u/0/reporting/c53f9edc-30ff-4f99-b90e-c0f651eed59d/page/p_huryau5b4d/edit">open report</a></p>
        <p><strong>Revenue Catcher:</strong> <a href="https://revenuecatcher-production.up.railway.app/manager">open manager</a></p>
        <p><strong>Revenue Catcher Inactivity:</strong> <a href="{html.escape(base_url)}/manager/inactivity?from={html.escape(start_date)}&to={html.escape(end_date)}">open inactivity page</a></p>
        <p class="note"><strong>What is complete now:</strong> The app can use the official external Revenue Catcher API for raw revenue rows, daily revenue summary, and closed shifts once the API key is saved.</p>
        <p class="note">The master Google Sheet import uses the Revenue tab as the transaction feed. The Sheet must allow CSV export by link; otherwise export it manually and upload the file here.</p>
        </section>
        """
        content += f"<section class='panel'><h2>Remembered Schema Mapping</h2><table class='data-table'><tr><th>Standard Field</th><th>Meaning</th><th>Incoming Column</th></tr>{rows}</table></section>"
        return page_shell("Data Sources", content)

    def settings(self, params):
        s = load_settings()
        content = "<section class='panel'><h2>Settings</h2><form method='post' class='settings-form'>"
        for key, value in s.items():
            if key in {"commission_rules", "viewer_allowed_routes", "shared_people", "site_blocks"}:
                continue
            content += f"<label>{key.replace('_', ' ').title()}<input name='{key}' value='{html.escape(str(value))}'></label>"
        content += "<button>Save Settings</button></form></section>"
        plans_json = html.escape(json.dumps(s.get("commission_rules", []), indent=2))
        content += "<section class='panel'><h2>Commission Plan</h2><p class='note'>Add plans here. A plan may match a platform, creator, chatter, team, and effective dates. Set <code>salary_per_hour</code> to calculate post-salary commission.</p><form method='post' class='settings-form'><label>Commission plans (JSON)<textarea name='commission_rules_json' rows='16'>" + plans_json + "</textarea></label><button>Save Commission Plans</button></form>" + table_html(pd.DataFrame(s.get("commission_rules", []))) + "</section>"
        return page_shell("Settings", content)

    def edit_site(self, params):
        blocks = sorted(site_blocks(), key=lambda block: (str(block.get("page", "")), int(block.get("order", 0))))
        selected_page = params.get("page", [blocks[0].get("page") if blocks else "/"])[0]
        block_id = params.get("block", [""])[0]
        editing = next((block for block in blocks if block.get("id") == block_id), None)
        page_value = str((editing or {}).get("page") or selected_page)
        page_options = "".join(
            f"<option value='{html.escape(path)}' {'selected' if path == page_value else ''}>{html.escape(label)}</option>"
            for path, label in editable_pages()
        )
        style = str((editing or {}).get("style") or "note")
        style_options = "".join(
            f"<option value='{value}' {'selected' if value == style else ''}>{label}</option>"
            for value, label in [("note", "Note"), ("highlight", "Highlight"), ("warning", "Important"), ("quiet", "Quiet")]
        )
        title = html.escape(str((editing or {}).get("title") or ""))
        body_raw = str((editing or {}).get("body") or "")
        body_editor = clean_rich_text(body_raw)
        body_value = html.escape(body_raw)
        enabled_checked = "checked" if (editing or {}).get("enabled", True) else ""
        block_rows = []
        if not blocks:
            block_rows.append("<div class='empty'>No editable blocks yet. Add your first one on the right.</div>")
        for block in blocks:
            active = " active" if block.get("id") == block_id else ""
            status = "Visible" if block.get("enabled", True) else "Hidden"
            block_page = str(block.get("page") or "/")
            block_ref = str(block.get("id") or "")
            block_rows.append(
                "<div class='builder-block-row" + active + "'>"
                "<span>"
                f"<strong>{html.escape(str(block.get('title') or 'Untitled block'))}</strong>"
                f"<em>{html.escape(editable_page_label(block_page))} · {status}</em>"
                "</span>"
                "<span class='builder-actions'>"
                f"<a class='button ghost small' href='/edit-site?page={html.escape(block_page)}&block={html.escape(block_ref)}'>Edit</a>"
                f"<form method='post' action='/move-site-block'><input type='hidden' name='id' value='{html.escape(block_ref)}'><input type='hidden' name='direction' value='up'><button class='ghost small'>Up</button></form>"
                f"<form method='post' action='/move-site-block'><input type='hidden' name='id' value='{html.escape(block_ref)}'><input type='hidden' name='direction' value='down'><button class='ghost small'>Down</button></form>"
                f"<form method='post' action='/delete-site-block'><input type='hidden' name='id' value='{html.escape(block_ref)}'><button class='danger small'>Delete</button></form>"
                "</span>"
                "</div>"
            )
        content = f"""
        <section class="panel builder-intro">
          <h2>Edit Site</h2>
          <p>Admin-only editor. Add simple rich-text blocks to any page, then they appear on the site without touching code.</p>
        </section>
        <section class="builder-grid">
          <div class="panel">
            <h2>Saved Blocks</h2>
            <div class="builder-block-list">{''.join(block_rows)}</div>
          </div>
          <div class="panel">
            <h2>{'Edit Block' if editing else 'Add Block'}</h2>
            <form method="post" action="/edit-site" class="builder-form">
              <input type="hidden" name="id" value="{html.escape(str((editing or {}).get('id') or ''))}">
              <label>Page<select name="page">{page_options}</select></label>
              <label>Block Title<input name="title" value="{title}" placeholder="Example: COO notes for tomorrow"></label>
              <label>Style<select name="style">{style_options}</select></label>
              <label class="toggle-row"><input type="checkbox" name="enabled" value="1" {enabled_checked}> Visible on site</label>
              <div class="wysiwyg-toolbar" aria-label="Text tools">
                <button type="button" data-command="bold">B</button>
                <button type="button" data-command="italic">I</button>
                <button type="button" data-command="insertUnorderedList">List</button>
                <button type="button" data-command="formatBlock" data-value="h3">H3</button>
                <button type="button" data-command="formatBlock" data-value="p">P</button>
              </div>
              <div class="wysiwyg-editor" contenteditable="true" data-target="site-block-body">{body_editor}</div>
              <textarea id="site-block-body" name="body" hidden>{body_value}</textarea>
              <button type="submit">{'Save Block' if editing else 'Add Block'}</button>
            </form>
          </div>
        </section>
        """
        return page_shell("Edit Site", content)

    def save_site_block(self):
        length = int(self.headers.get("Content-Length", 0))
        form = parse_qs(self.rfile.read(length).decode("utf-8"))
        settings = load_settings()
        blocks = settings.get("site_blocks") if isinstance(settings.get("site_blocks"), list) else []
        block_id = form.get("id", [""])[0].strip()
        page = form.get("page", ["/"])[0]
        valid_pages = {path for path, _ in editable_pages()}
        if page not in valid_pages:
            page = "/"
        existing = next((block for block in blocks if block.get("id") == block_id), None)
        if not existing:
            existing = {"id": secrets.token_hex(6), "order": len([block for block in blocks if block.get("page") == page]) + 1}
            blocks.append(existing)
        existing.update({
            "page": page,
            "title": form.get("title", ["Untitled block"])[0].strip() or "Untitled block",
            "body": form.get("body", [""])[0].strip(),
            "style": form.get("style", ["note"])[0],
            "enabled": "enabled" in form,
        })
        settings["site_blocks"] = blocks
        save_settings(settings)
        return self.redirect(f"/edit-site?page={page}&block={existing['id']}&saved=1")

    def delete_site_block(self):
        length = int(self.headers.get("Content-Length", 0))
        form = parse_qs(self.rfile.read(length).decode("utf-8"))
        block_id = form.get("id", [""])[0]
        settings = load_settings()
        blocks = settings.get("site_blocks") if isinstance(settings.get("site_blocks"), list) else []
        settings["site_blocks"] = [block for block in blocks if block.get("id") != block_id]
        save_settings(settings)
        return self.redirect("/edit-site")

    def move_site_block(self):
        length = int(self.headers.get("Content-Length", 0))
        form = parse_qs(self.rfile.read(length).decode("utf-8"))
        block_id = form.get("id", [""])[0]
        direction = form.get("direction", ["up"])[0]
        settings = load_settings()
        blocks = settings.get("site_blocks") if isinstance(settings.get("site_blocks"), list) else []
        block = next((item for item in blocks if item.get("id") == block_id), None)
        if not block:
            return self.redirect("/edit-site")
        same_page = sorted([item for item in blocks if item.get("page") == block.get("page")], key=lambda item: int(item.get("order", 0)))
        index = same_page.index(block)
        swap_index = index - 1 if direction == "up" else index + 1
        if 0 <= swap_index < len(same_page):
            same_page[index]["order"], same_page[swap_index]["order"] = same_page[swap_index].get("order", 0), same_page[index].get("order", 0)
        settings["site_blocks"] = blocks
        save_settings(settings)
        return self.redirect(f"/edit-site?page={block.get('page', '/')}&block={block_id}")

    def account(self, params):
        profile = person_profile()
        saved = bool(params.get("saved"))
        password_saved = bool(params.get("password_saved"))
        return page_shell("Account Settings", account_page_content(profile, saved=saved, password_saved=password_saved))

    def save_account(self):
        settings = load_settings()
        people = settings.get("shared_people") if isinstance(settings.get("shared_people"), dict) else {}
        user_key = REQUEST_USER.get()
        profile = people.get(user_key)
        if not isinstance(profile, dict):
            return self.respond("Not found", HTTPStatus.NOT_FOUND)
        content_type = self.headers.get("Content-Type", "")
        if content_type.startswith("multipart/form-data"):
            form = cgi.FieldStorage(fp=self.rfile, headers=self.headers, environ={"REQUEST_METHOD": "POST", "CONTENT_TYPE": content_type})
            for key in ["name", "username", "email", "photo_url"]:
                if key in form:
                    profile[key] = str(form.getfirst(key, "")).strip()
            photo_item = form["photo_file"] if "photo_file" in form else None
            if photo_item is not None and getattr(photo_item, "filename", ""):
                suffix = Path(photo_item.filename).suffix.lower()
                if suffix not in {".png", ".jpg", ".jpeg", ".webp", ".gif"}:
                    suffix = ".png"
                PROFILE_PHOTO_DIR.mkdir(parents=True, exist_ok=True)
                target = PROFILE_PHOTO_DIR / f"{user_key}{suffix}"
                with target.open("wb") as handle:
                    shutil.copyfileobj(photo_item.file, handle)
                profile["photo_url"] = f"/static/profile-photos/{target.name}"
        else:
            length = int(self.headers.get("Content-Length", 0))
            form = parse_qs(self.rfile.read(length).decode("utf-8"))
            for key in ["name", "username", "email", "photo_url"]:
                if key in form:
                    profile[key] = form[key][0].strip()
        if not profile.get("name"):
            profile["name"] = user_key.title()
        if not profile.get("username"):
            profile["username"] = str(profile.get("name", user_key)).lower().replace(" ", ".")
        settings["shared_people"] = people
        save_settings(settings)
        return self.redirect("/account?saved=1")

    def save_account_password(self):
        length = int(self.headers.get("Content-Length", 0))
        form = parse_qs(self.rfile.read(length).decode("utf-8"))
        new_password = form.get("new_password", [""])[0]
        confirm_password = form.get("confirm_password", [""])[0]
        if not new_password or new_password != confirm_password:
            return self.respond(page_shell("Account Settings", account_page_content(person_profile()) + "<section class='notice'><strong>Password not saved:</strong> enter the same password in both boxes.</section>"), HTTPStatus.BAD_REQUEST)
        settings = load_settings()
        people = settings.get("shared_people") if isinstance(settings.get("shared_people"), dict) else {}
        user_key = REQUEST_USER.get()
        profile = people.get(user_key)
        if not isinstance(profile, dict):
            return self.respond("Not found", HTTPStatus.NOT_FOUND)
        profile["password_hash"] = hash_profile_password(new_password)
        settings["shared_people"] = people
        save_settings(settings)
        return self.redirect("/account?password_saved=1")

    def permission_groups(self, params):
        return self.people_access(params)

    def people_access(self, params):
        people = shared_people()
        page_sections = [
            ("Core", CORE_PAGES),
            ("Reports", REPORT_PAGES),
            ("C Hub", C_HUB_PAGES),
            ("Hub", HUB_PAGES),
        ]
        cards = []
        for key, profile in people.items():
            name = str(profile.get("name", key.title()))
            title = str(profile.get("title", "Viewer"))
            role = str(profile.get("role", "viewer"))
            if role == "admin":
                access_rows = "<p class='note'>Admin access: can see and edit everything.</p>"
            else:
                allowed = viewer_allowed_routes(key)
                access_rows = ""
                for section_label, page_rows in page_sections:
                    access_rows += f"<h4>{html.escape(section_label)}</h4>"
                    for path, label in page_rows:
                        checked = " checked" if path in allowed else ""
                        access_rows += (
                            "<label class='permission-row compact'>"
                            f"<input type='checkbox' name='allowed_route__{html.escape(key)}' value='{html.escape(path)}'{checked}>"
                            "<span>"
                            f"<strong>{html.escape(label)}</strong>"
                            f"<em>{'Main C Hub landing page' if path == '/c-hub' else 'Visible when enabled'}</em>"
                            "</span>"
                            "</label>"
                        )
            cards.append(
                "<div class='permission-group-card people-card'>"
                "<div>"
                f"<span class='permission-kicker'>{html.escape(title)}</span>"
                f"<h3>{html.escape(name)}</h3>"
                f"<p>{'You. Full admin/editor access.' if role == 'admin' else 'Choose exactly what this person can open in the shared view.'}</p>"
                "</div>"
                f"<div class='permission-list'>{access_rows}</div>"
                "</div>"
            )
        content = f"""
        <section class="panel permission-panel">
          <h2>People Access</h2>
          <p class="note">Use this when you share GAZE. Pick each person at login, then GAZE only shows the pages you allow here. Admin can still access everything.</p>
          <form method="post" action="/people-access" class="permission-form">
            {''.join(cards)}
            <button type="submit">Save People Access</button>
          </form>
        </section>
        <section class="panel permission-panel">
          <h2>Admin Editing</h2>
          <p class="note">For now, editing is admin-only through simple controls like this page. A true drag-and-drop editor is possible, but it needs a separate build step so changes stay reliable and do not break the shared dashboards.</p>
        </section>
        """
        return page_shell("People Access", content)

    def save_permission_groups(self):
        return self.save_people_access()

    def save_people_access(self):
        length = int(self.headers.get("Content-Length", 0))
        form = parse_qs(self.rfile.read(length).decode("utf-8"))
        valid = SHAREABLE_ROUTES
        settings = load_settings()
        people = settings.get("shared_people") if isinstance(settings.get("shared_people"), dict) else shared_people()
        for key, profile in people.items():
            if not isinstance(profile, dict) or profile.get("role") == "admin":
                continue
            field = f"allowed_route__{key}"
            allowed = [path for path in form.get(field, []) if path in valid]
            profile["allowed_routes"] = allowed
        settings["shared_people"] = people
        save_settings(settings)
        return self.redirect("/people-access?saved=1")

    def metric_definitions(self, params):
        central = "".join(
            f"<p><strong>{html.escape(meta['label'])}:</strong> {html.escape(meta['definition'])}"
            + (f" <em>{html.escape(meta['formula'])}</em>" if meta.get("formula") else "")
            + "</p>"
            for meta in METRIC_REGISTRY.values()
        )
        existing = "".join(f"<p><strong>{html.escape(k)}:</strong> {html.escape(v)}</p>" for k, v in METRIC_DEFINITIONS.items() if metric_key_for_label(k) is None)
        content = "<section class='panel'><h2>Metric Definitions</h2>" + central + existing + "</section>"
        return page_shell("Metric Definitions", content)

    def inactivity_computation(self, params):
        tier_rows = pd.DataFrame([
            {
                "Tier": "Tier A",
                "Source": "RevenueCatcher creator tier badge",
                "Revenue / hour": "Tier A weighted avg model tips + messages per scheduled hour, by CET sales interval",
                "Inactivity %": "Tier A scheduled inactive hours in that interval / Tier A scheduled shift hours in that interval",
                "Money wasted": "Sum of each interval: Tier A shift hours in interval x Tier A inactivity % in interval x Tier A revenue/hour in interval",
            },
            {
                "Tier": "Tier B",
                "Source": "RevenueCatcher creator tier badge",
                "Revenue / hour": "Tier B weighted avg model tips + messages per scheduled hour, by CET sales interval",
                "Inactivity %": "Tier B scheduled inactive hours in that interval / Tier B scheduled shift hours in that interval",
                "Money wasted": "Sum of each interval: Tier B shift hours in interval x Tier B inactivity % in interval x Tier B revenue/hour in interval",
            },
            {
                "Tier": "Tier C",
                "Source": "RevenueCatcher creator tier badge",
                "Revenue / hour": "Tier C weighted avg model tips + messages per scheduled hour, by CET sales interval",
                "Inactivity %": "Tier C scheduled inactive hours in that interval / Tier C scheduled shift hours in that interval",
                "Money wasted": "Sum of each interval: Tier C shift hours in interval x Tier C inactivity % in interval x Tier C revenue/hour in interval",
            },
        ])
        example_rows = pd.DataFrame([
            {"Tier": "Tier A", "Time": "Quiet hour", "Shift hours": "50.0h", "Scheduled inactive hours": "4.0h", "Inactivity %": "8.0%", "Revenue / hour": "\u20ac60.00", "Money wasted": "\u20ac240.00"},
            {"Tier": "Tier A", "Time": "Peak hour", "Shift hours": "50.0h", "Scheduled inactive hours": "4.0h", "Inactivity %": "8.0%", "Revenue / hour": "\u20ac180.00", "Money wasted": "\u20ac720.00"},
            {"Tier": "Tier A", "Time": "Total", "Shift hours": "100.0h", "Scheduled inactive hours": "8.0h", "Inactivity %": "8.0%", "Revenue / hour": "blended", "Money wasted": "\u20ac960.00"},
        ])
        content = """
        <section class="panel">
          <h2>Inactivity Computation</h2>
          <p class="note">This page documents how GAZE estimates money wasted from inactivity. The live Inactivity page uses RevenueCatcher inactivity episodes, RevenueCatcher scheduled shifts, model revenue, and RevenueCatcher creator tiers.</p>
        </section>
        <section class="panel">
          <h2>Main Formula</h2>
          <p class="answer">Money wasted = sum of each CET sales interval: shift hours in that interval x inactivity percentage in that interval x model revenue per hour in that interval.</p>
          <p class="note">This means inactivity during peak or mid-peak sales intervals costs more than inactivity during average or slow intervals. The same formula can also be read as scheduled inactive hours in each interval x model revenue/hour for that same interval.</p>
        </section>
        <section class="panel">
          <h2>Inputs</h2>
          <p><strong>Shift hours:</strong> total scheduled RevenueCatcher shift hours for the selected period.</p>
          <p><strong>Scheduled inactive hours:</strong> only the inactivity minutes that overlap an actual scheduled shift. If an inactivity event is longer than the shift overlap, GAZE counts only the overlapped time.</p>
          <p><strong>Inactivity percentage:</strong> scheduled inactive hours divided by scheduled shift hours for the same CET sales interval.</p>
          <p><strong>Model revenue per hour:</strong> selected-period model tips + messages revenue divided by scheduled shift hours for the same CET sales interval. Subscriptions are not included.</p>
          <p><strong>Sales interval:</strong> hourly CET/RevenueCatcher-local buckets that naturally separate peak, mid-peak, average, and slow periods based on actual revenue pace.</p>
          <p><strong>Creator tier:</strong> the official RevenueCatcher creator tier badge. Tier is used for the per-tier rollup and as fallback/cap context when a model has too little revenue history in the selected period.</p>
        </section>
        """
        content += "<section class='panel'><h2>Per-Tier Computation</h2>" + table_html(tier_rows, 10) + "</section>"
        content += "<section class='panel'><h2>Simple Example</h2>" + table_html(example_rows, 10) + "</section>"
        content += """
        <section class="panel">
          <h2>Accuracy Rules</h2>
          <p><strong>Schedule based:</strong> unscheduled inactivity is excluded from money wasted.</p>
          <p><strong>Revenue based:</strong> the estimate follows what the model actually made from tips + messages during the selected period.</p>
          <p><strong>Time-interval aware:</strong> the estimate is calculated hour by hour in CET, so peak sales windows count more than average or slow windows.</p>
          <p><strong>Tier aware:</strong> Tier A, B, and C are calculated separately so higher-revenue tiers carry the correct earning pace for each sales interval without letting one extreme row inflate everyone.</p>
          <p><strong>Capped:</strong> when a model has sparse revenue data, GAZE uses tier-level rates as a fallback/cap so the estimate stays realistic.</p>
        </section>
        """
        return page_shell("Inactivity Computation", content)

    def architecture(self, params):
        path = APP_DIR / "ARCHITECTURE.md"
        content = "<section class='panel markdown'><pre>" + html.escape(path.read_text(encoding="utf-8")) + "</pre></section>"
        return page_shell("Architecture", content)

    def kpi_cards(self, cards: list[tuple[str, str, str]]) -> str:
        return '<section class="kpi-grid">' + "".join(kpi_card_html(label, value, note) for label, value, note in cards) + "</section>"

    def source_note(self, source_key: str, extra: str = "") -> str:
        source = source_summary(source_key)
        tabs = ", ".join(source["tabs"].keys())
        return (
            "<section class='notice'><strong>Source:</strong> "
            f"<a href='{html.escape(source['url'])}'>{html.escape(source['title'])}</a>"
            f" &middot; tabs: {html.escape(tabs)}"
            f"{extra}</section>"
        )

    def c_hub(self, params):
        ctx = date_selector_context(params)
        comp_start, comp_end = comparison_range(ctx["start"], ctx["end"], ctx.get("compare_label", "Previous period"))
        query = "?" + urlencode({"range": "Custom", "start": ctx["start"], "end": ctx["end"], "compare": ctx.get("compare_label", "Previous period")})
        links = {
            "socials": "/models-socials" + query,
            "ads": "/ads-performance" + query,
            "fans": "/of-new-fan-growth" + query,
            "tickets": "/notion-tickets" + query,
            "compliance": "/compliance-dash" + query,
            "hub": "/c-hub" + query,
            "inactivity": "/inactivity" + query,
        }
        ads = ads_data(ctx["start"], ctx["end"])
        prev_ads = ads_data(comp_start, comp_end)
        socials = model_socials_data(ctx["start"], ctx["end"])
        prev_socials = model_socials_data(comp_start, comp_end)
        fans = of_new_fans_data(ctx["start"], ctx["end"])
        prev_fans = of_new_fans_data(comp_start, comp_end)
        tickets = tickets_data(ctx["start"], ctx["end"])
        prev_tickets = tickets_data(comp_start, comp_end)
        compliance = compliance_data(ctx["start"], ctx["end"])
        db_ctx = current_context({"range": ["Custom"], "start": [ctx["start"].isoformat()], "end": [ctx["end"].isoformat()], "compare": [ctx.get("compare_label", "Previous period")]})
        inactive = postgres_inactivity_summary(postgres_inactivity_rows(db_ctx["current"]))
        prev_inactive = postgres_inactivity_summary(postgres_inactivity_rows(db_ctx["previous"]))

        ad_spend = safe_sum(ads["by_platform"], "ad_spend")
        prev_ad_spend = safe_sum(prev_ads["by_platform"], "ad_spend")
        impressions = safe_sum(socials["by_model"], "impressions")
        prev_impressions = safe_sum(prev_socials["by_model"], "impressions")
        new_fans = safe_sum(fans["by_model"], "new_fans")
        prev_new_fans = safe_sum(prev_fans["by_model"], "new_fans")
        tickets_total = safe_sum(tickets["by_status"], "tickets")
        prev_tickets_total = safe_sum(prev_tickets["by_status"], "tickets")
        money_wasted = float(inactive["money_wasted"])
        prev_money_wasted = float(prev_inactive["money_wasted"])

        ad_delta, ad_cls = delta_markup(ad_spend, prev_ad_spend)
        social_delta, social_cls = delta_markup(impressions, prev_impressions)
        fans_delta, fans_cls = delta_markup(new_fans, prev_new_fans)
        tickets_delta, tickets_cls = delta_markup(tickets_total, prev_tickets_total)
        inactive_delta, inactive_cls = delta_markup(money_wasted, prev_money_wasted)

        compliance_latest = compliance["latest"].copy()
        best_score = 0.0
        if not compliance_latest.empty and "Best Score" in compliance_latest:
            best_score = pd.to_numeric(compliance_latest["Best Score"], errors="coerce").fillna(0).mean()

        cards = [
            c_metric_card("Marketing Reach", fmt_compact(impressions), social_delta, links["socials"], social_cls),
            c_metric_card("BD Ad Spend", fmt_money(ad_spend), ad_delta, links["ads"], ad_cls),
            c_metric_card("OF New Fans", fmt_compact(new_fans), fans_delta, links["fans"], fans_cls),
            c_metric_card("Tickets", fmt_compact(tickets_total), tickets_delta, links["tickets"], tickets_cls),
            c_metric_card("Inactivity Cost", fmt_money(money_wasted), inactive_delta, links["inactivity"], inactive_cls),
            c_metric_card("Quality Score", f"{best_score:.1f}/100" if best_score else "n/a", "latest compliance read", links["compliance"]),
        ]

        top_model = first_value(socials["by_model"], "Model", "impressions")
        top_ad_platform = first_value(ads["by_platform"], "Platform", "ad_spend")
        top_fan_model = first_value(fans["by_model"], "model", "new_fans")
        insights = [
            insight_item(f"{top_model} is the strongest social reach driver in the selected range."),
            insight_item(f"{top_ad_platform} carries the highest ad spend and should be checked against click quality."),
            insight_item(f"{top_fan_model} leads OF new fan growth for this period."),
            insight_item(f"Inactivity exposure is {fmt_money(money_wasted)}, with {inactive['worst_name']} as the highest-cost chatter row."),
            insight_item(f"Tickets are at {fmt_compact(tickets_total)} for the selected range; click the ticket chart to inspect status and owners."),
        ]

        source_line = (
            "<section class='notice compact-source'><strong>Live C-level view:</strong> "
            "Marketing, Ads, OF Fan Growth, Compliance, Tickets, and Inactivity are combined from the Hub sources already connected to GAZE."
            "</section>"
        )
        content = looker_date_bar(ctx)
        content += source_line
        content += "<section class='c-hero'><div><span>Marketing & operations overview</span><h2>What moved, what matters, and where to click next.</h2></div></section>"
        content += "<section class='c-metric-grid'>" + "".join(cards) + "</section>"
        content += "<section class='c-hub-grid'>"
        content += f"<article class='panel c-chart-card'><a class='panel-link' href='{links['socials']}'>Open Models Socials</a><h2>Top Social Reach</h2>" + c_horizontal_chart(socials["by_model"], "Model", "impressions", links["socials"], lambda v: fmt_compact(v), 7) + "</article>"
        content += f"<article class='panel c-chart-card'><a class='panel-link' href='{links['ads']}'>Open Ads</a><h2>BD Ad Spend</h2>" + c_column_chart(ads["by_platform"], "Platform", "ad_spend", links["ads"], fmt_money, 6) + "</article>"
        content += f"<article class='panel c-chart-card'><a class='panel-link' href='{links['tickets']}'>Open Tickets</a><h2>Ticket Status Mix</h2>" + c_donut_chart(tickets["by_status"], "status", "tickets", links["tickets"]) + "</article>"
        content += f"<article class='panel c-chart-card'><a class='panel-link' href='{links['fans']}'>Open OF Fans</a><h2>OF New Fan Growth</h2>" + c_column_chart(fans["by_model"], "model", "new_fans", links["fans"], lambda v: fmt_compact(v), 7) + "</article>"
        content += f"<article class='panel c-chart-card'><a class='panel-link' href='{links['compliance']}'>Open Compliance</a><h2>Compliance Quality Scores</h2>" + c_horizontal_chart(compliance_latest, "Pillar", "Best Score", links["compliance"], lambda v: f"{v:.0f}/100", 7) + "</article>"
        content += "<article class='panel c-chart-card c-insights'><h2>Executive Insights</h2><ul class='insight-list'>" + "".join(insights) + "</ul></article>"
        content += "</section>"
        return page_shell("Marketing & Operations Overview", content)

    def c_hub_executive_overview(self, params):
        return self.overview(params)

    def c_hub_transactions(self, params):
        return self.transactions(params)

    def c_hub_commissions(self, params):
        return self.commissions(params)

    def c_hub_revenue(self, params):
        selector_ctx = date_selector_context(params)
        ctx = current_context(params)
        ctx = {**selector_ctx, **ctx}
        revenue_filters = dict(ctx["filters"])
        model_filters = model_filter_values(params)
        model_sort, model_sort_direction = model_card_sort_values(params)
        revenue_filters["transaction_type"] = MODEL_REVENUE_TRANSACTION_TYPES
        all_current_revenue = filter_period(ctx["all_data"], ctx["start"], ctx["end"], revenue_filters)
        current_revenue = all_current_revenue.copy()
        current_revenue = apply_model_revenue_filters(current_revenue, model_filters)

        today = business_today(ctx["settings"])
        mtd_start = date(today.year, today.month, 1)
        prev_month_start, prev_month_end = previous_month_same_days(mtd_start, today)
        trend_filters = {"transaction_type": MODEL_REVENUE_TRANSACTION_TYPES}
        trend_data = merge_live_revenue_catcher(
            analytics_frame(load_transactions(prev_month_start, today)),
            ctx["settings"],
            mtd_start,
            today,
            prev_month_start,
            prev_month_end,
        )
        mtd_data = trend_data
        prev_month_data = trend_data
        mtd_current = filter_period(mtd_data, mtd_start, today, trend_filters)
        prev_month_current = filter_period(prev_month_data, prev_month_start, prev_month_end, trend_filters)
        mtd_summary = revenue_summary_period_from_frame(trend_data, mtd_start, today, trend_filters)
        prev_month_summary = revenue_summary_period_from_frame(trend_data, prev_month_start, prev_month_end, trend_filters)
        chart_data = {
            "trend": daily_trend_rows(mtd_summary if not mtd_summary.empty else mtd_current, mtd_start, today, mtd_current),
            "previousMonthTrend": daily_trend_rows(prev_month_summary if not prev_month_summary.empty else prev_month_current, prev_month_start, prev_month_end, prev_month_current),
            "previousMonthLabel": f"{prev_month_start:%b} {prev_month_start.day} - {prev_month_end:%b} {prev_month_end.day}",
        }

        metadata = model_account_metadata(ctx["settings"])
        all_model_rows = model_platform_revenue(
            all_current_revenue,
            model_roster(ctx["all_data"]),
            model_platform_roster(ctx["all_data"]),
            metadata,
        )
        model_rows = model_platform_revenue(
            current_revenue,
            model_roster(ctx["all_data"]),
            model_platform_roster(ctx["all_data"]),
            metadata,
        )
        model_rows = filter_model_card_rows(model_rows, model_filters)
        body = (
            "<section class='model-revenue-section'>"
            + c_platform_totals_strip(model_rows)
            + model_filter_form(ctx, all_model_rows, metadata, model_filters, all_current_revenue, model_sort, model_sort_direction)
            + c_model_revenue_cards(model_rows, model_sort, model_sort_direction)
            + "</section>"
        )
        body += (
            "<section class='panel trend-panel'>"
            "<div class='panel-heading-row'>"
            "<div><h2>Revenue Trend</h2>"
            f"<p class='note'>Month to date: {mtd_start} to {today}</p></div>"
            "<button class='button ghost trend-compare-toggle' type='button' data-compare-label='Previous month'>Compare to Previous Month</button>"
            "</div>"
            "<div id='trendChart' class='chart trend-chart'></div>"
            "</section>"
        )
        body += f"<script>window.chartData={json.dumps(chart_data, default=str)};</script>"
        return c_dashboard_page("Model Revenue Overview", ctx, body, show_header=False)

    def c_hub_chatter_revenue(self, params):
        selector_ctx = date_selector_context(params)
        ctx = current_context(params)
        ctx = {**selector_ctx, **ctx}
        revenue_filters = dict(ctx["filters"])
        chatter_filters = chatter_filter_values(params)
        chatter_sort, chatter_sort_direction = chatter_card_sort_values(params)
        revenue_filters["transaction_type"] = ["tip", "message"]
        all_current_revenue = filter_period(ctx["all_data"], ctx["start"], ctx["end"], revenue_filters)
        all_previous_revenue = filter_period(ctx["all_data"], ctx["comp_start"], ctx["comp_end"], revenue_filters)
        current_revenue = apply_chatter_revenue_filters(all_current_revenue, chatter_filters)
        previous_revenue = apply_chatter_revenue_filters(all_previous_revenue, chatter_filters)
        current_summary = live_summary_period(ctx["settings"], ctx["start"], ctx["end"], revenue_filters)
        previous_summary = live_summary_period(ctx["settings"], ctx["comp_start"], ctx["comp_end"], revenue_filters)
        m = executive_metrics(current_revenue, previous_revenue)
        if not has_entity_revenue(current_revenue, "creator") and not any(chatter_filters.values()):
            m = apply_summary_revenue(m, current_summary, previous_summary)
        m = apply_scheduled_hours(m, ctx["all_data"], ctx["start"], ctx["end"], revenue_filters)
        revenue_delta = fmt_pct(m["revenue_change_pct"])
        cards = [
            ("Total Revenue", fmt_money(m["total_revenue"]), f"% \u0394 {revenue_delta}" if revenue_delta != "n/a" else "% \u0394 n/a"),
            ("Active Chatters", str(m["active_chatters"]), "distinct"),
            ("Avg / Chatter", fmt_money(m["avg_revenue_per_chatter"]), "average"),
            ("Revenue / Hour", fmt_money(m["revenue_per_hour"]), "selected period"),
            ("Total Hours", fmt_num(m["total_hours"]), "shift hours"),
        ]
        chatter_rows = chatter_platform_revenue(
            current_revenue,
            chatter_roster(current_revenue),
            chatter_platform_roster(current_revenue),
        )
        chatter_hours_filters = dict(revenue_filters)
        chatter_hours_filters.update({field: values for field, values in chatter_filters.items() if values})
        chatter_rate_metrics = revenue_per_hour_by_chatter(chatter_rows, ctx["all_data"], ctx["start"], ctx["end"], chatter_hours_filters)
        body = '<section class="kpi-grid compact-grid">' + "".join(kpi_card_html(a, b, c) for a, b, c in cards) + "</section>"
        body += (
            "<section class='model-revenue-section'>"
            "<div class='panel-heading-row'><div><h2>Chatter Revenue Across Platforms</h2>"
            "<p class='note'>Each card shows the chatter's tips + messages for the selected period, split across their assigned platforms.</p></div></div>"
            + c_platform_totals_strip(chatter_rows)
            + chatter_filter_form(ctx, all_current_revenue, chatter_filters, chatter_sort, chatter_sort_direction)
            + c_chatter_revenue_cards(chatter_rows, chatter_rate_metrics, chatter_sort, chatter_sort_direction)
            + "</section>"
        )
        return c_dashboard_page("Chatter Revenue Overview", ctx, body)

    def c_hub_inactivity(self, params):
        return self.inactivity(params)

    def c_hub_chatter_revenue_tier(self, params):
        ctx = date_selector_context(params)
        all_data = analytics_frame(load_transactions(), preserve_shift_revenue=True)
        matrix = build_chatter_revenue_tier_matrix(all_data)
        thresholds = monthly_tier_thresholds()
        month_headers = "".join(
            f"<th>{html.escape(month.strftime('%b %Y'))}</th>"
            for month in matrix.months
        )
        body_rows = []
        arrow_labels = {"up": "&uarr;", "down": "&darr;", "same": "&rarr;"}
        for row in matrix.rows:
            cells = []
            for cell in row["cells"]:
                tier = cell["tier"]
                arrow = arrow_labels.get(cell["arrow"], "")
                title = f"{cell['month'].strftime('%B %Y')}: {fmt_money(cell['revenue'])} monthly tips + messages" if tier else f"{cell['month'].strftime('%B %Y')}: no tier revenue"
                label = (
                    f"<strong>{tier}<span>{arrow}</span></strong><small>{fmt_money(cell['revenue'])}</small>"
                    if tier
                    else "<em>-</em><small>\u20ac0.00</small>"
                )
                cells.append(f"<td class='tier-cell tier-{html.escape(tier.lower() or 'empty')}' title='{html.escape(title)}'>{label}</td>")
            body_rows.append(
                "<tr>"
                f"<th class='model-name'>{html.escape(row['model'])}</th>"
                + "".join(cells)
                + "</tr>"
            )
        if body_rows:
            table = (
                "<div class='tier-matrix-scroll'>"
                "<table class='tier-matrix-table'>"
                "<thead><tr><th class='model-name'>Model</th>"
                + month_headers
                + "</tr></thead><tbody>"
                + "".join(body_rows)
                + "</tbody></table></div>"
            )
        else:
            table = "<div class='empty'>No model revenue tiers are available yet.</div>"

        month_range = "No revenue months yet"
        if matrix.first_month and matrix.last_month:
            month_range = f"{matrix.first_month.strftime('%b %Y')} to {matrix.last_month.strftime('%b %Y')}"
        cards = [
            ("Months", str(len(matrix.months)), month_range),
            ("Tier A", str(matrix.latest_counts.get("A", 0)), f"monthly revenue >= {fmt_money(thresholds['A'])}"),
            ("Tier B", str(matrix.latest_counts.get("B", 0)), f"monthly revenue {fmt_money(thresholds['B'])} - {fmt_money(thresholds['A'])}"),
            ("Tier C", str(matrix.latest_counts.get("C", 0)), f"monthly revenue below {fmt_money(thresholds['B'])}"),
        ]
        body = (
            "<section class='notice compact-source tier-matrix-note'>"
            "Monthly model view using monthly revenue tiers: A = €50k+ per month, B = €15k-€50k per month, C = below €15k per month. Amounts shown are total tips + messages from all platforms, excluding the current in-progress month."
            "</section>"
        )
        body += c_stat_strip(cards)
        body += (
            "<section class='panel tier-matrix-panel'>"
            "<div class='panel-heading-row'><div><h2>Monthly Tier Matrix</h2>"
            "<p class='note'>The letter is based on total monthly tips + messages revenue. The amount under the letter is the model's total tips + messages for the full month; arrows compare each model against their previous recorded month.</p>"
            "</div></div>"
            + table
            + "</section>"
        )
        return c_dashboard_page("Chatting Revenue Tier", ctx, body)

    def c_hub_target_monitoring(self, params):
        default_end = date.today()
        default_start = default_end - timedelta(days=14)
        ctx = date_selector_context(
            params,
            default_label="Custom",
            default_start=default_start,
            default_end=default_end,
        )
        all_data = analytics_frame(load_transactions(ctx["start"], ctx["end"]), preserve_shift_revenue=True)
        current = filter_period(all_data, ctx["start"], ctx["end"], {})
        targets = load_postgres_account_targets()
        monitoring = build_target_monitoring(current, ctx["start"], ctx["end"], targets)
        raw = monitoring.raw
        action_counts = raw["Action"].value_counts().to_dict() if not raw.empty and "Action" in raw else {}
        median_hit_rate = raw["Hit Rate Value"].median() if not raw.empty and "Hit Rate Value" in raw else 0
        cards = [
            ("Models", str(len(raw)), "model-platform rows"),
            ("Increase", str(action_counts.get("Increase", 0)), "5+ hit days"),
            ("Keep", str(action_counts.get("Keep", 0)), "1-4 hit days"),
            ("Decrease", str(action_counts.get("Decrease", 0)), "0 hit days"),
            ("Needs Target", str(action_counts.get("Needs Target", 0)), "missing Flow target"),
            ("Median Hit Rate", f"{float(median_hit_rate or 0):.1f}%", "selected period"),
        ]
        source_note = "Flow targets are the source of truth for Target Monitoring. GAZE reads the shared target data, reviews the selected period, and suggests target actions; approved target changes should still happen in Flow."
        if targets.empty:
            source_note += " Current target rows were not found in the connected database yet, so rows without targets are marked Needs Target."
        body = (
            "<section class='notice compact-source tier-matrix-note'>"
            + html.escape(source_note)
            + "</section>"
        )
        body += c_stat_strip(cards)
        body += (
            "<section class='panel target-monitoring-panel'>"
            "<div class='panel-heading-row'><div><h2>Target Monitoring</h2>"
            "<p class='note'>Hit days compare daily tips + messages revenue against the current Flow target; rows without a saved target use the suggested average as the temporary baseline. Increase means 5+ hit days, Keep means 1-4, Decrease means 0.</p>"
            "</div></div>"
            + table_html(monitoring.table, 500)
            + "</section>"
        )
        return c_dashboard_page("Target Monitoring", ctx, body)
    def c_hub_performance(self, params):
        ctx = date_selector_context(params)
        settings = load_settings()
        week_start = settings.get("reporting_week_start", "Friday")
        windows = week_windows(ctx["end"], week_start=week_start)
        load_start = windows[0][1] if windows else ctx["start"]
        all_data = analytics_frame(load_transactions(load_start, ctx["end"]))
        data = build_performance_hub(
            all_data,
            ctx["end"],
            week_start=week_start,
        )
        weekly = data["weekly"]
        latest = weekly.tail(1).iloc[0] if not weekly.empty else {}
        strength = float(latest.get("team_strength", 0) or 0)
        requirement = float(latest.get("model_requirement", 0) or 0)
        gap = strength - requirement
        hours = float(latest.get("hours", 0) or 0)
        revenue = float(latest.get("revenue", 0) or 0)
        operating_pct = strength / requirement * 100 if requirement else 0
        scheduled_chatters = int(latest.get("scheduled_chatters", 0) or 0)
        hr_matched = int(latest.get("hr_matched_chatters", 0) or 0)
        previous = weekly.tail(2).head(1).iloc[0] if len(weekly) > 1 else {}
        strength_change = strength - float(previous.get("team_strength", 0) or 0)
        requirement_change = requirement - float(previous.get("model_requirement", 0) or 0)
        chatter_change = scheduled_chatters - int(previous.get("scheduled_chatters", 0) or 0)
        transition_count = len(data.get("transition", pd.DataFrame()))
        momentum_label = "Stronger" if chatter_change > 0 else "Weaker" if chatter_change < 0 else "Stable"
        momentum_note = f"{fmt_compact(chatter_change, prefix='+' if chatter_change >= 0 else '')} scheduled vs previous week"
        match_note = f"{hr_matched}/{scheduled_chatters} scheduled chatters matched to HR" if scheduled_chatters else "no scheduled chatters"
        insight_tone = "positive" if gap >= 0 else "warning"
        insights = [
            insight_item(
                f"Current team strength is {fmt_compact(strength)} against a model requirement of {fmt_compact(requirement)}.",
                insight_tone,
            ),
            insight_item(
                f"Strength moved {fmt_compact(strength_change, prefix='+' if strength_change >= 0 else '')} vs the previous week.",
                "positive" if strength_change >= 0 else "warning",
            ),
            insight_item(
                f"Model requirement moved {fmt_compact(requirement_change, prefix='+' if requirement_change >= 0 else '')} vs the previous week.",
                "neutral",
            ),
            insight_item(
                f"Chatter capacity is {momentum_label.lower()}: {momentum_note}, with {fmt_compact(transition_count)} people in HR transition/watch.",
                "positive" if chatter_change > 0 else "warning" if chatter_change < 0 else "neutral",
            ),
            insight_item(
                f"HR match coverage: {match_note}. Missing HR scores stay pending and do not add strength yet.",
                "warning" if scheduled_chatters and hr_matched < scheduled_chatters else "positive",
            ),
            insight_item(
                f"Current week revenue per scheduled hour is {fmt_money(revenue / hours) if hours else 'n/a'}.",
                "neutral",
            ),
        ]
        cards = [
            ("Team Strength", fmt_compact(strength), "skill grade x scheduled hours"),
            ("Operating Potential", f"{operating_pct:.1f}%" if requirement else "n/a", "strength vs model requirement"),
            ("Model Requirement", fmt_compact(requirement), "RevenueCatcher creator tiers"),
            ("Capacity Gap", fmt_compact(gap, prefix="+" if gap >= 0 else ""), "strength minus requirement"),
            ("Hiring Signal", momentum_label, momentum_note),
            ("Scheduled Chatters", fmt_compact(scheduled_chatters), "unknown shifts excluded"),
            ("Scheduled Hours", fmt_compact(hours), "counted from shifts"),
            ("HR Profiles", match_note, "Notion match coverage"),
            ("Rev / Hour", fmt_money(revenue / hours) if hours else "n/a", "current week"),
        ]
        body = (
            "<section class='notice compact-source'><strong>Performance Hub draft:</strong> "
            "Only chatters found in the schedule are counted. HR data is using "
            f"{html.escape(data.get('snapshot_source', 'Notion employee data'))} "
            f"({data['snapshot_rows']} chatter rows). "
            "Model requirement uses each creator's official RevenueCatcher tier badge when available; revenue-based tiers are only a fallback."
            "</section>"
        )
        body += c_stat_strip(cards)
        body += "<section class='c-hub-grid performance-hub-grid'>"
        body += "<article class='panel c-chart-card c-wide-card'><h2>Team Strength vs Model Requirement</h2><p class='panel-note'>Team strength is skill grade x scheduled hours. Model requirement is weekly coverage points from RevenueCatcher creator tier.</p>" + c_strength_requirement_chart(weekly) + "</article>"
        body += "<article class='panel c-chart-card c-insights'><h2>Management Notes</h2><ul class='insight-list'>" + "".join(insights) + "</ul></article>"
        body += "<article class='panel c-chart-card'><h2>Current Chatter Tier Mix</h2>" + c_donut_chart(data["tier_mix"], "tier", "strength", "/c-hub/performance") + "</article>"
        body += "<article class='panel c-chart-card'><h2>Strength Leaderboard</h2>" + c_horizontal_chart(data["current_chatters"], "chatter", "operating_potential", "/c-hub/performance", lambda v: fmt_compact(v), 12) + "</article>"
        body += "<article class='panel c-chart-card'><h2>Revenue / Hour Trend</h2>" + c_column_chart(weekly, "week", "revenue_per_hour", "/c-hub/performance", fmt_money, 4) + "</article>"
        body += "<article class='panel c-chart-card c-wide-card scheduled-chatter-panel'><h2>Chatter Performance Hub</h2><p class='panel-note'>Chat Quality and Activity / Behaviour are the two scoring categories used in each chatter's skill grade.</p>" + c_scheduled_chatter_cards(data["current_chatters"]) + "</article>"
        body += "<article class='panel c-chart-card'><h2>Model Requirement Inputs</h2><p class='panel-note'>Weekly requirement points: Tier A = 4,200, Tier B = 3,000, Tier C = 1,800.</p>" + table_html(data["creator_requirements"].head(25), 25) + "</article>"
        body += "<article class='panel c-chart-card'><h2>HR Transition Watch</h2>" + table_html(data["transition"].head(25), 25) + "</article>"
        body += "</section>"
        return c_dashboard_page("Performance Hub", ctx, body)

    def c_hub_performance_2(self, params):
        ctx = date_selector_context(params)
        settings = load_settings()
        week_start = settings.get("reporting_week_start", "Friday")
        windows = week_windows(ctx["end"], week_start=week_start)
        load_start = windows[0][1] if windows else ctx["start"]
        # Performance Hub 2 must use the same live Revenue Catcher transactions
        # as its grades and planned schedule. The local import can be incomplete
        # (notably for English-team attribution), so retain it only as a fallback.
        live_data = load_postgres_transactions(load_start, ctx["end"])
        all_data = analytics_frame(live_data if not live_data.empty else load_transactions(load_start, ctx["end"]))
        scheduled_data = load_postgres_scheduled_shifts(load_start, ctx["end"])
        unfiltered = build_performance_hub_v2(
            all_data,
            ctx["end"],
            week_start=week_start,
            scheduled_data=scheduled_data,
        )
        selected = {
            "team": str(params.get("ph2_team", [""])[0] or "").strip(),
            "tier": str(params.get("ph2_tier", [""])[0] or "").strip(),
            "score": str(params.get("ph2_score", [""])[0] or "").strip(),
        }
        data = build_performance_hub_v2(
            all_data, ctx["end"], week_start=week_start, scheduled_data=scheduled_data, filters=selected,
        ) if any(selected.values()) else unfiltered
        weekly = data["weekly"]
        latest = weekly.tail(1).iloc[0] if not weekly.empty else {}
        strength = float(latest.get("team_strength", 0) or 0)
        scheduled_strength = float(latest.get("scheduled_strength", 0) or 0)
        requirement = float(latest.get("model_requirement", 0) or 0)
        gap = strength - requirement
        capacity_hours = float(latest.get("capacity_hours", 0) or 0)
        scheduled_hours = float(latest.get("hours", 0) or 0)
        utilization = float(latest.get("utilization_pct", 0) or 0)
        scheduled_chatters = int(latest.get("scheduled_chatters", 0) or 0)
        hr_matched = int(latest.get("hr_matched_chatters", 0) or 0)
        capacity_missing = int(latest.get("capacity_missing_chatters", 0) or 0)
        previous = weekly.tail(2).head(1).iloc[0] if len(weekly) > 1 else {}
        strength_change = strength - float(previous.get("team_strength", 0) or 0)
        operating_pct = strength / requirement * 100 if requirement else 0
        coverage_note = f"{hr_matched} of {scheduled_chatters} scheduled chatters have score profiles" if scheduled_chatters else "no scheduled chatters"
        shortage_note = "shortage" if gap < 0 else "surplus"
        cards = [
            ("Team Strength", f"{fmt_num(strength)}h", "quality-adjusted weekly capacity"),
            ("Model Requirement", f"{fmt_num(requirement)}h", "weekly model coverage needed"),
            ("Capacity Gap", f"{fmt_num(gap)}h", shortage_note),
            ("Operating Potential", f"{operating_pct:.1f}%" if requirement else "n/a", "strength vs requirement"),
            ("Strength Growth", f"{fmt_num(strength_change)}h", "vs previous week"),
            ("Weekly Capacity", f"{fmt_num(capacity_hours)}h", "RevenueCatcher planned shifts"),
            ("Chatter Hours", f"{fmt_num(scheduled_hours)}h", "unique actual hours worked"),
            ("Utilization", f"{fmt_num(utilization)}%", "unique chatter hours / capacity"),
            ("HR Data Coverage", coverage_note, f"{capacity_missing} missing capacity"),
        ]
        insights = [
            insight_item(
                f"Quality-adjusted team strength is {fmt_num(strength)}h against {fmt_num(requirement)}h of model requirement.",
                "positive" if gap >= 0 else "warning",
            ),
            insight_item(
                f"Capacity gap is {fmt_num(gap)}h, so this page now shows staffing shortage/surplus directly.",
                "positive" if gap >= 0 else "warning",
            ),
            insight_item(
                f"Strength moved {fmt_num(strength_change)}h vs the previous week.",
                "positive" if strength_change >= 0 else "warning",
            ),
            insight_item(
                f"HR data coverage: {coverage_note}. Missing weekly capacity is shown as missing and does not add strength.",
                "warning" if scheduled_chatters and hr_matched < scheduled_chatters else "neutral",
            ),
            insight_item(
                f"Quality-adjusted worked strength is {fmt_num(scheduled_strength)}h from {fmt_num(scheduled_hours)} unique chatter hours.",
                "neutral",
            ),
        ]
        available = unfiltered["current_chatters"]
        teams = sorted(v for v in available.get("team", pd.Series(dtype=str)).dropna().astype(str).unique() if v and v != "Unknown")
        tier_values = set(available.get("tier", pd.Series(dtype=str)).dropna().astype(str))
        tiers = [v for v in ["A", "B", "C", "Pending score"] if v in tier_values]
        def filter_options(values, current, blank):
            return f"<option value=''>{blank}</option>" + "".join(
                f"<option value='{html.escape(value, quote=True)}' {'selected' if value == current else ''}>{html.escape(value)}</option>"
                for value in values
            )
        filter_bar = (
            "<form class='filters performance-hub-filters' method='get'>"
            f"<input type='hidden' name='range' value='{html.escape(ctx['range_label'], quote=True)}'><input type='hidden' name='start' value='{ctx['start']}'><input type='hidden' name='end' value='{ctx['end']}'><input type='hidden' name='compare' value='{html.escape(ctx['compare_label'], quote=True)}'>"
            f"<label>Team<select name='ph2_team'>{filter_options(teams, selected['team'], 'All teams')}</select></label>"
            f"<label>Tier<select name='ph2_tier'>{filter_options(tiers, selected['tier'], 'All tiers')}</select></label>"
            f"<label>Grade status<select name='ph2_score'>{filter_options(['graded', 'pending'], selected['score'], 'All grades')}</select></label>"
            "<button type='submit'>Apply filters</button></form>"
        )
        body = filter_bar
        body += "<section class='notice compact-source'><strong>Performance Hub 2:</strong> Filters apply to chatter capacity, utilization and detail analysis. Chatter Hours count a person's shift once per day, even when Flow links it to several models. Model requirement remains agency-wide. Detail columns can be sorted by clicking a header.</section>"
        body += "<article class='panel c-chart-card c-wide-card scheduled-chatter-panel'><h2>Chatter Capacity & Utilization</h2>" + c_capacity_chatter_cards(data["current_chatters"]) + "</article>"
        body += (
            "<section class='notice compact-source'><strong>Performance Hub 2 draft:</strong> "
            "The original Performance Hub is unchanged. This version uses RevenueCatcher planned shifts for weekly capacity and live RevenueCatcher transactions for revenue, "
            "then weights capacity by chatter skill score. Model requirement is shown as weekly coverage hours from model tier."
            "</section>"
        )
        body += c_stat_strip(cards)
        body += "<section class='c-hub-grid performance-hub-grid'>"
        body += "<article class='panel c-chart-card c-wide-card'><h2>Team Strength vs Model Requirement</h2><p class='panel-note'>Team strength is quality-adjusted weekly chatter capacity. Model requirement is weekly model coverage needed.</p>" + c_strength_requirement_chart(weekly) + "</article>"
        body += "<article class='panel c-chart-card c-insights'><h2>Management Notes</h2><ul class='insight-list'>" + "".join(insights) + "</ul></article>"
        body += "<article class='panel c-chart-card'><h2>Current Chatter Tier Mix</h2>" + c_donut_chart(data["tier_mix"], "tier", "strength", "/c-hub/performance-2") + "</article>"
        body += "<article class='panel c-chart-card'><h2>Capacity Leaderboard</h2>" + c_horizontal_chart(data["current_chatters"], "chatter", "quality_adjusted_capacity", "/c-hub/performance-2", lambda v: f"{fmt_num(v)}h", 12) + "</article>"
        body += "<article class='panel c-chart-card'><h2>Utilization Trend</h2>" + c_column_chart(weekly, "week", "utilization_pct", "/c-hub/performance-2", lambda v: f"{fmt_num(v)}%", 4) + "</article>"
        body += "<article class='panel c-chart-card'><h2>Model Requirement Inputs</h2><p class='panel-note'>Draft weekly coverage targets: Tier A = 168h, Tier B = 112h, Tier C = 56h.</p>" + table_html(data["creator_requirements"].head(25), 25) + "</article>"
        body += "<article class='panel c-chart-card'><h2>HR Transition Watch</h2>" + table_html(data["transition"].head(25), 25) + "</article>"
        body += "<article class='panel c-chart-card c-wide-card'><h2>Sortable Chatter Detail</h2><p class='panel-note'>Click a column heading to sort this complete filtered set.</p>" + table_html(data["current_chatters"], 200) + "</article>"
        body += "</section>"
        return c_dashboard_page("Performance Hub 2", ctx, body)

    def c_hub_compliance(self, params):
        ctx = date_selector_context(params)
        data = compliance_data(ctx["start"], ctx["end"])
        latest = data["latest"]
        avg_best = safe_sum(latest, "Best Score") / max(1, len(latest)) if not latest.empty else 0
        avg_worst = safe_sum(latest, "Worst Score") / max(1, len(latest)) if not latest.empty else 0
        cards = [
            ("Avg Best Score", f"{avg_best:.1f}/100", "latest quality"),
            ("Avg Risk Score", f"{avg_worst:.1f}/100", "lowest performer read"),
            ("Pillars", str(len(latest)) if not latest.empty else "0", "quality areas"),
            ("Latest Evaluation", data["cards"][0][1] if data["cards"] else "n/a", "source date"),
        ]
        body = c_stat_strip(cards)
        body += "<section class='c-hub-grid'>"
        body += "<article class='panel c-chart-card'><h2>Compliance Score by Pillar</h2>" + c_horizontal_chart(latest, "Pillar", "Best Score", "/compliance-dash", lambda v: f"{v:.0f}/100", 7) + "</article>"
        body += "<article class='panel c-chart-card'><h2>Risk Floor by Pillar</h2>" + c_column_chart(latest, "Pillar", "Worst Score", "/compliance-dash", lambda v: f"{v:.0f}/100", 7) + "</article>"
        body += "<article class='panel c-chart-card c-wide-card'><h2>Latest Quality Assessment</h2>" + table_html(latest, 30) + "</article>"
        body += "</section>"
        return c_dashboard_page("Compliance", ctx, body)

    def c_hub_marketing_ads(self, params):
        ctx = date_selector_context(params)
        data = ads_data(ctx["start"], ctx["end"])
        by_campaign = data["by_campaign"].copy()
        if not by_campaign.empty:
            by_campaign["cpl"] = by_campaign.apply(lambda row: float(row["ad_spend"]) / float(row["clicks"]) if float(row["clicks"] or 0) else 0, axis=1)
        spend = safe_sum(data["by_platform"], "ad_spend")
        clicks = safe_sum(data["by_platform"], "clicks")
        signed = safe_sum(data["by_platform"], "leads_signed")
        cards = [
            ("Ad Spend", fmt_money(spend), "MTD selected source"),
            ("Leads", fmt_compact(clicks), "link clicks"),
            ("CPL", fmt_money(spend / clicks) if clicks else "-", "cost per lead"),
            ("Signed", fmt_compact(signed), "reported"),
            ("CPA", fmt_money(spend / signed) if signed else "-", "cost per acquisition"),
        ]
        body = c_stat_strip(cards)
        source = str(data.get("source", ""))
        latest_source = str(data.get("latest_source_date", ""))
        if source:
            source_label = "Live MDAds Google Sheet" if source == "Live Google Sheet" else "Cached MDAds snapshot"
            latest_note = f" Latest source date: {latest_source}." if latest_source else ""
            fallback_note = " The live sheet could not be reached, so this page is using the cached export." if source != "Live Google Sheet" else ""
            body += (
                "<section class='notice compact-source'>"
                f"<strong>Marketing ads source:</strong> {html.escape(source_label)}."
                f"{html.escape(latest_note)}"
                f"{html.escape(fallback_note)}"
                "</section>"
            )
        body += "<section class='c-hub-grid'>"
        body += "<article class='panel c-chart-card'><h2>Ad Spend by Campaign</h2>" + c_column_chart(by_campaign, "Campaign Name", "ad_spend", "/ads-performance", fmt_money, 8) + "</article>"
        body += "<article class='panel c-chart-card'><h2>Leads by Platform</h2>" + c_horizontal_chart(data["by_platform"], "Platform", "clicks", "/ads-performance", lambda v: fmt_compact(v), 8) + "</article>"
        body += "<article class='panel c-chart-card'><h2>Leads by Campaign</h2>" + c_horizontal_chart(by_campaign, "Campaign Name", "clicks", "/ads-performance", lambda v: fmt_compact(v), 8) + "</article>"
        body += "<article class='panel c-chart-card'><h2>CPL by Campaign</h2>" + c_column_chart(by_campaign, "Campaign Name", "cpl", "/ads-performance", fmt_money, 8) + "</article>"
        body += "</section>"
        return c_dashboard_page("Marketing | Ads", ctx, body)

    def c_hub_models_socials(self, params):
        ctx = date_selector_context(params)
        data = model_socials_data(ctx["start"], ctx["end"])
        raw = data["raw"]
        impressions = safe_sum(data["by_model"], "impressions")
        visits = safe_sum(data["by_model"], "profile_visits")
        bio_clicks = raw_numeric_total(raw, ["Bio Link Clicks"])
        adult_clicks = raw_numeric_total(raw, ["Adult Click Throughs", "Adult\nClick Throughs"])
        subs_of = raw_numeric_total(raw, ["Subscriptions (OF)"])
        followers_total = raw_numeric_total(raw, ["Followers Total Socials"])
        model_count = int(raw["Model"].nunique()) if not raw.empty and "Model" in raw else 0
        account_count = int(raw["Account"].nunique()) if not raw.empty and "Account" in raw else 0
        cards = [
            ("Number of Models", str(model_count), "active source rows"),
            ("Number of Accounts", str(account_count), "social accounts"),
            ("Impressions", fmt_compact(impressions), "social traffic"),
            ("Profile Visits", fmt_compact(visits), "profile traffic"),
            ("Bio Link Clicks", fmt_compact(bio_clicks), "link intent"),
            ("Followers Total", fmt_compact(followers_total), "social base"),
            ("Adult Click Throughs", fmt_compact(adult_clicks), "OF conversion"),
            ("Subscriptions OF", fmt_compact(subs_of), "OF growth"),
        ]
        body = c_stat_strip(cards)
        body += "<section class='c-hub-grid'>"
        body += "<article class='panel c-chart-card'><h2>Social Traffic / Reach</h2>" + c_horizontal_chart(data["by_model"], "Model", "impressions", "/models-socials", lambda v: fmt_compact(v), 8) + "</article>"
        body += "<article class='panel c-chart-card'><h2>Profile Visits by Model</h2>" + c_column_chart(data["by_model"], "Model", "profile_visits", "/models-socials", lambda v: fmt_compact(v), 8) + "</article>"
        body += "<article class='panel c-chart-card'><h2>Subscriptions by Model</h2>" + c_column_chart(data["by_model"], "Model", "subscriptions", "/models-socials", lambda v: fmt_compact(v), 8) + "</article>"
        body += "<article class='panel c-chart-card'><h2>Platform Reach Mix</h2>" + c_horizontal_chart(data["by_platform"], "Platform", "impressions", "/models-socials", lambda v: fmt_compact(v), 8) + "</article>"
        body += "</section>"
        return c_dashboard_page("Models Social Performance", ctx, body)

    def c_hub_of_new_fans(self, params):
        ctx = date_selector_context(params)
        data = of_new_fans_data(ctx["start"], ctx["end"])
        raw = data["raw"]
        cards = data["cards"]
        body = c_stat_strip(cards)
        top_models = data["by_model"].head(4)["model"].tolist() if not data["by_model"].empty else []
        body += "<section class='c-hub-grid'>"
        for model in top_models:
            source_col = next((col for col in raw.columns if col.strip() == str(model).strip()), None) if not raw.empty else None
            points = []
            if source_col:
                for _, row in raw.iterrows():
                    value = pd.to_numeric(pd.Series([row.get(source_col)]), errors="coerce").fillna(0).iloc[0]
                    points.append((str(row.get("Date", "")), float(value)))
            body += f"<article class='panel c-chart-card'><h2>{html.escape(str(model))} New Fans</h2>" + c_line_chart(points, "/of-new-fan-growth") + "</article>"
        body += "<article class='panel c-chart-card c-wide-card'><h2>New Fans by Model</h2>" + c_horizontal_chart(data["by_model"], "model", "new_fans", "/of-new-fan-growth", lambda v: fmt_compact(v), 8) + "</article>"
        body += "</section>"
        return c_dashboard_page("OF New Fan Growth", ctx, body)

    def c_hub_ads_performance(self, params):
        ctx = date_selector_context(params)
        data = ads_data(ctx["start"], ctx["end"])
        raw = data["raw"].copy()
        if raw.empty:
            body = c_stat_strip([("Ad Spend", "n/a", "no rows"), ("Leads", "n/a", "no rows")])
            return c_dashboard_page("Ads Performance", ctx, body)
        category = (
            raw.groupby("Ad Category", dropna=False)
            .agg(impressions=("impressions_num", "sum"), clicks=("clicks_num", "sum"), ad_spend=("spend_num", "sum"), signed=("leads_signed_num", "sum"))
            .reset_index()
        )
        category["cpl"] = category.apply(lambda row: row["ad_spend"] / row["clicks"] if row["clicks"] else 0, axis=1)
        cards = [
            ("BD + Hiring Spend", fmt_money(safe_sum(category, "ad_spend")), "total"),
            ("Impressions", fmt_compact(safe_sum(category, "impressions")), "reach"),
            ("Leads", fmt_compact(safe_sum(category, "clicks")), "clicks"),
            ("Signed", fmt_compact(safe_sum(category, "signed")), "reported"),
            ("Blended CPL", fmt_money(safe_sum(category, "ad_spend") / safe_sum(category, "clicks")) if safe_sum(category, "clicks") else "-", "cost"),
        ]
        body = c_stat_strip(cards)
        body += "<section class='c-hub-grid'>"
        body += "<article class='panel c-chart-card'><h2>Spend by Ad Category</h2>" + c_column_chart(category, "Ad Category", "ad_spend", "/ads-performance", fmt_money, 6) + "</article>"
        body += "<article class='panel c-chart-card'><h2>Leads by Ad Category</h2>" + c_horizontal_chart(category, "Ad Category", "clicks", "/ads-performance", lambda v: fmt_compact(v), 6) + "</article>"
        body += "<article class='panel c-chart-card'><h2>CPL by Ad Category</h2>" + c_column_chart(category, "Ad Category", "cpl", "/ads-performance", fmt_money, 6) + "</article>"
        body += "<article class='panel c-chart-card'><h2>Campaign Spend Ranking</h2>" + c_horizontal_chart(data["by_campaign"], "Campaign Name", "ad_spend", "/ads-performance", fmt_money, 10) + "</article>"
        body += "</section>"
        return c_dashboard_page("Ads Performance", ctx, body)

    def c_hub_tickets(self, params):
        ctx = date_selector_context(params, default_label="Custom", default_start=date(2026, 1, 1), default_end=date.today())
        data = tickets_data(ctx["start"], ctx["end"])
        body = c_stat_strip(data["cards"])
        source = str(data.get("source", ""))
        latest_created = str(data.get("latest_created", ""))
        if source:
            source_status = "Live Notion API" if source == "Notion API" else source
            latest_note = f" Latest ticket in this view: {latest_created}." if latest_created else ""
            fallback_note = " Add or fix the Notion token in the app environment to use live tickets." if source != "Notion API" else ""
            body += (
                "<section class='notice compact-source'>"
                f"<strong>Ticket source:</strong> {html.escape(source_status)}."
                f"{html.escape(latest_note)}"
                f"{html.escape(fallback_note)}"
                "</section>"
            )
        body += "<section class='c-hub-grid ticket-dashboard'>"
        body += "<article class='panel c-chart-card'><h2>Tickets by Department</h2>" + ticket_department_chart(data["by_department_status"]) + "</article>"
        body += "<article class='panel c-chart-card'><h2>Tickets by Status</h2>" + ticket_status_donut(data["by_status"]) + "</article>"
        body += "<article class='panel c-chart-card c-wide-card ticket-list-panel'><h2>Ticket List</h2>" + table_html(data["tickets"], 60) + "</article>"
        body += "</section>"
        return c_dashboard_page("Interdepartmental Tickets", ctx, body)

    def compliance_dash(self, params):
        ctx = date_selector_context(params)
        data = compliance_data(ctx["start"], ctx["end"])
        content = looker_date_bar(ctx)
        content += self.source_note("compliance", " &middot; cached from accessible Looker source.")
        content += self.kpi_cards(data["cards"])
        content += "<section class='grid-2'>"
        content += "<div class='panel'><h2>Latest Quality Assessment</h2>" + table_html(data["latest"], 100) + "</div>"
        content += "<div class='panel'><h2>Compliance Metric Definitions</h2>" + table_html(data["metrics"], 100) + "</div>"
        content += "</section>"
        return page_shell("Compliance Dash", content)

    def marketing(self, params):
        ctx = date_selector_context(params)
        ads = ads_data(ctx["start"], ctx["end"])
        socials = model_socials_data(ctx["start"], ctx["end"])
        fans = of_new_fans_data(ctx["start"], ctx["end"])
        cards = ads["cards"][:3] + [("New OF Fans", fans["cards"][0][1] if fans["cards"] else "n/a", "from OFNewFans")]
        content = looker_date_bar(ctx)
        content += self.source_note("marketing", " &middot; marketing, ads, socials, and OF fan tabs are cached.")
        content += self.kpi_cards(cards)
        content += "<section class='grid-2'>"
        content += "<div class='panel'><h2>Ads by Platform</h2>" + table_html(ads["by_platform"], 100) + "</div>"
        content += "<div class='panel'><h2>Socials by Model</h2>" + table_html(socials["by_model"], 100) + "</div>"
        content += "</section>"
        content += "<section class='panel'><h2>OF New Fans by Model</h2>" + table_html(fans["by_model"], 100) + "</section>"
        return page_shell("Marketing", content)

    def models_socials(self, params):
        ctx = date_selector_context(params)
        data = model_socials_data(ctx["start"], ctx["end"])
        content = looker_date_bar(ctx)
        content += self.source_note("marketing", " &middot; using LisaModelsRaw.")
        content += self.kpi_cards(data["cards"])
        content += "<section class='grid-2'>"
        content += "<div class='panel'><h2>By Model</h2>" + table_html(data["by_model"], 200) + "</div>"
        content += "<div class='panel'><h2>By Platform</h2>" + table_html(data["by_platform"], 100) + "</div>"
        content += "</section>"
        content += "<section class='panel'><h2>Recent Source Rows</h2>" + table_html(data["raw"].tail(100), 100) + "</section>"
        return page_shell("Models Socials", content)

    def of_new_fan_growth(self, params):
        ctx = date_selector_context(params)
        data = of_new_fans_data(ctx["start"], ctx["end"])
        content = looker_date_bar(ctx)
        content += self.source_note("marketing", " &middot; using OFNewFans.")
        content += self.kpi_cards(data["cards"])
        content += "<section class='grid-2'>"
        content += "<div class='panel'><h2>New Fans by Model</h2>" + table_html(data["by_model"], 100) + "</div>"
        content += "<div class='panel'><h2>Daily New Fan Growth</h2>" + table_html(data["daily"].tail(100), 100) + "</div>"
        content += "</section>"
        return page_shell("OF New Fan Growth", content)

    def ads_performance(self, params):
        ctx = date_selector_context(params)
        data = ads_data(ctx["start"], ctx["end"])
        content = looker_date_bar(ctx)
        content += self.source_note("marketing", " &middot; using MDAds.")
        content += self.kpi_cards(data["cards"])
        content += "<section class='grid-2'>"
        content += "<div class='panel'><h2>By Platform</h2>" + table_html(data["by_platform"], 100) + "</div>"
        content += "<div class='panel'><h2>By Campaign</h2>" + table_html(data["by_campaign"], 200) + "</div>"
        content += "</section>"
        content += "<section class='panel'><h2>Recent Ad Rows</h2>" + table_html(data["raw"].tail(100), 100) + "</section>"
        return page_shell("Ads Performance", content)

    def notion_tickets(self, params):
        ctx = date_selector_context(params, default_label="Custom", default_start=date(2026, 5, 15), default_end=date.today())
        data = tickets_data(ctx["start"], ctx["end"])
        content = looker_date_bar(ctx)
        content += self.source_note("tickets", " &middot; cached from RAW - Notion Tickets.")
        content += self.kpi_cards(data["cards"])
        content += "<section class='grid-2 ticket-dashboard'>"
        content += "<div class='panel ticket-visual'><h2>Tickets by Department</h2>" + ticket_department_chart(data["by_department_status"]) + "</div>"
        content += "<div class='panel ticket-visual'><h2>Tickets by Status</h2>" + ticket_status_donut(data["by_status"]) + "</div>"
        content += "</section>"
        content += "<section class='panel ticket-list-panel'><h2>Ticket List</h2>" + table_html(data["tickets"], 100) + "</section>"
        return page_shell("Notion Tickets", content)

    def upload(self):
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        form = cgi.FieldStorage(fp=self.rfile, headers=self.headers, environ={"REQUEST_METHOD": "POST", "CONTENT_TYPE": self.headers["Content-Type"]})
        item = form["file"]
        target = UPLOAD_DIR / Path(item.filename).name
        with target.open("wb") as handle:
            shutil.copyfileobj(item.file, handle)
        raw = CSVXLSXConnector(target).load()
        mapping = guess_mapping(list(raw.columns))
        save_mappings(mapping)
        processed = apply_mapping(raw, mapping)
        issues = validate_transactions(processed)
        insert_import(target.name, target.suffix.lower().lstrip("."), raw, processed, issues, is_demo=False)
        return self.redirect("/data-quality?uploaded=1")

    def upload_revenue_catcher_json(self):
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        form = cgi.FieldStorage(fp=self.rfile, headers=self.headers, environ={"REQUEST_METHOD": "POST", "CONTENT_TYPE": self.headers["Content-Type"]})
        item = form["file"]
        target = UPLOAD_DIR / Path(item.filename).name
        with target.open("wb") as handle:
            shutil.copyfileobj(item.file, handle)
        raw = RevenueCatcherJSONConnector(target).load()
        mapping = guess_mapping(list(raw.columns))
        save_mappings(mapping)
        processed = apply_mapping(raw, mapping)
        issues = validate_transactions(processed)
        insert_import(f"Revenue Catcher JSON - {target.name}", "revenue_catcher_json", raw, processed, issues, is_demo=False)
        return self.redirect("/data-quality?source=revenue-catcher-json")

    def upload_creators_json(self):
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        form = cgi.FieldStorage(fp=self.rfile, headers=self.headers, environ={"REQUEST_METHOD": "POST", "CONTENT_TYPE": self.headers["Content-Type"]})
        item = form["file"]
        target = UPLOAD_DIR / Path(item.filename).name
        with target.open("wb") as handle:
            shutil.copyfileobj(item.file, handle)
        raw = RevenueCatcherJSONConnector(target).load()
        count = upsert_creator_lookup(raw)
        return self.respond(f"<section class='panel'><h2>Creators imported</h2><p>Saved {count} Revenue Catcher creators into the local lookup table.</p><p><a class='button' href='/creators'>Open Creators</a></p></section>", HTTPStatus.OK)

    def upload_chatters_json(self):
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        form = cgi.FieldStorage(fp=self.rfile, headers=self.headers, environ={"REQUEST_METHOD": "POST", "CONTENT_TYPE": self.headers["Content-Type"]})
        item = form["file"]
        target = UPLOAD_DIR / Path(item.filename).name
        with target.open("wb") as handle:
            shutil.copyfileobj(item.file, handle)
        raw = RevenueCatcherJSONConnector(target).load()
        count = upsert_chatter_lookup(raw)
        return self.respond(f"<section class='panel'><h2>Chatters imported</h2><p>Saved {count} Revenue Catcher chatters into the local lookup table.</p><p><a class='button' href='/chatters'>Open Chatters</a></p></section>", HTTPStatus.OK)

    def save_revenue_catcher_settings(self):
        length = int(self.headers.get("Content-Length", 0))
        form = parse_qs(self.rfile.read(length).decode("utf-8"))
        settings = load_settings()
        for key in ["revenue_catcher_base_url", "revenue_catcher_start_date"]:
            if key in form:
                settings[key] = form[key][0].strip()
        api_key = form.get("revenue_catcher_api_key", [""])[0].strip()
        if api_key:
            settings["revenue_catcher_api_key"] = api_key
        save_settings(settings)
        return self.redirect("/data-sources?saved=revenue-catcher")

    def import_revenue_catcher_api(self):
        length = int(self.headers.get("Content-Length", 0))
        form = parse_qs(self.rfile.read(length).decode("utf-8"))
        settings = load_settings()
        date_from = date.fromisoformat(form.get("date_from", [settings.get("revenue_catcher_start_date", "2026-05-20")])[0])
        date_to = date.fromisoformat(form.get("date_to", [date.today().isoformat()])[0])
        base_url = settings.get("revenue_catcher_base_url", "https://revenuecatcher-production.up.railway.app").rstrip("/")
        frames = []
        try:
            cursor = date_from
            while cursor <= date_to:
                chunk_end = min(cursor + timedelta(days=6), date_to)
                url = f"{base_url}/api/shifts/export?dateFrom={cursor.isoformat()}&dateTo={chunk_end.isoformat()}"
                frame = RevenueCatcherConnector(url, headers=revenue_catcher_headers(settings)).load()
                if not frame.empty:
                    frames.append(frame)
                cursor = chunk_end + timedelta(days=1)
        except RuntimeError as exc:
            return self.respond(f"<section class='panel'><h2>Import failed</h2><p>{html.escape(str(exc))}</p><p><a class='button' href='/data-sources'>Back to Data Sources</a></p></section>", HTTPStatus.OK)
        raw = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
        mapping = guess_mapping(list(raw.columns))
        save_mappings(mapping)
        processed = apply_mapping(raw, mapping)
        issues = validate_transactions(processed)
        insert_import(f"Revenue Catcher API - shifts/export {date_from} to {date_to}", "revenue_catcher_api", raw, processed, issues, is_demo=False)
        return self.redirect("/data-quality?source=revenue-catcher-api")

    def import_revenue_api(self):
        length = int(self.headers.get("Content-Length", 0))
        form = parse_qs(self.rfile.read(length).decode("utf-8"))
        settings = load_settings()
        date_from = date.fromisoformat(form.get("date_from", [settings.get("revenue_catcher_start_date", "2026-05-20")])[0])
        date_to = date.fromisoformat(form.get("date_to", [date.today().isoformat()])[0])
        base_url = settings.get("revenue_catcher_base_url", "https://revenuecatcher-production.up.railway.app").rstrip("/")
        frames = []
        try:
            cursor = date_from
            while cursor <= date_to:
                chunk_end = min(cursor + timedelta(days=6), date_to)
                url = f"{base_url}/api/revenue?dateFrom={cursor.isoformat()}&dateTo={chunk_end.isoformat()}"
                frame = RevenueCatcherConnector(url, headers=revenue_catcher_headers(settings)).load()
                if not frame.empty:
                    frames.append(frame)
                cursor = chunk_end + timedelta(days=1)
        except RuntimeError as exc:
            return self.respond(f"<section class='panel'><h2>Import failed</h2><p>{html.escape(str(exc))}</p><p><a class='button' href='/data-sources'>Back to Data Sources</a></p></section>", HTTPStatus.OK)
        raw = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
        mapping = guess_mapping(list(raw.columns))
        save_mappings(mapping)
        processed = apply_mapping(raw, mapping)
        issues = validate_transactions(processed)
        insert_import(f"Revenue Catcher API - revenue rows {date_from} to {date_to}", "revenue_catcher_revenue_api", raw, processed, issues, is_demo=False)
        return self.redirect("/data-quality?source=revenue-api")

    def import_revenue_summary_api(self):
        length = int(self.headers.get("Content-Length", 0))
        form = parse_qs(self.rfile.read(length).decode("utf-8"))
        settings = load_settings()
        date_from = date.fromisoformat(form.get("date_from", [settings.get("revenue_catcher_start_date", "2026-05-20")])[0])
        date_to = date.fromisoformat(form.get("date_to", [date.today().isoformat()])[0])
        base_url = settings.get("revenue_catcher_base_url", "https://revenuecatcher-production.up.railway.app").rstrip("/")
        frames = []
        try:
            cursor = date_from
            while cursor <= date_to:
                chunk_end = min(cursor + timedelta(days=6), date_to)
                url = f"{base_url}/api/revenue/summary?dateFrom={cursor.isoformat()}&dateTo={chunk_end.isoformat()}&period=daily"
                frame = RevenueCatcherConnector(url, headers=revenue_catcher_headers(settings)).load()
                if not frame.empty:
                    frames.append(frame)
                cursor = chunk_end + timedelta(days=1)
        except RuntimeError as exc:
            return self.respond(f"<section class='panel'><h2>Import failed</h2><p>{html.escape(str(exc))}</p><p><a class='button' href='/data-sources'>Back to Data Sources</a></p></section>", HTTPStatus.OK)
        raw = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
        mapping = guess_mapping(list(raw.columns))
        save_mappings(mapping)
        processed = apply_mapping(raw, mapping)
        issues = validate_transactions(processed)
        insert_import(f"Revenue Catcher API - revenue/summary {date_from} to {date_to}", "revenue_catcher_summary_api", raw, processed, issues, is_demo=False)
        return self.redirect("/data-quality?source=revenue-summary-api")

    def import_active_shifts_api(self):
        length = int(self.headers.get("Content-Length", 0))
        form = parse_qs(self.rfile.read(length).decode("utf-8"))
        url = form.get("url", ["https://revenuecatcher-production.up.railway.app/api/shifts/active"])[0]
        try:
            raw = RevenueCatcherConnector(url).load()
        except RuntimeError as exc:
            return self.respond(f"<section class='panel'><h2>Import failed</h2><p>{html.escape(str(exc))}</p><p><a class='button' href='/data-sources'>Back to Data Sources</a></p></section>", HTTPStatus.OK)
        mapping = guess_mapping(list(raw.columns))
        save_mappings(mapping)
        processed = apply_mapping(raw, mapping)
        issues = validate_transactions(processed)
        insert_import("Revenue Catcher API - active shifts", "revenue_catcher_active_api", raw, processed, issues, is_demo=False)
        return self.redirect("/data-quality?source=active-shifts-api")

    def import_master_sheet(self):
        settings = load_settings()
        connector = GoogleSheetsConnector(settings["master_google_sheet_id"], settings["master_revenue_gid"])
        try:
            raw = connector.load()
        except RuntimeError as exc:
            return self.respond(f"<section class='panel'><h2>Import failed</h2><p>{html.escape(str(exc))}</p><p><a class='button' href='/data-sources'>Back to Data Sources</a></p></section>", HTTPStatus.OK)
        mapping = guess_mapping(list(raw.columns))
        save_mappings(mapping)
        processed = apply_mapping(raw, mapping)
        issues = validate_transactions(processed)
        insert_import("MD Master Revenue DB - Revenue tab", "google_sheet", raw, processed, issues, is_demo=False)
        return self.redirect("/data-quality?source=master-sheet")

    def import_master_shifts_sheet(self):
        settings = load_settings()
        connector = GoogleSheetsConnector(settings["master_google_sheet_id"], settings["master_shifts_gid"])
        try:
            raw = connector.load()
        except RuntimeError as exc:
            return self.respond(f"<section class='panel'><h2>Import failed</h2><p>{html.escape(str(exc))}</p><p>This tab currently needs to be link-exportable, or you can export the Shifts tab as CSV/XLSX and upload it here.</p><p><a class='button' href='/data-sources'>Back to Data Sources</a></p></section>", HTTPStatus.OK)
        mapping = guess_mapping(list(raw.columns))
        save_mappings(mapping)
        processed = apply_mapping(raw, mapping)
        processed["transaction_type"] = "shift_summary"
        processed["revenue"] = None
        issues = validate_transactions(processed)
        insert_import("MD Master Revenue DB - Shifts tab", "google_sheet_shifts", raw, processed, issues, is_demo=False)
        return self.redirect("/data-quality?source=master-shifts-sheet")

    def export(self, path, params):
        ctx = current_context(params)
        fmt = params.get("format", ["csv"])[0]
        if "transactions" in path:
            df = transaction_analysis(ctx["current"], float(ctx["settings"].get("unlock_threshold", 199)), "unlock")
        else:
            df = ctx["current"]
        output = export_table(df, "transactions", ctx["filters"], fmt)
        return self.respond(f"Export created: {output}", HTTPStatus.OK, "text/plain")

    def static_file(self, path):
        target = STATIC_DIR / path.replace("/static/", "")
        if not target.exists():
            return self.respond("Not found", HTTPStatus.NOT_FOUND)
        content_type = mimetypes.guess_type(target)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "public, max-age=86400")
        self.end_headers()
        self.wfile.write(target.read_bytes())

    def redirect(self, location: str):
        self.send_response(HTTPStatus.SEE_OTHER)
        self.send_header("Location", location)
        self.end_headers()

    def respond(self, body, status=HTTPStatus.OK, content_type="text/html; charset=utf-8"):
        if isinstance(body, bytes):
            data = body
        else:
            data = str(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def run(host=None, port=None):
    port = int(port or os.environ.get("PORT", "8766"))
    host = host or os.environ.get("HOST") or ("0.0.0.0" if os.environ.get("PORT") else "127.0.0.1")
    init_db()
    server = ThreadingHTTPServer((host, port), RevenueAnalyticsHandler)
    print(f"GAZE is running at http://{host}:{port}")
    server.serve_forever()


if __name__ == "__main__":
    run()











