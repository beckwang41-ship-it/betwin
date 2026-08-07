from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import unicodedata
from collections import defaultdict
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Iterable


GAP_PENALTY = -2.2
MAX_DP_CELLS = 1_500_000
TEAM_NAME_PATH = Path(__file__).resolve().parents[1] / "teamname.json"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def fingerprint(*values: Any) -> str:
    payload = json.dumps(
        values,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def normalize_text(value: object) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).lower().strip()
    text = re.sub(r"[\s·•・._—–\-（）()]+", "", text)
    for suffix in ("足球俱乐部", "俱乐部", "footballclub", "fc"):
        if text.endswith(suffix) and len(text) > len(suffix) + 1:
            text = text[: -len(suffix)]
    return text


def load_team_name_aliases() -> dict[str, str]:
    try:
        payload = json.loads(TEAM_NAME_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(
            f"无法读取球队别名表 {TEAM_NAME_PATH.name}: {error}"
        ) from error
    if not isinstance(payload, dict):
        raise RuntimeError(
            f"球队别名表 {TEAM_NAME_PATH.name} 的根节点必须是对象"
        )
    return {
        normalize_text(alias): normalize_text(canonical)
        for alias, canonical in payload.items()
    }


TEAM_NAME_ALIASES = load_team_name_aliases()


def normalize_name(value: object) -> str:
    normalized = normalize_text(value)
    visited: set[str] = set()
    while normalized in TEAM_NAME_ALIASES and normalized not in visited:
        visited.add(normalized)
        canonical = TEAM_NAME_ALIASES[normalized]
        if not canonical or canonical == normalized:
            break
        normalized = canonical
    return normalized


def normalize_league(value: object) -> str:
    text = normalize_text(value)
    aliases = {
        "美职足": "美职",
        "日职联": "日职",
        "韩职联": "韩职",
    }
    return aliases.get(text, text)


def team_similarity(left: object, right: object) -> float:
    first = normalize_name(left)
    second = normalize_name(right)
    if not first or not second:
        return 0.0
    if first == second:
        return 1.0
    if first in second or second in first:
        shorter = min(len(first), len(second))
        longer = max(len(first), len(second))
        return 0.82 + 0.18 * shorter / longer
    return SequenceMatcher(None, first, second, autojunk=False).ratio()


def goal_label(value: object) -> str:
    text = "" if value is None else str(value).strip()
    if text == "7+":
        return text
    try:
        number = int(float(text))
    except (TypeError, ValueError):
        return ""
    return "7+" if number >= 7 else str(number)


def row_signature(row: dict[str, Any], kind: str) -> tuple[str, str, str, str]:
    goal = (
        goal_label(row.get("total_goals"))
        if kind == "spf"
        else goal_label(row.get("actual_goals"))
    )
    return (
        normalize_league(row.get("league")),
        normalize_name(row.get("home_team")),
        normalize_name(row.get("away_team")),
        goal,
    )


def pair_quality(
    spf: dict[str, Any],
    goals: dict[str, Any],
) -> dict[str, Any]:
    league_same = normalize_league(spf.get("league")) == normalize_league(
        goals.get("league")
    )
    home_similarity = team_similarity(spf.get("home_team"), goals.get("home_team"))
    away_similarity = team_similarity(spf.get("away_team"), goals.get("away_team"))
    team_average = (home_similarity + away_similarity) / 2
    spf_goal = goal_label(spf.get("total_goals"))
    goal_value = goal_label(goals.get("actual_goals"))
    goals_comparable = bool(spf_goal and goal_value)
    goals_same = goals_comparable and spf_goal == goal_value
    eligible = league_same and (
        (goals_same and team_average >= 0.34) or team_average >= 0.72
    )
    score = (
        (2.0 if league_same else -4.0)
        + (4.0 if goals_same else -2.0)
        + home_similarity * 2.0
        + away_similarity * 2.0
    )
    confidence = max(0.0, min(1.0, score / 10.0))
    return {
        "eligible": eligible,
        "score": score,
        "confidence": confidence,
        "league_same": league_same,
        "goals_comparable": goals_comparable,
        "goals_same": goals_same,
        "home_similarity": home_similarity,
        "away_similarity": away_similarity,
    }


def _align_gap_dp(
    spf_rows: list[dict[str, Any]],
    goal_rows: list[dict[str, Any]],
) -> list[tuple[dict[str, Any], dict[str, Any], dict[str, Any]]]:
    left_count = len(spf_rows)
    right_count = len(goal_rows)
    scores = [[0.0] * (right_count + 1) for _ in range(left_count + 1)]
    moves = [[""] * (right_count + 1) for _ in range(left_count + 1)]
    for left in range(1, left_count + 1):
        scores[left][0] = scores[left - 1][0] + GAP_PENALTY
        moves[left][0] = "left"
    for right in range(1, right_count + 1):
        scores[0][right] = scores[0][right - 1] + GAP_PENALTY
        moves[0][right] = "right"

    quality_cache: dict[tuple[int, int], dict[str, Any]] = {}
    for left in range(1, left_count + 1):
        for right in range(1, right_count + 1):
            quality = pair_quality(spf_rows[left - 1], goal_rows[right - 1])
            quality_cache[(left - 1, right - 1)] = quality
            pair_score = (
                scores[left - 1][right - 1] + quality["score"]
                if quality["eligible"]
                else float("-inf")
            )
            skip_left = scores[left - 1][right] + GAP_PENALTY
            skip_right = scores[left][right - 1] + GAP_PENALTY
            if pair_score >= skip_left and pair_score >= skip_right:
                scores[left][right] = pair_score
                moves[left][right] = "pair"
            elif skip_left >= skip_right:
                scores[left][right] = skip_left
                moves[left][right] = "left"
            else:
                scores[left][right] = skip_right
                moves[left][right] = "right"

    pairs: list[tuple[dict[str, Any], dict[str, Any], dict[str, Any]]] = []
    left, right = left_count, right_count
    while left or right:
        move = moves[left][right]
        if move == "pair":
            quality = quality_cache[(left - 1, right - 1)]
            pairs.append((spf_rows[left - 1], goal_rows[right - 1], quality))
            left -= 1
            right -= 1
        elif move == "left":
            left -= 1
        elif move == "right":
            right -= 1
        else:
            break
    pairs.reverse()
    return pairs


def _align_gap_greedy(
    spf_rows: list[dict[str, Any]],
    goal_rows: list[dict[str, Any]],
    lookahead: int = 30,
) -> list[tuple[dict[str, Any], dict[str, Any], dict[str, Any]]]:
    pairs: list[tuple[dict[str, Any], dict[str, Any], dict[str, Any]]] = []
    left = right = 0
    while left < len(spf_rows) and right < len(goal_rows):
        best: tuple[float, int, int, dict[str, Any]] | None = None
        for left_offset in range(min(lookahead, len(spf_rows) - left)):
            for right_offset in range(min(lookahead, len(goal_rows) - right)):
                quality = pair_quality(
                    spf_rows[left + left_offset],
                    goal_rows[right + right_offset],
                )
                if not quality["eligible"]:
                    continue
                rank = quality["score"] - (left_offset + right_offset) * 0.45
                if best is None or rank > best[0]:
                    best = (rank, left_offset, right_offset, quality)
        if best is None:
            left += 1
            right += 1
            continue
        _, left_offset, right_offset, quality = best
        left += left_offset
        right += right_offset
        pairs.append((spf_rows[left], goal_rows[right], quality))
        left += 1
        right += 1
    return pairs


def align_reverse_order(
    spf_rows: Iterable[dict[str, Any]],
    goal_rows: Iterable[dict[str, Any]],
) -> list[tuple[dict[str, Any], dict[str, Any], dict[str, Any]]]:
    newest_spf = list(spf_rows)
    newest_goals = list(goal_rows)
    if not newest_spf or not newest_goals:
        return []

    left_signatures = [row_signature(row, "spf") for row in newest_spf]
    right_signatures = [row_signature(row, "goals") for row in newest_goals]
    matcher = SequenceMatcher(
        None,
        left_signatures,
        right_signatures,
        autojunk=False,
    )
    pairs: list[tuple[dict[str, Any], dict[str, Any], dict[str, Any]]] = []
    for tag, left_start, left_end, right_start, right_end in matcher.get_opcodes():
        left_gap = newest_spf[left_start:left_end]
        right_gap = newest_goals[right_start:right_end]
        if tag == "equal":
            for spf, goals in zip(left_gap, right_gap):
                pairs.append((spf, goals, pair_quality(spf, goals)))
            continue
        if not left_gap or not right_gap:
            continue
        if len(left_gap) * len(right_gap) <= MAX_DP_CELLS:
            pairs.extend(_align_gap_dp(left_gap, right_gap))
        else:
            pairs.extend(_align_gap_greedy(left_gap, right_gap))
    return pairs


def _rows(connection: sqlite3.Connection, query: str) -> list[dict[str, Any]]:
    connection.row_factory = sqlite3.Row
    return [dict(row) for row in connection.execute(query).fetchall()]


def _occurrences_from_latest(
    rows: Iterable[dict[str, Any]],
) -> dict[int, int]:
    counts: defaultdict[tuple[str, str, str], int] = defaultdict(int)
    ranks: dict[int, int] = {}
    for row in rows:
        fixture = (
            normalize_league(row.get("league")),
            normalize_name(row.get("home_team")),
            normalize_name(row.get("away_team")),
        )
        counts[fixture] += 1
        ranks[int(row["id"])] = counts[fixture]
    return ranks


def rebuild_historical_matches(
    connection: sqlite3.Connection,
) -> dict[str, int]:
    spf_rows = _rows(
        connection,
        """
        SELECT id, league, home_team, away_team, score, result, handicap,
               total_goals, source_file, source_row,
               initial_source_file, initial_source_row
        FROM historical_spf
        ORDER BY
          CASE source_file WHEN 'lsspfpl.xlsx' THEN 0 ELSE 1 END,
          source_row DESC,
          id DESC
        """,
    )
    hhad_rows = _rows(
        connection,
        """
        SELECT id, league, home_team, away_team, score, result, handicap,
               source_file, source_row
        FROM historical_hhad
        ORDER BY
          CASE source_file WHEN 'lsspfpl.xlsx' THEN 0 ELSE 1 END,
          source_row DESC,
          id DESC
        """,
    )
    goal_rows = _rows(
        connection,
        """
        SELECT id, league, home_team, away_team, actual_goals,
               source_file, source_row,
               initial_source_file, initial_source_row
        FROM historical_goals
        ORDER BY
          CASE source_file WHEN '历史进球数.xlsx' THEN 0 ELSE 1 END,
          source_row DESC,
          id DESC
        """,
    )
    hhad_by_source = {
        (row["source_file"], int(row["source_row"])): row
        for row in hhad_rows
    }
    spf_occurrences = _occurrences_from_latest(spf_rows)
    hhad_occurrences = _occurrences_from_latest(hhad_rows)
    goal_occurrences = _occurrences_from_latest(goal_rows)

    legacy_spf = [
        row for row in spf_rows if row["source_file"] == "lsspfpl.xlsx"
    ]
    legacy_goals = [
        row for row in goal_rows if row["source_file"] == "历史进球数.xlsx"
    ]
    pairs = [
        (*pair, "legacy_reverse_order")
        for pair in align_reverse_order(legacy_spf, legacy_goals)
    ]
    used_spf = {int(spf["id"]) for spf, _, _, _ in pairs}
    used_goals = {int(goals["id"]) for _, goals, _, _ in pairs}

    rich_spf = sorted(
        [
            row
            for row in spf_rows
            if int(row["id"]) not in used_spf
            and (
                row.get("initial_source_file") == "initspfpl.xlsx"
                or row.get("source_file") == "initspfpl.xlsx"
            )
        ],
        key=lambda row: int(
            row.get("initial_source_row") or row.get("source_row") or 0
        ),
        reverse=True,
    )
    rich_goals = sorted(
        [
            row
            for row in goal_rows
            if int(row["id"]) not in used_goals
            and (
                row.get("initial_source_file")
                == "lottery_goals_data_df1cda93.xlsx"
                or row.get("source_file") == "lottery_goals_data_df1cda93.xlsx"
            )
        ],
        key=lambda row: int(
            row.get("initial_source_row") or row.get("source_row") or 0
        ),
        reverse=True,
    )
    rich_pairs = [
        (*pair, "rich_reverse_order")
        for pair in align_reverse_order(rich_spf, rich_goals)
    ]
    for spf, goals, quality, method in rich_pairs:
        spf_id = int(spf["id"])
        goals_id = int(goals["id"])
        if spf_id not in used_spf and goals_id not in used_goals:
            pairs.append((spf, goals, quality, method))
            used_spf.add(spf_id)
            used_goals.add(goals_id)

    goal_match_by_spf = {
        int(spf["id"]): (goals, quality, method)
        for spf, goals, quality, method in pairs
    }
    created_at = now_iso()
    connection.execute("DELETE FROM historical_matches")

    matched = unverified = conflicts = spf_only = 0
    for spf in spf_rows:
        spf_id = int(spf["id"])
        goal_match = goal_match_by_spf.get(spf_id)
        goals = goal_match[0] if goal_match else None
        quality = goal_match[1] if goal_match else None
        method = goal_match[2] if goal_match else "spf_hhad_only"
        comparable = bool(quality and quality["goals_comparable"])
        consistent = bool(quality and quality["goals_same"])
        status = (
            "matched"
            if goal_match and consistent
            else "matched_unverified"
            if goal_match and not comparable
            else "conflict"
            if goal_match
            else "spf_hhad_only"
        )
        matched += int(status == "matched")
        unverified += int(status == "matched_unverified")
        conflicts += int(status == "conflict")
        spf_only += int(status == "spf_hhad_only")
        hhad = hhad_by_source.get(
            (spf["source_file"], int(spf["source_row"]))
        )
        hhad_id = int(hhad["id"]) if hhad else None
        match_key = fingerprint(
            "spf",
            spf["source_file"],
            int(spf["source_row"]),
        )
        connection.execute(
            """
            INSERT INTO historical_matches (
                match_key, league, home_team, away_team, score, result,
                handicap, total_goals, actual_goal_label,
                spf_id, hhad_id, goals_id,
                spf_source_file, spf_source_row,
                hhad_source_file, hhad_source_row,
                goals_source_file, goals_source_row,
                fixture_occurrence_from_latest,
                goal_fixture_occurrence_from_latest,
                match_status, match_method, match_confidence,
                goal_consistent, created_at
            ) VALUES (
                ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?,
                ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?
            )
            """,
            (
                match_key,
                spf["league"],
                spf["home_team"],
                spf["away_team"],
                spf.get("score"),
                spf.get("result"),
                spf.get("handicap"),
                spf.get("total_goals"),
                goals["actual_goals"] if goals else None,
                spf_id,
                hhad_id,
                int(goals["id"]) if goals else None,
                spf["source_file"],
                int(spf["source_row"]),
                hhad["source_file"] if hhad else None,
                int(hhad["source_row"]) if hhad else None,
                goals["source_file"] if goals else None,
                int(goals["source_row"]) if goals else None,
                spf_occurrences.get(spf_id),
                goal_occurrences.get(int(goals["id"])) if goals else None,
                status,
                method,
                quality["confidence"] if quality else None,
                int(consistent) if goal_match and comparable else None,
                created_at,
            ),
        )

    used_hhad: set[int] = set()
    for spf in spf_rows:
        hhad = hhad_by_source.get(
            (spf["source_file"], int(spf["source_row"]))
        )
        if hhad:
            used_hhad.add(int(hhad["id"]))

    hhad_only = 0
    for hhad in hhad_rows:
        hhad_id = int(hhad["id"])
        if hhad_id in used_hhad:
            continue
        hhad_only += 1
        match_key = fingerprint(
            "hhad",
            hhad["source_file"],
            int(hhad["source_row"]),
        )
        connection.execute(
            """
            INSERT INTO historical_matches (
                match_key, league, home_team, away_team, score, result,
                handicap, hhad_id,
                hhad_source_file, hhad_source_row,
                fixture_occurrence_from_latest,
                match_status, match_method, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'hhad_only', 'hhad_only', ?)
            """,
            (
                match_key,
                hhad["league"],
                hhad["home_team"],
                hhad["away_team"],
                hhad.get("score"),
                hhad.get("result"),
                hhad.get("handicap"),
                hhad_id,
                hhad["source_file"],
                int(hhad["source_row"]),
                hhad_occurrences.get(hhad_id),
                created_at,
            ),
        )

    goals_only = 0
    for goals in goal_rows:
        goals_id = int(goals["id"])
        if goals_id in used_goals:
            continue
        goals_only += 1
        match_key = fingerprint(
            "goals",
            goals["source_file"],
            int(goals["source_row"]),
        )
        connection.execute(
            """
            INSERT INTO historical_matches (
                match_key, league, home_team, away_team, actual_goal_label,
                goals_id, goals_source_file, goals_source_row,
                goal_fixture_occurrence_from_latest,
                match_status, match_method, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'goals_only', 'goals_only', ?)
            """,
            (
                match_key,
                goals["league"],
                goals["home_team"],
                goals["away_team"],
                goals["actual_goals"],
                goals_id,
                goals["source_file"],
                int(goals["source_row"]),
                goal_occurrences.get(goals_id),
                created_at,
            ),
        )

    return {
        "matched": matched,
        "matched_unverified": unverified,
        "conflicts": conflicts,
        "spf_hhad_only": spf_only,
        "hhad_only": hhad_only,
        "goals_only": goals_only,
        "total": (
            matched
            + unverified
            + conflicts
            + spf_only
            + hhad_only
            + goals_only
        ),
    }
