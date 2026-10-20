import unittest
from unittest.mock import patch

import pandas as pd

from app.currency import MONEY_COLUMNS, normalize_revenue_catcher
from app.connectors import revenue_catcher_to_frame
from app import postgres_source


class CurrencyTests(unittest.TestCase):
    def test_native_amounts_and_all_net_components_convert_together(self):
        frame = pd.DataFrame([
            {"platform": "F2F", "currency": "EUR", **dict.fromkeys(MONEY_COLUMNS, 100)},
            {"platform": "OF", "currency": "USD", **dict.fromkeys(MONEY_COLUMNS, 116.16)},
            {"platform": "KNKY", "currency": "USD", **dict.fromkeys(MONEY_COLUMNS, -116.16)},
        ])
        result = normalize_revenue_catcher(frame, 1.1616)
        for column in MONEY_COLUMNS:
            self.assertAlmostEqual(result[column].sum(), 100)
            self.assertAlmostEqual(result.loc[1, column], 100)
        self.assertTrue(result.currency.eq("EUR").all())
        self.assertEqual(frame.loc[1, "revenue"], 116.16)
        pd.testing.assert_frame_equal(result, normalize_revenue_catcher(result))

    def test_missing_currency_uses_platform_and_preserves_missing_values(self):
        result = normalize_revenue_catcher(pd.DataFrame([
            {"platform": "OF", "revenue": 116.16, "net_amount": None, "shift_hours": 2},
            {"platform": "F2F", "revenue": 0},
        ]), 1.1616)
        self.assertAlmostEqual(result.loc[0, "revenue"], 100)
        self.assertTrue(pd.isna(result.loc[0, "net_amount"]))
        self.assertEqual(result.loc[0, "shift_hours"], 2)
        self.assertEqual(result.loc[1, "revenue"], 0)

    def test_new_summary_selects_eur_without_double_conversion(self):
        result = revenue_catcher_to_frame({"dailySeries": [{"date": "2026-09-01", "totals": {"tip": {"eur": 100, "usd": 116.16}}}]})
        self.assertEqual(result.iloc[0].revenue, 100)
        self.assertEqual(result.iloc[0].tip_revenue, 100)

    def test_unlabeled_legacy_summary_cannot_override_eur_revenue(self):
        with self.assertRaisesRegex(ValueError, "summary has no currency"):
            revenue_catcher_to_frame({"summary": [{"period": "2026-09-11", "gross_amount": 6960.03}]})
        result = revenue_catcher_to_frame({"summary": [{"period": "2026-09-11", "gross_amount": {"eur": 5992.3, "usd": 6960.66}}]})
        self.assertAlmostEqual(result.iloc[0].revenue, 5992.3)

    @patch("app.currency.revenue_catcher_rate", return_value=1.1616)
    def test_api_transactions_and_shifts(self, rate):
        tx = revenue_catcher_to_frame({"results": [{"platform": "of", "gross_amount": 116.16, "net_amount": 92.928, "type": "tip"}]})
        self.assertAlmostEqual(tx.iloc[0].revenue, 100)
        self.assertAlmostEqual(tx.iloc[0].net_amount, 80)
        shift = revenue_catcher_to_frame({"shifts": [{"platform": "knky", "gross_revenue": 116.16, "commission_earned": 11.616}]})
        self.assertAlmostEqual(shift.iloc[0].revenue, 100)
        self.assertAlmostEqual(shift.iloc[0].commission_earned, 10)

    def test_invalid_rate_and_missing_eur_fail_instead_of_mislabeling(self):
        frame = pd.DataFrame([{"currency": "USD", "revenue": 100}])
        for rate in [0, -1, float("nan"), float("inf")]:
            with self.assertRaises(ValueError):
                normalize_revenue_catcher(frame, rate)
        with self.assertRaises(ValueError):
            normalize_revenue_catcher(pd.DataFrame([{"revenue": {"usd": 100}}]))

    @patch("app.postgres_source.configured_database_url", return_value="test")
    @patch("app.currency.revenue_catcher_rate", return_value=1.1616)
    @patch("app.postgres_source._read_sql_or_empty")
    def test_postgres_normalizes_before_caching(self, read, rate, url):
        read.side_effect = lambda label, *args: pd.DataFrame([{"platform": "OF", "currency": "USD", "revenue": 116.16}]) if label == "transactions" else pd.DataFrame()
        postgres_source._CACHE.clear()
        try:
            result = postgres_source.load_postgres_transactions(force_refresh=True)
            cached = postgres_source.load_postgres_transactions()
            self.assertAlmostEqual(result.iloc[0].revenue, 100)
            pd.testing.assert_frame_equal(result, cached)
            self.assertEqual(rate.call_count, 1)
        finally:
            postgres_source._CACHE.clear()


if __name__ == "__main__":
    unittest.main()
