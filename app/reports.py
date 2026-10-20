from __future__ import annotations

from datetime import date

import pandas as pd

from .analytics import executive_metrics, group_performance, safe_pct_change
from .looker_sources import ads_data, inactivity_monitor_rows, inactivity_monitor_summary, model_socials_data, of_new_fans_data

REPORT_REVENUE_TYPES = {"tip", "tips", "message", "messages"}


def money(value, currency: str = "EUR") -> str:
    if value is None or pd.isna(value):
        return "n/a"
    symbol = "€" if currency == "EUR" else "$"
    return f"{symbol}{float(value):,.0f}"


def pct(value) -> str:
    if value is None or pd.isna(value):
        return "n/a"
    return f"{float(value):.1f}%"


def clean_name(value, fallback: str = "Unassigned") -> str:
    if value is None or pd.isna(value):
        return fallback
    text = str(value).strip()
    if not text or text.lower() in {"nan", "none", "unknown"}:
        return fallback
    return text


def named_rows(rows: pd.DataFrame, name_col: str) -> pd.DataFrame:
    if rows.empty or name_col not in rows:
        return rows
    clean = rows.copy()
    names = clean[name_col].apply(lambda value: clean_name(value, ""))
    return clean[names.ne("")].copy()


def tips_messages_revenue_only(rows: pd.DataFrame) -> pd.DataFrame:
    if rows.empty or "transaction_type" not in rows or "revenue" not in rows:
        return rows.copy()
    filtered = rows.copy()
    revenue_type = filtered["transaction_type"].fillna("").astype(str).str.strip().str.lower()
    filtered.loc[~revenue_type.isin(REPORT_REVENUE_TYPES), "revenue"] = 0
    return filtered


def delta_line(current: float, previous: float, suffix: str) -> str:
    change = current - previous
    change_pct = safe_pct_change(current, previous)
    if change_pct is None:
        return f":eyes: no previous {suffix} comparison available"
    icon = ":tada:" if change >= 0 else ":small_red_triangle_down:"
    direction = "increase" if change >= 0 else "decrease"
    return f"{icon} {direction} {money(abs(change))} - {pct(abs(change_pct))} {suffix}"


def delta_suffix(row: pd.Series, label: str = "%\u0394") -> str:
    value = row.get("change_pct")
    if value is None or pd.isna(value):
        return ""
    direction = "up" if float(value) >= 0 else "down"
    return f" | {label} {direction} {pct(abs(value))}"


def range_title(start: date, end: date, kind: str) -> str:
    if kind == "monthly":
        return f"monthly - {start.strftime('%B %Y')}"
    week_num = ((end.day - 1) // 7) + 1
    return f"week {week_num} - {start.day} {start.strftime('%B')} - {end.day} {end.strftime('%B')}"


def compact_rows(rows: pd.DataFrame, name_col: str, value_col: str = "revenue", limit: int = 5) -> list[str]:
    rows = named_rows(rows, name_col)
    if rows.empty or name_col not in rows:
        return ["No ranked data available yet."]
    lines = []
    for _, row in rows.head(limit).iterrows():
        name = clean_name(row.get(name_col))
        lines.append(f"{name} {money(row.get(value_col, 0))}")
    return lines


def platform_lines(platform_rows: pd.DataFrame) -> list[str]:
    if platform_rows.empty:
        return [":purple_heart: F2F: n/a", ":pink_heart: KNKY: n/a", ":blue_heart: OF: n/a"]
    aliases = [("F2F", ":purple_heart:"), ("KNKY", ":pink_heart:"), ("OF", ":blue_heart:")]
    lines = []
    for platform, icon in aliases:
        row = platform_rows[platform_rows["platform"].astype(str).str.upper().eq(platform)]
        total = float(row.iloc[0]["revenue"]) if not row.empty else 0
        lines.append(f"{icon} {platform}: {money(total)}")
    return lines


def section_platform_detail(platform_rows: pd.DataFrame, current: pd.DataFrame, previous: pd.DataFrame, platform: str, icon: str) -> list[str]:
    lines = [f"**{platform}** {icon}"]
    platform_current = current[current["platform"].astype(str).str.upper().eq(platform)] if "platform" in current else pd.DataFrame()
    platform_previous = previous[previous["platform"].astype(str).str.upper().eq(platform)] if "platform" in previous else pd.DataFrame()
    cur_total = float(platform_current["revenue"].dropna().sum()) if not platform_current.empty else 0
    prev_total = float(platform_previous["revenue"].dropna().sum()) if not platform_previous.empty else 0
    change_pct = safe_pct_change(cur_total, prev_total)
    if change_pct is None:
        lines.append(":eyes: no previous comparison available")
    else:
        verb = "increased" if cur_total >= prev_total else "dropped"
        badge = ":tada:" if cur_total >= prev_total else ":small_red_triangle_down:"
        lines.append(f"{badge} {platform} {verb} {pct(abs(change_pct))} vs previous period")
    creators = group_performance(platform_current, platform_previous, "creator") if not platform_current.empty else pd.DataFrame()
    for _, row in creators.head(5).iterrows():
        name = clean_name(row.get("creator"))
        change = row.get("change_pct")
        badge = ":tada:" if pd.notna(change) and change >= 0 else ":small_red_triangle_down:" if pd.notna(change) else ":eyes:"
        detail = f" - {'up' if pd.notna(change) and change >= 0 else 'down'} {pct(abs(change))}" if pd.notna(change) else ""
        lines.append(f"{badge} {name} {money(row.get('revenue', 0))}{detail}")
    return lines


def marketing_lines(start: date, end: date) -> list[str]:
    socials = model_socials_data(start, end)
    raw = socials.get("raw", pd.DataFrame())
    if raw.empty:
        return [":iphone: **MKTG**", "Marketing socials data is not available for this date range."]
    impressions = float(raw.get("impressions", pd.Series(dtype=float)).sum())
    profile_visits = float(raw.get("profile_visits", pd.Series(dtype=float)).sum())
    followers = float(raw.get("followers_gained", pd.Series(dtype=float)).sum())
    bio_clicks = float(raw.get("bio_clicks", pd.Series(dtype=float)).sum())
    by_model = socials.get("by_model", pd.DataFrame())
    by_model = named_rows(by_model, "Model")
    top_reach = clean_name(by_model.iloc[0]["Model"], "top account") if not by_model.empty and "Model" in by_model else "top account"
    return [
        ":iphone: **MKTG**",
        f"IG impressions: {impressions:,.0f}",
        f"profile visits: {profile_visits:,.0f}",
        f"net followers gained: {followers:,.0f}",
        f"organic link clicks: {bio_clicks:,.0f}",
        f":tada: {top_reach} had the strongest reach in the selected period",
    ]


def ads_lines(start: date, end: date) -> list[str]:
    ads = ads_data(start, end)
    raw = ads.get("raw", pd.DataFrame())
    if raw.empty:
        return [":mega: **BD ADS**", "BD ads data is not available for this date range."]
    spend = float(raw.get("spend_num", pd.Series(dtype=float)).sum())
    clicks = float(raw.get("clicks_num", pd.Series(dtype=float)).sum())
    return [":mega: **BD ADS**", f":money_with_wings: total BD ad spend: {money(spend, 'USD')}", f"clicks: {clicks:,.0f}"]


def of_subs_lines(start: date, end: date) -> list[str]:
    fans = of_new_fans_data(start, end)
    rows = fans.get("by_model", pd.DataFrame())
    lines = [":dancer: **OF New Subs:**"]
    if rows.empty:
        lines.append("OF new fan data is not available for this date range.")
        return lines
    for _, row in rows.head(5).iterrows():
        lines.append(f"{int(row['new_fans']):,} - {row['model']}")
    return lines


def inactivity_lines(start: date, end: date, current: pd.DataFrame | None = None) -> list[str]:
    lines = [":eyes: **INACTIVITY**"]
    if current is not None and not current.empty and "transaction_type" in current:
        rows = current[current["transaction_type"].eq("inactivity")].copy()
        if not rows.empty:
            for col in ["inactive_minutes", "inactivity_money_wasted", "peak_unread_chats"]:
                if col in rows:
                    rows[col] = pd.to_numeric(rows[col], errors="coerce").fillna(0)
                else:
                    rows[col] = 0
            rows["chatter"] = rows.get("chatter", pd.Series(index=rows.index, dtype=object)).fillna("Unknown").replace("", "Unknown")
            rows = rows[~rows["chatter"].astype(str).str.strip().str.lower().isin(["", "unknown"])].copy()
            if rows.empty:
                lines.append("No chatter-specific inactivity was found for this date range.")
                return lines
            grouped = rows.groupby("chatter", dropna=False).agg(
                events=("transaction_key", "count"),
                max_unread=("peak_unread_chats", "max"),
                total_hours=("inactive_minutes", lambda values: float(values.sum()) / 60),
                max_hours=("inactive_minutes", lambda values: float(values.max()) / 60),
                money_wasted=("inactivity_money_wasted", "sum"),
            ).reset_index().sort_values(["money_wasted", "max_unread", "total_hours"], ascending=False)
            lines.append(f"highest unread: {int(rows['peak_unread_chats'].max()):,}")
            lines.append(f"total inactive hours: {float(rows['inactive_minutes'].sum() / 60):,.1f}h")
            lines.append(f"estimated money wasted: {money(rows['inactivity_money_wasted'].sum())}")
            lines.append(":eyes: pattern to watch")
            for _, row in grouped.head(6).iterrows():
                lines.append(f"{row['chatter']} - {int(row['max_unread']):,} peak unread - {float(row['max_hours']):.1f}h max inactive - {money(row['money_wasted'])} wasted")
            return lines
    rows = inactivity_monitor_rows(start, end)
    summary = inactivity_monitor_summary(rows)
    if rows.empty:
        lines.append("Inactivity detail is not connected for this date range yet.")
        return lines
    lines.append(f"highest unread: {summary['max_unread']}")
    lines.append(f"total inactive hours: {summary['total_hours']:,.1f}h")
    lines.append(f"estimated money wasted: {money(summary['money_wasted'])}")
    lines.append(":eyes: pattern to watch")
    for _, row in rows.sort_values(["max_unread", "total_hours"], ascending=False).head(6).iterrows():
        lines.append(f"{row['name']} - {int(row['max_unread'])} max unread - {float(row['max_hours']):.1f}h max inactive")
    return lines

def management_summary(report: dict) -> str:
    summary = report["summary"]
    lines = [
        f"{report['title']}",
        "",
        f"Total revenue landed at {money(summary['total_revenue'])}. {delta_line(summary['total_revenue'], summary['previous_revenue'], report['comparison_suffix'])}",
    ]
    if summary.get("revenue_per_hour"):
        lines.append(f"Revenue per hour was {money(summary['revenue_per_hour'])}.")
    if report["creator_performance"]:
        creators = named_rows(pd.DataFrame(report["creator_performance"]), "creator")
        if not creators.empty:
            top = creators.iloc[0]
            lines.append(f"Top model was {clean_name(top.get('creator'))} at {money(top.get('revenue', 0))}.")
    if report["chatter_performance"]:
        chatters = named_rows(pd.DataFrame(report["chatter_performance"]), "chatter")
        if not chatters.empty:
            top = chatters.iloc[0]
            lines.append(f"Top chatter was {clean_name(top.get('chatter'))} at {money(top.get('revenue', 0))}.")
    lines.extend(report["auto_insights"][:5])
    return "\n".join(lines)


def formatted_report(report: dict) -> str:
    summary = report["summary"]
    lines = [
        report["title"],
        "",
        ":speech_balloon: **CHAT DEPT**",
        f"OVERALL {report['kind']} rev: {money(summary['total_revenue'])}",
        delta_line(summary["total_revenue"], summary["previous_revenue"], report["comparison_suffix"]),
        "",
        *platform_lines(pd.DataFrame(report["platform_performance"])),
        "",
        ":trophy: **MODELS**",
        *compact_rows(pd.DataFrame(report["creator_performance"]), "creator", "revenue", 5),
        "",
    ]
    current = report["current"]
    previous = report["previous"]
    detail_current = report.get("detail_current", current)
    for platform, icon in [("F2F", ":purple_heart:"), ("KNKY", ":pink_heart:"), ("OF", ":blue_heart:")]:
        lines.extend(section_platform_detail(pd.DataFrame(report["platform_performance"]), current, previous, platform, icon))
        lines.append("")
    lines.extend([":trophy: **TOP CHATTERS**", *compact_rows(pd.DataFrame(report["chatter_performance"]), "chatter", "revenue", 10), ""])
    lines.extend(inactivity_lines(report["start"], report["end"], detail_current))
    lines.extend(["", *ads_lines(report["start"], report["end"]), "", *marketing_lines(report["start"], report["end"]), "", *of_subs_lines(report["start"], report["end"])])
    lines.extend([
        "",
        ":handshake: **BD**",
        "BD leads, meetings, and signed deals need the BD source connected.",
        "",
        ":art: **CREATIVE DIRECTING**",
        "Creative output data needs the creative tracking source connected.",
        "",
        ":busts_in_silhouette: **HR**",
        "HR applicant, offer, onboarding, resignation, and termination data needs the HR source connected.",
        "",
        ":rotating_light: **OVERALL**",
        *report["auto_insights"][:8],
    ])
    return "\n".join(lines)


def generate_report(current: pd.DataFrame, previous: pd.DataFrame, settings: dict, start: date, end: date, kind: str = "weekly") -> dict:
    revenue_current = tips_messages_revenue_only(current) if kind == "weekly" else current
    revenue_previous = tips_messages_revenue_only(previous) if kind == "weekly" else previous
    metrics = executive_metrics(revenue_current, revenue_previous)
    metrics["previous_revenue"] = float(revenue_previous["revenue"].dropna().sum()) if not revenue_previous.empty and "revenue" in revenue_previous else 0.0
    chatter = group_performance(revenue_current, revenue_previous, "chatter")
    creator = group_performance(revenue_current, revenue_previous, "creator")
    platform = group_performance(revenue_current, revenue_previous, "platform")
    auto_insights = []
    creator = named_rows(creator, "creator")
    chatter = named_rows(chatter, "chatter")
    platform = named_rows(platform, "platform")
    if not creator.empty:
        winner = creator.iloc[0]
        auto_insights.append(f":tada: {clean_name(winner.get('creator'))} led model revenue with {money(winner.get('revenue', 0))}.")
        climbers = creator[creator["change_pct"].notna()].sort_values("change_pct", ascending=False).head(2)
        for _, row in climbers.iterrows():
            if row["change_pct"] > 0:
                auto_insights.append(f":tada: {clean_name(row.get('creator'))} improved {pct(row['change_pct'])} vs previous period.")
    if not chatter.empty:
        top = chatter.iloc[0]
        auto_insights.append(f":warning: top chatter was {clean_name(top.get('chatter'))} at {money(top.get('revenue', 0))}.")
    if not platform.empty:
        best_platform = platform.iloc[0]
        auto_insights.append(f":eyes: strongest platform was {clean_name(best_platform.get('platform'))} at {money(best_platform.get('revenue', 0))}.")
    if not auto_insights:
        auto_insights.append(":eyes: detailed entity insights need imported creator, chatter, and platform data for the selected period.")
    return {
        "kind": kind,
        "title": range_title(start, end, "monthly" if kind == "monthly" else "weekly"),
        "comparison_suffix": "MoM" if kind == "monthly" else "WoW",
        "summary": metrics,
        "platform_performance": platform.head(8).to_dict("records") if not platform.empty else [],
        "creator_performance": creator.head(8).to_dict("records") if not creator.empty else [],
        "chatter_performance": chatter.head(10).to_dict("records") if not chatter.empty else [],
        "auto_insights": auto_insights,
        "current": revenue_current,
        "previous": revenue_previous,
        "detail_current": current,
        "detail_previous": previous,
        "start": start,
        "end": end,
    }



