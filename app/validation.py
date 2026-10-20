from __future__ import annotations

import pandas as pd


KNOWN_PLATFORMS = {"F2F", "OnlyFans", "Kinky", "FanCentro", "Fansly"}


def validate_transactions(df: pd.DataFrame) -> list[dict]:
    issues: list[dict] = []
    if df.empty:
        return [{"severity": "error", "issue_type": "empty_file", "message": "No rows were found in the imported data."}]

    for idx, row in df.reset_index(drop=True).iterrows():
        row_number = idx + 1
        if pd.isna(row.get("date")):
            issues.append(issue(row_number, "error", "invalid_date", "date", "Date is missing or invalid."))
        if pd.isna(row.get("revenue")):
            issues.append(issue(row_number, "error", "invalid_revenue", "revenue", "Revenue is missing or not numeric."))
        elif row.get("revenue") < 0:
            issues.append(issue(row_number, "warning", "negative_revenue", "revenue", "Revenue is negative and should be reviewed."))
        elif row.get("revenue") > 10000:
            issues.append(issue(row_number, "warning", "extreme_revenue", "revenue", "Revenue is unusually high and should be reviewed."))
        if not row.get("chatter"):
            issues.append(issue(row_number, "warning", "missing_chatter", "chatter", "Chatter is missing, unknown, or unassigned."))
        if not row.get("creator"):
            issues.append(issue(row_number, "warning", "missing_creator", "creator", "Creator is missing."))
        if row.get("platform") and row.get("platform") not in KNOWN_PLATFORMS:
            issues.append(issue(row_number, "info", "unknown_platform", "platform", f"Platform '{row.get('platform')}' is not in the known starter list."))
        if row.get("currency") and len(str(row.get("currency"))) != 3:
            issues.append(issue(row_number, "warning", "currency_inconsistency", "currency", "Currency should normally be a 3-letter code such as EUR."))
        if pd.notna(row.get("inactive_minutes")) and row.get("inactive_minutes") < 0:
            issues.append(issue(row_number, "warning", "negative_inactivity", "inactive_minutes", "Inactive minutes is negative."))
        if pd.notna(row.get("shift_hours")) and row.get("shift_hours") < 0:
            issues.append(issue(row_number, "warning", "negative_hours", "shift_hours", "Shift hours is negative."))

    duplicates = df[df["transaction_key"].notna() & df.duplicated("transaction_key", keep=False)]
    for idx in duplicates.index:
        issues.append(issue(int(idx) + 1, "warning", "duplicate_transaction", "transaction_key", "Possible duplicate transaction based on date/time, people, platform, type, and revenue."))

    currencies = set(df["currency"].dropna().astype(str).unique()) if "currency" in df else set()
    if len(currencies) > 1:
        issues.append(issue(None, "warning", "currency_inconsistency", "currency", f"Multiple currencies detected: {', '.join(sorted(currencies))}."))
    return issues


def issue(row_number, severity, issue_type, field, message) -> dict:
    return {
        "row_number": row_number,
        "severity": severity,
        "issue_type": issue_type,
        "field": field,
        "message": message,
    }

