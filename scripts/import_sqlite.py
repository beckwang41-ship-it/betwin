from __future__ import annotations

import hashlib
import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import pandas as pd

from prepare_data import build_goal_history, build_hhad_history, build_spf_history
from unify_history import rebuild_historical_matches


ROOT = Path(__file__).resolve().parents[1]
DATABASE_PATH = Path(os.environ.get("BETWIN_DATABASE_PATH", ROOT / "betwin.db"))
EXCEL_FILES = [
    ROOT / "initspfpl.xlsx",
    ROOT / "lsspfpl.xlsx",
    ROOT / "lottery_goals_data_df1cda93.xlsx",
    ROOT / "历史进球数.xlsx",
]
JSON_FILES = [
    ROOT / "realtime_matches_had_hhad_history.json",
    ROOT / "realtime_matches_history.json",
    ROOT / "match_data1.json",
]


SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS source_files (
    file_name TEXT PRIMARY KEY,
    file_type TEXT NOT NULL CHECK (file_type IN ('xlsx', 'json')),
    sha256 TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    record_count INTEGER NOT NULL,
    imported_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS raw_json_documents (
    file_name TEXT PRIMARY KEY REFERENCES source_files(file_name) ON DELETE CASCADE,
    payload_json TEXT NOT NULL,
    imported_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS historical_spf (
    id INTEGER PRIMARY KEY,
    fingerprint TEXT NOT NULL UNIQUE,
    league TEXT NOT NULL,
    home_team TEXT NOT NULL,
    away_team TEXT NOT NULL,
    score TEXT,
    result TEXT NOT NULL CHECK (result IN ('胜', '平', '负')),
    handicap INTEGER NOT NULL DEFAULT 0,
    total_goals INTEGER,
    initial_home_odds REAL,
    initial_draw_odds REAL,
    initial_away_odds REAL,
    final_home_odds REAL NOT NULL CHECK (final_home_odds > 1),
    final_draw_odds REAL NOT NULL CHECK (final_draw_odds > 1),
    final_away_odds REAL NOT NULL CHECK (final_away_odds > 1),
    source_name TEXT NOT NULL,
    source_file TEXT NOT NULL,
    source_row INTEGER NOT NULL CHECK (source_row > 0),
    initial_source_file TEXT,
    initial_source_row INTEGER
);

CREATE TABLE IF NOT EXISTS historical_goals (
    id INTEGER PRIMARY KEY,
    fingerprint TEXT NOT NULL UNIQUE,
    league TEXT NOT NULL,
    home_team TEXT NOT NULL,
    away_team TEXT NOT NULL,
    actual_goals TEXT NOT NULL CHECK (actual_goals IN ('0','1','2','3','4','5','6','7+')),
    initial_g0 REAL,
    initial_g1 REAL,
    initial_g2 REAL,
    initial_g3 REAL,
    initial_g4 REAL,
    initial_g5 REAL,
    initial_g6 REAL,
    initial_g7plus REAL,
    final_g0 REAL NOT NULL CHECK (final_g0 > 1),
    final_g1 REAL NOT NULL CHECK (final_g1 > 1),
    final_g2 REAL NOT NULL CHECK (final_g2 > 1),
    final_g3 REAL NOT NULL CHECK (final_g3 > 1),
    final_g4 REAL NOT NULL CHECK (final_g4 > 1),
    final_g5 REAL NOT NULL CHECK (final_g5 > 1),
    final_g6 REAL NOT NULL CHECK (final_g6 > 1),
    final_g7plus REAL NOT NULL CHECK (final_g7plus > 1),
    source_name TEXT NOT NULL,
    source_file TEXT NOT NULL,
    source_row INTEGER NOT NULL CHECK (source_row > 0),
    initial_source_file TEXT,
    initial_source_row INTEGER
);

CREATE TABLE IF NOT EXISTS historical_hhad (
    id INTEGER PRIMARY KEY,
    fingerprint TEXT NOT NULL UNIQUE,
    league TEXT NOT NULL,
    home_team TEXT NOT NULL,
    away_team TEXT NOT NULL,
    score TEXT,
    handicap INTEGER NOT NULL,
    result TEXT NOT NULL CHECK (result IN ('胜', '平', '负')),
    initial_home_odds REAL,
    initial_draw_odds REAL,
    initial_away_odds REAL,
    final_home_odds REAL NOT NULL CHECK (final_home_odds > 1),
    final_draw_odds REAL NOT NULL CHECK (final_draw_odds > 1),
    final_away_odds REAL NOT NULL CHECK (final_away_odds > 1),
    source_name TEXT NOT NULL,
    source_file TEXT NOT NULL,
    source_row INTEGER NOT NULL CHECK (source_row > 0),
    initial_source_file TEXT,
    initial_source_row INTEGER
);

CREATE TABLE IF NOT EXISTS historical_matches (
    id INTEGER PRIMARY KEY,
    match_key TEXT NOT NULL UNIQUE,
    league TEXT NOT NULL,
    home_team TEXT NOT NULL,
    away_team TEXT NOT NULL,
    score TEXT,
    result TEXT CHECK (result IN ('胜', '平', '负') OR result IS NULL),
    handicap INTEGER,
    total_goals INTEGER,
    actual_goal_label TEXT CHECK (
        actual_goal_label IN ('0','1','2','3','4','5','6','7+')
        OR actual_goal_label IS NULL
    ),
    spf_id INTEGER UNIQUE REFERENCES historical_spf(id) ON DELETE CASCADE,
    hhad_id INTEGER UNIQUE REFERENCES historical_hhad(id) ON DELETE CASCADE,
    goals_id INTEGER UNIQUE REFERENCES historical_goals(id) ON DELETE CASCADE,
    spf_source_file TEXT,
    spf_source_row INTEGER,
    hhad_source_file TEXT,
    hhad_source_row INTEGER,
    goals_source_file TEXT,
    goals_source_row INTEGER,
    fixture_occurrence_from_latest INTEGER CHECK (
        fixture_occurrence_from_latest > 0
        OR fixture_occurrence_from_latest IS NULL
    ),
    goal_fixture_occurrence_from_latest INTEGER CHECK (
        goal_fixture_occurrence_from_latest > 0
        OR goal_fixture_occurrence_from_latest IS NULL
    ),
    match_status TEXT NOT NULL CHECK (
        match_status IN (
            'matched',
            'matched_unverified',
            'conflict',
            'spf_hhad_only',
            'hhad_only',
            'goals_only'
        )
    ),
    match_method TEXT NOT NULL,
    match_confidence REAL CHECK (
        match_confidence BETWEEN 0 AND 1
        OR match_confidence IS NULL
    ),
    goal_consistent INTEGER CHECK (
        goal_consistent IN (0, 1)
        OR goal_consistent IS NULL
    ),
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS current_matches (
    match_id INTEGER PRIMARY KEY,
    display_name TEXT NOT NULL,
    league TEXT NOT NULL,
    home_team TEXT NOT NULL,
    away_team TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE TABLE IF NOT EXISTS spf_odds_snapshots (
    id INTEGER PRIMARY KEY,
    match_id INTEGER NOT NULL REFERENCES current_matches(match_id) ON DELETE CASCADE,
    market TEXT NOT NULL CHECK (market IN ('had', 'hhad')),
    goal_line TEXT NOT NULL DEFAULT '',
    captured_at TEXT NOT NULL DEFAULT '',
    home_odds REAL NOT NULL CHECK (home_odds > 1),
    draw_odds REAL NOT NULL CHECK (draw_odds > 1),
    away_odds REAL NOT NULL CHECK (away_odds > 1),
    source_name TEXT NOT NULL,
    UNIQUE (match_id, market, goal_line, captured_at, home_odds, draw_odds, away_odds)
);

CREATE TABLE IF NOT EXISTS goal_odds_snapshots (
    id INTEGER PRIMARY KEY,
    match_id INTEGER NOT NULL REFERENCES current_matches(match_id) ON DELETE CASCADE,
    captured_at TEXT NOT NULL DEFAULT '',
    g0 REAL NOT NULL CHECK (g0 > 1),
    g1 REAL NOT NULL CHECK (g1 > 1),
    g2 REAL NOT NULL CHECK (g2 > 1),
    g3 REAL NOT NULL CHECK (g3 > 1),
    g4 REAL NOT NULL CHECK (g4 > 1),
    g5 REAL NOT NULL CHECK (g5 > 1),
    g6 REAL NOT NULL CHECK (g6 > 1),
    g7plus REAL NOT NULL CHECK (g7plus > 1),
    source_name TEXT NOT NULL,
    UNIQUE (match_id, captured_at, g0, g1, g2, g3, g4, g5, g6, g7plus)
);

CREATE TABLE IF NOT EXISTS team_match_history (
    id INTEGER PRIMARY KEY,
    fingerprint TEXT NOT NULL UNIQUE,
    current_match_id INTEGER NOT NULL REFERENCES current_matches(match_id) ON DELETE CASCADE,
    perspective TEXT NOT NULL CHECK (perspective IN ('head_to_head', 'home_form', 'away_form')),
    match_date TEXT,
    league TEXT,
    home_team TEXT NOT NULL,
    away_team TEXT NOT NULL,
    score TEXT,
    half_score TEXT,
    source_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS predictions (
    id INTEGER PRIMARY KEY,
    match_id INTEGER NOT NULL REFERENCES current_matches(match_id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    model_version TEXT NOT NULL,
    home_probability REAL NOT NULL CHECK (home_probability BETWEEN 0 AND 1),
    draw_probability REAL NOT NULL CHECK (draw_probability BETWEEN 0 AND 1),
    away_probability REAL NOT NULL CHECK (away_probability BETWEEN 0 AND 1),
    goal_probabilities_json TEXT,
    predicted_result TEXT NOT NULL CHECK (predicted_result IN ('胜', '平', '负')),
    settings_json TEXT,
    UNIQUE (match_id, created_at, model_version)
);

CREATE TABLE IF NOT EXISTS prediction_ledger (
    id INTEGER PRIMARY KEY,
    match_id TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    market TEXT NOT NULL CHECK (market IN ('spf', 'hhad', 'goals')),
    handicap INTEGER,
    captured_at TEXT NOT NULL,
    source_updated_at TEXT,
    history_source_file TEXT NOT NULL,
    history_row_watermark INTEGER NOT NULL,
    league TEXT NOT NULL,
    home_team TEXT NOT NULL,
    away_team TEXT NOT NULL,
    display_name TEXT NOT NULL,
    predicted TEXT NOT NULL,
    top_labels_json TEXT NOT NULL,
    selected_probability REAL NOT NULL,
    selected_odds REAL NOT NULL,
    probabilities_json TEXT NOT NULL,
    odds_json TEXT NOT NULL,
    reliability_level TEXT NOT NULL CHECK (
        reliability_level IN ('recommended', 'cautious', 'skip')
    ),
    reliability_label TEXT NOT NULL,
    reliability_reason TEXT NOT NULL,
    threshold REAL NOT NULL,
    samples INTEGER NOT NULL,
    settings_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'settled')
    ),
    actual_result TEXT,
    score TEXT,
    correct INTEGER CHECK (correct IN (0, 1) OR correct IS NULL),
    simulated_return REAL,
    simulated_profit REAL,
  settled_source_file TEXT,
  settled_source_row INTEGER,
  settled_at TEXT,
  valid INTEGER NOT NULL DEFAULT 1 CHECK (valid IN (0, 1)),
  invalid_reason TEXT,
  UNIQUE (match_id, market, policy_version)
);

CREATE TABLE IF NOT EXISTS parlay_ledger (
  id INTEGER PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  combination_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('standard', 'goalsPair')),
  selection_source TEXT NOT NULL CHECK (
    selection_source IN ('system_default', 'user_saved')
  ),
  policy_version TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  source_updated_at TEXT,
  history_source_file TEXT NOT NULL,
  history_row_watermark INTEGER NOT NULL,
  legs_json TEXT NOT NULL,
  settings_json TEXT NOT NULL,
  total_stake REAL NOT NULL,
  hit_probability REAL NOT NULL,
  value_index REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'settled')
  ),
  correct INTEGER CHECK (correct IN (0, 1) OR correct IS NULL),
  simulated_return REAL,
  simulated_profit REAL,
  actual_results_json TEXT,
  settled_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_historical_spf_league
    ON historical_spf (league);
CREATE INDEX IF NOT EXISTS idx_historical_spf_odds
    ON historical_spf (final_home_odds, final_draw_odds, final_away_odds);
CREATE INDEX IF NOT EXISTS idx_historical_spf_result
    ON historical_spf (result);
CREATE INDEX IF NOT EXISTS idx_historical_goals_league
    ON historical_goals (league);
CREATE INDEX IF NOT EXISTS idx_historical_goals_actual
    ON historical_goals (actual_goals);
CREATE INDEX IF NOT EXISTS idx_historical_hhad_league_handicap
    ON historical_hhad (league, handicap);
CREATE INDEX IF NOT EXISTS idx_historical_hhad_odds
    ON historical_hhad (handicap, final_home_odds, final_draw_odds, final_away_odds);
CREATE INDEX IF NOT EXISTS idx_historical_hhad_result
    ON historical_hhad (result);
CREATE INDEX IF NOT EXISTS idx_historical_matches_status
    ON historical_matches (match_status);
CREATE INDEX IF NOT EXISTS idx_historical_matches_fixture
    ON historical_matches (
        league,
        home_team,
        away_team,
        fixture_occurrence_from_latest
    );
CREATE INDEX IF NOT EXISTS idx_historical_matches_spf_source
    ON historical_matches (spf_source_file, spf_source_row);
CREATE INDEX IF NOT EXISTS idx_parlay_ledger_status
    ON parlay_ledger (status, captured_at);
CREATE INDEX IF NOT EXISTS idx_parlay_ledger_mode
    ON parlay_ledger (mode, selection_source, status);
CREATE INDEX IF NOT EXISTS idx_historical_matches_goals_source
    ON historical_matches (goals_source_file, goals_source_row);
CREATE INDEX IF NOT EXISTS idx_spf_snapshots_match_time
    ON spf_odds_snapshots (match_id, market, captured_at);
CREATE INDEX IF NOT EXISTS idx_goal_snapshots_match_time
    ON goal_odds_snapshots (match_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_team_history_match
    ON team_match_history (current_match_id, perspective, match_date);

CREATE VIEW IF NOT EXISTS latest_had_odds AS
SELECT *
FROM (
    SELECT s.*,
           ROW_NUMBER() OVER (
               PARTITION BY s.match_id
               ORDER BY s.captured_at DESC, s.id DESC
           ) AS row_number
    FROM spf_odds_snapshots s
    WHERE s.market = 'had'
)
WHERE row_number = 1;

CREATE VIEW IF NOT EXISTS latest_goal_odds AS
SELECT *
FROM (
    SELECT g.*,
           ROW_NUMBER() OVER (
               PARTITION BY g.match_id
               ORDER BY g.captured_at DESC, g.id DESC
           ) AS row_number
    FROM goal_odds_snapshots g
)
WHERE row_number = 1;
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fingerprint(*values: Any) -> str:
    payload = json.dumps(values, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def as_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number


def valid_three_way(point: dict[str, Any]) -> bool:
    return all(as_float(point.get(key)) and float(point[key]) > 1 for key in ("h", "d", "a"))


def valid_goals(point: dict[str, Any]) -> bool:
    keys = ("g0", "g1", "g2", "g3", "g4", "g5", "g6", "g7plus")
    return all(as_float(point.get(key)) and float(point[key]) > 1 for key in keys)


def ensure_column(
    connection: sqlite3.Connection,
    table: str,
    column: str,
    definition: str,
) -> None:
    columns = {
        row[1]
        for row in connection.execute(f"PRAGMA table_info({table})").fetchall()
    }
    if column not in columns:
        connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def migrate_source_order_columns(connection: sqlite3.Connection) -> None:
    for table in ("historical_spf", "historical_goals", "historical_hhad"):
        ensure_column(connection, table, "source_file", "TEXT NOT NULL DEFAULT ''")
        ensure_column(connection, table, "source_row", "INTEGER NOT NULL DEFAULT 0")
        ensure_column(connection, table, "initial_source_file", "TEXT")
        ensure_column(connection, table, "initial_source_row", "INTEGER")
        connection.execute(
            f"""
            CREATE INDEX IF NOT EXISTS idx_{table}_source_order
            ON {table} (source_file, source_row)
            """
        )


def migrate_source_identity_fingerprints(
    connection: sqlite3.Connection,
) -> None:
    current_version = connection.execute("PRAGMA user_version").fetchone()[0]
    for table in ("historical_spf", "historical_hhad", "historical_goals"):
        if current_version < 5:
            rows = connection.execute(
                f"SELECT id, source_file, source_row FROM {table}"
            ).fetchall()
            connection.executemany(
                f"UPDATE {table} SET fingerprint = ? WHERE id = ?",
                [
                    (
                        fingerprint(table, source_file, int(source_row)),
                        int(row_id),
                    )
                    for row_id, source_file, source_row in rows
                ],
            )
        connection.execute(
            f"""
            CREATE UNIQUE INDEX IF NOT EXISTS idx_{table}_source_identity
            ON {table} (source_file, source_row)
            """
        )


def initialize_database(connection: sqlite3.Connection) -> None:
    connection.execute("PRAGMA journal_mode = WAL")
    connection.execute("PRAGMA synchronous = NORMAL")
    connection.executescript(SCHEMA)
    migrate_source_order_columns(connection)
    migrate_source_identity_fingerprints(connection)
    ensure_column(
        connection,
        "current_matches",
        "active",
        "INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))",
    )
    connection.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_current_matches_active
        ON current_matches (active, match_id)
        """
    )
    connection.execute("PRAGMA user_version = 6")


def upsert_source_file(
    connection: sqlite3.Connection,
    path: Path,
    file_type: str,
    record_count: int,
    imported_at: str,
) -> None:
    connection.execute(
        """
        INSERT INTO source_files
            (file_name, file_type, sha256, file_size, record_count, imported_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(file_name) DO UPDATE SET
            file_type = excluded.file_type,
            sha256 = excluded.sha256,
            file_size = excluded.file_size,
            record_count = excluded.record_count,
            imported_at = CASE
                WHEN source_files.sha256 <> excluded.sha256
                  OR source_files.file_size <> excluded.file_size
                  OR source_files.record_count <> excluded.record_count
                THEN excluded.imported_at
                ELSE source_files.imported_at
            END
        """,
        (
            path.name,
            file_type,
            file_sha256(path),
            path.stat().st_size,
            record_count,
            imported_at,
        ),
    )


def import_historical_spf(
    connection: sqlite3.Connection,
    records: Iterable[dict[str, Any]],
) -> int:
    before = connection.execute("SELECT COUNT(*) FROM historical_spf").fetchone()[0]
    for row in records:
        initial = row.get("initialOdds") or [None, None, None]
        final = row["odds"]
        key = fingerprint(
            "historical_spf",
            row["sourceFile"],
            int(row["sourceRow"]),
        )
        connection.execute(
            """
            INSERT OR IGNORE INTO historical_spf (
                fingerprint, league, home_team, away_team, score, result,
                handicap, total_goals,
                initial_home_odds, initial_draw_odds, initial_away_odds,
                final_home_odds, final_draw_odds, final_away_odds, source_name,
                source_file, source_row, initial_source_file, initial_source_row
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(fingerprint) DO UPDATE SET
                initial_home_odds = excluded.initial_home_odds,
                initial_draw_odds = excluded.initial_draw_odds,
                initial_away_odds = excluded.initial_away_odds,
                source_name = excluded.source_name,
                source_file = excluded.source_file,
                source_row = excluded.source_row,
                initial_source_file = excluded.initial_source_file,
                initial_source_row = excluded.initial_source_row
            """,
            (
                key,
                row["league"],
                row["home"],
                row["away"],
                row["score"] or None,
                row["result"],
                row["handicap"],
                row.get("totalGoals"),
                *initial,
                *final,
                row["source"],
                row["sourceFile"],
                row["sourceRow"],
                row.get("initialSourceFile"),
                row.get("initialSourceRow"),
            ),
        )
    after = connection.execute("SELECT COUNT(*) FROM historical_spf").fetchone()[0]
    return after - before


def import_historical_hhad(
    connection: sqlite3.Connection,
    records: Iterable[dict[str, Any]],
) -> int:
    before = connection.execute("SELECT COUNT(*) FROM historical_hhad").fetchone()[0]
    for row in records:
        initial = row.get("initialOdds") or [None, None, None]
        final = row["odds"]
        key = fingerprint(
            "historical_hhad",
            row["sourceFile"],
            int(row["sourceRow"]),
        )
        connection.execute(
            """
            INSERT INTO historical_hhad (
                fingerprint, league, home_team, away_team, score,
                handicap, result,
                initial_home_odds, initial_draw_odds, initial_away_odds,
                final_home_odds, final_draw_odds, final_away_odds, source_name,
                source_file, source_row, initial_source_file, initial_source_row
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(fingerprint) DO UPDATE SET
                initial_home_odds = excluded.initial_home_odds,
                initial_draw_odds = excluded.initial_draw_odds,
                initial_away_odds = excluded.initial_away_odds,
                source_name = excluded.source_name,
                source_file = excluded.source_file,
                source_row = excluded.source_row,
                initial_source_file = excluded.initial_source_file,
                initial_source_row = excluded.initial_source_row
            """,
            (
                key,
                row["league"],
                row["home"],
                row["away"],
                row["score"] or None,
                row["handicap"],
                row["result"],
                *initial,
                *final,
                row["source"],
                row["sourceFile"],
                row["sourceRow"],
                row.get("initialSourceFile"),
                row.get("initialSourceRow"),
            ),
        )
    after = connection.execute("SELECT COUNT(*) FROM historical_hhad").fetchone()[0]
    return after - before


def import_historical_goals(
    connection: sqlite3.Connection,
    records: Iterable[dict[str, Any]],
) -> int:
    before = connection.execute("SELECT COUNT(*) FROM historical_goals").fetchone()[0]
    for row in records:
        initial = row.get("initialOdds") or [None] * 8
        final = row["odds"]
        key = fingerprint(
            "historical_goals",
            row["sourceFile"],
            int(row["sourceRow"]),
        )
        connection.execute(
            """
            INSERT OR IGNORE INTO historical_goals (
                fingerprint, league, home_team, away_team, actual_goals,
                initial_g0, initial_g1, initial_g2, initial_g3,
                initial_g4, initial_g5, initial_g6, initial_g7plus,
                final_g0, final_g1, final_g2, final_g3,
                final_g4, final_g5, final_g6, final_g7plus, source_name,
                source_file, source_row, initial_source_file, initial_source_row
            ) VALUES (
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?
            )
            ON CONFLICT(fingerprint) DO UPDATE SET
                initial_g0 = excluded.initial_g0,
                initial_g1 = excluded.initial_g1,
                initial_g2 = excluded.initial_g2,
                initial_g3 = excluded.initial_g3,
                initial_g4 = excluded.initial_g4,
                initial_g5 = excluded.initial_g5,
                initial_g6 = excluded.initial_g6,
                initial_g7plus = excluded.initial_g7plus,
                source_name = excluded.source_name,
                source_file = excluded.source_file,
                source_row = excluded.source_row,
                initial_source_file = excluded.initial_source_file,
                initial_source_row = excluded.initial_source_row
            """,
            (
                key,
                row["league"],
                row["home"],
                row["away"],
                row["goals"],
                *initial,
                *final,
                row["source"],
                row["sourceFile"],
                row["sourceRow"],
                row.get("initialSourceFile"),
                row.get("initialSourceRow"),
            ),
        )
    after = connection.execute("SELECT COUNT(*) FROM historical_goals").fetchone()[0]
    return after - before


def insert_spf_snapshot(
    connection: sqlite3.Connection,
    match_id: int,
    market: str,
    goal_line: str,
    point: dict[str, Any],
    source_name: str,
) -> None:
    if not valid_three_way(point):
        return
    connection.execute(
        """
        INSERT OR IGNORE INTO spf_odds_snapshots (
            match_id, market, goal_line, captured_at,
            home_odds, draw_odds, away_odds, source_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            match_id,
            market,
            str(goal_line or ""),
            str(point.get("time") or ""),
            float(point["h"]),
            float(point["d"]),
            float(point["a"]),
            source_name,
        ),
    )


def insert_goal_snapshot(
    connection: sqlite3.Connection,
    match_id: int,
    point: dict[str, Any],
    source_name: str,
) -> None:
    if not valid_goals(point):
        return
    connection.execute(
        """
        INSERT OR IGNORE INTO goal_odds_snapshots (
            match_id, captured_at, g0, g1, g2, g3, g4, g5, g6, g7plus, source_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            match_id,
            str(point.get("time") or ""),
            *[float(point[key]) for key in ("g0", "g1", "g2", "g3", "g4", "g5", "g6", "g7plus")],
            source_name,
        ),
    )


def history_rows(detail: dict[str, Any]) -> Iterable[tuple[str, dict[str, Any]]]:
    for row in detail.get("history") or []:
        yield "head_to_head", row
    results = detail.get("results") or {}
    for row in (results.get("home") or {}).get("matches") or []:
        yield "home_form", row
    for row in (results.get("away") or {}).get("matches") or []:
        yield "away_form", row


def detail_goal_odds(detail: dict[str, Any]) -> dict[str, Any]:
    odds = detail.get("odds") or {}
    keys = ("s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7")
    if not all(odds.get(key) not in (None, "") for key in keys):
        return {}
    return {
        "g0": odds["s0"],
        "g1": odds["s1"],
        "g2": odds["s2"],
        "g3": odds["s3"],
        "g4": odds["s4"],
        "g5": odds["s5"],
        "g6": odds["s6"],
        "g7plus": odds["s7"],
        "time": str(detail.get("oddsTime") or "detail-current"),
    }


def import_live_json(
    connection: sqlite3.Connection,
    spf_live: list[dict[str, Any]],
    goal_live: list[dict[str, Any]],
    detail_live: list[dict[str, Any]],
    imported_at: str,
) -> None:
    spf_map = {int(row["match_id"]): row for row in spf_live}
    goal_map = {int(row["match_id"]): row for row in goal_live}
    detail_map = {int(row["matchId"]): row for row in detail_live}
    # match_data1 只补充队名、联赛和球队历史。没有进入任一实时赔率文件的
    # 比赛不属于当期可预测场次，不能仅凭详情文件出现在“选择比赛”中。
    match_ids = sorted(set(spf_map) | set(goal_map))
    if not match_ids:
        raise ValueError("当前比赛JSON为空，已停止切换活动批次")

    connection.execute("UPDATE current_matches SET active = 0")

    for match_id in match_ids:
        spf_row = spf_map.get(match_id, {})
        goal_row = goal_map.get(match_id, {})
        detail = detail_map.get(match_id, {})
        display_name = spf_row.get("display_name") or goal_row.get("display_name") or ""
        league = spf_row.get("league") or goal_row.get("league") or detail.get("league") or ""
        home = detail.get("homeTeam") or ""
        away = detail.get("awayTeam") or ""
        if (not home or not away) and ": " in display_name and " vs " in display_name:
            teams = display_name.split(": ", 1)[1].split(" vs ", 1)
            home, away = teams[0], teams[1]

        connection.execute(
            """
            INSERT INTO current_matches (
                match_id, display_name, league, home_team, away_team,
                imported_at, active
            ) VALUES (?, ?, ?, ?, ?, ?, 1)
            ON CONFLICT(match_id) DO UPDATE SET
                display_name = excluded.display_name,
                league = excluded.league,
                home_team = excluded.home_team,
                away_team = excluded.away_team,
                imported_at = excluded.imported_at,
                active = 1
            """,
            (match_id, display_name, league, home, away, imported_at),
        )

        odds = spf_row.get("odds") or {}
        had = odds.get("had") or {}
        had_timeline = (had.get("history") or {}).get("timeline") or []
        if had_timeline:
            for point in had_timeline:
                insert_spf_snapshot(
                    connection,
                    match_id,
                    "had",
                    "",
                    point,
                    "realtime_matches_had_hhad_history.json",
                )
        else:
            insert_spf_snapshot(
                connection,
                match_id,
                "had",
                "",
                had,
                "realtime_matches_had_hhad_history.json",
            )

        hhad_by_line = odds.get("hhad_by_goalLine") or {}
        if hhad_by_line:
            for goal_line, market_data in hhad_by_line.items():
                timeline = (market_data.get("history") or {}).get("timeline") or []
                if timeline:
                    for point in timeline:
                        insert_spf_snapshot(
                            connection,
                            match_id,
                            "hhad",
                            goal_line,
                            point,
                            "realtime_matches_had_hhad_history.json",
                        )
                else:
                    insert_spf_snapshot(
                        connection,
                        match_id,
                        "hhad",
                        goal_line,
                        market_data,
                        "realtime_matches_had_hhad_history.json",
                    )
        elif odds.get("hhad"):
            hhad = odds["hhad"]
            timeline = (hhad.get("history") or {}).get("timeline") or []
            if timeline:
                for point in timeline:
                    insert_spf_snapshot(
                        connection,
                        match_id,
                        "hhad",
                        hhad.get("goalLine") or "",
                        point,
                        "realtime_matches_had_hhad_history.json",
                    )
            else:
                insert_spf_snapshot(
                    connection,
                    match_id,
                    "hhad",
                    hhad.get("goalLine") or "",
                    hhad,
                    "realtime_matches_had_hhad_history.json",
                )

        goal_odds = goal_row.get("odds") or detail_goal_odds(detail)
        goal_source = (
            "realtime_matches_history.json"
            if goal_row.get("odds")
            else "match_data1.json"
        )
        goal_timeline = (goal_odds.get("history") or {}).get("timeline") or []
        if goal_timeline:
            for point in goal_timeline:
                insert_goal_snapshot(
                    connection,
                    match_id,
                    point,
                    goal_source,
                )
        else:
            insert_goal_snapshot(
                connection,
                match_id,
                goal_odds,
                goal_source,
            )

        for perspective, row in history_rows(detail):
            key = fingerprint(
                match_id,
                perspective,
                row.get("date"),
                row.get("homeTeam"),
                row.get("awayTeam"),
                row.get("score"),
                row.get("halfScore"),
                row.get("tournament"),
            )
            connection.execute(
                """
                INSERT OR IGNORE INTO team_match_history (
                    fingerprint, current_match_id, perspective, match_date,
                    league, home_team, away_team, score, half_score, source_name
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    key,
                    match_id,
                    perspective,
                    row.get("date"),
                    row.get("tournament"),
                    row.get("homeTeam") or "",
                    row.get("awayTeam") or "",
                    row.get("score"),
                    row.get("halfScore"),
                    "match_data1.json",
                ),
            )


def record_sources(
    connection: sqlite3.Connection,
    json_payloads: dict[str, Any],
    imported_at: str,
) -> None:
    for path in EXCEL_FILES:
        row_count = len(pd.read_excel(path, sheet_name=0))
        upsert_source_file(connection, path, "xlsx", row_count, imported_at)

    for path in JSON_FILES:
        payload = json_payloads[path.name]
        record_count = len(payload) if isinstance(payload, list) else 1
        upsert_source_file(connection, path, "json", record_count, imported_at)
        connection.execute(
            """
            INSERT INTO raw_json_documents (file_name, payload_json, imported_at)
            VALUES (?, ?, ?)
            ON CONFLICT(file_name) DO UPDATE SET
                payload_json = excluded.payload_json,
                imported_at = excluded.imported_at
            """,
            (
                path.name,
                json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                imported_at,
            ),
        )


def table_counts(connection: sqlite3.Connection) -> dict[str, int]:
    tables = [
        "source_files",
        "raw_json_documents",
        "historical_spf",
        "historical_hhad",
        "historical_goals",
        "historical_matches",
        "current_matches",
        "spf_odds_snapshots",
        "goal_odds_snapshots",
        "team_match_history",
        "predictions",
        "prediction_ledger",
        "parlay_ledger",
    ]
    return {
        table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        for table in tables
    }


def main() -> None:
    missing = [path.name for path in EXCEL_FILES + JSON_FILES if not path.exists()]
    if missing:
        raise FileNotFoundError(f"缺少数据文件：{', '.join(missing)}")

    imported_at = now_iso()
    spf_history = build_spf_history()
    hhad_history = build_hhad_history()
    goal_history = build_goal_history()
    json_payloads = {path.name: load_json(path) for path in JSON_FILES}

    with sqlite3.connect(DATABASE_PATH) as connection:
        initialize_database(connection)
        connection.commit()
        connection.execute("BEGIN IMMEDIATE")
        try:
            spf_added = import_historical_spf(connection, spf_history)
            hhad_added = import_historical_hhad(connection, hhad_history)
            goals_added = import_historical_goals(connection, goal_history)
            unified_summary = rebuild_historical_matches(connection)
            import_live_json(
                connection,
                json_payloads["realtime_matches_had_hhad_history.json"],
                json_payloads["realtime_matches_history.json"],
                json_payloads["match_data1.json"],
                imported_at,
            )
            record_sources(connection, json_payloads, imported_at)
            connection.commit()
        except Exception:
            connection.rollback()
            raise

        integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
        foreign_keys = connection.execute("PRAGMA foreign_key_check").fetchall()
        counts = table_counts(connection)

    print(f"数据库：{DATABASE_PATH}")
    print(f"本次新增历史胜平负：{spf_added:,}")
    print(f"本次新增历史让球胜平负：{hhad_added:,}")
    print(f"本次新增历史进球：{goals_added:,}")
    print(
        "统一比赛："
        f"匹配 {unified_summary['matched']:,}，"
        f"匹配但进球未校验 {unified_summary['matched_unverified']:,}，"
        f"进球冲突 {unified_summary['conflicts']:,}，"
        f"仅胜平负/让球 {unified_summary['spf_hhad_only']:,}，"
        f"仅让球 {unified_summary['hhad_only']:,}，"
        f"仅进球 {unified_summary['goals_only']:,}"
    )
    for table, count in counts.items():
        print(f"{table}: {count:,}")
    print(f"integrity_check: {integrity}")
    print(f"foreign_key_violations: {len(foreign_keys)}")


if __name__ == "__main__":
    main()
