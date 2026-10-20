from __future__ import annotations

from datetime import date

import pandas as pd


TIER_THRESHOLDS = {
    "daily": {"A": 1430.0, "B": 715.0},
    "weekly": {"A": 10000.0, "B": 5000.0},
    "monthly": {"A": 40000.0, "B": 20000.0},
}

CADENCE_LABELS = {
    "daily": "Daily",
    "weekly": "Weekly",
    "monthly": "Monthly",
}


def tier_for_amount(amount: float, cadence: str) -> str:
    thresholds = TIER_THRESHOLDS[cadence]
    if amount >= thresholds["A"]:
        return "A"
    if amount >= thresholds["B"]:
        return "B"
    return "C"


def tier_range_label(cadence: str, tier: str) -> str:
    thresholds = TIER_THRESHOLDS[cadence]
    if tier == "A":
        return f">= EUR {thresholds['A']:,.0f}"
    if tier == "B":
        return f"EUR {thresholds['B']:,.0f} - EUR {thresholds['A'] - 0.01:,.0f}"
    return f"< EUR {thresholds['B']:,.0f}"


def _period_days(start: date, end: date) -> int:
    return max(1, (end - start).days + 1)


def _clean_model_revenue(transactions: pd.DataFrame) -> pd.DataFrame:
    if transactions is None or transactions.empty or "creator" not in transactions:
        return pd.DataFrame(columns=["model", "selected_revenue", "active_days", "transactions"])

    rows = transactions.copy()
    rows["model"] = rows["creator"].fillna("").astype(str).str.strip()
    rows = rows[~rows["model"].isin(["", "Unknown", "None", "nan"])]
    transaction_type = rows.get("transaction_type", pd.Series("", index=rows.index)).fillna("").astype(str).str.lower().str.strip()
    revenue = pd.to_numeric(rows.get("revenue", pd.Series(0, index=rows.index)), errors="coerce").fillna(0)
    tip_revenue = pd.to_numeric(rows.get("tip_revenue", pd.Series(0, index=rows.index)), errors="coerce").fillna(0)
    message_revenue = pd.to_numeric(rows.get("message_revenue", pd.Series(0, index=rows.index)), errors="coerce").fillna(0)

    rows["tier_revenue"] = 0.0
    rows.loc[transaction_type.isin(["tip", "tips", "message", "messages"]), "tier_revenue"] = revenue
    rows.loc[transaction_type.eq("shift_summary"), "tier_revenue"] = tip_revenue + message_revenue
    rows = rows[rows["tier_revenue"] > 0]
    if rows.empty:
        return pd.DataFrame(columns=["model", "selected_revenue", "active_days", "transactions"])

    return (
        rows.groupby("model", dropna=False)
        .agg(
            selected_revenue=("tier_revenue", "sum"),
            active_days=("date", pd.Series.nunique),
            transactions=("tier_revenue", "count"),
        )
        .reset_index()
    )


def build_revenue_tiers(transactions: pd.DataFrame, start: date, end: date) -> dict:
    days = _period_days(start, end)
    by_model = _clean_model_revenue(transactions)
    if by_model.empty:
        return {
            "days": days,
            "by_model": by_model,
            "tier_assignments": empty_assignment_tables(),
            "tier_summary": pd.DataFrame(columns=["cadence", "tier", "range", "models", "revenue", "avg_model_revenue"]),
            "weekly_mix": pd.DataFrame(columns=["tier", "models"]),
            "top_models": pd.DataFrame(columns=["model", "weekly_revenue"]),
            "metric_records": [],
            "thresholds": threshold_rows(),
        }

    by_model["daily_revenue"] = by_model["selected_revenue"] / days
    by_model["weekly_revenue"] = by_model["daily_revenue"] * 7
    by_model["monthly_revenue"] = by_model["daily_revenue"] * 30

    for cadence in CADENCE_LABELS:
        by_model[f"{cadence}_tier"] = by_model[f"{cadence}_revenue"].apply(lambda value: tier_for_amount(float(value), cadence))

    by_model = by_model.sort_values(["weekly_tier", "weekly_revenue", "selected_revenue"], ascending=[True, False, False]).reset_index(drop=True)

    summary_rows = []
    for cadence, label in CADENCE_LABELS.items():
        revenue_col = f"{cadence}_revenue"
        tier_col = f"{cadence}_tier"
        for tier in ["A", "B", "C"]:
            tier_rows = by_model[by_model[tier_col] == tier]
            revenue = float(tier_rows[revenue_col].sum()) if not tier_rows.empty else 0.0
            models = int(len(tier_rows))
            summary_rows.append(
                {
                    "cadence": label,
                    "tier": f"Tier {tier}",
                    "range": tier_range_label(cadence, tier),
                    "models": models,
                    "revenue": revenue,
                    "avg_model_revenue": revenue / models if models else 0.0,
                }
            )
    tier_summary = pd.DataFrame(summary_rows)

    weekly_mix = (
        by_model.groupby("weekly_tier", dropna=False)
        .agg(models=("model", "count"), revenue=("weekly_revenue", "sum"))
        .reset_index()
        .rename(columns={"weekly_tier": "tier"})
    )
    weekly_mix["tier"] = "Tier " + weekly_mix["tier"].astype(str)

    top_models = by_model.sort_values("weekly_revenue", ascending=False).head(12)[["model", "weekly_revenue", "weekly_tier"]].copy()
    top_models["weekly_tier"] = "Tier " + top_models["weekly_tier"].astype(str)
    tier_assignments = assignment_tables(by_model)

    metric_records = []
    for cadence in CADENCE_LABELS:
        revenue_col = f"{cadence}_revenue"
        tier_col = f"{cadence}_tier"
        details = by_model[
            ["model", "selected_revenue", "active_days", "transactions", revenue_col, tier_col]
        ].copy()
        details = details.rename(columns={revenue_col: "tier_revenue", tier_col: "tier"})
        metric_records.append(
            {
                "metric_name": f"revenue_tiers_{cadence}",
                "value": float(details["tier_revenue"].sum()),
                "details": {
                    "cadence": cadence,
                    "period_days": days,
                    "thresholds": TIER_THRESHOLDS[cadence],
                    "models": details.to_dict("records"),
                },
            }
        )

    return {
        "days": days,
        "by_model": by_model,
        "tier_assignments": tier_assignments,
        "tier_summary": tier_summary,
        "weekly_mix": weekly_mix,
        "top_models": top_models,
        "metric_records": metric_records,
        "thresholds": threshold_rows(),
    }


def threshold_rows() -> pd.DataFrame:
    rows = []
    for cadence, label in CADENCE_LABELS.items():
        for tier in ["A", "B", "C"]:
            rows.append({"cadence": label, "tier": f"Tier {tier}", "range": tier_range_label(cadence, tier)})
    return pd.DataFrame(rows)


def assignment_tables(by_model: pd.DataFrame) -> dict[str, pd.DataFrame]:
    tables = {}
    for cadence, label in CADENCE_LABELS.items():
        revenue_col = f"{cadence}_revenue"
        tier_col = f"{cadence}_tier"
        rows = []
        for tier in ["A", "B", "C"]:
            tier_rows = by_model[by_model[tier_col] == tier].sort_values(revenue_col, ascending=False)
            for _, row in tier_rows.iterrows():
                rows.append(
                    {
                        "cadence": label,
                        "tier": f"Tier {tier}",
                        "model": row["model"],
                        "tier_revenue": float(row[revenue_col]),
                        "selected_revenue": float(row["selected_revenue"]),
                        "active_days": int(row["active_days"]),
                        "transactions": int(row["transactions"]),
                    }
                )
        tables[cadence] = pd.DataFrame(rows, columns=["cadence", "tier", "model", "tier_revenue", "selected_revenue", "active_days", "transactions"])
    return tables


def empty_assignment_tables() -> dict[str, pd.DataFrame]:
    columns = ["cadence", "tier", "model", "tier_revenue", "selected_revenue", "active_days", "transactions"]
    return {cadence: pd.DataFrame(columns=columns) for cadence in CADENCE_LABELS}
