import json
import pandas as pd
import numpy as np
import math
import os
import shutil
import re
import logging
import joblib
import time
import hashlib
from datetime import datetime, timedelta
from collections import defaultdict, Counter
from dataclasses import dataclass, field
from typing import Dict, List, Tuple, Optional
from sklearn.calibration import CalibratedClassifierCV
from sklearn.neighbors import NearestNeighbors

# ================= 配置区域 =================
JSON_FILE = "realtime_matches_history.json"
HISTORY_FILE = "历史进球数.xlsx"
HISTORY_ENRICH_FILE = "lottery_goals_data_df1cda93.xlsx"
MATRIX_FILE = "league_matrix.json"
REPORT_FILE = "match_analysis_v82_pro.html" # [UPDATE] V82.0 Ultimate
REPORT_TEMPLATE_FILE = "report_template.html"
RECORD_DB_FILE = "match_predictions_record.json"
EXCEL_SHEET_FILE = "复盘账本.xlsx"
DAXIAO_FILE = "daxiaoqiu.xlsx"

# 模型文件
MODEL_FILE = "odds_brain_binary_sniper.model"
TRAP_MODEL_2 = "trap_hunter_2goals.model"
TRAP_MODEL_3 = "trap_hunter_3goals.model"
MULTI_LINE_MODEL = "ou_over_3lines_final_v2_1.model"
FILE_LEAGUE_AVG = "leaguegoals.xlsx"           # 联赛基准数据
FILE_TEAM_SPLIT = "allleagues_xg_xga.xlsx"     # 球队分项数据

#STATS_DATA_FILE = "goalshuju.xlsx"
TEAM_NAME_FILE = "teamname.json"
LOG_FILE = "n52goalfx.log"
FOREBET_CONTEXT_FILE = "forebet_context.json"
MATCH_NEWS_CONTEXT_FILE = "match_news_context.json"
GOALS_LLM_CACHE_FILE = "goals_llm_cache.json"
GOALS_LLM_DEFAULT_MAX_CALLS = 3
GOALS_LLM_UNSELECTED_HTML = ""

HIST_ODDS_COLS = ['0进球赔率', '1进球赔率', '2进球赔率', '3进球赔率', '4进球赔率', '5进球赔率', '6进球赔率', '7+进球赔率']
HIST_FINAL_ODDS_COLS_ALT = ['最终0进球赔率', '最终1进球赔率', '最终2进球赔率', '最终3进球赔率', '最终4进球赔率', '最终5进球赔率', '最终6进球赔率', '最终7+进球赔率']
HIST_INIT_ODDS_COLS = ['初始0进球赔率', '初始1进球赔率', '初始2进球赔率', '初始3进球赔率', '初始4进球赔率', '初始5进球赔率', '初始6进球赔率', '初始7+进球赔率']

V7_G0_TOL = 3.0
V7_NEIGHBORS = 100
V7_INIT_BLEND_WEIGHT = 0.10
V7_DRIFT_BLEND_WEIGHT = 0.15
V9_SEARCH_TOP_N = 650
V9_STRICT_MIN = 12
V9_SAME_LEAGUE_MIN = 20
V9_LIMIT_STRICT = 55
V9_LIMIT_MIX = 65
V9_DYNAMIC_LIMIT_RATIO = 0.52
V9_INIT_LOGIT_WEIGHT = 0.08
V9_INIT_XG_WEIGHT = 0.0
V9_DRIFT_WEIGHT = 0.0
V9_XG_DELTA_WEIGHT = 0.0
V9_INIT_MISSING_WEIGHT = 0.02
XG_TOL_LOW = 0.25
XG_TOL_HIGH = 0.30
HIST_XG_MIN_NEIGHBORS = 35
HIST_XG_MAX_NEIGHBORS = 120
HIST_XG_EXPAND_STEP = 0.05
HIST_XG_MAX_TOL = 0.85

BASE_WEIGHT_CONFIG = {
    "V9": 1.11, "Hist": 1.67, "V7": 0.55, "Poisson_Base": 1.63, "Matrix_Base": 2.5,
    "Trajectory": 1.5
}

# 组融合倍率（绝对+相对双通道）
FUSION_ABS_COEF = 0.30
FUSION_REL_COEF = 0.25
FUSION_REL_SCALE = 0.15
FUSION_BLEND_REL = 0.45
FUSION_RAW_MIN = 0.82
FUSION_RAW_MAX = 1.20
FUSION_MULT_MIN = 0.88
FUSION_MULT_MAX = 1.15

# [阈值配置]
BTS_HIGH_AVG = 0.55; BTS_LOW_AVG = 0.35
MIN_INVERSION_DEPTH = 0.15; MIN_MATRIX_SAMPLE = 10
MIN_INVERSION_DEPTH_P = 0.02
DEFORMATION_DEV_P = 0.03

LEAGUE_KEYWORDS = {
    "TIER_1": ["英超", "西甲", "德甲", "意甲", "法甲", "欧冠", "世界杯", "欧洲杯"],
    "TIER_2": ["英冠", "荷甲", "葡超", "日职", "韩职", "美职", "巴甲", "俄超", "土超", "比甲", "欧罗巴", "欧协联", "足总杯", "亚冠", "K联赛", "J联赛", "澳超"]
}

LEAGUE_GROUP_KEYWORDS = {
    "EURO_ELITE": ["英超", "西甲", "德甲", "意甲", "法甲", "欧冠", "欧罗巴", "欧协联", "欧洲杯", "世界杯", "足总杯"],
    "EURO_MID": ["英冠", "荷甲", "荷乙", "法乙", "德乙", "葡超", "比甲", "俄超", "土超", "挪超", "瑞超", "丹超"],
    "ASIA_OCEANIA": ["日职", "韩职", "亚冠", "K联赛", "J联赛", "澳超", "中超"],
    "AMERICAS": ["美职", "巴甲", "阿甲", "墨", "哥伦", "智利"],
}

LOW_CONF_ENABLE = True
LOW_CONF_MIN_TOP1 = 0.19
LOW_CONF_MIN_TOP2_SUM = 0.46
LOW_CONF_MIN_MARGIN = 0.06
LOW_CONF_MAX_AGREE_PAIRS = 2
LOW_CONF_MAX_TOP1_SUPPORT = 0
LOW_CONF_STAR_CAP = 1
LOW_CONF_REQUIRE_REASONS = 2
LOWCONF_RESCAN_THRESHOLD = 30
LOWCONF_SCAN_REPORT_FILE = "lowconf_threshold_scan.json"
LOWCONF_SCAN_CMD = 'python3 "lowconf_threshold_scan.py" --max-samples 300'

VOTE_M_HIST_TIEBREAK_ENABLE = False
VOTE_M_HIST_TIEBREAK_MAX_MATRIX_CONF = 0.18
VOTE_M_HIST_TIEBREAK_REQUIRE_HIST_TOP_WEIGHT = True

LEAGUE_GUARD_ENABLE = True
LEAGUE_GUARD_REPORT_FILE = "regression_report.json"
LEAGUE_GUARD_MIN_SAMPLES = 40
LEAGUE_GUARD_MAX_ACC_TOP2 = 0.40
LEAGUE_GUARD_FALLBACK = ["法甲", "亚冠精英", "葡超", "澳超", "亚洲杯23"]
LEAGUE_GUARD_STRICT_STRATEGIES = {"VOTE_M", "SLOPE"}
LEAGUE_GUARD_TRAJECTORY_MULT = 0.85
LEAGUE_GUARD_MATRIX_MULT = 0.88
LEAGUE_GUARD_STAR_CAP = 3
LEAGUE_GUARD_SNAPSHOT_ENABLE = True
LEAGUE_GUARD_DYN_MIN_SAMPLES = 12
LEAGUE_GUARD_RATIO_LEVEL1 = 0.985
LEAGUE_GUARD_RATIO_LEVEL2 = 0.960
LEAGUE_GUARD_RATIO_LEVEL3 = 0.930

DYN_WEIGHT_WINDOW = 220
DYN_WEIGHT_SNAPSHOT_FILE = "dynamic_weights_snapshot.json"
DYN_WEIGHT_EXPORT_ENABLE = True

REQUIRED_HISTORY_BASE_COLS = ['进球数', '联赛类型', '主队名', '客队名']
REQUIRED_HISTORY_COLS = REQUIRED_HISTORY_BASE_COLS + HIST_ODDS_COLS
REQUIRED_TEAM_SPLIT_COLS = ['球队', '联赛', '主场xG', '客场xG', '主场xGA', '客场xGA', '总体xG', '总体xGA']

def setup_logger():
    logger = logging.getLogger("n52goalfx")
    if logger.handlers:
        return logger
    logger.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")
    sh = logging.StreamHandler()
    sh.setFormatter(fmt)
    fh = logging.FileHandler(LOG_FILE, encoding='utf-8')
    fh.setFormatter(fmt)
    logger.addHandler(sh)
    logger.addHandler(fh)
    logger.propagate = False
    return logger

LOGGER = setup_logger()

def _read_table_head(path, nrows=1):
    if path.lower().endswith(".csv"):
        return pd.read_csv(path, nrows=nrows)
    return pd.read_excel(path, nrows=nrows)

def _find_first_col(columns, candidates):
    for c in candidates:
        if c in columns:
            return c
    return None

def force_single_thread_model(model, _seen=None):
    """Force sklearn-like estimators to n_jobs=1 to avoid per-call process pool churn."""
    if model is None:
        return
    if _seen is None:
        _seen = set()
    oid = id(model)
    if oid in _seen:
        return
    _seen.add(oid)

    try:
        if hasattr(model, "n_jobs"):
            model.n_jobs = 1
    except Exception:
        pass

    # Pipeline / wrapper structures
    try:
        if hasattr(model, "steps"):
            for _, step in model.steps:
                force_single_thread_model(step, _seen)
    except Exception:
        pass
    for attr in ("estimator", "base_estimator", "clf"):
        try:
            nested = getattr(model, attr, None)
            if nested is not None:
                force_single_thread_model(nested, _seen)
        except Exception:
            pass
    try:
        clfs = getattr(model, "clfs", None)
        if isinstance(clfs, dict):
            for item in clfs.values():
                force_single_thread_model(item, _seen)
    except Exception:
        pass

    # Ensembles / calibrated wrappers
    for attr in ("estimators_", "estimators", "calibrated_classifiers_"):
        try:
            coll = getattr(model, attr, None)
            if not coll:
                continue
            if isinstance(coll, dict):
                it = coll.values()
            else:
                it = coll
            for item in it:
                force_single_thread_model(item, _seen)
        except Exception:
            pass

def validate_runtime_inputs():
    required_files = [JSON_FILE, HISTORY_FILE, FILE_TEAM_SPLIT]
    missing = [f for f in required_files if not os.path.exists(f)]
    if missing:
        LOGGER.error("启动失败: 缺少必需文件 -> %s", ", ".join(missing))
        return False

    try:
        with open(JSON_FILE, "r", encoding="utf-8") as f:
            matches = json.load(f)
        if not isinstance(matches, list):
            LOGGER.error("启动失败: %s 必须是列表格式。", JSON_FILE)
            return False
    except Exception:
        LOGGER.exception("启动失败: 无法读取 %s", JSON_FILE)
        return False

    try:
        hist_head = _read_table_head(HISTORY_FILE, nrows=1)
        hist_head.columns = hist_head.columns.str.strip()
        miss_base = [c for c in REQUIRED_HISTORY_BASE_COLS if c not in hist_head.columns]
        has_std_odds = all(c in hist_head.columns for c in HIST_ODDS_COLS)
        has_alt_final_odds = all(c in hist_head.columns for c in HIST_FINAL_ODDS_COLS_ALT)
        if miss_base or not (has_std_odds or has_alt_final_odds):
            if miss_base:
                LOGGER.error("启动失败: %s 缺少基础列 -> %s", HISTORY_FILE, ", ".join(miss_base))
            else:
                LOGGER.error("启动失败: %s 缺少赔率列，需满足其一: 标准列或最终赔率列。", HISTORY_FILE)
            return False
    except Exception:
        LOGGER.exception("启动失败: 无法读取 %s 头部", HISTORY_FILE)
        return False

    try:
        team_head = _read_table_head(FILE_TEAM_SPLIT, nrows=1)
        team_head.columns = team_head.columns.str.strip()
        miss_team = [c for c in REQUIRED_TEAM_SPLIT_COLS if c not in team_head.columns]
        if miss_team:
            LOGGER.error("启动失败: %s 缺少列 -> %s", FILE_TEAM_SPLIT, ", ".join(miss_team))
            return False
    except Exception:
        LOGGER.exception("启动失败: 无法读取 %s 头部", FILE_TEAM_SPLIT)
        return False

    return True

# ================= 结构定义 =================
@dataclass
class AnalyzeOutput:
    weighted_recs: List[Dict]
    advice: Dict
    tier_label: str
    star_score: int
    dxg: float
    strategy_code: str
    final_rec: List[int]
    engines_raw: Dict
    matrix_meta: Optional[Dict]
    matrix_dist: Optional[List[float]]
    deformation_alert: Optional[Dict]
    extra: Dict = field(default_factory=dict)
    visuals: Dict = field(default_factory=dict) # [NEW] 专门存放视觉化组件HTML

    def __iter__(self):
        yield self.weighted_recs
        yield self.advice
        yield self.tier_label
        yield self.star_score
        yield self.dxg
        yield self.strategy_code
        yield self.final_rec
        yield self.engines_raw
        yield self.matrix_meta
        yield self.matrix_dist
        yield self.deformation_alert

@dataclass
class Over3LinesModel:
    feature_cols: List[str]
    odds_prefix_for_baseline: str
    events: List[Tuple[str, int]]
    alphas: Dict[str, float]
    clfs: Dict[str, object]

    def predict_over_probs(self, df_features: pd.DataFrame) -> pd.DataFrame:
        work_df = df_features.reindex(columns=self.feature_cols, fill_value=0.0)
        X = work_df[self.feature_cols]
        out = {}
        for name, _ in self.events: out[name] = self.clfs[name].predict_proba(X)[:, 1]
        return pd.DataFrame(out, index=work_df.index)

@dataclass
class TrapHunterModel:
    target_goals: int
    feature_cols: List[str]
    clf: CalibratedClassifierCV
    def predict_proba_df(self, df: pd.DataFrame) -> np.ndarray:
        work_df = df.copy()
        for col in self.feature_cols:
            if col not in work_df.columns: work_df[col] = 0.0
        X = work_df[self.feature_cols].copy()
        return self.clf.predict_proba(X)[:, 1]

# ================= 核心工具函数 =================
def advice_summary(advice: dict) -> dict:
    """Keep only small, backtest/useful fields to avoid bloating JSON."""
    if not isinstance(advice, dict):
        return {}

    out = {
        "type": advice.get("type"),
        "title": advice.get("title"),
        "action": advice.get("action"),
        "stars": advice.get("stars"),
    }

    # 可选：保留少量关键字段
    for k in ("math_tag", "tac_msg"):
        if k in advice:
            out[k] = advice.get(k)

    # what 有时很长，截断
    what = advice.get("what")
    if isinstance(what, str) and what:
        out["what"] = what[:200]

    return out

def odds_to_probs_fair(odds_list):
    try:
        raw = [1/x if x > 0 else 0 for x in odds_list]
        s = sum(raw)
        if s == 0: return [0]*8
        return [r/s for r in raw]
    except Exception:
        LOGGER.debug("odds_to_probs_fair 输入异常: %s", odds_list, exc_info=True)
        return [0]*8

def odds_to_probs(odds_list): return odds_to_probs_fair(odds_list)

def calculate_xg(probs):
    xg = 0; goals_val = [0, 1, 2, 3, 4, 5, 6, 7.5]
    for i, p in enumerate(probs): xg += p * goals_val[i]
    return xg


def _format_goal_bucket(goal):
    try:
        goal_val = int(float(goal))
    except Exception:
        return str(goal or "").strip() or "未知"
    return "7+球" if goal_val >= 7 else f"{goal_val}球"


def _goal_odds_dict(raw_odds):
    vals = list(raw_odds or [])
    out = {}
    for idx in range(8):
        try:
            odd = float(vals[idx] or 0)
        except Exception:
            odd = 0.0
        if odd <= 0:
            continue
        out[_format_goal_bucket(idx)] = round(odd, 2)
    return out


def _build_goals_recent_form_summary(anl_poisson):
    home_form = str(((anl_poisson or {}).get("h_stats") or {}).get("raw_form") or "").strip().upper()
    away_form = str(((anl_poisson or {}).get("a_stats") or {}).get("raw_form") or "").strip().upper()
    parts = []
    if home_form:
        parts.append(f"主近况{home_form}")
    if away_form:
        parts.append(f"客近况{away_form}")
    return "；".join(parts)


def _build_goals_recent_form_summary_from_forebet(forebet_context):
    trend = (forebet_context or {}).get("trend_context") or {}
    home = trend.get("home_form") or {}
    away = trend.get("away_form") or {}
    parts = []
    try:
        hm = int(home.get("matches") or 0)
        if hm > 0:
            parts.append(
                f"主近{hm}场{int(home.get('wins') or 0)}胜{int(home.get('draws') or 0)}平{int(home.get('losses') or 0)}负，"
                f"场均总进球{float(home.get('avg_total_goals') or 0):.2f}"
            )
    except Exception:
        pass
    try:
        am = int(away.get("matches") or 0)
        if am > 0:
            parts.append(
                f"客近{am}场{int(away.get('wins') or 0)}胜{int(away.get('draws') or 0)}平{int(away.get('losses') or 0)}负，"
                f"场均总进球{float(away.get('avg_total_goals') or 0):.2f}"
            )
    except Exception:
        pass
    notes = [str(x).strip() for x in (trend.get("notes") or []) if str(x).strip()]
    if notes and len(parts) < 3:
        parts.append(notes[0])
    return "；".join(parts[:3])


def _build_goals_team_stats_summary(anl_poisson, forebet_context=None):
    tech = (forebet_context or {}).get("technical_stats_context") or {}
    block = ((tech.get("home_away") or {}).get("all") or {}) if isinstance(tech, dict) else {}
    home = block.get("home") or {}
    away = block.get("away") or {}
    try:
        hp = float(home.get("played", 0) or 0)
        ap = float(away.get("played", 0) or 0)
        hgf = float(home.get("goals_for_per_game", 0) or 0)
        hga = float(home.get("goals_against_per_game", 0) or 0)
        agf = float(away.get("goals_for_per_game", 0) or 0)
        aga = float(away.get("goals_against_per_game", 0) or 0)
    except Exception:
        hp = ap = hgf = hga = agf = aga = 0.0
    parts = []
    if hp > 0 and ap > 0:
        parts.append(f"主攻vs客防{hgf:.2f} vs {aga:.2f}")
        parts.append(f"客攻vs主防{agf:.2f} vs {hga:.2f}")
        try:
            hover = float(home.get("over_2_5", 0) or 0) / hp if hp > 0 else 0.0
            aover = float(away.get("over_2_5", 0) or 0) / ap if ap > 0 else 0.0
            hbtts = float(home.get("btts_yes", 0) or 0) / hp if hp > 0 else 0.0
            abtts = float(away.get("btts_yes", 0) or 0) / ap if ap > 0 else 0.0
        except Exception:
            hover = aover = hbtts = abtts = 0.0
        if hover > 0 or aover > 0:
            parts.append(f"主场Over2.5{hover:.0%}，客场Over2.5{aover:.0%}")
        if hbtts > 0 or abtts > 0:
            parts.append(f"主场BTTS{hbtts:.0%}，客场BTTS{abtts:.0%}")
        return "，".join(parts[:4])

    h_stats = ((anl_poisson or {}).get("h_stats") or {}) if isinstance(anl_poisson, dict) else {}
    a_stats = ((anl_poisson or {}).get("a_stats") or {}) if isinstance(anl_poisson, dict) else {}

    parts = []
    try:
        hxg = float(h_stats.get("home_xg", 0) or 0)
        hxga = float(h_stats.get("home_xga", 0) or 0)
        axg = float(a_stats.get("away_xg", 0) or 0)
        axga = float(a_stats.get("away_xga", 0) or 0)
    except Exception:
        hxg = hxga = axg = axga = 0.0
    if hxg > 0 or hxga > 0 or axg > 0 or axga > 0:
        parts.append(f"主攻vs客防{hxg:.2f} vs {axga:.2f}")
        parts.append(f"客攻vs主防{axg:.2f} vs {hxga:.2f}")

    try:
        hbts = float(h_stats.get("bts", 0) or 0)
        abts = float(a_stats.get("bts", 0) or 0)
    except Exception:
        hbts = abts = 0.0
    if hbts > 0 or abts > 0:
        parts.append(f"BTTS均值{((hbts + abts) / 2.0):.0%}")

    try:
        lg_total = float(h_stats.get("lg_avg_total", 0) or a_stats.get("lg_avg_total", 0) or 0)
    except Exception:
        lg_total = 0.0
    if lg_total > 0:
        parts.append(f"联赛总进球基准{lg_total:.2f}")

    return "，".join(parts)


def _build_goals_injury_summary(match, forebet_context=None):
    lineup = (forebet_context or {}).get("lineup_injury") or {}
    if isinstance(lineup, dict):
        home_abs = [x for x in (lineup.get("home_absences") or []) if isinstance(x, dict)]
        away_abs = [x for x in (lineup.get("away_absences") or []) if isinstance(x, dict)]
        parts = []
        if home_abs:
            item = home_abs[0]
            parts.append(f"主队伤停：{str(item.get('name') or '').strip()}({str(item.get('role') or '').strip() or '未知位置'})")
        if away_abs:
            item = away_abs[0]
            parts.append(f"客队伤停：{str(item.get('name') or '').strip()}({str(item.get('role') or '').strip() or '未知位置'})")
        if parts:
            return "；".join(parts[:2])

    if not isinstance(match, dict):
        return ""
    for key in ("injury_summary", "injury_impact_summary"):
        text = str(match.get(key) or "").strip()
        if text:
            return text

    lineup = match.get("lineup_injury") or {}
    if isinstance(lineup, dict):
        summary = str(lineup.get("summary") or "").strip()
        if summary:
            return summary
    return ""


def load_forebet_context_map(path=FOREBET_CONTEXT_FILE):
    fp = os.path.abspath(path or FOREBET_CONTEXT_FILE)
    if not os.path.exists(fp):
        return {}
    try:
        with open(fp, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            return {str(k): v for k, v in data.items() if str(k) != "_meta" and isinstance(v, dict)}
    except Exception:
        LOGGER.exception("Forebet context 读取失败: %s", fp)
    return {}


def load_match_news_context_map(path=MATCH_NEWS_CONTEXT_FILE):
    fp = os.path.abspath(path or MATCH_NEWS_CONTEXT_FILE)
    if not os.path.exists(fp):
        return {}
    try:
        with open(fp, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            return {str(k): v for k, v in data.items() if str(k) != "_meta" and isinstance(v, dict)}
    except Exception:
        LOGGER.exception("赛前新闻缓存读取失败: %s", fp)
    return {}


def resolve_goals_forebet_context(forebet_context_map, match_id=None, match=None):
    if not isinstance(forebet_context_map, dict) or not forebet_context_map:
        return {}

    candidates = []
    if match_id is not None:
        candidates.append(str(match_id).strip())
    if isinstance(match, dict):
        for key in ("match_id", "id"):
            value = str(match.get(key) or "").strip()
            if value:
                candidates.append(value)
        embedded = match.get("forebet_context")
        if isinstance(embedded, dict):
            return embedded

    for key in candidates:
        if key and isinstance(forebet_context_map.get(key), dict):
            return forebet_context_map.get(key) or {}
    return {}


def resolve_goals_match_news_context(news_map, match_id=None, match=None, forebet_context=None):
    if not isinstance(news_map, dict) or not news_map:
        return {}

    candidates = []
    if match_id is not None:
        candidates.append(str(match_id).strip())
    if isinstance(match, dict):
        for key in ("match_id", "id"):
            value = str(match.get(key) or "").strip()
            if value:
                candidates.append(value)
        display_name = str(match.get("display_name") or "").strip()
        league = str(match.get("league") or "").strip()
        if " vs " in display_name:
            home, away = re.split(r"\s+vs\s+", display_name, maxsplit=1, flags=re.IGNORECASE)
            candidates.append("|".join([x for x in [home.strip(), away.strip(), league] if x]))
    if isinstance(forebet_context, dict):
        for key in ("match_key",):
            value = str(forebet_context.get(key) or "").strip()
            if value:
                candidates.append(value)
        home = str(forebet_context.get("home_team") or "").strip()
        away = str(forebet_context.get("away_team") or "").strip()
        league = str(forebet_context.get("league") or "").strip()
        if home and away:
            candidates.append("|".join([x for x in [home, away, league] if x]))

    for key in candidates:
        if key and isinstance(news_map.get(key), dict):
            return news_map.get(key) or {}
    return {}


def _env_flag(name, default=True):
    raw = os.environ.get(name)
    if raw is None:
        return bool(default)
    return str(raw).strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name, default=0):
    try:
        return int(float(os.environ.get(name, default) or default))
    except Exception:
        return int(default)


def should_run_goals_llm(star_score, final_rec, llm_calls=0):
    if not _env_flag("USE_GOALS_LLM", True):
        return False
    if not final_rec:
        return False
    min_star = _env_int("GOALS_LLM_MIN_STAR", 4)
    try:
        star = int(star_score or 0)
    except Exception:
        star = 0
    if star < min_star:
        return False
    max_calls = get_goals_llm_max_calls()
    if max_calls > 0 and int(llm_calls or 0) >= max_calls:
        return False
    return True


def get_goals_llm_max_calls():
    raw = os.environ.get("GOALS_LLM_MAX_CALLS")
    if raw is None:
        return GOALS_LLM_DEFAULT_MAX_CALLS
    try:
        return max(0, int(float(raw or 0)))
    except Exception:
        return GOALS_LLM_DEFAULT_MAX_CALLS


def score_goals_llm_task(task):
    task = task or {}
    try:
        star = int(task.get("star") or 0)
    except Exception:
        star = 0
    info = task.get("info") or {}
    local_ref = info.get("local_reference") or {}
    score = star * 100
    strategy = str(task.get("strategy") or "").strip().upper()
    if strategy == "VOTE_M":
        score += 30
    elif strategy == "VOTE_S":
        score += 18
    elif strategy:
        score += 10
    if str(info.get("recent_form_summary") or "").strip():
        score += 16
    if str(info.get("team_stats_summary") or "").strip():
        score += 14
    if str(info.get("injury_summary") or "").strip():
        score += 8
    if str(info.get("timeline_summary") or "").strip():
        score += 8
    if str(info.get("ou_market_summary") or "").strip():
        score += 8
    if str(info.get("ai_signal_summary") or "").strip():
        score += 6
    try:
        model_xg = float(local_ref.get("model_xg", 0) or 0)
        market_xg = float(local_ref.get("market_xg", 0) or 0)
        if abs(model_xg - market_xg) >= 0.25:
            score += 10
    except Exception:
        pass
    reason = f"{star}星 / {strategy or 'STD'} / 数据分{score - star * 100}"
    return score, reason


def select_goals_llm_tasks(tasks, limit=None):
    call_limit = get_goals_llm_max_calls() if limit is None else max(0, int(limit))
    ranked = []
    for order, task in enumerate(tasks or []):
        if not task:
            continue
        score, reason = score_goals_llm_task(task)
        ranked.append((score, -order, task, reason))
    ranked.sort(reverse=True)
    selected = ranked if call_limit <= 0 else ranked[:call_limit]
    selected_ids = {id(item[2]) for item in selected}
    return selected, selected_ids, len(ranked)


def load_goals_llm_cache(path=GOALS_LLM_CACHE_FILE):
    if not _env_flag("GOALS_LLM_CACHE", True):
        return {}
    fp = os.path.abspath(path or GOALS_LLM_CACHE_FILE)
    if not os.path.exists(fp):
        return {}
    try:
        with open(fp, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        LOGGER.exception("进球LLM缓存读取失败: %s", fp)
        return {}


def save_goals_llm_cache(cache, path=GOALS_LLM_CACHE_FILE):
    if not _env_flag("GOALS_LLM_CACHE", True) or not isinstance(cache, dict):
        return
    fp = os.path.abspath(path or GOALS_LLM_CACHE_FILE)
    try:
        with open(fp, "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False, indent=2)
    except Exception:
        LOGGER.exception("进球LLM缓存写入失败: %s", fp)


def build_goals_llm_cache_key(match_id, context, match_info, analyzer):
    provider_state = {
        "provider": getattr(analyzer, "provider", ""),
        "model": getattr(analyzer, "model", ""),
        "reasoning": bool(getattr(analyzer, "reasoning_enabled", False)),
        "effort": getattr(analyzer, "reasoning_effort", ""),
    }
    payload = {
        "match_id": str(match_id or ""),
        "provider": provider_state,
        "context": context or {},
        "match_info": match_info or {},
    }
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _build_goals_timeline_summary(timeline_analysis):
    data = timeline_analysis or {}
    if not data.get("active"):
        return ""
    parts = []
    try:
        drift = float(data.get("total_drift", 0.0) or 0.0)
    except Exception:
        drift = 0.0
    try:
        move = float(data.get("last_move", 0.0) or 0.0)
    except Exception:
        move = 0.0
    try:
        vol = float(data.get("vol", 0.0) or 0.0)
    except Exception:
        vol = 0.0

    if drift >= 0.05:
        parts.append("长期略偏大")
    elif drift <= -0.05:
        parts.append("长期略偏小")
    if data.get("rapid_confirmed"):
        parts.append("末段继续冲大" if move > 0 else "末段继续压小")
    elif abs(move) >= 0.02:
        parts.append("末段有明显动作")
    if vol >= 0.06:
        parts.append("波动较大")
    elif vol >= 0.03:
        parts.append("波动不小")
    return "，".join(parts)


def _build_goals_ai_signal_summary(ai_result=None, multi_res=None):
    parts = []
    ai_type = str((ai_result or {}).get("type") or "").strip().upper()
    try:
        prob_big = float((ai_result or {}).get("prob_big", 0) or 0)
    except Exception:
        prob_big = 0.0
    if ai_type == "BIG":
        parts.append(f"AI偏大球({prob_big:.0%})")
    elif ai_type == "SMALL":
        parts.append(f"AI偏小球({1 - prob_big:.0%})")

    if isinstance(multi_res, dict):
        for line in ("2.5", "3.5"):
            item = multi_res.get(line) or {}
            tag = str(item.get("tag") or "").strip().upper()
            if not tag:
                continue
            if tag == "VALUE":
                parts.append(f"O{line}价值可跟")
            elif tag == "TRAP":
                parts.append(f"O{line}谨防陷阱")
    return "，".join(parts[:3])


def build_goals_llm_context(
    match,
    odds_history,
    analyze_output,
    anl_v9,
    anl_v7,
    anl_xg,
    anl_poisson,
    ai_result=None,
    multi_res=None,
    ou_info=None,
    forebet_context=None,
    official_news=None,
):
    final = (odds_history or {}).get("final") or {}
    initial = (odds_history or {}).get("initial") or {}
    final_odds = [final.get(f"g{i}" if i < 7 else "g7plus", 0) for i in range(8)]
    init_odds = [initial.get(f"g{i}" if i < 7 else "g7plus", 0) for i in range(8)]
    final_probs = odds_to_probs_fair(final_odds)
    fused_dist8 = list(((analyze_output.extra or {}).get("fused_dist8") or [0.0] * 8))
    top_goal_probs = [
        {"goal": int(goal), "prob": float(prob)}
        for goal, prob in topk_from_dist8(fused_dist8, 3)
    ]
    local_reference = {
        "goal_picks": [int(x) for x in ((analyze_output.final_rec or [])[:2])],
        "goal_pick_probs": top_goal_probs,
        "model_xg": round(calculate_xg(fused_dist8), 2),
        "market_xg": round(calculate_xg(final_probs), 2),
        "engine_picks": {
            "V9": [int(x[0]) for x in ((anl_v9 or {}).get("top3") or [])[:2]],
            "Hist": [int(x[0]) for x in ((anl_xg or {}).get("top3") or [])[:2]],
            "V7": [int(x[0]) for x in ((anl_v7 or {}).get("top3") or [])[:2]],
            "Poisson": [int(x[0]) for x in ((anl_poisson or {}).get("top3") or [])[:2]],
        },
    }

    picks_text = "、".join([_format_goal_bucket(x) for x in local_reference["goal_picks"]]) or "暂无明确主路径"
    goal_path_summary = (
        f"本地{picks_text}主路径，融合分布"
        + "、".join([f"{_format_goal_bucket(item['goal'])}{item['prob']:.0%}" for item in top_goal_probs[:3]])
        + f"，模型xG {local_reference['model_xg']:.2f}，市场xG {local_reference['market_xg']:.2f}"
    )

    ou_market_summary = ""
    if ou_info:
        line_str = str(ou_info.get("line_str") or ou_info.get("line") or "").strip()
        over = str(ou_info.get("over") or "").strip()
        under = str(ou_info.get("under") or "").strip()
        pieces = []
        if line_str:
            pieces.append(f"大小球{line_str}")
        if over:
            pieces.append(f"大{over}")
        if under:
            pieces.append(f"小{under}")
        ou_market_summary = "，".join(pieces)

    advice = (analyze_output.advice or {}) if isinstance(analyze_output, AnalyzeOutput) else {}
    local_advice_summary = "；".join(
        [
            x for x in [
                str(advice.get("action") or "").strip(),
                str(advice.get("what") or "").strip(),
                str(advice.get("tac_msg") or "").strip(),
            ] if x
        ][:3]
    )

    return {
        "goal_odds_curr": _goal_odds_dict(final_odds),
        "goal_odds_init": _goal_odds_dict(init_odds),
        "goal_path_summary": goal_path_summary,
        "recent_form_summary": _build_goals_recent_form_summary_from_forebet(forebet_context) or _build_goals_recent_form_summary(anl_poisson),
        "team_stats_summary": _build_goals_team_stats_summary(anl_poisson, forebet_context=forebet_context),
        "injury_summary": _build_goals_injury_summary(match, forebet_context=forebet_context),
        "official_news": {"prefetch_news": official_news} if isinstance(official_news, dict) and official_news else {},
        "timeline_summary": _build_goals_timeline_summary((analyze_output.extra or {}).get("timeline_analysis") or {}),
        "ou_market_summary": ou_market_summary,
        "ai_signal_summary": _build_goals_ai_signal_summary(ai_result=ai_result, multi_res=multi_res),
        "local_advice_summary": local_advice_summary,
        "local_reference": local_reference,
    }

def poisson_probability(k, lamb):
    return (lamb ** k) * math.exp(-lamb) / math.factorial(k)

def get_league_tier(league_name):
    l_str = str(league_name).upper()
    for kw in LEAGUE_KEYWORDS["TIER_1"]:
        if kw in l_str: return 1, "Tier 1 · 豪门"
    for kw in LEAGUE_KEYWORDS["TIER_2"]:
        if kw in l_str: return 2, "Tier 2 · 杯赛"
    return 3, "Tier 3 · 野鸡"

def get_league_group(league_name):
    s = str(league_name or "").upper()
    for group, kws in LEAGUE_GROUP_KEYWORDS.items():
        for kw in kws:
            if kw in s:
                return group
    return "OTHER"

def _parse_record_datetime(date_str, ts_val):
    if ts_val is not None and str(ts_val).strip() != "":
        try:
            ts = float(ts_val)
            if ts > 1e12:
                ts /= 1000.0
            if ts > 0:
                return datetime.fromtimestamp(ts)
        except Exception:
            pass
    ds = str(date_str or "").strip()
    if not ds:
        return None
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S"):
        try:
            return datetime.strptime(ds, fmt)
        except Exception:
            continue
    return None

def parse_goal_value(v):
    if v is None:
        return None
    if isinstance(v, (int, np.integer)):
        g = int(v)
        return 7 if g >= 7 else (0 if g < 0 else g)
    if isinstance(v, float):
        if pd.isna(v):
            return None
        g = int(round(v))
        return 7 if g >= 7 else (0 if g < 0 else g)
    s = str(v).strip()
    if not s:
        return None
    s = s.replace("球", "").replace("+", "").strip()
    m = re.search(r"-?\d+", s)
    if not m:
        return None
    g = int(m.group(0))
    return 7 if g >= 7 else (0 if g < 0 else g)

def load_league_guard_names(report_file=LEAGUE_GUARD_REPORT_FILE):
    names = set(str(x).strip() for x in LEAGUE_GUARD_FALLBACK if str(x).strip())
    if not LEAGUE_GUARD_ENABLE:
        return names
    if not os.path.exists(report_file):
        return names
    try:
        with open(report_file, "r", encoding="utf-8") as f:
            obj = json.load(f)
        rows = obj.get("by_league") if isinstance(obj, dict) else None
        if isinstance(rows, list):
            for r in rows:
                if not isinstance(r, dict):
                    continue
                lg = str(r.get("league") or "").strip()
                n = int(r.get("n") or 0)
                acc = float(r.get("acc_top2") or 0.0)
                if lg and n >= LEAGUE_GUARD_MIN_SAMPLES and acc <= LEAGUE_GUARD_MAX_ACC_TOP2:
                    names.add(lg)
    except Exception:
        LOGGER.exception("联赛风控名单加载失败: %s", report_file)
    return names

def _guard_rule_from_level(level):
    lvl = int(level)
    if lvl >= 3:
        return {
            "level": 3,
            "trajectory_mult": 0.78,
            "matrix_mult": 0.83,
            "star_cap": 2,
            "strict_strategies": ["VOTE_M", "SLOPE", "VOTE_S"],
        }
    if lvl == 2:
        return {
            "level": 2,
            "trajectory_mult": LEAGUE_GUARD_TRAJECTORY_MULT,
            "matrix_mult": LEAGUE_GUARD_MATRIX_MULT,
            "star_cap": LEAGUE_GUARD_STAR_CAP,
            "strict_strategies": sorted(list(LEAGUE_GUARD_STRICT_STRATEGIES)),
        }
    return {
        "level": 1,
        "trajectory_mult": 0.92,
        "matrix_mult": 0.94,
        "star_cap": 4,
        "strict_strategies": ["VOTE_M"],
    }

def load_league_guard_profiles(report_file=LEAGUE_GUARD_REPORT_FILE, snapshot_file=DYN_WEIGHT_SNAPSHOT_FILE):
    profiles = {}
    base_names = load_league_guard_names(report_file=report_file)
    for lg in base_names:
        if not lg:
            continue
        rule = _guard_rule_from_level(2)
        rule["reasons"] = ["regression"]
        profiles[str(lg)] = rule

    if LEAGUE_GUARD_SNAPSHOT_ENABLE and os.path.exists(snapshot_file):
        try:
            with open(snapshot_file, "r", encoding="utf-8") as f:
                snap = json.load(f)
            lg_map = snap.get("league_weights") if isinstance(snap, dict) else None
            all_w = snap.get("all_weights", {}) if isinstance(snap, dict) else {}
            if isinstance(lg_map, dict):
                for lg, node in lg_map.items():
                    if str(lg).upper() == "ALL":
                        continue
                    if not isinstance(node, dict):
                        continue
                    samples = node.get("samples", {}) if isinstance(node.get("samples"), dict) else {}
                    min_s = min(
                        int(samples.get("v9", 0) or 0),
                        int(samples.get("v7", 0) or 0),
                        int(samples.get("hist", 0) or 0),
                    )
                    if min_s < LEAGUE_GUARD_DYN_MIN_SAMPLES:
                        continue
                    w = node.get("weights", {}) if isinstance(node.get("weights"), dict) else {}
                    ratios = []
                    for key in ("V9", "V7", "Hist", "Poisson_Base"):
                        lw = float(w.get(key, 0.0) or 0.0)
                        aw = float(all_w.get(key, 0.0) or 0.0)
                        if lw > 0 and aw > 0:
                            ratios.append(lw / aw)
                    if len(ratios) < 3:
                        continue
                    avg_ratio = float(sum(ratios) / len(ratios))
                    dyn_level = 0
                    if avg_ratio <= LEAGUE_GUARD_RATIO_LEVEL3:
                        dyn_level = 3
                    elif avg_ratio <= LEAGUE_GUARD_RATIO_LEVEL2:
                        dyn_level = 2
                    elif avg_ratio <= LEAGUE_GUARD_RATIO_LEVEL1:
                        dyn_level = 1
                    if dyn_level <= 0:
                        continue
                    prev = profiles.get(str(lg), {})
                    prev_level = int(prev.get("level", 0) or 0)
                    new_level = max(prev_level, dyn_level)
                    rule = _guard_rule_from_level(new_level)
                    reasons = list(prev.get("reasons", []))
                    reasons.append(f"dyn_ratio={avg_ratio:.3f}")
                    rule["reasons"] = sorted(list(set(reasons)))
                    rule["avg_ratio"] = avg_ratio
                    rule["dyn_min_samples"] = min_s
                    profiles[str(lg)] = rule
        except Exception:
            LOGGER.exception("联赛风控快照加载失败: %s", snapshot_file)
    return profiles

def get_guard_profile(league_name, guard_profiles):
    s = str(league_name or "").strip()
    if not s or not isinstance(guard_profiles, dict) or not guard_profiles:
        return None
    best = None
    best_key = ""
    best_level = -1
    for k, profile in guard_profiles.items():
        key = str(k or "").strip()
        if not key or key not in s:
            continue
        lvl = int((profile or {}).get("level", 0) or 0)
        if (lvl > best_level) or (lvl == best_level and len(key) > len(best_key)):
            best = dict(profile or {})
            best_key = key
            best_level = lvl
            best["matched_key"] = key
    return best

def is_guard_league(league_name, guard_names):
    s = str(league_name or "").strip()
    if not s or not guard_names:
        return False
    for g in guard_names:
        if g and g in s:
            return True
    return False

def remind_lowconf_rescan(record_data, threshold=LOWCONF_RESCAN_THRESHOLD, scan_report=LOWCONF_SCAN_REPORT_FILE):
    """
    提醒逻辑：
    - 读取上次 lowconf_threshold_scan.json 的 generated_at
    - 统计该时间之后新增了多少“已标注(result_goal存在)”比赛
    - 达到阈值时提醒重跑阈值扫描
    """
    try:
        rows = []
        if isinstance(record_data, dict):
            rows = list(record_data.values())
        elif isinstance(record_data, list):
            rows = record_data

        labeled_total = 0
        for r in rows:
            if parse_goal_value(r.get("result_goal")) is not None:
                labeled_total += 1

        if not os.path.exists(scan_report):
            if labeled_total >= int(threshold):
                msg = (
                    f"🔔 阈值扫描提醒：当前已标注 {labeled_total} 场，尚未发现扫描报告。"
                    f"建议执行：{LOWCONF_SCAN_CMD}"
                )
                print(msg)
                LOGGER.warning(msg)
            return

        with open(scan_report, "r", encoding="utf-8") as f:
            scan_obj = json.load(f)
        scan_dt = None
        if isinstance(scan_obj, dict):
            scan_dt = _parse_record_datetime(scan_obj.get("generated_at"), None)
        if scan_dt is None:
            return

        new_labeled = 0
        for r in rows:
            g = parse_goal_value(r.get("result_goal"))
            if g is None:
                continue
            r_dt = _parse_record_datetime(r.get("date"), r.get("timestamp"))
            if r_dt is not None and r_dt > scan_dt:
                new_labeled += 1

        if new_labeled >= int(threshold):
            msg = (
                f"🔔 阈值扫描提醒：自上次扫描后新增已标注 {new_labeled} 场(阈值 {threshold})。"
                f"建议执行：{LOWCONF_SCAN_CMD}"
            )
            print(msg)
            LOGGER.warning(msg)
    except Exception:
        LOGGER.exception("低置信阈值扫描提醒检查失败")

def get_matrix_range_key(g0):
    try:
        if g0 is None or pd.isna(g0) or g0 <= 0: return "unknown"
        g0 = float(g0)
    except Exception:
        LOGGER.debug("get_matrix_range_key 解析失败: %s", g0, exc_info=True)
        return "unknown"
    if g0 < 11.0: return "range_0_11"
    if g0 < 16.0: return "range_11_16"
    if g0 < 20.0: return "range_16_20"
    if g0 < 30.0: return "range_20_30"
    if g0 < 40.0: return "range_30_40"
    if g0 < 50.0: return "range_40_50"
    return "range_50_plus"

# ================= [NEW] SVG Sparkline 生成器 =================
def generate_sparkline_svg(data_series, width=100, height=25, color="#3b82f6"):
    """生成微型走势图的 SVG 代码"""
    if not data_series or len(data_series) < 2:
        return ""

    # 归一化数据到画布坐标
    min_val = min(data_series)
    max_val = max(data_series)
    range_val = max_val - min_val
    if range_val == 0: range_val = 1 # 避免除零

    points = []
    step_x = width / (len(data_series) - 1)

    for i, val in enumerate(data_series):
        x = i * step_x
        # y轴反转，数值大在上面
        y = height - ((val - min_val) / range_val * height)
        points.append(f"{x:.1f},{y:.1f}")

    points_str = " ".join(points)

    # 动态颜色：涨红跌蓝
    if data_series[-1] > data_series[0]: stroke_col = "#ef4444" # 红
    elif data_series[-1] < data_series[0]: stroke_col = "#3b82f6" # 蓝
    else: stroke_col = "#94a3b8" # 灰

    svg = f"""<svg width="{width}" height="{height}" viewBox="0 0 {width} {height}" fill="none" xmlns="http://www.w3.org/2000/svg">
    <polyline points="{points_str}" stroke="{stroke_col}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" fill="none"/>
    <circle cx="{points[-1].split(',')[0]}" cy="{points[-1].split(',')[1]}" r="2" fill="{stroke_col}" />
    </svg>"""
    return svg

# ================= 性能引擎：向量化搜索 =================
class FastSearchEngine:
    _instance = None
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(FastSearchEngine, cls).__new__(cls)
            cls._instance.initialized = False
        return cls._instance
    @staticmethod
    def _odds_to_probs_matrix(odds_matrix):
        with np.errstate(divide='ignore', invalid='ignore'):
            inv = np.divide(1.0, odds_matrix, out=np.zeros_like(odds_matrix, dtype=float), where=odds_matrix > 0)
        row_sums = inv.sum(axis=1, keepdims=True)
        return np.divide(inv, row_sums, out=np.zeros_like(inv), where=row_sums > 0)

    @staticmethod
    def _logit(p_arr):
        eps = 1e-5
        p_clip = np.clip(p_arr, eps, 1 - eps)
        return np.log(p_clip / (1 - p_clip))

    def _build_feature_matrix(self, final_probs, init_probs, init_missing_flag):
        goals = np.array([0, 1, 2, 3, 4, 5, 6, 7.5], dtype=float)
        xg_final = np.dot(final_probs, goals).reshape(-1, 1)
        xg_init = np.dot(init_probs, goals).reshape(-1, 1)
        xg_delta = xg_final - xg_init
        final_logits = self._logit(final_probs)
        drift = final_probs - init_probs
        parts = [final_logits, xg_final * 2.0]
        if V9_INIT_LOGIT_WEIGHT > 0:
            parts.append(self._logit(init_probs) * V9_INIT_LOGIT_WEIGHT)
        if V9_INIT_XG_WEIGHT > 0:
            parts.append(xg_init * V9_INIT_XG_WEIGHT)
        if V9_DRIFT_WEIGHT > 0:
            parts.append(drift * V9_DRIFT_WEIGHT)
        if V9_XG_DELTA_WEIGHT > 0:
            parts.append(xg_delta * V9_XG_DELTA_WEIGHT)
        if V9_INIT_MISSING_WEIGHT > 0:
            miss = init_missing_flag.reshape(-1, 1).astype(float)
            parts.append(miss * V9_INIT_MISSING_WEIGHT)
        return np.hstack(parts)

    def initialize(self, hist_df):
        if self.initialized: return
        self.hist_df = hist_df.reset_index(drop=True)

        final_odds = self.hist_df[HIST_ODDS_COLS].to_numpy(dtype=float)
        final_probs = self._odds_to_probs_matrix(final_odds)
        self.base_probs = final_probs

        has_hist_init = all(c in self.hist_df.columns for c in HIST_INIT_ODDS_COLS)
        if has_hist_init:
            init_odds = self.hist_df[HIST_INIT_ODDS_COLS].to_numpy(dtype=float)
            valid_init = np.all(init_odds > 0, axis=1)
        else:
            init_odds = np.zeros_like(final_odds)
            valid_init = np.zeros(final_odds.shape[0], dtype=bool)

        init_missing_flag = (~valid_init).astype(float)
        init_odds_filled = np.where(valid_init[:, None], init_odds, final_odds)
        init_probs = self._odds_to_probs_matrix(init_odds_filled)
        self.init_probs = init_probs
        self.init_missing_flag = init_missing_flag
        self.X_features = self._build_feature_matrix(final_probs, init_probs, init_missing_flag)

        try:
            cov_matrix = np.cov(self.X_features.T)
            reg_cov = cov_matrix + np.eye(cov_matrix.shape[0]) * 1e-6
            self.VI = np.linalg.inv(reg_cov)

            self.knn = NearestNeighbors(
                n_neighbors=80, algorithm='brute', metric='mahalanobis',
                metric_params={'VI': self.VI}, n_jobs=1
            )
            print(f"✅ [V9.3 Hyper] 索引构建完成 (终赔核心 + 可选初赔特征)")
        except Exception as e:
            print(f"⚠️ 马氏距离构建失败，回退至欧氏距离: {e}")
            self.knn = NearestNeighbors(n_neighbors=80, algorithm='ball_tree', metric='euclidean', n_jobs=1)

        self.knn.fit(self.X_features)
        self.initialized = True

    # ===== FastSearchEngine 内新增：构建 query 向量 =====
    def build_query_vector(self, target_odds_list, target_initial_odds=None):
        if not target_odds_list or len(target_odds_list) < 8:
            return None

        final_arr = np.array([(x if (x is not None and x > 0) else 0.0) for x in target_odds_list[:8]], dtype=float).reshape(1, -1)
        if final_arr.sum() <= 0:
            return None

        init_missing = 1.0
        init_arr = final_arr.copy()
        if isinstance(target_initial_odds, (list, tuple)) and len(target_initial_odds) >= 8:
            cand_init = np.array([(x if (x is not None and x > 0) else 0.0) for x in target_initial_odds[:8]], dtype=float).reshape(1, -1)
            if np.all(cand_init > 0):
                init_arr = cand_init
                init_missing = 0.0

        final_probs = self._odds_to_probs_matrix(final_arr)
        init_probs = self._odds_to_probs_matrix(init_arr)
        query_vector = self._build_feature_matrix(final_probs, init_probs, np.array([init_missing], dtype=float))
        return query_vector.reshape(1, -1)


    # ===== FastSearchEngine 内新增：对任意子集重算距离（筛选后也能用）=====
    def distances_to_rows(self, query_vector, row_idx):
        X = self.X_features[row_idx]
        q = query_vector.reshape(1, -1)
        diff = X - q

        # Mahalanobis
        if hasattr(self, "VI") and self.VI is not None:
            d2 = np.einsum("ij,jk,ik->i", diff, self.VI, diff)
            d2 = np.maximum(d2, 0.0)
            return np.sqrt(d2)

        # Euclidean fallback
        return np.sqrt(np.sum(diff * diff, axis=1))

# ===== 替换原 search_v9 =====
    def search_v9(self, target_odds_list, target_initial_odds=None, top_n=50):
        if not self.initialized:
            return (pd.DataFrame(), np.array([]), np.array([], dtype=int))

        query_vector = self.build_query_vector(target_odds_list, target_initial_odds=target_initial_odds)
        if query_vector is None:
            return (pd.DataFrame(), np.array([]), np.array([], dtype=int))

        n_fit = int(len(getattr(self, "hist_df", [])) or 0)
        if n_fit <= 0:
            return (pd.DataFrame(), np.array([]), np.array([], dtype=int))
        n_query = max(1, min(int(top_n), n_fit))

        distances, indices = self.knn.kneighbors(query_vector, n_neighbors=n_query)
        row_idx = indices[0].astype(int)
        dists = distances[0].astype(float)

        df = self.hist_df.iloc[row_idx].copy()
        # 把“真实行号”和“距离”带出来，便于后续筛选再对齐
        df["_v9_row"] = row_idx
        df["_v9_dist"] = dists
        return (df, dists, row_idx)


# ================= 动态权重调节器 =================
class DynamicWeightAdjuster:
    """
    稳健动态权重调节器（保留原功能口径，但加入：
    - 有样本才动（min_n）
    - 收缩（n/(n+shrink_k)）
    - Beta 平滑（避免小样本极端）
    - 调整幅度限制（clamp）
    - 相关性惩罚（Top2 长期高度一致则惩罚冗余引擎）
    """
    def __init__(self, record_file, min_n: int = 12, shrink_k: int = 24,
                 clamp_low: float = 0.85, clamp_high: float = 1.20,
                 corr_thr: float = 0.80, corr_floor: float = 0.80,
                 recent_n: int = DYN_WEIGHT_WINDOW,
                 snapshot_file: str = DYN_WEIGHT_SNAPSHOT_FILE,
                 export_snapshot: bool = DYN_WEIGHT_EXPORT_ENABLE):
        self.record_file = record_file
        self.min_n = int(min_n)
        self.shrink_k = float(shrink_k)
        self.clamp_low = float(clamp_low)
        self.clamp_high = float(clamp_high)
        self.corr_thr = float(corr_thr)
        self.corr_floor = float(corr_floor)
        self.recent_n = int(recent_n)
        self.snapshot_file = snapshot_file
        self.export_snapshot = bool(export_snapshot)

        # acc: league -> eng -> posterior_mean_acc
        self.stats = {}
        # n: league -> eng -> n
        self.ns = defaultdict(dict)
        # pair: league -> (e1,e2) -> (avg_jaccard, n)
        self.pairs = defaultdict(dict)
        # tier level stats
        self.tier_stats = {}
        self.tier_ns = defaultdict(dict)
        self.tier_pairs = defaultdict(dict)
        # fusion: (league_group, strategy) -> eng -> posterior_mean_acc
        self.fusion_stats = {}
        self.fusion_ns = defaultdict(dict)
        # precomputed weight cache
        self.weight_cache_league = {}
        self.weight_cache_tier = {}
        self.weight_cache_all = BASE_WEIGHT_CONFIG.copy()
        self._load_stats()

    def _iter_records(self, data):
        if isinstance(data, dict):
            return list(data.values())
        if isinstance(data, list):
            return data
        return []

    def _extract_true_goal(self, match: dict):
        # 尽量兼容你历史 record 的字段
        for k in ["result_goal", "true_goal", "goal", "result", "final_goal"]:
            v = match.get(k)
            if v is not None and v != "":
                try:
                    return int(v)
                except Exception:
                    pass
        return None

    def _extract_top2(self, pred):
        # pred 可能是 [..] 或 {"top2":[..]} 等
        if pred is None:
            return None
        if isinstance(pred, (list, tuple)):
            if len(pred) >= 2:
                try:
                    return [int(pred[0]), int(pred[1])]
                except Exception:
                    return None
            return None
        if isinstance(pred, dict):
            for k in ["top2", "final_rec", "rec", "pick", "pred"]:
                v = pred.get(k)
                if isinstance(v, (list, tuple)) and len(v) >= 2:
                    try:
                        return [int(v[0]), int(v[1])]
                    except Exception:
                        return None
        return None

    def _record_sort_key(self, rec: dict) -> float:
        ts_val = rec.get("timestamp")
        if ts_val is not None and str(ts_val).strip() != "":
            try:
                ts = float(ts_val)
                if ts > 1e12:
                    ts /= 1000.0
                if ts > 0:
                    return ts
            except Exception:
                pass
        ds = str(rec.get("date") or "").strip()
        if ds:
            for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S"):
                try:
                    return datetime.strptime(ds, fmt).timestamp()
                except Exception:
                    continue
        return 0.0

    def _posterior_acc(self, hits):
        n = len(hits)
        if n <= 0:
            return None, 0
        s = sum(hits)
        acc = (s + 1.0) / (n + 2.0)
        return float(acc), int(n)

    def _build_post_stats(self, hit_map):
        stats = {}
        ns = defaultdict(dict)
        for bucket, eng_map in hit_map.items():
            stats.setdefault(bucket, {})
            for eng, hits in eng_map.items():
                acc, n = self._posterior_acc(hits)
                ns[bucket][eng] = int(n)
                if acc is not None:
                    stats[bucket][eng] = float(acc)
        return stats, ns

    def _build_pair_stats(self, pair_js_map):
        pairs = defaultdict(dict)
        for bucket, pair_map in pair_js_map.items():
            for pair, js_list in pair_map.items():
                if not js_list:
                    continue
                pairs[bucket][pair] = (float(sum(js_list) / len(js_list)), int(len(js_list)))
        return pairs

    def _compute_weights_from_maps(self, perf, nmap, pairmap):
        weights = BASE_WEIGHT_CONFIG.copy()
        eng2cfg = {
            "v9": "V9",
            "v7": "V7",
            "hist": "Hist",
            "poisson": "Poisson_Base",
        }

        post_acc = {}
        for eng, cfg_key in eng2cfg.items():
            n = int(nmap.get(eng, 0) or 0)
            acc = perf.get(eng, None)
            if acc is None or n < self.min_n:
                post_acc[eng] = None
                continue
            post_acc[eng] = float(acc)
            raw = 1.0 + 0.40 * ((acc - 0.50) * 2.0)
            raw = max(self.clamp_low, min(self.clamp_high, raw))
            strength = self._shrink_strength(n)
            mult = 1.0 + strength * (raw - 1.0)
            mult = max(self.clamp_low, min(self.clamp_high, mult))
            weights[cfg_key] *= mult

        for (e1, e2), (avg_j, pn) in pairmap.items():
            if pn < self.min_n or avg_j < self.corr_thr:
                continue
            a1 = post_acc.get(e1, None)
            a2 = post_acc.get(e2, None)
            if a1 is None or a2 is None:
                continue
            weaker = e1 if a1 < a2 else e2
            cfg_key = eng2cfg.get(weaker)
            if not cfg_key:
                continue
            strength = self._shrink_strength(int(pn))
            pen = 1.0 - 0.12 * strength
            pen = max(self.corr_floor, pen)
            weights[cfg_key] *= pen

        return weights

    def _pick_weight_bucket(self, league_name):
        lg = str(league_name or "")
        if lg in self.weight_cache_league:
            return dict(self.weight_cache_league[lg])
        tier = get_league_tier(lg)[0]
        tier_key = f"T{tier}"
        if tier_key in self.weight_cache_tier:
            return dict(self.weight_cache_tier[tier_key])
        if "ALL" in self.weight_cache_league:
            return dict(self.weight_cache_league["ALL"])
        return BASE_WEIGHT_CONFIG.copy()

    def _export_snapshot_file(self):
        if not self.export_snapshot or not self.snapshot_file:
            return
        try:
            payload = {
                "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "recent_n": self.recent_n,
                "min_n": self.min_n,
                "clamp_low": self.clamp_low,
                "clamp_high": self.clamp_high,
                "corr_thr": self.corr_thr,
                "corr_floor": self.corr_floor,
                "league_weights": {},
                "tier_weights": {},
                "all_weights": self.weight_cache_all,
            }
            for lg, w in self.weight_cache_league.items():
                payload["league_weights"][lg] = {
                    "weights": w,
                    "samples": dict(self.ns.get(lg, {})),
                    "acc": dict(self.stats.get(lg, {})),
                }
            for tk, w in self.weight_cache_tier.items():
                payload["tier_weights"][tk] = {
                    "weights": w,
                    "samples": dict(self.tier_ns.get(tk, {})),
                    "acc": dict(self.tier_stats.get(tk, {})),
                }
            with open(self.snapshot_file, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, indent=2)
        except Exception:
            LOGGER.exception("动态权重快照写入失败: %s", self.snapshot_file)

    def _load_stats(self):
        if not os.path.exists(self.record_file):
            return
        try:
            with open(self.record_file, 'r', encoding='utf-8') as f:
                data = json.load(f)

            items = self._iter_records(data)
            items = sorted(items, key=self._record_sort_key, reverse=True)[:self.recent_n]

            # league_hits[lg][eng] = list[int]
            league_hits = defaultdict(lambda: defaultdict(list))
            # tier_hits[T1/T2/T3/ALL][eng] = list[int]
            tier_hits = defaultdict(lambda: defaultdict(list))
            # 用于相关性：league_pair_js[lg][(e1,e2)] = list[float]
            league_pair_js = defaultdict(lambda: defaultdict(list))
            # 用于相关性：tier_pair_js[T1/T2/T3/ALL][(e1,e2)] = list[float]
            tier_pair_js = defaultdict(lambda: defaultdict(list))
            # 分组融合命中：bucket=(group,strategy) -> eng -> list[int]
            fusion_hits = defaultdict(lambda: defaultdict(list))

            for match in items:
                lg = match.get('league', 'Unknown')
                tier_key = f"T{get_league_tier(lg)[0]}"
                lg_group = get_league_group(lg)
                strat = str(match.get('strategy', 'STD') or 'STD').upper()
                res = self._extract_true_goal(match)
                if res is None:
                    continue

                engines = match.get('engines', {}) or {}
                # 统一 key（你原脚本常见：v9/v7/hist/poisson）
                preds = {}
                for eng_name, pred in engines.items():
                    key = str(eng_name).lower()
                    top2 = self._extract_top2(pred)
                    if top2:
                        preds[key] = top2
                        hit = 1 if (res in top2[:2]) else 0
                        league_hits[lg][key].append(hit)
                        league_hits['ALL'][key].append(hit)
                        tier_hits[tier_key][key].append(hit)
                        tier_hits['ALL'][key].append(hit)
                        fusion_hits[(lg_group, strat)][key].append(hit)
                        fusion_hits[(lg_group, "ALL")][key].append(hit)
                        fusion_hits[("ALL", strat)][key].append(hit)
                        fusion_hits[("ALL", "ALL")][key].append(hit)

                # pairwise jaccard
                keys = list(preds.keys())
                for i in range(len(keys)):
                    for j in range(i+1, len(keys)):
                        a = set(preds[keys[i]])
                        b = set(preds[keys[j]])
                        inter = len(a & b)
                        union = len(a | b)
                        js = (inter / union) if union > 0 else 0.0
                        league_pair_js[lg][(keys[i], keys[j])].append(js)
                        league_pair_js['ALL'][(keys[i], keys[j])].append(js)
                        tier_pair_js[tier_key][(keys[i], keys[j])].append(js)
                        tier_pair_js['ALL'][(keys[i], keys[j])].append(js)

            self.stats, self.ns = self._build_post_stats(league_hits)
            self.tier_stats, self.tier_ns = self._build_post_stats(tier_hits)
            self.pairs = self._build_pair_stats(league_pair_js)
            self.tier_pairs = self._build_pair_stats(tier_pair_js)

            for bucket, eng_map in fusion_hits.items():
                self.fusion_stats.setdefault(bucket, {})
                for eng, hits in eng_map.items():
                    n = len(hits)
                    self.fusion_ns[bucket][eng] = n
                    if n == 0:
                        continue
                    s = sum(hits)
                    acc = (s + 1.0) / (n + 2.0)
                    self.fusion_stats[bucket][eng] = float(acc)

            self.weight_cache_league = {}
            self.weight_cache_tier = {}
            for lg, perf in self.stats.items():
                nmap = self.ns.get(lg, {})
                pairmap = self.pairs.get(lg, {})
                self.weight_cache_league[lg] = self._compute_weights_from_maps(perf, nmap, pairmap)
            for tk, perf in self.tier_stats.items():
                nmap = self.tier_ns.get(tk, {})
                pairmap = self.tier_pairs.get(tk, {})
                self.weight_cache_tier[tk] = self._compute_weights_from_maps(perf, nmap, pairmap)
            self.weight_cache_all = self.weight_cache_league.get("ALL", BASE_WEIGHT_CONFIG.copy())
            self._export_snapshot_file()

            print(
                f"📊 [Turbo] 动态权重已校准 (window={self.recent_n}, "
                f"league={max(0, len(self.stats)-1)}, tier={max(0, len(self.tier_stats)-1)})"
            )
        except Exception as e:
            print(f"⚠️ 动态权重加载失败: {e}")

    def _shrink_strength(self, n: int) -> float:
        return float(n) / float(n + self.shrink_k) if n > 0 else 0.0

    def get_adjusted_weights(self, league_name):
        return self._pick_weight_bucket(league_name)

    def get_fusion_multipliers(self, league_name, strategy_code):
        eng2cfg = {
            "v9": "V9",
            "v7": "V7",
            "hist": "Hist",
            "poisson": "Poisson_Base",
        }
        out = {cfg: 1.0 for cfg in eng2cfg.values()}
        group = get_league_group(league_name)
        strat = str(strategy_code or "ALL").upper()
        buckets = [(group, strat), (group, "ALL"), ("ALL", strat), ("ALL", "ALL")]

        selected = {}
        min_req_n = max(8, self.min_n // 2)
        for eng in eng2cfg.keys():
            acc = None
            n = 0
            for b in buckets:
                st_map = self.fusion_stats.get(b, {})
                if eng not in st_map:
                    continue
                n = int(self.fusion_ns.get(b, {}).get(eng, 0) or 0)
                if n >= min_req_n:
                    acc = float(st_map[eng])
                    break
            if acc is not None:
                selected[eng] = {"acc": acc, "n": n}

        peer_mean = None
        if len(selected) >= 2:
            peer_mean = float(np.mean([v["acc"] for v in selected.values()]))

        for eng, cfg_key in eng2cfg.items():
            row = selected.get(eng)
            if not row:
                continue

            acc = float(row["acc"])
            n = int(row["n"])
            strength = float(n) / float(n + max(12, self.shrink_k))

            # 绝对命中率通道（跨策略可比）
            raw_abs = 1.0 + FUSION_ABS_COEF * ((acc - 0.50) * 2.0)

            # 相对同桶通道（同策略内拉开强弱，避免“全员<0.5时都被一起压低”）
            raw = raw_abs
            if peer_mean is not None:
                rel = (acc - peer_mean) / max(1e-9, FUSION_REL_SCALE)
                raw_rel = 1.0 + FUSION_REL_COEF * rel
                raw = ((1.0 - FUSION_BLEND_REL) * raw_abs) + (FUSION_BLEND_REL * raw_rel)

            raw = max(FUSION_RAW_MIN, min(FUSION_RAW_MAX, raw))
            mult = 1.0 + strength * (raw - 1.0)
            mult = max(FUSION_MULT_MIN, min(FUSION_MULT_MAX, mult))
            out[cfg_key] = mult

        out["__group__"] = group
        out["__strategy__"] = strat
        return out

# ================= 三线指挥官 (MultiLineAnalyst) =================
class MultiLineAnalyst:
    def __init__(self, model_path=MULTI_LINE_MODEL):
        self.active = False; self.model = None
        if os.path.exists(model_path):
            try:
                self.model = joblib.load(model_path)
                force_single_thread_model(self.model)
                self.active = True
                print(f"✅ 三线指挥官已就位")
            except Exception:
                LOGGER.exception("三线模型加载崩溃: %s", model_path)
    def _calculate_features(self, initial_odds, final_odds):
        def get_metrics(odds):
            safe_odds = [x if x > 0 else 0.01 for x in odds]
            raw_probs = np.array([1/x for x in safe_odds])
            overround = raw_probs.sum()
            probs = raw_probs / overround if overround > 0 else raw_probs
            xg = np.sum(probs * np.array([0, 1, 2, 3, 4, 5, 6, 7.5]))
            entropy = -np.sum(probs * np.log2(probs + 1e-9))
            return xg, entropy, overround, probs
        i_xg, i_ent, i_mar, i_probs = get_metrics(initial_odds)
        f_xg, f_ent, f_mar, f_probs = get_metrics(final_odds)
        feat = {}
        feat['init_xg'] = i_xg; feat['final_xg'] = f_xg; feat['xg_trend'] = f_xg - i_xg
        feat['initial_entropy'] = i_ent; feat['final_entropy'] = f_ent; feat['entropy_change'] = f_ent - i_ent
        feat['init_overround'] = i_mar; feat['final_overround'] = f_mar; feat['overround_change'] = f_mar - i_mar
        feat['gap_2_3_init'] = initial_odds[2] - initial_odds[3]
        feat['gap_2_3_final'] = final_odds[2] - final_odds[3]
        feat['gap_2_3_trend'] = feat['gap_2_3_final'] - feat['gap_2_3_init']
        for idx in range(8):
            feat[f'init_p{idx}'] = i_probs[idx]; feat[f'final_p{idx}'] = f_probs[idx]
            i_o = initial_odds[idx] if initial_odds[idx] > 0 else 1
            f_o = final_odds[idx]; feat[f'chg_pct_{idx}'] = (f_o - i_o) / i_o
        return feat
    def analyze(self, initial_odds, final_odds):
        if not self.active or sum(final_odds) == 0: return None
        if sum(initial_odds) == 0: initial_odds = final_odds
        feat_dict = self._calculate_features(initial_odds, final_odds)
        df_feat = pd.DataFrame(feat_dict, index=[0])
        f_probs = [feat_dict[f'final_p{i}'] for i in range(8)]
        imp_o15 = 1.0 - (f_probs[0] + f_probs[1])
        imp_o25 = 1.0 - (f_probs[0] + f_probs[1] + f_probs[2])
        imp_o35 = 1.0 - (f_probs[0] + f_probs[1] + f_probs[2] + f_probs[3])
        implied_map = {'Over1.5': imp_o15, 'Over2.5': imp_o25, 'Over3.5': imp_o35}
        results = {}
        try:
            preds = self.model.predict_over_probs(df_feat)
            for name, _ in self.model.events:
                line = name.replace("Over", "")
                model_prob = preds.iloc[0][name]
                alpha = self.model.alphas.get(name, 0.5)
                implied = implied_map.get(name, 0)
                blend_prob = alpha * model_prob + (1 - alpha) * implied
                edge = blend_prob - implied
                tag = "NORM"; thr = 0.05
                if edge >= thr: tag = "VALUE"
                elif edge <= -thr: tag = "TRAP"
                results[line] = {"tag": tag, "edge": edge, "prob": blend_prob, "imp": implied}
        except Exception:
            LOGGER.exception("三线指挥官推理失败")
            return None
        return results

# ================= AI 陷阱猎人 (TrapHunter) =================
class TrapHunter:
    def __init__(self):
        self.model_2 = self._load(TRAP_MODEL_2); self.model_3 = self._load(TRAP_MODEL_3)
        if self.model_2 and self.model_3: print("✅ 陷阱猎人已就位 (Trap Hunter V3)")
    def _load(self, path):
        if os.path.exists(path):
            try:
                model = joblib.load(path)
                force_single_thread_model(model)
                return model
            except Exception:
                LOGGER.exception("Trap 模型加载失败: %s", path)
                return None
        return None
    def _get_features(self, initial_odds, final_odds):
        if sum(initial_odds) == 0 or sum(final_odds) == 0: return None
        def get_series(odds):
            safe_odds = [x if x > 0 else 0.01 for x in odds]
            probs = np.array([1/x for x in safe_odds])
            raw_sum = probs.sum()
            if raw_sum > 0: probs /= raw_sum
            xg = np.sum(probs * np.array([0, 1, 2, 3, 4, 5, 6, 7.5]))
            entropy = -np.sum(probs * np.log2(probs + 1e-9))
            return xg, entropy, probs, raw_sum
        i_xg, i_ent, i_probs, i_sum = get_series(initial_odds)
        f_xg, f_ent, f_probs, f_sum = get_series(final_odds)
        feat = {}
        feat['initial_xg'] = i_xg; feat['final_xg'] = f_xg; feat['xg_trend'] = f_xg - i_xg
        feat['initial_entropy'] = i_ent; feat['final_entropy'] = f_ent; feat['entropy_change'] = f_ent - i_ent
        feat['margin_change'] = f_sum - i_sum
        feat['gap_2_3_init'] = initial_odds[2] - initial_odds[3]
        feat['gap_2_3_final'] = final_odds[2] - final_odds[3]
        feat['gap_2_3_trend'] = feat['gap_2_3_final'] - feat['gap_2_3_init']
        for idx in range(8):
            i_o = initial_odds[idx] if initial_odds[idx] > 0 else 1
            f_o = final_odds[idx]; feat[f'chg_pct_{idx}'] = (f_o - i_o) / i_o
            feat[f'final_prob_{idx}'] = f_probs[idx]
        return feat
    def detect(self, initial_odds, final_odds):
        if not self.model_2 or not self.model_3: return []
        feat_dict = self._get_features(initial_odds, final_odds)
        if not feat_dict: return []
        df = pd.DataFrame(feat_dict, index=[0])
        traps = []
        try:
            real_p2 = self.model_2.predict_proba_df(df)[0]
            odd_2 = final_odds[2]
            if odd_2 > 0:
                implied_p2 = odds_to_probs_fair(final_odds)[2]
                if (implied_p2 - real_p2) > 0.15: traps.append(f"🪤2球(AI陷阱)")
        except Exception:
            LOGGER.exception("Trap2 推理失败")
        try:
            real_p3 = self.model_3.predict_proba_df(df)[0]
            odd_3 = final_odds[3]
            if odd_3 > 0:
                implied_p3 = odds_to_probs_fair(final_odds)[3]
                if (implied_p3 - real_p3) > 0.15: traps.append(f"🪤3球(AI陷阱)")
        except Exception:
            LOGGER.exception("Trap3 推理失败")
        return traps

# ================= AI 狙击手 (AIPredictor) =================
class AIPredictor:
    def __init__(self, model_file=MODEL_FILE):
        self.active = False
        if os.path.exists(model_file):
            try:
                self.model = joblib.load(model_file)
                force_single_thread_model(self.model)
                self.active = True
                print(f"✅ AI 狙击手已就位: {model_file}")
            except Exception:
                LOGGER.exception("AI 狙击模型加载失败: %s", model_file)
    def _get_probs_and_xg(self, odds_list):
        if sum(odds_list) == 0: return None, 0, 0
        probs = np.array([1/x if x > 0 else 0 for x in odds_list])
        raw_margin = np.sum(probs)
        norm_probs = probs / raw_margin if raw_margin > 0 else probs
        xg = 0; goals_val = [0, 1, 2, 3, 4, 5, 6, 7.5]
        for i, p in enumerate(norm_probs): xg += p * goals_val[i]
        return norm_probs, xg, raw_margin
    def _calculate_entropy(self, probs): return -np.sum(probs * np.log2(probs + 1e-9))
    def predict(self, initial_odds, final_odds):
        if not self.active: return None
        init_p, init_xg, init_margin = self._get_probs_and_xg(initial_odds)
        final_p, final_xg, final_margin = self._get_probs_and_xg(final_odds)
        if init_p is None or final_p is None: return None
        features = {}
        features['initial_xg'] = init_xg; features['final_xg'] = final_xg; features['xg_trend'] = final_xg - init_xg
        features['initial_entropy'] = self._calculate_entropy(init_p); features['final_entropy'] = self._calculate_entropy(final_p)
        features['entropy_change'] = features['final_entropy'] - features['initial_entropy']
        features['margin_change'] = final_margin - init_margin
        for i in range(8):
            i_odd = initial_odds[i]; f_odd = final_odds[i]
            features[f'chg_pct_{i}'] = (f_odd - i_odd) / i_odd if i_odd > 0 else 0
            features[f'final_prob_{i}'] = final_p[i]
        features['gap_2_3_init'] = initial_odds[2] - initial_odds[3]
        features['gap_2_3_final'] = final_odds[2] - final_odds[3]
        features['gap_2_3_trend'] = features['gap_2_3_final'] - features['gap_2_3_init']
        # ==========================
        # 🔥 必须与训练脚本保持一致
        # ==========================

        # 1. cross_structure: final_xg * (o2 / o3)
        o2 = final_odds[2]
        o3 = final_odds[3] if final_odds[3] > 0 else 0.01
        features['cross_structure'] = final_xg * (o2 / o3)

        # 2. cross_vol_entropy: abs(xg_trend) * final_entropy
        features['cross_vol_entropy'] = abs(features['xg_trend']) * features['final_entropy']

        # 3. cross_3_odd_prob: o3 * prob_3
        # final_p 是前面 _get_probs_and_xg 算出来的概率列表
        features['cross_3_odd_prob'] = o3 * final_p[3]

        df_feat = pd.DataFrame(features, index=[0])

        THRESHOLD_XG_TREND = 0.10; THRESHOLD_MARGIN = 0.015
        is_sniper_mode = (abs(features['xg_trend']) >= THRESHOLD_XG_TREND) or (abs(features['margin_change']) >= THRESHOLD_MARGIN)
        if not is_sniper_mode: return {"type": "SILENT", "msg": "波动不足"}
        try:
            # 注意：model.classes_ 通常是 [0, 1]，所以 [:, 1] 是大球概率
            probs = self.model.predict_proba(df_feat)[0]
            prob_big = probs[1]

            # ================= 配置安全锁 =================
             # 激进的大球模型，需要更高的门槛才能信
            CONF_THRESHOLD_BIG = 0.59  # 大球需要 59% 以上把握
            CONF_THRESHOLD_SMALL = 0.46 # 小球需要 54% 以上把握 (1 - 0.46 = 0.54)

            result_type = "SILENT"
            confidence = 0.0
            msg = "波动不足或信心低"

            if prob_big >= CONF_THRESHOLD_BIG:
                result_type = "BIG"
                confidence = prob_big
                msg = f"AI狙击大球(信度{confidence:.0%})"
            elif prob_big <= CONF_THRESHOLD_SMALL:
                result_type = "SMALL"
                confidence = 1.0 - prob_big
                msg = f"AI狙击小球(信度{confidence:.0%})"
            else:
                # 落在 0.46 - 0.59 之间的，全部过滤掉，不做预测
                return {"type": "SILENT", "msg": f"AI观望(大球率{prob_big:.0%})"}

            return {"type": result_type, "conf": confidence, "prob_big": prob_big, "msg": msg}
        except Exception as e:
            LOGGER.exception("AI狙击推理失败")
            return {"type": "ERROR", "msg": str(e)}

# ================= [NEW] 大小球盘口仲裁器 =================
class MarketLineArbitrator:
    def __init__(self):
        self.active = True

    def parse_handicap(self, text):
        """解析盘口，如 '2.5/3' -> 2.75"""
        try:
            s = str(text).strip().replace(",", ".")
            # 兼容 "3.5(球)" / "2.5/3(球)" / "3(球)" 等格式
            nums = re.findall(r"\d+(?:\.\d+)?", s)
            if not nums:
                return 2.5
            if "/" in s and len(nums) >= 2:
                return (float(nums[0]) + float(nums[1])) / 2.0
            return float(nums[0])
        except Exception:
            LOGGER.debug("盘口解析失败，使用默认值2.5: %s", text, exc_info=True)
            return 2.5 # 默认兜底

    def analyze(self, ou_data):
        """
        ou_data: {'line': 2.75, 'over': 0.87, 'under': 1.02}
        返回: 修正系数、标签、颜色
        """
        if not ou_data: return None

        line = ou_data['line']
        o_odd = ou_data['over']
        u_odd = ou_data['under']

        res = {
            "implied_goals": line,
            "tag": "",
            "color": "#64748b", # gray
            "score_boost": {}, # {进球数: 加分值}
            "desc": ""
        }

        # === 核心博弈逻辑 ===

        # 1. 深盘低水 (如 3.5球 @ 0.83) -> 庄家极度防大
        if line >= 3.25 and o_odd <= 0.88:
            res['tag'] = "🔥深盘防大"
            res['color'] = "#ef4444" # red
            res['score_boost'] = {3: 2.0, 4: 4.0, 5: 4.0, 6: 3.0}
            res['desc'] = f"盘口{line}且大球低水，庄家严防打穿"

        # 2. 浅盘高水 (如 1.75球 @ 1.10) -> 诱小或真实看死小
        elif line <= 2.0:
            if o_odd > 1.05: # 大球超高水，极难打出
                res['tag'] = "🧊铁桶死小"
                res['color'] = "#3b82f6" # blue
                res['score_boost'] = {0: 4.0, 1: 4.0, 2: 1.0}
                res['desc'] = f"盘口{line}极浅，大球赔付压力大"
            else: # 浅盘低水，可能有鬼
                res['tag'] = "⚠️浅盘诱下"
                res['color'] = "#f59e0b" # orange
                res['score_boost'] = {2: 3.0} # 重点防2球走水或卡盘

        # 3. 2.75/3球 生死博弈 (如 2.75 @ 0.87)
        elif 2.75 <= line <= 3.0:
            if o_odd < 0.90:
                res['tag'] = "📈倾向3球"
                res['color'] = "#10b981" # green
                res['score_boost'] = {3: 5.0, 4: 2.0} # 重点加注3球
                res['desc'] = "大球低水，直指3球起步"
            elif o_odd > 1.02:
                res['tag'] = "📉阻力明显"
                res['color'] = "#94a3b8"
                res['score_boost'] = {2: 3.0, 1: 2.0}

        # 3.5 2.0-2.25 浅盘过渡区
        elif 2.0 < line < 2.25:
            if o_odd < 0.90:
                res['tag'] = "📊浅场2球+"
                res['color'] = "#10b981"
                res['score_boost'] = {2: 3.0, 3: 2.0}
                res['desc'] = "浅盘但大球低水，防2/3球"
            else:
                res['tag'] = "📊浅盘观望"
                res['color'] = "#94a3b8"
                res['score_boost'] = {1: 2.0, 2: 2.0}
                res['desc'] = "浅盘阻力一般，倾向1/2球"

        # 3.6 3.0-3.25 深盘过渡区
        elif 3.0 < line < 3.25:
            if o_odd < 0.90:
                res['tag'] = "📊深盘3球+"
                res['color'] = "#ef4444"
                res['score_boost'] = {3: 3.0, 4: 3.0}
                res['desc'] = "深盘且低水，防3/4球"
            else:
                res['tag'] = "📊3球上方阻力"
                res['color'] = "#94a3b8"
                res['score_boost'] = {2: 2.0, 3: 2.0}
                res['desc'] = "深盘上方阻力，防2/3球"

        # 4. 2.25/2.5 常规盘
        else:
            if o_odd < 0.85:
                res['tag'] = "👀防守2/3"
                res['score_boost'] = {2: 2.0, 3: 2.0}
            elif o_odd > 1.00:
                res['tag'] = "💤看淡"
                res['score_boost'] = {0: 1.0, 1: 2.0, 2: 1.0}

        return res

def load_daxiao_database():
    """读取 daxiaoqiu.xlsx 并建立索引"""
    if not os.path.exists(DAXIAO_FILE):
        print(f"⚠️ 未找到大小球文件: {DAXIAO_FILE}")
        LOGGER.warning("未找到大小球文件: %s", DAXIAO_FILE)
        return {}

    try:
        # 读取Excel，确保 '指数' 列按字符串读取以免自动转日期
        df = pd.read_excel(DAXIAO_FILE, dtype={'指数': str})
        # 清洗列名
        df.columns = df.columns.str.strip()

        db = {}
        arbitrator = MarketLineArbitrator()

        def normalize_team_token(name):
            s = str(name or "").strip().upper()
            return re.sub(r"\s+", "", s)

        def split_matchup(text):
            parts = re.split(r"\s+V[S]?\s+", str(text or "").strip(), flags=re.IGNORECASE)
            if len(parts) == 2:
                h = normalize_team_token(parts[0])
                a = normalize_team_token(parts[1])
                if h and a:
                    return h, a
            return None, None

        print(f"🔄 正在加载大小球指数...")
        for row in df.to_dict('records'):
            raw_teams = str(row.get('对阵', '')).strip()
            home_team, away_team = split_matchup(raw_teams)
            if not home_team:
                home_team = normalize_team_token(raw_teams)

            # 解析数据
            line_str = str(row.get('指数', '2.5'))
            line_val = arbitrator.parse_handicap(line_str)

            data = {
                "line": line_val,
                "line_str": line_str,
                "over": float(row.get('大', 0)),
                "under": float(row.get('小', 0))
            }

            # 优先使用“主|客”键，避免仅主队键被覆盖；同时保留主队兜底键兼容旧逻辑
            if home_team and away_team:
                db[f"{home_team}|{away_team}"] = data
            db.setdefault(f"H:{home_team}", data)

        print(f"✅ 大小球数据加载完成，共 {len(db)} 条")
        return db

    except Exception as e:
        print(f"❌ 大小球加载失败: {e}")
        LOGGER.exception("大小球加载失败: %s", DAXIAO_FILE)
        return {}

# ================= 数据加载器 =================
def load_team_mapping():
    if not os.path.exists(TEAM_NAME_FILE): return {}
    try:
        with open(TEAM_NAME_FILE, 'r', encoding='utf-8') as f: return json.load(f)
    except Exception:
        LOGGER.exception("球队映射加载失败: %s", TEAM_NAME_FILE)
        return {}
# ================= [NEW] 核心数据加载器 =================

def calculate_form_factor(last_5_val):
    """
    解析 'W L W D W' 格式的近况，返回状态系数 (0.85 - 1.15)
    适配 Excel 可能读入为 NaN 或非字符串的情况
    """
    if pd.isna(last_5_val):
        return 1.0 # 无数据默认正常状态

    # 转成字符串并清洗
    raw_str = str(last_5_val).upper().replace(" ", "").replace(",", "")
    # 只取最近5场（防止 excel 里写多了）
    clean_str = raw_str[:5]

    if not clean_str: return 1.0

    score = 0
    max_score = len(clean_str) * 3

    for char in clean_str:
        if char == 'W': score += 3
        elif char == 'D': score += 1
        # L 加 0 分，其他字符忽略

    # 归一化计算
    # 0分 -> 0.85 (低迷)
    # 满分 -> 1.15 (火热)
    if max_score == 0: return 1.0

    norm_score = score / max_score
    factor = 0.85 + (norm_score * 0.30)

    return factor


def load_xg_database(name_mapping):
    """
    [新版加载器] 读取联赛基准值 + 球队分项xG数据
    """
    print(f"🔄 正在加载新版 xG 核心数据...")

    # 1. 加载联赛基准数据 (leaguegoals.xlsx)
    league_stats = {}
    try:
        if os.path.exists(FILE_LEAGUE_AVG):
            df_lg = pd.read_excel(FILE_LEAGUE_AVG)
            # 确保列名清除空格
            df_lg.columns = df_lg.columns.str.strip()
            for row in df_lg.to_dict('records'):
                lg_name = str(row.get('联赛', '')).strip()
                if not lg_name: continue
                league_stats[lg_name] = {
                    "avg_home": float(row.get('主场场均进球', 1.5)),
                    "avg_away": float(row.get('客场场均进球', 1.2))
                }
            print(f"✅ 已加载 {len(league_stats)} 个联赛的基准数据")
        else:
            print(f"⚠️ 未找到联赛数据: {FILE_LEAGUE_AVG}")
    except Exception as e:
        print(f"❌ 联赛数据读取失败: {e}")
        LOGGER.exception("联赛基准读取失败: %s", FILE_LEAGUE_AVG)

    # 2. 加载球队分项数据 (allleagues_xg_xga.xlsx)
    xg_db = {}
    try:
        if not os.path.exists(FILE_TEAM_SPLIT):
            print(f"❌ 未找到球队数据文件: {FILE_TEAM_SPLIT}")
            LOGGER.error("未找到球队数据文件: %s", FILE_TEAM_SPLIT)
            return {}

        df_team = pd.read_excel(FILE_TEAM_SPLIT)
        df_team.columns = df_team.columns.str.strip() # 清除表头空格

        # 检查关键列是否存在
        for c in REQUIRED_TEAM_SPLIT_COLS:
            if c not in df_team.columns:
                print(f"❌ 缺少列: {c}，请检查Excel表头")
                LOGGER.error("球队数据缺少关键列: %s", c)
                return {}

        # 可选列：用于补齐旧逻辑中的 bts/raw_form
        col_form = _find_first_col(df_team.columns, ['近5场', '近期战绩', '状态', 'FORM', 'Form', 'Last5'])
        col_bts = _find_first_col(df_team.columns, ['BTTS', 'BTS', '双方进球率', '双方破门率'])
        col_bts_home = _find_first_col(df_team.columns, ['主场BTTS', '主场BTS', '主场双方进球率'])
        col_bts_away = _find_first_col(df_team.columns, ['客场BTTS', '客场BTS', '客场双方进球率'])

        def as_prob(v):
            try:
                p = float(v)
            except Exception:
                return 0.0
            if not np.isfinite(p):
                return 0.0
            if p > 1.0 and p <= 100.0:
                p /= 100.0
            if p < 0:
                return 0.0
            if p > 1.0:
                return 1.0
            return p

                # === [新增] 计算联赛 xG 基准（同口径）===
        # 用球队表自己聚合出每个联赛的主/客 xG 与主/客 xGA 平均值
        league_xg_base = {}
        try:
            g = df_team.groupby('联赛', dropna=False)
            for lg, sub in g:
                lg_name = str(lg).strip()
                if not lg_name:
                    continue
                league_xg_base[lg_name] = {
                    "xg_home_avg": float(sub['主场xG'].mean()),
                    "xg_away_avg": float(sub['客场xG'].mean()),
                    "xga_home_avg": float(sub['主场xGA'].mean()),
                    "xga_away_avg": float(sub['客场xGA'].mean()),
                }
        except Exception as e:
            print(f"⚠️ 联赛xG基准聚合失败: {e}")
            league_xg_base = {}


        count = 0
        for row in df_team.to_dict('records'):
            raw_name = str(row['球队']).strip()
            # 查字典转译 (如果excel里已经是中文，name_mapping里没有也没关系，用原名)
            team_name = name_mapping.get(raw_name, raw_name)

            league_name = str(row.get('联赛', '')).strip()

            # 获取该球队所在联赛的基准值 (如果没有就给默认 1.5/1.2)
            lg_base = league_stats.get(league_name, {"avg_home": 1.5, "avg_away": 1.2})
            # === [新增] 同口径联赛xG基准 ===
            lg_xg = league_xg_base.get(league_name, {})
            bts_vals = []
            if col_bts_home:
                bts_vals.append(as_prob(row.get(col_bts_home, 0)))
            if col_bts_away:
                bts_vals.append(as_prob(row.get(col_bts_away, 0)))
            if col_bts:
                bts_vals.append(as_prob(row.get(col_bts, 0)))
            bts_value = float(sum(bts_vals) / len(bts_vals)) if bts_vals else 0.0


            # 存入结构化数据
            xg_db[team_name] = {
                "league": league_name,
                "lg_avg_home": lg_base['avg_home'],
                "lg_avg_away": lg_base['avg_away'],

                # [新增] 联赛 xG 基准（同口径）
                "lg_xg_home": float(lg_xg.get("xg_home_avg", 0.0)),
                "lg_xg_away": float(lg_xg.get("xg_away_avg", 0.0)),
                "lg_xga_home": float(lg_xg.get("xga_home_avg", 0.0)),
                "lg_xga_away": float(lg_xg.get("xga_away_avg", 0.0)),
                # 核心分项数据
                "home_xg": float(row['主场xG']),
                "away_xg": float(row['客场xG']),
                "home_xga": float(row['主场xGA']),
                "away_xga": float(row['客场xGA']),
                "overall_xg": float(row['总体xG']),
                "overall_xga": float(row['总体xGA']),
                "bts": bts_value,
                "raw_form": str(row.get(col_form, "")).strip() if col_form else "",

                # [新增] 联赛总进球基准（用于大/小球判断）
                "lg_avg_total": float(lg_base['avg_home'] + lg_base['avg_away']),

                # 兼容旧逻辑的字段 (如果有form可以用旧逻辑，这里暂时给1.0)
                "form": 1.0,
                "mp": 10 # 假定样本足够
            }
            count += 1

        print(f"✅ 成功加载 {count} 支球队的分项 xG 数据")
        return xg_db

    except Exception as e:
        print(f"❌ 球队数据解析失败: {e}")
        LOGGER.exception("球队数据解析失败: %s", FILE_TEAM_SPLIT)
        return {}

def _to_fair_probs_matrix(odds_matrix: np.ndarray) -> np.ndarray:
    with np.errstate(divide='ignore', invalid='ignore'):
        inv = np.divide(1.0, odds_matrix, out=np.zeros_like(odds_matrix, dtype=float), where=odds_matrix > 0)
    row_sums = inv.sum(axis=1, keepdims=True)
    return np.divide(inv, row_sums, out=np.zeros_like(inv), where=row_sums > 0)

def _attach_history_probability_matrices(df: pd.DataFrame, final_probs: np.ndarray, init_probs: Optional[np.ndarray] = None) -> pd.DataFrame:
    # 2D 矩阵不能作为 DataFrame 单列写入；作为运行时属性保留极速索引能力。
    object.__setattr__(df, 'final_probs_mat', np.asarray(final_probs, dtype=float))
    if init_probs is not None:
        object.__setattr__(df, 'init_probs_mat', np.asarray(init_probs, dtype=float))
    return df

def _build_match_key(df: pd.DataFrame, odds_cols: List[str]) -> List[tuple]:
    lg = df['联赛类型'].astype(str).str.strip()
    home = df['主队名'].astype(str).str.strip()
    away = df['客队名'].astype(str).str.strip()
    goals = pd.to_numeric(df['进球数'], errors='coerce').fillna(-1).astype(int)
    odds_parts = [pd.to_numeric(df[c], errors='coerce').fillna(0.0).round(3) for c in odds_cols]
    return list(zip(lg, home, away, goals, *odds_parts))

def _enrich_history_initial_odds(df: pd.DataFrame) -> pd.DataFrame:
    if not all(c in df.columns for c in HIST_INIT_ODDS_COLS):
        for c in HIST_INIT_ODDS_COLS:
            if c not in df.columns:
                df[c] = np.nan
    else:
        for c in HIST_INIT_ODDS_COLS:
            df[c] = pd.to_numeric(df[c], errors='coerce')

    missing_mask = ~df[HIST_INIT_ODDS_COLS].gt(0).all(axis=1)
    if not missing_mask.any():
        return df

    if not os.path.exists(HISTORY_ENRICH_FILE):
        return df
    if os.path.abspath(HISTORY_ENRICH_FILE) == os.path.abspath(HISTORY_FILE):
        return df

    needed_cols = set(REQUIRED_HISTORY_BASE_COLS + HIST_ODDS_COLS + HIST_FINAL_ODDS_COLS_ALT + HIST_INIT_ODDS_COLS)
    try:
        aux = pd.read_excel(HISTORY_ENRICH_FILE, usecols=lambda c: c in needed_cols)
    except Exception:
        LOGGER.exception("补充初赔失败: 无法读取 %s", HISTORY_ENRICH_FILE)
        return df

    aux.columns = aux.columns.str.strip()
    if not all(c in aux.columns for c in HIST_ODDS_COLS) and all(c in aux.columns for c in HIST_FINAL_ODDS_COLS_ALT):
        aux = aux.rename(columns=dict(zip(HIST_FINAL_ODDS_COLS_ALT, HIST_ODDS_COLS)))

    required_aux = set(REQUIRED_HISTORY_BASE_COLS + HIST_ODDS_COLS + HIST_INIT_ODDS_COLS)
    if not required_aux.issubset(aux.columns):
        return df

    aux = aux.copy()
    aux['进球数'] = pd.to_numeric(
        aux['进球数'].astype(str).str.replace('+', '', regex=False).str.replace('球', '', regex=False).str.strip(),
        errors='coerce'
    )
    aux = aux.dropna(subset=['进球数'])
    for c in HIST_ODDS_COLS + HIST_INIT_ODDS_COLS:
        aux[c] = pd.to_numeric(aux[c], errors='coerce').fillna(0.0)
    aux = aux[aux[HIST_INIT_ODDS_COLS].gt(0).all(axis=1)].copy()
    if aux.empty:
        return df

    key_to_init = {}
    for k, v in zip(_build_match_key(aux, HIST_ODDS_COLS), aux[HIST_INIT_ODDS_COLS].to_numpy(dtype=float)):
        if k not in key_to_init:
            key_to_init[k] = v

    target_idx = df.index[missing_mask]
    filled = 0
    for ridx, k in zip(target_idx, _build_match_key(df.loc[target_idx], HIST_ODDS_COLS)):
        val = key_to_init.get(k)
        if val is None:
            continue
        df.loc[ridx, HIST_INIT_ODDS_COLS] = val
        filled += 1

    if filled > 0:
        LOGGER.info("历史样本初赔补齐完成: %s 行 (source=%s)", filled, HISTORY_ENRICH_FILE)
    return df

def _prepare_history_df(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df.columns = df.columns.str.strip()
    if not all(c in df.columns for c in HIST_ODDS_COLS) and all(c in df.columns for c in HIST_FINAL_ODDS_COLS_ALT):
        df = df.rename(columns=dict(zip(HIST_FINAL_ODDS_COLS_ALT, HIST_ODDS_COLS)))

    for c in REQUIRED_HISTORY_BASE_COLS + HIST_ODDS_COLS:
        if c not in df.columns:
            raise ValueError(f"历史数据缺少必需列: {c}")

    df['进球数'] = pd.to_numeric(
        df['进球数'].astype(str).str.replace('+', '', regex=False).str.replace('球', '', regex=False).str.strip(),
        errors='coerce'
    )
    df = df.dropna(subset=['进球数']).copy()
    df['进球数'] = df['进球数'].clip(lower=0, upper=7)

    for c in HIST_ODDS_COLS:
        df[c] = pd.to_numeric(df[c], errors='coerce').fillna(0.0)
    for c in HIST_INIT_ODDS_COLS:
        if c not in df.columns:
            df[c] = np.nan
        else:
            df[c] = pd.to_numeric(df[c], errors='coerce')

    return _enrich_history_initial_odds(df)

def load_history():
    """
    智能加载历史数据：优先读取 .pkl 高速缓存，
    如果 Excel 更新了，则自动重新转换。
    """
    base, ext = os.path.splitext(HISTORY_FILE)
    pkl_file = base + ".pkl"
    df = pd.DataFrame()

    use_cache = False
    if os.path.exists(pkl_file) and os.path.exists(HISTORY_FILE):
        src_mtimes = [os.path.getmtime(HISTORY_FILE)]
        if os.path.exists(HISTORY_ENRICH_FILE):
            if os.path.abspath(HISTORY_ENRICH_FILE) != os.path.abspath(HISTORY_FILE):
                src_mtimes.append(os.path.getmtime(HISTORY_ENRICH_FILE))
        if os.path.getmtime(pkl_file) > max(src_mtimes):
            use_cache = True

    try:
        if use_cache:
            print(f"🚀 [Speedup] 正在加载高速缓存: {pkl_file} ...")
            df = pd.read_pickle(pkl_file)
        else:
            print(f"🐢 正在读取源文件 (首次运行较慢): {HISTORY_FILE} ...")
            if HISTORY_FILE.endswith('.csv'):
                df = pd.read_csv(HISTORY_FILE)
            else:
                df = pd.read_excel(HISTORY_FILE)

        df = _prepare_history_df(df)
        df = df.reset_index(drop=True)
        df['Tier'] = df['联赛类型'].apply(lambda x: get_league_tier(x)[0])
        df['tier_1_mask'] = df['Tier'] == 1
        df['tier_1_2_mask'] = df['Tier'].isin([1, 2])

        probs = _to_fair_probs_matrix(df[HIST_ODDS_COLS].to_numpy(dtype=float))
        goals = np.array([0, 1, 2, 3, 4, 5, 6, 7.5], dtype=float)
        df['Implied_xG'] = np.dot(probs, goals)
        df['_final_probs'] = list(probs)
        init_probs_mat = None

        has_hist_init = all(c in df.columns for c in HIST_INIT_ODDS_COLS)
        if has_hist_init:
            init_odds = df[HIST_INIT_ODDS_COLS].to_numpy(dtype=float)
            valid_init = np.all(init_odds > 0, axis=1)
            init_odds_filled = np.where(valid_init[:, None], init_odds, df[HIST_ODDS_COLS].to_numpy(dtype=float))
            init_probs_mat = _to_fair_probs_matrix(init_odds_filled)
            df['_init_probs'] = list(init_probs_mat)
            df['_valid_init'] = valid_init

        if not use_cache:
            print(f"💾 正在生成高速缓存 -> {pkl_file}")
            df.to_pickle(pkl_file)

        _attach_history_probability_matrices(df, probs, init_probs_mat)
        FastSearchEngine().initialize(df)
        return df
    except Exception as e:
        print(f"❌ History Error: {e}")
        LOGGER.exception("历史数据加载失败: %s", HISTORY_FILE)
        return pd.DataFrame()


# ================= 引擎层优化 =================
def normalize_dist8(dist8):
    dist8 = [float(x) if x is not None else 0.0 for x in dist8]
    s = sum(dist8)
    if s <= 0:
        return [0.0]*8
    return [x/s for x in dist8]

def topk_from_dist8(dist8, k=3):
    # 返回 [(goal, prob), ...]，goal=0..7（7代表7+）
    pairs = list(enumerate(dist8))
    pairs.sort(key=lambda x: x[1], reverse=True)
    return [(int(g), float(p)) for g, p in pairs[:k]]

def process_stats(df, method, weights=None):
    """
    统计历史比赛进球分布
    支持 'weights' 参数进行距离加权 (IDW)
    """
    if df.empty:
        return {"top3": [], "dist8": [0.0]*8, "size": 0, "method": method, "details": []}

    dist8 = [0.0] * 8

    # === 分支 A: 启用距离加权 (IDW) ===
    if weights is not None and len(weights) == len(df):
        try:
            # 权重计算: w = 1 / (d + 1e-4) -> 距离越小权重越大
            # 确保 weights 是 numpy array 以便计算
            w_arr = np.array(weights)
            # 避免极小距离导致的除零
            inv_dist = 1.0 / (w_arr + 1e-4)
            # 归一化权重
            w_norm = inv_dist / inv_dist.sum()

            # 加权统计
            goals = df['进球数'].values
            for i, g_val in enumerate(goals):
                try:
                    idx = int(g_val)
                    if idx >= 7: idx = 7
                    if idx < 0: continue
                    # 累加权重而不是简单的 +1
                    dist8[idx] += w_norm[i]
                except Exception: continue

        except Exception as e:
            # 如果计算出错，回退到普通模式
            print(f"⚠️ 加权计算失败，回退普通模式: {e}")
            weights = None # 标记为 None 让下面的逻辑接管

    # === 分支 B: 普通计数模式 (V7, Hist 或 V9无权重时) ===
    if weights is None:
        counts = df['进球数'].value_counts(normalize=True)
        for g, p in counts.items():
            try:
                idx = int(g)
            except Exception: continue
            if idx >= 7: idx = 7
            if idx < 0: continue
            dist8[idx] = float(p)

    # 再次归一化 (防误差)
    dist8 = normalize_dist8(dist8)

    # 提取 Top 3
    top3_data = topk_from_dist8(dist8, 3)

    # 生成详情列表 (用于前端显示)
    details = []
    # 只取前 10 场展示
    for i, r in enumerate(df.head(10).to_dict('records')):
        # 如果有权重，把距离显示在 'o' (赔率) 字段里，方便调试查看
        # 如果没有权重，就显示原来的 0球赔率
        note = ""
        if weights is not None and i < len(weights):
             note = f"d={weights[i]:.3f}"
        else:
             note = str(r.get('0进球赔率', ''))

        details.append({
            'lg': r['联赛类型'],
            'h': r['主队名'],
            'a': r['客队名'],
            'g': int(r['进球数']),
            'o': note
        })

    return {
        "top3": top3_data,
        "dist8": dist8,
        "size": len(df),
        "method": method,
        "details": details
    }

def apply_tier_filter(hist_df, target_tier):
    if target_tier == 1:
        if hasattr(hist_df, 'tier_1_mask'):
            return hist_df[hist_df.tier_1_mask]
        return hist_df[hist_df['Tier'] == 1]
    elif target_tier == 2:
        if hasattr(hist_df, 'tier_1_2_mask'):
            return hist_df[hist_df.tier_1_2_mask]
        return hist_df[hist_df['Tier'].isin([1, 2])]
    else:
        return hist_df

def engine_v9(target, hist, lg, target_tier, target_initial=None):
    engine = FastSearchEngine()
    if not engine.initialized:
        return process_stats(pd.DataFrame(), "V9 (Error)")

    query_vector = engine.build_query_vector(target, target_initial_odds=target_initial)
    if query_vector is None:
        return process_stats(pd.DataFrame(), "V9 (Error)")

    neighbors, _, _ = engine.search_v9(target, target_initial_odds=target_initial, top_n=V9_SEARCH_TOP_N)
    if len(neighbors) == 0:
        return process_stats(pd.DataFrame(), "V9 (Turbo)", weights=None)

    def slice_and_process(df_in, method_label, limit=V9_LIMIT_MIX):
        if len(df_in) > 0:
            limit = max(40, min(limit, int(len(df_in) * V9_DYNAMIC_LIMIT_RATIO)))
        df_slice = df_in.head(limit).copy()
        if "_v9_row" in df_slice.columns:
            rows = df_slice["_v9_row"].values.astype(int)
            dists = engine.distances_to_rows(query_vector, rows)
            return process_stats(df_slice, method_label, weights=dists)
        else:
            # 理论上不该走到这
            return process_stats(df_slice, method_label, weights=None)

    # ===== Tier 1 严管：同联赛优先 =====
    if target_tier == 1:
        strict_matches = neighbors[neighbors["联赛类型"] == lg]
        if len(strict_matches) >= V9_STRICT_MIN:
            return slice_and_process(strict_matches, f"V9.3 (Strict|{lg})", limit=V9_LIMIT_STRICT)
        tier_matches = apply_tier_filter(neighbors, target_tier)
        return slice_and_process(tier_matches, "V9.3 (Tier1|Mix)", limit=V9_LIMIT_STRICT)

    # ===== Tier 2/3 宽容：同联赛不够就同 tier 混合 =====
    same_league = neighbors[neighbors["联赛类型"] == lg]
    if len(same_league) >= V9_SAME_LEAGUE_MIN:
        return slice_and_process(same_league, f"V9.3 ({lg})", limit=V9_LIMIT_STRICT)

    tier_matches = apply_tier_filter(neighbors, target_tier)
    return slice_and_process(tier_matches, "V9.3 (Tier Mix)", limit=V9_LIMIT_MIX)


def engine_v7(target, hist, lg, target_tier, target_initial=None):
    hist_filtered = apply_tier_filter(hist, target_tier)
    target_g0 = target[0]

    # 用 Numpy 布尔掩码进行筛选，代替连续创建 DataFrame 副本
    g0_mask = (hist_filtered['0进球赔率'] - target_g0).abs() <= V7_G0_TOL
    hist_filtered = hist_filtered[g0_mask]
    if len(hist_filtered) < 10:
        hist_filtered = hist

    target_probs = np.array(odds_to_probs_fair(target), dtype=float)

    # 直接使用挂载的 2D Numpy 矩阵进行索引，避免 np.vstack 的开销
    if hasattr(hist, 'final_probs_mat'):
        hist_final_probs = hist.final_probs_mat[hist_filtered.index]
    else:
        hist_final_probs = np.vstack(hist_filtered['_final_probs'].values)

    d = np.abs(hist_final_probs - target_probs).sum(axis=1)
    method = "V7 (Fair)"

    has_target_init = isinstance(target_initial, (list, tuple)) and len(target_initial) >= 8 and all((x or 0) > 0 for x in target_initial[:8])
    has_hist_init = '_init_probs' in hist_filtered.columns
    if has_target_init and has_hist_init:
        valid_init = hist_filtered['_valid_init'].to_numpy(dtype=bool)
        if np.any(valid_init):
            target_init_probs = np.array(odds_to_probs_fair(target_initial[:8]), dtype=float)

            if hasattr(hist, 'init_probs_mat'):
                hist_init_probs = hist.init_probs_mat[hist_filtered.index]
            else:
                hist_init_probs = np.vstack(hist_filtered['_init_probs'].values)

            init_dist = np.abs(hist_init_probs - target_init_probs).sum(axis=1)
            target_drift = target_probs - target_init_probs
            hist_drift = hist_final_probs - hist_init_probs
            drift_dist = np.abs(hist_drift - target_drift).sum(axis=1)

            bonus_dist = (V7_INIT_BLEND_WEIGHT * init_dist) + (V7_DRIFT_BLEND_WEIGHT * drift_dist)
            d = d + np.where(valid_init, bonus_dist, 0.0)
            method = "V7 (Fair+Init)"

    d = pd.Series(d, index=hist_filtered.index)
    sel_idx = d.nsmallest(V7_NEIGHBORS).index.tolist()
    sel_df = hist_filtered.loc[sel_idx].copy()
    sel_weights = d.loc[sel_idx].to_numpy(dtype=float)
    return process_stats(sel_df, method, weights=sel_weights)

def _select_xg_neighbors(pool_df, target_xg, base_tol, min_n=HIST_XG_MIN_NEIGHBORS, max_n=HIST_XG_MAX_NEIGHBORS):
    if pool_df is None or pool_df.empty:
        return pd.DataFrame(), float(base_tol)

    dist = (pool_df['Implied_xG'] - target_xg).abs()

    # 找到基础 tol 内的邻居
    base_mask = dist <= base_tol
    base_count = base_mask.sum()

    tol = float(base_tol)
    if base_count >= int(min_n):
        # 足够了，只取满足基础 tol 的
        sel_idx = dist[base_mask].index
    else:
        # 基础 tol 不够，我们需要至少 min_n 个，但不超过 HIST_XG_MAX_TOL
        valid_mask = dist <= HIST_XG_MAX_TOL
        valid_dist = dist[valid_mask]

        if len(valid_dist) <= int(min_n):
            # 满足最大宽容度的都不够 min_n 个，全要了
            sel_idx = valid_dist.index
            if len(valid_dist) > 0:
                tol = max(tol, valid_dist.max())
        else:
            # 找到前 min_n 个的距离
            sel_idx = valid_dist.nsmallest(int(min_n)).index
            tol = max(tol, valid_dist.loc[sel_idx].max())

    sel = pool_df.loc[sel_idx].copy()
    if sel.empty:
        sel = pool_df.copy()
        sel['_xg_dist'] = dist
    else:
        sel['_xg_dist'] = dist.loc[sel_idx]

    sel = sel.sort_values('_xg_dist', ascending=True)
    if len(sel) > int(max_n):
        sel = sel.head(int(max_n)).copy()
    return sel, tol

def engine_xg_arbiter(target_xg, hist_df, target_tier):
    filtered = apply_tier_filter(hist_df, target_tier)
    base_tol = XG_TOL_HIGH if target_xg > 3.0 else XG_TOL_LOW
    neighbors, tol_used = _select_xg_neighbors(filtered, target_xg, base_tol)
    source_tag = "tier"
    if len(neighbors) < HIST_XG_MIN_NEIGHBORS:
        global_neighbors, global_tol = _select_xg_neighbors(hist_df, target_xg, base_tol)
        if len(global_neighbors) >= len(neighbors):
            neighbors = global_neighbors
            tol_used = global_tol
            source_tag = "global"
    if neighbors.empty:
        return process_stats(pd.DataFrame(), "Hist(Empty)")
    weights = neighbors['_xg_dist'].to_numpy(dtype=float)
    return process_stats(neighbors, f"Hist(xG±{tol_used:.2f}|{source_tag})", weights=weights)

# ================= [修改 3] 升级版泊松引擎 (V2.2 安全微调版) =================
def engine_poisson(home_team, away_team, xg_db):
    """
    [新版泊松] 基于分项数据的精准计算
    公式：Lambda = 联赛基准 * (主攻系数) * (客防系数)
    """
    # 1. 获取数据
    h_data = xg_db.get(home_team)
    a_data = xg_db.get(away_team)

    if not h_data or not a_data:
        return {
            "top3": [], "xg": 0, "active": False,
            "msg": "无xG数据", "dist8": [0.0]*8
        }

    # 2. 准备计算参数
    # 混合权重：0.7 信主客场特质，0.3 信整体实力 (增加鲁棒性)
    W_SPLIT = 0.7
    W_ALL = 0.3

        # === [优化] 同时取“联赛进球基准”和“联赛xG基准” ===
    lg_g_home = float(h_data.get('lg_avg_home', 1.5))
    lg_g_away = float(h_data.get('lg_avg_away', 1.2))
    lg_g_total = float(h_data.get('lg_avg_total', lg_g_home + lg_g_away))

    lg_xg_home = float(h_data.get('lg_xg_home', 0.0))
    lg_xg_away = float(h_data.get('lg_xg_away', 0.0))
    lg_xga_home = float(h_data.get('lg_xga_home', 0.0))
    lg_xga_away = float(h_data.get('lg_xga_away', 0.0))

    # 兜底：如果联赛xG基准没算出来，就退回到进球基准（保持可运行）
    if lg_xg_home < 0.1: lg_xg_home = lg_g_home
    if lg_xg_away < 0.1: lg_xg_away = lg_g_away
    if lg_xga_home < 0.1: lg_xga_home = lg_g_away  # xGA口径兜底随便给个合理量级
    if lg_xga_away < 0.1: lg_xga_away = lg_g_home

    # === split/overall 平滑（你原来的 W_SPLIT/W_ALL 保留）===
    real_h_att = (h_data['home_xg'] * W_SPLIT) + (h_data['overall_xg'] * W_ALL)
    real_h_def = (h_data['home_xga'] * W_SPLIT) + (h_data['overall_xga'] * W_ALL)
    real_a_att = (a_data['away_xg'] * W_SPLIT) + (a_data['overall_xg'] * W_ALL)
    real_a_def = (a_data['away_xga'] * W_SPLIT) + (a_data['overall_xga'] * W_ALL)

    # === 先在 xG 尺度下算 lambda（同口径）===
    # 主队：联赛主场xG基准 × (主队主场进攻相对强度) × (客队客场防守暴露相对强度)
    lambda_h_xg = lg_xg_home * (real_h_att / lg_xg_home) * (real_a_def / lg_xga_away)

    # 客队：联赛客场xG基准 × (客队客场进攻相对强度) × (主队主场防守暴露相对强度)
    lambda_a_xg = lg_xg_away * (real_a_att / lg_xg_away) * (real_h_def / lg_xga_home)

    # === 再做 xG→进球缩放（用 leaguegoals 的主/客场均进球对齐尺度）===
    scale_home = lg_g_home / lg_xg_home if lg_xg_home > 0.1 else 1.0
    scale_away = lg_g_away / lg_xg_away if lg_xg_away > 0.1 else 1.0

    lambda_h = lambda_h_xg * scale_home
    lambda_a = lambda_a_xg * scale_away
    # 防极端脏数据导致分布失真
    lambda_h = min(lambda_h, 4.5)
    lambda_a = min(lambda_a, 4.5)

    # 3. 生成基础泊松概率 (标准 Dixon-Coles)
    probs = defaultdict(float)
    h_probs = [poisson_probability(i, lambda_h) for i in range(10)]
    a_probs = [poisson_probability(i, lambda_a) for i in range(10)]

    RHO = -0.13 # 低比分相关性修正

    for h in range(8):
        for a in range(8):
            prob = h_probs[h] * a_probs[a]

            # Dixon-Coles 修正 (主要修正 0-0, 1-0, 0-1, 1-1)
            correction = 1.0
            if h==0 and a==0: correction = 1.0 - (lambda_h * lambda_a * RHO)
            elif h==0 and a==1: correction = 1.0 + (lambda_h * RHO)
            elif h==1 and a==0: correction = 1.0 + (lambda_a * RHO)
            elif h==1 and a==1: correction = 1.0 - RHO

            final_p = max(0, prob * correction)

            tg = h + a
            if tg < 7: probs[tg] += final_p
            else: probs[7] += final_p

    # === [核心逻辑] 智能长尾补偿 (Smart Tail Boost) ===
    # 只有明确的大球场景才触发，绝对不碰小球联赛

    league_name = str(h_data.get('league', ''))

    # === [新增] 大/小球判定（相对联赛总进球基准）===
    total_xg_exp = lambda_h + lambda_a
    ou_gap = total_xg_exp - lg_g_total

    if ou_gap >= 0.20:
        ou_tag = "大球"
    elif ou_gap <= -0.20:
        ou_tag = "小球"
    else:
        ou_tag = "中性"

    # 不再看名字，而是直接根据你的 leaguegoals.xlsx 数据判断

    # 1. 判定大球联赛 (Tail Boost)
    # 逻辑：如果Excel里该联赛场均 > 2.9球，就视为大球联赛，开启强力补偿
    # (注：你的截图里德甲3.27/荷甲3.24会触发，英超2.79/西甲2.57不会触发，这很合理，因为补偿系数1.15很强，只应给最疯的联赛)
    is_high_vol_league = lg_g_total >= 2.90

    # 2. 判定防守联赛
    # 逻辑：如果Excel里该联赛场均 <= 2.35球，就视为防守联赛，绝对禁止开启大球补偿
    # (注：你的截图里意甲2.37勉强算中性，如果低于2.35就会被归为铁桶联赛)
    is_def_league = lg_g_total <= 2.35

    # 触发条件：
    # 1. 必须不在黑名单里 (not is_def_league)
    # 2. 并且满足以下之一：
    #    a. 是大球白名单联赛
    #    b. 或者 双方期望进球极大 (Total xG > 3.25)
    should_boost = False
    if not is_def_league:
        if is_high_vol_league:
            should_boost = True
        elif total_xg_exp > 3.25:
            should_boost = True

    msg_suffix = ""
    if should_boost:
        # 模拟负二项分布特征：增加厚尾
        # 这种修正会让 4/5/6 球的概率提升，压缩 1/2 球的概率
        probs[4] *= 1.15
        probs[5] *= 1.25
        probs[6] *= 1.35
        probs[7] *= 1.40
        msg_suffix = " ⚡HighVol"
    else:
        # 如果是防守联赛，甚至可以反向压缩一点大球 (可选，这里暂时不动)
        if is_def_league:
            msg_suffix = " 🛡️DefMode"

    # 4. 重新归一化
    total_prob = sum(probs.values())
    dist8 = [0.0]*8
    if total_prob > 0:
        for g in range(8):
            dist8[g] = probs.get(g, 0.0) / total_prob
    else:
        dist8 = [0.0]*8

    # 5. 输出
    msg = f"{ou_tag} H:{lambda_h:.2f}/A:{lambda_a:.2f} | Total:{total_xg_exp:.2f} (LAvg:{lg_g_total:.2f}){msg_suffix}"

    return {
        "top3": topk_from_dist8(dist8, 3), # dist8 在后面代码里有计算，不用动
        "xg": lambda_h + lambda_a,
        "ou_tag": ou_tag,
        "ou_gap": ou_gap,
        "active": True,
        "msg": msg,
        "gp": 10, # 虚拟场次
        "dist": probs,
        "dist8": dist8,
        "h_stats": h_data, "a_stats": a_data
    }
# ================= [UPDATE] 时间轴深度分析 (含 Swing/Vol & Series) =================
def analyze_timeline_dynamics(timeline_list: List[Dict]):
    """深度解析 timeline，计算赔率初速度、末速度、急跌、阴跌、波动率、振幅，并识别形态(拉扯/回拉)。"""
    default_res = {
        "active": False, "msg": "数据不足", "is_rapid": False, "tags": [],
        "total_drift": 0.0, "last_move": 0.0, "steps": 0, "p_start": 0, "p_end": 0,
        "swing": 0.0, "vol": 0.0, "p3_series": [],
        "edge_delta": 0.0, "tail_delta": 0.0, "ent_delta": 0.0,
        "edge_series": [], "tail_series": [], "ent_series": [],
        # new fields (不会影响旧界面，未用到也没事)
        "sign_changes": 0, "shape": "none", "is_whipsaw": False, "is_reversal": False,
        "rapid_confirmed": False
    }

    if not timeline_list or len(timeline_list) < 2:
        return default_res

    valid_snaps = []
    for item in timeline_list:
        odds = [item.get(f'g{i}' if i < 7 else 'g7plus', 0) for i in range(8)]
        if sum(odds) == 0:
            continue
        valid_snaps.append({"o": odds})

    if len(valid_snaps) < 2:
        return default_res

    # 提取概率序列（统一在去水概率域计算）
    def get_probs(odds):
        return odds_to_probs_fair(odds)

    probs_series = [get_probs(s['o']) for s in valid_snaps]
    # P3+（3球及以上）
    p3_series = [float(sum(p[3:])) for p in probs_series]

    # 细分三项：
    # edge = P3 - P2（用于 2 vs 3 边界）
    # tail_ratio = P4+ / P3（尾部厚度）
    # entropy（分布发散度）
    edge_series = [float(p[3] - p[2]) for p in probs_series]
    tail_series = [float(sum(p[4:]) / max(p[3], 1e-9)) for p in probs_series]
    ent_series = []
    for p in probs_series:
        e = 0.0
        for x in p:
            if x > 0:
                e -= x * math.log(x)
        ent_series.append(float(e))

    edge_delta = float(edge_series[-1] - edge_series[-2]) if len(edge_series) >= 2 else 0.0
    tail_delta = float(tail_series[-1] - tail_series[-2]) if len(tail_series) >= 2 else 0.0
    ent_delta  = float(ent_series[-1] - ent_series[-2]) if len(ent_series) >= 2 else 0.0

    p_start = p3_series[0]
    p_end = p3_series[-1]
    total_drift = float(p_end - p_start)
    last_move = float(p_end - p3_series[-2])

    swing = float(max(p3_series) - min(p3_series))

    # vol：路径长度（与你原脚本/界面一致，便于显示“vol=5.5%”这种口径）
    vol = 0.0
    diffs = []
    for i in range(1, len(p3_series)):
        d = float(p3_series[i] - p3_series[i-1])
        diffs.append(d)
        vol += abs(d)

    # 方向切换次数（忽略很小的噪声）
    eps = 0.003  # 0.3pp 噪声带，避免微抖动被当成“拉扯”
    signs = []
    for d in diffs:
        if abs(d) < eps:
            continue
        signs.append(1 if d > 0 else -1)
    sign_changes = 0
    for i in range(1, len(signs)):
        if signs[i] != signs[i-1]:
            sign_changes += 1

    # 形态识别（用于“出手纪律”，不强行改变你原标签体系）
    is_whipsaw = (sign_changes >= 2) or (vol > (abs(total_drift) + 1e-9) * 1.8 and swing > abs(total_drift) * 1.2)
    is_reversal = (sign_changes == 1 and swing > 0.03 and abs(total_drift) < swing * 0.65)

    if is_whipsaw:
        shape = "whipsaw"
    elif is_reversal:
        shape = "reversal"
    elif total_drift > 0.03:
        shape = "trend_up"
    elif total_drift < -0.03:
        shape = "trend_down"
    else:
        shape = "stable"

    # [TAGS GENERATION LOGIC] — 保持你原脚本“标签+cls”结构
    tags = []
    is_rapid = False

    # —— 核心升级：⚡阈值回到 2.5pp，但必须满足“确认条件”（单边/非拉扯/末段显著）——
    # 1) abs(last_move) >= 2.5pp
    # 2) sign_changes <= 1（单边或弱回拉）
    # 3) 非拉扯：vol 不显著大于 |drift|（允许轻微差异）
    # 4) swing 不要远大于 |drift|（避免“走回去”的诱导盘）
    rapid_confirmed = (
        abs(last_move) >= 0.025 and
        sign_changes <= 1 and
        (abs(total_drift) >= 1e-6) and
        (vol <= abs(total_drift) * 1.25) and
        (swing <= abs(total_drift) * 1.35)
    )

    if rapid_confirmed:
        is_rapid = True
        direction = "升" if last_move > 0 else "降"
        tags.append({"text": f"⚡ 临场{direction} ({last_move:+.1%})", "cls": "tag-purple"})

    # 2. 主力抢筹 vs 震荡洗盘（保持原口径，但对“拉扯盘”强制归入洗盘）
    if abs(total_drift) > 0.03:
        if (not is_whipsaw) and vol <= abs(total_drift) * 1.2:
            direction = "抢筹" if total_drift > 0 else "出货"
            cls = "tag-red" if total_drift > 0 else "tag-blue"
            tags.append({"text": f"🚀 主力{direction} (单边)", "cls": cls})
        else:
            tags.append({"text": "🌊 震荡洗盘", "cls": "tag-yellow"})

    # 2.5 形态额外提示（不影响你原UI拼接，属于加信息）
    if is_whipsaw:
        tags.append({"text": "🌀 拉扯盘", "cls": "tag-yellow"})
    elif is_reversal:
        tags.append({"text": "🔁 回拉修正", "cls": "tag-yellow"})

    # 3. 阴跌/阴升（保留你原逻辑：|drift|>5pp 且非临场突击）
    if abs(total_drift) > 0.05 and not is_rapid:
        direction = "升" if total_drift > 0 else "降"
        tags.append({"text": f"📈 长时阴{direction}", "cls": "tag-gray"})

    return {
        "active": True, "p_start": p_start, "p_end": p_end,
        "total_drift": total_drift, "last_move": last_move,
        "steps": len(valid_snaps), "tags": tags, "is_rapid": is_rapid,
        "swing": swing, "vol": vol, "p3_series": p3_series,
        "edge_delta": edge_delta, "tail_delta": tail_delta, "ent_delta": ent_delta,
        "edge_series": edge_series, "tail_series": tail_series, "ent_series": ent_series,
        "sign_changes": sign_changes, "shape": shape,
        "is_whipsaw": is_whipsaw, "is_reversal": is_reversal,
        "rapid_confirmed": rapid_confirmed
    }

def extract_timeline_features(history_dict: Dict) -> Dict:
    try:
        timeline = (history_dict or {}).get('timeline', []) or []
        if len(timeline) < 2: return {"steps": len(timeline)}
        return {"steps": len(timeline)}
    except Exception:
        LOGGER.exception("extract_timeline_features 解析失败")
        return {"steps": 0}

# ================= 决策中心优化 =================
class EnsembleRiskManager:
    def __init__(self):
        self.matrix = self.load_json(MATRIX_FILE)
        self.trap_hunter = TrapHunter(); self.weight_adjuster = DynamicWeightAdjuster(RECORD_DB_FILE)
        self.league_guard_names = set()
        self.league_guard_profiles = {}
    def load_json(self, filepath):
        if os.path.exists(filepath):
            try:
                with open(filepath, 'r', encoding='utf-8') as f: return json.load(f)
            except Exception:
                LOGGER.exception("JSON加载失败: %s", filepath)
                return {}
        return {}

    def scan_curve_deformation(self, initial_odds, final_odds, ai_result):
        if sum(initial_odds) == 0 or sum(final_odds) == 0: return None
        init_p = odds_to_probs_fair(initial_odds); final_p = odds_to_probs_fair(final_odds)
        changes = [final_p[i] - init_p[i] for i in range(8)]
        median_change = float(np.median(changes)); max_deviation = 0.0; target_idx = -1
        for i, change in enumerate(changes):
            dev = abs(float(change) - median_change)
            if dev > max_deviation: max_deviation = dev; target_idx = i
        if max_deviation > DEFORMATION_DEV_P:
            current_trend = float(changes[target_idx])
            if current_trend > median_change:
                ai_direction = ai_result.get('type', 'UNKNOWN') if ai_result else 'UNKNOWN'
                msg = ""; color = "#f97316"; border_style = "solid"; lbl = f"{target_idx}" if target_idx < 7 else "7+"
                if target_idx <= 2:
                    if ai_direction == "SMALL": msg = f"📉共振! AI也看小, 真实防守{lbl}球"; color = "#3b82f6"
                    elif ai_direction == "BIG": msg = f"🎣诱盘! AI看大, 无视降赔博大球"; color = "#10b981"; border_style = "dashed"
                    else: msg = f"⚠️鬼手: 独降{lbl}球 (AI未明确)"
                elif target_idx >= 4:
                    if ai_direction == "BIG": msg = f"🔥共振! AI也看大, 庄家真实降赔"; color = "#ef4444"
                    elif ai_direction == "SMALL": msg = f"🪤诱盘! AI看小, {lbl}球或是陷阱"; color = "#f59e0b"; border_style = "dashed"
                    else: msg = f"⚠️鬼手: 独降{lbl}球 (AI未明确)"
                else:
                    if ai_direction == "BIG": msg = f"✅真大球! 3球降赔+AI看好"; color = "#ef4444"
                    elif ai_direction == "SMALL": msg = f"❌假大球! 3球降赔但AI看小"; color = "#94a3b8"
                    else: msg = f"⚡鬼手: 独降3球 (方向不明)"
                return {"type": "DEFORMATION", "target": target_idx, "msg": msg, "color": color, "border": border_style}
        return None
    def fuse_dist8(self, dist_weight_list, mode="geo", eps=1e-12):
        """
        dist_weight_list: [(dist8, weight), ...]
        mode: "geo"=几何融合(更尖锐), "avg"=算术融合(更平滑)
        """
        items = [(normalize_dist8(d), float(w)) for d, w in dist_weight_list if d and w > 0]
        if not items:
            return [0.0]*8
        if mode == "avg":
            out = [0.0]*8
            wsum = 0.0
            for d, w in items:
                wsum += w
                for i in range(8):
                    out[i] += w * d[i]
            if wsum > 0:
                out = [x/wsum for x in out]
            return normalize_dist8(out)
        # geo
        logv = [0.0]*8
        wsum = 0.0
        for d, w in items:
            wsum += w
            for i in range(8):
                logv[i] += w * math.log(max(d[i], eps))
        out = [math.exp(x / max(wsum, eps)) for x in logv]
        return normalize_dist8(out)


    def analyze(self, match, odds_history, anl_v9, anl_v7, anl_xg, anl_poisson, ai_result, multi_res, ou_info=None):
        league_name = match.get('league', '未知')
        tier, tier_label = get_league_tier(league_name)
        current_weights = self.weight_adjuster.get_adjusted_weights(league_name)
        guard_profiles = getattr(self, "league_guard_profiles", {}) or {}
        guard_profile = get_guard_profile(league_name, guard_profiles) if LEAGUE_GUARD_ENABLE else None
        league_guard_active = bool(guard_profile)
        guard_level = int((guard_profile or {}).get("level", 0) or 0)
        guard_strategies = set((guard_profile or {}).get("strict_strategies", list(LEAGUE_GUARD_STRICT_STRATEGIES)))
        league_guard_note = ""
        if league_guard_active:
            traj_mult = float((guard_profile or {}).get("trajectory_mult", LEAGUE_GUARD_TRAJECTORY_MULT) or LEAGUE_GUARD_TRAJECTORY_MULT)
            matrix_mult = float((guard_profile or {}).get("matrix_mult", LEAGUE_GUARD_MATRIX_MULT) or LEAGUE_GUARD_MATRIX_MULT)
            current_weights["Trajectory"] = float(current_weights.get("Trajectory", 1.0) or 1.0) * traj_mult
            current_weights["Matrix_Base"] = float(current_weights.get("Matrix_Base", 1.0) or 1.0) * matrix_mult
            league_guard_note = f"🛡️联赛风控L{guard_level}"
        # ================= [修改 2] 相关性惩罚逻辑 =================
        # 提取各引擎的前2名推荐 (排序后对比，忽略顺序)
        def get_top2_set(anl_res):
            if not anl_res or 'top3' not in anl_res: return set()
            # 取前2名，转为集合方便对比
            return set([x[0] for x in anl_res['top3'][:2]])

        s_v9 = get_top2_set(anl_v9)
        s_v7 = get_top2_set(anl_v7)
        s_hist = get_top2_set(anl_xg)

        penalty_tags = []

        # 1) V9 vs V7：完全重叠重罚，部分重叠轻罚
        ov_v9_v7 = len(s_v9 & s_v7)
        if len(s_v9) >= 2 and ov_v9_v7 >= 1:
            pen = 0.60 if ov_v9_v7 >= 2 else 0.80
            current_weights['V7'] = current_weights.get('V7', 0.8) * pen
            penalty_tags.append(f"V7重叠x{pen:.2f}")

        # 2) V9 vs Hist：完全重叠重罚，部分重叠轻罚
        ov_v9_hist = len(s_v9 & s_hist)
        if len(s_v9) >= 2 and ov_v9_hist >= 1:
            pen = 0.70 if ov_v9_hist >= 2 else 0.85
            current_weights['Hist'] = current_weights.get('Hist', 1.2) * pen
            penalty_tags.append(f"Hist重叠x{pen:.2f}")

        # (可选) 将惩罚信息加入逻辑显示，方便你调试看
        if penalty_tags:
            print(f"   ⚠️ [{match.get('display_name')}] 触发相关性惩罚: {','.join(penalty_tags)}")
        # ================= [修改 2 结束] =================
        king_identity = None; leader_identity = None
        engine_weights_subset = {k:v for k,v in current_weights.items() if k in ['V9', 'Hist', 'V7', 'Poisson_Base']}
        sorted_engines = sorted(engine_weights_subset.items(), key=lambda x:x[1], reverse=True)
        if sorted_engines[0][1] >= 1.8: king_identity = sorted_engines[0][0]
        elif sorted_engines[0][1] >= 1.4: leader_identity = sorted_engines[0][0]
        v9_top3 = anl_v9['top3']; v7_top3 = anl_v7['top3']; hist_top3 = anl_xg['top3']
        v9_dist8 = anl_v9.get("dist8", [0.0]*8)
        v7_dist8 = anl_v7.get("dist8", [0.0]*8)
        hist_dist8 = anl_xg.get("dist8", [0.0]*8)
        pois_dist8 = anl_poisson.get("dist8", [0.0]*8) if anl_poisson.get("active") else None

        final = odds_history.get('final', {}); initial = odds_history.get('initial', {})
        l_f = [final.get(f'g{i}' if i<7 else 'g7plus', 0) for i in range(8)]
        l_i = [initial.get(f'g{i}' if i<7 else 'g7plus', 0) for i in range(8)]
        init_probs = odds_to_probs_fair(l_i); final_probs = odds_to_probs_fair(l_f)
        deformation_alert = self.scan_curve_deformation(l_i, l_f, ai_result)
        ai_traps = self.trap_hunter.detect(l_i, l_f)
        timeline_list = odds_history.get('timeline', [])
        timeline_analysis = analyze_timeline_dynamics(timeline_list)
        scoreboard = defaultdict(float)
        g0_f = l_f[0]; g0_i = initial.get('g0', 0); o2 = l_f[2]; o3 = l_f[3]
        depth_p = (final_probs[3] - final_probs[2]) if final_probs else 0.0
        is_inverted = depth_p > 0; inversion_depth = (o2 - o3)
        matrix_active = False; matrix_dist = None; matrix_desc = ""; matrix_meta = None
        matrix_data = self.matrix.get(league_name)
        strategy_code = "STD"

        # Matrix DNA Logic
        if matrix_data:
            range_key = get_matrix_range_key(g0_f); node = matrix_data.get(range_key)
            if node and is_inverted and depth_p >= MIN_INVERSION_DEPTH_P and node.get('sample',0) >= MIN_MATRIX_SAMPLE:
                matrix_active = True; matrix_dist = node.get('dist')
                matrix_meta = {
                    'bucket_key': range_key, 'sample': node.get('sample', 0), 'confidence': node.get('confidence', 0),
                    'bucket_share_in_league': node.get('bucket_share_in_league', None),
                    'total_in_league_after_filter': node.get('total_in_league_after_filter', None),
                    'inversion_depth': inversion_depth,
                }
                matrix_desc = f"🗺️ 矩阵入局(信度{int(node.get('confidence',0)*100)}%)"
                strategy_code = "VOTE_M"
                for g in node['top2']: scoreboard[g] += node.get('confidence',0) * current_weights["Matrix_Base"]
        if not matrix_active: matrix_desc = "🦁 标准模式"; strategy_code = "VOTE_S" if king_identity else "STD"
        fusion_mult = self.weight_adjuster.get_fusion_multipliers(league_name, strategy_code)
        fusion_group = fusion_mult.pop("__group__", get_league_group(league_name))
        fusion_strat = fusion_mult.pop("__strategy__", strategy_code)
        fusion_applied = []
        for k, m in fusion_mult.items():
            if k in current_weights:
                current_weights[k] = current_weights.get(k, 1.0) * float(m)
                if abs(float(m) - 1.0) >= 0.03:
                    fusion_applied.append(f"{k}x{float(m):.2f}")
        fusion_note = ""
        if fusion_applied:
            fusion_note = f"🧬组融合[{fusion_group}/{fusion_strat}]:" + ",".join(fusion_applied)

        def cast_vote(engine_name, recs, weight_key):
            w = current_weights.get(weight_key, 1.0)
            if engine_name == king_identity: w *= 1.2
            for i, (g,_) in enumerate(recs[:3]): scoreboard[g] += [5,3,1][i] * w
        dist_items = []

        def w_of(key):
            w = float(current_weights.get(key, 1.0) or 1.0)
            if key == king_identity:
                w *= 1.2
            return w

        dist_items.append((v9_dist8, w_of("V9")))
        dist_items.append((hist_dist8, w_of("Hist")))
        dist_items.append((v7_dist8, w_of("V7")))
        cast_vote("V9", v9_top3, "V9")
        cast_vote("V7", v7_top3, "V7")
        cast_vote("Hist", hist_top3, "Hist")
        if anl_poisson.get("active"):
            dist_items.append((pois_dist8, w_of("Poisson_Base")))
            cast_vote("Poisson_Base", anl_poisson['top3'], "Poisson_Base")
        # ========== [NEW] 注入大小球盘口意志 ==========
        ou_html_snippet = ""
        #ou_arbitration = None
        market_arbitrator = MarketLineArbitrator() # 实例化

        if ou_info:
            # 1. 进行博弈分析
            ou_arb = market_arbitrator.analyze(ou_info)

            if ou_arb:
                # 2. 修正分数 (权重 3.0)
                OU_WEIGHT = 3.0
                for g, val in ou_arb.get('score_boost', {}).items():
                    scoreboard[g] += val * OU_WEIGHT

                # 3. 生成 HTML 片段
                tag = ou_arb['tag']
                col = ou_arb['color']
                desc = ou_arb['desc']
                l_str = str(ou_info.get('line_str', ''))
                o_odd = str(ou_info.get('over', ''))

                ou_html_snippet = f"<div style='margin-top:6px; padding:6px; background:{col}15; border:1px solid {col}; border-radius:4px; display:flex; justify-content:space-between; align-items:center;'><div style='display:flex; flex-direction:column;'><span style='font-size:10px; color:{col}; font-weight:bold;'>{tag}</span><span style='font-size:9px; color:#94a3b8;'>{desc}</span></div><div style='text-align:right;'><div style='font-size:12px; font-weight:bold; color:#e2e8f0;'>{l_str}球</div><div style='font-size:9px; color:#cbd5e1;'>大{o_odd}</div></div></div>"

                # 将大小球分析作为重要理由加入 "what" 字段
                matrix_desc += f" ⚖️{tag}"
        if timeline_analysis.get('active'):
            drift = float(timeline_analysis.get('total_drift', 0.0) or 0.0)
            move = float(timeline_analysis.get('last_move', 0.0) or 0.0)
            traj_w = float(current_weights.get("Trajectory", 1.0) or 1.0)

            is_whipsaw = bool(timeline_analysis.get('is_whipsaw', False))
            is_reversal = bool(timeline_analysis.get('is_reversal', False))
            rapid_ok = bool(timeline_analysis.get('rapid_confirmed', timeline_analysis.get('is_rapid', False)))

            # —— 出手纪律（你确认的“最优方案”）——
            # 1) long drift（🌊）作为背景信号：>5pp 才参与
            # 2) ⚡只在 rapid_confirmed 时出手（2.5pp + 单边确认）
            # 3) 拉扯盘：不看 drift，仅允许⚡轻量参与（防噪声/诱导）
            # 4) 回拉盘：弱化 drift，强调末段 move（修正信息）
            if is_whipsaw:
                # 拉扯盘：只允许强末段轻量影响
                if rapid_ok:
                    if move > 0:
                        for g in [3, 4, 5]:
                            scoreboard[g] += 2.5 * traj_w
                    else:
                        for g in [0, 1, 2]:
                            scoreboard[g] += 2.5 * traj_w
            else:
                # 非拉扯盘：long drift 背景加分
                if drift > 0.05:
                    for g in [3, 4, 5, 6, 7]:
                        scoreboard[g] += (2.5 if is_reversal else 3.0) * traj_w
                elif drift < -0.05:
                    for g in [0, 1, 2]:
                        scoreboard[g] += (2.5 if is_reversal else 3.0) * traj_w

                # ⚡末段：回拉盘更重末段；普通趋势盘按原强度
                if rapid_ok:
                    if move > 0:
                        for g in [3, 4, 5]:
                            scoreboard[g] += (6.0 if is_reversal else 5.0) * traj_w
                    else:
                        for g in [0, 1, 2]:
                            scoreboard[g] += (6.0 if is_reversal else 5.0) * traj_w
        h_st = anl_poisson.get('h_stats', {}); a_st = anl_poisson.get('a_stats', {})
        avg_bts = (h_st.get('bts',0) + a_st.get('bts',0)) / 2
        logic_msg = ""
        if avg_bts > BTS_HIGH_AVG and avg_bts < 1.0: logic_msg = "🔥互爆"
        elif avg_bts > 0 and avg_bts < BTS_LOW_AVG: logic_msg = "💤便秘"
        trend_msg = ""

        # 1. 计算融合分布 & 模型共识 xG
        fused_dist8 = self.fuse_dist8(dist_items, mode="geo")
        model_xg_consensus = 0
        model_goals = [0, 1, 2, 3, 4, 5, 6, 7.5]
        for idx, p_val in enumerate(fused_dist8):
            model_xg_consensus += p_val * model_goals[idx]

        # 2. 计算分歧度 (Model xG - Market Implied xG)
        market_xg = calculate_xg(final_probs)
        xg_diff = model_xg_consensus - market_xg

        anti_tac_msg = ""
        anti_tac_color = "#64748b"
        anti_tac_bg = "rgba(100, 116, 139, 0.1)"
        force_star_zero = False

        # 3. 触发反脆弱逻辑
        # 场景A: 模型严重看大 (比庄家多0.75球)，但庄家不开大 -> 极大概率是诱大或有主力缺阵
        if xg_diff > 0.75:
            # 如果没有临场资金强力支持(Timeline)，则视为陷阱
            if not timeline_analysis.get('is_rapid'):
                anti_tac_msg = f"[🛡️ 风控介入]：模型过热预警！数据看大(xG{model_xg_consensus:.2f})但庄家保守(xG{market_xg:.2f})，谨防诱多，建议放弃或反打小。"
                anti_tac_color = "#f43f5e" # 玫瑰红
                anti_tac_bg = "rgba(244, 63, 94, 0.15)"
                force_star_zero = True
                logic_msg += " ⚠️模型与庄家背离"

        # 场景B: 模型严重看小，但庄家开得深 -> 庄家看好有球，信庄家
        elif xg_diff < -0.70:
            if timeline_analysis.get('last_move', 0) >= 0:
                 anti_tac_msg = f"[👁️ 庄家视角]：模型看小但盘口坚挺。庄家掌握额外信息，关注临场大球。"
                 anti_tac_color = "#8b5cf6" # 紫色
                 anti_tac_bg = "rgba(139, 92, 246, 0.15)"
                 # 这种情况下，给高进球数加分
                 for g in [3, 4]: scoreboard[g] += 10.0

        if g0_i > 0 and g0_f > 0:
            diff = g0_f - g0_i
            if diff >= 1.0: trend_msg = f"✅ 0赔上浮(+{diff:.1f})"
            elif diff <= -1.0: trend_msg = f"📉 0赔跳水({diff:.1f})"
        top3_fused = topk_from_dist8(fused_dist8, 3)
        final_rec = [g for g, _ in top3_fused[:2]]
        # ===== [GATE v3 上线版：限定策略 + 共识接管] =====
        ALLOW_STRATEGIES = {"SLOPE", "VOTE_M", "VOTE_S"}
        TAKEOVER_TH = 2  # agree_pairs <= 2 触发

        top2_v9 = [x[0] for x in v9_top3[:2]]
        top2_hist = [x[0] for x in hist_top3[:2]]
        top2_v7 = [x[0] for x in v7_top3[:2]]

        def _overlap(a, b): return len(set(a) & set(b))
        def _set_eq2(a, b): return len(a) == 2 and len(b) == 2 and set(a) == set(b)

        def consensus_pick(v9, hist, v7, old_final):
            v9, hist, v7, old_final = (v9 or [])[:2], (hist or [])[:2], (v7 or [])[:2], (old_final or [])[:2]

            # 1) 优先 hist==v7（你历史上更稳）
            if _set_eq2(hist, v7): return hist[:]
            if _set_eq2(v9, hist): return v9[:]
            if _set_eq2(v9, v7):   return v9[:]

            # 2) 三者交集优先
            inter = list(set(v9) & set(hist) & set(v7))

            # 3) 多数表决补齐
            cnt = Counter(v9 + hist + v7)
            majority = [k for k, _ in sorted(cnt.items(), key=lambda kv: (-kv[1], kv[0]))]

            rec = []
            for x in inter:
                if x not in rec: rec.append(x)
                if len(rec) >= 2: return rec[:2]
            for x in majority:
                if x not in rec: rec.append(x)
                if len(rec) >= 2: return rec[:2]

            return old_final[:2] if old_final else []

        # ---- pairwise overlap evidence ----
        ov_v9_hist = _overlap(top2_v9, top2_hist)
        ov_v9_v7   = _overlap(top2_v9, top2_v7)
        ov_hist_v7 = _overlap(top2_hist, top2_v7)

        agree_pairs = 0
        agree_pairs += int(ov_v9_hist > 0)
        agree_pairs += int(ov_v9_v7 > 0)
        agree_pairs += int(ov_hist_v7 > 0)

        overlap_cnt = {"v9_hist": ov_v9_hist, "v9_v7": ov_v9_v7, "hist_v7": ov_hist_v7}
        overlap_bin = {k: int(v > 0) for k, v in overlap_cnt.items()}
        overlap_text = f"ov(v9-hist={ov_v9_hist}, v9-v7={ov_v9_v7}, hist-v7={ov_hist_v7})"

        gate_info = {
            "version": "gate_v3_filtered_consensus",
            "league": league_name,
            "strategy": strategy_code,
            "agree_pairs": agree_pairs,

            # ✅ 新增：overlap 证据
            "overlap_cnt": overlap_cnt,   # 具体重叠个数（0/1/2）
            "overlap_bin": overlap_bin,   # 是否重叠（0/1）
            "overlap_text": overlap_text, # 便于日志/报告快速扫

            "took_over": False,
            "reason": "not_triggered",
            "old_final": final_rec[:],
            "new_final": final_rec[:],
            "v9": top2_v9[:],
            "hist": top2_hist[:],
            "v7": top2_v7[:],
            "low_conf": False,
            "low_conf_reasons": [],
        }

        gate_info["tag"] = "GATE_V3_NO"

        if (strategy_code in ALLOW_STRATEGIES) and (agree_pairs <= TAKEOVER_TH):
            cons = consensus_pick(top2_v9, top2_hist, top2_v7, final_rec)
            if cons and (cons != final_rec):
                old = final_rec[:]
                final_rec = cons[:]
                gate_info["took_over"] = True
                gate_info["tag"] = "GATE_V3_TAKEOVER"
                gate_info["reason"] = f"filtered_consensus_takeover<= {TAKEOVER_TH}"
                gate_info["old_final"] = old[:]
                gate_info["new_final"] = final_rec[:]

                # 只在接管时打印（上线不刷屏）
                print(
                    f"[GATE] takeover(v3) league={league_name} strategy={strategy_code} "
                    f"agree_pairs={agree_pairs} old={old} new={final_rec} "
                    f"v9={top2_v9} hist={top2_hist} v7={top2_v7}",
                    flush=True
                )
            else:
                gate_info["reason"] = "no_change"
        else:
            if strategy_code not in ALLOW_STRATEGIES:
                gate_info["reason"] = "strategy_not_allowed"
            elif agree_pairs > TAKEOVER_TH:
                gate_info["reason"] = "agree_pairs_too_high"
        # ===== [GATE v3 结束] =====

        if league_guard_active and strategy_code in guard_strategies:
            old = final_rec[:]
            safe = consensus_pick(top2_v9, top2_hist, top2_v7, final_rec)
            if safe and safe != final_rec:
                final_rec = safe[:]
                gate_info["old_final"] = old[:]
                gate_info["new_final"] = final_rec[:]
                print(
                    f"[GUARD] league={league_name} strategy={strategy_code} old={old} new={final_rec} "
                    f"v9={top2_v9} hist={top2_hist} v7={top2_v7}",
                    flush=True
                )
            strategy_code = "LEAGUE_GUARD"
            gate_info["tag"] = "LEAGUE_GUARD"
            gate_info["reason"] = "weak_league_conservative_override"
            gate_info["strategy"] = strategy_code
            gate_info["guard_level"] = guard_level
            gate_info["guard_reasons"] = list((guard_profile or {}).get("reasons", []))

        support_cnt = Counter(top2_v9 + top2_hist + top2_v7)
        low_conf_reasons = []
        top1_prob = float(top3_fused[0][1]) if top3_fused else 0.0
        top2_sum = float(sum([x[1] for x in top3_fused[:2]])) if top3_fused else 0.0
        top3_prob = float(top3_fused[2][1]) if len(top3_fused) >= 3 else 0.0
        margin_13 = top1_prob - top3_prob
        top1_goal = final_rec[0] if final_rec else None
        top1_support = int(support_cnt.get(top1_goal, 0)) if top1_goal is not None else 0

        if top1_prob < LOW_CONF_MIN_TOP1:
            low_conf_reasons.append(f"top1<{LOW_CONF_MIN_TOP1:.2f}")
        if top2_sum < LOW_CONF_MIN_TOP2_SUM:
            low_conf_reasons.append(f"top2sum<{LOW_CONF_MIN_TOP2_SUM:.2f}")
        if margin_13 < LOW_CONF_MIN_MARGIN and agree_pairs <= LOW_CONF_MAX_AGREE_PAIRS:
            low_conf_reasons.append(f"margin<{LOW_CONF_MIN_MARGIN:.2f}")
        if top1_support <= LOW_CONF_MAX_TOP1_SUPPORT and agree_pairs <= LOW_CONF_MAX_AGREE_PAIRS:
            low_conf_reasons.append("low_engine_support")

        low_conf_trigger = LOW_CONF_ENABLE and (len(low_conf_reasons) >= LOW_CONF_REQUIRE_REASONS)
        low_conf_note = ""
        if low_conf_trigger:
            old = final_rec[:]
            safe_final = consensus_pick(top2_v9, top2_hist, top2_v7, final_rec)
            if safe_final and safe_final != final_rec:
                final_rec = safe_final[:]
                gate_info["old_final"] = old[:]
                gate_info["new_final"] = final_rec[:]
            gate_info["low_conf"] = True
            gate_info["low_conf_reasons"] = low_conf_reasons[:]
            gate_info["tag"] = "LOW_CONF_GATE"
            gate_info["reason"] = "low_confidence_gate"
            strategy_code = "LOWCONF"
            gate_info["strategy"] = strategy_code
            low_conf_note = f"（低置信门控:{'|'.join(low_conf_reasons)}）"

        # VOTE_M 专项：三引擎高分歧时，用 Hist 作为保守锚点（仅在未触发更高优先级门控时）
        if VOTE_M_HIST_TIEBREAK_ENABLE and strategy_code == "VOTE_M":
            s_v9 = set(top2_v9)
            s_v7 = set(top2_v7)
            s_hist = set(top2_hist)
            all_distinct = (len(s_v9) == 2 and len(s_v7) == 2 and len(s_hist) == 2 and not (s_v9 == s_v7 or s_v9 == s_hist or s_v7 == s_hist))
            matrix_conf = float((matrix_meta or {}).get("confidence", 1.0) or 1.0)
            hist_weight_ok = True
            if VOTE_M_HIST_TIEBREAK_REQUIRE_HIST_TOP_WEIGHT:
                hist_w = float(current_weights.get("Hist", 1.0) or 1.0)
                v9_w = float(current_weights.get("V9", 1.0) or 1.0)
                v7_w = float(current_weights.get("V7", 1.0) or 1.0)
                hist_weight_ok = hist_w >= max(v9_w, v7_w)
            if all_distinct and matrix_conf <= VOTE_M_HIST_TIEBREAK_MAX_MATRIX_CONF and hist_weight_ok:
                hist_anchor = top2_hist[:]
                if len(hist_anchor) == 2 and hist_anchor != final_rec:
                    old = final_rec[:]
                    final_rec = hist_anchor[:]
                    gate_info["old_final"] = old
                    gate_info["new_final"] = final_rec[:]
                    gate_info["vote_m_hist_tiebreak"] = True
                    gate_info["tag"] = "VOTE_M_HIST_TIEBREAK"
                    gate_info["reason"] = "vote_m_three_engine_divergence"
                    print(
                        f"[VOTE_M] hist_tiebreak league={league_name} old={old} new={final_rec} "
                        f"conf={matrix_conf:.2f} w_hist={current_weights.get('Hist',1.0):.2f} "
                        f"w_v9={current_weights.get('V9',1.0):.2f} w_v7={current_weights.get('V7',1.0):.2f} "
                        f"v9={top2_v9} hist={top2_hist} v7={top2_v7}",
                        flush=True
                    )

        star_score = 0
        if final_rec:
            if matrix_active: star_score = 5
            elif king_identity: star_score = 4
            else: star_score = 3
        if force_star_zero:
            star_score = 0
        if low_conf_trigger:
            star_score = min(star_score, LOW_CONF_STAR_CAP)
        if league_guard_active:
            guard_star_cap = int((guard_profile or {}).get("star_cap", LEAGUE_GUARD_STAR_CAP) or LEAGUE_GUARD_STAR_CAP)
            star_score = min(star_score, guard_star_cap)
        score_debug = f"(FusedTop3: {[(g, round(p,3)) for g,p in top3_fused]})"
        combined_traps = []
        if anl_poisson['active']:
            p_dist = anl_poisson.get('dist', {})
            for g in [2, 3]:
                odd = l_f[g]
                if odd > 0:
                    implied_prob = 1.0 / odd; real_prob = p_dist.get(g, 0)
                    if real_prob < (implied_prob - 0.10): combined_traps.append(f"🪤{g}球(Pois陷阱)")
        for t in ai_traps: combined_traps.append(t)
        tactical_msg = anti_tac_msg
        tactical_color = anti_tac_color if anti_tac_msg else "#64748b"
        tactical_bg = anti_tac_bg if anti_tac_msg else "rgba(100, 116, 139, 0.1)"
        has_trap = len(combined_traps) > 0
        is_high_xg = anl_poisson['xg'] > 3.0 or (len(anl_poisson.get('top3',[])) > 0 and anl_poisson['top3'][0][0] >= 3)
        top1_goal = anl_poisson['top3'][0][0] if len(anl_poisson.get('top3',[])) > 0 else 0
        is_squeeze = False
        try:
            gap_init = (init_probs[3] - init_probs[2]); gap_final = (final_probs[3] - final_probs[2])
            if (gap_final - gap_init) >= 0.03: is_squeeze = True
        except Exception:
            LOGGER.debug("is_squeeze 计算失败", exc_info=True)
            is_squeeze = False
        if timeline_analysis.get('is_rapid') and not force_star_zero:
             direction = "大球" if timeline_analysis.get('last_move', 0) > 0 else "小球"
             tactical_msg = f"[🎯 战术指令]：监测到临场【{direction}】资金异动！跟随聪明钱，注意防范剧本反转。"
             tactical_color = "#8b5cf6"; tactical_bg = "rgba(139, 92, 246, 0.15)"
        elif is_high_xg and has_trap:
             tactical_msg = "[🎯 战术指令]：诱盘警报！数据看大但存在陷阱。建议避开陷阱，小注博 4球/5球。"
             tactical_color = "#ef4444"; tactical_bg = "rgba(239, 68, 68, 0.15)"
        elif (top1_goal <= 2) and is_squeeze:
             tactical_msg = "[🎯 战术指令]：穿盘预警！基本面保守但资金狂冲3球。建议防范 3-0/2-1，不要死守小球。"
             tactical_color = "#f59e0b"; tactical_bg = "rgba(245, 158, 11, 0.15)"
        elif star_score == 0 and not tactical_msg:
             tactical_msg = "[🎯 战术指令]：极度混乱。引擎打架，风险过高，建议直接放弃。"
             tactical_color = "#94a3b8"; tactical_bg = "rgba(148, 163, 184, 0.1)"
        if low_conf_trigger:
            tactical_msg = "[🎯 战术指令]：低置信门控触发，建议降仓或放弃本场。"
            tactical_color = "#94a3b8"; tactical_bg = "rgba(148, 163, 184, 0.15)"
        v9_str = str([x[0] for x in v9_top3[:2]])
        v7_str = str([x[0] for x in v7_top3[:2]])
        hist_str = str([x[0] for x in hist_top3[:2]])
        def mark_status(name, recs_str, key):
            w = current_weights.get(key, 1.0); base = BASE_WEIGHT_CONFIG.get(key, 1.0)
            status_icon = ""
            if w > base * 1.1: status_icon = "🔥"
            elif w < base * 0.9: status_icon = "❄️"

            if key == king_identity:
                return f"👑{name}{status_icon}:{recs_str}"
            elif key == leader_identity:
                return f"🚩{name}{status_icon}:{recs_str}"
            return f"{name}{status_icon}:{recs_str}"

        d_parts = []
        if league_guard_note:
            d_parts.append(league_guard_note)
        if matrix_active: d_parts.append("🗺️Matrix")
        if fusion_note: d_parts.append(fusion_note)
        v9_method = anl_v9.get("method", "")  # 例如 "V9 (Turbo|LG)" / "V9 (Legacy)" / "V9 (Turbo|Tier)"
        v9_tag = ""
        if "Legacy" in v9_method:
            v9_tag = "Legacy"
        elif "LG" in v9_method:
            v9_tag = "LG"
        elif "Tier" in v9_method:
            v9_tag = "Tier"
        elif "Turbo" in v9_method:
            v9_tag = "Turbo"

        v9_name = f"🦁V9[{v9_tag}]" if v9_tag else "🦁V9"
        d_parts.append(mark_status(v9_name, v9_str, "V9"))
        d_parts.append(mark_status("⚖️Hist", hist_str, "Hist"))
        d_parts.append(mark_status("🐯V7", v7_str, "V7"))
        if anl_poisson['active']:
            p_msg = anl_poisson.get('msg', ''); p_top2 = str([x[0] for x in anl_poisson['top3'][:2]])
            p_ou = anl_poisson.get('ou_tag', '')
            d_parts.append(f"🧪Pois({p_msg}):{p_top2}")
        if trend_msg: d_parts.append(trend_msg)
        if is_squeeze: d_parts.append(f"⚡2/3赔博弈")
        if combined_traps: d_parts.append(f" | {' '.join(combined_traps)}")
        # if timeline_analysis.get('tags'): d_parts.append(f" | {' '.join(timeline_analysis['tags'])}") # 已移至视觉区

        dialogue_base = " ".join(d_parts)
        king_tag = f" [👑{king_identity}加权]" if king_identity else ""

        gate_badge = "🚦GATE接管 " if gate_info.get("took_over") else ""
        gate_note = ""
        if gate_info.get("took_over"):
            gate_note = f"（共识接管 {gate_info['old_final']}→{gate_info['new_final']} | agree_pairs={gate_info['agree_pairs']}）"

        advice = {
            "type": "alert_green" if star_score >= 3 else "normal",
            "title": f"{gate_badge}🗳️ 议会共识 {final_rec}",
            "what": f"{matrix_desc} {logic_msg}{king_tag}。",
            "action": f"综合推荐 {final_rec} {gate_note}{low_conf_note}",
            "dialogue": dialogue_base,
            "stars": "★"*star_score,
            "math_tag": score_debug,
            "tac_col": tactical_color,
            "tac_msg": tactical_msg,
            "tac_bg": tactical_bg,
            "tac_color_text": tactical_color
        }

        weighted_recs = []
        if final_rec:
            p1 = fused_dist8[final_rec[0]]
            p2 = fused_dist8[final_rec[1]] if len(final_rec) > 1 else 0.0
            s = p1 + p2
            for i, g in enumerate(final_rec):
                pct = (fused_dist8[g] / s) * 100 if s > 0 else 50
                col = "linear-gradient(135deg, #7f1d1d, #ef4444)" if i==0 else "linear-gradient(135deg, #1e3a8a, #3b82f6)"
                weighted_recs.append({
                    "pct": pct,
                    "color_css": "",
                    "bar_content": f"<div style='width:100%;height:100%;background:{col};display:flex;align-items:center;justify-content:center;color:white;font-weight:bold;'>{g}球 ({fused_dist8[g]:.1%})</div>"
                })

        engines_raw = {
            "v9": [x[0] for x in v9_top3[:2]], "v7": [x[0] for x in v7_top3[:2]],
            "hist": [x[0] for x in hist_top3[:2]], "poisson": [x[0] for x in anl_poisson['top3'][:2]]
        }

        # [GENERATE VISUALS]
        visuals = {}
        # 1. Sparkline SVG
        if timeline_analysis.get('p3_series'):
            visuals['sparkline'] = generate_sparkline_svg(timeline_analysis['p3_series'])

        # 2. Tactical Tags (List of HTML strings)
        tag_htmls = []
        if timeline_analysis.get('tags'):
            for t in timeline_analysis['tags']:
                tag_htmls.append(f"<span class='tag {t['cls']}'>{t['text']}</span>")
        visuals['tags_html'] = "".join(tag_htmls)

        # 3. Energy Bar
        energy_html = ""
        if matrix_meta:
            conf = matrix_meta.get('confidence', 0)
            bars = int(conf * 10) # 0-10
            bar_color = "energy-green" if conf >= 0.4 else ("energy-yellow" if conf >= 0.25 else "energy-gray")
            segments = ""
            for i in range(10):
                seg_cls = bar_color if i < bars else "energy-empty"
                segments += f"<div class='energy-seg {seg_cls}'></div>"
            energy_html = f"<div class='energy-box'><div class='energy-label'>历史基因强度</div><div class='energy-bar'>{segments}</div><div class='energy-val'>{conf:.0%}</div></div>"
        visuals['energy_html'] = energy_html

        extra_data = {
            "timeline_feat": extract_timeline_features(odds_history),
            "depth_p": depth_p,
            "timeline_analysis": timeline_analysis,
            "fused_dist8": fused_dist8,
            "gate_info": gate_info,
        }
        visuals['ou_html'] = ou_html_snippet
        return AnalyzeOutput(
            weighted_recs=weighted_recs, advice=advice, tier_label=tier_label, star_score=star_score,
            dxg=0, strategy_code=strategy_code, final_rec=final_rec, engines_raw=engines_raw,
            matrix_meta=matrix_meta, matrix_dist=matrix_dist, deformation_alert=deformation_alert,
            extra=extra_data, visuals=visuals
        )

# ================= 记录器类 =================
class PredictionRecorder:
    def __init__(self, json_file, excel_file):
        self.json_file = json_file; self.excel_file = excel_file; self.data = self.load_json()
    def load_json(self):
        if os.path.exists(self.json_file):
            try:
                with open(self.json_file, 'r', encoding='utf-8') as f: return json.load(f)
            except Exception:
                LOGGER.exception("记录JSON读取失败: %s", self.json_file)
                return {}
        return {}
    def record(self, match_id, league, teams, strategy, final_rec, engines_data, xg, ai_result=None, multi_res=None,meta=None):

        key = str(match_id)
        existing = self.data.get(key, {})
        def clean(l): return [int(x) for x in l]
        entry = {
            "match_id": key, "date": datetime.now().strftime("%Y-%m-%d"),
            "league": league, "teams": teams, "xg": round(xg, 2),
            "strategy": strategy, "recommendation": clean(final_rec),
            "meta": meta or {},
            "engines": {"v9": clean(engines_data.get('v9',[])), "hist": clean(engines_data.get('hist',[])), "v7": clean(engines_data.get('v7',[])),"poisson": clean(engines_data.get('poisson',[]))},
            "ai_sniper": ai_result if ai_result else "N/A",
            "multi_line": multi_res,
            "result_goal": existing.get('result_goal'), "is_correct": existing.get('is_correct')
        }
        self.data[key] = entry


    def save_all(self):
        try:
            with open(self.json_file, 'w', encoding='utf-8') as f: json.dump(self.data, f, ensure_ascii=False, indent=4)
        except Exception:
            LOGGER.exception("记录JSON写入失败: %s", self.json_file)
        self.update_excel()
    def update_excel(self):
        new_rows = []
        for key, item in self.data.items():
            ai_val = "N/A"
            if isinstance(item.get('ai_sniper'), dict): ai_val = f"{item['ai_sniper'].get('type')} ({item['ai_sniper'].get('conf',0):.0%})"
            multi_info = ""
            if item.get('multi_line'):
                m = item['multi_line']
                parts = []
                for line in ['1.5', '2.5', '3.5']:
                    if line in m:
                        tag = m[line]['tag']; prob = m[line]['prob']; edge = m[line]['edge']
                        tag_icon = "💎" if tag == 'VALUE' else ("🪤" if tag == 'TRAP' else "")
                        parts.append(f"O{line}{tag_icon}:{int(prob*100)}%({int(edge*100):+}%)")
                if parts: multi_info = " | " + " ".join(parts)
            full_ai_str = ai_val + multi_info
            engines = item.get('engines', {})
            res_val = item.get('result_goal')
            corr_val = item.get('is_correct')
            corr_str = "✅" if corr_val is True else ("❌" if corr_val is False else "")
            res_for_df = res_val if res_val is not None else np.nan
            row = {
                "ID": int(key) if key.isdigit() else key,
                "日期": item.get('date', ''), "联赛": item.get('league', ''), "对阵": item.get('teams', ''),
                "xG": item.get('xg', 0), "策略": item.get('strategy', 'STD'),
                "推荐": str(item['recommendation']), "AI狙击": full_ai_str,
                "真实进球(待填)": res_for_df, "是否命中": corr_str,
                "V9": str(engines.get('v9', [])), "V7": str(engines.get('v7', [])), "Hist": str(engines.get('hist', [])), "Poisson": str(engines.get('poisson', []))
            }
            new_rows.append(row)
        if not new_rows: return
        new_df = pd.DataFrame(new_rows)
        final_df = None
        if os.path.exists(self.excel_file):
            try:
                keep_cols = ['ID', '真实进球(待填)', '是否命中']
                old_df = pd.read_excel(self.excel_file, usecols=lambda c: c in keep_cols)
                new_work_df = new_df.copy()
                new_work_df['ID'] = new_work_df['ID'].astype(str)
                if 'ID' in old_df.columns:
                    old_df['ID'] = old_df['ID'].astype(str)
                    new_work_df.set_index('ID', inplace=True)
                    old_df.set_index('ID', inplace=True)
                    for c in ['真实进球(待填)', '是否命中']:
                        if c in old_df.columns and c in new_work_df.columns:
                            new_work_df[c] = new_work_df[c].astype(object)
                            new_s = new_work_df[c]
                            old_s = old_df[c].reindex(new_work_df.index)
                            empty_mask = new_s.isna() | (new_s.astype(str).str.strip() == "")
                            new_work_df.loc[empty_mask, c] = old_s[empty_mask]
                    final_df = new_work_df.reset_index()
                else:
                    final_df = new_work_df
            except Exception:
                LOGGER.exception("账本合并失败，改用新数据覆盖: %s", self.excel_file)
                final_df = new_df
        else: final_df = new_df
        if final_df is not None:
            if '日期' in final_df.columns: final_df = final_df.sort_values(by="日期", ascending=False)
            cols = ['ID', '日期', '联赛', '对阵', 'xG', '策略', '推荐', 'AI狙击', '真实进球(待填)', '是否命中', 'V9', 'V7', 'Hist', 'Poisson']
            for c in cols:
                if c not in final_df.columns: final_df[c] = ""
            try: final_df[cols].to_excel(self.excel_file, index=False); print(f"✅ 账本更新完成")
            except Exception:
                LOGGER.exception("账本写入失败: %s", self.excel_file)

# ================= 主程序 =================
def run_analyzer():
    LOGGER.info(">>> 启动 V82.0 Ultimate Professional (Tactical Tags + Sparkline + Dashboard)...")
    if not validate_runtime_inputs():
        return
    name_map = load_team_mapping()
    stats_db = load_xg_database(name_map)
    daxiao_db = load_daxiao_database()
    ai_bot = AIPredictor(); multi_bot = MultiLineAnalyst()
    try:
        with open(JSON_FILE, 'r', encoding='utf-8') as f: matches = json.load(f)
        LOGGER.info("读取比赛: %s 场", len(matches))
    except Exception:
        LOGGER.exception("比赛JSON读取失败: %s", JSON_FILE)
        return
    forebet_context_map = load_forebet_context_map()
    match_news_context_map = load_match_news_context_map()
    goals_llm_cache = load_goals_llm_cache()
    goals_llm_calls = 0
    goals_llm_cache_hits = 0
    goals_llm_tasks = []
    hist = load_history(); mgr = EnsembleRiskManager(); recorder = PredictionRecorder(RECORD_DB_FILE, EXCEL_SHEET_FILE); results = []
    kimi_engine = None
    try:
        from llm_engine import KimiAnalyzer
        kimi_engine = KimiAnalyzer()
    except Exception:
        LOGGER.exception("进球LLM引擎初始化失败")
    try:
        guard_profiles = load_league_guard_profiles()
        mgr.league_guard_profiles = dict(guard_profiles)
        mgr.league_guard_names = set(guard_profiles.keys())
        if LEAGUE_GUARD_ENABLE and guard_profiles:
            lvl_cnt = Counter(int((v or {}).get("level", 0) or 0) for v in guard_profiles.values())
            LOGGER.info(
                "联赛风控配置已加载: %s 项 (L1=%s, L2=%s, L3=%s)",
                len(guard_profiles),
                int(lvl_cnt.get(1, 0)),
                int(lvl_cnt.get(2, 0)),
                int(lvl_cnt.get(3, 0)),
            )
    except Exception:
        LOGGER.exception("联赛风控名单初始化失败")
    if hist.empty:
        LOGGER.error("历史样本为空，流程终止。")
        return
    if not stats_db:
        LOGGER.error("xG数据库为空，流程终止。")
        return

    def clean_prefix(name):
        if not name: return ""
        name = name.replace("：", ":")
        if ":" in name: return name.split(":")[-1].strip()
        return name.strip()

    VS_REGEX = re.compile(r"\s+vs\s+", flags=re.IGNORECASE)

    def normalize_team_token(name):
        s = str(name or "").strip().upper()
        return re.sub(r"\s+", "", s)

    def add_candidate(buf, name):
        k = normalize_team_token(name)
        if k and k not in buf:
            buf.append(k)

    for match in matches:
        match_id = str(match.get('match_id', 'unknown'))
        try:
            forebet_context = resolve_goals_forebet_context(forebet_context_map, match_id, match)
            match_news_context = resolve_goals_match_news_context(
                match_news_context_map,
                match_id=match_id,
                match=match,
                forebet_context=forebet_context,
            )
            curr = match.get('odds', {})
            final_odds = [curr.get(f'g{i}' if i<7 else 'g7plus', 0) for i in range(8)]
            if sum(final_odds)==0: continue
            history_obj = curr.get('history', {}) or {}
            initial_raw = history_obj.get('initial', {})
            initial_odds = [initial_raw.get(f'g{i}' if i<7 else 'g7plus', 0) for i in range(8)]
            has_full_initial = all((x or 0) > 0 for x in initial_odds[:8])
            model_initial_odds = initial_odds if has_full_initial else None
            aux_initial_odds = initial_odds if has_full_initial else final_odds
            ai_result = ai_bot.predict(aux_initial_odds, final_odds)
            multi_res = multi_bot.analyze(aux_initial_odds, final_odds)
            tier, lbl = get_league_tier(match['league'])
            xg = calculate_xg(odds_to_probs_fair(final_odds))
            anl_v9 = engine_v9(final_odds, hist, match['league'], tier, target_initial=model_initial_odds)
            anl_v7 = engine_v7(final_odds, hist, match['league'], tier, target_initial=model_initial_odds)
            anl_xg = engine_xg_arbiter(xg, hist, tier)
            h_name_raw = match.get('home_team'); a_name_raw = match.get('away_team')
            if not h_name_raw:
                disp = str(match.get('display_name', '') or '')
                parts = VS_REGEX.split(disp)
                if len(parts) == 2:
                    h_name_raw = parts[0].strip()
                    a_name_raw = parts[1].strip()
            h_n = name_map.get(clean_prefix(h_name_raw), clean_prefix(h_name_raw))
            a_n = name_map.get(clean_prefix(a_name_raw), clean_prefix(a_name_raw))
            anl_pois = engine_poisson(h_n, a_n, stats_db)
            # ================= [START] 2. 匹配大小球数据 =================
            home_candidates = []
            away_candidates = []
            add_candidate(home_candidates, h_n)
            add_candidate(away_candidates, a_n)
            add_candidate(home_candidates, clean_prefix(h_name_raw))
            add_candidate(away_candidates, clean_prefix(a_name_raw))

            ou_info_found = None
            for hk in home_candidates:
                for ak in away_candidates:
                    pair_key = f"{hk}|{ak}"
                    if pair_key in daxiao_db:
                        ou_info_found = daxiao_db.get(pair_key)
                        break
                if ou_info_found:
                    break

            # 兜底：仅主队键（兼容旧数据）
            if not ou_info_found:
                for hk in home_candidates:
                    ou_info_found = daxiao_db.get(f"H:{hk}")
                    if ou_info_found:
                        break
            # ================= [END] =================
            res = mgr.analyze(
                match, {'initial': initial_raw, 'final': curr, 'timeline': history_obj.get('timeline', [])},
                anl_v9, anl_v7, anl_xg, anl_pois, ai_result, multi_res,
                ou_info=ou_info_found  # <--- 关键修改：传入找到的数据
            )
            if isinstance(res, AnalyzeOutput):
                w_recs = res.weighted_recs; advice = res.advice; tier_lbl = res.tier_label
                star = res.star_score; dxg = res.dxg; strat = res.strategy_code
                final_rec = res.final_rec; engs = res.engines_raw; m_meta = res.matrix_meta
                m_dist = res.matrix_dist; def_alert = res.deformation_alert; extra = res.extra
                visuals = res.visuals

                fused_dist8 = extra.get('fused_dist8', [0]*8)
            else: continue
            meta = {
                "star": star,
                "dxg": dxg,
                "tier_label": tier_lbl,
                "advice": advice_summary(advice),              # 如果担心太大，可只存字符串/标签
                "deformation": def_alert,
                "fused_dist8": fused_dist8,
                "gate_info": extra.get("gate_info"),
            }

            recorder.record(
                match_id, match['league'], match['display_name'],
                strat, final_rec, engs, xg,
                ai_result, multi_res,
                meta=meta
            )
            goals_llm_html = ""
            pending_goals_llm_task = None
            if kimi_engine and getattr(kimi_engine, "enabled", False) and should_run_goals_llm(star, final_rec, 0):
                try:
                    goals_llm_info = build_goals_llm_context(
                        match=match,
                        odds_history={'initial': initial_raw, 'final': curr, 'timeline': history_obj.get('timeline', [])},
                        analyze_output=res,
                        anl_v9=anl_v9,
                        anl_v7=anl_v7,
                        anl_xg=anl_xg,
                        anl_poisson=anl_pois,
                        ai_result=ai_result,
                        multi_res=multi_res,
                        ou_info=ou_info_found,
                        forebet_context=forebet_context,
                        official_news=match_news_context,
                    )
                    goals_llm_ctx = {"tier": tier_lbl, "match_name": match.get('display_name', '')}
                    cache_key = build_goals_llm_cache_key(match_id, goals_llm_ctx, goals_llm_info, kimi_engine)
                    cached_result = goals_llm_cache.get(cache_key) if isinstance(goals_llm_cache, dict) else None
                    if isinstance(cached_result, dict):
                        goals_llm_result = cached_result
                        goals_llm_cache_hits += 1
                        goals_llm_html = str((goals_llm_result or {}).get("html") or "")
                    else:
                        placeholder = f"__GOALS_LLM_PLACEHOLDER_{match_id}__"
                        goals_llm_html = placeholder
                        pending_goals_llm_task = {
                            "match_id": match_id,
                            "match_name": match.get('display_name', ''),
                            "star": star,
                            "strategy": strat,
                            "ctx": goals_llm_ctx,
                            "info": goals_llm_info,
                            "cache_key": cache_key,
                            "placeholder": placeholder,
                        }
                except Exception:
                    LOGGER.exception("进球LLM预测失败: match_id=%s", match_id)
            # === [新增] 凯利注码计算 ===
            kelly_html = ""
            if final_rec:
                # 取第一推荐进球数
                best_g = final_rec[0]
                # 获取该进球数的模型概率 (fused_dist8 在上文已计算)
                model_prob = fused_dist8[best_g]

                # 获取该进球数的赔率 (final_odds)
                # 注意：final_odds 的索引是 0..7
                # 如果 best_g 是 7，对应 final_odds[7]
                try:
                    market_odd = final_odds[best_g]
                    if market_odd > 1.0 and model_prob >= 0.10:
                        # 凯利公式: f = (bp - q) / b = (Odd*Prob - 1) / (Odd - 1)
                        edge = (market_odd * model_prob) - 1
                        if edge > 0:
                            # 1/4 凯利 (稳健型)
                            b = market_odd - 1
                            kelly_full = edge / b
                            kelly_rec = kelly_full * 0.25

                            # 格式化显示
                            k_pct = kelly_rec * 100
                            chip_color = "#10b981" # Green
                            if k_pct > 3.0: chip_color = "#ef4444" # Red (重注)

                            kelly_html = f"""
                            <div style='margin-top:6px; padding:6px; background:#0f172a; border-radius:4px; border:1px solid {chip_color}; display:flex; justify-content:space-between; align-items:center;'>
                                <div style='color:#94a3b8; font-size:10px;'>💰 凯利指引 ({best_g}球)</div>
                                <div style='color:{chip_color}; font-weight:bold; font-size:12px;'>
                                    Edge {edge*100:+.1f}% 👉 下注 {k_pct:.1f}%
                                </div>
                            </div>
                            """
                except Exception:
                    LOGGER.exception("凯利注码计算失败: match_id=%s", match_id)
            # === [新增结束] ===

            # 1. 先定义美化函数 (必须在最前面)
            def color_form(f_str):
                if not f_str or f_str == 'nan': return "<span style='color:#64748b'>-</span>"
                html = ""
                # 清洗字符串
                clean_s = ''.join(filter(str.isalpha, str(f_str))).upper()[:5]
                for char in clean_s:
                    if char == 'W': col = "#10b981"; txt = "W"
                    elif char == 'L': col = "#ef4444"; txt = "L"
                    elif char == 'D': col = "#94a3b8"; txt = "D"
                    else: continue
                    html += f"<span style='display:inline-block;width:14px;height:14px;background:{col};color:white;font-size:9px;text-align:center;line-height:14px;margin-right:2px;border-radius:3px;font-weight:bold;'>{txt}</span>"
                return html

            # 2. 然后获取数据
            h_form_raw = anl_pois.get('h_stats', {}).get('raw_form', '')
            a_form_raw = anl_pois.get('a_stats', {}).get('raw_form', '')

            # 3. 接着生成 form_html 变量 (这一步必须在 advice_html 之前！)
            form_html = "" # 初始化为空，防止报错
            if h_form_raw or a_form_raw:
                form_html = f"""
                <div style='margin-top:8px; padding-top:6px; border-top:1px dashed #334155; display:flex; justify-content:space-between; align-items:center;'>
                    <div style='display:flex; align-items:center; gap:4px;'>
                        <span style='font-size:10px; color:#94a3b8;'>主近况</span>
                        <div style='display:flex;'>{color_form(h_form_raw)}</div>
                    </div>
                    <div style='display:flex; align-items:center; gap:4px;'>
                        <span style='font-size:10px; color:#94a3b8;'>客近况</span>
                        <div style='display:flex;'>{color_form(a_form_raw)}</div>
                    </div>
                </div>
                """

            tac_html = ""
            if advice.get('tac_msg'):
                tac_html += f"<div style='background:{advice['tac_bg']}; color:{advice['tac_color_text']}; padding:6px 8px; border-radius:4px; font-weight:bold; font-size:11px; margin-bottom:8px; border:1px solid {advice['tac_color_text']};'>{advice['tac_msg']}</div>"

            multi_html = ""
            if multi_res:
                multi_html += "<div style='display:flex; gap:4px; margin-bottom:8px;'>"
                for line in ['1.5', '2.5', '3.5']:
                    if line in multi_res:
                        data = multi_res[line]; tag = data['tag']; bg = "#334155"; icon = ""
                        if tag == "VALUE": bg = "#b91c1c"; icon = "💎"
                        elif tag == "TRAP": bg = "#1e40af"; icon = "🪤"
                        prob_val = int(data['prob'] * 100); edge_val = int(data['edge'] * 100)
                        display_str = f"{prob_val}% ({edge_val:+}%)"
                        multi_html += f"<div style='flex:1; background:{bg}; border-radius:4px; padding:4px; text-align:center; font-size:10px; color:white;'><div style='opacity:0.7'>O{line} {icon}</div><div style='font-weight:bold; font-size:12px;'>{display_str}</div></div>"
                multi_html += "</div>"

            if ai_result and ai_result.get('type') in ['BIG', 'SMALL']:
                ai_bg = "#ef4444" if ai_result['type'] == 'BIG' else "#3b82f6"
                ai_prob = ai_result['prob_big'] if ai_result['type'] == 'BIG' else (1-ai_result['prob_big'])
                fire = "🔥" if (ai_result['type'] == 'BIG' and ai_prob > 0.65) else ""
                refine_text = ""
                if ai_result['type'] == 'BIG':
                    big_map = {i: 1.0/final_odds[i] for i in [3,4,5,6,7] if final_odds[i]>0}
                    top3 = sorted(big_map.items(), key=lambda x:x[1], reverse=True)[:3]
                    if top3: refine_text = f"<span style='font-size:10px; opacity:0.9; margin-left:6px; border-left:1px solid #ffffff66; padding-left:6px;'>🎯精选: {','.join([str(x[0]) for x in top3])}球</span>"
                tac_html += f"<div style='margin-bottom:8px; background:{ai_bg}15; border:1px solid {ai_bg}; padding:5px; border-radius:4px; font-size:11px; color:{ai_bg}; font-weight:bold; display:flex; justify-content:space-between;'><div>🤖 AI狙击: {ai_result['type']} {fire} {refine_text}</div><span>信心: {ai_prob:.0%}</span></div>"

            if def_alert:
                ac = def_alert.get('color', '#f97316')
                bs = def_alert.get('border', 'solid')
                tac_html += f"<div style='margin-bottom:8px; background:{ac}20; border:1px {bs} {ac}; padding:5px; border-radius:4px; font-size:11px; color:{ac}; font-weight:bold;'>{def_alert['msg']}</div>"

            spectrum_html = ""
            if m_dist:
                spectrum_html = "<div class='spectrum-row'>"
                for g_idx, p in enumerate(m_dist):
                    h_pct = min(p * 100 * 2.5, 100); c_class = "spec-gray"
                    if p >= 0.25: c_class = "spec-red"
                    elif p >= 0.15: c_class = "spec-orange"
                    elif p >= 0.10: c_class = "spec-yellow"
                    val_str = f"{int(p*100)}%" if p > 0.05 else ""; label = str(g_idx) if g_idx < 7 else "7+"
                    spectrum_html += f"<div class='spec-cell'><div class='spec-bar {c_class}' style='height:{h_pct}%'></div><div class='spec-val'>{val_str}</div><div class='spec-lbl'>{label}</div></div>"

                # [VISUAL UPGRADE] Matrix Energy Bar
                energy_bar = visuals.get('energy_html', '')
                spectrum_html += f"</div>{energy_bar}"

            traj_html = ""
            timeline_anl = extra.get('timeline_analysis', {})
            if timeline_anl.get('active'):
                # [VISUAL UPGRADE] Tags & Sparkline
                tags_html = visuals.get('tags_html', '')
                sparkline = visuals.get('sparkline', '')

                # 保留折叠的详情数据，但默认显示标签
                detail_str = f"n={timeline_anl.get('steps',0)} | ΔP3+={timeline_anl.get('total_drift',0)*100:+.1f}% | vol={timeline_anl.get('vol',0)*100:.1f}%"
                if timeline_anl.get('steps', 0) >= 3:
                    detail_str += f" | edgeΔ(P3−P2)={timeline_anl.get('edge_delta',0)*100:+.1f}% | tailΔ(P4+/P3)={timeline_anl.get('tail_delta',0):+.2f} | ΔH={timeline_anl.get('ent_delta',0):+.2f}"
                    # 口语化解读（不改变界面结构：只在这一行末尾追加）
                    try:
                        drift = float(timeline_anl.get('total_drift', 0.0) or 0.0)
                        vol = float(timeline_anl.get('vol', 0.0) or 0.0)
                        edge_delta = float(timeline_anl.get('edge_delta', 0.0) or 0.0)
                        tail_delta = float(timeline_anl.get('tail_delta', 0.0) or 0.0)
                        ent_delta = float(timeline_anl.get('ent_delta', 0.0) or 0.0)
                        steps = int(timeline_anl.get('steps', 0) or 0)
                        pieces = []
                        if drift > 0:
                            pieces.append("偏大(3+)")
                        elif drift < 0:
                            pieces.append("偏小(0-2)")
                        else:
                            pieces.append("方向不明显")
                        if steps >= 3:
                            # 2 vs 3 边界（在Top1为1时转成区间表达）
                            if edge_delta > 0.005:
                                edge_phrase = "更像3球"
                            elif edge_delta < -0.005:
                                edge_phrase = "更像2球"
                            else:
                                edge_phrase = ""
                            try:
                                top1_goal = final_rec[0] if isinstance(final_rec, (list, tuple)) and len(final_rec) > 0 else None
                            except Exception:
                                top1_goal = None
                            if edge_phrase:
                                if top1_goal == 1 and edge_phrase == "更像2球":
                                    edge_phrase = "更像1-2球"
                                elif top1_goal == 1 and edge_phrase == "更像3球":
                                    edge_phrase = "更像1-3球"
                                pieces.append(edge_phrase)
                            # 尾部厚度：4+ 是否在抬头
                            if tail_delta > 0.20:
                                pieces.append("尾巴变厚(防4+)")
                            elif tail_delta < -0.20:
                                pieces.append("尾巴收敛")
                            # 确定性
                            if ent_delta > 0.03:
                                pieces.append("更发散(噪音↑)")
                            elif ent_delta < -0.03:
                                pieces.append("更集中(更确定)")
                        else:
                            pieces.append("样本少")
                        vol_pct = vol * 100.0
                        if vol_pct >= 6.0:
                            pieces.append("波动大(易拉扯)")
                        elif vol_pct >= 3.0:
                            pieces.append("有波动")
                        if pieces:
                            detail_str += " | 解读：" + "，".join(pieces)
                    except Exception:
                        LOGGER.debug("时间轴口语化解读失败: match_id=%s", match_id, exc_info=True)


                traj_html = f"""<div style='display:flex; align-items:center; justify-content:space-between; margin-top:8px; border-top:1px dashed #334155; padding-top:6px;'>
                    <div style='display:flex; gap:4px; flex-wrap:wrap;'>{tags_html}</div>
                    <div style='width:60px;'>{sparkline}</div>
                </div>
                <div style='font-family:monospace;font-size:9px;color:#64748b;margin-top:2px;'>{detail_str}</div>
                """

            ou_block = visuals.get('ou_html','')

            advice_html = f"<div class='tactical-card' style='border-left-color:{advice.get('tac_col', '#3b82f6') or '#3b82f6'}'>" \
                          f"{multi_html}{tac_html}" \
                          f"<div style='font-family:monospace; font-size:10px; color:#94a3b8; margin-bottom:6px; border-bottom:1px solid #334155; padding-bottom:4px;'>{advice['dialogue']}</div>" \
                          f"<div class='tc-header' style='color:#10b981'>{advice['title']} <span style='color:#e2e8f0; font-size:12px;'>{advice['stars']}</span></div>" \
                          f"<div class='tc-body'><b style='color:#cbd5e1'>[现象]</b> {advice['what']}</div>" \
                          f"<div class='tc-action'><span style='color:#cbd5e1'>[操作]</span> <span style='color:#fff; font-weight:bold;'>{advice['action']}</span> {advice['math_tag']}</div>" \
                          f"{kelly_html}" \
                          f"{ou_block}" \
                          f"{goals_llm_html}" \
                          f"{spectrum_html}{traj_html}" \
                          f"{form_html}" \
                          f"</div>"
            tier_class = "tier-gray"
            if "Tier 1" in tier_lbl: tier_class = "tier-gold"
            tier_html = f"<div class='tier-strip {tier_class}'></div>"
            hist_html = f"<div class='sample-info'>🔎 {anl_v9['method']} ({anl_v9['size']})</div>"
            for i, (g, p) in enumerate(anl_v9['top3']):
                bar_w = min(p * 100 * 1.5, 100); bar_c = "bar-cyber-top" if i==0 else "bar-cyber-normal"
                hist_html += f"<div class='progress-row'><span class='p-label'>{g}</span><div class='p-bar-bg'><div class='p-bar-fill {bar_c}' style='width:{bar_w}%'></div></div><span class='p-val'>{p:.0%}</span></div>"
            details_html = f"<div class='details-box'><button class='toggle-btn' onclick='toggleDetails(\"d-{match_id}\")'>📂 历史同赔回查 ({len(anl_v9['details'])}场)</button><div id='d-{match_id}' class='details-content'><table class='d-table'><tr><th>联赛</th><th>对阵</th><th>进球</th><th>0赔</th></tr>"
            for d in anl_v9['details']: details_html += f"<tr><td>{d['lg']}</td><td>{d['h']} vs {d['a']}</td><td class='goal-num'>{d['g']}</td><td>{d['o']}</td></tr>"
            details_html += "</table></div></div>"
            money_bar_html = "<div class='mb-track-cyber'>"
            for item in w_recs: money_bar_html += f"<div style='width:{item['pct']}%; {item['color_css']}' class='mb-seg-cyber'>{item['bar_content']}</div>"
            money_bar_html += "</div>"
            xg_display = f"{xg:.2f}"; g0_display = f"{final_odds[0]:.1f}"
            result_item = {
                "match": match['display_name'], "league": match['league'],
                "advice_html": advice_html, "g0_html": f"<div class='digi-box'><span class='digi-label'>0赔</span><span class='digi-val'>{g0_display}</span></div>",
                "xg_html": f"<div class='digi-box'><span class='digi-label'>xG</span><span class='digi-val'>{xg_display}</span></div>",
                "star_score": star, "tier_html": tier_html, "tier_label": lbl,
                "hist_html": hist_html, "details_html": details_html, "money_bar_html": money_bar_html
            }
            results.append(result_item)
            if pending_goals_llm_task:
                pending_goals_llm_task["result"] = result_item
                goals_llm_tasks.append(pending_goals_llm_task)
        except Exception:
            LOGGER.exception("单场处理失败: match_id=%s", match_id)
            continue
    if kimi_engine and getattr(kimi_engine, "enabled", False) and goals_llm_tasks:
        selected_goals_llm, selected_goal_ids, eligible_goal_count = select_goals_llm_tasks(goals_llm_tasks)
        LOGGER.info(
            "进球LLM精选: 从%s场候选中选择%s场新请求",
            eligible_goal_count,
            len(selected_goals_llm),
        )
        cache_dirty = False
        for rank, (_score, _order, task, reason) in enumerate(selected_goals_llm, start=1):
            match_label = task.get("match_name") or task.get("match_id") or "未知比赛"
            print(f"🤖 进球LLM精选 {rank}/{len(selected_goals_llm)}: {match_label} | {reason}", flush=True)
            try:
                goals_llm_calls += 1
                goals_llm_result = kimi_engine.predict_goals(task.get("ctx") or {}, task.get("info") or {})
                if isinstance(goals_llm_result, dict):
                    goals_llm_cache[task.get("cache_key")] = goals_llm_result
                    cache_dirty = True
                html = str((goals_llm_result or {}).get("html") or "")
            except Exception:
                LOGGER.exception("进球LLM预测失败: match_id=%s", task.get("match_id"))
                html = ""
            result = task.get("result") or {}
            placeholder = str(task.get("placeholder") or "")
            if placeholder and isinstance(result, dict):
                result["advice_html"] = str(result.get("advice_html") or "").replace(placeholder, html)

        for task in goals_llm_tasks:
            if id(task) in selected_goal_ids:
                continue
            result = task.get("result") or {}
            placeholder = str(task.get("placeholder") or "")
            if placeholder and isinstance(result, dict):
                result["advice_html"] = str(result.get("advice_html") or "").replace(
                    placeholder,
                    GOALS_LLM_UNSELECTED_HTML,
                )
        if cache_dirty:
            save_goals_llm_cache(goals_llm_cache)

    recorder.save_all()
    remind_lowconf_rescan(recorder.data)
    # [VISUAL UPGRADE] 使用外部 Jinja2 模板文件生成报告
    template_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), REPORT_TEMPLATE_FILE)
    try:
        from jinja2 import Environment, FileSystemLoader
        env = Environment(loader=FileSystemLoader(os.path.dirname(os.path.abspath(__file__))))
        template = env.get_template(REPORT_TEMPLATE_FILE)

        context = {
            'SCAN_TIME': datetime.now().strftime('%Y-%m-%d %H:%M'),
            'TOTAL_COUNT': len(results),
            'STAR5_COUNT': sum(1 for r in results if r['star_score'] == 5),
            'STAR4_COUNT': sum(1 for r in results if r['star_score'] == 4),
            'results': results
        }
        html = template.render(**context)
    except Exception as e:
        LOGGER.error("Jinja2 模板渲染失败: %s", e)
        # 极端回退方案，防崩溃
        html = f"<!DOCTYPE html><html><body><h1>模板渲染失败</h1><p>{e}</p></body></html>"
    with open(REPORT_FILE, 'w', encoding='utf-8') as f: f.write(html)
    if goals_llm_calls or goals_llm_cache_hits:
        LOGGER.info("进球LLM统计: 新请求=%s, 缓存命中=%s", goals_llm_calls, goals_llm_cache_hits)
    print(f"🚀 报告已生成: {REPORT_FILE}")

if __name__ == "__main__":
    run_analyzer()
