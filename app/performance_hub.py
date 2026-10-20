from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path

import pandas as pd

from .config import DATA_DIR
from .notion_source import load_employee_rows
from .postgres_source import load_postgres_chatter_grades, load_postgres_creator_tiers, load_postgres_scheduled_shifts


SNAPSHOT_PATH = DATA_DIR / "performance_sources" / "chatters_notion.csv"
ROSTER_COLUMNS = [
    "name",
    "first_name_key",
    "status_clean",
    "team_clean",
    "current_tier",
    "emotional_connection",
    "tone",
    "bwc",
    "personalisation",
    "responsiveness",
    "chatting_quality",
    "activity_behaviour",
    "skill_grade",
    "skill_tier",
    "weekly_capacity_hours",
    "latest_grade_date",
]


def _clean_number(value) -> float:
    if value is None or pd.isna(value):
        return 0.0
    text = str(value).strip().replace(",", "").replace("%", "").replace("EUR", "").replace("$", "")
    if not text or text.lower() in {"nan", "none", "n/a"}:
        return 0.0
    try:
        return float(text)
    except ValueError:
        return 0.0


def _score(value) -> float:
    number = _clean_number(value)
    if number <= 0:
        return 0.0
    if number <= 1:
        number *= 100
    if number <= 10:
        number *= 10
    return max(0.0, min(100.0, number))


def _first_name(value: str) -> str:
    return str(value or "").strip().split(" ")[0].lower()


def _column(rows: pd.DataFrame, name: str, default: str = "") -> pd.Series:
    if name in rows:
        return rows[name]
    return pd.Series([default] * len(rows), index=rows.index)


def _normalise_column_name(value: str) -> str:
    return "".join(char for char in str(value or "").lower() if char.isalnum())


def _matching_column(rows: pd.DataFrame, candidates: list[str]) -> str | None:
    if rows.empty:
        return None
    normalised = {_normalise_column_name(column): column for column in rows.columns}
    for candidate in candidates:
        key = _normalise_column_name(candidate)
        if key in normalised:
            return normalised[key]
    for candidate in candidates:
        key = _normalise_column_name(candidate)
        for normalised_name, column in normalised.items():
            if key and (key in normalised_name or normalised_name in key):
                return column
    return None


def _score_column(rows: pd.DataFrame, candidates: list[str]) -> pd.Series:
    column = _matching_column(rows, candidates)
    if not column:
        return pd.Series([0.0] * len(rows), index=rows.index)
    return rows[column].apply(_score)


def _weighted_average(parts: list[tuple[pd.Series, float]]) -> pd.Series:
    if not parts:
        return pd.Series(dtype=float)
    weighted = pd.Series([0.0] * len(parts[0][0]), index=parts[0][0].index)
    weights = pd.Series([0.0] * len(parts[0][0]), index=parts[0][0].index)
    for series, weight in parts:
        values = pd.to_numeric(series, errors="coerce").fillna(0)
        present = values.gt(0)
        weighted = weighted.add(values.where(present, 0) * weight, fill_value=0)
        weights = weights.add(present.astype(float) * weight, fill_value=0)
    return weighted.div(weights.replace(0, pd.NA)).fillna(0)


def _normalized_chatter_rows(rows: pd.DataFrame, source: str) -> pd.DataFrame:
    if rows.empty:
        return pd.DataFrame()
    rows = rows.copy()
    if "Full Name" not in rows and "Name" in rows:
        rows["Full Name"] = rows["Name"]
    if "Full Name" not in rows:
        title_columns = [column for column in rows.columns if column.lower() in {"name", "full name", "employee"}]
        if title_columns:
            rows["Full Name"] = rows[title_columns[0]]
    if "Full Name" not in rows:
        return pd.DataFrame()
    rows["name"] = rows["Full Name"].fillna("").astype(str).str.strip()
    rows = rows[rows["name"].ne("")]
    role = _column(rows, "Role").fillna("").astype(str).str.strip()
    if not role.empty:
        chatter_rows = rows[role.str.contains("chatter", case=False, na=False)].copy()
        if not chatter_rows.empty:
            rows = chatter_rows
    rows["first_name_key"] = rows["name"].apply(_first_name)
    rows["status_clean"] = _column(rows, "Status").fillna("").astype(str).str.strip()
    rows["team_clean"] = _column(rows, "Team").fillna("").astype(str).str.strip().replace("", "Unknown")
    rows["current_tier"] = _column(rows, "Current Tier").fillna("").astype(str).str.strip().replace("", "Unassigned")
    capacity_column = _matching_column(rows, [
        "Weekly Capacity",
        "Weekly Capacity Hours",
        "Hours Per Week",
        "Hours per week",
        "Available Hours Per Week",
        "Available hours per week",
        "Max Hours Per Week",
        "Max hours per week",
        "Can Do Per Week",
        "How many hours per week",
        "Contracted Weekly Hours",
    ])
    rows["weekly_capacity_hours"] = rows[capacity_column].apply(_clean_number) if capacity_column else 0.0

    direct_chat_quality = _score_column(rows, ["Chat Quality", "Chat Quality Score", "chat_quality_score"])
    direct_activity = _score_column(rows, ["Activity / Behaviour", "Activity / Behavior", "Activity Score", "activity_score"])
    direct_scores_present = direct_chat_quality.gt(0) | direct_activity.gt(0)

    rows["emotional_connection"] = _score_column(rows, ["Emotional Connection", "Emotional Conn", "Emotional"])
    rows["tone"] = _score_column(rows, ["Tone & Fan Energy", "Tone and Fan Energy", "Tone", "Fan Energy"])
    rows["bwc"] = _score_column(rows, ["BWC", "Boundaries", "Boundary"])
    rows["personalisation"] = _score_column(rows, [
        "Personalization, Notes",
        "Personalisation, Notes",
        "Personalization",
        "Personalisation",
        "Notes",
    ])
    rows["responsiveness"] = _score_column(rows, ["Responsiveness", "Response", "Response Speed"])

    quality_inputs = [
        _column(rows, "Latest QA Average Rating").apply(_score),
        _column(rows, "Latest CM Average Rating").apply(_score),
        _column(rows, "Quality Score").apply(_score),
        _column(rows, "Compliance Score").apply(_score),
        _column(rows, "Recent Overall Score").apply(_score),
    ]
    quality_frame = pd.concat(quality_inputs, axis=1).replace(0, pd.NA)
    fallback_quality = quality_frame.mean(axis=1).fillna(0)
    rows["chatting_quality"] = _weighted_average([
        (rows["emotional_connection"], 15),
        (rows["tone"], 15),
        (rows["bwc"], 35),
    ])
    rows["chatting_quality"] = rows["chatting_quality"].where(rows["chatting_quality"].gt(0), fallback_quality)
    rows["chatting_quality"] = rows["chatting_quality"].where(~direct_chat_quality.gt(0), direct_chat_quality)

    activity_inputs = [
        _column(rows, "Latest QA Min Rating").apply(_score),
        _column(rows, "Latest CM Min Rating").apply(_score),
        _column(rows, "Typing Speed").apply(lambda value: min(100.0, _clean_number(value) / 1.2)),
    ]
    activity_frame = pd.concat(activity_inputs, axis=1).replace(0, pd.NA)
    fallback_activity = activity_frame.mean(axis=1).fillna(rows["chatting_quality"])
    rows["activity_behaviour"] = _weighted_average([
        (rows["personalisation"], 20),
        (rows["responsiveness"], 15),
    ])
    rows["activity_behaviour"] = rows["activity_behaviour"].where(rows["activity_behaviour"].gt(0), fallback_activity)
    rows["activity_behaviour"] = rows["activity_behaviour"].where(~direct_activity.gt(0), direct_activity)
    rows["skill_grade"] = _weighted_average([
        (rows["emotional_connection"], 15),
        (rows["tone"], 15),
        (rows["bwc"], 35),
        (rows["personalisation"], 20),
        (rows["responsiveness"], 15),
    ])
    fallback_grade = (rows["chatting_quality"] * 0.65 + rows["activity_behaviour"] * 0.35).fillna(0)
    rows["skill_grade"] = rows["skill_grade"].where(rows["skill_grade"].gt(0), fallback_grade)
    rows["skill_grade"] = rows["skill_grade"].where(~direct_scores_present, fallback_grade)
    rows["skill_grade"] = rows["skill_grade"].apply(lambda value: max(0.0, min(100.0, float(value or 0))))
    rows["skill_tier"] = rows["skill_grade"].apply(skill_tier)
    latest_grade_column = _matching_column(rows, ["Latest Grade Date", "Graded At", "Grade Date", "last_graded_at", "graded_at"])
    rows["latest_grade_date"] = rows[latest_grade_column] if latest_grade_column else ""
    rows.attrs["source"] = source
    return rows


def load_chatter_snapshot() -> pd.DataFrame:
    grade_rows = _normalized_chatter_rows(load_postgres_chatter_grades(), "RevenueCatcher Chatter Grades")
    notion_rows = _normalized_chatter_rows(load_employee_rows(), "Notion API")
    if not grade_rows.empty:
        if not notion_rows.empty:
            details = notion_rows[["first_name_key", "status_clean", "team_clean", "current_tier"]].drop_duplicates("first_name_key")
            grade_rows = grade_rows.merge(details, on="first_name_key", how="left", suffixes=("", "_hr"))
            for column in ["status_clean", "team_clean", "current_tier"]:
                hr_column = f"{column}_hr"
                if hr_column in grade_rows:
                    hr_values = grade_rows[hr_column].fillna("").astype(str).str.strip()
                    own_values = grade_rows[column].fillna("").astype(str).str.strip()
                    grade_rows[column] = hr_values.where(hr_values.ne(""), own_values)
                    grade_rows = grade_rows.drop(columns=[hr_column])
            grade_rows.attrs["source"] = "RevenueCatcher Chatter Grades + Notion HR roster"
        return grade_rows
    if not notion_rows.empty:
        return notion_rows
    if not SNAPSHOT_PATH.exists():
        return pd.DataFrame()
    return _normalized_chatter_rows(pd.read_csv(SNAPSHOT_PATH), "Notion export snapshot")


def skill_tier(score: float) -> str:
    score = float(score or 0)
    if score >= 85:
        return "A"
    if score >= 75:
        return "B"
    if score >= 65:
        return "C"
    return "Needs coaching"


def week_windows(end: date, count: int = 4, week_start: str = "Friday") -> list[tuple[str, date, date]]:
    week_start_idx = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].index(week_start)
    days_since_start = (end.weekday() - week_start_idx) % 7
    current_start = end - timedelta(days=days_since_start)
    windows = []
    for offset in reversed(range(count)):
        start = current_start - timedelta(days=offset * 7)
        finish = min(start + timedelta(days=6), end) if offset == 0 else start + timedelta(days=6)
        windows.append((f"W{count - offset}", start, finish))
    return windows


def _assigned_chatter_mask(df: pd.DataFrame) -> pd.Series:
    if df.empty or "chatter" not in df:
        return pd.Series(dtype=bool)
    chatter = df["chatter"].fillna("").astype(str).str.strip()
    return chatter.ne("") & chatter.str.lower().ne("unknown")


def _period(df: pd.DataFrame, start: date, end: date) -> pd.DataFrame:
    if df.empty or "date" not in df:
        return pd.DataFrame()
    dates = pd.to_datetime(df["date"], errors="coerce").dt.date
    return df[(dates >= start) & (dates <= end)].copy()


def _hours_by_chatter(rows: pd.DataFrame) -> pd.DataFrame:
    """Return actual chatter hours without multiplying time by handled models.

    Flow can associate a single chat shift with several model accounts.  Those
    records describe one person's time, so utilization must first collapse
    duplicate/overlapping shift intervals at the chatter-day level.
    """
    if rows.empty or "shift_hours" not in rows:
        return pd.DataFrame(columns=["chatter", "hours"])
    shift_rows = rows[rows.get("transaction_type", "").eq("shift_summary")].copy()
    if shift_rows.empty:
        return pd.DataFrame(columns=["chatter", "hours"])
    shift_rows = shift_rows[_assigned_chatter_mask(shift_rows)].copy()
    shift_rows["shift_hours"] = pd.to_numeric(shift_rows["shift_hours"], errors="coerce").fillna(0)
    shift_rows["date"] = pd.to_datetime(shift_rows.get("date"), errors="coerce").dt.date
    shift_rows["_start"] = pd.to_datetime(shift_rows.get("shift_start"), errors="coerce", utc=True)
    shift_rows["_end"] = pd.to_datetime(shift_rows.get("shift_end"), errors="coerce", utc=True)

    daily = []
    for (chatter, shift_date), group in shift_rows.groupby(["chatter", "date"], dropna=False):
        intervals = group[group["_start"].notna() & group["_end"].notna()].sort_values("_start")
        if not intervals.empty:
            # Union intervals so overlapping model assignments count once while
            # genuinely separate shifts on the same day are retained.
            total = 0.0
            start = end = None
            for interval_start, interval_end in intervals[["_start", "_end"]].itertuples(index=False, name=None):
                if start is None:
                    start, end = interval_start, interval_end
                elif interval_start <= end:
                    end = max(end, interval_end)
                else:
                    total += max(0.0, (end - start).total_seconds() / 3600)
                    start, end = interval_start, interval_end
            total += max(0.0, (end - start).total_seconds() / 3600)
        else:
            # Legacy rows without an interval cannot distinguish models from
            # parallel assignments. The daily maximum is the safe person-time
            # estimate; summing would overstate utilization.
            total = float(group["shift_hours"].max())
        daily.append({"chatter": chatter, "date": shift_date, "hours": total})
    daily_frame = pd.DataFrame(daily)
    return daily_frame.groupby("chatter", dropna=False)["hours"].sum().reset_index(name="hours") if not daily_frame.empty else pd.DataFrame(columns=["chatter", "hours"])


def _scheduled_capacity_by_chatter(rows: pd.DataFrame, start: date, finish: date) -> pd.DataFrame:
    """Return planned person-hours, once per chatter and scheduled day."""
    if rows is None or rows.empty or "date" not in rows or "scheduled_hours" not in rows:
        return pd.DataFrame(columns=["first_name_key", "scheduled_capacity_hours"])
    scheduled = _period(rows, start, finish)
    if scheduled.empty:
        return pd.DataFrame(columns=["first_name_key", "scheduled_capacity_hours"])
    scheduled = scheduled.copy()
    scheduled["scheduled_hours"] = pd.to_numeric(scheduled["scheduled_hours"], errors="coerce").fillna(0)
    scheduled["first_name_key"] = scheduled.get("chatter", pd.Series("", index=scheduled.index)).apply(_first_name)
    scheduled = scheduled[scheduled["first_name_key"].ne("")]
    scheduled["date"] = pd.to_datetime(scheduled["date"], errors="coerce").dt.date
    # One scheduled shift can be linked to several models. Taking the daily
    # maximum prevents that administrative relationship from inflating a
    # chatter's available hours and the utilization denominator.
    daily = scheduled.groupby(["first_name_key", "date"], dropna=False)["scheduled_hours"].max().reset_index()
    return daily.groupby("first_name_key", dropna=False)["scheduled_hours"].sum().reset_index(name="scheduled_capacity_hours")


def _revenue_by_chatter(rows: pd.DataFrame) -> pd.DataFrame:
    if rows.empty or "revenue" not in rows:
        return pd.DataFrame(columns=["chatter", "revenue"])
    revenue_rows = rows[rows["revenue"].notna()].copy()
    if revenue_rows.empty:
        return pd.DataFrame(columns=["chatter", "revenue"])
    revenue_rows = revenue_rows[_assigned_chatter_mask(revenue_rows)].copy()
    revenue_rows["revenue"] = pd.to_numeric(revenue_rows["revenue"], errors="coerce").fillna(0)
    return revenue_rows.groupby("chatter", dropna=False)["revenue"].sum().reset_index(name="revenue")


def _normalise_creator_tier(value) -> str:
    text = str(value or "").strip().upper()
    if not text or text in {"NAN", "NONE", "UNASSIGNED"}:
        return ""
    if "A" in text:
        return "A"
    if "B" in text:
        return "B"
    if "C" in text:
        return "C"
    return ""


def _official_creator_tiers() -> pd.DataFrame:
    rows = load_postgres_creator_tiers()
    if rows.empty:
        return pd.DataFrame(columns=["creator", "creator_id", "creator_tier", "model_tier_source"])
    rows = rows.copy()
    for column in ["creator", "creator_id", "creator_tier", "tier_source"]:
        if column not in rows:
            rows[column] = ""
    rows["creator_tier"] = rows["creator_tier"].apply(_normalise_creator_tier)
    rows = rows[rows["creator_tier"].ne("")].copy()
    if rows.empty:
        return pd.DataFrame(columns=["creator", "creator_id", "creator_tier", "model_tier_source"])
    rows["creator_key"] = rows["creator"].fillna("").astype(str).str.strip().str.lower()
    tier_rank = {"A": 3, "B": 2, "C": 1}
    rows["_rank"] = rows["creator_tier"].map(tier_rank).fillna(0)
    rows = rows.sort_values(["_rank", "creator"], ascending=[False, True])
    by_id = rows[rows["creator_id"].fillna("").astype(str).str.strip().ne("")].drop_duplicates("creator_id")
    by_name = rows[rows["creator_key"].ne("")].drop_duplicates("creator_key")
    return pd.concat([by_id, by_name], ignore_index=True).drop_duplicates(["creator_id", "creator_key"], keep="first").rename(columns={"tier_source": "model_tier_source"})


def _transition_watch_rows(roster: pd.DataFrame) -> pd.DataFrame:
    if roster.empty:
        return pd.DataFrame()
    rows = roster.copy()
    status = rows["status_clean"].fillna("").astype(str).str.strip()
    transition_mask = status.ne("") & ~status.str.lower().isin({"active"})
    rows = rows[transition_mask].copy()
    if rows.empty:
        return pd.DataFrame()
    rows["_status_order"] = rows["status_clean"].fillna("").astype(str).str.lower().map({
        "probee": 0,
        "ready to start chatting": 1,
        "didn't finish training": 2,
        "inactive": 3,
        "left": 4,
        "fired": 5,
    }).fillna(9)
    rows = rows.sort_values(["_status_order", "team_clean", "name"])
    return rows[["name", "status_clean", "team_clean", "current_tier", "skill_grade"]].rename(columns={
        "name": "chatter",
        "status_clean": "status",
        "team_clean": "team",
        "current_tier": "tier",
    })


def _creator_requirement(rows: pd.DataFrame) -> tuple[float, pd.DataFrame]:
    if rows.empty or "creator" not in rows or "revenue" not in rows:
        return 0.0, pd.DataFrame()
    revenue_rows = rows[rows["revenue"].notna()].copy()
    if revenue_rows.empty:
        return 0.0, pd.DataFrame()
    revenue_rows["revenue"] = pd.to_numeric(revenue_rows["revenue"], errors="coerce").fillna(0)
    group_cols = ["creator"]
    if "creator_id" in revenue_rows:
        group_cols.append("creator_id")
    creators = revenue_rows.groupby(group_cols, dropna=False)["revenue"].sum().reset_index()
    creators = creators[creators["creator"].fillna("").astype(str).str.strip().ne("")]
    if creators.empty:
        return 0.0, creators
    creators["creator_key"] = creators["creator"].fillna("").astype(str).str.strip().str.lower()
    creators["estimated_tier"] = creators["revenue"].apply(
        lambda value: "A" if value >= 10000 else "B" if value >= 5000 else "C"
    )
    official = _official_creator_tiers()
    if not official.empty:
        if "creator_id" in creators and "creator_id" in official:
            creators = creators.merge(
                official[["creator_id", "creator_tier", "model_tier_source"]].drop_duplicates("creator_id"),
                on="creator_id",
                how="left",
            )
        if "creator_tier" not in creators:
            creators["creator_tier"] = ""
            creators["model_tier_source"] = ""
        missing = creators["creator_tier"].fillna("").astype(str).str.strip().eq("")
        if missing.any():
            name_tiers = official[["creator_key", "creator_tier", "model_tier_source"]].drop_duplicates("creator_key")
            name_matched = creators.loc[missing, ["creator_key"]].merge(name_tiers, on="creator_key", how="left")
            creators.loc[missing, "creator_tier"] = name_matched["creator_tier"].fillna("").to_numpy()
            creators.loc[missing, "model_tier_source"] = name_matched["model_tier_source"].fillna("").to_numpy()
    else:
        creators["creator_tier"] = ""
        creators["model_tier_source"] = ""
    creators["creator_tier"] = creators["creator_tier"].fillna("").astype(str).str.strip()
    creators["model_tier"] = creators["creator_tier"].where(creators["creator_tier"].ne(""), creators["estimated_tier"])
    creators["model_tier_source"] = creators["model_tier_source"].fillna("").replace("", "estimated from revenue")
    requirement_points = {"A": 4200.0, "B": 3000.0, "C": 1800.0}
    creators["requirement"] = creators["model_tier"].map(requirement_points).fillna(1800.0)
    display_cols = ["creator", "revenue", "model_tier", "requirement", "model_tier_source"]
    if "creator_id" in creators:
        display_cols.insert(1, "creator_id")
    return float(creators["requirement"].sum()), creators.sort_values("revenue", ascending=False)[display_cols]


def _creator_capacity_requirement(rows: pd.DataFrame) -> tuple[float, pd.DataFrame]:
    if rows.empty or "creator" not in rows or "revenue" not in rows:
        return 0.0, pd.DataFrame()
    _, creators = _creator_requirement(rows)
    if creators.empty:
        return 0.0, creators
    creators = creators.copy()
    weekly_hours = {"A": 168.0, "B": 112.0, "C": 56.0}
    creators["required_weekly_hours"] = creators["model_tier"].map(weekly_hours).fillna(56.0)
    display_cols = [
        column
        for column in ["creator", "creator_id", "revenue", "model_tier", "required_weekly_hours", "model_tier_source"]
        if column in creators
    ]
    return float(creators["required_weekly_hours"].sum()), creators.sort_values("revenue", ascending=False)[display_cols]


def build_performance_hub(all_data: pd.DataFrame, end: date, week_start: str = "Friday") -> dict:
    snapshot = load_chatter_snapshot()
    snapshot_source = snapshot.attrs.get("source", "Notion employee data") if not snapshot.empty else "No HR source connected"
    roster = snapshot.copy() if not snapshot.empty else pd.DataFrame(columns=ROSTER_COLUMNS)
    numeric_roster_columns = {
        "emotional_connection",
        "tone",
        "bwc",
        "personalisation",
        "responsiveness",
        "chatting_quality",
        "activity_behaviour",
        "skill_grade",
    }
    for column in ROSTER_COLUMNS:
        if column not in roster:
            roster[column] = 0.0 if column in numeric_roster_columns else ""
    if "first_name_key" not in roster or roster["first_name_key"].fillna("").astype(str).str.strip().eq("").all():
        roster["first_name_key"] = roster["name"].apply(_first_name)
    roster = roster[ROSTER_COLUMNS].copy()
    windows = week_windows(end, week_start=week_start)
    weekly_rows = []
    current_table = pd.DataFrame()
    current_creators = pd.DataFrame()
    for label, start, finish in windows:
        period_rows = _period(all_data, start, finish)
        hours = _hours_by_chatter(period_rows)
        revenue = _revenue_by_chatter(period_rows)
        if hours.empty:
            active = pd.DataFrame(columns=["chatter", "hours", "revenue", "skill_grade", "skill_tier"])
        else:
            hours["first_name_key"] = hours["chatter"].apply(_first_name)
            active = hours.merge(roster, on="first_name_key", how="left")
            active = active.merge(revenue, on="chatter", how="left")
            active["revenue"] = pd.to_numeric(active["revenue"], errors="coerce").fillna(0)
            active["hr_match"] = active["name"].fillna("").astype(str).str.strip().ne("")
            active["name"] = active["name"].fillna(active["chatter"])
            active["skill_grade"] = pd.to_numeric(active["skill_grade"], errors="coerce").fillna(0)
            active["score_pending"] = active["skill_grade"].le(0)
            active["skill_grade"] = active["skill_grade"].where(active["skill_grade"].gt(0), 0)
            active["chatting_quality"] = pd.to_numeric(active["chatting_quality"], errors="coerce").fillna(active["skill_grade"])
            active["activity_behaviour"] = pd.to_numeric(active["activity_behaviour"], errors="coerce").fillna(active["skill_grade"])
            active["skill_tier"] = active["skill_tier"].fillna(active["skill_grade"].apply(skill_tier))
            active.loc[active["score_pending"], "skill_tier"] = "Pending score"
            active["current_tier"] = active["current_tier"].fillna("Unassigned").replace("", "Unassigned")
            active["team_clean"] = active["team_clean"].fillna("Unknown").replace("", "Unknown")
            active["operating_potential"] = active["skill_grade"] * active["hours"]
            active["revenue_per_hour"] = active.apply(lambda row: row["revenue"] / row["hours"] if row["hours"] else 0, axis=1)
        requirement, creators = _creator_requirement(period_rows)
        strength = float(active["operating_potential"].sum()) if "operating_potential" in active else 0.0
        hours_total = float(active["hours"].sum()) if "hours" in active else 0.0
        revenue_total = float(active["revenue"].sum()) if "revenue" in active else 0.0
        weekly_rows.append({
            "week": label,
            "start": start,
            "end": finish,
            "team_strength": strength,
            "model_requirement": requirement,
            "operating_potential_pct": strength / requirement * 100 if requirement else 0.0,
            "gap": strength - requirement,
            "scheduled_chatters": int(active["chatter"].nunique()) if "chatter" in active else 0,
            "hours": hours_total,
            "revenue": revenue_total,
            "revenue_per_hour": revenue_total / hours_total if hours_total else 0.0,
            "avg_skill": strength / hours_total if hours_total else 0.0,
            "hr_matched_chatters": int(active["hr_match"].sum()) if "hr_match" in active else 0,
        })
        current_table = active.copy()
        current_creators = creators.copy()

    weekly = pd.DataFrame(weekly_rows)
    if not current_table.empty:
        current_table = current_table.sort_values("operating_potential", ascending=False)
        current_table = current_table[[
            "name", "skill_tier", "skill_grade", "chatting_quality", "activity_behaviour",
            "hours", "operating_potential", "revenue", "revenue_per_hour", "current_tier", "team_clean", "hr_match", "score_pending", "latest_grade_date"
        ]]
        current_table = current_table.rename(columns={
            "name": "chatter",
            "skill_tier": "tier",
            "skill_grade": "skill_grade",
            "chatting_quality": "chat_quality",
            "activity_behaviour": "activity_behaviour",
            "hours": "scheduled_hours",
            "operating_potential": "operating_potential",
            "revenue_per_hour": "rev_per_hour",
            "current_tier": "notion_tier",
            "team_clean": "team",
            "hr_match": "hr_profile_found",
        })
    transition = _transition_watch_rows(roster)
    tier_mix = current_table.groupby("tier", dropna=False).agg(chatters=("chatter", "count"), strength=("operating_potential", "sum")).reset_index() if not current_table.empty else pd.DataFrame()
    return {
        "weekly": weekly,
        "current_chatters": current_table,
        "tier_mix": tier_mix,
        "creator_requirements": current_creators,
        "transition": transition,
        "snapshot_rows": len(snapshot),
        "snapshot_source": snapshot_source,
    }


def build_performance_hub_v2(
    all_data: pd.DataFrame,
    end: date,
    week_start: str = "Friday",
    scheduled_data: pd.DataFrame | None = None,
    filters: dict[str, str] | None = None,
) -> dict:
    snapshot = load_chatter_snapshot()
    snapshot_source = snapshot.attrs.get("source", "No HR source connected") if not snapshot.empty else "No HR source connected"
    roster = snapshot.copy() if not snapshot.empty else pd.DataFrame(columns=ROSTER_COLUMNS)
    numeric_roster_columns = {
        "emotional_connection",
        "tone",
        "bwc",
        "personalisation",
        "responsiveness",
        "chatting_quality",
        "activity_behaviour",
        "skill_grade",
        "weekly_capacity_hours",
    }
    for column in ROSTER_COLUMNS:
        if column not in roster:
            roster[column] = 0.0 if column in numeric_roster_columns else ""
    if "first_name_key" not in roster or roster["first_name_key"].fillna("").astype(str).str.strip().eq("").all():
        roster["first_name_key"] = roster["name"].apply(_first_name)
    roster = roster[ROSTER_COLUMNS].copy()
    roster["weekly_capacity_hours"] = pd.to_numeric(roster["weekly_capacity_hours"], errors="coerce").fillna(0)
    roster["skill_grade"] = pd.to_numeric(roster["skill_grade"], errors="coerce").fillna(0)
    roster["chatting_quality"] = pd.to_numeric(roster["chatting_quality"], errors="coerce").fillna(roster["skill_grade"])
    roster["activity_behaviour"] = pd.to_numeric(roster["activity_behaviour"], errors="coerce").fillna(roster["skill_grade"])
    roster["hr_match"] = roster["name"].fillna("").astype(str).str.strip().ne("")
    roster["score_pending"] = roster["skill_grade"].le(0)
    roster["skill_tier"] = roster["skill_tier"].fillna(roster["skill_grade"].apply(skill_tier))
    roster.loc[roster["score_pending"], "skill_tier"] = "Pending score"
    roster["current_tier"] = roster["current_tier"].fillna("Unassigned").replace("", "Unassigned")
    roster["team_clean"] = roster["team_clean"].fillna("Unknown").replace("", "Unknown")
    active_status = roster["status_clean"].fillna("").astype(str).str.strip().str.lower()
    capacity_roster = roster[active_status.eq("") | active_status.eq("active")].copy()

    windows = week_windows(end, week_start=week_start)
    if scheduled_data is None:
        scheduled_data = load_postgres_scheduled_shifts(windows[0][1], windows[-1][2])
    weekly_rows = []
    current_table = pd.DataFrame()
    current_creators = pd.DataFrame()
    for label, start, finish in windows:
        period_rows = _period(all_data, start, finish)
        hours = _hours_by_chatter(period_rows)
        revenue = _revenue_by_chatter(period_rows)
        revenue_by_profile = revenue.copy()
        if not revenue_by_profile.empty:
            revenue_by_profile["first_name_key"] = revenue_by_profile["chatter"].apply(_first_name)
            revenue_by_profile = revenue_by_profile.groupby("first_name_key", dropna=False)["revenue"].sum().reset_index()
        else:
            revenue_by_profile = pd.DataFrame(columns=["first_name_key", "revenue"])
        scheduled_capacity = _scheduled_capacity_by_chatter(scheduled_data, start, finish)
        scheduled_keys = pd.DataFrame(columns=["first_name_key", "chatter"])
        if not hours.empty:
            hours["first_name_key"] = hours["chatter"].apply(_first_name)
            scheduled_keys = hours[["first_name_key", "chatter"]].copy()
        else:
            hours = pd.DataFrame(columns=["first_name_key", "chatter", "hours"])
        scheduled_rows = _period(scheduled_data, start, finish) if scheduled_data is not None and not scheduled_data.empty else pd.DataFrame()
        if not scheduled_rows.empty and "chatter" in scheduled_rows:
            planned_keys = scheduled_rows[["chatter"]].copy()
            planned_keys["first_name_key"] = planned_keys["chatter"].apply(_first_name)
            scheduled_keys = pd.concat([scheduled_keys, planned_keys[["first_name_key", "chatter"]]], ignore_index=True).drop_duplicates("first_name_key")
        if not revenue.empty:
            revenue_keys = revenue[["chatter"]].copy()
            revenue_keys["first_name_key"] = revenue_keys["chatter"].apply(_first_name)
            scheduled_keys = pd.concat([scheduled_keys, revenue_keys[["first_name_key", "chatter"]]], ignore_index=True).drop_duplicates("first_name_key")

        active = capacity_roster.copy()
        if not scheduled_keys.empty:
            missing_keys = scheduled_keys[~scheduled_keys["first_name_key"].isin(active["first_name_key"])].copy()
            if not missing_keys.empty:
                # A scheduled chatter can be graded in RevenueCatcher while their HR
                # status is not literally "Active" (for example, training or
                # onboarding). Keep that recorded grade instead of replacing the
                # chatter with an ungraded filler row.
                roster_lookup = roster.drop_duplicates("first_name_key")
                known_scheduled = missing_keys.merge(roster_lookup, on="first_name_key", how="inner")
                if not known_scheduled.empty:
                    known_keys = set(known_scheduled["first_name_key"])
                    known_scheduled = known_scheduled.drop(columns=["chatter"], errors="ignore")
                    active = pd.concat([active, known_scheduled], ignore_index=True)
                    missing_keys = missing_keys[~missing_keys["first_name_key"].isin(known_keys)].copy()
            if not missing_keys.empty:
                filler = pd.DataFrame({
                    "name": missing_keys["chatter"],
                    "first_name_key": missing_keys["first_name_key"],
                    "status_clean": "Missing HR profile",
                    "team_clean": "Unknown",
                    "current_tier": "Unassigned",
                    "emotional_connection": 0.0,
                    "tone": 0.0,
                    "bwc": 0.0,
                    "personalisation": 0.0,
                    "responsiveness": 0.0,
                    "chatting_quality": 0.0,
                    "activity_behaviour": 0.0,
                    "skill_grade": 0.0,
                    "skill_tier": "Pending score",
                    "weekly_capacity_hours": 0.0,
                    "latest_grade_date": "",
                    "hr_match": False,
                    "score_pending": True,
                })
                active = pd.concat([active, filler], ignore_index=True)

        # Apply analysis filters before calculating totals so every card, chart
        # and detail row describes the same set of chatters.
        selected = filters or {}
        selected_team = str(selected.get("team", "") or "").strip()
        selected_tier = str(selected.get("tier", "") or "").strip()
        selected_score = str(selected.get("score", "") or "").strip().lower()
        if selected_team:
            active = active[active["team_clean"].fillna("").astype(str).str.casefold().eq(selected_team.casefold())].copy()
        if selected_tier:
            active = active[active["skill_tier"].fillna("").astype(str).str.casefold().eq(selected_tier.casefold())].copy()
        if selected_score == "graded":
            active = active[~active["score_pending"].astype(bool)].copy()
        elif selected_score == "pending":
            active = active[active["score_pending"].astype(bool)].copy()

        active = active.merge(hours, on="first_name_key", how="left")
        active = active.merge(scheduled_capacity, on="first_name_key", how="left")
        active["profile_weekly_capacity_hours"] = active["weekly_capacity_hours"]
        active["weekly_capacity_hours"] = active["scheduled_capacity_hours"].where(
            active["scheduled_capacity_hours"].notna(), active["profile_weekly_capacity_hours"]
        )
        active["capacity_source"] = active["scheduled_capacity_hours"].notna().map({True: "RevenueCatcher schedule", False: "Profile capacity"})
        # Revenue is attributed directly to a chatter in Revenue Catcher. Match it
        # to the score profile independently of whether that chatter has a closed
        # shift in this period; otherwise a roster card with no completed shift
        # would incorrectly show zero revenue.
        active = active.merge(revenue_by_profile, on="first_name_key", how="left")
        active["hours"] = pd.to_numeric(active["hours"], errors="coerce").fillna(0)
        active["revenue"] = pd.to_numeric(active["revenue"], errors="coerce").fillna(0)
        active["display_chatter"] = active["chatter"].fillna(active["name"])
        active["capacity_gap_hours"] = active["weekly_capacity_hours"] - active["hours"]
        active["utilization_pct"] = active.apply(
            lambda row: row["hours"] / row["weekly_capacity_hours"] * 100 if row["weekly_capacity_hours"] else 0,
            axis=1,
        )
        active["quality_adjusted_capacity"] = active["weekly_capacity_hours"] * active["skill_grade"] / 100
        active["quality_adjusted_scheduled"] = active["hours"] * active["skill_grade"] / 100
        active["revenue_per_hour"] = active.apply(lambda row: row["revenue"] / row["hours"] if row["hours"] else 0, axis=1)
        active["capacity_missing"] = active["weekly_capacity_hours"].le(0)

        requirement, creators = _creator_capacity_requirement(period_rows)
        strength = float(active["quality_adjusted_capacity"].sum()) if "quality_adjusted_capacity" in active else 0.0
        scheduled_strength = float(active["quality_adjusted_scheduled"].sum()) if "quality_adjusted_scheduled" in active else 0.0
        capacity_total = float(active["weekly_capacity_hours"].sum()) if "weekly_capacity_hours" in active else 0.0
        hours_total = float(active["hours"].sum()) if "hours" in active else 0.0
        revenue_total = float(active["revenue"].sum()) if "revenue" in active else 0.0
        worked_chatters = active[active["hours"].gt(0)].copy() if "hours" in active else pd.DataFrame()
        scheduled_chatters = int(worked_chatters["first_name_key"].nunique()) if not worked_chatters.empty else 0
        hr_matched_chatters = int(worked_chatters["hr_match"].astype(bool).sum()) if not worked_chatters.empty else 0
        weekly_rows.append({
            "week": label,
            "start": start,
            "end": finish,
            "team_strength": strength,
            "scheduled_strength": scheduled_strength,
            "model_requirement": requirement,
            "operating_potential_pct": strength / requirement * 100 if requirement else 0.0,
            "gap": strength - requirement,
            "capacity_hours": capacity_total,
            "scheduled_chatters": scheduled_chatters,
            "hours": hours_total,
            "revenue": revenue_total,
            "revenue_per_hour": revenue_total / hours_total if hours_total else 0.0,
            "avg_skill": scheduled_strength / hours_total * 100 if hours_total else 0.0,
            "hr_matched_chatters": hr_matched_chatters,
            "capacity_missing_chatters": int(active["capacity_missing"].sum()) if "capacity_missing" in active else 0,
            "utilization_pct": hours_total / capacity_total * 100 if capacity_total else 0.0,
        })
        current_table = active.copy()
        current_creators = creators.copy()

    weekly = pd.DataFrame(weekly_rows)
    if not current_table.empty:
        current_table = current_table.sort_values(["quality_adjusted_capacity", "hours", "display_chatter"], ascending=[False, False, True])
        current_table = current_table[[
            "display_chatter", "skill_tier", "skill_grade", "chatting_quality", "activity_behaviour",
            "weekly_capacity_hours", "hours", "capacity_gap_hours", "utilization_pct",
            "quality_adjusted_capacity", "quality_adjusted_scheduled", "revenue", "revenue_per_hour",
            "current_tier", "team_clean", "hr_match", "score_pending", "capacity_missing", "capacity_source", "latest_grade_date",
        ]]
        current_table = current_table.rename(columns={
            "display_chatter": "chatter",
            "skill_tier": "tier",
            "chatting_quality": "chat_quality",
            "activity_behaviour": "activity_behaviour",
            "weekly_capacity_hours": "weekly_capacity_hours",
            "hours": "scheduled_hours",
            "revenue_per_hour": "rev_per_hour",
            "current_tier": "notion_tier",
            "team_clean": "team",
            "hr_match": "hr_profile_found",
        })
    tier_mix = current_table.groupby("tier", dropna=False).agg(chatters=("chatter", "count"), strength=("quality_adjusted_capacity", "sum")).reset_index() if not current_table.empty else pd.DataFrame()
    transition = _transition_watch_rows(roster)
    return {
        "weekly": weekly,
        "current_chatters": current_table,
        "tier_mix": tier_mix,
        "creator_requirements": current_creators,
        "transition": transition,
        "snapshot_rows": len(snapshot),
        "snapshot_source": snapshot_source,
    }
