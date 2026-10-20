from __future__ import annotations

import calendar
from dataclasses import dataclass
from datetime import date

import pandas as pd

CHATTER_MONTHLY_THRESHOLDS = {"A": 50000.0, "B": 15000.0}


def _monthly_tier_for_amount(amount: float) -> str:
    if amount >= CHATTER_MONTHLY_THRESHOLDS["A"]:
        return "A"
    if amount >= CHATTER_MONTHLY_THRESHOLDS["B"]:
        return "B"
    return "C"


@dataclass(frozen=True)
class MonthlyTierMatrix:
    months: list[date]
    rows: list[dict]
    latest_counts: dict[str, int]
    first_month: date | None
    last_month: date | None


def _month_start(value: date) -> date:
    return date(value.year, value.month, 1)


def _month_days(value: date) -> int:
    return calendar.monthrange(value.year, value.month)[1]


def _add_months(value: date, months: int) -> date:
    month_index = value.month - 1 + months
    return date(value.year + month_index // 12, month_index % 12 + 1, 1)


def _month_range(first_month: date, last_month: date) -> list[date]:
    months = []
    current = first_month
    while current <= last_month:
        months.append(current)
        current = _add_months(current, 1)
    return months


def _clean_monthly_revenue(transactions: pd.DataFrame) -> pd.DataFrame:
    if transactions is None or transactions.empty or "creator" not in transactions:
        return pd.DataFrame(columns=["model", "month", "revenue"])

    rows = transactions.copy()
    rows["model"] = rows["creator"].fillna("").astype(str).str.strip()
    rows = rows[~rows["model"].isin(["", "Unknown", "None", "nan"])]
    if rows.empty:
        return pd.DataFrame(columns=["model", "month", "revenue"])

    rows["date"] = pd.to_datetime(rows.get("date"), errors="coerce")
    rows = rows[rows["date"].notna()].copy()
    if rows.empty:
        return pd.DataFrame(columns=["model", "month", "revenue"])

    transaction_type = rows.get("transaction_type", pd.Series("", index=rows.index)).fillna("").astype(str).str.lower().str.strip()
    revenue = pd.to_numeric(rows.get("revenue", pd.Series(0, index=rows.index)), errors="coerce").fillna(0)
    tip_revenue = pd.to_numeric(rows.get("tip_revenue", pd.Series(0, index=rows.index)), errors="coerce").fillna(0)
    message_revenue = pd.to_numeric(rows.get("message_revenue", pd.Series(0, index=rows.index)), errors="coerce").fillna(0)

    rows["revenue_for_tier"] = 0.0
    rows.loc[transaction_type.isin(["tip", "tips", "message", "messages"]), "revenue_for_tier"] = revenue
    rows.loc[transaction_type.eq("shift_summary"), "revenue_for_tier"] = tip_revenue + message_revenue
    rows = rows[rows["revenue_for_tier"] > 0].copy()
    if rows.empty:
        return pd.DataFrame(columns=["model", "month", "revenue"])

    rows["month"] = rows["date"].dt.to_period("M").dt.to_timestamp().dt.date
    return (
        rows.groupby(["model", "month"], dropna=False)
        .agg(revenue=("revenue_for_tier", "sum"))
        .reset_index()
    )


def build_chatter_revenue_tier_matrix(transactions: pd.DataFrame) -> MonthlyTierMatrix:
    monthly = _clean_monthly_revenue(transactions)
    if monthly.empty:
        return MonthlyTierMatrix([], [], {"A": 0, "B": 0, "C": 0}, None, None)

    current_month = _month_start(date.today())
    completed_month = _add_months(current_month, -1)
    first_data_month = _month_start(min(monthly["month"]))
    last_data_month = _month_start(max(monthly["month"]))
    first_month = first_data_month
    last_month = min(last_data_month, completed_month)
    monthly = monthly[monthly["month"] <= last_month].copy()
    if monthly.empty or last_month < first_month:
        return MonthlyTierMatrix([], [], {"A": 0, "B": 0, "C": 0}, None, None)
    months = _month_range(first_month, last_month)
    pivot = monthly.pivot_table(index="model", columns="month", values="revenue", aggfunc="sum", fill_value=0.0)

    rows = []
    tier_rank = {"A": 3, "B": 2, "C": 1, "": 0}
    latest_counts = {"A": 0, "B": 0, "C": 0}
    latest_month = months[-1]
    for model in sorted(pivot.index, key=lambda item: str(item).lower()):
        cells = []
        previous_tier = ""
        latest_tier = ""
        latest_revenue = 0.0
        for month in months:
            revenue = float(pivot.loc[model, month]) if month in pivot.columns else 0.0
            tier = _monthly_tier_for_amount(revenue) if revenue > 0 else ""
            if not previous_tier or not tier:
                arrow = ""
            elif tier_rank[tier] > tier_rank[previous_tier]:
                arrow = "up"
            elif tier_rank[tier] < tier_rank[previous_tier]:
                arrow = "down"
            else:
                arrow = "same"
            cells.append({"month": month, "tier": tier, "arrow": arrow, "revenue": revenue})
            previous_tier = tier or previous_tier
            if month == latest_month:
                latest_tier = tier
                latest_revenue = revenue
        if latest_tier in latest_counts:
            latest_counts[latest_tier] += 1
        rows.append(
            {
                "model": model,
                "cells": cells,
                "latest_tier": latest_tier or "No tier",
                "latest_revenue": latest_revenue,
            }
        )

    rows.sort(key=lambda row: ({"A": 0, "B": 1, "C": 2}.get(row["latest_tier"], 3), -row["latest_revenue"], row["model"].lower()))
    return MonthlyTierMatrix(months, rows, latest_counts, first_month, last_month)


def monthly_tier_thresholds() -> dict[str, float]:
    return CHATTER_MONTHLY_THRESHOLDS.copy()
