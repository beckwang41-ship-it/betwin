from __future__ import annotations

import json
import math
import re
from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data" / "processed"


def clean_text(value: object) -> str:
    if pd.isna(value):
        return ""
    return str(value).strip()


def clean_number(value: object) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return round(number, 4)


def valid_odds(values: list[float | None]) -> bool:
    return all(value is not None and value > 1 for value in values)


def result_from_score(score: object, existing: object) -> str:
    label = clean_text(existing)
    if label in {"胜", "平", "负"}:
        return label

    text = clean_text(score)
    encoded = {"-1:-H": "胜", "-1:-D": "平", "-1:-A": "负"}
    if text in encoded:
        return encoded[text]

    match = re.fullmatch(r"\s*(\d+)\s*[:：-]\s*(\d+)\s*", text)
    if not match:
        return ""
    home, away = map(int, match.groups())
    return "胜" if home > away else "平" if home == away else "负"


def total_goals_from_score(score: object) -> int | None:
    match = re.fullmatch(r"\s*(\d+)\s*[:：-]\s*(\d+)\s*", clean_text(score))
    if not match:
        return None
    return sum(map(int, match.groups()))


def build_spf_history() -> list[dict]:
    """
    从 history.xlsx 的「胜平负让球」工作表读取胜平负和让球数据。
    每条记录包含初始赔率和最终赔率。
    """
    records: list[dict] = []
    
    # 读取新的统一文件
    df = pd.read_excel(ROOT / "history.xlsx", sheet_name="胜平负让球")
    
    for source_row, (_, row) in enumerate(df.iterrows(), start=2):
        # 读取最终赔率（必需）
        final_odds = [
            clean_number(row.get("胜平负-最终-胜")),
            clean_number(row.get("胜平负-最终-平")),
            clean_number(row.get("胜平负-最终-负")),
        ]
        if not valid_odds(final_odds):
            continue
            
        # 读取初始赔率（可选）
        initial_odds = [
            clean_number(row.get("胜平负-初始-胜")),
            clean_number(row.get("胜平负-初始-平")),
            clean_number(row.get("胜平负-初始-负")),
        ]
        
        result = result_from_score(row.get("比分"), row.get("胜平负结果"))
        if not result:
            continue
            
        record = {
            "league": clean_text(row.get("联赛类型")),
            "home": clean_text(row.get("主队")),
            "away": clean_text(row.get("客队")),
            "score": clean_text(row.get("比分")),
            "result": result,
            "handicap": int(row.get("让球", 0)),
            "odds": final_odds,
            "initialOdds": initial_odds if valid_odds(initial_odds) else None,
            "totalGoals": total_goals_from_score(row.get("比分")),
            "source": "history.xlsx",
            "sourceFile": "history.xlsx",
            "sourceRow": source_row,
            "initialSourceFile": "history.xlsx" if valid_odds(initial_odds) else None,
            "initialSourceRow": source_row if valid_odds(initial_odds) else None,
        }
        records.append(record)
    
    return records


def build_hhad_history() -> list[dict]:
    """
    从 history.xlsx 的「胜平负让球」工作表读取让球数据。
    每条记录包含初始赔率和最终赔率。
    """
    records: list[dict] = []
    
    # 读取新的统一文件
    df = pd.read_excel(ROOT / "history.xlsx", sheet_name="胜平负让球")
    
    for source_row, (_, row) in enumerate(df.iterrows(), start=2):
        # 读取最终赔率（必需）
        final_odds = [
            clean_number(row.get("让球-最终-胜")),
            clean_number(row.get("让球-最终-平")),
            clean_number(row.get("让球-最终-负")),
        ]
        result = clean_text(row.get("让球结果"))
        if not valid_odds(final_odds) or result not in {"胜", "平", "负"}:
            continue
            
        # 读取初始赔率（可选）
        initial_odds = [
            clean_number(row.get("让球-初始-胜")),
            clean_number(row.get("让球-初始-平")),
            clean_number(row.get("让球-初始-负")),
        ]
        
        handicap = int(row.get("让球", 0))
        record = {
            "league": clean_text(row.get("联赛类型")),
            "home": clean_text(row.get("主队")),
            "away": clean_text(row.get("客队")),
            "score": clean_text(row.get("比分")),
            "result": result,
            "handicap": handicap,
            "odds": final_odds,
            "initialOdds": initial_odds if valid_odds(initial_odds) else None,
            "source": "history.xlsx",
            "sourceFile": "history.xlsx",
            "sourceRow": source_row,
            "initialSourceFile": "history.xlsx" if valid_odds(initial_odds) else None,
            "initialSourceRow": source_row if valid_odds(initial_odds) else None,
        }
        records.append(record)
    
    return records


def normalize_goal_label(value: object) -> str:
    if pd.isna(value):
        return ""
    text = str(value).strip()
    if text == "7+":
        return text
    try:
        number = int(float(text))
    except ValueError:
        return ""
    return str(number) if 0 <= number <= 6 else "7+"


def build_goal_history() -> list[dict]:
    """
    从 history.xlsx 的「总进球数」工作表读取进球数据。
    每条记录包含初始赔率和最终赔率。
    """
    records: list[dict] = []
    labels = ["0", "1", "2", "3", "4", "5", "6", "7+"]
    
    # 读取新的统一文件
    df = pd.read_excel(ROOT / "history.xlsx", sheet_name="总进球数")
    
    for source_row, (_, row) in enumerate(df.iterrows(), start=2):
        # 读取最终赔率（必需）
        final_odds = [clean_number(row.get(f"最终{label}进球赔率")) for label in labels]
        if not valid_odds(final_odds):
            continue
            
        goal = normalize_goal_label(row.get("进球数"))
        if not goal:
            continue
            
        # 读取初始赔率（可选）
        initial_odds = [clean_number(row.get(f"初始{label}进球赔率")) for label in labels]
        
        record = {
            "league": clean_text(row.get("联赛类型")),
            "home": clean_text(row.get("主队名")),
            "away": clean_text(row.get("客队名")),
            "goals": goal,
            "odds": final_odds,
            "initialOdds": initial_odds if valid_odds(initial_odds) else None,
            "source": "history.xlsx",
            "sourceFile": "history.xlsx",
            "sourceRow": source_row,
            "initialSourceFile": "history.xlsx" if valid_odds(initial_odds) else None,
            "initialSourceRow": source_row if valid_odds(initial_odds) else None,
        }
        records.append(record)
    
    return records


def save_json(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    spf = build_spf_history()
    goals = build_goal_history()
    save_json(OUTPUT / "historical_spf.json", spf)
    save_json(OUTPUT / "historical_goals.json", goals)
    print(f"胜平负历史：{len(spf):,} 场")
    print(f"总进球历史：{len(goals):,} 场")
    print(f"输出目录：{OUTPUT}")
