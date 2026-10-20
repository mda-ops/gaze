from __future__ import annotations

from datetime import date, timedelta
from typing import Iterable

import pandas as pd


def safe_pct_change(current: float, previous: float) -> float | None:
    if previous is None or pd.isna(previous) or previous == 0:
        return None
    return (current - previous) / previous * 100


def date_range_for(label: str, today: date | None = None, week_start: str = "Friday") -> tuple[date, date]:
    today = today or date.today()
    week_start_idx = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].index(week_start)
    days_since_start = (today.weekday() - week_start_idx) % 7
    this_week_start = today - timedelta(days=days_since_start)
    if label == "Today":
        return today, today
    if label == "Yesterday":
        y = today - timedelta(days=1)
        return y, y
    if label == "This week":
        return this_week_start, today
    if label == "Last week":
        start = this_week_start - timedelta(days=7)
        return start, start + timedelta(days=6)
    if label == "Last 7 days":
        return today - timedelta(days=6), today
    if label == "Last 30 days":
        return today - timedelta(days=29), today
    if label == "This month":
        return today.replace(day=1), today
    if label == "Last month":
        first_this = today.replace(day=1)
        last_prev = first_this - timedelta(days=1)
        return last_prev.replace(day=1), last_prev
    return today - timedelta(days=29), today


def comparison_range(start: date, end: date, mode: str) -> tuple[date, date]:
    days = (end - start).days + 1
    if mode == "Previous week":
        return start - timedelta(days=7), end - timedelta(days=7)
    if mode == "Previous month":
        return start - timedelta(days=30), end - timedelta(days=30)
    return start - timedelta(days=days), start - timedelta(days=1)


def filter_period(df: pd.DataFrame, start: date, end: date, filters: dict | None = None) -> pd.DataFrame:
    if df.empty:
        return df.copy()
    filtered = df.copy()
    filtered = filtered[(filtered["date"] >= start) & (filtered["date"] <= end)]
    filters = filters or {}
    for field in ["platform", "team", "language", "creator", "chatter", "transaction_type"]:
        value = filters.get(field)
        if value and field in filtered:
            if isinstance(value, list):
                filtered = filtered[filtered[field].fillna("Unknown").isin(value)]
            else:
                filtered = filtered[filtered[field].fillna("Unknown") == value]
    return filtered


def total(series: pd.Series) -> float:
    return float(series.dropna().sum()) if not series.empty else 0.0


def distinct_count(df: pd.DataFrame, col: str) -> int:
    if col not in df or df.empty:
        return 0
    return int(df[col].dropna().replace("", pd.NA).dropna().nunique())


def executive_metrics(current: pd.DataFrame, previous: pd.DataFrame) -> dict:
    revenue = total(current.get("revenue", pd.Series(dtype=float)))
    prev_revenue = total(previous.get("revenue", pd.Series(dtype=float)))
    hours = total(current.get("shift_hours", pd.Series(dtype=float)))
    inactivity_source = current.get("inactive_minutes", pd.Series(dtype=float))
    inactivity = total(inactivity_source) if not inactivity_source.dropna().empty else None
    chatters = distinct_count(current, "chatter")
    creators = distinct_count(current, "creator")
    return {
        "total_revenue": revenue,
        "previous_revenue": prev_revenue,
        "revenue_change_pct": safe_pct_change(revenue, prev_revenue),
        "revenue_per_hour": revenue / hours if hours else None,
        "active_chatters": chatters,
        "active_creators": creators,
        "total_hours": hours,
        "total_inactivity": inactivity,
        "avg_revenue_per_chatter": revenue / chatters if chatters else None,
        "avg_revenue_per_creator": revenue / creators if creators else None,
        "transactions": int(len(current)),
        "average_transaction_value": revenue / len(current) if len(current) else None,
    }


def trend(df: pd.DataFrame, group: str = "date") -> list[dict]:
    if df.empty:
        return []
    result = df.groupby(group, dropna=False)["revenue"].sum().reset_index()
    result[group] = result[group].astype(str)
    return result.to_dict("records")


def group_performance(current: pd.DataFrame, previous: pd.DataFrame, group: str) -> pd.DataFrame:
    if current.empty and previous.empty:
        return pd.DataFrame()
    current = current.copy()
    previous = previous.copy()
    if group in current:
        current[group] = current[group].fillna("Unknown").replace("", "Unknown")
    if group in previous:
        previous[group] = previous[group].fillna("Unknown").replace("", "Unknown")
    cur = current.groupby(group, dropna=False).agg(
        revenue=("revenue", "sum"),
        hours=("shift_hours", "sum"),
        messages=("messages_sent", "sum"),
        inactivity=("inactive_minutes", "sum"),
        transactions=("revenue", "count"),
        creators_worked=("creator", pd.Series.nunique),
        days=("date", pd.Series.nunique),
    ).reset_index()
    prev = previous.groupby(group, dropna=False).agg(previous_revenue=("revenue", "sum")).reset_index()
    merged = cur.merge(prev, on=group, how="left")
    merged["previous_revenue"] = merged["previous_revenue"].fillna(0)
    total_revenue = merged["revenue"].sum()
    merged["change_amount"] = merged["revenue"] - merged["previous_revenue"]
    merged["change_pct"] = merged.apply(lambda r: safe_pct_change(r["revenue"], r["previous_revenue"]), axis=1)
    merged["revenue_per_hour"] = merged.apply(lambda r: r["revenue"] / r["hours"] if r["hours"] else None, axis=1)
    merged["messages_per_hour"] = merged.apply(lambda r: r["messages"] / r["hours"] if r["hours"] else None, axis=1)
    merged["revenue_share_pct"] = merged["revenue"].apply(lambda x: x / total_revenue * 100 if total_revenue else None)
    merged["average_revenue_per_day"] = merged.apply(lambda r: r["revenue"] / r["days"] if r["days"] else None, axis=1)
    merged["average_transaction_value"] = merged.apply(lambda r: r["revenue"] / r["transactions"] if r["transactions"] else None, axis=1)
    return merged.sort_values("revenue", ascending=False).reset_index(drop=True)


def creator_performance(current: pd.DataFrame, previous: pd.DataFrame) -> pd.DataFrame:
    base = group_performance(current, previous, "creator")
    if base.empty:
        return base
    extras = current.groupby("creator", dropna=False).agg(
        active_chatters=("chatter", pd.Series.nunique),
        unlock_revenue=("unlock_amount", "sum"),
        tip_revenue=("tip_revenue", "sum"),
        subscription_revenue=("subscription_revenue", "sum"),
    ).reset_index()
    result = base.merge(extras, on="creator", how="left")
    result["revenue_per_chatter"] = result.apply(lambda r: r["revenue"] / r["active_chatters"] if r["active_chatters"] else None, axis=1)
    return result


def top_n_concentration(current: pd.DataFrame, ns: Iterable[int] = (1, 3, 5, 8, 10)) -> dict:
    if current.empty:
        return {f"top_{n}_share_pct": None for n in ns}
    by_chatter = current.dropna(subset=["chatter"]).groupby("chatter")["revenue"].sum().sort_values(ascending=False)
    total_revenue = by_chatter.sum()
    out = {}
    for n in ns:
        out[f"top_{n}_share_pct"] = float(by_chatter.head(n).sum() / total_revenue * 100) if total_revenue else None
    return out


def transaction_analysis(current: pd.DataFrame, threshold: float, transaction_type: str | list[str] | None = None) -> pd.DataFrame:
    if current.empty:
        return current
    df = current.copy()
    amount = df["unlock_amount"].where(df["unlock_amount"].notna() & (df["unlock_amount"] > 0), df["revenue"])
    df = df.assign(amount=amount)
    if transaction_type:
        if isinstance(transaction_type, list):
            df = df[df["transaction_type"].isin(transaction_type)]
        else:
            df = df[df["transaction_type"] == transaction_type]
    df = df[df["amount"] >= threshold]
    df["chatter_status"] = df["chatter"].apply(lambda value: "Missing / Unassigned" if pd.isna(value) or str(value).strip() == "" else "Assigned")
    return df.sort_values("amount", ascending=False)


def inactivity_analysis(current: pd.DataFrame) -> pd.DataFrame:
    if current.empty:
        return pd.DataFrame()
    result = current.groupby("chatter", dropna=False).agg(
        revenue=("revenue", "sum"),
        hours=("shift_hours", "sum"),
        inactivity=("inactive_minutes", "sum"),
        transactions=("revenue", "count"),
    ).reset_index()
    result["inactivity_per_hour"] = result.apply(lambda r: r["inactivity"] / r["hours"] if r["hours"] else None, axis=1)
    result["revenue_per_hour"] = result.apply(lambda r: r["revenue"] / r["hours"] if r["hours"] else None, axis=1)
    return result.sort_values("inactivity", ascending=False)


def commission_rule_for_row(row: pd.Series, settings: dict) -> dict:
    """Return the most specific active commission rule for a revenue or shift row."""
    rules = settings.get("commission_rules") or [{}]
    row_date = str(row.get("date") or "")[:10]
    best: tuple[int, int, dict] | None = None
    for index, rule in enumerate(rules):
        effective_from = str(rule.get("effective_from") or "")[:10]
        effective_until = str(rule.get("effective_until") or "")[:10]
        if row_date and ((effective_from and row_date < effective_from) or (effective_until and row_date > effective_until)):
            continue
        score = 0
        matches = True
        for field in ("platform", "creator", "chatter", "team"):
            expected = str(rule.get(field) or "*").strip()
            actual = str(row.get(field) or "").strip()
            if expected and expected != "*":
                if expected.casefold() != actual.casefold():
                    matches = False
                    break
                score += 1
        if matches and (best is None or score > best[0]):
            best = (score, index, rule)
    return best[2] if best is not None else rules[0]


def commission_analysis(current: pd.DataFrame, settings: dict) -> pd.DataFrame:
    if current.empty:
        return pd.DataFrame()
    result = current.copy()
    rules = result.apply(lambda row: commission_rule_for_row(row, settings), axis=1)
    for field in ("creator_pct", "external_partner_pct", "other_commission_pct", "chatter_commission_pct", "salary_per_hour"):
        result[field] = pd.to_numeric(rules.map(lambda rule: rule.get(field, 0)), errors="coerce").fillna(0.0)
    result["commission_plan"] = rules.map(lambda rule: str(rule.get("name") or "Unnamed commission plan"))
    result["creator_commission"] = result["revenue"] * result["creator_pct"] / 100
    result["external_partner_commission"] = result["revenue"] * result["external_partner_pct"] / 100
    result["other_commission"] = result["revenue"] * result["other_commission_pct"] / 100
    result["chatter_payout"] = result["revenue"] * result["chatter_commission_pct"] / 100
    result["company_net_revenue"] = result["revenue"] - result[["creator_commission", "external_partner_commission", "other_commission", "chatter_payout"]].sum(axis=1)
    return result
