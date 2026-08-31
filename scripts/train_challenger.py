from __future__ import annotations

import json
import math
import os
import sqlite3
import subprocess
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import numpy as np
from sklearn.ensemble import RandomForestClassifier


ROOT = Path(__file__).resolve().parent.parent
DATABASE_PATH = Path(os.environ.get("BETWIN_DATABASE_PATH", ROOT / "betwin.db"))
MODEL_PATH = Path(
    os.environ.get(
        "BETWIN_CHALLENGER_MODEL_PATH",
        ROOT / "data" / "challenger-model.json",
    )
)
CONFIG_PATH = Path(
    os.environ.get(
        "BETWIN_CHALLENGER_CONFIG_PATH",
        ROOT / "data" / "challenger-config.json",
    )
)

OUTCOME_LABELS = ["胜", "平", "负"]
GOAL_LABELS = ["0", "1", "2", "3", "4", "5", "6", "7+"]
THRESHOLDS = {"spf": 0.07, "hhad": 0.07, "goals": 0.015}
HISTORICAL_THRESHOLDS = {
    "spf": [0.03, 0.05, 0.07, 0.10],
    "hhad": [0.03, 0.05, 0.07, 0.10],
    "goals": [0.005, 0.010, 0.015, 0.020],
}
GOAL_POOL_FRACTIONS = [0.25, 0.5, 0.75, 1.0]
RANDOM_SEED = 20260727
MIN_SOURCE_ROWS = 1000
BOOTSTRAP_ITERATIONS = 1000
BOOTSTRAP_BLOCK_SIZE = 20

CANDIDATES = [
    {
        "id": "rf-depth6-leaf20",
        "max_depth": 6,
        "min_samples_leaf": 20,
        "max_features": 0.5,
    },
    {
        "id": "rf-depth8-leaf15",
        "max_depth": 8,
        "min_samples_leaf": 15,
        "max_features": 0.5,
    },
    {
        "id": "rf-depth10-leaf10",
        "max_depth": 10,
        "min_samples_leaf": 10,
        "max_features": "sqrt",
    },
    {
        "id": "rf-depth12-leaf8",
        "max_depth": 12,
        "min_samples_leaf": 8,
        "max_features": 0.5,
    },
    {
        "id": "rf-unlimited-leaf20",
        "max_depth": None,
        "min_samples_leaf": 20,
        "max_features": 0.5,
    },
]


def read_rows(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    connection.row_factory = sqlite3.Row
    rows = connection.execute(
        """
        SELECT m.match_key, m.spf_source_file, m.spf_source_row,
               g.source_file AS goal_source_file,
               g.source_row AS goal_source_row,
               s.league, s.result AS spf_result,
               s.initial_home_odds AS spf_i_h,
               s.initial_draw_odds AS spf_i_d,
               s.initial_away_odds AS spf_i_a,
               s.final_home_odds AS spf_f_h,
               s.final_draw_odds AS spf_f_d,
               s.final_away_odds AS spf_f_a,
               h.result AS hhad_result, h.handicap,
               h.initial_home_odds AS hhad_i_h,
               h.initial_draw_odds AS hhad_i_d,
               h.initial_away_odds AS hhad_i_a,
               h.final_home_odds AS hhad_f_h,
               h.final_draw_odds AS hhad_f_d,
               h.final_away_odds AS hhad_f_a,
               g.actual_goals,
               g.initial_g0 AS goal_i_0,
               g.initial_g1 AS goal_i_1,
               g.initial_g2 AS goal_i_2,
               g.initial_g3 AS goal_i_3,
               g.initial_g4 AS goal_i_4,
               g.initial_g5 AS goal_i_5,
               g.initial_g6 AS goal_i_6,
               g.initial_g7plus AS goal_i_7,
               g.final_g0 AS goal_f_0,
               g.final_g1 AS goal_f_1,
               g.final_g2 AS goal_f_2,
               g.final_g3 AS goal_f_3,
               g.final_g4 AS goal_f_4,
               g.final_g5 AS goal_f_5,
               g.final_g6 AS goal_f_6,
               g.final_g7plus AS goal_f_7
        FROM historical_matches m
        JOIN historical_spf s ON s.id = m.spf_id
        JOIN historical_hhad h ON h.id = m.hhad_id
        JOIN historical_goals g ON g.id = m.goals_id
        WHERE m.match_status = 'matched' AND m.goal_consistent = 1
        ORDER BY m.spf_source_file, m.spf_source_row
        """
    ).fetchall()
    return [dict(row) for row in rows]


def source_updated_at(connection: sqlite3.Connection) -> str | None:
    row = connection.execute(
        "SELECT MAX(imported_at) AS updated_at FROM source_files WHERE file_type = 'xlsx'"
    ).fetchone()
    return row[0] if row else None


def valid_odds(values: list[Any]) -> bool:
    return all(value is not None and float(value) > 1 for value in values)


def odds_vector(row: dict[str, Any], prefix: str, size: int) -> list[float] | None:
    suffixes = ["h", "d", "a"] if size == 3 else list(range(size))
    values = [row.get(f"{prefix}_{suffix}") for suffix in suffixes]
    if not valid_odds(values):
        return None
    return [float(value) for value in values]


def normalized_odds(values: list[float]) -> tuple[np.ndarray, float]:
    implied = 1 / np.asarray(values, dtype=float)
    overround = float(implied.sum())
    return implied / overround, overround


def goal_expectation(probabilities: np.ndarray) -> float:
    values = np.asarray([0, 1, 2, 3, 4, 5, 6, 7.5], dtype=float)
    return float(np.dot(probabilities, values))


@dataclass
class FeatureSpec:
    leagues: list[str]
    names: list[str]
    history_sources: list[str]
    historical_thresholds: dict[str, list[float]]
    goal_pool_fractions: list[float] = field(
        default_factory=lambda: list(GOAL_POOL_FRACTIONS)
    )


def historical_feature_names(
    thresholds: dict[str, list[float]],
    goal_pool_fractions: list[float] = GOAL_POOL_FRACTIONS,
) -> list[str]:
    names: list[str] = []
    for market in ["spf", "hhad"]:
        for tolerance in thresholds[market]:
            band = f"{tolerance:.3f}".rstrip("0").rstrip(".").replace(".", "p")
            names.extend(
                f"history_{market}_t{band}_p_{index}"
                for index in range(3)
            )
            names.extend(
                [
                    f"history_{market}_t{band}_sample_count",
                    f"history_{market}_t{band}_sample_log1p",
                    f"history_{market}_t{band}_missing",
                    f"history_{market}_t{band}_entropy",
                    f"history_{market}_t{band}_margin",
                ]
            )
        names.extend(
            [
                f"history_{market}_available_bands",
                f"history_{market}_direction_stable",
                f"history_{market}_consensus_share",
            ]
        )
    for fraction in goal_pool_fractions:
        band = f"pool{round(fraction * 100)}"
        names.extend(
            f"history_goals_{band}_p_{index}"
            for index in range(8)
        )
        names.extend(
            [
                f"history_goals_{band}_sample_count",
                f"history_goals_{band}_sample_log1p",
                f"history_goals_{band}_missing",
                f"history_goals_{band}_entropy",
                f"history_goals_{band}_margin",
            ]
        )
    names.extend(
        [
            "history_goals_available_bands",
            "history_goals_direction_stable",
            "history_goals_consensus_share",
        ]
    )
    return names


def build_feature_spec(
    train_rows: list[dict[str, Any]],
    history_sources: list[str],
) -> FeatureSpec:
    leagues = sorted({str(row["league"]) for row in train_rows})
    names: list[str] = []
    markets = [("spf", 3), ("hhad", 3), ("goal", 8)]
    for market, size in markets:
        names.extend(f"{market}_final_p_{index}" for index in range(size))
        names.extend(f"{market}_initial_p_{index}" for index in range(size))
        names.extend(f"{market}_delta_p_{index}" for index in range(size))
        names.extend(f"{market}_final_log_odds_{index}" for index in range(size))
        names.extend(f"{market}_initial_log_odds_{index}" for index in range(size))
        names.extend(
            [
                f"{market}_final_overround",
                f"{market}_initial_overround",
                f"{market}_initial_missing",
            ]
        )
    names.extend(
        [
            "handicap",
            "goal_final_expectation",
            "goal_initial_expectation",
            "spf_hhad_home_gap",
            "spf_hhad_draw_gap",
            "spf_hhad_away_gap",
        ]
    )
    names.extend(f"league::{league}" for league in leagues)
    names.append("league::__unknown__")
    names.extend(
        historical_feature_names(HISTORICAL_THRESHOLDS, GOAL_POOL_FRACTIONS)
    )
    return FeatureSpec(
        leagues=leagues,
        names=names,
        history_sources=history_sources,
        historical_thresholds=HISTORICAL_THRESHOLDS,
        goal_pool_fractions=GOAL_POOL_FRACTIONS,
    )


def features_for_row(
    row: dict[str, Any],
    spec: FeatureSpec,
    historical_features: np.ndarray,
) -> np.ndarray:
    values: list[float] = []
    probability_vectors: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    for market, size in [("spf", 3), ("hhad", 3), ("goal", 8)]:
        final_odds = odds_vector(row, f"{market}_f", size)
        if final_odds is None:
            raise ValueError(f"{row['match_key']} 缺少 {market} 终赔")
        initial_odds = odds_vector(row, f"{market}_i", size)
        missing = initial_odds is None
        if initial_odds is None:
            initial_odds = final_odds
        final_probabilities, final_overround = normalized_odds(final_odds)
        initial_probabilities, initial_overround = normalized_odds(initial_odds)
        probability_vectors[market] = (
            final_probabilities,
            initial_probabilities,
        )
        values.extend(final_probabilities.tolist())
        values.extend(initial_probabilities.tolist())
        values.extend((final_probabilities - initial_probabilities).tolist())
        values.extend(math.log(value) for value in final_odds)
        values.extend(math.log(value) for value in initial_odds)
        values.extend(
            [final_overround, initial_overround, 1.0 if missing else 0.0]
        )

    spf_final = probability_vectors["spf"][0]
    hhad_final = probability_vectors["hhad"][0]
    goal_final, goal_initial = probability_vectors["goal"]
    values.extend(
        [
            float(row["handicap"]),
            goal_expectation(goal_final),
            goal_expectation(goal_initial),
            float(spf_final[0] - hhad_final[0]),
            float(spf_final[1] - hhad_final[1]),
            float(spf_final[2] - hhad_final[2]),
        ]
    )
    league = str(row["league"])
    values.extend(1.0 if league == candidate else 0.0 for candidate in spec.leagues)
    values.append(0.0 if league in spec.leagues else 1.0)
    values.extend(float(value) for value in historical_features)
    result = np.asarray(values, dtype=np.float32)
    if len(result) != len(spec.names):
        raise RuntimeError(
            f"特征数量不一致：生成 {len(result)}，定义 {len(spec.names)}"
        )
    return result


def distribution_features(
    actual: np.ndarray,
    distances: np.ndarray,
    tolerances: list[float],
    size: int,
    extra_mask: np.ndarray | None = None,
) -> list[float]:
    values: list[float] = []
    directions: list[int] = []
    available_bands = 0
    for tolerance in tolerances:
        mask = distances <= tolerance
        if extra_mask is not None:
            mask &= extra_mask
        matches = actual[mask]
        sample_count = int(len(matches))
        if sample_count:
            counts = np.bincount(matches, minlength=size).astype(float)
            probabilities = counts / counts.sum()
            positive = probabilities[probabilities > 0]
            entropy = float(
                -np.sum(positive * np.log(positive)) / math.log(size)
            )
            sorted_probabilities = np.sort(probabilities)
            margin = float(
                sorted_probabilities[-1] - sorted_probabilities[-2]
            )
            top = np.flatnonzero(
                np.isclose(probabilities, probabilities.max(), atol=1e-12)
            )
            if len(top) == 1:
                directions.append(int(top[0]))
            available_bands += 1
            missing = 0.0
        else:
            probabilities = np.full(size, 1 / size, dtype=float)
            entropy = 1.0
            margin = 0.0
            missing = 1.0
        values.extend(probabilities.tolist())
        values.extend(
            [
                float(sample_count),
                math.log1p(sample_count),
                missing,
                entropy,
                margin,
            ]
        )

    if directions:
        direction_counts = Counter(directions)
        consensus_share = max(direction_counts.values()) / len(directions)
        direction_stable = (
            1.0
            if len(directions) == len(tolerances)
            and len(direction_counts) == 1
            else 0.0
        )
    else:
        consensus_share = 0.0
        direction_stable = 0.0
    values.extend(
        [float(available_bands), direction_stable, float(consensus_share)]
    )
    return values


def load_goal_production_events() -> tuple[dict[tuple[str, int], dict[str, Any]], dict[str, Any]]:
    script = ROOT / "scripts" / "export_goal_production_events.mjs"
    environment = os.environ.copy()
    environment["BETWIN_DATABASE_PATH"] = str(DATABASE_PATH)
    completed = subprocess.run(
        ["node", str(script)],
        check=True,
        capture_output=True,
        text=True,
        env=environment,
    )
    payload = json.loads(completed.stdout)
    events = {
        (str(event["sourceFile"]), int(event["sourceRow"])): event
        for event in payload.get("events", [])
    }
    return events, {
        "matchingVersion": payload.get("matchingVersion"),
        "ordering": payload.get("ordering"),
        "events": len(events),
    }


def production_goal_features(
    event: dict[str, Any],
    fractions: list[float],
) -> list[float]:
    pools = event.get("pools", []) if event else []
    values: list[float] = []
    directions: list[int] = []
    available_bands = 0
    for fraction in fractions:
        pool = next(
            (
                item
                for item in pools
                if math.isclose(
                    float(item.get("fraction", 0)),
                    fraction,
                    abs_tol=1e-12,
                )
            ),
            None,
        )
        sample_count = int(pool.get("sampleCount", 0)) if pool else 0
        probabilities = (
            np.asarray(pool.get("probabilities", []), dtype=float)
            if pool
            else np.asarray([], dtype=float)
        )
        available = (
            sample_count > 0
            and probabilities.shape == (8,)
            and np.isfinite(probabilities).all()
            and float(probabilities.sum()) > 0
        )
        if available:
            probabilities = probabilities / probabilities.sum()
            positive = probabilities[probabilities > 0]
            entropy = float(
                -np.sum(positive * np.log(positive)) / math.log(8)
            )
            ordered = np.sort(probabilities)
            margin = float(ordered[-1] - ordered[-2])
            top = np.flatnonzero(
                np.isclose(probabilities, probabilities.max(), atol=1e-12)
            )
            if len(top) == 1:
                directions.append(int(top[0]))
            available_bands += 1
            missing = 0.0
        else:
            probabilities = np.full(8, 1 / 8, dtype=float)
            entropy = 1.0
            margin = 0.0
            missing = 1.0
        values.extend(probabilities.tolist())
        values.extend(
            [
                float(sample_count),
                math.log1p(sample_count),
                missing,
                entropy,
                margin,
            ]
        )

    if directions:
        direction_counts = Counter(directions)
        consensus_share = max(direction_counts.values()) / len(directions)
        direction_stable = (
            1.0
            if len(directions) == len(fractions)
            and len(direction_counts) == 1
            else 0.0
        )
    else:
        consensus_share = 0.0
        direction_stable = 0.0
    values.extend(
        [float(available_bands), direction_stable, float(consensus_share)]
    )
    return values


def historical_feature_matrix(
    rows: list[dict[str, Any]],
    spec: FeatureSpec,
    goal_events: dict[tuple[str, int], dict[str, Any]] | None = None,
) -> np.ndarray:
    label_index = {label: index for index, label in enumerate(OUTCOME_LABELS)}
    spf_odds = np.asarray(
        [odds_vector(row, "spf_f", 3) for row in rows],
        dtype=float,
    )
    hhad_odds = np.asarray(
        [odds_vector(row, "hhad_f", 3) for row in rows],
        dtype=float,
    )
    spf_actual = np.asarray(
        [label_index[str(row["spf_result"])] for row in rows],
        dtype=np.int32,
    )
    hhad_actual = np.asarray(
        [label_index[str(row["hhad_result"])] for row in rows],
        dtype=np.int32,
    )
    handicaps = np.asarray([int(row["handicap"]) for row in rows])
    feature_count = len(
        historical_feature_names(
            spec.historical_thresholds,
            spec.goal_pool_fractions,
        )
    )
    result = np.zeros((len(rows), feature_count), dtype=np.float32)

    for target_index in range(len(rows)):
        if target_index == 0:
            spf_distances = np.asarray([], dtype=float)
            hhad_distances = np.asarray([], dtype=float)
        else:
            spf_distances = spf_distance_matrix(
                spf_odds[:target_index],
                spf_odds[target_index],
            )
            hhad_distances = spf_distance_matrix(
                hhad_odds[:target_index],
                hhad_odds[target_index],
            )
        values: list[float] = []
        values.extend(
            distribution_features(
                spf_actual[:target_index],
                spf_distances,
                spec.historical_thresholds["spf"],
                3,
            )
        )
        values.extend(
            distribution_features(
                hhad_actual[:target_index],
                hhad_distances,
                spec.historical_thresholds["hhad"],
                3,
                handicaps[:target_index] == handicaps[target_index],
            )
        )
        if goal_events is None:
            event = {}
        else:
            event_key = (
                str(rows[target_index]["goal_source_file"]),
                int(rows[target_index]["goal_source_row"]),
            )
            if event_key not in goal_events:
                raise RuntimeError(
                    f"{rows[target_index]['match_key']} 缺少生产总进球滚动事件 {event_key}"
                )
            event = goal_events[event_key]
        values.extend(
            production_goal_features(
                event,
                spec.goal_pool_fractions,
            )
        )
        result[target_index] = np.asarray(values, dtype=np.float32)
        if target_index and target_index % 1000 == 0:
            print(f"  已生成 {target_index:,} / {len(rows):,} 场滚动历史特征")
    return result


def threshold_band(tolerance: float) -> str:
    return f"{tolerance:.3f}".rstrip("0").rstrip(".").replace(".", "p")


def selection_observations(
    rows: list[dict[str, Any]],
    historical_features: np.ndarray,
    history_names: list[str],
    market: str,
) -> dict[str, np.ndarray]:
    name_index = {name: index for index, name in enumerate(history_names)}
    size = 8 if market == "goals" else 3
    band = (
        "pool100"
        if market == "goals"
        else f"t{threshold_band(THRESHOLDS[market])}"
    )
    probability_start = name_index[f"history_{market}_{band}_p_0"]
    probabilities = historical_features[
        :, probability_start : probability_start + size
    ].astype(float)
    sample_count = historical_features[
        :, name_index[f"history_{market}_{band}_sample_count"]
    ].astype(float)
    margin = historical_features[
        :, name_index[f"history_{market}_{band}_margin"]
    ].astype(float)
    stable = historical_features[
        :, name_index[f"history_{market}_direction_stable"]
    ].astype(float)
    consensus = historical_features[
        :, name_index[f"history_{market}_consensus_share"]
    ].astype(float)
    actual = target_values(rows, market)
    return {
        "probabilities": probabilities,
        "sampleCount": sample_count,
        "topProbability": probabilities.max(axis=1),
        "margin": margin,
        "stable": stable,
        "consensus": consensus,
        "actual": actual,
        "correct": correct_scores(probabilities, actual),
        "available": sample_count > 0,
    }


def quantile_candidates(values: np.ndarray) -> list[float]:
    return sorted(
        {
            round_number(value)
            for value in np.quantile(
                values,
                [0, 0.15, 0.30, 0.45, 0.60, 0.75, 0.90],
            )
        }
    )


def selection_mask(
    observations: dict[str, np.ndarray],
    rule: dict[str, Any],
) -> np.ndarray:
    mask = (
        observations["available"]
        & (observations["sampleCount"] >= rule["minSamples"])
        & (observations["topProbability"] >= rule["minTopProbability"])
        & (observations["margin"] >= rule["minMargin"])
        & (observations["consensus"] >= rule["minConsensus"])
    )
    if rule["requireStable"]:
        mask &= observations["stable"] >= 1
    return mask


def selection_segment_metrics(
    observations: dict[str, np.ndarray],
    selected: np.ndarray,
    start: int,
    end: int,
) -> dict[str, float]:
    available = observations["available"][start:end]
    chosen = selected[start:end]
    correct = observations["correct"][start:end]
    available_count = int(available.sum())
    selected_count = int(chosen.sum())
    baseline_accuracy = (
        float(correct[available].mean()) if available_count else 0.0
    )
    selected_accuracy = (
        float(correct[chosen].mean()) if selected_count else 0.0
    )
    return {
        "available": available_count,
        "selected": selected_count,
        "coverage": (
            selected_count / available_count if available_count else 0.0
        ),
        "baselineAccuracy": baseline_accuracy,
        "selectedAccuracy": selected_accuracy,
        "accuracyLift": selected_accuracy - baseline_accuracy,
    }


def selection_block_bootstrap(
    observations: dict[str, np.ndarray],
    selected: np.ndarray,
    start: int,
    end: int,
) -> dict[str, Any]:
    available = observations["available"][start:end]
    chosen = selected[start:end]
    correct = observations["correct"][start:end]
    count = len(correct)
    random = np.random.default_rng(RANDOM_SEED + start + end)
    deltas: list[float] = []
    for _ in range(BOOTSTRAP_ITERATIONS):
        indices: list[int] = []
        while len(indices) < count:
            block_start = int(random.integers(0, count))
            take = min(BOOTSTRAP_BLOCK_SIZE, count - len(indices))
            indices.extend(
                (block_start + offset) % count for offset in range(take)
            )
        sampled = np.asarray(indices, dtype=int)
        sample_available = available[sampled]
        sample_selected = chosen[sampled]
        if not sample_available.any() or not sample_selected.any():
            continue
        baseline = float(correct[sampled][sample_available].mean())
        recommended = float(correct[sampled][sample_selected].mean())
        deltas.append(recommended - baseline)
    return {
        "iterations": len(deltas),
        "blockSize": BOOTSTRAP_BLOCK_SIZE,
        "confidence": 0.95,
        "accuracyLift": {
            "lower": percentile(deltas, 0.025) if deltas else 0.0,
            "upper": percentile(deltas, 0.975) if deltas else 0.0,
        },
    }


def tune_selection_policy(
    rows: list[dict[str, Any]],
    historical_features: np.ndarray,
    history_names: list[str],
    market: str,
    train_end: int,
    calibration_end: int,
) -> dict[str, Any]:
    observations = selection_observations(
        rows,
        historical_features,
        history_names,
        market,
    )
    train_available = observations["available"][:train_end]
    available_indices = np.flatnonzero(train_available)
    if not len(available_indices):
        raise RuntimeError(f"{market} 没有可用于选择性预测的训练样本")
    sample_candidates = quantile_candidates(
        observations["sampleCount"][available_indices]
    )
    top_candidates = quantile_candidates(
        observations["topProbability"][available_indices]
    )
    margin_candidates = quantile_candidates(
        observations["margin"][available_indices]
    )
    candidates: list[dict[str, Any]] = []
    for min_samples in sample_candidates:
        for min_top_probability in top_candidates:
            for min_margin in margin_candidates:
                for require_stable in [False, True]:
                    for min_consensus in [0.0, 0.75, 1.0]:
                        rule = {
                            "threshold": THRESHOLDS[market],
                            "minSamples": int(math.ceil(min_samples)),
                            "minTopProbability": min_top_probability,
                            "minMargin": min_margin,
                            "requireStable": require_stable,
                            "minConsensus": min_consensus,
                        }
                        selected = selection_mask(observations, rule)
                        metrics_result = selection_segment_metrics(
                            observations,
                            selected,
                            0,
                            train_end,
                        )
                        if (
                            metrics_result["selected"] < 300
                            or metrics_result["coverage"] < 0.12
                            or metrics_result["coverage"] > 0.65
                        ):
                            continue
                        candidates.append(
                            {
                                "rule": rule,
                                "train": metrics_result,
                                "selected": selected,
                            }
                        )
    if not candidates:
        raise RuntimeError(f"{market} 没有满足覆盖率约束的选择规则")
    best = max(
        candidates,
        key=lambda candidate: (
            candidate["train"]["accuracyLift"],
            candidate["train"]["selectedAccuracy"],
            candidate["train"]["coverage"],
        ),
    )
    selected = best["selected"]
    calibration = selection_segment_metrics(
        observations,
        selected,
        train_end,
        calibration_end,
    )
    calibration_significance = selection_block_bootstrap(
        observations,
        selected,
        train_end,
        calibration_end,
    )
    calibration_passed = (
        best["train"]["accuracyLift"] >= 0.03
        and calibration["selected"] >= 100
        and calibration["coverage"] >= 0.08
        and calibration["accuracyLift"] >= 0.03
        and calibration_significance["accuracyLift"]["lower"] >= 0
    )
    test = selection_segment_metrics(
        observations,
        selected,
        calibration_end,
        len(rows),
    )
    test_significance = selection_block_bootstrap(
        observations,
        selected,
        calibration_end,
        len(rows),
    )
    test_passed = (
        calibration_passed
        and test["selected"] >= 100
        and test["coverage"] >= 0.08
        and test["accuracyLift"] >= 0.02
        and test_significance["accuracyLift"]["lower"] >= 0
    )
    if test_passed:
        reason = (
            "训练段选出的规则在中间20%和最新20%均提高命中率，"
            "且连续区块Bootstrap的95%下界不低于0"
        )
    elif not calibration_passed:
        reason = (
            "训练段筛选规则未能在中间20%稳定复现，"
            "本玩法不标记“建议预测”"
        )
    else:
        reason = (
            "规则通过中间20%验证，但未通过最新20%最终门禁，"
            "本玩法不标记“建议预测”"
        )
    return {
        "enabled": test_passed,
        "rule": best["rule"],
        "train": best["train"],
        "calibration": calibration,
        "calibrationSignificance": calibration_significance,
        "test": test,
        "testSignificance": test_significance,
        "gate": {
            "passed": test_passed,
            "calibrationPassed": calibration_passed,
            "testPassed": test_passed,
            "minimumTrainLift": 0.03,
            "minimumCalibrationLift": 0.03,
            "minimumTestLift": 0.02,
            "reason": reason,
        },
    }


def target_values(rows: list[dict[str, Any]], market: str) -> np.ndarray:
    field = {
        "spf": "spf_result",
        "hhad": "hhad_result",
        "goals": "actual_goals",
    }[market]
    labels = GOAL_LABELS if market == "goals" else OUTCOME_LABELS
    mapping = {label: index for index, label in enumerate(labels)}
    return np.asarray([mapping[str(row[field])] for row in rows], dtype=np.int32)


def temperature_scale(probabilities: np.ndarray, temperature: float) -> np.ndarray:
    safe = np.clip(probabilities, 1e-12, 1)
    logits = np.log(safe) / temperature
    logits -= logits.max(axis=1, keepdims=True)
    values = np.exp(logits)
    return values / values.sum(axis=1, keepdims=True)


def log_loss(probabilities: np.ndarray, actual: np.ndarray) -> float:
    selected = probabilities[np.arange(len(actual)), actual]
    return float(-np.log(np.clip(selected, 1e-12, 1)).mean())


def brier_score(probabilities: np.ndarray, actual: np.ndarray) -> float:
    expected = np.zeros_like(probabilities)
    expected[np.arange(len(actual)), actual] = 1
    return float(np.square(probabilities - expected).sum(axis=1).mean())


def accuracy_score_with_ties(
    probabilities: np.ndarray, actual: np.ndarray
) -> float:
    scores = []
    for row, target in zip(probabilities, actual):
        top = np.flatnonzero(np.isclose(row, row.max(), atol=1e-12))
        scores.append(1 / len(top) if target in top else 0)
    return float(np.mean(scores))


def metrics(probabilities: np.ndarray, actual: np.ndarray) -> dict[str, float]:
    return {
        "accuracy": accuracy_score_with_ties(probabilities, actual),
        "logLoss": log_loss(probabilities, actual),
        "brier": brier_score(probabilities, actual),
    }


def choose_temperature(
    probabilities: np.ndarray, actual: np.ndarray
) -> tuple[float, np.ndarray]:
    temperatures = np.linspace(0.5, 3.0, 101)
    candidates = [
        (float(value), temperature_scale(probabilities, float(value)))
        for value in temperatures
    ]
    return min(candidates, key=lambda item: log_loss(item[1], actual))


def train_market(
    x_train: np.ndarray,
    y_train: np.ndarray,
    x_calibration: np.ndarray,
    y_calibration: np.ndarray,
    market: str,
) -> tuple[RandomForestClassifier, float, dict[str, Any]]:
    results: list[dict[str, Any]] = []
    fitted: list[tuple[RandomForestClassifier, float, np.ndarray]] = []
    for index, candidate in enumerate(CANDIDATES):
        classifier = RandomForestClassifier(
            n_estimators=180,
            max_depth=candidate["max_depth"],
            min_samples_leaf=candidate["min_samples_leaf"],
            max_features=candidate["max_features"],
            random_state=RANDOM_SEED + index,
            n_jobs=-1,
        )
        classifier.fit(x_train, y_train)
        raw = classifier.predict_proba(x_calibration)
        temperature, calibrated = choose_temperature(raw, y_calibration)
        result = {
            **candidate,
            "temperature": temperature,
            "calibration": metrics(calibrated, y_calibration),
        }
        results.append(result)
        fitted.append((classifier, temperature, calibrated))
        print(
            f"  {market} {candidate['id']}: "
            f"acc={result['calibration']['accuracy']:.4f} "
            f"logloss={result['calibration']['logLoss']:.4f} "
            f"brier={result['calibration']['brier']:.4f} "
            f"T={temperature:.3f}"
        )
    selected_index = min(
        range(len(results)),
        key=lambda index: (
            results[index]["calibration"]["logLoss"],
            results[index]["calibration"]["brier"],
            -results[index]["calibration"]["accuracy"],
        ),
    )
    classifier, temperature, _ = fitted[selected_index]
    return classifier, temperature, {
        "selected": results[selected_index],
        "candidates": results,
    }


def spf_distance_matrix(history: np.ndarray, target: np.ndarray) -> np.ndarray:
    return np.max(np.abs(history / target - 1), axis=1)


def goal_probabilities_matrix(odds: np.ndarray) -> np.ndarray:
    implied = 1 / odds
    return implied / implied.sum(axis=1, keepdims=True)


def rolling_baseline(
    rows: list[dict[str, Any]],
    test_start: int,
    market: str,
    goal_events: dict[tuple[str, int], dict[str, Any]] | None = None,
) -> tuple[np.ndarray, np.ndarray, list[int]]:
    labels = GOAL_LABELS if market == "goals" else OUTCOME_LABELS
    field = {
        "spf": "spf_result",
        "hhad": "hhad_result",
        "goals": "actual_goals",
    }[market]
    label_index = {label: index for index, label in enumerate(labels)}
    if market == "goals":
        probabilities: list[np.ndarray] = []
        actual: list[int] = []
        test_indices: list[int] = []
        for target_index in range(test_start, len(rows)):
            row = rows[target_index]
            event = (goal_events or {}).get(
                (str(row["goal_source_file"]), int(row["goal_source_row"]))
            )
            pool = next(
                (
                    item
                    for item in (event or {}).get("pools", [])
                    if math.isclose(
                        float(item.get("fraction", 0)),
                        1.0,
                        abs_tol=1e-12,
                    )
                ),
                None,
            )
            values = np.asarray(
                pool.get("probabilities", []) if pool else [],
                dtype=float,
            )
            if values.shape != (8,) or not np.isfinite(values).all():
                continue
            probabilities.append(values / values.sum())
            actual.append(label_index[str(row[field])])
            test_indices.append(target_index - test_start)
        return np.asarray(probabilities), np.asarray(actual), test_indices

    prefix = "goal_f" if market == "goals" else f"{market}_f"
    size = 8 if market == "goals" else 3
    all_odds = np.asarray(
        [odds_vector(row, prefix, size) for row in rows],
        dtype=float,
    )
    all_actual = np.asarray(
        [label_index[str(row[field])] for row in rows],
        dtype=np.int32,
    )
    all_handicaps = np.asarray([int(row["handicap"]) for row in rows])
    probabilities: list[np.ndarray] = []
    actual: list[int] = []
    test_indices: list[int] = []

    for target_index in range(test_start, len(rows)):
        target_odds = all_odds[target_index]
        distances = spf_distance_matrix(
            all_odds[:target_index],
            target_odds,
        )
        mask = distances <= THRESHOLDS[market]
        if market == "hhad":
            mask &= (
                all_handicaps[:target_index] == all_handicaps[target_index]
            )
        matches = all_actual[:target_index][mask]
        if not len(matches):
            continue
        counts = np.bincount(matches, minlength=len(labels)).astype(float)
        probabilities.append(counts / counts.sum())
        actual.append(int(all_actual[target_index]))
        test_indices.append(target_index - test_start)
    return np.asarray(probabilities), np.asarray(actual), test_indices


def correct_scores(probabilities: np.ndarray, actual: np.ndarray) -> np.ndarray:
    result = []
    for row, target in zip(probabilities, actual):
        top = np.flatnonzero(np.isclose(row, row.max(), atol=1e-12))
        result.append(1 / len(top) if target in top else 0)
    return np.asarray(result, dtype=float)


def metric_deltas(
    challenger: np.ndarray,
    baseline: np.ndarray,
    actual: np.ndarray,
) -> dict[str, np.ndarray]:
    expected = np.zeros_like(challenger)
    expected[np.arange(len(actual)), actual] = 1
    return {
        "accuracy": correct_scores(challenger, actual)
        - correct_scores(baseline, actual),
        "logLoss": -np.log(
            np.clip(challenger[np.arange(len(actual)), actual], 1e-12, 1)
        )
        + np.log(
            np.clip(baseline[np.arange(len(actual)), actual], 1e-12, 1)
        ),
        "brier": np.square(challenger - expected).sum(axis=1)
        - np.square(baseline - expected).sum(axis=1),
    }


def percentile(values: list[float], probability: float) -> float:
    return float(np.quantile(np.asarray(values), probability))


def block_bootstrap(
    deltas: dict[str, np.ndarray],
    iterations: int = BOOTSTRAP_ITERATIONS,
    block_size: int = BOOTSTRAP_BLOCK_SIZE,
) -> dict[str, Any]:
    count = len(deltas["accuracy"])
    random = np.random.default_rng(RANDOM_SEED)
    samples = {name: [] for name in deltas}
    for _ in range(iterations):
        indices: list[int] = []
        while len(indices) < count:
            start = int(random.integers(0, count))
            take = min(block_size, count - len(indices))
            indices.extend((start + offset) % count for offset in range(take))
        selected = np.asarray(indices, dtype=int)
        for name, values in deltas.items():
            samples[name].append(float(values[selected].mean()))
    result = {}
    for name, values in deltas.items():
        bootstrap = samples[name]
        result[name] = {
            "delta": float(values.mean()),
            "lower": percentile(bootstrap, 0.025),
            "upper": percentile(bootstrap, 0.975),
        }
    return {
        "iterations": iterations,
        "blockSize": block_size,
        "confidence": 0.95,
        "metrics": result,
    }


def round_number(value: Any, digits: int = 10) -> float:
    return round(float(value), digits)


def export_forest(
    classifier: RandomForestClassifier,
    temperature: float,
    labels: list[str],
) -> dict[str, Any]:
    trees = []
    for estimator in classifier.estimators_:
        tree = estimator.tree_
        values = tree.value[:, 0, :]
        value_sums = values.sum(axis=1, keepdims=True)
        normalized = np.divide(
            values,
            value_sums,
            out=np.zeros_like(values),
            where=value_sums > 0,
        )
        trees.append(
            {
                "left": tree.children_left.astype(int).tolist(),
                "right": tree.children_right.astype(int).tolist(),
                "feature": tree.feature.astype(int).tolist(),
                "threshold": [round_number(value) for value in tree.threshold],
                "value": [
                    [round_number(probability) for probability in row]
                    for row in normalized
                ],
            }
        )
    return {
        "type": "random-forest",
        "labels": labels,
        "classes": [int(value) for value in classifier.classes_],
        "temperature": round_number(temperature),
        "trees": trees,
    }


def market_gate(
    challenger_metrics: dict[str, float],
    baseline_metrics: dict[str, float],
    significance: dict[str, Any],
) -> dict[str, Any]:
    delta_accuracy = (
        challenger_metrics["accuracy"] - baseline_metrics["accuracy"]
    )
    delta_log_loss = (
        challenger_metrics["logLoss"] - baseline_metrics["logLoss"]
    )
    delta_brier = challenger_metrics["brier"] - baseline_metrics["brier"]
    intervals = significance["metrics"]
    mean_passed = (
        delta_accuracy >= 0.01
        and delta_log_loss < 0
        and delta_brier < 0
    )
    significance_passed = (
        intervals["accuracy"]["lower"] >= 0
        and intervals["logLoss"]["upper"] < 0
        and intervals["brier"]["upper"] < 0
    )
    passed = mean_passed and significance_passed
    if passed:
        reason = (
            "最新20%命中率至少提高1个百分点，Log Loss和Brier同时改善，"
            "并通过95%连续区块Bootstrap门禁"
        )
    elif not mean_passed:
        reason = (
            "最新20%没有同时满足命中率至少提高1个百分点、"
            "Log Loss下降和Brier下降，继续保留历史相似模型"
        )
    else:
        reason = (
            "平均指标达到门槛，但95%连续区块Bootstrap仍不能排除随机波动，"
            "继续保留历史相似模型"
        )
    return {
        "passed": passed,
        "meanPassed": mean_passed,
        "significancePassed": significance_passed,
        "minimumAccuracyLift": 0.01,
        "reason": reason,
    }


def main() -> None:
    connection = sqlite3.connect(DATABASE_PATH)
    try:
        all_rows = read_rows(connection)
        updated_at = source_updated_at(connection)
    finally:
        connection.close()

    source_counts = Counter(str(row["spf_source_file"]) for row in all_rows)
    eligible_sources = {
        source for source, count in source_counts.items() if count >= MIN_SOURCE_ROWS
    }
    rows = [
        row for row in all_rows if str(row["spf_source_file"]) in eligible_sources
    ]
    rows.sort(key=lambda row: (str(row["spf_source_file"]), int(row["spf_source_row"])))
    if not rows:
        raise RuntimeError("没有满足最小样本要求的历史来源")

    train_end = int(len(rows) * 0.6)
    calibration_end = int(len(rows) * 0.8)
    train_rows = rows[:train_end]
    calibration_rows = rows[train_end:calibration_end]
    test_rows = rows[calibration_end:]
    included_sources = sorted(eligible_sources)
    spec = build_feature_spec(train_rows, included_sources)
    print("读取共享生产入口生成的总进球严格前序事件")
    goal_events, goal_event_meta = load_goal_production_events()
    print(
        f"  {goal_event_meta['events']:,} 个事件 · "
        f"{goal_event_meta['matchingVersion']}"
    )
    print("生成严格前序滚动的历史相似统计特征")
    rolling_history_features = historical_feature_matrix(
        rows,
        spec,
        goal_events,
    )
    history_feature_names = historical_feature_names(
        spec.historical_thresholds,
        spec.goal_pool_fractions,
    )

    print(
        f"统一样本 {len(all_rows):,} 场；主时序来源 {len(rows):,} 场；"
        f"训练 {len(train_rows):,} / 校准 {len(calibration_rows):,} / "
        f"测试 {len(test_rows):,}"
    )
    print(f"特征 {len(spec.names)} 项；联赛独热 {len(spec.leagues)} 项")

    x_all = np.vstack(
        [
            features_for_row(row, spec, rolling_history_features[index])
            for index, row in enumerate(rows)
        ]
    )
    x_train = x_all[:train_end]
    x_calibration = x_all[train_end:calibration_end]
    x_test = x_all[calibration_end:]

    generated_at = datetime.now(timezone.utc).isoformat()
    model_markets: dict[str, Any] = {}
    config_markets: dict[str, Any] = {}
    self_test_predictions: dict[str, list[float]] = {}
    labels_by_market = {
        "spf": OUTCOME_LABELS,
        "hhad": OUTCOME_LABELS,
        "goals": GOAL_LABELS,
    }

    for market in ["spf", "hhad", "goals"]:
        print(f"\n训练 {market} 挑战模型")
        y_train = target_values(train_rows, market)
        y_calibration = target_values(calibration_rows, market)
        y_test = target_values(test_rows, market)
        classifier, temperature, selection = train_market(
            x_train,
            y_train,
            x_calibration,
            y_calibration,
            market,
        )
        challenger_test = temperature_scale(
            classifier.predict_proba(x_test),
            temperature,
        )
        self_test_predictions[market] = [
            round_number(value) for value in challenger_test[0]
        ]
        baseline_test, baseline_actual, common_indices = rolling_baseline(
            rows,
            calibration_end,
            market,
            goal_events,
        )
        challenger_common = challenger_test[np.asarray(common_indices)]
        actual_common = y_test[np.asarray(common_indices)]
        if not np.array_equal(baseline_actual, actual_common):
            raise RuntimeError(f"{market} 基准测试标签与挑战模型不一致")

        challenger_metrics = metrics(challenger_common, actual_common)
        baseline_metrics = metrics(baseline_test, actual_common)
        deltas = metric_deltas(
            challenger_common,
            baseline_test,
            actual_common,
        )
        significance = block_bootstrap(deltas)
        gate = market_gate(
            challenger_metrics,
            baseline_metrics,
            significance,
        )
        print(
            f"测试：历史 acc={baseline_metrics['accuracy']:.4f} "
            f"logloss={baseline_metrics['logLoss']:.4f} "
            f"brier={baseline_metrics['brier']:.4f}"
        )
        print(
            f"      模型 acc={challenger_metrics['accuracy']:.4f} "
            f"logloss={challenger_metrics['logLoss']:.4f} "
            f"brier={challenger_metrics['brier']:.4f}"
        )
        print(f"门禁：{'通过' if gate['passed'] else '未通过'} · {gate['reason']}")

        labels = labels_by_market[market]
        model_markets[market] = {
            "enabled": False,
            "selectedCandidate": selection["selected"]["id"],
            "model": export_forest(classifier, temperature, labels),
        }
        config_markets[market] = {
            "selectedCandidate": selection["selected"]["id"],
            "temperature": temperature,
            "calibration": selection["selected"]["calibration"],
            "candidates": selection["candidates"],
            "test": {
                "evaluated": len(actual_common),
                "coverage": len(actual_common) / len(y_test),
                "baseline": baseline_metrics,
                "challenger": challenger_metrics,
                "delta": {
                    key: challenger_metrics[key] - baseline_metrics[key]
                    for key in ["accuracy", "logLoss", "brier"]
                },
            },
            "significance": significance,
            "gate": gate,
            "production": {
                "enabled": False,
                "candidateOnly": True,
                "runtimeEnabled": False,
                "policy": "historical-similarity",
                "reason": "离线挑战模型；未经独立门禁和用户明确批准不得上线",
            },
        }

    selection_markets: dict[str, Any] = {}
    print("\n选择性预测分层验证")
    for market in ["spf", "hhad", "goals"]:
        policy = tune_selection_policy(
            rows,
            rolling_history_features,
            history_feature_names,
            market,
            train_end,
            calibration_end,
        )
        selection_markets[market] = policy
        rule = policy["rule"]
        print(
            f"  {market}: {'通过' if policy['enabled'] else '未通过'} · "
            f"规则 样本≥{rule['minSamples']}、"
            f"最高概率≥{rule['minTopProbability']:.1%}、"
            f"领先≥{rule['minMargin']:.1%}、"
            f"{'要求方向稳定' if rule['requireStable'] else '不强制方向稳定'}；"
            f"校准 {policy['calibration']['selected']} 场 "
            f"{policy['calibration']['selectedAccuracy']:.1%}，"
            f"最新测试 {policy['test']['selected']} 场 "
            f"{policy['test']['selectedAccuracy']:.1%} "
            f"(覆盖 {policy['test']['coverage']:.1%})"
        )

    data_meta = {
        "database": DATABASE_PATH.name,
        "verifiedMatches": len(all_rows),
        "modelRows": len(rows),
        "sourceUpdatedAt": updated_at,
        "includedSources": sorted(eligible_sources),
        "goalMatchingVersion": goal_event_meta["matchingVersion"],
        "goalTrainingEvents": goal_event_meta["events"],
        "excludedSources": {
            source: count
            for source, count in source_counts.items()
            if source not in eligible_sources
        },
    }
    model_payload = {
        "version": 4,
        "generatedAt": generated_at,
        "candidateOnly": True,
        "runtimeEnabled": False,
        "data": data_meta,
        "featureSpec": {
            "names": spec.names,
            "leagues": spec.leagues,
            "historySources": spec.history_sources,
            "historicalThresholds": spec.historical_thresholds,
            "goalProductionMatching": True,
            "goalPoolFractions": spec.goal_pool_fractions,
            "goalMatchingVersion": goal_event_meta["matchingVersion"],
        },
        "selfTest": {
            "features": [round_number(value) for value in x_test[0]],
            "predictions": self_test_predictions,
        },
        "markets": model_markets,
    }
    config_payload = {
        "version": 4,
        "generatedAt": generated_at,
        "candidateOnly": True,
        "runtimeEnabled": False,
        "data": data_meta,
        "methodology": {
            "ordering": "主历史来源按 source_row 从小到大，最后一行视为最新",
            "split": "较早60%训练、中间20%选模型并做温度校准、最新20%只做最终测试",
            "features": (
                "三个玩法的初赔、终赔、去水概率、概率变化、返还率、"
                "让球数、进球期望、联赛独热编码，以及三个玩法在多档阈值下"
                "仅使用此前比赛计算的相似赛果占比、整数样本数、分布集中度和方向稳定性"
            ),
            "historicalFeatures": (
                "胜平负和让球胜平负分别匹配，不取三市场交集；"
                "总进球直接复用生产0球窗口、综合距离指数权重和25%/50%/75%/100%样本池；"
                "让球玩法只使用相同让球数；没有相似样本时使用均匀占位并提供缺失标记，"
                "1场或10场均保留真实占比及整数样本数"
            ),
            "missingOpeningOdds": (
                "缺失初赔用同场终赔填充，并增加初赔缺失标记"
            ),
            "baseline": (
                "最新20%每场仅使用同来源更早source_row；总进球基准直接来自共享生产入口"
            ),
            "goalOrdering": goal_event_meta["ordering"],
            "calibration": "只在中间20%选择模型参数及温度，不查看最新20%结果",
            "gate": (
                "最新20%命中率至少提高1个百分点，Log Loss与Brier同时下降，"
                "且95%连续20场区块Bootstrap确认改善"
            ),
            "marketsIndependent": (
                "三个目标分别训练；多市场赔率只作为赛前特征，不作为相似样本交集"
            ),
            "deployment": "只生成离线挑战报告；即使研究门禁通过也保持runtimeEnabled=false",
        },
        "split": {
            "train": len(train_rows),
            "calibration": len(calibration_rows),
            "test": len(test_rows),
        },
        "featureCount": len(spec.names),
        "leagueCount": len(spec.leagues),
        "searchSpace": CANDIDATES,
        "markets": config_markets,
        "selection": {
            "methodology": (
                "较早60%只用于选择筛选规则，中间20%验证规则能否复现，"
                "最新20%只做最终门禁；只使用赛前可见的相似样本数、"
                "最高历史占比、领先差和多阈值方向一致性"
            ),
            "labels": {
                "recommended": "建议预测",
                "cautious": "谨慎参考",
                "skip": "建议跳过",
            },
            "markets": selection_markets,
        },
    }

    MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    MODEL_PATH.write_text(
        json.dumps(model_payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    CONFIG_PATH.write_text(
        json.dumps(config_payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"\n模型已写入：{MODEL_PATH}")
    print(f"验证配置已写入：{CONFIG_PATH}")


if __name__ == "__main__":
    main()
