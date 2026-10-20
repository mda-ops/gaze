from __future__ import annotations

import pandas as pd

from .analytics import executive_metrics, group_performance, safe_pct_change, top_n_concentration


def factual_insights(current: pd.DataFrame, previous: pd.DataFrame) -> list[str]:
    insights: list[str] = []
    metrics = executive_metrics(current, previous)
    change = metrics["revenue_change_pct"]
    if change is not None:
        direction = "increased" if change >= 0 else "decreased"
        insights.append(f"Revenue {direction} {abs(change):.1f}% compared with the comparison period.")
    chatter_perf = group_performance(current, previous, "chatter")
    if not chatter_perf.empty:
        top = chatter_perf.iloc[0]
        insights.append(f"{top['chatter']} generated the highest chatter revenue at \u20ac{top['revenue']:,.2f}.")
        improved = chatter_perf.sort_values("change_amount", ascending=False).iloc[0]
        insights.append(f"{improved['chatter']} had the largest revenue improvement at \u20ac{improved['change_amount']:,.2f}.")
        declined = chatter_perf.sort_values("change_amount", ascending=True).iloc[0]
        if declined["change_amount"] < 0:
            insights.append(f"{declined['chatter']} had the largest revenue decline at \u20ac{declined['change_amount']:,.2f}.")
    concentration = top_n_concentration(current)
    top5 = concentration.get("top_5_share_pct")
    top8 = concentration.get("top_8_share_pct")
    if top5 is not None:
        insights.append(f"Top 5 chatters generated {top5:.1f}% of selected-period chatter revenue.")
    if top8 is not None and top8 > 70:
        insights.append("Revenue remains heavily concentrated in the strongest chatter group.")
    creator_perf = group_performance(current, previous, "creator")
    if not creator_perf.empty:
        creator = creator_perf.iloc[0]
        insights.append(f"{creator['creator']} accounts for {creator['revenue_share_pct']:.1f}% of selected-period creator revenue.")
    return insights


def anomalies(current: pd.DataFrame, previous: pd.DataFrame, settings: dict) -> list[dict]:
    flags: list[dict] = []
    for group in ["chatter", "creator", "platform"]:
        perf = group_performance(current, previous, group)
        for _, row in perf.iterrows():
            change = row.get("change_pct")
            if change is None or pd.isna(change):
                continue
            if change <= -float(settings.get("anomaly_revenue_drop_pct", 30)):
                flags.append({
                    "area": group,
                    "name": row[group],
                    "severity": "warning",
                    "message": f"Revenue is {abs(change):.1f}% below the comparison period.",
                    "why": f"Current \u20ac{row['revenue']:,.2f} vs previous \u20ac{row['previous_revenue']:,.2f}.",
                })
            if change >= float(settings.get("anomaly_revenue_spike_pct", 40)):
                flags.append({
                    "area": group,
                    "name": row[group],
                    "severity": "info",
                    "message": f"Revenue is {change:.1f}% above the comparison period.",
                    "why": f"Current \u20ac{row['revenue']:,.2f} vs previous \u20ac{row['previous_revenue']:,.2f}.",
                })
    return flags
