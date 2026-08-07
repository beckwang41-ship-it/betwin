from __future__ import annotations

import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from unify_history import (  # noqa: E402
    align_reverse_order,
    normalize_name,
    pair_quality,
)


def spf_row(
    row_id: int,
    source_row: int,
    home: str,
    away: str,
    goals: int,
) -> dict[str, object]:
    return {
        "id": row_id,
        "source_row": source_row,
        "league": "英超",
        "home_team": home,
        "away_team": away,
        "total_goals": goals,
    }


def goal_row(
    row_id: int,
    source_row: int,
    home: str,
    away: str,
    goals: int,
) -> dict[str, object]:
    return {
        "id": row_id,
        "source_row": source_row,
        "league": "英超",
        "home_team": home,
        "away_team": away,
        "actual_goals": str(goals),
    }


class ReverseHistoryAlignmentTests(unittest.TestCase):
    def test_team_aliases_are_shared_with_runtime_settlement(self) -> None:
        self.assertEqual(normalize_name("弗鲁米嫩"), normalize_name("弗鲁米嫩塞"))
        self.assertEqual(
            normalize_name("圣吉尔联合"), normalize_name("圣吉联合")
        )
        self.assertEqual(
            normalize_name("布拉格斯巴达"), normalize_name("布斯巴达")
        )

    def test_same_fixture_in_multiple_seasons_is_not_deduplicated(self) -> None:
        spf = [
            spf_row(3, 300, "曼彻斯特联", "曼彻斯特城", 2),
            spf_row(2, 200, "曼彻斯特联", "曼彻斯特城", 4),
            spf_row(1, 100, "曼彻斯特联", "曼彻斯特城", 1),
        ]
        goals = [
            goal_row(30, 30, "曼联", "曼城", 2),
            goal_row(20, 20, "曼联", "曼城", 4),
            goal_row(10, 10, "曼联", "曼城", 1),
        ]

        pairs = align_reverse_order(spf, goals)

        self.assertEqual(
            [(left["id"], right["id"]) for left, right, _ in pairs],
            [(3, 30), (2, 20), (1, 10)],
        )
        self.assertTrue(all(quality["goals_same"] for _, _, quality in pairs))

    def test_ambiguous_repeated_fixture_prefers_newest_rows(self) -> None:
        spf = [
            spf_row(3, 300, "曼联", "曼城", 2),
            spf_row(2, 200, "曼联", "曼城", 2),
            spf_row(1, 100, "曼联", "曼城", 2),
        ]
        goals = [
            goal_row(30, 30, "曼联", "曼城", 2),
            goal_row(20, 20, "曼联", "曼城", 2),
        ]

        pairs = align_reverse_order(spf, goals)

        self.assertEqual(
            [(left["id"], right["id"]) for left, right, _ in pairs],
            [(3, 30), (2, 20)],
        )

    def test_goal_difference_is_retained_as_a_conflict_candidate(self) -> None:
        left = spf_row(1, 100, "曼联", "曼城", 2)
        right = goal_row(10, 10, "曼联", "曼城", 3)

        quality = pair_quality(left, right)

        self.assertTrue(quality["eligible"])
        self.assertTrue(quality["goals_comparable"])
        self.assertFalse(quality["goals_same"])

    def test_zero_goals_is_a_valid_comparable_value(self) -> None:
        left = spf_row(1, 100, "曼联", "曼城", 0)
        right = goal_row(10, 10, "曼联", "曼城", 0)

        quality = pair_quality(left, right)

        self.assertTrue(quality["goals_comparable"])
        self.assertTrue(quality["goals_same"])


if __name__ == "__main__":
    unittest.main()
