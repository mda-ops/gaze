import unittest
from datetime import date
from unittest.mock import patch

import pandas as pd

from app.analytics import (
    commission_analysis,
    commission_rule_for_row,
    date_range_for,
    executive_metrics,
    filter_period,
    group_performance,
    safe_pct_change,
    top_n_concentration,
)
from app.web import commission_cost_breakdown, dutch_english_cost_breakdown, flow_manager_dashboard_totals, fmt_money, kpi_value_class, management_allocation_breakdown, operating_expense_breakdown, set_display_currency
from app.financials import financial_ledger
from app.performance_hub import _hours_by_chatter, build_performance_hub_v2


class AnalyticsTests(unittest.TestCase):
    def setUp(self):
        self.df = pd.DataFrame([
            {"date": date(2026, 8, 1), "chatter": "A", "creator": "C1", "platform": "F2F", "team": "NL", "language": "NL", "transaction_type": "unlock", "revenue": 100.0, "shift_hours": 2.0, "messages_sent": 20, "inactive_minutes": 10},
            {"date": date(2026, 8, 2), "chatter": "B", "creator": "C1", "platform": "F2F", "team": "NL", "language": "NL", "transaction_type": "tip", "revenue": 50.0, "shift_hours": 1.0, "messages_sent": 10, "inactive_minutes": 20},
            {"date": date(2026, 7, 25), "chatter": "A", "creator": "C1", "platform": "F2F", "team": "NL", "language": "NL", "transaction_type": "unlock", "revenue": 80.0, "shift_hours": 2.0, "messages_sent": 10, "inactive_minutes": 5},
        ])

    def test_revenue_totals_and_change(self):
        current = self.df.iloc[:2]
        previous = self.df.iloc[2:]
        metrics = executive_metrics(current, previous)
        self.assertEqual(metrics["total_revenue"], 150.0)
        self.assertEqual(metrics["previous_revenue"], 80.0)
        self.assertAlmostEqual(metrics["revenue_change_pct"], 87.5)

    def test_revenue_per_hour(self):
        metrics = executive_metrics(self.df.iloc[:2], self.df.iloc[2:])
        self.assertEqual(metrics["revenue_per_hour"], 50.0)

    def test_revenue_share_and_average_transaction_value(self):
        perf = group_performance(self.df.iloc[:2], self.df.iloc[2:], "chatter")
        row_a = perf[perf["chatter"] == "A"].iloc[0]
        self.assertAlmostEqual(row_a["revenue_share_pct"], 66.6666666, places=5)
        self.assertEqual(row_a["average_transaction_value"], 100.0)

    def test_top_n_concentration(self):
        concentration = top_n_concentration(self.df.iloc[:2], [1, 3])
        self.assertAlmostEqual(concentration["top_1_share_pct"], 66.6666666, places=5)
        self.assertAlmostEqual(concentration["top_3_share_pct"], 100.0)

    def test_hours_and_messages(self):
        perf = group_performance(self.df.iloc[:2], self.df.iloc[2:], "chatter")
        row_a = perf[perf["chatter"] == "A"].iloc[0]
        self.assertEqual(row_a["hours"], 2.0)
        self.assertEqual(row_a["messages_per_hour"], 10.0)

    def test_commission_calculation(self):
        settings = {"commission_rules": [{"creator_pct": 30, "external_partner_pct": 5, "other_commission_pct": 2, "chatter_commission_pct": 8}]}
        result = commission_analysis(self.df.iloc[:1], settings).iloc[0]
        self.assertEqual(result["creator_commission"], 30.0)
        self.assertEqual(result["chatter_payout"], 8.0)
        self.assertEqual(result["company_net_revenue"], 55.0)

    def test_commission_plan_matches_team_before_default(self):
        settings = {"commission_rules": [
            {"name": "Default", "team": "*", "chatter_commission_pct": 8},
            {"name": "Dutch team", "team": "NL", "chatter_commission_pct": 12},
        ]}
        row = self.df.iloc[0]
        self.assertEqual(commission_rule_for_row(row, settings)["name"], "Dutch team")
        result = commission_analysis(self.df.iloc[:1], settings).iloc[0]
        self.assertEqual(result["commission_plan"], "Dutch team")
        self.assertEqual(result["chatter_payout"], 12.0)

    @patch("app.web.revenue_catcher_rate", return_value=2.0)
    def test_commission_breakdown_deducts_english_hourly_salary(self, _rate):
        revenue = self.df.iloc[:1].copy()
        revenue["team"] = "English"
        shifts = pd.DataFrame([{
            "date": date(2026, 8, 1), "transaction_type": "shift_summary", "team": "English",
            "chatter": "A", "platform": "F2F", "shift_hours": 2.0,
        }])
        settings = {"commission_rules": [{"name": "English plan", "team": "English", "chatter_commission_pct": 10}], "english_chatter_salary_usd_per_hour": 2}
        summary, teams, chatters = commission_cost_breakdown(revenue, pd.concat([revenue, shifts], ignore_index=True), settings)
        self.assertEqual(summary, {"pre_salary_commission": 10.0, "salary_cost": 2.0, "post_salary_commission": 8.0})
        self.assertEqual(teams.iloc[0]["team"], "English")
        self.assertEqual(chatters.iloc[0]["commission_plan"], "English plan")

    @patch("app.web.revenue_catcher_rate", return_value=2.0)
    def test_commission_breakdown_uses_english_schedule_when_closed_shifts_missing(self, _rate):
        revenue = pd.DataFrame([{
            "date": date(2026, 8, 1), "transaction_type": "tip", "revenue": 100.0,
            "team": "English", "chatter": "A", "platform": "OF", "flow_chatter_commission_pct": 10.0,
        }])
        schedule = pd.DataFrame([{"team": "English", "chatter": "A", "scheduled_hours": 3.0}])
        settings = {"commission_rules": [{"chatter_commission_pct": 8}], "english_chatter_salary_usd_per_hour": 2}
        summary, _, _ = commission_cost_breakdown(revenue, revenue, settings, schedule)
        self.assertEqual(summary["salary_cost"], 3.0)

    def test_commission_breakdown_prefers_flow_rate_over_generic_plan(self):
        revenue = pd.DataFrame([{
            "date": date(2026, 8, 1), "transaction_type": "tip", "revenue": 100.0,
            "team": "English", "chatter": "A", "platform": "OF",
            "flow_chatter_commission_pct": 7.5, "flow_commission_pool": "English core",
        }])
        settings = {"commission_rules": [{"name": "Fallback", "chatter_commission_pct": 8}]}
        summary, _, chatters = commission_cost_breakdown(revenue, revenue, settings)
        self.assertEqual(summary["pre_salary_commission"], 7.5)
        self.assertEqual(chatters.iloc[0]["commission_plan"], "Flow rate 7.5% · English core")

    def test_commission_breakdown_does_not_pay_unattributed_revenue(self):
        revenue = pd.DataFrame([{
            "date": date(2026, 8, 1), "transaction_type": "tip", "revenue": 100.0,
            "team": None, "chatter": None, "platform": "OF",
        }])
        settings = {"commission_rules": [{"name": "Fallback", "chatter_commission_pct": 8}]}
        summary, teams, chatters = commission_cost_breakdown(revenue, revenue, settings)
        self.assertEqual(summary["pre_salary_commission"], 0.0)
        self.assertTrue(teams.empty)
        self.assertTrue(chatters.empty)

    def test_management_allocation_uses_flow_manager_rate(self):
        revenue = pd.DataFrame([{
            "date": date(2026, 8, 1), "transaction_type": "tip", "revenue": 100.0,
            "team": "Dutch", "chatter": "A", "flow_manager_commission_pct": 1.5,
            "flow_manager_name": "Maurice",
        }])
        summary, detail = management_allocation_breakdown(revenue, {"net_revenue": 70.0})
        self.assertEqual(summary["chat_manager_cuts"], 1.5)
        self.assertEqual(summary["admin_management_pool"], 68.5)
        self.assertEqual(detail.iloc[0]["chat_manager"], "Maurice")

    @patch("app.web.flow_bonus_by_chatter")
    def test_commission_breakdown_includes_flow_bonus(self, flow_bonus):
        flow_bonus.return_value = pd.DataFrame([{"team": "Dutch", "chatter": "A", "flow_bonus": 2.5}])
        revenue = pd.DataFrame([{
            "date": date(2026, 8, 1), "transaction_type": "tip", "revenue": 100.0,
            "team": "Dutch", "chatter": "A", "platform": "F2F", "flow_chatter_commission_pct": 10.0,
        }])
        summary, teams, chatters = commission_cost_breakdown(revenue, revenue, {"commission_rules": [{"chatter_commission_pct": 8}]})
        self.assertEqual(chatters.iloc[0]["base_commission"], 10.0)
        self.assertEqual(chatters.iloc[0]["flow_bonus"], 2.5)
        self.assertEqual(summary["pre_salary_commission"], 12.5)
        self.assertEqual(teams.iloc[0]["flow_bonus"], 2.5)

    @patch("app.web.revenue_catcher_rate", return_value=2.0)
    def test_operating_expenses_accrue_over_selected_days(self, _rate):
        settings = {"operating_expenses": [
            {"department": "Ops", "person": "A", "monthly_amount": 300.0, "currency": "EUR"},
            {"department": "Ops", "person": "B", "monthly_amount": 300.0, "currency": "USD"},
        ]}
        summary, department = operating_expense_breakdown(settings, date(2026, 9, 1), date(2026, 9, 15))
        self.assertEqual(summary["period_eur"], 150.0)
        self.assertEqual(summary["period_usd"], 150.0)
        self.assertEqual(summary["period_eur_reporting"], 225.0)
        self.assertEqual(department.iloc[0]["monthly_eur"], 300.0)

    def test_dutch_and_english_costs_are_separated(self):
        revenue = pd.DataFrame([
            {"date": date(2026, 8, 1), "transaction_type": "tip", "revenue": 100.0, "team": "Dutch", "chatter": "A", "platform": "F2F"},
            {"date": date(2026, 8, 1), "transaction_type": "tip", "revenue": 50.0, "team": "English", "chatter": "B", "platform": "F2F"},
        ])
        settings = {"commission_rules": [{"name": "Plan", "chatter_commission_pct": 10}]}
        result = dutch_english_cost_breakdown(revenue, revenue, settings).set_index("team")
        self.assertEqual(result.loc["Dutch", "chatter_commission_pre_salary"], 10.0)
        self.assertEqual(result.loc["English", "chatter_commission_pre_salary"], 5.0)

    @patch("app.performance_hub.load_chatter_snapshot")
    def test_performance_hub_v2_keeps_grade_for_scheduled_non_active_chatter(self, load_snapshot):
        load_snapshot.return_value = pd.DataFrame([{
            "name": "Aaliyah", "first_name_key": "aaliyah", "status_clean": "Training", "team_clean": "English",
            "current_tier": "Unassigned", "skill_grade": 80.0, "skill_tier": "B", "chatting_quality": 80.0,
            "activity_behaviour": 80.0, "weekly_capacity_hours": 20.0, "latest_grade_date": "2026-08-01",
        }])
        shifts = pd.DataFrame([{
            "date": date(2026, 9, 15), "transaction_type": "shift_summary", "chatter": "Aaliyah",
            "shift_hours": 4.0, "revenue": None,
        }])
        result = build_performance_hub_v2(shifts, date(2026, 9, 15))
        row = result["current_chatters"].iloc[0]
        self.assertEqual(row["skill_grade"], 80.0)
        self.assertFalse(row["score_pending"])
        self.assertEqual(str(row["latest_grade_date"])[:10], "2026-08-01")

    @patch("app.performance_hub.load_chatter_snapshot")
    def test_performance_hub_v2_uses_revenue_catcher_schedule_for_capacity(self, load_snapshot):
        load_snapshot.return_value = pd.DataFrame([{
            "name": "Aaliyah", "first_name_key": "aaliyah", "status_clean": "Training", "team_clean": "English",
            "current_tier": "Unassigned", "skill_grade": 80.0, "skill_tier": "B", "chatting_quality": 80.0,
            "activity_behaviour": 80.0, "weekly_capacity_hours": 0.0, "latest_grade_date": "2026-08-01",
        }])
        schedules = pd.DataFrame([{
            "date": date(2026, 9, 15), "chatter": "Aaliyah", "scheduled_hours": 7.5,
        }])
        revenue = pd.DataFrame([{
            "date": date(2026, 9, 15), "transaction_type": "tip", "chatter": "Aaliyah", "revenue": 100.0,
        }])
        result = build_performance_hub_v2(revenue, date(2026, 9, 15), scheduled_data=schedules)
        row = result["current_chatters"].iloc[0]
        self.assertEqual(row["weekly_capacity_hours"], 7.5)
        self.assertEqual(row["capacity_source"], "RevenueCatcher schedule")
        self.assertFalse(row["capacity_missing"])
        self.assertEqual(row["revenue"], 100.0)

    def test_performance_hub_hours_count_overlapping_model_assignments_once(self):
        shifts = pd.DataFrame([
            {"date": date(2026, 9, 15), "transaction_type": "shift_summary", "chatter": "Aaliyah", "shift_hours": 8.0,
             "shift_start": "2026-09-15T08:00:00Z", "shift_end": "2026-09-15T16:00:00Z", "creator": "Model A"},
            {"date": date(2026, 9, 15), "transaction_type": "shift_summary", "chatter": "Aaliyah", "shift_hours": 8.0,
             "shift_start": "2026-09-15T08:00:00Z", "shift_end": "2026-09-15T16:00:00Z", "creator": "Model B"},
            {"date": date(2026, 9, 15), "transaction_type": "shift_summary", "chatter": "Aaliyah", "shift_hours": 4.0,
             "shift_start": "2026-09-15T14:00:00Z", "shift_end": "2026-09-15T18:00:00Z", "creator": "Model C"},
        ])
        result = _hours_by_chatter(shifts)
        self.assertEqual(result.iloc[0]["hours"], 10.0)

    def test_flow_manager_totals_exclude_rows_without_md_cut(self):
        rows = pd.DataFrame([
            {"transaction_type": "tip", "revenue": 100.0, "net_amount": 25.0},
            {"transaction_type": "subscription", "status": "paid-pending-balance", "revenue": 40.0, "net_amount": 10.0},
            {"transaction_type": "subscription", "status": "loading", "revenue": 30.0, "net_amount": 8.0},
            {"transaction_type": "ppv", "revenue": 20.0, "net_amount": 5.0},
            {"transaction_type": "message", "revenue": 80.0, "net_amount": 0.0},
            {"transaction_type": "shift_summary", "revenue": 999.0, "net_amount": 100.0},
        ])
        totals = flow_manager_dashboard_totals(rows)
        self.assertEqual(totals["gross"], 170.0)
        self.assertEqual(totals["net"], 43.0)
        self.assertEqual(totals["eligible_rows"], 3)

    def test_date_filtering_and_friday_week(self):
        start, end = date_range_for("This week", today=date(2026, 8, 11), week_start="Friday")
        self.assertEqual(start, date(2026, 8, 7))
        self.assertEqual(end, date(2026, 8, 11))
        filtered = filter_period(self.df, date(2026, 8, 1), date(2026, 8, 2), {})
        self.assertEqual(len(filtered), 2)

    def test_safe_zero_previous(self):
        self.assertIsNone(safe_pct_change(100, 0))

    def test_kpi_value_status_is_semantic_not_numeric(self):
        self.assertEqual(kpi_value_class("€1,234.50", "chatter_commission"), "")
        self.assertEqual(kpi_value_class("-€54,487.05", "operating_expenses"), "")
        self.assertEqual(kpi_value_class("+€17.60", "profit_loss"), "kpi-positive")
        self.assertEqual(kpi_value_class("-€17.60", "profit_loss"), "kpi-negative")
        self.assertEqual(kpi_value_class("+17.6%", "profit_margin"), "kpi-positive")
        self.assertEqual(kpi_value_class("n/a"), "")

    def test_financial_ledger_reconciles_without_double_counting(self):
        ledger = financial_ledger(
            gross_revenue=1000, platform_fees=100, creator_share=200, partner_share=50, other_external=0,
            chatter_commission=100, chatter_bonus=20, chatter_salary=80, manager_commission=10,
            other_direct_costs=0, operating_expenses=140,
        )
        self.assertEqual(ledger["agency_revenue"], 650)
        self.assertEqual(ledger["direct_revenue_costs"], 210)
        self.assertEqual(ledger["net_revenue"], 440)
        self.assertEqual(ledger["profit_loss"], 300)
        self.assertEqual(ledger["profit_margin_pct"], 30)
        self.assertTrue(ledger["is_complete"])

    def test_financial_ledger_keeps_missing_costs_unavailable(self):
        ledger = financial_ledger(gross_revenue=1000, platform_fees=None, creator_share=None)
        self.assertIsNone(ledger["agency_revenue"])
        self.assertIsNone(ledger["net_revenue"])
        self.assertIsNone(ledger["profit_loss"])

    @patch("app.web.revenue_catcher_rate", return_value=1.2)
    def test_money_display_can_switch_between_eur_and_usd(self, _rate):
        set_display_currency("USD")
        self.assertEqual(fmt_money(10), "$12.00")
        set_display_currency("EUR")
        self.assertEqual(fmt_money(10), "€10.00")


if __name__ == "__main__":
    unittest.main()
