import unittest
from datetime import date

import pandas as pd

from app.target_monitoring import build_target_monitoring


class TargetMonitoringTests(unittest.TestCase):
    def test_flow_target_matches_transaction_by_model_name(self):
        transactions = pd.DataFrame([
            {
                "date": date(2026, 10, 1),
                "creator": "Jane",
                "account_username": "jane_f2f",
                "platform": "F2F",
                "transaction_type": "tip",
                "revenue": 4000.0,
            },
        ])
        # Flow can store the target against a model name while transactions use
        # an account username. Both aliases must resolve to the same target.
        flow_targets = pd.DataFrame([
            {
                "account": "",
                "account_username": "",
                "model": "Jane",
                "platform": "F2F",
                "current_target": 3500.0,
            },
        ])

        result = build_target_monitoring(
            transactions,
            date(2026, 10, 1),
            date(2026, 10, 1),
            flow_targets,
        )

        row = result.raw.iloc[0]
        self.assertEqual(row["Current Target"], "€3,500.00")
        self.assertNotEqual(row["Action"], "Needs Target")

    def test_missing_target_remains_visible_for_real_gaps(self):
        transactions = pd.DataFrame([
            {
                "date": date(2026, 10, 1),
                "creator": "No Target",
                "account_username": "no_target",
                "platform": "F2F",
                "transaction_type": "tip",
                "revenue": 500.0,
            },
        ])

        result = build_target_monitoring(
            transactions,
            date(2026, 10, 1),
            date(2026, 10, 1),
            pd.DataFrame(),
        )

        self.assertEqual(result.raw.iloc[0]["Action"], "Needs Target")


if __name__ == "__main__":
    unittest.main()
