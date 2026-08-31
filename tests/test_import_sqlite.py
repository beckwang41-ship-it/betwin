from __future__ import annotations

import io
import json
import sqlite3
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import import_sqlite  # noqa: E402
from import_sqlite import (  # noqa: E402
    SCHEMA,
    import_historical_goals,
    import_historical_hhad,
    import_historical_spf,
    import_live_json,
)


class JsonOnlyImportTests(unittest.TestCase):
    def test_json_only_does_not_read_or_rebuild_historical_data(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database_path = root / "test.db"
            json_files = [
                root / "realtime_matches_had_hhad_history.json",
                root / "realtime_matches_history.json",
                root / "match_data1.json",
            ]
            payloads = [
                [
                    {
                        "match_id": 9001,
                        "display_name": "测试联赛: JSON主队 vs JSON客队",
                        "league": "测试联赛",
                        "odds": {"had": {"h": 2.1, "d": 3.2, "a": 3.4}},
                    }
                ],
                [],
                [],
            ]
            for path, payload in zip(json_files, payloads, strict=True):
                path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

            with sqlite3.connect(database_path) as connection:
                connection.executescript(SCHEMA)
                import_historical_spf(
                    connection,
                    [{
                        "source": "最终赔率",
                        "sourceFile": "history.xlsx",
                        "sourceRow": 2,
                        "initialSourceFile": None,
                        "initialSourceRow": None,
                        "league": "历史联赛",
                        "home": "历史主队",
                        "away": "历史客队",
                        "score": "1:0",
                        "result": "胜",
                        "handicap": 0,
                        "totalGoals": 1,
                        "initialOdds": [2.0, 3.0, 4.0],
                        "odds": [2.1, 3.1, 4.1],
                    }],
                )
                connection.execute(
                    """
                    INSERT INTO source_files
                        (file_name, file_type, sha256, file_size, record_count, imported_at)
                    VALUES ('history.xlsx', 'xlsx', 'before', 1, 1, '2026-01-01T00:00:00+00:00')
                    """
                )
                before_history = connection.execute(
                    "SELECT league, home_team, away_team, result FROM historical_spf"
                ).fetchall()

            fail_if_called = AssertionError("JSON模式不应读取Excel历史")
            with (
                patch.object(import_sqlite, "DATABASE_PATH", database_path),
                patch.object(import_sqlite, "JSON_FILES", json_files),
                patch.object(import_sqlite, "EXCEL_FILES", [root / "missing.xlsx"]),
                patch.object(import_sqlite, "build_spf_history", side_effect=fail_if_called),
                patch.object(import_sqlite, "build_hhad_history", side_effect=fail_if_called),
                patch.object(import_sqlite, "build_goal_history", side_effect=fail_if_called),
                redirect_stdout(io.StringIO()),
            ):
                import_sqlite.main(["--json-only"])

            with sqlite3.connect(database_path) as connection:
                self.assertEqual(
                    connection.execute(
                        "SELECT league, home_team, away_team, result FROM historical_spf"
                    ).fetchall(),
                    before_history,
                )
                self.assertEqual(
                    connection.execute(
                        "SELECT imported_at FROM source_files WHERE file_name = 'history.xlsx'"
                    ).fetchone()[0],
                    "2026-01-01T00:00:00+00:00",
                )
                self.assertEqual(
                    connection.execute(
                        "SELECT display_name, active FROM current_matches WHERE match_id = 9001"
                    ).fetchone(),
                    ("测试联赛: JSON主队 vs JSON客队", 1),
                )
                self.assertEqual(
                    connection.execute(
                        "SELECT COUNT(*) FROM raw_json_documents"
                    ).fetchone()[0],
                    3,
                )


class LiveTeamNameImportTests(unittest.TestCase):
    def test_realtime_display_name_has_priority_over_detail_team_names(self) -> None:
        connection = sqlite3.connect(":memory:")
        try:
            connection.executescript(SCHEMA)
            import_live_json(
                connection,
                [
                    {
                        "match_id": 1,
                        "display_name": "测试联赛: 实时主队 vs 实时客队",
                        "league": "测试联赛",
                    }
                ],
                [],
                [
                    {
                        "matchId": 1,
                        "league": "测试联赛",
                        "homeTeam": "详情主队",
                        "awayTeam": "详情客队",
                    }
                ],
                "2026-08-07T00:00:00+00:00",
            )
            row = connection.execute(
                "SELECT display_name, home_team, away_team FROM current_matches"
            ).fetchone()
            self.assertEqual(
                row,
                ("测试联赛: 实时主队 vs 实时客队", "实时主队", "实时客队"),
            )
        finally:
            connection.close()

    def test_detail_batch_deactivates_stale_realtime_matches(self) -> None:
        connection = sqlite3.connect(":memory:")
        try:
            connection.executescript(SCHEMA)
            realtime = [
                {
                    "match_id": 1,
                    "display_name": "测试联赛: 已完场主队 vs 已完场客队",
                    "league": "测试联赛",
                },
                {
                    "match_id": 2,
                    "display_name": "测试联赛: 当前主队 vs 当前客队",
                    "league": "测试联赛",
                },
            ]
            import_live_json(
                connection,
                realtime,
                [],
                [],
                "2026-08-19T00:00:00+00:00",
            )
            import_live_json(
                connection,
                realtime,
                [],
                [
                    {
                        "matchId": 2,
                        "league": "测试联赛",
                        "homeTeam": "当前主队",
                        "awayTeam": "当前客队",
                    },
                    {
                        "matchId": 3,
                        "league": "测试联赛",
                        "homeTeam": "仅详情主队",
                        "awayTeam": "仅详情客队",
                    },
                ],
                "2026-08-20T00:00:00+00:00",
            )

            self.assertEqual(
                connection.execute(
                    "SELECT match_id, active FROM current_matches ORDER BY match_id"
                ).fetchall(),
                [(1, 0), (2, 1)],
            )
        finally:
            connection.close()

    def test_disjoint_detail_batch_does_not_deactivate_current_matches(self) -> None:
        connection = sqlite3.connect(":memory:")
        try:
            connection.executescript(SCHEMA)
            import_live_json(
                connection,
                [
                    {
                        "match_id": 1,
                        "display_name": "测试联赛: 原主队 vs 原客队",
                        "league": "测试联赛",
                    }
                ],
                [],
                [],
                "2026-08-19T00:00:00+00:00",
            )

            with self.assertRaisesRegex(ValueError, "没有共同比赛"):
                import_live_json(
                    connection,
                    [
                        {
                            "match_id": 2,
                            "display_name": "测试联赛: 新主队 vs 新客队",
                            "league": "测试联赛",
                        }
                    ],
                    [],
                    [
                        {
                            "matchId": 3,
                            "league": "测试联赛",
                            "homeTeam": "另一主队",
                            "awayTeam": "另一客队",
                        }
                    ],
                    "2026-08-20T00:00:00+00:00",
                )

            self.assertEqual(
                connection.execute(
                    "SELECT match_id, active FROM current_matches ORDER BY match_id"
                ).fetchall(),
                [(1, 1)],
            )
        finally:
            connection.close()


class HistoricalSourceRowUpdateTests(unittest.TestCase):
    def test_reused_source_row_replaces_the_complete_historical_record(self) -> None:
        connection = sqlite3.connect(":memory:")
        try:
            connection.executescript(SCHEMA)
            common = {
                "source": "最终赔率",
                "sourceFile": "history.xlsx",
                "sourceRow": 10,
                "initialSourceFile": "initial.xlsx",
                "initialSourceRow": 10,
            }
            import_historical_spf(
                connection,
                [{
                    **common,
                    "league": "旧联赛",
                    "home": "旧主队",
                    "away": "旧客队",
                    "score": "0:0",
                    "result": "平",
                    "handicap": 0,
                    "totalGoals": 0,
                    "initialOdds": [2.0, 3.0, 4.0],
                    "odds": [2.1, 3.1, 4.1],
                }],
            )
            import_historical_spf(
                connection,
                [{
                    **common,
                    "league": "欧罗巴",
                    "home": "比亚韦斯托克",
                    "away": "格拉斯哥流浪者",
                    "score": "2:1",
                    "result": "胜",
                    "handicap": 0,
                    "totalGoals": 3,
                    "initialOdds": [2.65, 3.15, 2.3],
                    "odds": [2.88, 3.15, 2.15],
                }],
            )
            import_historical_hhad(
                connection,
                [{
                    **common,
                    "league": "旧联赛",
                    "home": "旧主队",
                    "away": "旧客队",
                    "score": "0:0",
                    "handicap": -1,
                    "result": "负",
                    "initialOdds": [2.0, 3.0, 4.0],
                    "odds": [2.1, 3.1, 4.1],
                }],
            )
            import_historical_hhad(
                connection,
                [{
                    **common,
                    "league": "欧罗巴",
                    "home": "比亚韦斯托克",
                    "away": "格拉斯哥流浪者",
                    "score": "2:1",
                    "handicap": 1,
                    "result": "胜",
                    "initialOdds": [1.47, 3.95, 5.1],
                    "odds": [1.52, 3.8, 4.8],
                }],
            )
            import_historical_goals(
                connection,
                [{
                    **common,
                    "league": "旧联赛",
                    "home": "旧主队",
                    "away": "旧客队",
                    "goals": "0",
                    "initialOdds": [2.0] * 8,
                    "odds": [2.1] * 8,
                }],
            )
            import_historical_goals(
                connection,
                [{
                    **common,
                    "league": "欧罗巴",
                    "home": "比亚韦",
                    "away": "流浪者",
                    "goals": "3",
                    "initialOdds": [13, 5.2, 3.6, 3.6, 5.4, 9.7, 19, 28],
                    "odds": [12, 5, 3.1, 3.4, 6.2, 12, 27, 44],
                }],
            )

            self.assertEqual(
                connection.execute(
                    "SELECT league, home_team, away_team, score, result, "
                    "total_goals, final_home_odds FROM historical_spf"
                ).fetchone(),
                ("欧罗巴", "比亚韦斯托克", "格拉斯哥流浪者", "2:1", "胜", 3, 2.88),
            )
            self.assertEqual(
                connection.execute(
                    "SELECT league, home_team, away_team, score, handicap, "
                    "result, final_home_odds FROM historical_hhad"
                ).fetchone(),
                ("欧罗巴", "比亚韦斯托克", "格拉斯哥流浪者", "2:1", 1, "胜", 1.52),
            )
            self.assertEqual(
                connection.execute(
                    "SELECT league, home_team, away_team, actual_goals, "
                    "final_g0 FROM historical_goals"
                ).fetchone(),
                ("欧罗巴", "比亚韦", "流浪者", "3", 12.0),
            )
        finally:
            connection.close()


if __name__ == "__main__":
    unittest.main()
