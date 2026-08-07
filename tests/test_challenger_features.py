import sys
import unittest
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from train_challenger import (  # noqa: E402
    HISTORICAL_THRESHOLDS,
    FeatureSpec,
    historical_feature_matrix,
    historical_feature_names,
)


def historical_row(
    key,
    spf_result,
    hhad_result,
    goals,
    handicap=1,
    home_odds=2.0,
):
    row = {
        "match_key": key,
        "spf_result": spf_result,
        "hhad_result": hhad_result,
        "actual_goals": goals,
        "handicap": handicap,
    }
    for prefix, size in [("spf_f", 3), ("hhad_f", 3), ("goal_f", 8)]:
        suffixes = ["h", "d", "a"] if size == 3 else list(range(size))
        odds = (
            [home_odds, 3.2, 4.0]
            if size == 3
            else [8.0, 5.0, 4.0, 4.2, 6.0, 9.0, 15.0, 25.0]
        )
        for suffix, value in zip(suffixes, odds):
            row[f"{prefix}_{suffix}"] = value
    return row


class ChallengerHistoricalFeatureTests(unittest.TestCase):
    def test_each_row_only_uses_strictly_earlier_results(self):
        rows = [
            historical_row("m1", "胜", "负", "1"),
            historical_row("m2", "平", "胜", "2"),
            historical_row("m3", "负", "平", "3"),
        ]
        names = historical_feature_names(HISTORICAL_THRESHOLDS)
        spec = FeatureSpec(
            leagues=[],
            names=names,
            history_sources=["main.xlsx"],
            historical_thresholds=HISTORICAL_THRESHOLDS,
        )
        matrix = historical_feature_matrix(rows, spec)
        count_index = names.index("history_spf_t0p07_sample_count")
        win_index = names.index("history_spf_t0p07_p_0")
        draw_index = names.index("history_spf_t0p07_p_1")

        self.assertEqual(matrix[0, count_index], 0)
        self.assertEqual(matrix[1, count_index], 1)
        self.assertEqual(matrix[1, win_index], 1)
        self.assertEqual(matrix[1, draw_index], 0)
        self.assertEqual(matrix[2, count_index], 2)
        self.assertTrue(np.isclose(matrix[2, win_index], 0.5))
        self.assertTrue(np.isclose(matrix[2, draw_index], 0.5))

    def test_hhad_history_requires_the_same_handicap(self):
        rows = [
            historical_row("m1", "胜", "胜", "1", handicap=1),
            historical_row("m2", "平", "负", "2", handicap=-1),
            historical_row("m3", "负", "平", "3", handicap=1),
        ]
        names = historical_feature_names(HISTORICAL_THRESHOLDS)
        spec = FeatureSpec(
            leagues=[],
            names=names,
            history_sources=["main.xlsx"],
            historical_thresholds=HISTORICAL_THRESHOLDS,
        )
        matrix = historical_feature_matrix(rows, spec)
        count_index = names.index("history_hhad_t0p07_sample_count")

        self.assertEqual(matrix[1, count_index], 0)
        self.assertEqual(matrix[2, count_index], 1)


if __name__ == "__main__":
    unittest.main()
