from __future__ import annotations

from pathlib import Path
from datetime import date
import re

import pandas as pd

from .config import DATA_DIR
from .notion_source import load_ticket_rows

LOOKER_DATA_DIR = DATA_DIR / "looker_sources"
MARKETING_SHEET_ID = "1y_R1cgIc5A4-vFrqY9OC-gQm4NdKJnsCZLn93ONu2ak"
MARKETING_ADS_GID = "2065549255"
OF_NEW_FANS_SHEET_ID = "14wXRPz6vm9gPE5I0UhlS9Dr7Eopj1JYDK7hm4uiNChY"
OF_NEW_FANS_GID = "1377579258"

SOURCES = {
    "compliance": {
        "title": "ADG - MD - Project Dusan Dashboard",
        "url": "https://docs.google.com/spreadsheets/d/1D0lnC5q88Q9uRfbaSK3B_yLrskv0EHzQE89pmGqOfJQ/edit?usp=drivesdk",
        "tabs": {
            "ComplianceLooker": "compliance_looker.csv",
            "ComplianceMetric": "compliance_metric.csv",
        },
    },
    "marketing": {
        "title": "ADG - MD - Marketing Performance Tracker",
        "url": "https://docs.google.com/spreadsheets/d/1y_R1cgIc5A4-vFrqY9OC-gQm4NdKJnsCZLn93ONu2ak/edit?usp=drivesdk",
        "tabs": {
            "MDAds": "marketing_ads.csv",
            "LisaMD": "models_lisa_md.csv",
            "LisaModelsRaw": "models_lisa_raw.csv",
            "OFNewFans": "of_new_fans.csv",
        },
    },
    "tickets": {
        "title": "ADG - MD - Internal Ticketing - Reporting Hub",
        "url": "https://docs.google.com/spreadsheets/d/1Xa46BD1ypJI3dUfAoVALsE39RYi1j-jsQDzjXujGlAI/edit?usp=drivesdk",
        "tabs": {
            "RAW - Notion Tickets": "notion_tickets.csv",
            "CLEAN - Tickets": None,
            "REPORT - Ticketing KPI": None,
        },
    },
}


def load_source(filename: str) -> pd.DataFrame:
    path = LOOKER_DATA_DIR / filename
    if not path.exists():
        return pd.DataFrame()
    rows = pd.read_csv(path)
    rows.attrs["source"] = "Cached snapshot"
    return rows


def load_google_sheet_source(spreadsheet_id: str, gid: str, fallback_filename: str | None = None) -> pd.DataFrame:
    url = f"https://docs.google.com/spreadsheets/d/{spreadsheet_id}/export?format=csv&gid={gid}"
    try:
        rows = pd.read_csv(url)
        rows.attrs["source"] = "Live Google Sheet"
        return rows
    except Exception:
        if fallback_filename:
            return load_source(fallback_filename)
        return pd.DataFrame()


def clean_number(value) -> float:
    if value is None or pd.isna(value):
        return 0.0
    text = str(value).strip()
    if not text or text.lower() in {"nan", "none", "warmup"}:
        return 0.0
    text = text.replace("$", "").replace("EUR", "").replace(",", "").replace("%", "").strip()
    try:
        return float(text)
    except ValueError:
        return 0.0


def numeric_series(df: pd.DataFrame, column: str) -> pd.Series:
    if df.empty or column not in df:
        return pd.Series(dtype=float)
    return df[column].apply(clean_number)


def parsed_date_series(df: pd.DataFrame) -> pd.Series:
    if df.empty:
        return pd.Series(dtype="object")
    date_col = next((col for col in ["Date of Evaluation", "Date", "Created", "Created At"] if col in df), None)
    if not date_col:
        return pd.Series([pd.NaT] * len(df), index=df.index)
    default_year = date.today().year

    def parse_row(row):
        raw = str(row.get(date_col) or "").strip()
        if not raw or raw.lower() in {"nan", "none"}:
            return pd.NaT
        if not any(char.isdigit() for char in raw):
            return pd.NaT
        if not any(str(year) in raw for year in range(2020, 2031)):
            year_value = row.get("Year") if "Year" in row else None
            year = int(clean_number(year_value)) if year_value is not None and clean_number(year_value) else default_year
            raw = f"{raw} {year}"
        if re.match(r"^\d{4}-\d{1,2}-\d{1,2}$", raw):
            return pd.to_datetime(raw, errors="coerce")
        return pd.to_datetime(raw, errors="coerce", dayfirst=True)

    return df.apply(parse_row, axis=1).dt.date


def filter_by_date(df: pd.DataFrame, start: date | None = None, end: date | None = None) -> pd.DataFrame:
    if df.empty or start is None or end is None:
        return df.copy()
    dates = parsed_date_series(df)
    filtered = df[(dates >= start) & (dates <= end)].copy()
    return filtered


def source_summary(source_key: str) -> dict:
    return SOURCES[source_key]


def compliance_data(start: date | None = None, end: date | None = None) -> dict:
    all_looker = load_source("compliance_looker.csv")
    looker = filter_by_date(all_looker, start, end)
    metric = load_source("compliance_metric.csv")
    if looker.empty and not all_looker.empty:
        looker = all_looker.copy()
    if looker.empty:
        return {"cards": [], "latest": looker, "metrics": metric}
    latest_label = looker["Date of Evaluation"].dropna().iloc[-1] if "Date of Evaluation" in looker else "latest"
    latest = looker[looker["Date of Evaluation"] == latest_label].copy() if "Date of Evaluation" in looker else looker.tail(6).copy()
    best_avg = numeric_series(latest, "Best Score").mean()
    worst_avg = numeric_series(latest, "Worst Score").mean()
    cards = [
        ("Latest Evaluation", str(latest_label), "Looker source"),
        ("Avg Best Score", f"{best_avg:.1f}", "latest period"),
        ("Avg Worst Score", f"{worst_avg:.1f}", "latest period"),
        ("Pillars Tracked", str(int(latest["Pillar"].nunique())) if "Pillar" in latest else "0", "quality areas"),
    ]
    return {"cards": cards, "latest": latest, "metrics": metric}


def ads_data(start: date | None = None, end: date | None = None) -> dict:
    source_ads = load_google_sheet_source(MARKETING_SHEET_ID, MARKETING_ADS_GID, "marketing_ads.csv")
    source_label = source_ads.attrs.get("source", "")
    source_dates = parsed_date_series(source_ads)
    latest_source_date = source_dates.max() if not source_dates.empty else None
    latest_source_label = "" if pd.isna(latest_source_date) else latest_source_date.strftime("%d %b %Y")
    ads = filter_by_date(source_ads, start, end)
    if ads.empty:
        return {"cards": [], "by_platform": ads, "by_campaign": ads, "raw": ads, "source": source_label, "latest_source_date": latest_source_label}
    ads = ads.copy()
    ads["impressions_num"] = numeric_series(ads, "Impressions")
    ads["clicks_num"] = numeric_series(ads, "Link Clicks (Leads)")
    ads["spend_num"] = numeric_series(ads, "Ad Spend")
    ads["leads_signed_num"] = numeric_series(ads, "Leads Signed")
    total_spend = ads["spend_num"].sum()
    total_clicks = ads["clicks_num"].sum()
    total_signed = ads["leads_signed_num"].sum()
    cards = [
        ("Ad Spend", f"\u20ac{total_spend:,.2f}", source_label.lower() if source_label else "selected source"),
        ("Impressions", f"{ads['impressions_num'].sum():,.0f}", "total"),
        ("Link Clicks", f"{total_clicks:,.0f}", "leads"),
        ("Cost / Click", f"\u20ac{total_spend / total_clicks:,.2f}" if total_clicks else "n/a", "calculated"),
        ("Leads Signed", f"{total_signed:,.0f}", "reported"),
    ]
    by_platform = (
        ads.groupby("Platform", dropna=False)
        .agg(impressions=("impressions_num", "sum"), clicks=("clicks_num", "sum"), ad_spend=("spend_num", "sum"), leads_signed=("leads_signed_num", "sum"))
        .reset_index()
        .sort_values("ad_spend", ascending=False)
    )
    by_campaign = (
        ads.groupby("Campaign Name", dropna=False)
        .agg(impressions=("impressions_num", "sum"), clicks=("clicks_num", "sum"), ad_spend=("spend_num", "sum"), leads_signed=("leads_signed_num", "sum"))
        .reset_index()
        .sort_values("ad_spend", ascending=False)
    )
    return {"cards": cards, "by_platform": by_platform, "by_campaign": by_campaign, "raw": ads, "source": source_label, "latest_source_date": latest_source_label}


def model_socials_data(start: date | None = None, end: date | None = None) -> dict:
    rows = filter_by_date(load_source("models_lisa_raw.csv"), start, end)
    if rows.empty:
        return {"cards": [], "by_model": rows, "by_platform": rows, "raw": rows}
    rows = rows.copy()
    for source, target in [
        ("Impressions", "impressions"),
        ("Profile Visits", "profile_visits"),
        ("Followers Gained", "followers_gained"),
        ("Bio Link Clicks", "bio_clicks"),
        ("Bouncy Link Clicks", "bouncy_clicks"),
        ("Subscriptions (F2F)", "subscriptions_f2f"),
        ("Subscriptions (OF)", "subscriptions_of"),
        ("Content Planned", "content_planned"),
        ("Content Posted", "content_posted"),
    ]:
        rows[target] = numeric_series(rows, source)
    rows["subscriptions"] = rows["subscriptions_f2f"] + rows["subscriptions_of"]
    cards = [
        ("Impressions", f"{rows['impressions'].sum():,.0f}", "social reach"),
        ("Profile Visits", f"{rows['profile_visits'].sum():,.0f}", "total"),
        ("Followers Gained", f"{rows['followers_gained'].sum():,.0f}", "growth"),
        ("Subscriptions", f"{rows['subscriptions'].sum():,.0f}", "F2F + OF"),
    ]
    by_model = (
        rows.groupby("Model", dropna=False)
        .agg(impressions=("impressions", "sum"), profile_visits=("profile_visits", "sum"), followers_gained=("followers_gained", "sum"), subscriptions=("subscriptions", "sum"), content_posted=("content_posted", "sum"))
        .reset_index()
        .sort_values("impressions", ascending=False)
    )
    by_platform = (
        rows.groupby("Platform", dropna=False)
        .agg(impressions=("impressions", "sum"), profile_visits=("profile_visits", "sum"), followers_gained=("followers_gained", "sum"), subscriptions=("subscriptions", "sum"))
        .reset_index()
        .sort_values("impressions", ascending=False)
    )
    return {"cards": cards, "by_model": by_model, "by_platform": by_platform, "raw": rows}


def of_new_fans_data(start: date | None = None, end: date | None = None) -> dict:
    wide = filter_by_date(load_google_sheet_source(OF_NEW_FANS_SHEET_ID, OF_NEW_FANS_GID, "of_new_fans.csv"), start, end)
    if wide.empty or "Date" not in wide:
        return {"cards": [], "by_model": wide, "daily": wide, "raw": wide}
    value_cols = [col for col in wide.columns if col != "Date"]
    long = wide.melt(id_vars=["Date"], value_vars=value_cols, var_name="model", value_name="new_fans")
    long["model"] = long["model"].astype(str).str.strip()
    long["new_fans"] = long["new_fans"].apply(clean_number)
    by_model = long.groupby("model", dropna=False)["new_fans"].sum().reset_index().sort_values("new_fans", ascending=False)
    daily = long.groupby("Date", dropna=False)["new_fans"].sum().reset_index()
    total_new = long["new_fans"].sum()
    best_model = by_model.iloc[0]["model"] if not by_model.empty else "n/a"
    best_day = daily.sort_values("new_fans", ascending=False).iloc[0]["Date"] if not daily.empty else "n/a"
    cards = [
        ("New Fans", f"{total_new:,.0f}", "OF total"),
        ("Models Tracked", str(int(by_model["model"].nunique())) if not by_model.empty else "0", "source columns"),
        ("Top Model", str(best_model), "by new fans"),
        ("Best Day", str(best_day), "highest daily total"),
    ]
    return {"cards": cards, "by_model": by_model, "daily": daily, "raw": wide}


def tickets_data(start: date | None = None, end: date | None = None) -> dict:
    source_rows = load_ticket_rows()
    source_label = source_rows.attrs.get("source", "Notion API") if not source_rows.empty else ""
    if source_rows.empty:
        source_rows = load_source("notion_tickets.csv")
        if not source_rows.empty:
            source_label = "Cached ticket snapshot"
    if source_rows.empty:
        return {"cards": [], "by_department_status": pd.DataFrame(), "by_status": pd.DataFrame(), "tickets": source_rows, "source": "No ticket source connected", "latest_created": ""}

    if source_label == "Notion API":
        live_columns = {str(col).strip().lower() for col in source_rows.columns}
        has_ticket_shape = all(
            live_columns & group
            for group in [
                {"ticket subject", "name", "subject", "title", "task"},
                {"status", "ticket status"},
                {"department", "responsible department", "team"},
            ]
        )
        if not has_ticket_shape:
            cached_rows = load_source("notion_tickets.csv")
            if not cached_rows.empty:
                source_rows = cached_rows
                source_label = "Cached ticket snapshot"

    rows = source_rows.copy()

    def pick(*names: str) -> pd.Series:
        normalized = {str(col).strip().lower(): col for col in rows.columns}
        for name in names:
            col = normalized.get(name.strip().lower())
            if col is not None:
                return rows[col]
        return pd.Series([""] * len(rows), index=rows.index)

    rows = pd.DataFrame(
        {
            "Created": pick("Created", "Created time", "Created Time", "Created At", "Date"),
            "Ticket Subject": pick("Ticket Subject", "Name", "Subject", "Title", "Task"),
            "Department": pick("Department", "Responsible Department", "Team"),
            "Assignee": pick("Assignee", "Assigned To", "Owner"),
            "Urgency": pick("Urgency", "Priority"),
            "Status": pick("Status", "Ticket Status"),
        }
    )
    rows = filter_by_date(rows, start, end)
    if rows.empty:
        return {"cards": [], "by_department_status": pd.DataFrame(), "by_status": pd.DataFrame(), "tickets": rows, "source": source_label, "latest_created": ""}
    rows = rows.copy()
    source_created_dates = pd.to_datetime(rows["Created"], errors="coerce")
    latest_created = source_created_dates.max()
    latest_created_label = "" if pd.isna(latest_created) else f"{latest_created.day} {latest_created.strftime('%b %Y')}"
    rows["Department"] = rows["Department"].fillna("").replace("", "Unassigned")
    rows["Ticket Subject"] = rows["Ticket Subject"].fillna("").replace("", "Untitled ticket")
    rows["Assignee"] = rows["Assignee"].fillna("").replace("", "Unassigned")
    rows["Urgency"] = rows["Urgency"].fillna("").replace("", "None")
    rows["Status"] = rows["Status"].fillna("").replace("", "Unknown")
    rows["Created"] = source_created_dates.apply(lambda x: "" if pd.isna(x) else f"{x.day} {x.strftime('%b %Y')}")

    status_counts = rows["Status"].value_counts().rename_axis("status").reset_index(name="tickets")
    department_status = (
        rows.groupby(["Department", "Status"], dropna=False)
        .size()
        .rename("tickets")
        .reset_index()
    )
    total = len(rows)
    unassigned = int(rows["Assignee"].eq("Unassigned").sum())
    open_count = int(rows["Status"].isin(["New", "In progress"]).sum())
    completed = int(rows["Status"].eq("Completed").sum())
    finalized = int(rows["Status"].isin(["Completed", "Declined"]).sum())
    cards = [
        ("Total Tickets", str(total), "created"),
        ("Unassigned", str(unassigned), "needs owner"),
        ("Open", str(open_count), "new + in progress"),
        ("Completed", str(completed), "done"),
        ("Finalized", str(finalized), "completed + declined"),
    ]
    return {
        "cards": cards,
        "by_department_status": department_status,
        "by_status": status_counts,
        "tickets": rows[["Created", "Ticket Subject", "Department", "Assignee", "Urgency", "Status"]],
        "source": source_label,
        "latest_created": latest_created_label,
    }


def inactivity_monitor_rows(start: date | None = None, end: date | None = None, view: str = "Chatter") -> pd.DataFrame:
    rows = load_source("inactivity_monitor.csv")
    if rows.empty:
        return rows
    rows = rows.copy()
    rows["date_from"] = pd.to_datetime(rows["date_from"], errors="coerce").dt.date
    rows["date_to"] = pd.to_datetime(rows["date_to"], errors="coerce").dt.date
    rows = rows[rows["view"].fillna("").eq(view)].copy()
    if start is not None and end is not None:
        rows = rows[(rows["date_to"] >= start) & (rows["date_from"] <= end)].copy()
    for col in ["events", "total_unread", "max_unread", "total_hours", "max_hours", "money_wasted"]:
        rows[col] = pd.to_numeric(rows[col], errors="coerce").fillna(0)
    return rows


def inactivity_monitor_summary(rows: pd.DataFrame) -> dict:
    if rows.empty:
        return {
            "events": 0,
            "total_unread": 0,
            "max_unread": 0,
            "total_hours": 0.0,
            "max_hours": 0.0,
            "money_wasted": 0.0,
            "worst_name": "n/a",
            "worst_money": 0.0,
        }
    worst = rows.sort_values("money_wasted", ascending=False).iloc[0]
    return {
        "events": int(rows["events"].sum()),
        "total_unread": int(rows["total_unread"].sum()),
        "max_unread": int(rows["max_unread"].max()),
        "total_hours": float(rows["total_hours"].sum()),
        "max_hours": float(rows["max_hours"].max()),
        "money_wasted": float(rows["money_wasted"].sum()),
        "worst_name": str(worst["name"]),
        "worst_money": float(worst["money_wasted"]),
    }
