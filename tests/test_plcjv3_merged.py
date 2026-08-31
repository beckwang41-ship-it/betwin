import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import call, patch

import plcjv3_merged as collector


class Plcjv3MergedTests(unittest.TestCase):
    def test_resolve_match_ids_preserves_json_order_and_deduplicates(self):
        source_rows = [
            {"matchId": 2040960},
            {"matchId": 2040970},
            {"matchId": 2040969},
            {"matchId": 2040970},
        ]

        with tempfile.TemporaryDirectory() as temp_dir:
            source_path = Path(temp_dir) / "match_data1.json"
            source_path.write_text(
                json.dumps(source_rows, ensure_ascii=False),
                encoding="utf-8",
            )

            match_ids, source_name = collector.resolve_match_ids(temp_dir)

        self.assertEqual(match_ids, [2040960, 2040970, 2040969])
        self.assertEqual(source_name, "match_data1.json")

    def test_main_fetches_each_explicit_match_id_instead_of_a_numeric_range(self):
        match_ids = [2040960, 2040970, 2040969]
        odds_history = {
            "leagueAbbName": "测试",
            "homeTeamAbbName": "主队",
            "awayTeamAbbName": "客队",
        }

        with (
            patch.object(collector, "fetch_odds_history", return_value=odds_history) as fetch_mock,
            patch.object(collector, "build_ttg_match_data", return_value=None),
            patch.object(collector, "build_had_hhad_match_data", return_value=None),
            patch.object(collector.time, "sleep"),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            collector.main(match_ids=match_ids, id_source_file="test.json")

        self.assertEqual(fetch_mock.call_args_list, [call(mid) for mid in match_ids])


if __name__ == "__main__":
    unittest.main()
