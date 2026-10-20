from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from statistics import mean, median

import pandas as pd


@dataclass
class TargetMonitoringResult:
    table: pd.DataFrame
    raw: pd.DataFrame


def _norm(value) -> str:
    if value is None or pd.isna(value):
        return ""
    return str(value).strip().lower()


def _money(value) -> str:
    try:
        number = float(value or 0)
    except (TypeError, ValueError):
        number = 0.0
    return f"\u20ac{number:,.2f}"


def _pct(value) -> str:
    try:
        number = float(value or 0)
    except (TypeError, ValueError):
        number = 0.0
    return f"{number:.1f}%"


def _date_range(start: date, end: date) -> list[date]:
    days = max(0, (end - start).days)
    return [start + timedelta(days=idx) for idx in range(days + 1)]


def _revenue_rows(df: pd.DataFrame) -> pd.DataFrame:
    if df is None or df.empty:
        return pd.DataFrame(columns=["date", "account", "model", "platform", "revenue"])
    source = df.copy()
    for col in ["transaction_type", "creator", "account_username", "platform", "revenue", "tip_revenue", "message_revenue", "date"]:
        if col not in source:
            source[col] = None
    source["transaction_type"] = source["transaction_type"].fillna("").astype(str).str.lower()
    detailed = source[source["transaction_type"].isin(["tip", "tips", "message", "messages"])].copy()
    if not detailed.empty:
        detailed["target_revenue"] = pd.to_numeric(detailed["revenue"], errors="coerce").fillna(0)
        rows = detailed
    else:
        rows = source[source["transaction_type"].eq("shift_summary")].copy()
        rows["target_revenue"] = (
            pd.to_numeric(rows["tip_revenue"], errors="coerce").fillna(0)
            + pd.to_numeric(rows["message_revenue"], errors="coerce").fillna(0)
        )
    if rows.empty:
        return pd.DataFrame(columns=["date", "account", "model", "platform", "revenue"])
    rows["date"] = pd.to_datetime(rows["date"], errors="coerce").dt.date
    rows["model"] = rows["creator"].fillna("").astype(str).str.strip()
    rows["account"] = rows["account_username"].fillna("").astype(str).str.strip()
    rows.loc[rows["account"].eq("") | rows["account"].str.lower().eq("none"), "account"] = rows["model"]
    rows["platform"] = rows["platform"].fillna("Unknown").astype(str).str.upper().str.strip()
    rows = rows[(rows["date"].notna()) & (rows["account"].ne("")) & (rows["target_revenue"] > 0)].copy()
    if rows.empty:
        return pd.DataFrame(columns=["date", "account", "model", "platform", "revenue"])
    return rows[["date", "account", "model", "platform", "target_revenue"]].rename(columns={"target_revenue": "revenue"})


def _target_lookup(targets: pd.DataFrame) -> dict[tuple[str, str], float]:
    if targets is None or targets.empty:
        return {}
    frame = targets.copy()
    for col in ["account", "account_username", "model", "platform", "current_target"]:
        if col not in frame:
            frame[col] = None
    frame["platform"] = frame["platform"].fillna("").astype(str).str.upper().str.strip()
    frame["current_target"] = pd.to_numeric(frame["current_target"], errors="coerce").fillna(0)
    lookup: dict[tuple[str, str], float] = {}
    for _, row in frame.iterrows():
        target = float(row.get("current_target") or 0)
        if target <= 0:
            continue
        platform = _norm(row.get("platform"))
        # Flow can describe the same account by its username or its model name.
        # Keep every reliable alias so target monitoring matches its transaction rows.
        for column in ("account", "account_username", "model"):
            name = _norm(row.get(column))
            if name:
                # Source rows arrive in Flow-first order. Do not let a lower-
                # priority fallback source overwrite an approved Flow target.
                lookup.setdefault((name, platform), target)
    return lookup


def _classify(hit_days: int, target: float) -> str:
    if target <= 0:
        return "Needs Target"
    if hit_days >= 5:
        return "Increase"
    if hit_days == 0:
        return "Decrease"
    return "Keep"


def build_target_monitoring(df: pd.DataFrame, start: date, end: date, targets: pd.DataFrame | None = None) -> TargetMonitoringResult:
    rows = _revenue_rows(df)
    if rows.empty:
        empty = pd.DataFrame(columns=[
            "Account", "Platform", "Current Target", "Hit Days", "Hit Rate", "Median of Hit Days",
            "Average of Hit Days", "Median of All Days", "Average of All Days", "Action",
            "Suggested Target", "Suggested Target Median", "Suggested Target Ave",
        ])
        return TargetMonitoringResult(table=empty, raw=empty.copy())

    target_map = _target_lookup(targets if targets is not None else pd.DataFrame())
    days = _date_range(start, end)
    grouped = rows.groupby(["account", "model", "platform", "date"], as_index=False)["revenue"].sum()
    output = []
    for (account, model, platform), account_rows in grouped.groupby(["account", "model", "platform"]):
        daily = {day: 0.0 for day in days}
        for _, row in account_rows.iterrows():
            day = row["date"]
            if day in daily:
                daily[day] += float(row["revenue"] or 0)
        values = list(daily.values())
        med_all = float(median(values)) if values else 0.0
        avg_all = float(mean(values)) if values else 0.0
        target = target_map.get((_norm(account), _norm(platform)))
        if not target:
            target = target_map.get((_norm(model), _norm(platform)))
        if not target:
            target = target_map.get((_norm(account), ""), target_map.get((_norm(model), ""), 0.0))
        comparison_target = target if target > 0 else avg_all
        hit_values = [value for value in values if comparison_target > 0 and value >= comparison_target]
        hit_days = len(hit_values)
        hit_rate = hit_days / len(values) * 100 if values else 0.0
        med_hit = float(median(hit_values)) if hit_values else 0.0
        avg_hit = float(mean(hit_values)) if hit_values else 0.0
        action = _classify(hit_days, target)
        suggested_median = target
        suggested_average = target
        if action == "Increase":
            suggested_median = med_hit
            suggested_average = avg_hit
        elif action == "Decrease":
            suggested_median = med_all
            suggested_average = avg_all
        elif action == "Needs Target":
            suggested_median = med_all
            suggested_average = avg_all
        display_model = model or account
        output.append({
            "Model": display_model,
            "Account": account,
            "Platform": platform,
            "Current Target Value": target,
            "Current Target": _money(target) if target else "Needs Target",
            "Hit Days": hit_days,
            "Hit Rate Value": hit_rate,
            "Hit Rate": _pct(hit_rate),
            "Median of Hit Days Value": med_hit,
            "Median of Hit Days": _money(med_hit),
            "Average of Hit Days Value": avg_hit,
            "Average of Hit Days": _money(avg_hit),
            "Median of All Days Value": med_all,
            "Median of All Days": _money(med_all),
            "Average of All Days Value": avg_all,
            "Average of All Days": _money(avg_all),
            "Action": action,
            "Suggested Target Value": suggested_average,
            "Suggested Target": _money(suggested_average),
            "Suggested Target Median": _money(suggested_median),
            "Suggested Target Ave": _money(suggested_average),
            "Evaluated Days": len(values),
        })
    raw = pd.DataFrame(output)
    priority = {"Increase": 0, "Decrease": 1, "Keep": 2, "Needs Target": 3}
    raw["_priority"] = raw["Action"].map(priority).fillna(9)
    raw = raw.sort_values(["_priority", "Suggested Target Value", "Model", "Platform"], ascending=[True, False, True, True]).drop(columns=["_priority"])
    display_cols = [
        "Model", "Platform", "Current Target", "Hit Days", "Hit Rate", "Median of Hit Days",
        "Average of Hit Days", "Median of All Days", "Average of All Days", "Action",
        "Suggested Target", "Suggested Target Median", "Suggested Target Ave",
    ]
    return TargetMonitoringResult(table=raw[display_cols].copy(), raw=raw.copy())
