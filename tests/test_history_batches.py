import sqlite3
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from import_sqlite import (initialize_database, import_historical_spf,
                           import_historical_hhad, import_historical_goals)
from unify_history import rebuild_historical_matches


def fixture(home="甲", row=2):
    return dict(source="终赔", sourceFile="history.xlsx", sourceRow=row,
                league="测试", home=home, away="乙", score="2:1", result="胜",
                handicap=0, totalGoals=3, odds=[2., 3., 4.])


class HistoryBatchTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        initialize_database(self.db)

    def tearDown(self):
        self.db.close()

    def test_reimport_and_shift_preserve_first_identity_and_batch(self):
        import_historical_spf(self.db, [fixture("甲", 2), fixture("丙", 3)], "2026-09-20")
        before = self.db.execute("SELECT * FROM historical_spf ORDER BY id").fetchall()
        self.assertEqual(import_historical_spf(self.db, [fixture("丙", 2)], "2026-09-21"), 0)
        self.assertEqual(before, self.db.execute("SELECT * FROM historical_spf ORDER BY id").fetchall())
        self.assertEqual(import_historical_spf(self.db, [fixture("丁", 2)], "2026-09-21"), 1)
        rebuild_historical_matches(self.db)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM historical_matches").fetchone()[0], 3)
        rows = self.db.execute("SELECT history_batch_id FROM historical_spf ORDER BY id").fetchall()
        self.assertEqual(rows[0], rows[1])
        self.assertGreater(rows[2][0], rows[1][0])

    def test_batch_pairing_does_not_depend_on_sheet_row(self):
        import_historical_spf(self.db, [fixture()], "2026-09-20")
        import_historical_hhad(self.db, [{**fixture(row=8), "handicap": -1, "result": "平"}], "2026-09-20")
        import_historical_goals(self.db, [{**fixture(row=20), "goals": "3", "odds": [3.] * 8}], "2026-09-20")
        rebuild_historical_matches(self.db)
        self.assertEqual([tuple(r) for r in self.db.execute("SELECT spf_id, hhad_id, goals_id, match_status FROM historical_matches")], [(1, 1, 1, "matched")])

    def test_different_batch_same_row_cannot_pair(self):
        import_historical_spf(self.db, [fixture()], "2026-09-20")
        import_historical_hhad(self.db, [{**fixture(), "handicap": -1, "result": "平"}], "2026-09-21")
        rebuild_historical_matches(self.db)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM historical_matches WHERE spf_id IS NOT NULL AND hhad_id IS NOT NULL").fetchone()[0], 0)

    def test_migration_orders_existing_batches_and_keeps_legacy(self):
        import_historical_spf(self.db, [fixture("新")], "2026-09-21")
        import_historical_spf(self.db, [fixture("旧")], "2026-09-20")
        import_historical_spf(self.db, [{**fixture("存量"), "sourceFile": "lsspfpl.xlsx"}], "2026-09-19")
        self.db.execute("UPDATE historical_spf SET history_batch_id = 0")
        self.db.execute("DELETE FROM history_import_batches")
        self.db.execute("PRAGMA user_version = 6")
        self.db.commit()
        initialize_database(self.db)
        rows = dict(self.db.execute("SELECT home_team, history_batch_id FROM historical_spf"))
        self.assertEqual(rows["存量"], 0)
        self.assertGreater(rows["新"], rows["旧"])
        before = self.db.execute("SELECT * FROM historical_spf").fetchall()
        self.db.commit()
        initialize_database(self.db)
        self.assertEqual(before, self.db.execute("SELECT * FROM historical_spf").fetchall())
