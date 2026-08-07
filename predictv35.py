import pandas as pd
import difflib
import numpy as np
import json
import os
import glob
import warnings
import math
import argparse
from risk_control import RiskEngine
import itertools
import datetime
import time
import re
import pickle
from html import escape
from sklearn.ensemble import RandomForestClassifier
from sklearn.calibration import CalibratedClassifierCV
from sklearn.preprocessing import LabelEncoder
from match_context_pipeline import canonicalize_team_name, load_team_alias_map, team_names_match

# 只屏蔽噪音类警告；与数据正确性相关的警告（如 SettingWithCopyWarning）保持可见
warnings.filterwarnings("ignore", category=FutureWarning)
warnings.filterwarnings("ignore", category=UserWarning)
warnings.filterwarnings("ignore", category=DeprecationWarning)


def _load_local_env():
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if not os.path.exists(env_path):
        return
    try:
        with open(env_path, "r", encoding="utf-8") as f:
            for raw_line in f:
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip().strip("'\"")
                if key and key not in os.environ:
                    os.environ[key] = value
    except Exception as exc:
        print(f"⚠️ .env 加载失败: {exc}")


_load_local_env()

# ================= 配置区域 =================
TRAIN_FILE = 'initspfpl_with_Elo.xlsx'
ODDS_FILE = 'realtime_matches_had_hhad_history.json'
OUTPUT_HTML = 'prediction_report_V104_Expert.html'
HISTORY_FILE = 'bet_history.xlsx'
FULL_LOG_FILE = 'full_match_log.xlsx'
MATCH_NEWS_CONTEXT_FILE = 'match_news_context.json'
FOTMOB_CONTEXT_FILE = 'fotmob_context.json'
WEIGHTS_FILE = 'backtest_weights_spf.json'
USE_EXTERNAL_BLEND_WEIGHTS = False

# 最小有效样本量（命中率优先）
MIN_SAMPLES = 16

# ==========================================
# 🛡️ 出手质量控制（基于回测数据驱动）
# ==========================================
# 联赛黑名单：回测 ROI < -30% 的联赛，直接屏蔽最终推荐
# 数据来源：2026-02-25 ~ 2026-04-24 共507场回测
# 法甲 -53.6% | 荷甲 -54.2% | 英超 -36.9% | 葡超 -42.2%
# 澳超 -82.3% | 韩职 -82.9% | 欧罗巴 -37.0%
# ⚠️ 统计警示：黑名单基于约2个月/507场回测，分摊到单联赛样本量很小，
#    -30% ROI 与随机波动难以区分（多重比较问题）。建议定期用更长窗口重估，
#    或通过环境变量 SPF_LEAGUE_BLACKLIST 覆盖（逗号分隔，留空=禁用黑名单）。
LEAGUE_BLACKLIST = {'法甲', '荷甲', '英超', '葡超', '澳超', '韩职', '欧罗巴'}
if 'SPF_LEAGUE_BLACKLIST' in os.environ:
    LEAGUE_BLACKLIST = {
        x.strip() for x in os.environ['SPF_LEAGUE_BLACKLIST'].split(',') if x.strip()
    }
# 禁止平局推荐。注意：27.8% 命中率接近平局基础发生率(约25~27%)，
# "模型不擅长平局"的结论证据不足，真正该看的是平局推荐的 EV。
# 可用环境变量 SPF_DISABLE_DRAW=0 关闭此过滤。
DISABLE_DRAW_PICK = os.environ.get('SPF_DISABLE_DRAW', '1').strip() not in ('0', 'false', 'False')

# --- 概率校准表（Isotonic Regression 拟合，保守下修3%）---
# 模型概率 → 校准后概率（用于计算 EV = cal_prob * odds）
# 当 EV < EV_THRESHOLD 时拦截推荐
CALIBRATION_TABLE = [
    (0.30, 0.000), (0.34, 0.000), (0.36, 0.284), (0.38, 0.303),
    (0.40, 0.349), (0.42, 0.353), (0.44, 0.418), (0.46, 0.485),
    (0.48, 0.485), (0.50, 0.485), (0.52, 0.485), (0.54, 0.519),
    (0.56, 0.519), (0.60, 0.519), (0.65, 0.519), (0.70, 0.733),
    (0.75, 0.733), (0.80, 0.733),
]
# 最低 EV 门槛：cal_prob * odds >= 此值才允许推荐
# ⚠️ 统计警示：0.95/1.00 两档阈值是在同一份回测集上挑选的（选择偏差），
#    66场/37场样本的 ROI 置信区间很宽，实盘大概率向零回归。
#    阈值应在冻结后做前瞻验证（paper trading），可用 SPF_EV_THRESHOLD 覆盖。
CALIBRATED_EV_THRESHOLD = float(os.environ.get('SPF_EV_THRESHOLD', '0.95'))

# 校准平滑：校准表来自小样本 Isotonic 拟合，存在大段平台与悬崖式跳变。
# CALIBRATION_BLEND: 校准值与原始概率的混合权重（1.0=完全信校准表，0.0=不校准）。
# CALIBRATION_FLOOR_RATIO: 校准结果下限 = raw_prob * 该比例，避免概率被直接归零
#   形成"隐藏硬规则"。两者均保持保守方向：最终值不会高于原始概率。
CALIBRATION_BLEND = float(os.environ.get('SPF_CALIBRATION_BLEND', '0.5'))
CALIBRATION_FLOOR_RATIO = float(os.environ.get('SPF_CALIBRATION_FLOOR', '0.5'))
# ==========================================

# 近邻匹配参数（来自 ordered_grid_backtest_best.json）
NN_STD_P = 0.10
NN_STD_TREND = 0.03
NN_TREND_WEIGHT = 2.0
NN_TOP_N = 20
NN_TAU = 600

# --- 1. 联赛分级定义 ---
LEAGUE_TIERS = {
    'Tier1': [
        '德甲', '德乙', '荷甲', '荷乙', '澳甲', 
        '挪超', '奥甲', '瑞典超', '日职', '韩职', '美职'
    ],
    'Tier2': [
        '意甲', '意乙', '西乙', '法乙', '阿甲', '葡超', 
        '希腊超', '俄超', '巴西甲', '解放者杯', '南美杯', '非洲杯'
    ],
    'Tier3': [
        '英超', '西甲', '法甲', '英冠', '英甲',
        '欧冠', '欧罗巴', '欧协联',
        '世界杯', '欧洲杯', '亚洲杯', '美洲杯', '欧国联'
    ],
    'Tier4': [
        '英足总杯', '英联杯', '足总杯',
        '国王杯', '德国杯', '意大利杯', '法国杯'
    ]
}

# --- 2. 核心：分层权重配置 ---
TIER_CONF = {
    'spf': {
        'Tier1': (0.0, 2.0),
        'Tier2': (0.0, 0.5), 
        'Tier3': (0.0, 0.5), 
        'Tier4': (0.0, 6.0), 
        'Other': (0.0, 6.0)
    },
    'rq': {
        'Tier1': (0.0, 1.0),
        'Tier2': (0.0, 6.0), 
        'Tier3': (0.0, 2.0),
        'Tier4': (0.0, 1.0),
        'Other': (0.0, 1.0)
    }
}
# SPF 融合权重（当前阶段采用保守固定，不依赖外部融合回测）
BACKTEST_W_SPF = {
    'market': 1.0,
    'ai_rf': 0.0,
    'poisson': 0.0
}
# 统一融合权重（仅用于“融合概率”输出，不改主策略风控与选单）
UNIFIED_FUSION_WEIGHTS = {
    'hist': 0.55,
    'market': 0.20,
    'ai_rf': 0.15,
    'poisson': 0.10,
}
# 融合稳定性参数（仅影响融合展示概率）
FUSION_MIN_TOP1 = 0.45   # top1 最低置信
FUSION_MIN_GAP = 0.08    # top1-top2 最小优势
FUSION_ADJ_CLIP = 0.35   # 单方向修正绝对值上限
# SPF 风控模式开关：
# - balanced: 双硬规则(混乱+中赔EV)且需同时命中，覆盖率优先
# - accuracy: 仅中赔EV做硬拦截，命中率优先
SPF_RISK_MODE = "accuracy"
SPF_RISK_PROFILES = {
    "balanced": {
        "hard_rules": {"混乱检测(top<0.45)", "SPF:中赔EV不足(1.7-2.8)"},
        "hard_threshold": 2
    },
    "accuracy": {
        "hard_rules": {"SPF:中赔EV不足(1.7-2.8)"},
        "hard_threshold": 1
    }
}
# SPF 规则白名单（仅白名单内规则参与拦截/扣分）
# 依据当前回测：保留增益稳定的规则，关闭长期误杀高的规则
SPF_HARD_RULE_WHITELIST = {
    "混乱检测(top<0.45)",
    "SPF:中赔EV不足(1.7-2.8)",
}
SPF_SOFT_RULE_WHITELIST = {
    "SPF:高赔EV不足(>2.80)",
    "SPF概率准入(信心低)",
    "Kelly<0.04(鸡肋)",
}
SPF_SOFT_PENALTY = {
    "SPF:赔率过低(<1.48)": 1.2,
    "SPF:高赔EV不足(>2.80)": 0.8,
    "SPF:低赔胜率不足(<1.70)": 0.8,
    "Kelly≤0(无正EV)": 0.6,
    "Kelly<0.04(鸡肋)": 0.4,
    "SPF赔率准入(范围外)": 0.6,
    "SPF概率准入(信心低)": 0.8
}
SPF_RULE_LABELS = {
    "混乱检测(top<0.45)": "结果分歧大（方向不稳）",
    "SPF:赔率过低(<1.48)": "赔率过低（回报偏薄）",
    "SPF:高赔EV不足(>2.80)": "高赔性价比不足",
    "SPF:中赔EV不足(1.7-2.8)": "中赔性价比不足",
    "SPF:低赔胜率不足(<1.70)": "低赔胜率不够",
    "Kelly≤0(无正EV)": "期望收益为负",
    "Kelly<0.04(鸡肋)": "期望收益偏低",
    "SPF赔率准入(范围外)": "赔率区间不理想",
    "SPF概率准入(信心低)": "命中把握偏低"
}
ODDS_BAND_LABELS = {
    "low": "低赔组",
    "mid": "中赔组",
    "high": "高赔组"
}
THRESH_SOURCE_LABELS = {
    "bucket_best": "本组专属阈值",
    "band_best_fallback": "同赔率段回退阈值",
    "default_fallback": "默认阈值",
    "default": "默认阈值"
}
USE_DYNAMIC_SPF_THRESHOLDS = True
SPF_DYNAMIC_THRESHOLDS_FILE = 'spf_dynamic_thresholds.json'
DEFAULT_SPF_THRESHOLDS_BY_BAND = {
    'low':  {'top_min': 0.45, 'gap_min': 0.15, 'prob_min': 0.60, 'ev_min': 1.05},
    'mid':  {'top_min': 0.45, 'gap_min': 0.15, 'prob_min': 0.50, 'ev_min': 1.10},
    'high': {'top_min': 0.45, 'gap_min': 0.15, 'prob_min': 0.40, 'ev_min': 1.10},
}
AI_MODEL_CACHE_FILE = 'ai_model_cache_v104.pkl'
AI_MODEL_CACHE_VERSION = 3  # v3: 训练前强制时序排序 + 训练逻辑重构，旧缓存必须失效
# 单场精选展示门槛（仅影响前端卡片展示，不影响主策略下单逻辑）
SINGLE_CARD_MIN_ODDS = 1.48
SINGLE_CARD_MIN_EV = 0.95
# ===========================================

def resolve_spf_risk_profile():
    mode = str(SPF_RISK_MODE).strip().lower()
    if mode not in SPF_RISK_PROFILES:
        mode = "balanced"
    cfg = SPF_RISK_PROFILES[mode]
    hard_rules = set(cfg.get("hard_rules", set()))
    if SPF_HARD_RULE_WHITELIST:
        hard_rules = hard_rules & set(SPF_HARD_RULE_WHITELIST)
    soft_penalty = {
        k: v for k, v in SPF_SOFT_PENALTY.items()
        if (not SPF_SOFT_RULE_WHITELIST) or (k in SPF_SOFT_RULE_WHITELIST)
    }
    hard_threshold = int(cfg.get("hard_threshold", 1))
    if not hard_rules:
        hard_threshold = 1
    else:
        hard_threshold = min(max(1, hard_threshold), len(hard_rules))
    enabled_rules = set(hard_rules) | set(soft_penalty.keys())
    return {
        "mode": mode,
        "hard_rules": hard_rules,
        "hard_threshold": hard_threshold,
        "soft_penalty": soft_penalty,
        "enabled_rules": enabled_rules
    }


def get_odds_band(odds):
    if odds < 1.70:
        return 'low'
    if odds <= 2.80:
        return 'mid'
    return 'high'


def fmt_score(val, default="0.0"):
    try:
        return f"{float(val):.1f}"
    except Exception:
        return default


ABSENCE_ROLE_LABELS = {
    'G': '门将',
    'D': '后卫',
    'M': '中场',
    'F': '前锋',
}

ABSENCE_STATUS_LABELS = {
    'Will not play': '缺阵',
    'Uncertain': '待定',
    'Doubtful': '待定',
    'Suspended': '停赛',
    'Injured': '伤缺',
}

VENUE_SHORT_LABELS = {
    'H': '主',
    'A': '客',
    'N': '中',
}


def _coerce_int(value, default=0):
    try:
        return int(float(value))
    except Exception:
        return default


def _parse_context_date(value):
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return datetime.datetime.fromisoformat(text.replace("Z", "+00:00")).date()
    except Exception:
        pass
    for fmt in ("%Y-%m-%d", "%m/%d/%Y"):
        try:
            return datetime.datetime.strptime(text, fmt).date()
        except Exception:
            continue
    return None


def _absence_sort_key(item):
    status = str((item or {}).get("status_label") or (item or {}).get("status") or "").strip()
    status_rank = {
        "Will not play": 0,
        "Suspended": 0,
        "Injured": 1,
        "Doubtful": 2,
        "Uncertain": 3,
    }.get(status, 4)
    games_played = _coerce_int((item or {}).get("games_played"), 0)
    name = str((item or {}).get("name") or "").strip()
    return (status_rank, -games_played, name)


def _render_absence_person(item):
    if not isinstance(item, dict):
        return ""

    name = escape(str(item.get("name") or "").strip())
    if not name:
        return ""

    role = escape(ABSENCE_ROLE_LABELS.get(str(item.get("role") or "").strip(), str(item.get("role") or "").strip()))
    reason = escape(str(item.get("reason") or "").strip())
    status_raw = str(item.get("status_label") or item.get("status") or "").strip()
    status = escape(ABSENCE_STATUS_LABELS.get(status_raw, status_raw))
    games_played = _coerce_int(item.get("games_played"), 0)
    started = _coerce_int(item.get("started"), 0)
    goals = _coerce_int(item.get("goals"), 0)
    assists = _coerce_int(item.get("assists"), 0)
    importance = escape(str(item.get("importance_label") or "").strip())
    rating_raw = item.get("rating")
    rating = ""
    try:
        if rating_raw not in (None, ""):
            rating = f"{float(rating_raw):.1f}"
    except Exception:
        rating = ""

    meta = []
    if importance:
        meta.append(importance)
    if role:
        meta.append(role)
    if status:
        meta.append(status)
    if reason:
        meta.append(reason)
    if games_played > 0 or started > 0:
        meta.append(f"{games_played}场{started}首发" if started > 0 else f"{games_played}场")
    if goals > 0 or assists > 0 or item.get("source") == "fotmob":
        meta.append(f"{goals}球{assists}助")
    if rating:
        meta.append(f"评分{rating}")

    meta_html = ""
    if meta:
        meta_html = (
            f"<div style='font-size:10px;color:#666;margin-top:2px;'>"
            f"{escape(' / '.join(meta))}</div>"
        )

    return (
        "<div style='padding:5px 0;border-bottom:1px dashed #f0f0f0;'>"
        f"<div style='font-size:11px;color:#262626;font-weight:bold;'>{name}</div>"
        f"{meta_html}"
        "</div>"
    )


def render_injury_summary_card(lineup_injury):
    lineup_injury = lineup_injury or {}
    home_absences = [x for x in (lineup_injury.get("home_absences") or []) if isinstance(x, dict)]
    away_absences = [x for x in (lineup_injury.get("away_absences") or []) if isinstance(x, dict)]

    if not home_absences and not away_absences:
        return ""

    def render_side(title, items, accent, bg):
        count = len(items)
        top_items = sorted(items, key=_absence_sort_key)[:3]
        body = "".join(_render_absence_person(item) for item in top_items)
        if not body:
            body = "<div style='font-size:11px;color:#8c8c8c;padding:8px 0;'>暂无明确缺阵</div>"
        return (
            f"<div style='flex:1;min-width:0;background:{bg};border:1px solid {accent};"
            "border-radius:6px;padding:8px;'>"
            f"<div style='font-size:11px;font-weight:bold;color:#262626;margin-bottom:6px;'>{title}"
            f"<span style='float:right;color:{accent};'>缺阵{count}人</span></div>"
            f"{body}</div>"
        )

    return (
        "<div style='margin-top:6px;border:1px solid #ffd8bf;background:#fff7e6;border-radius:6px;overflow:hidden;'>"
        "<div style='background:#fa8c16;color:#fff;font-size:10px;padding:4px 8px;font-weight:bold;"
        "display:flex;justify-content:space-between;'>"
        "<span>🩺 伤停情报</span>"
        "<span>仅展示缺阵摘要</span>"
        "</div>"
        "<div style='display:flex;gap:8px;padding:8px;flex-wrap:wrap;'>"
        f"{render_side('主队', home_absences, '#fa8c16', '#fffdf7')}"
        f"{render_side('客队', away_absences, '#722ed1', '#faf5ff')}"
        "</div></div>"
    )


def _pick_future_hard_matches(matches, kickoff_time, limit=2):
    kickoff_date = _parse_context_date(kickoff_time)
    picked = []
    for item in (matches or []):
        if not isinstance(item, dict):
            continue
        difficulty = _coerce_int(item.get("difficulty"), 0)
        if difficulty < 4:
            continue
        match_date = _parse_context_date(item.get("date"))
        if kickoff_date and match_date and match_date <= kickoff_date:
            continue
        payload = dict(item)
        payload["_match_date"] = match_date
        picked.append(payload)

    picked.sort(
        key=lambda item: (
            item.get("_match_date") or datetime.date.max,
            -_coerce_int(item.get("difficulty"), 0),
            str(item.get("opponent") or ""),
        )
    )
    return picked[:limit]


def _render_schedule_match(item):
    opponent = escape(str(item.get("opponent") or "").strip())
    venue = VENUE_SHORT_LABELS.get(str(item.get("venue") or "").strip(), str(item.get("venue") or "").strip())
    league = escape(str(item.get("league") or "").strip())
    date_text = escape(str(item.get("date") or "").strip())
    difficulty = _coerce_int(item.get("difficulty"), 0)
    if not opponent:
        return ""

    meta = " ".join(x for x in [date_text, league, f"{venue}场" if venue else ""] if x).strip()
    meta_html = f"<div style='font-size:10px;color:#666;margin-top:2px;'>{meta}</div>" if meta else ""
    return (
        "<div style='padding:5px 0;border-bottom:1px dashed #f0f0f0;'>"
        f"<div style='font-size:11px;color:#262626;font-weight:bold;'>{opponent}"
        f"<span style='float:right;color:#cf1322;'>难度{difficulty}</span></div>"
        f"{meta_html}</div>"
    )


def render_schedule_pressure_card(schedule_context, kickoff_time=None):
    schedule_context = schedule_context or {}
    next_matches = schedule_context.get("next_matches") or {}
    home_hard = _pick_future_hard_matches(next_matches.get("home") or [], kickoff_time)
    away_hard = _pick_future_hard_matches(next_matches.get("away") or [], kickoff_time)

    if not home_hard and not away_hard:
        return ""

    def render_side(title, items, accent, bg):
        if not items:
            body = "<div style='font-size:11px;color:#8c8c8c;padding:8px 0;'>暂无偏硬赛程</div>"
        else:
            body = "".join(_render_schedule_match(item) for item in items)
        return (
            f"<div style='flex:1;min-width:0;background:{bg};border:1px solid {accent};"
            "border-radius:6px;padding:8px;'>"
            f"<div style='font-size:11px;font-weight:bold;color:#262626;margin-bottom:6px;'>{title}"
            f"<span style='float:right;color:{accent};'>{len(items)}场</span></div>"
            f"{body}</div>"
        )

    return (
        "<div style='margin-top:6px;border:1px solid #adc6ff;background:#f0f5ff;border-radius:6px;overflow:hidden;'>"
        "<div style='background:#2f54eb;color:#fff;font-size:10px;padding:4px 8px;font-weight:bold;"
        "display:flex;justify-content:space-between;'>"
        "<span>📆 后续赛程压力</span>"
        "<span>仅展示难度≥4</span>"
        "</div>"
        "<div style='display:flex;gap:8px;padding:8px;flex-wrap:wrap;'>"
        f"{render_side('主队硬仗', home_hard, '#2f54eb', '#f8faff')}"
        f"{render_side('客队硬仗', away_hard, '#13c2c2', '#f6fffe')}"
        "</div></div>"
    )


def render_web_verification_card(grounding, show_empty=False):
    return ""


def render_gemini_status_card(message):
    text = str(message or "").strip()
    if not text:
        return ""
    return (
        "<div style='margin-top:6px;padding:8px 10px;background:#fffbe6;"
        "border:1px solid #ffe58f;border-radius:6px;font-size:11px;"
        "line-height:1.6;color:#333;'>"
        "<div style='font-weight:bold;color:#ad6800;margin-bottom:4px;'>🤖 大模型提示</div>"
        f"<div>{text}</div>"
        "</div>"
    )


def _should_force_llm_review(match_info):
    info = match_info if isinstance(match_info, dict) else {}

    lineup = info.get("lineup_injury") or {}
    home_absences = lineup.get("home_absences") or []
    away_absences = lineup.get("away_absences") or []
    if len(home_absences) + len(away_absences) >= 5:
        return True

    bifa = info.get("bifa") or {}
    vol = bifa.get("vol") or {}
    try:
        if max(float(vol.get("h", 0) or 0), float(vol.get("a", 0) or 0)) >= 0.75:
            return True
    except (TypeError, ValueError):
        pass

    pankou = info.get("pankou") or {}
    for book_key in ("pb", "mac"):
        book = pankou.get(book_key) or {}
        try:
            init_line = float(book.get("init_line", 0) or 0)
            curr_line = float(book.get("curr_line", 0) or 0)
        except (TypeError, ValueError):
            continue
        if abs(curr_line - init_line) >= 0.25:
            return True

    return False


def calibrate_probability(raw_prob):
    """用校准表做分段线性插值，并向原始概率收缩以缓解小样本过拟合。

    修复点：
    1. 原实现 raw_prob<=0.30 直接返回 0.000，等于把低概率推荐无条件清零，
       且 0.34→0.36 之间从 0 跳变到 0.284。现改为：插值后与原始概率按
       CALIBRATION_BLEND 混合，并以 raw*CALIBRATION_FLOOR_RATIO 兜底。
    2. 保守约束：最终值不会超过原始概率（只下修不上修）。
    """
    try:
        raw = float(raw_prob)
    except (TypeError, ValueError):
        return 0.0
    raw = min(max(raw, 0.0), 1.0)
    table = CALIBRATION_TABLE
    if not table:
        return raw

    # 分段线性插值（区间外取端点值）
    if raw <= table[0][0]:
        interp = table[0][1]
    elif raw >= table[-1][0]:
        interp = table[-1][1]
    else:
        interp = raw
        for i in range(len(table) - 1):
            x0, y0 = table[i]
            x1, y1 = table[i + 1]
            if x0 <= raw <= x1:
                interp = y0 if x1 == x0 else y0 + (raw - x0) / (x1 - x0) * (y1 - y0)
                break

    blend = min(max(CALIBRATION_BLEND, 0.0), 1.0)
    cal = blend * interp + (1.0 - blend) * raw
    # 下限保护：避免归零悬崖；上限保护：保持只向下修正的保守方向
    cal = max(cal, raw * min(max(CALIBRATION_FLOOR_RATIO, 0.0), 1.0))
    cal = min(cal, raw)
    return cal


def should_skip_llm_review(candidate_to_ask, match_info=None):
    allowed, _ = should_run_llm_prediction(
        candidate_to_ask,
        match_info,
        used_calls=0,
        max_calls=0,
    )
    return not allowed


def _get_llm_min_odds():
    try:
        return float(
            os.environ.get(
                "LLM_MIN_ODDS",
                os.environ.get("LLM_SKIP_LOW_ODDS_THRESHOLD", "1.7"),
            )
            or 1.7
        )
    except (TypeError, ValueError):
        return 1.7


def _get_llm_max_matches():
    for key in ("LLM_MAX_MATCHES", "LLM_MAX_CALLS"):
        raw = os.environ.get(key)
        if raw is None:
            continue
        try:
            return max(0, int(float(raw)))
        except (TypeError, ValueError):
            continue
    return 10


def _extract_llm_candidate_odds(candidate_to_ask):
    try:
        return float((candidate_to_ask or {}).get("odds", 0) or 0)
    except (TypeError, ValueError, AttributeError):
        return 0.0


def _extract_market_edge_odds(match_info):
    market_odds = (match_info or {}).get("market_odds") or {}
    spf_curr = market_odds.get("spf_curr") or {}
    values = []
    for key in ("胜", "负"):
        try:
            value = float(spf_curr.get(key, 0) or 0)
        except (TypeError, ValueError):
            value = 0.0
        if value > 0:
            values.append(value)
    return min(values) if values else 0.0


def should_run_llm_prediction(candidate_to_ask, match_info=None, used_calls=0, max_calls=None):
    if not candidate_to_ask:
        return False, "无候选推荐，跳过大模型"

    min_odds = _get_llm_min_odds()
    candidate_odds = _extract_llm_candidate_odds(candidate_to_ask)
    market_edge_odds = _extract_market_edge_odds(match_info)

    if candidate_odds <= 0:
        return False, "候选赔率缺失，跳过大模型"

    if candidate_odds and candidate_odds < min_odds:
        return False, f"赔率{candidate_odds:.2f}低于{min_odds:.2f}，跳过大模型"
    if market_edge_odds and market_edge_odds < min_odds:
        return False, f"胜负低赔{market_edge_odds:.2f}低于{min_odds:.2f}，跳过大模型"

    call_limit = _get_llm_max_matches() if max_calls is None else max(0, int(max_calls))
    if call_limit and used_calls >= call_limit:
        return False, f"大模型预测已达{call_limit}场上限，跳过"

    return True, ""


def _safe_float_value(value, default=0.0):
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return default


def _llm_odds_band_score(odds):
    odds = _safe_float_value(odds)
    if odds <= 0:
        return -20
    if 1.70 <= odds <= 2.40:
        return 24
    if 2.40 < odds <= 2.80:
        return 18
    if 2.80 < odds <= 3.50:
        return 8
    return 0


def _llm_data_richness_score(match_info):
    info = match_info or {}
    score = 0
    history = info.get("history") or {}
    lineup = info.get("lineup_injury") or {}

    if str(info.get("recent_form_summary") or "").strip():
        score += 12
    if any(history.get(k) for k in (
        "forebet_home_last6",
        "forebet_away_last6",
        "forebet_head_to_head",
        "recent_home_matches",
        "recent_away_matches",
    )):
        score += 12
    if any(lineup.get(k) for k in ("home_absences", "away_absences")):
        score += 10
    if info.get("bifa"):
        score += 8
    if info.get("pankou"):
        score += 8
    if info.get("technical_stats_context"):
        score += 6
    if info.get("manual"):
        score += 5
    if info.get("poisson"):
        score += 5
    return score


def _normalize_decision_label(decision_level):
    if not isinstance(decision_level, dict):
        return ""
    return str(decision_level.get("label") or "").strip()


def score_llm_prediction_task(result):
    """给大模型候选排序：先看是否值得参与，再看赔率区间和可分析数据量。"""
    result = result or {}
    task = result.get("_llm_task") or {}
    candidate = task.get("candidate") or {}
    info = task.get("info") or {}
    decision_level = result.get("decision_level") or info.get("decision_level") or {}
    label = _normalize_decision_label(decision_level)
    decision_score = {
        "稳胆": 540,
        "可博": 360,
        "分歧": 240,
        "回避EV": 150,
        "回避风控": 50,
        "联赛屏蔽": 20,
        "无推荐": 10,
        "放弃": 10,
    }.get(label, 180)

    odds = _extract_llm_candidate_odds(candidate)
    local_score = _safe_float_value(result.get("score"))
    ess = _safe_float_value(result.get("ess"))
    sample = _safe_float_value(result.get("sample"))
    data_score = _llm_data_richness_score(info)
    total = (
        decision_score
        + _llm_odds_band_score(odds)
        + max(-5.0, min(local_score, 10.0)) * 8
        + min(ess, 30.0) * 1.2
        + min(sample, 80.0) * 0.35
        + data_score
    )
    reason_parts = [
        label or "未分级",
        f"赔率{odds:.2f}" if odds else "赔率缺失",
        f"本地分{local_score:.1f}",
        f"数据分{data_score}",
    ]
    return total, " / ".join(reason_parts)


def select_llm_prediction_tasks(results, limit=None):
    call_limit = _get_llm_max_matches() if limit is None else max(0, int(limit))
    ranked = []
    ev_ranked = []
    for order, result in enumerate(results or []):
        task = (result or {}).get("_llm_task")
        if not task:
            continue
        decision_level = (result or {}).get("decision_level") or (task.get("info") or {}).get("decision_level") or {}
        label = _normalize_decision_label(decision_level)
        if label in {"放弃", "无推荐", "联赛屏蔽", "回避风控"}:
            continue
        allowed, _reason = should_run_llm_prediction(
            task.get("candidate") or {},
            task.get("info") or {},
            used_calls=0,
            max_calls=0,
        )
        if not allowed:
            continue
        score, reason = score_llm_prediction_task(result)
        row = (score, -order, result, reason)
        if label == "回避EV":
            ev_ranked.append(row)
        else:
            ranked.append(row)

    ranked.sort(reverse=True)
    ev_ranked.sort(reverse=True)
    selected = ranked if not call_limit else ranked[:call_limit]
    remaining_slots = max(0, (call_limit or len(ranked) + 2) - len(selected))
    if remaining_slots:
        selected.extend(ev_ranked[:min(2, remaining_slots)])
    selected.sort(reverse=True)
    selected_ids = {id(item[2]) for item in selected}
    return selected, selected_ids, len(ranked) + min(2, len(ev_ranked))

class PredictorV104_Expert:
    def __init__(self):
        self.df = None
        self.league_profiles = {} 
        self.clf_spf = None
        self.clf_rq = None
        self.le = LabelEncoder()
        self.ai_sample_size_spf = 0
        self.ai_sample_size_rq = 0
        self.manual_data = {}
        self.train_source_file = None

        # --- 【修改位置 1】新增：用于存储高级xG数据 ---
        self.xg_data = {}      # 存球队数据 (allleagues_xg_xga.xlsx)
        self.lg_data = {}      # 存联赛数据 (leaguegoals.xlsx)
        self.spf_blend_weights = self.load_spf_weights()
        self.spf_dynamic_thresholds = self.load_spf_dynamic_thresholds()
        self.risk_engine = RiskEngine(spf_thresholds=self.spf_dynamic_thresholds)
        self.team_alias_map = load_team_alias_map()
        self._print_config_fingerprint()

    def _print_config_fingerprint(self):
        """打印关键策略参数的指纹哈希。

        用途：做前瞻验证（paper trading）时，比对各期报告的指纹是否一致，
        即可确认参数已冻结、没有被中途调整——这是检验回测结论是否过拟合的前提。
        """
        import hashlib
        cfg = {
            'blacklist': sorted(LEAGUE_BLACKLIST),
            'disable_draw': DISABLE_DRAW_PICK,
            'ev_threshold': CALIBRATED_EV_THRESHOLD,
            'cal_blend': CALIBRATION_BLEND,
            'cal_floor': CALIBRATION_FLOOR_RATIO,
            'cal_table': CALIBRATION_TABLE,
            'risk_mode': SPF_RISK_MODE,
            'nn': [NN_STD_P, NN_STD_TREND, NN_TREND_WEIGHT, NN_TOP_N, NN_TAU],
            'min_samples': MIN_SAMPLES,
        }
        digest = hashlib.sha256(
            json.dumps(cfg, sort_keys=True, ensure_ascii=False).encode('utf-8')
        ).hexdigest()[:12]
        self.config_fingerprint = digest
        print(f"🔒 策略参数指纹: {digest} "
              f"(EV阈值={CALIBRATED_EV_THRESHOLD}, 校准混合={CALIBRATION_BLEND}, "
              f"黑名单{len(LEAGUE_BLACKLIST)}个, 禁平={DISABLE_DRAW_PICK})")
        print("   👉 前瞻验证期间请保持指纹不变；指纹变化=参数被调整，期间成绩不可与历史合并统计。")

    def _build_ai_cache_meta(self):
        train_file = self.train_source_file or self.find_file() or ""
        abs_file = os.path.abspath(train_file) if train_file else ""
        try:
            st = os.stat(train_file) if train_file else None
            file_mtime = int(st.st_mtime) if st else 0
            file_size = int(st.st_size) if st else 0
        except Exception:
            file_mtime = 0
            file_size = 0
        return {
            'version': AI_MODEL_CACHE_VERSION,
            'train_file': abs_file,
            'file_mtime': file_mtime,
            'file_size': file_size,
            'rows': int(len(self.df)) if self.df is not None else 0,
            'cols': tuple(sorted([str(c) for c in (self.df.columns if self.df is not None else [])])),
        }

    def _load_ai_cache(self, cache_meta):
        if not os.path.exists(AI_MODEL_CACHE_FILE):
            return False
        try:
            with open(AI_MODEL_CACHE_FILE, 'rb') as f:
                obj = pickle.load(f)
            if not isinstance(obj, dict):
                return False
            if obj.get('meta') != cache_meta:
                return False
            self.clf_spf = obj.get('clf_spf')
            self.clf_rq = obj.get('clf_rq')
            self.ai_sample_size_spf = int(obj.get('ai_sample_size_spf', 0))
            self.ai_sample_size_rq = int(obj.get('ai_sample_size_rq', 0))
            if not self.clf_spf:
                return False
            print(f"⚡ 已加载AI缓存: {AI_MODEL_CACHE_FILE}")
            return True
        except Exception as e:
            print(f"⚠️ AI缓存读取失败，改为重训: {e}")
            return False

    def _save_ai_cache(self, cache_meta):
        try:
            obj = {
                'meta': cache_meta,
                'clf_spf': self.clf_spf,
                'clf_rq': self.clf_rq,
                'ai_sample_size_spf': int(self.ai_sample_size_spf or 0),
                'ai_sample_size_rq': int(self.ai_sample_size_rq or 0),
            }
            with open(AI_MODEL_CACHE_FILE, 'wb') as f:
                pickle.dump(obj, f)
            print(f"💾 AI模型已缓存: {AI_MODEL_CACHE_FILE}")
        except Exception as e:
            print(f"⚠️ AI缓存写入失败: {e}")
        
    def clean_label(self, val):
        s = str(val).strip()
        if s in ['3', '3.0', '胜', 'W', 'win', '让胜']: return '胜'
        if s in ['1', '1.0', '平', 'D', 'draw', '让平']: return '平'
        if s in ['0', '0.0', '负', 'L', 'lose', '让负']: return '负'
        return None

    def _poisson_pmf(self, k, lam):
        # 统一泊松PMF实现，避免重复定义
        if k < 0:
            return 0.0
        try:
            return (lam**k * math.exp(-lam)) / math.factorial(k)
        except Exception:
            return 0.0

    def _get_tier_num(self, lg_name):
        lg_str = str(lg_name)
        if any(k in lg_str for k in LEAGUE_TIERS['Tier1']): return 1
        if any(k in lg_str for k in LEAGUE_TIERS['Tier2']): return 2
        if any(k in lg_str for k in LEAGUE_TIERS['Tier3']): return 3
        if any(k in lg_str for k in LEAGUE_TIERS['Tier4']): return 4
        return 5

    def load_spf_weights(self):
        """
        从本地 JSON 读取 SPF 融合权重；失败时回退默认常量。
        期望格式:
        {"market": 0.90, "ai_rf": 0.08, "poisson": 0.02}
        """
        defaults = BACKTEST_W_SPF.copy()
        if not USE_EXTERNAL_BLEND_WEIGHTS:
            print("ℹ️ 已禁用外部融合权重，使用固定保守权重。")
            return defaults

        if not os.path.exists(WEIGHTS_FILE):
            print(f"ℹ️ 未找到 {WEIGHTS_FILE}，使用内置融合权重。")
            return defaults

        try:
            with open(WEIGHTS_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if not isinstance(data, dict):
                raise ValueError("权重文件不是 JSON 对象")

            vals = {}
            for k in ['market', 'ai_rf', 'poisson']:
                v = float(data.get(k, defaults[k]))
                if math.isnan(v) or v < 0:
                    raise ValueError(f"权重非法: {k}={v}")
                vals[k] = v

            s = vals['market'] + vals['ai_rf'] + vals['poisson']
            if s <= 0:
                raise ValueError("权重和必须大于0")
            vals = {k: vals[k] / s for k in vals}
            print(
                f"✅ 已加载融合权重: market={vals['market']:.3f}, "
                f"ai_rf={vals['ai_rf']:.3f}, poisson={vals['poisson']:.3f}"
            )
            return vals
        except Exception as e:
            print(f"⚠️ 读取 {WEIGHTS_FILE} 失败，使用内置权重: {e}")
            return defaults

    def load_spf_dynamic_thresholds(self):
        fallback = {
            'defaults_by_band': DEFAULT_SPF_THRESHOLDS_BY_BAND.copy(),
            'thresholds_by_bucket': {}
        }
        if not USE_DYNAMIC_SPF_THRESHOLDS:
            print("ℹ️ 已禁用动态SPF阈值，使用固定阈值。")
            return fallback
        if not os.path.exists(SPF_DYNAMIC_THRESHOLDS_FILE):
            print(f"ℹ️ 未找到 {SPF_DYNAMIC_THRESHOLDS_FILE}，使用固定阈值。")
            return fallback
        try:
            with open(SPF_DYNAMIC_THRESHOLDS_FILE, 'r', encoding='utf-8') as f:
                obj = json.load(f)
            defaults = obj.get('defaults_by_band', {})
            buckets = obj.get('thresholds_by_bucket', {})
            if not isinstance(defaults, dict) or not isinstance(buckets, dict):
                raise ValueError("JSON结构不合法")

            merged_defaults = {}
            for b in ['low', 'mid', 'high']:
                src = defaults.get(b, {})
                base = DEFAULT_SPF_THRESHOLDS_BY_BAND[b]
                merged_defaults[b] = {
                    'top_min': float(src.get('top_min', base['top_min'])),
                    'gap_min': float(src.get('gap_min', base['gap_min'])),
                    'prob_min': float(src.get('prob_min', base['prob_min'])),
                    'ev_min': float(src.get('ev_min', base['ev_min'])),
                }
            print(f"✅ 已加载动态SPF阈值: {SPF_DYNAMIC_THRESHOLDS_FILE} (桶数={len(buckets)})")
            return {
                'defaults_by_band': merged_defaults,
                'thresholds_by_bucket': buckets
            }
        except Exception as e:
            print(f"⚠️ 读取动态SPF阈值失败，回退固定阈值: {e}")
            return fallback

    def resolve_spf_thresholds(self, tier, odds):
        band = get_odds_band(float(odds)) if odds else 'mid'
        cfg = self.spf_dynamic_thresholds or {}
        defaults = cfg.get('defaults_by_band', DEFAULT_SPF_THRESHOLDS_BY_BAND)
        buckets = cfg.get('thresholds_by_bucket', {})

        base = defaults.get(band, DEFAULT_SPF_THRESHOLDS_BY_BAND[band])
        bucket_key = f"{tier}|{band}"
        bucket_cfg = buckets.get(bucket_key, {})
        source = bucket_cfg.get('source', 'default') if bucket_cfg else 'default'

        return {
            'bucket_key': bucket_key,
            'band': band,
            'source': source,
            'top_min': float(bucket_cfg.get('top_min', base['top_min'])),
            'gap_min': float(bucket_cfg.get('gap_min', base['gap_min'])),
            'prob_min': float(bucket_cfg.get('prob_min', base['prob_min'])),
            'ev_min': float(bucket_cfg.get('ev_min', base['ev_min'])),
        }

    def preflight_inputs(self):
        """
        启动前输入健康检查：
        - 训练文件存在且含关键列
        - 赔率 JSON 存在且可解析为列表
        """
        train_path = self.find_file()
        if not train_path:
            print(f"❌ 健康检查失败：找不到训练文件（期望 {TRAIN_FILE} 或同目录 xlsx/csv）")
            return False

        # 只读表头，不加载全量数据
        try:
            if str(train_path).endswith('.csv'):
                hdr = pd.read_csv(train_path, nrows=0)
            else:
                hdr = pd.read_excel(train_path, nrows=0)
            cols = set([str(c).strip() for c in hdr.columns])
            required = {'胜平负结果', '胜平负-最终-胜', '胜平负-最终-平', '胜平负-最终-负'}
            miss = [c for c in required if c not in cols]
            if miss:
                print(f"❌ 健康检查失败：训练文件缺少关键列: {miss}")
                return False
        except Exception as e:
            print(f"❌ 健康检查失败：读取训练文件表头异常: {e}")
            return False

        if not os.path.exists(ODDS_FILE):
            print(f"❌ 健康检查失败：缺少赔率文件 {ODDS_FILE}")
            return False
        try:
            with open(ODDS_FILE, 'r', encoding='utf-8') as f:
                odds = json.load(f)
            if not isinstance(odds, list):
                print(f"❌ 健康检查失败：{ODDS_FILE} 不是比赛列表(JSON array)")
                return False
        except Exception as e:
            print(f"❌ 健康检查失败：赔率文件无法解析: {e}")
            return False

        # 可选文件仅告警，不阻断
        for opt in ['manual_data.xlsx', 'leaguegoals.xlsx', 'allleagues_xg_xga.xlsx', 'match_data1.xlsx', 'bifa.xlsx', 'pankou.xlsx']:
            if not os.path.exists(opt):
                print(f"⚠️ 可选数据缺失: {opt}")
        return True

    # === 新增：亚盘翻译官 ===
    def get_handicap_translator(self, line):
        """
        把数字盘口翻译成中文术语 + 输赢规则
        line: 盘口数值 (负数为主队让球，正数为主队受让)
        """
        if line is None: return "无盘口", ""
        
        abs_line = abs(line)
        decimal = abs_line - int(abs_line)
        is_giving = (line < 0) # 是否让球
        
        # 1. 确定盘口名称
        name = ""
        if decimal == 0: name = "一球" if abs_line == 1 else ("两球" if abs_line == 2 else ("平手" if abs_line==0 else f"{int(abs_line)}球"))
        elif decimal == 0.25: name = "平/半" if abs_line < 0.5 else ("一/球半" if abs_line < 1.5 else f"{int(abs_line)}球/{int(abs_line)}+0.5")
        elif decimal == 0.5: name = "半球" if abs_line < 1 else ("球半" if abs_line < 2 else f"{int(abs_line)}.5球")
        elif decimal == 0.75: name = "半/一" if abs_line < 1 else ("球半/两球" if abs_line < 2 else f"{int(abs_line)}.5/{int(abs_line)+1}")
        
        # 2. 确定规则 (主队视角)
        rule = ""
        if line == 0:
            rule = "打平退钱，赢球全赢"
        
        # --- 让球方 (如 -0.25, -0.5) ---
        elif is_giving:
            tag = "让"
            if decimal == 0: rule = f"赢{int(abs_line)}个走水，赢{int(abs_line)+1}个全赢"
            elif decimal == 0.25: rule = f"打平输一半，赢1球全赢" if abs_line < 0.5 else f"赢{int(abs_line)}个输一半，赢{int(abs_line)+1}个全赢"
            elif decimal == 0.5: rule = f"打平全输，赢1球全赢" if abs_line < 1 else f"赢{int(abs_line)}个全输，赢{int(abs_line)+1}个全赢"
            elif decimal == 0.75: rule = f"赢1球赢一半，赢2球全赢" if abs_line < 1 else f"赢{int(abs_line)}个全输，赢{int(abs_line)+1}个赢一半"
            
        # --- 受让方 (如 +0.25, +0.5) ---
        else:
            tag = "受"
            if decimal == 0: rule = f"输{int(abs_line)}个走水，不输球全赢"
            elif decimal == 0.25: rule = f"打平赢一半，输1球全输" if abs_line < 0.5 else f"输{int(abs_line)}个赢一半，输{int(abs_line)+1}个全输"
            elif decimal == 0.5: rule = f"打平全赢，输1球全输" if abs_line < 1 else f"输{int(abs_line)}个全赢，输{int(abs_line)+1}个全输"
            elif decimal == 0.75: rule = f"输1球输一半，打平全赢" if abs_line < 1 else f"输{int(abs_line)}个全赢，输{int(abs_line)+1}个输一半"

        full_name = f"{tag}{name}" if line != 0 else name
        return full_name, rule

    # === 优化点 6: 无效赔率返回 None ===
    def _get_true_probs(self, o_w, o_d, o_l):
        """
        基于 lsspfpl.xlsx 回测结论的修正去水法：
        1. 歧视主胜：主胜RTP仅86%，意味着水分最大，需强力压缩其真实概率。
        2. 优待平局：平局RTP近90%，水分最少，保留更多概率。
        3. 惩罚高赔：赔率>4.5时RTP暴跌至81%，必须大幅惩罚。
        4. 奖励低赔：赔率<1.5时RTP较高，给予适当补偿。
        """
        if not o_w or not o_d or not o_l or o_w == 0 or o_d == 0 or o_l == 0:
            return None, None, None
            
        # --- 1. 定义基础返还率 (来自你的回测数据) ---
        # 主胜坑最深(0.862)，平局最良心(0.899)，客胜居中(0.880)
        base_rtp_w = 0.862
        base_rtp_d = 0.899
        base_rtp_l = 0.880
        
        # --- 2. 定义长尾修正函数 (处理热门/冷门偏差) ---
        def get_adjusted_rtp(odds, base):
            # 赔率 > 4.5: 大冷门，回测显示RTP只有 81.5%，狠杀
            if odds > 4.50: 
                return 0.815
            # 赔率 < 1.5: 超热门，回测显示RTP有 90.2%，提升权重
            elif odds < 1.50: 
                return 0.902
            # 中间区间: 使用选项的基础RTP
            else: 
                return base

        # --- 3. 计算修正后的 RTP ---
        rtp_w = get_adjusted_rtp(o_w, base_rtp_w)
        rtp_d = get_adjusted_rtp(o_d, base_rtp_d)
        rtp_l = get_adjusted_rtp(o_l, base_rtp_l)

        # --- 4. 还原真实概率 (概率 = RTP / 赔率) ---
        # 这一步算出来的是未归一化的概率
        raw_p_w = rtp_w / o_w
        raw_p_d = rtp_d / o_d
        raw_p_l = rtp_l / o_l
        
        # --- 5. 归一化 (让概率之和等于1) ---
        total_p = raw_p_w + raw_p_d + raw_p_l
        if total_p == 0: return None, None, None
        
        p_w = raw_p_w / total_p
        p_d = raw_p_d / total_p
        p_l = raw_p_l / total_p
        
        return p_w, p_d, p_l

    def _get_true_probs_rq(self, o_w, o_d, o_l):
        """
        让球三项(RQ)专用去水：使用更均衡的RTP参数，避免直接复用SPF偏置。
        """
        if not o_w or not o_d or not o_l or o_w == 0 or o_d == 0 or o_l == 0:
            return None, None, None

        base_rtp = 0.890

        def get_adjusted_rtp(odds, base):
            if odds > 4.50:
                return 0.840
            elif odds < 1.50:
                return 0.900
            else:
                return base

        rtp_w = get_adjusted_rtp(o_w, base_rtp)
        rtp_d = get_adjusted_rtp(o_d, base_rtp)
        rtp_l = get_adjusted_rtp(o_l, base_rtp)

        raw_p_w = rtp_w / o_w
        raw_p_d = rtp_d / o_d
        raw_p_l = rtp_l / o_l

        total_p = raw_p_w + raw_p_d + raw_p_l
        if total_p == 0:
            return None, None, None

        return raw_p_w / total_p, raw_p_d / total_p, raw_p_l / total_p

    def _calc_poisson_matrix(self, lam_h, lam_a):
        """
        输出：p_win, p_draw, p_loss, top_scores(列表)
        版本：V32.0 纯净高进球版 (去除小球偏见)
        """
        # 1. 扩大计算范围：从 6 改为 10
        # 这样才能捕捉到 3:3, 4:2, 5:0 这种大比分的概率
        limit = 10 
        
        prob_h = [self._poisson_pmf(i, lam_h) for i in range(limit)]
        prob_a = [self._poisson_pmf(i, lam_a) for i in range(limit)]
        
        p_w, p_d, p_l = 0.0, 0.0, 0.0
        score_list = [] 
        
        for h in range(limit):
            for a in range(limit):
                prob = prob_h[h] * prob_a[a]
                
                # --- 【核心修改】删除了这里的 0:0/1:1 强行加权 ---
                # 让数据说话：如果 Lambda 高，大比分概率自然就高
                
                # 收集比分 (门槛调低到 0.001，保留更多长尾冷门比分)
                if prob > 0.001:
                    score_list.append({'score': f"{h}:{a}", 'pct': prob})
                
                if h > a: p_w += prob
                elif h == a: p_d += prob
                else: p_l += prob
                    
        # 归一化
        total = p_w + p_d + p_l
        if total == 0: return 0, 0, 0, []
        
        # 对具体比分的概率做归一化
        for item in score_list:
            item['pct'] /= total
            
        # 按概率降序排列，取前5名 (原来只取3名，现在多看几个，防冷门)
        score_list.sort(key=lambda x: x['pct'], reverse=True)
        top_scores = score_list[:5] # 显示前5个比分
        
        return p_w/total, p_d/total, p_l/total, top_scores

        
    def _calc_rq_poisson(self, lam_h, lam_a, handicap):
        """
        基于泊松分布，计算【竞彩让球】的胜平负概率
        版本：V31.0 竞彩整数盘专用高精度版
        """
        # 扩大计算范围到 9球，防止强队穿盘后的概率丢失
        limit = 10 
        p_rq_w, p_rq_d, p_rq_l = 0.0, 0.0, 0.0
        
        # 预计算概率列表
        prob_h = [self._poisson_pmf(i, lam_h) for i in range(limit)]
        prob_a = [self._poisson_pmf(i, lam_a) for i in range(limit)]
        
        # 定义极小误差，解决 float 计算 -1.0 + 1.0 != 0 的问题
        EPSILON = 1e-5
        
        for h in range(limit):
            for a in range(limit):
                prob = prob_h[h] * prob_a[a]
                
                # --- 基础比分修正 (非让球修正) ---
                # 这是为了让基础泊松更符合足球低进球的规律
                # 如果不加这个，所有平局(包括让平)的概率都会偏低
                #if h == a:
                #    if h == 0: prob *= 1.20 # 0-0 修正
                #    elif h == 1: prob *= 1.10 # 1-1 修正
                
                # --- 竞彩让球判定 ---
                
                # 计算: 主队进球 + 让球值 - 客队进球
                # 例如: 2 : 1，让 -1
                # diff = 2 + (-1) - 1 = 0
                diff = h + handicap - a
                
                # 判定
                if diff > EPSILON:
                    p_rq_w += prob # 让胜
                elif abs(diff) <= EPSILON:
                    p_rq_d += prob # 让平 (命中这里！)
                else:
                    p_rq_l += prob # 让负
                    
        # 归一化
        total = p_rq_w + p_rq_d + p_rq_l
        if total == 0: return 0, 0, 0
        
        return p_rq_w/total, p_rq_d/total, p_rq_l/total

    def find_file(self):
        if os.path.exists(TRAIN_FILE): return TRAIN_FILE
        files = glob.glob("*.xlsx") + glob.glob("*.csv")
        return files[0] if files else None

    def load_data(self):
        f = self.find_file()
        if not f: 
            print(f"❌ 错误：找不到 {TRAIN_FILE}")
            return False
        self.train_source_file = f
        
        print(f"🔄 读取全息历史库 (V104 Expert): {f} ...")
        try:
            if f.endswith('.csv'): self.df = pd.read_csv(f)
            else: self.df = pd.read_excel(f)
            
            self.df.columns = self.df.columns.str.strip()
            
            if '胜平负结果' in self.df.columns: self.df['胜平负结果'] = self.df['胜平负结果'].apply(self.clean_label)
            if '让球结果' in self.df.columns: self.df['让球结果'] = self.df['让球结果'].apply(self.clean_label)
            
            num_cols = [
                '胜平负-初始-胜', '胜平负-初始-平', '胜平负-初始-负',
                '胜平负-最终-胜', '胜平负-最终-平', '胜平负-最终-负',
                '让球-初始-胜', '让球-初始-平', '让球-初始-负',
                '让球-最终-胜', '让球-最终-平', '让球-最终-负',
                '让球'
            ]
            for c in num_cols:
                if c in self.df.columns: self.df[c] = pd.to_numeric(self.df[c], errors='coerce')
                else: self.df[c] = np.nan

            self.df['让球'] = self.df['让球'].apply(lambda x: round(x * 4) / 4 if pd.notnull(x) else x)
            self.df = self.df.dropna(subset=['让球', '让球-最终-胜', '胜平负-最终-胜', '胜平负-初始-胜'])

            # === 时序处理 ===
            # 历史库若无日期列，可在 .env 中声明 SPF_ROWS_ARE_TIME_ORDERED=1，
            # 表示"文件行序即时间序（最后一行=最近比赛）"，跳过日期探测与警告。
            self._time_sorted_by = None
            _rows_ordered = os.environ.get('SPF_ROWS_ARE_TIME_ORDERED', '').strip() in ('1', 'true', 'True')
            if _rows_ordered:
                self._time_sorted_by = '行序(人工确认)'
                print("🕐 已声明历史库按行序排列（旧→新），时间衰减与校准切分基于行序。")
            else:
                for _dcol in ('比赛时间', '开赛时间', '比赛日期', '日期', '时间', 'date', 'Date', 'match_date'):
                    if _dcol in self.df.columns:
                        _parsed = pd.to_datetime(self.df[_dcol], errors='coerce')
                        if _parsed.notna().mean() >= 0.8:  # 至少80%能解析才视为有效日期列
                            self.df = self.df.assign(_sort_dt=_parsed)
                            self.df = self.df.sort_values('_sort_dt', kind='stable').drop(columns=['_sort_dt'])
                            self._time_sorted_by = _dcol
                            break
                if self._time_sorted_by:
                    print(f"🕐 历史库已按『{self._time_sorted_by}』升序排列。")
                else:
                    print("ℹ️ 未找到日期列，按行序作为时间序（最后一行视为最近比赛）。"
                          "若确认如此，可在 .env 设置 SPF_ROWS_ARE_TIME_ORDERED=1 关闭本提示。")

            # 顺序索引（旧->新）：用于时间衰减
            self.df = self.df.reset_index(drop=True)
            self.df['_row_id'] = np.arange(len(self.df))

            # 赔率变化量
            self.df['spf_delta_h'] = self.df['胜平负-最终-胜'] - self.df['胜平负-初始-胜']
            self.df['spf_delta_a'] = self.df['胜平负-最终-负'] - self.df['胜平负-初始-负']
            self.df['spf_delta_h'] = self.df['spf_delta_h'].fillna(0)
            self.df['spf_delta_a'] = self.df['spf_delta_a'].fillna(0)

            # 让球赔率变化量（用于 RQ 趋势锁定；没有初赔则为 0）
            self.df['rq_delta_h'] = self.df['让球-最终-胜'] - self.df['让球-初始-胜']
            self.df['rq_delta_a'] = self.df['让球-最终-负'] - self.df['让球-初始-负']
            self.df['rq_delta_h'] = self.df['rq_delta_h'].fillna(0)
            self.df['rq_delta_a'] = self.df['rq_delta_a'].fillna(0)
            
            # CR 计算
            temp_rq = self.df['让球-最终-胜'].replace(0, np.nan)
            self.df['cr_ratio'] = self.df['胜平负-最终-胜'] / temp_rq
            self.df['cr_ratio'] = self.df['cr_ratio'].fillna(0)
            
            self.manual_data = self.load_manual_data()
            self.load_advanced_data() 
            self.build_league_profiles()
            self.train_ai()
            return True
        except Exception as e:
            print(f"❌ 读取文件失败: {e}")
            return False

    def load_manual_data(self):
        """
        读取 manual_data.xlsx
        包含：欧赔、返还率(RTP)、凯利指数
        兼容两类表头：
        - 旧版：平均主胜/平均平赔/平均客胜
        - 新版：胜/平/负
        """
        manual_file = 'manual_data.xlsx'
        if not os.path.exists(manual_file): return {}

        print(f"📂 读取人工风控数据 (含RTP): {manual_file} ...")

        def norm_team(s):
            t = str(s or "").strip().lower()
            t = t.replace("FC", "").replace("fc", "").replace(" ", "")
            t = t.replace("（", "(").replace("）", ")")
            t = re.sub(r"[·\\-\\.()]", "", t)
            return t

        def parse_duel(raw):
            txt = str(raw or "").strip()
            if not txt or txt.lower() == 'nan':
                return "", ""
            if ':' in txt:
                txt = txt.split(':', 1)[-1].strip()
            parts = re.split(r"\s+VS\s+|\s+vs\s+|VS|vs", txt, flags=re.I)
            if len(parts) >= 2:
                return parts[0].strip(), parts[1].strip()
            return txt.strip(), ""

        def pick_value(row, candidates):
            for c in candidates:
                v = row.get(c, None)
                if v is None:
                    continue
                if isinstance(v, str) and not v.strip():
                    continue
                try:
                    if math.isnan(v):
                        continue
                except Exception:
                    pass
                return v
            return None

        def get_float(val, default=None):
            try:
                if val is None or (isinstance(val, str) and val.strip() == ""):
                    return default
                if isinstance(val, str):
                    s = val.strip().replace("−", "-").replace(",", "")
                    if s.endswith("%"):
                        v = float(s[:-1]) / 100.0
                    else:
                        v = float(s)
                else:
                    v = float(val)
                return v if not math.isnan(v) else default
            except Exception:
                return default

        try:
            df = pd.read_excel(manual_file, dtype={0: str})
            df.columns = df.columns.str.strip()
            manual_map = {}

            for _, row in df.iterrows():
                # 1) 读取对阵（优先“对阵”列，兼容旧文件首列）
                duel_raw = row.get('对阵', None)
                if duel_raw is None or (isinstance(duel_raw, str) and not duel_raw.strip()):
                    duel_raw = row.iloc[0]
                h_row, a_row = parse_duel(duel_raw)
                if not h_row:
                    continue

                # 2) 读取欧赔（兼容新旧列名）
                avg_w = get_float(pick_value(row, ['平均主胜', '主胜', '胜']), 0.0)
                avg_d = get_float(pick_value(row, ['平均平赔', '平赔', '平']), 0.0)
                avg_l = get_float(pick_value(row, ['平均客胜', '客胜', '负']), 0.0)

                # 3) 读取凯利值
                k_w = get_float(pick_value(row, ['凯利胜']), 0.95)
                k_d = get_float(pick_value(row, ['凯利平']), 0.95)
                k_l = get_float(pick_value(row, ['凯利负']), 0.95)

                # 4) 读取返还率（支持 0.93 或 93%）
                avg_rtp = get_float(pick_value(row, ['返还率']), 0.94)
                if avg_rtp and avg_rtp > 1.2:
                    avg_rtp = avg_rtp / 100.0

                info = {
                    'avg_w': avg_w, 'avg_d': avg_d, 'avg_l': avg_l,
                    'k_w': k_w, 'k_d': k_d, 'k_l': k_l,
                    'avg_rtp': avg_rtp
                }

                # 主键：主客队规范化对阵（避免只按主队匹配导致错配）
                n_h = norm_team(h_row)
                n_a = norm_team(a_row)
                if n_h and n_a:
                    manual_map[f"__PAIR__{n_h}|{n_a}"] = info
                if n_h:
                    manual_map[f"__HOME__{n_h}"] = info
                    manual_map[h_row] = info
                if h_row and a_row:
                    manual_map[f"{h_row} VS {a_row}"] = info

            print(f"✅ 人工风控加载完成: {len(manual_map)} 条索引")
            return manual_map

        except Exception as e:
            print(f"❌ 读取人工数据失败: {e}")
            return {}


    # --- 【修改位置 2】新增读取函数 ---
    def load_advanced_data(self):
        print("📂 正在读取高级xG数据库...")
        self.xg_data = {}
        self.lg_data = {}
        
        # ==========================================
        # 1. 读取联赛基准 (leaguegoals.xlsx)
        # ==========================================
        f_lg = 'leaguegoals.xlsx' # 请确认文件名
        if os.path.exists(f_lg):
            try:
                # 默认读取第1张Sheet
                df = pd.read_excel(f_lg)
                # 去除列名空格，防止 "联赛 " 这种错误
                df.columns = df.columns.str.strip()
                
                for _, row in df.iterrows():
                    # 关键列名：'联赛', '主场场均进球', '客场场均进球'
                    # 如果你的Excel里叫 "主场进球"，请手动修改下面的代码
                    lg_name = str(row['联赛']).strip()
                    self.lg_data[lg_name] = {
                        'avg_home': float(row['主场场均进球']),
                        'avg_away': float(row['客场场均进球'])
                    }
                print(f"✅ 联赛基准加载成功: {len(self.lg_data)} 个联赛")
            except Exception as e:
                print(f"❌ 读取联赛文件({f_lg})失败: {e}")
        else:
            print(f"⚠️ 未找到文件: {f_lg}")

        # ==========================================
        # 2. 读取球队数据 (allleagues_xg_xga.xlsx)
        # ==========================================
        f_xg = 'allleagues_xg_xga.xlsx' # 请确认文件名
        if os.path.exists(f_xg):
            try:
                # 默认读取第1张Sheet
                df = pd.read_excel(f_xg)
                df.columns = df.columns.str.strip()
                
                count = 0
                for _, row in df.iterrows():
                    # 关键列名：'球队', '主场xG', '客场xG', '主场xGA', '客场xGA'
                    # 请确认你的Excel里确实是这就叫这些名字
                    name = str(row['球队']).strip()
                    if not name or name == 'nan': continue
                    
                    self.xg_data[name] = {
                        'home_xg': float(row['主场xG']),
                        'away_xg': float(row['客场xG']),
                        'home_xga': float(row['主场xGA']),
                        'away_xga': float(row['客场xGA'])
                    }
                    count += 1
                print(f"✅ 球队xG加载成功: {count} 支球队")
                
            except Exception as e:
                print(f"❌ 读取球队文件({f_xg})失败: {e}")
                print(f"👉 程序看到的列名是: {df.columns.tolist()}") # 报错时打印列名帮你检查
        else:
            print(f"⚠️ 未找到文件: {f_xg}")
            
    # 【修改位置 2】新增：加载 match_data1.xlsx (基于ID匹配)
    # ==========================================================
    # ==========================================================
    # 【修复版】加载 match_data1.xlsx (自动适配列名)
    # ==========================================================
    def load_match_excel_data(self):
        excel_file = 'match_data1.xlsx'
        if not os.path.exists(excel_file):
            print(f"⚠️ 未找到 {excel_file}，跳过动态修正。")
            return {}

        print(f"📊 读取动态状态数据: {excel_file} ...")
        try:
            df = pd.read_excel(excel_file)
            # 1. 强力清洗列名：去空格、去括号里的内容，只留核心关键词
            # 这样 '主队进失球 (近5场)' 就能被识别为 '主队进失球'，防改名
            df.columns = df.columns.str.strip()
            
            # 辅助：模糊查找列名
            def find_col(keywords):
                for col in df.columns:
                    if all(k in col for k in keywords):
                        return col
                return None

            # 动态定位列名
            col_h_goal = find_col(['主队', '进失球']) # 找包含这两个词的列
            col_a_goal = find_col(['客队', '进失球'])
            col_status = find_col(['状态信息'])
            col_history = find_col(['历史战绩'])
            col_id = find_col(['比赛ID'])

            if not col_id:
                print("❌ Excel 缺少 '比赛ID' 列，无法加载！")
                return {}

            data_map = {}
            count_ok = 0
            
            for _, row in df.iterrows():
                try:
                    # 获取比赛ID
                    raw_id = row.get(col_id)
                    if pd.isna(raw_id): continue
                    m_id = int(raw_id)
                    
                    # 1. 提取近期进失球
                    # 格式: "进球5, 失球15" 或 "进球:5 失球:15"
                    def parse_goals(txt):
                        if not isinstance(txt, str): return 0, 0
                        # 兼容中文逗号和冒号
                        clean_txt = txt.replace('：', ':').replace('，', ',')
                        g = re.search(r'进球\D*(\d+)', clean_txt)
                        l = re.search(r'失球\D*(\d+)', clean_txt)
                        
                        # 算场均 (除以5)
                        avg_g = int(g.group(1))/5 if g else 0
                        avg_l = int(l.group(1))/5 if l else 0
                        return avg_g, avg_l

                    h_avg_g, h_avg_l = parse_goals(row.get(col_h_goal))
                    a_avg_g, a_avg_l = parse_goals(row.get(col_a_goal))
                    
                    # 2. 提取上次比赛日期
                    status_txt = str(row.get(col_status, ''))
                    
                    def get_last_date(txt, tag):
                        # 兼容中文冒号和英文冒号
                        # 匹配模式：找到 "主队" -> 后面任意字符 -> 找到第一个日期格式
                        pattern = tag + r'.*?(\d{4}-\d{2}-\d{2})'
                        match = re.search(pattern, txt, re.DOTALL)
                        return match.group(1) if match else None

                    h_last_date = get_last_date(status_txt, '主队')
                    a_last_date = get_last_date(status_txt, '客队')
                    
                    # 3. 提取历史
                    history_txt = str(row.get(col_history, ''))
                    
                    data_map[m_id] = {
                        'h_recent': {'gf': h_avg_g, 'ga': h_avg_l},
                        'a_recent': {'gf': a_avg_g, 'ga': a_avg_l},
                        'fatigue': {'h_date': h_last_date, 'a_date': a_last_date},
                        'history_raw': history_txt
                    }
                    count_ok += 1
                except Exception as e:
                    continue
            
            print(f"✅ 动态数据加载成功: {count_ok} 场 (列名已自动适配)")
            return data_map
        except Exception as e:
            print(f"❌ 读取Excel失败: {e}")
            return {}

    def load_match_json_data(self):
        json_file = 'match_data1.json'
        if not os.path.exists(json_file):
            print(f"⚠️ 未找到 {json_file}，跳过历史交锋JSON增强。")
            return {}

        print(f"📘 读取历史交锋JSON: {json_file} ...")
        try:
            with open(json_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if not isinstance(data, list):
                return {}

            out = {}
            count_ok = 0
            for item in data:
                try:
                    m_id = int(item.get('matchId'))
                except Exception:
                    continue
                out[m_id] = {
                    'history_matches': item.get('history') or [],
                    'recent_results': item.get('results') or {},
                    'goal_odds': item.get('odds') or {},
                }
                count_ok += 1
            print(f"✅ 历史交锋JSON加载成功: {count_ok} 场")
            return out
        except Exception as e:
            print(f"❌ 读取历史交锋JSON失败: {e}")
            return {}

    def load_match_context_full(self):
        json_file = 'match_context_full.json'
        if not os.path.exists(json_file):
            print(f"⚠️ 未找到 {json_file}，跳过标准情报层。")
            return {}

        print(f"🧠 读取标准情报层: {json_file} ...")
        try:
            with open(json_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if isinstance(data, dict):
                news_map = self.load_match_news_context()
                fotmob_map = self.load_fotmob_context()
                out = {}
                for k, v in data.items():
                    if isinstance(v, dict):
                        context = self._merge_match_news_context(v, news_map)
                        context = self._merge_fotmob_context(context, fotmob_map)
                        out[int(k) if str(k).isdigit() else k] = context
                print(f"✅ 标准情报层加载成功: {len(out)} 场")
                return out
            print("⚠️ 标准情报层格式异常，跳过。")
            return {}
        except Exception as e:
            print(f"❌ 读取标准情报层失败: {e}")
            return {}

    def load_fotmob_context(self, json_file=FOTMOB_CONTEXT_FILE):
        if not os.path.exists(json_file):
            return {}
        try:
            with open(json_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if not isinstance(data, dict):
                print(f"⚠️ FotMob缓存格式异常，跳过: {json_file}")
                return {}
            out = {str(k): v for k, v in data.items() if not str(k).startswith("_") and isinstance(v, dict)}
            if out:
                print(f"🩺 读取FotMob伤停缓存: {json_file}，{len(out)} 场")
            return out
        except Exception as e:
            print(f"⚠️ 读取FotMob伤停缓存失败 ({json_file}): {e}")
            return {}

    def load_match_news_context(self, json_file=MATCH_NEWS_CONTEXT_FILE):
        if not os.path.exists(json_file):
            return {}
        try:
            with open(json_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if not isinstance(data, dict):
                print(f"⚠️ 赛前新闻缓存格式异常，跳过: {json_file}")
                return {}
            out = {str(k): v for k, v in data.items() if not str(k).startswith("_") and isinstance(v, dict)}
            if out:
                print(f"📰 读取赛前新闻缓存: {json_file}，{len(out)} 场")
            return out
        except Exception as e:
            print(f"⚠️ 读取赛前新闻缓存失败 ({json_file}): {e}")
            return {}

    def _merge_match_news_context(self, full_context, news_map):
        context = dict(full_context or {})
        if not isinstance(news_map, dict) or not news_map:
            return context

        keys = []
        match_id = context.get('match_id')
        if match_id not in (None, ""):
            keys.append(str(match_id))
        match_key = str(context.get('match_key') or '').strip()
        if match_key:
            keys.append(match_key)

        news = None
        for key in keys:
            candidate = news_map.get(key)
            if isinstance(candidate, dict):
                news = candidate
                break
        if not news:
            return context

        official_news = context.get('official_news') if isinstance(context.get('official_news'), dict) else {}
        official_news = dict(official_news)
        official_news['prefetch_news'] = news
        context['official_news'] = official_news
        return context

    def _merge_fotmob_context(self, full_context, fotmob_map):
        context = dict(full_context or {})
        if not isinstance(fotmob_map, dict) or not fotmob_map:
            return context

        keys = []
        match_id = context.get('match_id')
        if match_id not in (None, ""):
            keys.append(str(match_id))
        match_key = str(context.get('match_key') or '').strip()
        if match_key:
            keys.append(match_key)

        fotmob_entry = None
        for key in keys:
            candidate = fotmob_map.get(key)
            if isinstance(candidate, dict):
                fotmob_entry = candidate
                break

        if not fotmob_entry:
            context['fotmob_context'] = {
                'source': 'fotmob',
                'injury': {
                    'source': 'fotmob',
                    'summary': 'FotMob伤停未匹配，本场不使用伤停影响',
                    'home_absences': [],
                    'away_absences': [],
                },
            }
            context['lineup_injury'] = context['fotmob_context']['injury']
            return context

        context['fotmob_context'] = fotmob_entry
        injury = fotmob_entry.get('injury') if isinstance(fotmob_entry.get('injury'), dict) else {}
        if injury:
            merged_injury = dict(injury)
            match_info = fotmob_entry.get('match') if isinstance(fotmob_entry.get('match'), dict) else {}
            if match_info.get('url') and not merged_injury.get('source_url'):
                merged_injury['source_url'] = match_info.get('url')
            context['lineup_injury'] = merged_injury
        return context

    def _format_llm_match_list(self, matches, limit=5):
        out = []
        for m in (matches or [])[:limit]:
            if not isinstance(m, dict):
                continue
            dt = str(m.get('date', '') or '')
            home = str(m.get('homeTeam', '') or '')
            away = str(m.get('awayTeam', '') or '')
            score = str(m.get('score', '') or '')
            tour = str(m.get('tournament', '') or '')
            line = " | ".join([x for x in [dt, tour, f"{home} vs {away}", score] if x])
            if line:
                out.append(line)
        return out

    def _build_llm_review_info(self, candidate, odds_data, manual_info, poisson_data, bf_data, pk_info, dyn_info):
        kind = str((candidate or {}).get('kind', 'spf')).lower()

        manual_summary = {}
        if manual_info:
            manual_summary = {
                'avg_w': round(float(manual_info.get('avg_w', 0) or 0), 3),
                'avg_d': round(float(manual_info.get('avg_d', 0) or 0), 3),
                'avg_l': round(float(manual_info.get('avg_l', 0) or 0), 3),
                'rtp': round(float(manual_info.get('avg_rtp', 0) or 0), 4),
                'kelly_w': round(float(manual_info.get('k_w', 0) or 0), 3),
                'kelly_d': round(float(manual_info.get('k_d', 0) or 0), 3),
                'kelly_l': round(float(manual_info.get('k_l', 0) or 0), 3),
            }

        poisson_summary = {}
        if poisson_data:
            poisson_summary = {
                'lam_h': round(float(poisson_data.get('lh', 0) or 0), 3),
                'lam_a': round(float(poisson_data.get('la', 0) or 0), 3),
                'spf': {
                    '胜': round(float(poisson_data.get('ph', 0) or 0), 4),
                    '平': round(float(poisson_data.get('pd', 0) or 0), 4),
                    '负': round(float(poisson_data.get('pl', 0) or 0), 4),
                },
                'rq': {
                    '胜': round(float(poisson_data.get('rq_ph', 0) or 0), 4),
                    '平': round(float(poisson_data.get('rq_pd', 0) or 0), 4),
                    '负': round(float(poisson_data.get('rq_pl', 0) or 0), 4),
                },
                'scores': [f"{x.get('score')}({x.get('pct', 0):.1%})" for x in (poisson_data.get('scores') or [])[:5] if isinstance(x, dict)],
            }

        bifa_summary = {}
        if bf_data:
            try:
                bifa_summary = {
                    'vol': {k: round(float((bf_data.get('vol') or {}).get(k, 0) or 0), 4) for k in ['h', 'd', 'a']},
                    'var': {k: round(float((bf_data.get('var') or {}).get(k, 0) or 0), 4) for k in ['h', 'd', 'a']},
                    'odds': {k: round(float((bf_data.get('odds') or {}).get(k, 0) or 0), 4) for k in ['h', 'd', 'a']},
                }
            except Exception:
                bifa_summary = {}

        pankou_summary = {}
        if pk_info:
            pankou_summary = {
                'pb': pk_info.get('pb') or {},
                'mac': pk_info.get('mac') or {},
            }

        h2h_matches = []
        recent_home = []
        recent_away = []
        recent_stats = {}
        if dyn_info:
            h2h_matches = self._format_llm_match_list(dyn_info.get('history_matches') or [], limit=6)
            recent_struct = dyn_info.get('recent_results') or {}
            home_block = recent_struct.get('home') or {}
            away_block = recent_struct.get('away') or {}
            recent_home = self._format_llm_match_list(home_block.get('matches') or [], limit=5)
            recent_away = self._format_llm_match_list(away_block.get('matches') or [], limit=5)
            recent_stats = {
                'home': home_block.get('stats') or {},
                'away': away_block.get('stats') or {},
                'recent_gfga': {
                    'home': dyn_info.get('h_recent') or {},
                    'away': dyn_info.get('a_recent') or {},
                },
                'fatigue': dyn_info.get('fatigue') or {},
            }

        full_context = (dyn_info or {}).get('full_context') or {}
        full_history = full_context.get('history_context') or {}
        standings_snapshot = full_context.get('standings_snapshot') or {}
        merged_history = {
            'h2h_matches': h2h_matches,
            'recent_home_matches': recent_home,
            'recent_away_matches': recent_away,
            'stats': recent_stats,
            'history_raw': str((dyn_info or {}).get('history_raw', '') or '')[:1200],
        }
        if full_history:
            merged_history.update({
                'forebet_head_to_head': full_history.get('head_to_head_matches') or [],
                'forebet_home_last6': full_history.get('home_last6_matches') or [],
                'forebet_away_last6': full_history.get('away_last6_matches') or [],
                'forebet_home_matches': full_history.get('home_matches') or [],
                'forebet_away_matches': full_history.get('away_matches') or [],
                'forebet_intro': full_history.get('intro_paragraphs') or [],
            })

        match_info_extra = dict(full_context.get('match_info') or {})
        original_home = str(match_info_extra.get('home_team') or '').strip()
        original_away = str(match_info_extra.get('away_team') or '').strip()
        if full_context.get('match_key'):
            match_info_extra['match_key'] = full_context.get('match_key')
        if full_context.get('home_team'):
            if original_home and original_home != full_context.get('home_team'):
                match_info_extra['home_team_alt'] = original_home
            match_info_extra['home_team'] = full_context.get('home_team')
        if full_context.get('away_team'):
            if original_away and original_away != full_context.get('away_team'):
                match_info_extra['away_team_alt'] = original_away
            match_info_extra['away_team'] = full_context.get('away_team')
        lineup_injury = full_context.get('lineup_injury') or {}
        market_consensus_summary = self._build_market_consensus_summary(
            odds_data=odds_data,
            bifa_summary=bifa_summary,
            pankou_summary=pankou_summary,
        )
        market_heat_warning = self._build_market_heat_warning(
            odds_data=odds_data,
            bifa_summary=bifa_summary,
            pankou_summary=pankou_summary,
        )
        draw_warning = self._build_draw_warning(
            odds_data=odds_data,
            poisson_data=poisson_data,
        )
        replay_attribution_brief = self._build_replay_attribution_brief(
            match_info_extra=match_info_extra,
        )
        calibration_brief = self._build_calibration_brief(
            market_heat_warning=market_heat_warning,
            draw_warning=draw_warning,
            match_info_extra=match_info_extra,
            suppress_overlap=bool(replay_attribution_brief),
        )
        decision_level = self._classify_llm_decision_level(
            candidate=candidate,
            market_heat_warning=market_heat_warning,
            draw_warning=draw_warning,
            replay_attribution_brief=replay_attribution_brief,
        )
        recent_form_summary = self._build_recent_form_summary(
            history=merged_history,
            match_info_extra=match_info_extra,
            standings_snapshot=standings_snapshot,
        )
        ou_path_summary = self._build_ou_path_summary(
            poisson_data=poisson_data,
            technical_stats_context=full_context.get('technical_stats_context') or {},
        )
        score_path_summary = self._build_score_path_summary(
            best_bet=candidate,
            spf_stats=spf_stats_blend if 'spf_stats_blend' in locals() else None,
            poisson_data=poisson_data,
        )

        return {
            'kind': kind,
            'handicap': odds_data.get('handicap', 0),
            'market_odds': {
                'spf_init': {'胜': odds_data.get('sw_init'), '平': odds_data.get('sd_init'), '负': odds_data.get('sl_init')},
                'spf_curr': {'胜': odds_data.get('sw'), '平': odds_data.get('sd'), '负': odds_data.get('sl')},
                'rq_init': {'胜': odds_data.get('rw_init'), '平': odds_data.get('rd_init'), '负': odds_data.get('rl_init')},
                'rq_curr': {'胜': odds_data.get('rw'), '平': odds_data.get('rd'), '负': odds_data.get('rl')},
            },
            'manual': manual_summary,
            'poisson': poisson_summary,
            'bifa': bifa_summary,
            'pankou': pankou_summary,
            'odds_movement_context': odds_data.get('odds_movement_context') or {},
            'history': merged_history,
            'match_info_extra': match_info_extra,
            'schedule_context': full_context.get('schedule_context') or {},
            'lineup_injury': lineup_injury,
            'injury_impact_summary': self._build_injury_impact_summary(lineup_injury),
            'market_consensus_summary': market_consensus_summary,
            'market_heat_warning': market_heat_warning,
            'draw_warning': draw_warning,
            'calibration_brief': calibration_brief,
            'replay_attribution_brief': replay_attribution_brief,
            'decision_level': decision_level,
            'recent_form_summary': recent_form_summary,
            'ou_path_summary': ou_path_summary,
            'score_path_summary': score_path_summary,
            'standings_motivation': full_context.get('standings_motivation') or {},
            'standings_snapshot': standings_snapshot,
            'weather_venue': full_context.get('weather_venue') or {},
            'official_news': full_context.get('official_news') or {},
            'trend_context': full_context.get('trend_context') or {},
            'technical_stats_context': full_context.get('technical_stats_context') or {},
            'quality_control': full_context.get('quality_control') or {},
            'llm_summary_input': full_context.get('llm_summary_input') or {},
        }

    def _get_team_alias_map(self):
        alias_map = getattr(self, 'team_alias_map', None)
        if isinstance(alias_map, dict):
            return alias_map
        alias_map = load_team_alias_map()
        self.team_alias_map = alias_map
        return alias_map

    def _recent_history_rows(self, history, side):
        history = history or {}
        if side == 'home':
            return (
                history.get('recent_home_rows')
                or history.get('home_last6_matches')
                or history.get('forebet_home_last6')
                or history.get('recent_home_matches')
                or []
            )
        return (
            history.get('recent_away_rows')
            or history.get('away_last6_matches')
            or history.get('forebet_away_last6')
            or history.get('recent_away_matches')
            or []
        )

    def _parse_recent_form_row(self, item):
        if isinstance(item, dict):
            return {
                'date': str(item.get('date') or item.get('date_text') or '').strip(),
                'home_team': str(item.get('homeTeam') or item.get('home_team') or '').strip(),
                'away_team': str(item.get('awayTeam') or item.get('away_team') or '').strip(),
                'score': str(item.get('score') or '').strip(),
                'league_tag': str(item.get('league_tag') or item.get('tournament') or item.get('league') or '').strip(),
            }
        text = str(item or '').strip()
        if not text:
            return {}
        parts = [x.strip() for x in text.split('|')]
        teams = parts[-2] if len(parts) >= 2 else ''
        score = parts[-1] if len(parts) >= 1 else ''
        home_team = away_team = ''
        if ' vs ' in teams:
            home_team, away_team = [x.strip() for x in teams.split(' vs ', 1)]
        return {
            'date': parts[0] if parts else '',
            'home_team': home_team,
            'away_team': away_team,
            'score': score,
            'league_tag': parts[1] if len(parts) >= 4 else '',
        }

    def _parse_recent_form_date(self, text):
        raw = str(text or '').strip()
        if not raw:
            return None
        for fmt in ('%Y-%m-%d', '%Y/%m/%d', '%m/%d/%Y', '%m/%d %Y', '%m/%d/%y'):
            try:
                return datetime.datetime.strptime(raw, fmt)
            except Exception:
                continue
        match = re.match(r'(\d{2})/(\d{2})\s+(\d{4})', raw)
        if match:
            try:
                return datetime.datetime(int(match.group(3)), int(match.group(1)), int(match.group(2)))
            except Exception:
                return None
        return None

    def _recent_team_markers(self, match_info_extra, side):
        match_info_extra = match_info_extra or {}
        alias_map = self._get_team_alias_map()
        keys = ['home_team', 'home_team_alt'] if side == 'home' else ['away_team', 'away_team_alt']
        markers = []
        for key in keys:
            text = str(match_info_extra.get(key) or '').strip()
            if not text:
                continue
            markers.append(text)
            canonical = canonicalize_team_name(text, alias_map)
            if canonical and canonical not in markers:
                markers.append(canonical)
        return markers

    def _recent_result_for_row(self, row, team_markers):
        alias_map = self._get_team_alias_map()
        text = str(row.get('score') or '').strip()
        m = re.search(r'(\d+)\s*[-:]\s*(\d+)', text)
        if not m:
            return ''
        hs, as_ = int(m.group(1)), int(m.group(2))
        home_team = str(row.get('home_team') or '').strip()
        away_team = str(row.get('away_team') or '').strip()
        is_home = any(team_names_match(marker, home_team, alias_map) for marker in team_markers)
        is_away = any(team_names_match(marker, away_team, alias_map) for marker in team_markers)
        if not is_home and not is_away:
            return ''
        gf, ga = (hs, as_) if is_home else (as_, hs)
        if gf > ga:
            return '胜'
        if gf == ga:
            return '平'
        return '负'

    def _describe_recent_form_state(self, results):
        seq = [str(x).strip() for x in (results or []) if str(x).strip() in {'胜', '平', '负'}]
        if not seq:
            return ''
        last3 = seq[-3:]
        if len(last3) == 3:
            if last3.count('负') == 3:
                return '状态下滑'
            if last3.count('胜') >= 2 and '负' not in last3:
                return '状态回暖'
        points_map = {'胜': 3, '平': 1, '负': 0}
        first_half = seq[:max(1, len(seq) // 2)]
        second_half = seq[max(1, len(seq) // 2):]
        first_avg = sum(points_map[x] for x in first_half) / len(first_half)
        second_avg = sum(points_map[x] for x in second_half) / len(second_half) if second_half else first_avg
        avg = sum(points_map[x] for x in seq) / len(seq)
        if second_avg >= first_avg + 0.8:
            return '状态回暖'
        if second_avg <= first_avg - 0.8:
            return '状态下滑'
        if avg >= 2.0:
            return '状态强势'
        if avg <= 1.0:
            return '状态偏弱'
        return '走势反复'

    def _format_last3_record(self, results):
        last3 = [x for x in (results or [])[-3:] if x in {'胜', '平', '负'}]
        if not last3:
            return ''
        parts = []
        if last3.count('胜'):
            parts.append(f"{last3.count('胜')}胜")
        if last3.count('平'):
            parts.append(f"{last3.count('平')}平")
        if last3.count('负'):
            parts.append(f"{last3.count('负')}负")
        return f"近3场{''.join(parts)}" if parts else ''

    def _count_non_league_fixtures(self, rows):
        tags = [str((row or {}).get('league_tag') or '').strip().upper() for row in (rows or []) if str((row or {}).get('league_tag') or '').strip()]
        if not tags:
            return 0
        dominant = max(set(tags), key=tags.count)
        return sum(1 for tag in tags if tag != dominant)

    def _build_standings_rank_map(self, standings_snapshot):
        alias_map = self._get_team_alias_map()
        rank_map = {}
        if isinstance(standings_snapshot, dict):
            items = standings_snapshot.items()
        elif isinstance(standings_snapshot, list):
            items = enumerate(standings_snapshot)
        else:
            return rank_map

        for key, value in items:
            if not isinstance(value, dict):
                continue
            team_name = str(
                value.get('team')
                or value.get('team_display')
                or value.get('name')
                or key
                or ''
            ).strip()
            if not team_name:
                continue
            rank_raw = value.get('rank')
            if rank_raw in (None, ''):
                rank_raw = value.get('rk')
            if rank_raw in (None, ''):
                rank_raw = (value.get('stats') or {}).get('rank') if isinstance(value.get('stats'), dict) else None
            try:
                rank = int(rank_raw)
            except Exception:
                continue
            canonical = canonicalize_team_name(team_name, alias_map) or team_name
            rank_map[canonical] = rank
            rank_map.setdefault(team_name, rank)
        return rank_map

    def _lookup_standings_rank(self, team_name, rank_map):
        team_name = str(team_name or '').strip()
        if not team_name or not rank_map:
            return None
        alias_map = self._get_team_alias_map()
        canonical = canonicalize_team_name(team_name, alias_map) or team_name
        candidates = [canonical, team_name]
        for candidate in candidates:
            if candidate in rank_map:
                return rank_map[candidate]
        for key, rank in rank_map.items():
            if team_names_match(team_name, key, alias_map):
                return rank
        return None

    def _build_recent_opponent_strength_note(self, rows, team_markers, standings_snapshot):
        rank_map = self._build_standings_rank_map(standings_snapshot)
        total_teams = len(rank_map)
        if not rank_map or total_teams < 6:
            return ""

        alias_map = self._get_team_alias_map()
        ranks = []
        for row in rows or []:
            home_team = str((row or {}).get('home_team') or '').strip()
            away_team = str((row or {}).get('away_team') or '').strip()
            if not home_team or not away_team:
                continue
            is_home = any(team_names_match(marker, home_team, alias_map) for marker in team_markers)
            is_away = any(team_names_match(marker, away_team, alias_map) for marker in team_markers)
            opponent = away_team if is_home else home_team if is_away else ""
            if not opponent:
                continue
            rank = self._lookup_standings_rank(opponent, rank_map)
            if rank is not None:
                ranks.append(rank)

        if len(ranks) < 3:
            return ""

        strong_limit = max(4, int(math.ceil(total_teams * 0.25)))
        weak_limit = max(total_teams - 3, int(math.ceil(total_teams * 0.75)))
        strong_count = sum(1 for rank in ranks if rank <= strong_limit)
        weak_count = sum(1 for rank in ranks if rank >= weak_limit)
        avg_rank = sum(ranks) / len(ranks)
        weak_tail = max(1, total_teams - weak_limit + 1)

        if strong_count >= 3 and strong_count >= weak_count:
            return f"对手偏强（{strong_count}战前{strong_limit}）"
        if weak_count >= 3 and weak_count > strong_count:
            return f"对手偏弱（{weak_count}战后{weak_tail}）"
        if avg_rank <= strong_limit + 1:
            return f"对手偏强（均值{avg_rank:.1f}）"
        if avg_rank >= weak_limit - 1:
            return f"对手偏弱（均值{avg_rank:.1f}）"
        return "对手强弱均衡"

    def _build_side_recent_form_summary(self, rows, team_markers, prefix, standings_snapshot=None):
        parsed_rows = [self._parse_recent_form_row(item) for item in list(rows or [])[:6]]
        dated = []
        undated = []
        for idx, row in enumerate(parsed_rows):
            dt = self._parse_recent_form_date(row.get('date'))
            if dt is None:
                undated.append((idx, row))
            else:
                dated.append((dt, idx, row))
        if dated and not undated:
            ordered_rows = [row for _, _, row in sorted(dated, key=lambda x: (x[0], x[1]))]
        else:
            ordered_rows = parsed_rows

        results = []
        used_rows = []
        for row in ordered_rows:
            result = self._recent_result_for_row(row, team_markers)
            if result:
                results.append(result)
                used_rows.append(row)
        if not results:
            return ''

        parts = [f"{prefix}近{len(results)}场{''.join(results)}"]
        last3_record = self._format_last3_record(results)
        if last3_record:
            parts.append(last3_record)
        state = self._describe_recent_form_state(results)
        if state:
            parts.append(state)
        non_league = self._count_non_league_fixtures(used_rows)
        if non_league >= 2:
            parts.append(f"含{non_league}场非联赛")
        opponent_strength = self._build_recent_opponent_strength_note(used_rows, team_markers, standings_snapshot)
        if opponent_strength:
            parts.append(opponent_strength)
        return '，'.join(parts)

    def _build_recent_form_summary(self, history, match_info_extra, standings_snapshot=None):
        home_summary = self._build_side_recent_form_summary(
            self._recent_history_rows(history, 'home'),
            self._recent_team_markers(match_info_extra, 'home'),
            '主',
            standings_snapshot=standings_snapshot,
        )
        away_summary = self._build_side_recent_form_summary(
            self._recent_history_rows(history, 'away'),
            self._recent_team_markers(match_info_extra, 'away'),
            '客',
            standings_snapshot=standings_snapshot,
        )
        return '；'.join([x for x in [home_summary, away_summary] if x])

    def _technical_ou25_snapshot(self, technical_stats_context):
        technical = technical_stats_context or {}
        candidates = [
            ((technical.get('overall') or {}).get('all') or {}, '赛季'),
            ((technical.get('overall') or {}).get('league') or {}, '联赛'),
            ((technical.get('home_away') or {}).get('all') or {}, '主客场'),
            ((technical.get('home_away') or {}).get('league') or {}, '联赛主客场'),
        ]
        for block, label in candidates:
            home = block.get('home') or {}
            away = block.get('away') or {}
            try:
                hp = float(home.get('played', 0) or 0)
                ap = float(away.get('played', 0) or 0)
                ho = float(home.get('over_2_5', 0) or 0)
                ao = float(away.get('over_2_5', 0) or 0)
                hu = float(home.get('under_2_5', 0) or 0)
                au = float(away.get('under_2_5', 0) or 0)
                hgf = float(home.get('goals_for_per_game', 0) or 0)
                hga = float(home.get('goals_against_per_game', 0) or 0)
                agf = float(away.get('goals_for_per_game', 0) or 0)
                aga = float(away.get('goals_against_per_game', 0) or 0)
            except Exception:
                continue
            if hp > 0 and ap > 0:
                return {
                    'label': label,
                    'home_over25': ho / hp,
                    'away_over25': ao / ap,
                    'home_under25': hu / hp,
                    'away_under25': au / ap,
                    'avg_total_goals': ((hgf + hga) + (agf + aga)) / 2.0,
                }
        return {}

    def _build_ou_path_summary(self, poisson_data, technical_stats_context=None):
        poisson_data = poisson_data or {}
        technical = self._technical_ou25_snapshot(technical_stats_context or {})
        try:
            lam_h = float(poisson_data.get('lh', 0) or 0)
            lam_a = float(poisson_data.get('la', 0) or 0)
        except Exception:
            lam_h = lam_a = 0.0
        lam_total = lam_h + lam_a
        ou_probs = self._calc_ou25_probs_from_poisson(lam_h, lam_a) if lam_total > 0 else {"大球": 0.0, "小球": 0.0}

        score_picks = []
        for item in (poisson_data.get('scores') or [])[:3]:
            if not isinstance(item, dict):
                continue
            score = str(item.get('score') or '').strip()
            if score:
                score_picks.append(score)
        high_scores = []
        low_scores = []
        for score in score_picks:
            m = re.search(r'(\d+)\s*[:\-]\s*(\d+)', score)
            if not m:
                continue
            total = int(m.group(1)) + int(m.group(2))
            if total >= 3:
                high_scores.append(score)
            else:
                low_scores.append(score)

        over_signals = 0
        under_signals = 0
        parts = []

        avg_over25 = avg_under25 = avg_total_goals = 0.0
        if technical:
            avg_over25 = ((technical.get('home_over25') or 0.0) + (technical.get('away_over25') or 0.0)) / 2.0
            avg_under25 = ((technical.get('home_under25') or 0.0) + (technical.get('away_under25') or 0.0)) / 2.0
            avg_total_goals = float(technical.get('avg_total_goals') or 0.0)
            if avg_over25 >= 0.56:
                parts.append("技术面大2.5占比偏高")
                over_signals += 1
            elif avg_under25 >= 0.56:
                parts.append("技术面小2.5占比偏高")
                under_signals += 1

        if lam_total > 0:
            parts.append(f"泊松总进球{lam_total:.1f}")
            if lam_total >= 2.75:
                over_signals += 1
            elif lam_total <= 2.35:
                under_signals += 1
        elif avg_total_goals > 0:
            parts.append(f"总进球中枢{avg_total_goals:.1f}")
            if avg_total_goals >= 2.75:
                over_signals += 1
            elif avg_total_goals <= 2.35:
                under_signals += 1

        if ou_probs.get("大球", 0) >= 0.57:
            over_signals += 1
        elif ou_probs.get("小球", 0) >= 0.57:
            under_signals += 1

        if len(high_scores) >= 2:
            parts.append(f"高比分集中在{'/'.join(high_scores[:2])}")
            over_signals += 1
        elif len(low_scores) >= 2:
            parts.append(f"低比分集中在{'/'.join(low_scores[:2])}")
            under_signals += 1

        if over_signals > under_signals:
            parts.append("进球预期偏大")
        elif under_signals > over_signals:
            parts.append("进球预期偏小")
        elif parts:
            parts.append("进球预期均衡")

        dedup = []
        seen = set()
        for item in parts:
            if item and item not in seen:
                seen.add(item)
                dedup.append(item)
        return "，".join(dedup[:4])

    def _wdl_pick_from_stats(self, spf_stats):
        best_label = ""
        best_pct = -1.0
        mapping = {'胜': '主胜', '平': '平局', '负': '客胜'}
        for item in (spf_stats or []):
            if not isinstance(item, dict):
                continue
            label = mapping.get(str(item.get('result') or '').strip())
            if not label:
                continue
            try:
                pct = float(item.get('pct', 0) or 0)
            except Exception:
                pct = 0.0
            if pct > best_pct:
                best_label = label
                best_pct = pct
        return best_label, best_pct

    def _build_score_path_summary(self, best_bet, spf_stats, poisson_data):
        poisson_data = poisson_data or {}
        direction = ""
        if best_bet and str(best_bet.get('kind') or '').lower() == 'spf':
            sel = str(best_bet.get('sel') or '').strip()
            direction = {'胜': '主胜', '平': '平局', '负': '客胜'}.get(sel, '')
        if not direction:
            direction, _ = self._wdl_pick_from_stats(spf_stats)

        try:
            lam_h = float(poisson_data.get('lh', 0) or 0)
            lam_a = float(poisson_data.get('la', 0) or 0)
        except Exception:
            lam_h = lam_a = 0.0
        ou_probs = self._calc_ou25_probs_from_poisson(lam_h, lam_a) if (lam_h + lam_a) > 0 else {"大球": 0.0, "小球": 0.0}
        ou_label = "大球" if ou_probs.get("大球", 0) >= ou_probs.get("小球", 0) else "小球"

        score_rows = []
        for item in (poisson_data.get('scores') or [])[:3]:
            if not isinstance(item, dict):
                continue
            score = str(item.get('score') or '').strip()
            if score:
                score_rows.append(score)

        notes = []
        prefix = f"{direction}+{ou_label}路径" if direction else f"{ou_label}路径"
        notes.append(prefix)

        if direction:
            _, best_pct = self._wdl_pick_from_stats(spf_stats)
            if best_pct > 0:
                if direction == '主胜':
                    notes.append("主胜概率领先")
                elif direction == '客胜':
                    notes.append("客胜概率领先")
                elif direction == '平局':
                    notes.append("平局概率最高")

        if score_rows:
            notes.append(f"比分集中在{'/'.join(score_rows[:2])}")

        margin_note = ""
        for score in score_rows:
            m = re.search(r'(\d+)\s*[:\-]\s*(\d+)', score)
            if not m:
                continue
            hs, as_ = int(m.group(1)), int(m.group(2))
            if direction == '主胜' and hs > as_:
                if hs - as_ == 1:
                    margin_note = "主队一球胜更常见"
                    break
                margin_note = "主队赢面更偏两球以上"
            elif direction == '客胜' and as_ > hs:
                if as_ - hs == 1:
                    margin_note = "客队一球胜更常见"
                    break
                margin_note = "客队赢面更偏两球以上"
            elif direction == '平局' and hs == as_:
                margin_note = "平局比分更集中"
                break
        if margin_note:
            notes.append(margin_note)

        dedup = []
        seen = set()
        for item in notes:
            if item and item not in seen:
                seen.add(item)
                dedup.append(item)
        return "，".join(dedup[:4])

    def _build_market_consensus_summary(self, odds_data, bifa_summary=None, pankou_summary=None):
        odds_data = odds_data or {}
        bifa_summary = bifa_summary or {}
        pankou_summary = pankou_summary or {}

        def side_label(key):
            return {"h": "主胜", "d": "平局", "a": "客胜"}.get(key, "")

        def safe_float(value):
            try:
                if value is None:
                    return None
                val = float(value)
                if math.isnan(val) or val <= 0:
                    return None
                return val
            except Exception:
                return None

        notes = []
        scores = {"h": 0.0, "d": 0.0, "a": 0.0}

        curr = {
            "h": safe_float(odds_data.get("sw")),
            "d": safe_float(odds_data.get("sd")),
            "a": safe_float(odds_data.get("sl")),
        }
        valid_curr = {k: v for k, v in curr.items() if v}
        if valid_curr:
            eu_pick = min(valid_curr, key=valid_curr.get)
            notes.append(f"欧赔偏{side_label(eu_pick)}")
            scores[eu_pick] += 1.0

        init = {
            "h": safe_float(odds_data.get("sw_init")),
            "d": safe_float(odds_data.get("sd_init")),
            "a": safe_float(odds_data.get("sl_init")),
        }
        deltas = {}
        for key in ("h", "d", "a"):
            if init.get(key) and curr.get(key):
                deltas[key] = (curr[key] - init[key]) / init[key]
        down_candidates = [(key, delta) for key, delta in deltas.items() if delta <= -0.02]
        if down_candidates:
            move_pick, move_delta = min(down_candidates, key=lambda item: item[1])
            notes.append(f"{side_label(move_pick)}降赔")
            scores[move_pick] += 0.8

        asian_text = ""
        asian_vote = ""
        for book_key in ("pb", "mac"):
            book = pankou_summary.get(book_key) or {}
            try:
                init_line = float(book.get("init_line"))
                curr_line = float(book.get("curr_line"))
                init_water = float(book.get("init_water"))
                curr_water = float(book.get("curr_water"))
            except Exception:
                continue
            if curr_line <= init_line - 0.45:
                asian_text = "亚盘更挺主队"
                asian_vote = "h"
            elif curr_line >= init_line + 0.45:
                asian_text = "亚盘更防客队"
                asian_vote = "a"
            elif curr_water <= init_water - 0.03:
                asian_text = "亚盘更挺主队"
                asian_vote = "h"
            elif curr_water >= init_water + 0.03:
                asian_text = "亚盘更防客队"
                asian_vote = "a"
            if asian_text:
                break
        if asian_text:
            notes.append(asian_text)
            scores[asian_vote] += 1.0

        vol = bifa_summary.get("vol") or {}
        try:
            raw_share = {
                "h": float(vol.get("h", 0) or 0),
                "d": float(vol.get("d", 0) or 0),
                "a": float(vol.get("a", 0) or 0),
            }
        except Exception:
            raw_share = {}
        total_share = sum(raw_share.values()) if raw_share else 0.0
        if total_share > 1.5:
            share = {k: (v / total_share) for k, v in raw_share.items()}
        else:
            share = raw_share
        valid_share = {k: v for k, v in share.items() if v > 0}
        if valid_share:
            top_key = max(valid_share, key=valid_share.get)
            top_val = valid_share[top_key]
            second_val = sorted(valid_share.values(), reverse=True)[1] if len(valid_share) > 1 else 0.0
            if top_val >= 0.45 and top_val - second_val >= 0.08:
                notes.append(f"必发资金偏{side_label(top_key)}")
                scores[top_key] += 1.0

        home_score = scores["h"]
        away_score = scores["a"]
        draw_score = scores["d"]
        final_text = ""
        if home_score >= 2.2 and home_score >= away_score + 1.0 and home_score >= draw_score + 1.0:
            final_text = "市场整体偏主队不败，偏主胜"
        elif away_score >= 2.2 and away_score >= home_score + 1.0 and away_score >= draw_score + 1.0:
            final_text = "市场整体偏客队不败，偏客胜"
        elif draw_score >= 1.8 and draw_score >= home_score + 0.6 and draw_score >= away_score + 0.6:
            final_text = "市场防平倾向明显"
        elif home_score >= 1.6 and away_score == 0 and draw_score == 0:
            final_text = "市场略偏主队"
        elif away_score >= 1.6 and home_score == 0 and draw_score == 0:
            final_text = "市场略偏客队"
        elif home_score > 0 and away_score > 0:
            final_text = "市场意见分歧"

        parts = []
        seen = set()
        for item in notes:
            if item and item not in seen:
                seen.add(item)
                parts.append(item)
        if final_text:
            parts.append(final_text)
        return "；".join(parts)

    def _build_market_heat_warning(self, odds_data, bifa_summary=None, pankou_summary=None):
        odds_data = odds_data or {}
        bifa_summary = bifa_summary or {}
        pankou_summary = pankou_summary or {}

        def safe_float(value):
            try:
                if value is None:
                    return None
                val = float(value)
                if math.isnan(val) or val <= 0:
                    return None
                return val
            except Exception:
                return None

        curr = {
            "h": safe_float(odds_data.get("sw")),
            "d": safe_float(odds_data.get("sd")),
            "a": safe_float(odds_data.get("sl")),
        }
        init = {
            "h": safe_float(odds_data.get("sw_init")),
            "d": safe_float(odds_data.get("sd_init")),
            "a": safe_float(odds_data.get("sl_init")),
        }
        valid_curr = {k: v for k, v in curr.items() if v}
        if not valid_curr:
            return ""
        fav_key = min(valid_curr, key=valid_curr.get)
        fav_odds = valid_curr.get(fav_key) or 0.0
        if fav_key not in {"h", "a"} or fav_odds >= 1.7:
            return ""

        fav_label = "主胜" if fav_key == "h" else "客胜"
        move_parts = [f"{fav_label}低赔"]
        rise_flag = False
        if init.get(fav_key) and curr.get(fav_key):
            delta = (curr[fav_key] - init[fav_key]) / init[fav_key]
            if delta >= 0.03:
                move_parts.append("持续升赔")
                rise_flag = True
        if not rise_flag:
            return ""

        notes = ["".join(move_parts)]

        vol = bifa_summary.get("vol") or {}
        try:
            fav_share = float(vol.get(fav_key, 0) or 0)
        except Exception:
            fav_share = 0.0
        top_key = ""
        top_share = 0.0
        valid_share = {}
        for key in ("h", "d", "a"):
            try:
                val = float(vol.get(key, 0) or 0)
            except Exception:
                val = 0.0
            if val > 0:
                valid_share[key] = val
        if valid_share:
            total_share = sum(valid_share.values())
            if total_share > 1.5:
                valid_share = {k: v / total_share for k, v in valid_share.items()}
            top_key = max(valid_share, key=valid_share.get)
            top_share = valid_share.get(top_key, 0.0)
            fav_share = valid_share.get(fav_key, fav_share)
        bifa_mismatch = bool(valid_share) and (top_key != fav_key or fav_share < 0.45)
        if bifa_mismatch:
            notes.append(f"必发未跟{'主队' if fav_key == 'h' else '客队'}")

        asian_bias = ""
        for book_key in ("pb", "mac"):
            book = pankou_summary.get(book_key) or {}
            try:
                init_line = float(book.get("init_line"))
                curr_line = float(book.get("curr_line"))
                init_water = float(book.get("init_water"))
                curr_water = float(book.get("curr_water"))
            except Exception:
                continue
            if curr_line <= init_line - 0.45 or curr_water <= init_water - 0.03:
                asian_bias = "h"
            elif curr_line >= init_line + 0.45 or curr_water >= init_water + 0.03:
                asian_bias = "a"
            if asian_bias:
                break
        asian_mismatch = asian_bias and asian_bias != fav_key
        if asian_mismatch:
            notes.append("盘口不配合")

        if not bifa_mismatch and not asian_mismatch:
            return ""

        notes.append("热门偏虚")
        return "，".join(notes)

    def _build_draw_warning(self, odds_data, poisson_data=None):
        odds_data = odds_data or {}
        poisson_data = poisson_data or {}

        def safe_float(value):
            try:
                if value is None:
                    return None
                val = float(value)
                if math.isnan(val) or val <= 0:
                    return None
                return val
            except Exception:
                return None

        sw = safe_float(odds_data.get("sw"))
        sd = safe_float(odds_data.get("sd"))
        sl = safe_float(odds_data.get("sl"))
        sd_init = safe_float(odds_data.get("sd_init"))

        notes = []
        draw_signal = 0
        if sd and sw and sl and sd <= min(sw, sl) + 0.55:
            notes.append("平赔压低")
            draw_signal += 1
        if sd and sd_init:
            delta_d = abs(sd - sd_init) / sd_init
            if delta_d <= 0.03:
                if notes and notes[-1] == "平赔压低":
                    notes[-1] = "平赔压低且变化平稳"
                else:
                    notes.append("平赔变化平稳")
                draw_signal += 1

        try:
            lam_h = float(poisson_data.get("lh", 0) or 0)
            lam_a = float(poisson_data.get("la", 0) or 0)
        except Exception:
            lam_h = lam_a = 0.0
        if lam_h > 0 and lam_a > 0 and abs(lam_h - lam_a) <= 0.18:
            notes.append("泊松均势")
            draw_signal += 1

        low_scores = []
        for item in (poisson_data.get("scores") or [])[:3]:
            if not isinstance(item, dict):
                continue
            score = str(item.get("score") or "").strip()
            if not score:
                continue
            m = re.search(r'(\d+)\s*[:\-]\s*(\d+)', score)
            if not m:
                continue
            total = int(m.group(1)) + int(m.group(2))
            if total <= 2:
                low_scores.append(score)
        if len(low_scores) >= 2:
            notes.append(f"低比分集中在{'/'.join(low_scores[:2])}")
            draw_signal += 1

        if draw_signal < 2:
            return ""
        notes.append("防平价值高")

        dedup = []
        seen = set()
        for item in notes:
            if item and item not in seen:
                seen.add(item)
                dedup.append(item)
        return "，".join(dedup[:4])

    def _parse_logged_match_result(self, score_text):
        text = str(score_text or "").strip()
        if ":" not in text:
            return ""
        left, right = text.split(":", 1)
        try:
            home_goals = int(str(left).strip())
            away_goals = int(str(right).strip())
        except Exception:
            return ""
        if home_goals > away_goals:
            return "胜"
        if home_goals == away_goals:
            return "平"
        return "负"

    def _summarize_replay_calibration_frame(self, spf_df):
        spf_df = spf_df.copy()
        if spf_df.empty:
            return {}

        stats = {
            "overall_hit_rate": float(spf_df["hit"].mean()),
            "sample_size": int(len(spf_df)),
        }

        hot_df = spf_df[
            spf_df["Main_Warn"].str.contains("超级大热|赔率异常", regex=True, na=False)
        ]
        if not hot_df.empty:
            stats["hot_favorite"] = {
                "count": int(len(hot_df)),
                "hit_rate": float(hot_df["hit"].mean()),
            }

        balanced_df = spf_df[spf_df["Main_Warn"].str.contains("均势局", regex=False, na=False)]
        if not balanced_df.empty:
            stats["balanced_draw"] = {
                "count": int(len(balanced_df)),
                "draw_rate": float((balanced_df["actual_result"] == "平").mean()),
                "hit_rate": float(balanced_df["hit"].mean()),
            }

        high_df = spf_df[spf_df["SPF_Dyn_Band"] == "high"]
        if not high_df.empty:
            stats["high_risk_band"] = {
                "count": int(len(high_df)),
                "hit_rate": float(high_df["hit"].mean()),
            }
        return stats

    def _normalize_spf_result_label(self, value):
        text = str(value or "").strip()
        if not text or text in {"-", "nan", "None"}:
            return ""
        mapping = {
            "主胜": "胜",
            "平局": "平",
            "客胜": "负",
            "胜": "胜",
            "平": "平",
            "负": "负",
        }
        return mapping.get(text, "")

    def _summarize_replay_attribution_frame(self, spf_df):
        spf_df = spf_df.copy()
        if spf_df.empty:
            return {}

        stats = {
            "overall_hit_rate": float(spf_df["hit"].mean()),
            "sample_size": int(len(spf_df)),
            "miss_count": int((~spf_df["hit"]).sum()),
        }

        miss_df = spf_df[~spf_df["hit"]].copy()
        if miss_df.empty:
            return stats

        miss_total = max(int(len(miss_df)), 1)

        def add_cluster(key, subset):
            if subset.empty:
                return
            count = int(len(subset))
            stats[key] = {
                "count": count,
                "share": float(count / miss_total),
            }

        hot_df = miss_df[
            miss_df["Main_Warn"].str.contains("超级大热|赔率异常|混乱|大热", regex=True, na=False)
        ]
        add_cluster("hot_miss", hot_df)

        draw_df = miss_df[miss_df["actual_result"] == "平"]
        add_cluster("draw_miss", draw_df)

        conflict_df = miss_df[
            miss_df["Score_Trace"].str.contains(
                "euro_asia|欧亚风控|spf_soft|asia_risk|joint_veto",
                regex=True,
                na=False,
                case=False,
            )
        ]
        add_cluster("conflict_miss", conflict_df)

        return stats

    def _extract_match_league_name(self, match_info_extra=None):
        match_info_extra = match_info_extra or {}
        for key in ("league", "league_name", "lg", "competition"):
            value = str(match_info_extra.get(key) or "").strip()
            if value:
                return value
        return ""

    def _load_replay_attribution_stats(self, history_file=FULL_LOG_FILE, recent_rows=240):
        history_file = os.path.abspath(history_file or FULL_LOG_FILE)
        cache_key = getattr(self, "_replay_attribution_cache_key", None)
        cache_value = getattr(self, "_replay_attribution_cache_value", None)
        try:
            stat = os.stat(history_file)
            file_key = (history_file, int(stat.st_mtime), int(stat.st_size), int(recent_rows or 0))
        except Exception:
            return {}
        if cache_key == file_key and isinstance(cache_value, dict):
            return cache_value

        wanted_cols = {"League", "Final_Sel", "Best_SPF", "Main_Warn", "Score_Trace", "比分", "Final_Kind"}
        try:
            df = pd.read_excel(
                history_file,
                usecols=lambda col: str(col).strip() in wanted_cols,
            )
        except Exception:
            return {}
        if recent_rows and len(df) > int(recent_rows):
            df = df.tail(int(recent_rows)).copy()
        if df.empty:
            return {}

        for col in wanted_cols:
            if col not in df.columns:
                df[col] = ""

        df["League"] = df["League"].fillna("").astype(str).str.strip()
        df["Final_Sel"] = df["Final_Sel"].fillna("").astype(str).str.strip()
        df["Best_SPF"] = df["Best_SPF"].fillna("").astype(str).str.strip()
        df["Main_Warn"] = df["Main_Warn"].fillna("").astype(str).str.strip()
        df["Score_Trace"] = df["Score_Trace"].fillna("").astype(str).str.strip()
        df["比分"] = df["比分"].fillna("").astype(str).str.strip()
        df["Final_Kind"] = df["Final_Kind"].fillna("").astype(str).str.strip().str.lower()
        df["predicted_result"] = df["Final_Sel"].map(self._normalize_spf_result_label)
        fallback = df["Best_SPF"].map(self._normalize_spf_result_label)
        df.loc[df["predicted_result"] == "", "predicted_result"] = fallback
        df["actual_result"] = df["比分"].map(self._parse_logged_match_result)

        spf_df = df[
            df["predicted_result"].isin(["胜", "平", "负"]) &
            df["actual_result"].isin(["胜", "平", "负"])
        ].copy()
        if spf_df.empty:
            return {}
        spf_df["hit"] = spf_df["predicted_result"] == spf_df["actual_result"]

        stats = self._summarize_replay_attribution_frame(spf_df)
        stats["by_league"] = {}
        for league_name, league_df in spf_df.groupby("League"):
            league_name = str(league_name or "").strip()
            if not league_name:
                continue
            league_stats = self._summarize_replay_attribution_frame(league_df)
            if league_stats:
                stats["by_league"][league_name] = league_stats

        self._replay_attribution_cache_key = file_key
        self._replay_attribution_cache_value = stats
        return stats

    def _build_replay_attribution_brief(self, match_info_extra=None, attribution_stats=None):
        attribution_stats = attribution_stats or self._load_replay_attribution_stats()
        if not attribution_stats:
            return ""

        target_league = self._extract_match_league_name(match_info_extra)
        league_stats_map = attribution_stats.get("by_league") or {}
        league_stats = league_stats_map.get(target_league) or {} if target_league else {}

        baseline_source = attribution_stats
        baseline_prefix = ""
        if target_league and int(league_stats.get("sample_size") or 0) >= 40:
            baseline_source = league_stats
            baseline_prefix = f"{target_league}"

        source_stats = baseline_source
        source_prefix = baseline_prefix
        if source_stats is attribution_stats:
            source_prefix = ""

        notes = []
        overall_size = int(source_stats.get("sample_size") or 0)
        overall_hit_rate = float(source_stats.get("overall_hit_rate") or 0)
        if overall_size >= 40 and overall_hit_rate > 0:
            notes.append(f"{source_prefix}近期回看：近{overall_size}单命中{overall_hit_rate:.0%}")
        elif overall_size >= 20 and overall_hit_rate > 0:
            notes.append(f"近期回看：近{overall_size}单命中{overall_hit_rate:.0%}")

        miss_items = []
        for category_name, label, min_count in (
            ("hot_miss", "假热", 8),
            ("draw_miss", "防平", 6),
            ("conflict_miss", "欧亚冲突", 5),
        ):
            category_stats = source_stats.get(category_name) or {}
            if not isinstance(category_stats, dict):
                continue
            count = int(category_stats.get("count") or 0)
            share = float(category_stats.get("share") or 0)
            if count < int(min_count) or share <= 0:
                continue
            miss_items.append({
                "label": label,
                "count": count,
                "share": share,
            })

        if miss_items:
            miss_items.sort(key=lambda item: (-float(item.get("share") or 0), -int(item.get("count") or 0)))
            tags = [item["label"] for item in miss_items[:2] if item.get("label")]
            if tags:
                notes.append("错因偏" + "、".join(tags))

        if not notes:
            return ""
        return "复盘归因：" + "；".join(notes[:2])

    def _classify_decision_level(
        self,
        final_pick=None,
        rec_score=0.0,
        ess=0.0,
        warn="",
        market_heat_warning="",
        draw_warning="",
        replay_attribution_brief="",
        quality_veto_reason="",
    ):
        if not isinstance(final_pick, dict) or not final_pick:
            veto_text = str(quality_veto_reason or "").strip()
            if veto_text:
                if "联赛风控" in veto_text:
                    return {
                        "label": "联赛屏蔽",
                        "badge_text": "🚫 联赛屏蔽",
                        "style": "border:1px solid #d9d9d9;color:#666;background:#f5f5f5",
                        "reason": veto_text,
                    }
                if "EV不足" in veto_text:
                    return {
                        "label": "回避EV",
                        "badge_text": "🧮 回避EV",
                        "style": "border:1px solid #ffd591;color:#ad4e00;background:#fff7e6",
                        "reason": veto_text,
                    }
                return {
                    "label": "回避风控",
                    "badge_text": "🛡️ 回避风控",
                    "style": "border:1px solid #ffccc7;color:#a8071a;background:#fff1f0",
                    "reason": veto_text,
                }
            return {
                "label": "无推荐",
                "badge_text": "⏸️ 无推荐",
                "style": "border:1px solid #d9d9d9;color:#666;background:#f5f5f5",
                "reason": "暂无有效推荐",
            }

        try:
            odds = float(final_pick.get("odds", 0) or 0)
        except Exception:
            odds = 0.0
        try:
            score = float(rec_score or 0)
        except Exception:
            score = 0.0
        try:
            ess_value = float(ess or 0)
        except Exception:
            ess_value = 0.0

        warn_text = str(warn or "").strip()
        market_warning_text = str(market_heat_warning or "").strip()
        draw_warning_text = str(draw_warning or "").strip()
        replay_text = str(replay_attribution_brief or "").strip()

        conflict_flags = 0
        if any(x in warn_text for x in ["混乱", "观察", "分歧"]):
            conflict_flags += 1
        if market_warning_text:
            conflict_flags += 1
        if draw_warning_text:
            conflict_flags += 1
        if any(x in replay_text for x in ["欧亚冲突", "假热"]):
            conflict_flags += 1

        if conflict_flags >= 2:
            return {
                "label": "分歧",
                "badge_text": "⚖️ 分歧",
                "style": "border:1px solid #ffe58f;color:#ad6800;background:#fffbe6",
                "reason": "信号冲突偏多",
            }

        if score >= 7.0 and ess_value >= 15.0 and odds >= 1.70:
            return {
                "label": "稳胆",
                "badge_text": "💎 稳胆",
                "style": "border:1px solid #95de64;color:#237804;background:#f6ffed",
                "reason": "评分高且赔率达标",
            }

        if score >= 5.0 and ess_value >= 12.0:
            low_odds_note = "，低赔不列稳胆" if 0 < odds < 1.70 else ""
            return {
                "label": "可博",
                "badge_text": "🎯 可博",
                "style": "border:1px solid #91d5ff;color:#0958d9;background:#e6f4ff",
                "reason": f"综合分可用{low_odds_note}",
            }

        if score >= 3.0:
            return {
                "label": "分歧",
                "badge_text": "⚖️ 分歧",
                "style": "border:1px solid #ffe58f;color:#ad6800;background:#fffbe6",
                "reason": "有方向但把握一般",
            }

        return {
            "label": "回避风控",
            "badge_text": "🛡️ 回避风控",
            "style": "border:1px solid #ffccc7;color:#a8071a;background:#fff1f0",
            "reason": "分数不足，回避参与",
        }

    def _classify_llm_decision_level(
        self,
        candidate=None,
        market_heat_warning="",
        draw_warning="",
        replay_attribution_brief="",
    ):
        candidate = candidate or {}
        if not isinstance(candidate, dict) or not candidate:
            return {
                "label": "放弃",
                "badge_text": "⏸️ 放弃",
                "reason": "暂无明确方向",
            }

        try:
            odds = float(candidate.get("odds", 0) or 0)
        except Exception:
            odds = 0.0
        try:
            prob = float(candidate.get("prob", 0) or 0)
        except Exception:
            prob = 0.0

        conflict_flags = 0
        if str(market_heat_warning or "").strip():
            conflict_flags += 1
        if str(draw_warning or "").strip():
            conflict_flags += 1
        if any(x in str(replay_attribution_brief or "") for x in ["欧亚冲突", "假热"]):
            conflict_flags += 1

        if conflict_flags >= 2:
            return {
                "label": "分歧",
                "badge_text": "⚖️ 分歧",
                "reason": "风险提示偏多",
            }

        if odds >= 1.70 and prob >= 0.60:
            return {
                "label": "稳胆",
                "badge_text": "💎 稳胆",
                "reason": "赔率达标且方向更稳",
            }

        if odds > 0:
            if odds < 1.70:
                return {
                    "label": "可博",
                    "badge_text": "🎯 可博",
                    "reason": "低赔不列稳胆",
                }
            return {
                "label": "可博",
                "badge_text": "🎯 可博",
                "reason": "综合分可用，方向明确",
            }

        return {
            "label": "放弃",
            "badge_text": "⏸️ 放弃",
            "reason": "赔率信息不足",
        }

    def _single_card_pass(self, item):
        bb = (item or {}).get('best_bet') or {}
        if not bb or bb.get('sel') not in ['胜', '平', '负']:
            return False
        try:
            odds = float(bb.get('odds', 0) or 0)
            prob = float(bb.get('prob', 0) or 0)
        except Exception:
            return False
        if odds <= 0 or prob <= 0:
            return False
        ev = odds * prob
        return odds >= SINGLE_CARD_MIN_ODDS and ev >= SINGLE_CARD_MIN_EV

    def _single_card_decision_priority(self, item):
        label = str(((item or {}).get("decision_level") or {}).get("label") or "").strip()
        return {
            "稳胆": 0,
            "可博": 1,
            "分歧": 2,
            "回避EV": 3,
            "回避风控": 4,
            "联赛屏蔽": 5,
            "无推荐": 6,
            "放弃": 6,
        }.get(label, 4)

    def _select_top_single_cards(self, results, limit=3):
        ranked = []
        for item in (results or []):
            if float(item.get('score', 0) or 0) <= 0:
                continue
            if not self._single_card_pass(item):
                continue
            level = str(((item or {}).get("decision_level") or {}).get("label") or "").strip()
            if level not in {"稳胆", "可博"}:
                continue
            ranked.append(item)
        ranked.sort(
            key=lambda item: (
                self._single_card_decision_priority(item),
                -float(item.get('score', 0) or 0),
                -float((((item or {}).get('best_bet') or {}).get('prob', 0) or 0)),
            )
        )
        return ranked[: max(0, int(limit or 0))]

    def _select_low_priority_single_cards(self, results, limit=6):
        ranked = []
        for item in (results or []):
            if float(item.get('score', 0) or 0) <= 0:
                continue
            level = str(((item or {}).get("decision_level") or {}).get("label") or "").strip()
            bb = (item or {}).get('best_bet') or {}
            if bb and bb.get('sel') not in ['胜', '平', '负']:
                continue
            if level in {"分歧", "回避EV", "回避风控", "联赛屏蔽", "无推荐", "放弃"}:
                ranked.append(item)
                continue
            if level in {"稳胆", "可博"} and not self._single_card_pass(item):
                ranked.append(item)
                continue
        ranked.sort(
            key=lambda item: (
                self._single_card_decision_priority(item),
                -float(item.get('score', 0) or 0),
            )
        )
        return ranked[: max(0, int(limit or 0))]

    def _load_replay_calibration_stats(self, history_file=FULL_LOG_FILE, recent_rows=240):
        history_file = os.path.abspath(history_file or FULL_LOG_FILE)
        cache_key = getattr(self, "_replay_calibration_cache_key", None)
        cache_value = getattr(self, "_replay_calibration_cache_value", None)
        try:
            stat = os.stat(history_file)
            file_key = (history_file, int(stat.st_mtime), int(stat.st_size), int(recent_rows or 0))
        except Exception:
            return {}
        if cache_key == file_key and isinstance(cache_value, dict):
            return cache_value

        try:
            df = pd.read_excel(
                history_file,
                usecols=["League", "Best_SPF", "Main_Warn", "SPF_Dyn_Band", "比分"],
            )
        except Exception:
            return {}
        if recent_rows and len(df) > int(recent_rows):
            df = df.tail(int(recent_rows)).copy()
        if df.empty:
            return {}

        df["Best_SPF"] = df["Best_SPF"].fillna("").astype(str).str.strip()
        df["League"] = df["League"].fillna("").astype(str).str.strip()
        df["Main_Warn"] = df["Main_Warn"].fillna("").astype(str).str.strip()
        df["SPF_Dyn_Band"] = df["SPF_Dyn_Band"].fillna("").astype(str).str.strip().str.lower()
        df["actual_result"] = df["比分"].map(self._parse_logged_match_result)
        spf_df = df[df["Best_SPF"].isin(["胜", "平", "负"]) & df["actual_result"].isin(["胜", "平", "负"])].copy()
        if spf_df.empty:
            return {}
        spf_df["hit"] = spf_df["Best_SPF"] == spf_df["actual_result"]

        stats = self._summarize_replay_calibration_frame(spf_df)
        stats["by_league"] = {}
        for league_name, league_df in spf_df.groupby("League"):
            league_name = str(league_name or "").strip()
            if not league_name:
                continue
            league_stats = self._summarize_replay_calibration_frame(league_df)
            if league_stats:
                stats["by_league"][league_name] = league_stats

        self._replay_calibration_cache_key = file_key
        self._replay_calibration_cache_value = stats
        return stats

    def _build_calibration_brief(self, market_heat_warning="", draw_warning="", match_info_extra=None, calibration_stats=None, suppress_overlap=False):
        calibration_stats = calibration_stats or self._load_replay_calibration_stats()
        if not calibration_stats:
            return ""

        target_league = self._extract_match_league_name(match_info_extra)
        league_stats_map = calibration_stats.get("by_league") or {}
        league_stats = league_stats_map.get(target_league) or {} if target_league else {}
        baseline_source = calibration_stats
        baseline_prefix = ""
        if target_league and int((league_stats.get("sample_size") or 0)) >= 40:
            baseline_source = league_stats
            baseline_prefix = f"{target_league}"

        def has_enough_category(category_stats, min_count, min_sample=0):
            if not isinstance(category_stats, dict):
                return False
            if min_sample and int(category_stats.get("sample_size") or 0) < int(min_sample):
                return False
            return int(category_stats.get("count", 0) or 0) >= int(min_count)

        def choose_category(category_name, min_count, min_sample=0):
            if target_league and league_stats:
                league_category = league_stats.get(category_name) or {}
                if has_enough_category(league_category, min_count, min_sample):
                    return league_category, f"{target_league}"
            global_category = calibration_stats.get(category_name) or {}
            if has_enough_category(global_category, min_count, min_sample):
                return global_category, ""
            return {}, ""

        def build_notes(source_stats, prefix, category_name):
            notes = []
            if category_name == "hot_favorite":
                hot_stats = source_stats
                if market_heat_warning and int(hot_stats.get("count", 0) or 0) >= 12:
                    hit_rate = float(hot_stats.get("hit_rate", 0) or 0)
                    if hit_rate > 0:
                        notes.append(
                            f"{prefix}低赔热门类近{int(hot_stats['count'])}场命中仅{hit_rate:.0%}，谨防假热"
                        )
            elif category_name == "balanced_draw":
                draw_stats = source_stats
                if draw_warning and int(draw_stats.get("count", 0) or 0) >= 8:
                    draw_rate = float(draw_stats.get("draw_rate", 0) or 0)
                    if draw_rate > 0:
                        notes.append(
                            f"{prefix}均势局近{int(draw_stats['count'])}场打平{draw_rate:.0%}，防平优先"
                        )
            elif category_name == "high_risk_band":
                high_stats = source_stats
                if int(high_stats.get("count", 0) or 0) >= 10:
                    hit_rate = float(high_stats.get("hit_rate", 0) or 0)
                    if hit_rate > 0:
                        notes.append(
                            f"{prefix}高风险档近{int(high_stats['count'])}场命中仅{hit_rate:.0%}，结论宜降温"
                        )
            return notes

        notes = []
        overall_size = int(baseline_source.get("sample_size") or 0)
        overall_hit_rate = float(baseline_source.get("overall_hit_rate") or 0)
        if overall_size >= 40 and overall_hit_rate > 0:
            notes.append(f"{baseline_prefix}近期回看：近{overall_size}场命中{overall_hit_rate:.0%}")

        if not suppress_overlap:
            hot_stats, hot_prefix = choose_category("hot_favorite", 12)
            notes.extend(build_notes(hot_stats, hot_prefix, "hot_favorite"))

            draw_stats, draw_prefix = choose_category("balanced_draw", 8)
            notes.extend(build_notes(draw_stats, draw_prefix, "balanced_draw"))

        if not notes and overall_size >= 20 and overall_hit_rate > 0:
            notes.append(f"近期回看：近{overall_size}场命中{overall_hit_rate:.0%}")

        if not suppress_overlap and not notes:
            high_stats, high_prefix = choose_category("high_risk_band", 10)
            notes.extend(build_notes(high_stats, high_prefix, "high_risk_band"))

        if not notes:
            return ""
        return "复盘校准：" + "；".join(notes[:2])

    def _stats_to_wdl_prob_map(self, stats):
        out = {"主胜": 0.0, "平局": 0.0, "客胜": 0.0}
        mapping = {"胜": "主胜", "平": "平局", "负": "客胜"}
        for item in (stats or []):
            if not isinstance(item, dict):
                continue
            label = mapping.get(str(item.get("result") or "").strip())
            if not label:
                continue
            try:
                out[label] = round(float(item.get("pct", 0) or 0), 4)
            except Exception:
                out[label] = 0.0
        return out

    def _calc_ou25_probs_from_poisson(self, lam_h, lam_a):
        if not lam_h or not lam_a:
            return {"大球": 0.0, "小球": 0.0}
        limit = 10
        over = under = 0.0
        prob_h = [self._poisson_pmf(i, lam_h) for i in range(limit)]
        prob_a = [self._poisson_pmf(i, lam_a) for i in range(limit)]
        for h in range(limit):
            for a in range(limit):
                prob = prob_h[h] * prob_a[a]
                if h + a >= 3:
                    over += prob
                else:
                    under += prob
        total = over + under
        if total <= 0:
            return {"大球": 0.0, "小球": 0.0}
        return {"大球": round(over / total, 4), "小球": round(under / total, 4)}

    def _build_local_llm_reference(self, best_bet, spf_stats, poisson_data):
        ref = {
            "best_bet": {
                "kind": str((best_bet or {}).get("kind") or ""),
                "sel": str((best_bet or {}).get("sel") or ""),
                "odds": float((best_bet or {}).get("odds", 0) or 0),
            } if best_bet else {},
            "wdl_probs": self._stats_to_wdl_prob_map(spf_stats),
            "ou25_probs": {"大球": 0.0, "小球": 0.0},
            "score_picks": [],
        }
        if poisson_data:
            ref["ou25_probs"] = self._calc_ou25_probs_from_poisson(
                float(poisson_data.get("lh", 0) or 0),
                float(poisson_data.get("la", 0) or 0),
            )
            ref["score_picks"] = [
                str(item.get("score") or "").strip()
                for item in (poisson_data.get("scores") or [])[:3]
                if isinstance(item, dict) and str(item.get("score") or "").strip()
            ]
        return ref
    
    def load_bifa_data(self):
        bifa_file = 'bifa.xlsx'
        if not os.path.exists(bifa_file):
            print(f"⚠️ 未找到 {bifa_file}，跳过资金风控。")
            return {}

        print(f"💰 读取必发资金数据: {bifa_file} ...")
        try:
            df = pd.read_excel(bifa_file)
            df.columns = df.columns.str.strip()
            bifa_map = {}
            
            def clean_num(val):
                if pd.isna(val): return 0
                s = str(val).replace(',', '').replace('%', '')
                try: return float(s)
                except Exception: return 0

            def clean_name(name):
                return str(name).strip().replace('FC', '').replace(' ', '')

            total_rows = len(df)
            i = 0
            while i < total_rows - 2:
                try:
                    row_h = df.iloc[i]
                    h_name = clean_name(row_h.iloc[0])
                    
                    row_d = df.iloc[i+1]
                    if "平" not in str(row_d.iloc[0]):
                        i += 1; continue

                    row_a = df.iloc[i+2]
                    
                    v_h = clean_num(row_h.iloc[2])
                    v_d = clean_num(row_d.iloc[2])
                    v_a = clean_num(row_a.iloc[2])
                    
                    o_h = clean_num(row_h.iloc[5])
                    o_d = clean_num(row_d.iloc[5])
                    o_a = clean_num(row_a.iloc[5])

                    var_h = clean_num(row_h.iloc[6])
                    var_d = clean_num(row_d.iloc[6])
                    var_a = clean_num(row_a.iloc[6])

                    bifa_map[h_name] = {
                        'vol': {'h': v_h, 'd': v_d, 'a': v_a},
                        'odds': {'h': o_h, 'd': o_d, 'a': o_a},
                        'var': {'h': var_h, 'd': var_d, 'a': var_a},
                        'payout': clean_num(row_h.iloc[4])
                    }
                    i += 3
                except Exception as e:
                    i += 1
                    continue
            
            print(f"✅ 必发数据加载成功: {len(bifa_map)} 场")
            return bifa_map

        except Exception as e:
            print(f"❌ 读取必发Excel失败: {e}")
            return {}

    def load_pankou_data(self):
        pk_file = 'pankou.xlsx'
        if not os.path.exists(pk_file):
            print(f"⚠️ 未找到 {pk_file}，跳过亚盘风控。")
            return {}

        print(f"⚖️ 读取亚盘动态数据 (初盘+终盘): {pk_file} ...")
        try:
            df = pd.read_excel(pk_file)
            df.columns = df.columns.str.strip() # 去除列名空格
            pk_map = {}

            # 辅助：队名清洗
            def clean_name(name):
                return str(name).strip().replace('FC', '').replace(' ', '')

            # 辅助：全能盘口解析器 (支持数字/文本)
            def parse_handicap(val):
                if isinstance(val, (int, float)): return float(val)
                if val is None: return 0
                s = str(val).strip()
                if not s or s.lower() == 'nan': return 0
                try: return float(s)
                except Exception: pass
                
                is_receive = "受" in s
                t = s.replace("受", "").strip()
                v = 0
                if t == "平手": v = 0
                elif t in ["平手/半球", "平/半"]: v = 0.25
                elif t == "半球": v = 0.5
                elif t in ["半球/一球", "半/一"]: v = 0.75
                elif t == "一球": v = 1.0
                elif t in ["一球/球半", "一/球半"]: v = 1.25
                elif t == "球半": v = 1.5
                elif t in ["球半/两球", "球半/两"]: v = 1.75
                elif t == "两球": v = 2.0
                elif t == "两球/两球半": v = 2.25
                elif t == "两球半": v = 2.5
                elif t == "两球半/三球": v = 2.75
                elif t == "三球": v = 3.0
                return v if is_receive else -v

            # 辅助：安全读取浮点数
            def get_float(row, col_name):
                try:
                    val = row.get(col_name)
                    if val is None: return 0.0
                    return float(val)
                except Exception: return 0.0

            for _, row in df.iterrows():
                try:
                    # 1. 匹配对阵名 (兼容 "A VS B" 格式)
                    vs_str = str(row.get('对阵', ''))
                    if 'VS' not in vs_str: continue
                    parts = vs_str.split('VS')
                    h_name = clean_name(parts[0])
                    
                    # 2. 读取平博数据 (初始 + 最新)
                    # 根据您截图的列名适配
                    pb_init_line = parse_handicap(row.get('平博初始盘'))
                    pb_init_water = get_float(row, '平博初始主')
                    
                    pb_curr_line = parse_handicap(row.get('平博最新盘'))
                    pb_curr_water = get_float(row, '平博最新主')
                    
                    # 3. 读取澳门数据 (初始 + 最新)
                    mac_init_line = parse_handicap(row.get('澳门初始盘'))
                    mac_init_water = get_float(row, '澳门初始主')
                    
                    mac_curr_line = parse_handicap(row.get('澳门最新盘'))
                    mac_curr_water = get_float(row, '澳门最新主')

                    # 存入字典
                    pk_map[h_name] = {
                        'pb': {
                            'init_line': pb_init_line, 'init_water': pb_init_water,
                            'curr_line': pb_curr_line, 'curr_water': pb_curr_water
                        },
                        'mac': {
                            'init_line': mac_init_line, 'init_water': mac_init_water,
                            'curr_line': mac_curr_line, 'curr_water': mac_curr_water
                        }
                    }
                except Exception as e: 
                    continue
            
            print(f"✅ 动态亚盘加载成功: {len(pk_map)} 场")
            return pk_map
        except Exception as e:
            print(f"❌ 读取亚盘Excel失败: {e}")
            return {}
    
    # -------------------------------------------------------
    # 🔴 补回丢失的 parse_json 函数
    # -------------------------------------------------------
    def _to_positive_float(self, value):
        try:
            if value is None:
                return None
            val = float(value)
            if math.isnan(val) or val <= 0:
                return None
            return val
        except Exception:
            return None

    def _format_odds_move(self, label, initial, final):
        initial = self._to_positive_float(initial)
        final = self._to_positive_float(final)
        if initial is None or final is None:
            return ""
        pct = (final - initial) * 100.0 / initial
        return f"{label}{initial:.2f}→{final:.2f}({pct:+.1f}%)"

    def _infer_market_bias(self, initial, final):
        try:
            h_init = float(initial.get('h'))
            a_init = float(initial.get('a'))
            h_final = float(final.get('h'))
            a_final = float(final.get('a'))
        except Exception:
            return ""
        home_delta = (h_final - h_init) / h_init if h_init else 0.0
        away_delta = (a_final - a_init) / a_init if a_init else 0.0
        if home_delta >= 0.015 and away_delta <= -0.015:
            return "市场向客队倾斜"
        if home_delta <= -0.015 and away_delta >= 0.015:
            return "市场向主队倾斜"
        return ""

    def _build_market_odds_movement_segment(self, title, market, labels):
        market = market or {}
        history = market.get('history') or {}
        timeline = [x for x in (history.get('timeline') or []) if isinstance(x, dict)]
        initial = history.get('initial') or (timeline[0] if timeline else {}) or {}
        final = history.get('final') or (timeline[-1] if timeline else {}) or market
        if not isinstance(initial, dict) or not isinstance(final, dict):
            return ""

        parts = []
        for key, label in labels:
            part = self._format_odds_move(label, initial.get(key), final.get(key))
            if part:
                parts.append(part)
        if not parts:
            return ""

        bias = self._infer_market_bias(initial, final)
        if bias:
            parts.append(bias)
        return f"{title}：" + "，".join(parts)

    def _build_odds_movement_context(self, match_payload):
        odds = (match_payload or {}).get('odds') or {}
        had_segment = self._build_market_odds_movement_segment(
            "胜平负",
            odds.get('had') or {},
            (('h', '胜'), ('d', '平'), ('a', '负')),
        )
        hhad = odds.get('hhad') or {}
        goal_line = str(hhad.get('goalLine') or ((hhad.get('history') or {}).get('final') or {}).get('goalLine') or "").strip()
        hhad_title = f"让球({goal_line})" if goal_line else "让球"
        hhad_segment = self._build_market_odds_movement_segment(
            hhad_title,
            hhad,
            (('h', '让胜'), ('d', '让平'), ('a', '让负')),
        )
        segments = [x for x in [had_segment, hhad_segment] if x]
        if not segments:
            return {}
        return {"summary": "；".join(segments[:2])}

    def _build_injury_impact_summary(self, lineup_injury):
        lineup_injury = lineup_injury or {}
        source = str(lineup_injury.get("source") or "").strip().lower()
        if source == "fotmob":
            key_labels = {"核心", "主力/重要轮换", "主要轮换"}
            impact_weight = {
                "核心": 2.0,
                "主力/重要轮换": 1.2,
                "主要轮换": 1.0,
                "轮换/替补": 0.2,
                "重要性低/待核验": 0.1,
            }

            def norm_role(row):
                role = str(row.get("role") or "").strip().upper()
                if role in {"G", "D", "M", "F"}:
                    return role
                group = str(row.get("position_group") or "").strip()
                if "门将" in group:
                    return "G"
                if "后" in group or "卫" in group:
                    return "D"
                if "中场" in group:
                    return "M"
                if "前锋" in group or "前场" in group:
                    return "F"
                return ""

            def impact_level(score):
                if score >= 2.8:
                    return "较大"
                if score >= 1.6:
                    return "中等"
                if score >= 0.6:
                    return "轻微"
                return "有限"

            def side_summary(side_key, side_label):
                rows = [x for x in (lineup_injury.get(f"{side_key}_absences") or []) if isinstance(x, dict)]
                if not rows:
                    return f"{side_label}暂无明确伤停"

                attack_score = 0.0
                defense_score = 0.0
                key_count = 0
                unknown_score = 0.0
                for row in rows:
                    label = str(row.get("importance_label") or "").strip() or "重要性低/待核验"
                    weight = impact_weight.get(label, 0.1)
                    role = norm_role(row)
                    if label in key_labels:
                        key_count += 1
                    if role == "F":
                        attack_score += weight
                    elif role == "M":
                        attack_score += weight * 0.35
                        defense_score += weight * 0.55
                    elif role == "D":
                        defense_score += weight
                    elif role == "G":
                        defense_score += weight * 1.2
                    else:
                        unknown_score += weight

                if attack_score == 0 and defense_score == 0 and unknown_score > 0:
                    attack_score = unknown_score * 0.5
                    defense_score = unknown_score * 0.5

                attack_level = impact_level(attack_score)
                defense_level = impact_level(defense_score)
                if key_count == 0:
                    if attack_level == "有限" and defense_level == "有限":
                        if defense_score >= attack_score + 0.2 and defense_score > 0:
                            return f"{side_label}伤停{len(rows)}人，以轮换为主，防守影响有限"
                        if attack_score >= defense_score + 0.2 and attack_score > 0:
                            return f"{side_label}伤停{len(rows)}人，以轮换为主，进攻影响有限"
                        return f"{side_label}伤停{len(rows)}人，以轮换为主，整体影响有限"
                    if defense_score >= attack_score + 0.8:
                        return f"{side_label}伤停{len(rows)}人，以轮换为主，防守影响{defense_level}"
                    if attack_score >= defense_score + 0.8:
                        return f"{side_label}伤停{len(rows)}人，以轮换为主，进攻影响{attack_level}"
                    strongest = defense_level if defense_score >= attack_score else attack_level
                    return f"{side_label}伤停{len(rows)}人，以轮换为主，整体影响{strongest}"

                if defense_score >= attack_score + 0.8:
                    return f"{side_label}伤停{len(rows)}人，其中主力{key_count}人，防守影响{defense_level}，进攻影响{attack_level}"
                if attack_score >= defense_score + 0.8:
                    return f"{side_label}伤停{len(rows)}人，其中主力{key_count}人，进攻影响{attack_level}，防守影响{defense_level}"
                strongest = defense_level if defense_score >= attack_score else attack_level
                return f"{side_label}伤停{len(rows)}人，其中主力{key_count}人，整体影响{strongest}"

            return "FotMob伤停：" + "；".join(
                [
                    side_summary("home", "主队"),
                    side_summary("away", "客队"),
                ]
            )

        role_labels = {"G": "门将", "D": "后卫", "M": "中场", "F": "前锋"}

        def importance_label(role, games):
            if role == "G" and games >= 10:
                return "核心"
            if games >= 20:
                return "核心"
            if games >= 8:
                return "主要轮换"
            if games > 0:
                return "轮换/替补"
            return "重要性低/待核验"

        def absence_text(row):
            name = str(row.get('name') or '').strip()
            role = str(row.get('role') or '').strip().upper()
            try:
                games = int(float(row.get('games_played') or 0))
            except Exception:
                games = 0
            if not name:
                return ""
            role_text = role_labels.get(role, role or "球员")
            label = importance_label(role, games)
            reason = str(row.get('reason') or row.get('status_label') or '').strip()
            details = f"{role_text}{games}场，{label}"
            if reason:
                details += f"，{reason}"
            return f"{name}({details})"

        def side_summary(side_key, side_label):
            rows = [x for x in (lineup_injury.get(f"{side_key}_absences") or []) if isinstance(x, dict)]
            if not rows:
                return ""
            text = f"{side_label}伤停{len(rows)}人"
            details = [absence_text(row) for row in sorted(rows, key=_absence_sort_key)[:3]]
            details = [x for x in details if x]
            if details:
                text += "：" + "、".join(details)
            return text

        parts = [
            side_summary("home", "主队"),
            side_summary("away", "客队"),
        ]
        body = "；".join([x for x in parts if x])
        if not body:
            return ""
        prefix = "Forebet伤停" if source == "forebet" or not source else f"{source}伤停"
        return f"{prefix}：{body}"

    def parse_json(self, m):
        had = m.get('odds', {}).get('had', {}) or {}
        hhad = m.get('odds', {}).get('hhad', {}) or {}
        had_init = had.get('history', {}).get('initial', {}) or {}
        hhad_init = hhad.get('history', {}).get('initial', {}) or {}

        def to_float(x):
            """把 JSON 里的赔率/数值统一转 float；无效(空/<=0/NaN)返回 None"""
            try:
                if x is None:
                    return None
                v = float(x)
                if math.isnan(v) or v <= 0:
                    return None
                return v
            except Exception:
                return None

        # 让球值：允许为 0；无效则置 0
        try:
            h_val = float(hhad.get('goalLine', 0))
            if math.isnan(h_val):
                h_val = 0.0
        except Exception:
            h_val = 0.0
        h_val = round(h_val * 4) / 4  # 四分之一球

        return {
            'sw': to_float(had.get('h')),
            'sd': to_float(had.get('d')),
            'sl': to_float(had.get('a')),
            'sw_init': to_float(had_init.get('h')),
            'sd_init': to_float(had_init.get('d')),
            'sl_init': to_float(had_init.get('a')),

            'rw': to_float(hhad.get('h')),
            'rd': to_float(hhad.get('d')),
            'rl': to_float(hhad.get('a')),
            'rw_init': to_float(hhad_init.get('h')),
            'rd_init': to_float(hhad_init.get('d')),
            'rl_init': to_float(hhad_init.get('a')),

            'handicap': h_val,
            'source_time': (
                had.get('history', {}).get('final', {}).get('time')
                or hhad.get('history', {}).get('final', {}).get('time')
                or ""
            ),
            'odds_movement_context': self._build_odds_movement_context(m),
        }


    def build_league_profiles(self):
        if '联赛类型' not in self.df.columns: return
        grouped = self.df.groupby('联赛类型')
        for name, group in grouped:
            total = len(group)
            if total < 20: continue 
            home_wins = len(group[group['胜平负结果'] == '胜'])
            home_rate = home_wins / total
            tags = []
            if home_rate > 0.50: tags.append({'text': f'🏟️ 主场强势', 'cls': 'prof-red'})
            elif home_rate < 0.38: tags.append({'text': f'⚖️ 无主场优势', 'cls': 'prof-gray'})
            
            fav_mask = (group['胜平负-最终-胜'] < 1.55)
            fav_total = fav_mask.sum()
            fav_rate = -1
            if fav_total >= 5:
                fav_wins = len(group[fav_mask & (group['胜平负结果'] == '胜')])
                fav_rate = fav_wins / fav_total
            self.league_profiles[name] = {'tags': tags, 'fav_rate': fav_rate}

    # === 优化点 5: AI 特征加入初始赔率 ===
    def _fit_calibrated_rf(self, X, y):
        """训练 RandomForest 并做概率校准。

        前提：self.df 已在 load_data 中按真实日期升序排列，因此这里的
        顺序 80/20 切分（前80%训练、后20%校准）才是真正的时序切分，
        校准集不会泄露未来信息。样本太少时回退 cv=3。
        """
        base_clf = RandomForestClassifier(
            n_estimators=120, max_depth=10, random_state=42, class_weight='balanced'
        )
        split = int(len(X) * 0.8)
        if split < 50:
            clf = CalibratedClassifierCV(base_clf, method='sigmoid', cv=3)
            clf.fit(X, y)
        else:
            X_tr, y_tr = X.iloc[:split], y.iloc[:split]
            X_cal, y_cal = X.iloc[split:], y.iloc[split:]
            base_clf.fit(X_tr, y_tr)
            clf = CalibratedClassifierCV(base_clf, method='sigmoid', cv='prefit')
            clf.fit(X_cal, y_cal)
        return clf

    def train_ai(self):
        cache_meta = self._build_ai_cache_meta()
        if self._load_ai_cache(cache_meta):
            return

        print("🧠 正在训练 AI 模型 (赔率 + 联赛分级 + 趋势)...")
        df_train = self.df.copy()
        
        # --- 1. 特征工程：赔率 + 联赛分级 + 赔率变化率 ---

        # A. 联赛分级映射 (将联赛名转为 Tier 数字 1,2,3,4)
        df_train['tier'] = df_train['联赛类型'].apply(self._get_tier_num)

        # B. 赔率变化率 (Delta)
        # 避免除以0
        df_train['spf_chg_w'] = (df_train['胜平负-最终-胜'] - df_train['胜平负-初始-胜']) / df_train['胜平负-初始-胜'].replace(0, 1)
        df_train['spf_chg_d'] = (df_train['胜平负-最终-平'] - df_train['胜平负-初始-平']) / df_train['胜平负-初始-平'].replace(0, 1)
        df_train['spf_chg_l'] = (df_train['胜平负-最终-负'] - df_train['胜平负-初始-负']) / df_train['胜平负-初始-负'].replace(0, 1)

        # 定义特征列表（不使用 Elo）
        feature_cols = [
            '胜平负-最终-胜', '胜平负-最终-平', '胜平负-最终-负', 
            '胜平负-初始-胜', '胜平负-初始-平', '胜平负-初始-负',
            '让球', 
            'tier',
            'spf_chg_w', 'spf_chg_d', 'spf_chg_l' # <--- 趋势新增
        ]
        
        # 填充空值
        df_train = df_train.fillna(-1)
        target_map = {'胜': 0, '平': 1, '负': 2}
        
        # --- 训练 SPF 模型 ---
        d1 = df_train.dropna(subset=['胜平负结果']).copy()  # .copy() 修复链式赋值
        d1['y'] = d1['胜平负结果'].map(target_map)
        d1 = d1.dropna(subset=['y'])
        self.ai_sample_size_spf = len(d1)

        if len(d1) > 10:
            valid_feats = [c for c in feature_cols if c in d1.columns]
            self.clf_spf = self._fit_calibrated_rf(d1[valid_feats], d1['y'].astype(int))
            self.clf_spf.feature_names_in_ = valid_feats


        # --- 训练 RQ 模型 ---
        # RQ模型也加入基本面特征，但也需要 RQ 赔率
        rq_feats = feature_cols + ['让球-最终-胜', '让球-最终-平', '让球-最终-负']
        
        d2 = df_train.dropna(subset=['让球结果']).copy()
        d2['y'] = d2['让球结果'].map(target_map)
        d2 = d2.dropna(subset=['y'])
        self.ai_sample_size_rq = len(d2)

        if len(d2) > 10:
            valid_feats_rq = [c for c in rq_feats if c in d2.columns]
            self.clf_rq = self._fit_calibrated_rf(d2[valid_feats_rq], d2['y'].astype(int))
            self.clf_rq.feature_names_in_ = valid_feats_rq

        self._save_ai_cache(cache_meta)

    def get_ai_detailed(self, odds_data, league):
        if not self.clf_spf: return [], []
        
        # 1. 准备基础赔率数据
        sw, sd, sl = odds_data.get('sw', 0), odds_data.get('sd', 0), odds_data.get('sl', 0)
        sw_i, sd_i, sl_i = odds_data.get('sw_init', 0), odds_data.get('sd_init', 0), odds_data.get('sl_init', 0)
        if not sw or not sw_i: return [], [] # 数据缺失不预测

        # 2. 准备高级特征 (Tier, Delta)
        tier = self._get_tier_num(league)
        
        # 计算 Deltas
        d_w = (sw - sw_i)/sw_i if sw_i else 0
        d_d = (sd - sd_i)/sd_i if sd_i else 0
        d_l = (sl - sl_i)/sl_i if sl_i else 0

        # 构建输入字典
        # 必须和 train_ai 里的 feature_cols 顺序无关，但名字要对
        input_dict = {
            '胜平负-最终-胜': sw, '胜平负-最终-平': sd, '胜平负-最终-负': sl,
            '胜平负-初始-胜': sw_i, '胜平负-初始-平': sd_i, '胜平负-初始-负': sl_i,
            '让球': odds_data.get('handicap', 0),
            'tier': tier,
            'spf_chg_w': d_w, 'spf_chg_d': d_d, 'spf_chg_l': d_l,
            # RQ 特征
            '让球-最终-胜': odds_data.get('rw', 0), '让球-最终-平': odds_data.get('rd', 0), '让球-最终-负': odds_data.get('rl', 0)
        }
        # 转为 DataFrame
        df_input = pd.DataFrame([input_dict])
        
        lmap = {0:'胜', 1:'平', 2:'负'}
        
        def predict(clf, df):
            if not hasattr(clf, 'feature_names_in_'): return []
            # 只取模型需要的列，自动对其
            cols = clf.feature_names_in_
            # 如果缺列，填0
            valid_input = df.reindex(columns=cols).fillna(0)
            
            try:
                probs = clf.predict_proba(valid_input)[0]
                res = []
                for i, p in enumerate(probs):
                    res.append({'result': lmap[i], 'pct': p})
                res.sort(key=lambda x: x['pct'], reverse=True)
                return res
            except Exception: return []

        return predict(self.clf_spf, df_input), predict(self.clf_rq, df_input)

    def blend_spf_probs(
        self,
        hist_stats,
        market_probs,
        ai_spf,
        poisson_data,
        odds_data=None,
        manual_info=None,
        asia_decision=None,
        bf_data=None
    ):
        """
        统一融合概率（展示层）：
        历史相似 + 市场概率 + AI + 泊松 + 欧赔结构 + 亚盘方向 + 资金流。
        注意：该函数只影响融合概率展示，不改主策略风控与选单链路。
        """
        eps = 1e-6
        outcomes = ['胜', '平', '负']

        def norm_map(m):
            if not isinstance(m, dict):
                return None
            vals = {k: float(m.get(k, 0.0) or 0.0) for k in outcomes}
            s = sum(max(0.0, v) for v in vals.values())
            if s <= 0:
                return None
            return {k: max(0.0, vals[k]) / s for k in outcomes}

        def stats_to_map(stats):
            if not stats:
                return None
            out = {}
            for x in stats:
                r = x.get('result')
                p = x.get('pct')
                if r in outcomes and p is not None:
                    out[r] = float(p)
            return norm_map(out)

        hist_map = stats_to_map(hist_stats)
        market_map = norm_map(market_probs or {})
        ai_map = stats_to_map(ai_spf or [])
        poi_map = None
        if poisson_data:
            poi_map = norm_map({
                '胜': poisson_data.get('ph', 0),
                '平': poisson_data.get('pd', 0),
                '负': poisson_data.get('pl', 0),
            })

        active = {}
        cfg = UNIFIED_FUSION_WEIGHTS.copy()
        if hist_map:
            active['hist'] = float(cfg.get('hist', 0.0))
        if market_map:
            active['market'] = float(cfg.get('market', 0.0))
        if ai_map:
            active['ai_rf'] = float(cfg.get('ai_rf', 0.0))
        if poi_map:
            active['poisson'] = float(cfg.get('poisson', 0.0))

        if not active or sum(active.values()) <= 0:
            if hist_map:
                return hist_map
            if market_map:
                return market_map
            return {'胜': 1/3, '平': 1/3, '负': 1/3}

        z = sum(active.values())
        active = {k: v / z for k, v in active.items()}

        # 几何融合：权重加权对数概率
        log_score = {r: 0.0 for r in outcomes}
        for r in outcomes:
            if 'hist' in active:
                log_score[r] += active['hist'] * math.log(max(hist_map.get(r, 0.0), eps))
            if 'market' in active:
                log_score[r] += active['market'] * math.log(max(market_map.get(r, 0.0), eps))
            if 'ai_rf' in active:
                log_score[r] += active['ai_rf'] * math.log(max(ai_map.get(r, 0.0), eps))
            if 'poisson' in active:
                log_score[r] += active['poisson'] * math.log(max(poi_map.get(r, 0.0), eps))

        # 轻量修正项（不触碰主风控逻辑）
        adj = {r: 0.0 for r in outcomes}

        # 1) 欧赔结构：竞彩 vs 欧洲均赔
        if manual_info and odds_data:
            pairs = [
                ('胜', odds_data.get('sw', 0), manual_info.get('avg_w', 0)),
                ('平', odds_data.get('sd', 0), manual_info.get('avg_d', 0)),
                ('负', odds_data.get('sl', 0), manual_info.get('avg_l', 0)),
            ]
            for r, jc_odds, avg_odds in pairs:
                if jc_odds and avg_odds and jc_odds > 0 and avg_odds > 0:
                    ratio = jc_odds / avg_odds
                    if ratio < 0.90:
                        adj[r] -= 0.10
                    elif ratio > 1.02:
                        adj[r] += 0.06

        # 2) 亚盘方向：命中否决方向时做概率压制
        kill_sides = set((asia_decision or {}).get('kill_sides', set()))
        if 'home' in kill_sides:
            adj['胜'] -= 0.25
            adj['平'] += 0.08
            adj['负'] += 0.17
        if 'away' in kill_sides:
            adj['负'] -= 0.25
            adj['平'] += 0.08
            adj['胜'] += 0.17

        # 3) 资金流：主胜过热降主，平局吸金增平
        if bf_data:
            try:
                vh = float((bf_data.get('vol') or {}).get('h', 0) or 0)
                vd = float((bf_data.get('vol') or {}).get('d', 0) or 0)
                va = float((bf_data.get('vol') or {}).get('a', 0) or 0)
                tot = vh + vd + va
                if tot > 0:
                    rh = vh / tot
                    rd = vd / tot
                    if rh > 0.60:
                        adj['胜'] -= 0.10
                        adj['平'] += 0.04
                        adj['负'] += 0.06
                    if rd > 0.25:
                        adj['平'] += 0.06
                        adj['胜'] -= 0.03
                        adj['负'] -= 0.03
            except Exception:
                pass

        # 修正项限幅：防止单一模块把概率拉偏
        for r in outcomes:
            adj[r] = max(-FUSION_ADJ_CLIP, min(FUSION_ADJ_CLIP, adj[r]))
            log_score[r] += adj[r]

        # softmax
        m = max(log_score.values())
        exp_map = {r: math.exp(log_score[r] - m) for r in outcomes}
        s = sum(exp_map.values())
        if s <= 0:
            if hist_map:
                return hist_map
            if market_map:
                return market_map
            return {'胜': 1/3, '平': 1/3, '负': 1/3}
        out = {r: exp_map[r] / s for r in outcomes}

        # 置信门槛：融合优势不足时回退历史相似（若无历史则保留融合）
        ranked = sorted(out.items(), key=lambda x: x[1], reverse=True)
        top1 = ranked[0][1]
        top2 = ranked[1][1]
        if hist_map and (top1 < FUSION_MIN_TOP1 or (top1 - top2) < FUSION_MIN_GAP):
            return hist_map
        return out

    def assign_tier(self, league_name):
        l_str = str(league_name)
        for tier, keywords in LEAGUE_TIERS.items():
            for kw in keywords:
                if kw in l_str:
                    return tier
        return 'Other'

    def get_tier_pool(self, current_league):
        tier_name = self.assign_tier(current_league)
        if tier_name == 'Other': return pd.DataFrame() 
        target_leagues = LEAGUE_TIERS[tier_name]
        pattern = '|'.join(target_leagues)
        return self.df[self.df['联赛类型'].astype(str).str.contains(pattern, na=False, regex=True)].copy()

    # === 优化点 1 & 2 & 3: RQ独立匹配 + 三项全约束 + 距离标准化 ===
    # === 最终回归版：纯粹赔率 + 趋势匹配 ===
    def calculate_3d_weights(self, odds, current_league, home_team, away_team, market='spf'):
        """
        回归本质：只利用 赔率分布(P) + 赔率趋势(Delta) + 让球(H) 进行匹配
        不再依赖不准确的 Elo 或外部排名数据。
        """
        sw = odds['sw']; sd = odds['sd']; sl = odds['sl']
        sw_init = odds['sw_init']; sd_init = odds['sd_init']; sl_init = odds['sl_init']
        h = odds['handicap']
        
        # RQ 模式参数
        rw = odds['rw']; rd = odds['rd']; rl = odds['rl']
        rw_init = odds.get('rw_init'); rd_init = odds.get('rd_init'); rl_init = odds.get('rl_init')

        # 0. 基础校验
        if not sw or not sd or not sl: return None, 0, "赔率缺失", 'h'
        if market == 'rq' and (not rw or not rd or not rl): return None, 0, "让球赔率缺失", 'h'

        # 1. 确定目标数据列
        # 我们重点关注主胜和客胜的变化，因为平局变化通常较小
        if market == 'spf':
            # 当前赔率
            curr_odds = [sw, sd, sl]
            # 赔率变化率 (Current Delta)
            # 逻辑：(终赔 - 初赔) / 初赔
            d_w = (sw - sw_init)/sw_init if sw_init else 0
            d_l = (sl - sl_init)/sl_init if sl_init else 0
            
            # 历史数据列名
            cols_final = ['胜平负-最终-胜', '胜平负-最终-平', '胜平负-最终-负']
            col_d_w = 'spf_delta_w_pct' # 我们需要现场计算百分比
            col_d_l = 'spf_delta_l_pct'
            
            focus_side = 'h' if sw <= sl else 'a'
            
        else: # market == 'rq'
            curr_odds = [rw, rd, rl]
            d_w = (rw - rw_init)/rw_init if rw_init else 0
            d_l = (rl - rl_init)/rl_init if rl_init else 0
            
            cols_final = ['让球-最终-胜', '让球-最终-平', '让球-最终-负']
            col_d_w = 'rq_delta_w_pct'
            col_d_l = 'rq_delta_l_pct'
            
            focus_side = 'h' if rw <= rl else 'a'

        # 计算当前真实概率分布 (Prob Vector)
        # 这里的 _get_true_probs 已经包含了去水逻辑
        if market == 'rq':
            curr_pw, curr_pd, curr_pl = self._get_true_probs_rq(curr_odds[0], curr_odds[1], curr_odds[2])
        else:
            curr_pw, curr_pd, curr_pl = self._get_true_probs(curr_odds[0], curr_odds[1], curr_odds[2])
        if curr_pw is None: return None, 0, "概率异常", 'h'

        # 2. 样本池选择 (Tier + Handicap Hard Filter)
        # 只在同级别联赛、同盘口中找，这本身就是最强的实力过滤器
        # 先精确匹配联赛，避免 contains 带来的跨联赛污染
        pool = self.df[self.df['联赛类型'].astype(str) == str(current_league)].copy()
        if len(pool) < 20:
            tier_pool = self.get_tier_pool(current_league)
            if not tier_pool.empty and len(tier_pool) > 50: pool = tier_pool
        
        # 【硬过滤】让球必须一致（容差匹配，修复浮点精确等值导致样本池静默归零）
        try:
            _h_norm = round(float(h) * 4) / 4  # 与 load_data 的盘口规整方式保持一致
        except (TypeError, ValueError):
            return None, 0, "盘口异常", focus_side
        pool = pool[np.isclose(pool['让球'].astype(float), _h_norm, atol=0.01)]
        pool = pool.copy()
        
        # 3. 预计算历史数据的 Delta (百分比)
        # 这一步是为了匹配“趋势”。曼城降水 vs 曼城升水，意义完全不同。
        if market == 'spf':
            pool[col_d_w] = (pool['胜平负-最终-胜'] - pool['胜平负-初始-胜']) / pool['胜平负-初始-胜']
            pool[col_d_l] = (pool['胜平负-最终-负'] - pool['胜平负-初始-负']) / pool['胜平负-初始-负']
        else:
            pool[col_d_w] = (pool['让球-最终-胜'] - pool['让球-初始-胜']) / pool['让球-初始-胜']
            pool[col_d_l] = (pool['让球-最终-负'] - pool['让球-初始-负']) / pool['让球-初始-负']
        
        # 填充空值防报错
        pool[col_d_w] = pool[col_d_w].fillna(0)
        pool[col_d_l] = pool[col_d_l].fillna(0)

        # 4. 初步筛选 (Bone Structure)
        # 这一步是为了加快计算速度，先圈定一个大概范围
        # 只要赔率结构大致相似 (±15%) 即可
        mask = (
            (pool[cols_final[0]].between(curr_odds[0]*0.85, curr_odds[0]*1.15)) &
            (pool[cols_final[2]].between(curr_odds[2]*0.85, curr_odds[2]*1.15))
        )
        pool = pool[mask].copy()
        
        if len(pool) < MIN_SAMPLES: 
            return None, 0, f"相似样本不足({len(pool)})", focus_side

        # 5. 精确距离计算 (The Distance Metric)
        
        # A. 概率分布距离 (Structure Distance)
        # 历史赔率转概率
        margin_hist = (1/pool[cols_final[0]]) + (1/pool[cols_final[1]]) + (1/pool[cols_final[2]])
        pool['hp_w'] = (1/pool[cols_final[0]]) / margin_hist
        pool['hp_d'] = (1/pool[cols_final[1]]) / margin_hist
        pool['hp_l'] = (1/pool[cols_final[2]]) / margin_hist
        
        # 欧式距离计算
        std_p = NN_STD_P
        dist_struct_sq = ((pool['hp_w'] - curr_pw)/std_p)**2 + \
                         ((pool['hp_d'] - curr_pd)/std_p)**2 + \
                         ((pool['hp_l'] - curr_pl)/std_p)**2
        
        # B. 趋势距离 (Trend Distance)
        # 这一步非常重要！它区分了“诱盘”和“正路”
        # 如果当前是主胜降赔，我们就要找历史上也是主胜降赔的比赛
        std_trend = NN_STD_TREND
        dist_trend_sq = ((pool[col_d_w] - d_w)/std_trend)**2 + \
                        ((pool[col_d_l] - d_l)/std_trend)**2
        
        # C. 最终距离
        pool['distance'] = np.sqrt(dist_struct_sq + dist_trend_sq * NN_TREND_WEIGHT)
        
        # 6. 提取结果
        df_final = pool.sort_values('distance').head(NN_TOP_N).copy()
        
        # 基础距离权重
        base_weight = 1.0 / (df_final['distance'] + 0.05)
        # 无日期场景下用顺序索引做时间衰减：越新的样本权重越高
        if '_row_id' in df_final.columns and NN_TAU > 0:
            curr_row = self.df['_row_id'].max() if '_row_id' in self.df.columns else df_final['_row_id'].max()
            age = (curr_row - df_final['_row_id']).clip(lower=0)
            time_decay = np.exp(-age / NN_TAU)
            df_final['weight'] = base_weight * time_decay
        else:
            df_final['weight'] = base_weight
        
        count = len(df_final)
        sum_w = df_final['weight'].sum()
        sum_w_sq = (df_final['weight']**2).sum()
        ess = (sum_w**2) / sum_w_sq if sum_w_sq > 0 else 0
        
        tag = f"🎯 锁定({count}场)"
        return df_final, ess, tag, focus_side

    # === 优化点 4: 动态贝叶斯平滑 C ===
    def get_weighted_stats(self, df_weighted, target_col, ess=None, prior_probs=None):
        if df_weighted is None or df_weighted.empty: return []
        total_weight = df_weighted['weight'].sum()
        if total_weight == 0: return []
        stats = []
        grouped = df_weighted.groupby(target_col)['weight'].sum()
        
        # 动态 C 计算: 
        # 如果 ESS 很小 (比如 1)，我们不信样本，C 应该大 (比如 20)
        # 如果 ESS 很大 (比如 20)，我们信样本，C 应该小 (比如 1)
        # 公式: C = 20 / max(ess, 1)
        if ess is None: C = 5.0
        else: C = max(1.0, min(20.0, 20.0 / max(ess, 0.5)))
        
        for res in ['胜', '平', '负']:
            w_hist = grouped.get(res, 0)
            p_prior = prior_probs.get(res, 0.333) if prior_probs else 0.333
            smoothed_prob = (w_hist + C * p_prior) / (total_weight + C)
            stats.append({'result': res, 'pct': smoothed_prob})
        stats.sort(key=lambda x: x['pct'], reverse=True)
        return stats

    def check_track_compliance(self, res, odds, prob, kind):
        if not odds or odds == 0: return False, "NoOdds", "赔率缺失"
        if kind == 'spf' and res != '平':
            if 1.35 <= odds <= 3.20: 
                if prob >= 0.40: return True, "主力", "高信" 
                else: return False, "主力", f"胜率低({prob:.0%})"
            else: return False, "主力", f"赔率不佳({odds})"
        if kind == 'spf' and res == '平':
            if 2.60 <= odds <= 3.80:
                if prob >= 0.30: return True, "防守", "平局" 
                else: return False, "防守", f"风险高({prob:.0%})"
            else: return False, "防守", "赔率异常"
        if kind == 'rq':
            if 1.50 <= odds <= 3.00:
                if prob >= 0.50: return True, "修正", "优质盘口" 
                else: return False, "修正", f"信心低({prob:.0%})"
            else: return False, "修正", "赔率鸡肋"
        return False, "其他", "未定义"

    def _calc_entropy_norm(self, stats):
        entropy = 0.0
        for item in stats or []:
            p = float(item.get('pct', 0) or 0)
            if p > 0:
                entropy -= p * math.log2(p)
        max_entropy = 1.585
        return entropy / max_entropy if max_entropy > 0 else 0.0

    def _calc_final_kelly(self, prob, odds, ess, norm_entropy):
        adj_prob = prob
        if prob > 0.55:
            adj_prob = 0.55 + (prob - 0.55) * 0.6

        raw_kelly = (odds * adj_prob - 1) / (odds - 1)
        penalty_factor = 1 - (norm_entropy ** 2)

        if raw_kelly > 0:
            min_frac = 0.05
            max_frac = 0.25
            ess_conf = min(1.0, ess / 10.0)
            ess_frac = min_frac + (max_frac - min_frac) * ess_conf
            final_kelly = raw_kelly * penalty_factor * ess_frac
        else:
            final_kelly = raw_kelly * penalty_factor

        return raw_kelly, final_kelly, penalty_factor

    def calculate_kelly_roi_raw(self, stats, odds_data, ess, kind='spf'):
        if not stats or not odds_data: return None, None, None, None, None, None
        
        # --- 1. 获取首选结果与概率 ---
        top = stats[0]
        res = top['result']
        prob = top['pct']
        
        # --- 2. 匹配赔率 ---
        odds = 0; odds_init = 0
        if kind == 'spf':
            if res == '胜': odds = odds_data.get('sw'); odds_init = odds_data.get('sw_init')
            elif res == '平': odds = odds_data.get('sd'); odds_init = odds_data.get('sd_init')
            elif res == '负': odds = odds_data.get('sl'); odds_init = odds_data.get('sl_init')
        elif kind == 'rq':
            if res == '胜': odds = odds_data.get('rw'); odds_init = odds_data.get('rw_init')
            elif res == '平': odds = odds_data.get('rd'); odds_init = odds_data.get('rd_init')
            elif res == '负': odds = odds_data.get('rl'); odds_init = odds_data.get('rl_init')
            
        if not odds or odds == 0: return None, None, None, None, None, None
        
        # --- 3. 计算优化版 Kelly (Phase 4: Calibration + ESS Fraction) ---
        roi = (odds * prob) - 1
        
        # 2) 香农熵惩罚 (Chaos Penalty)
        norm_entropy = self._calc_entropy_norm(stats)
        raw_kelly, final_kelly, penalty_factor = self._calc_final_kelly(prob, odds, ess, norm_entropy)
        
        # --- 4. 风控与标签生成 ---
        is_qualified, track, reason = self.check_track_compliance(res, odds, prob, kind)
        conf_tag = ""; conf_cls = "conf-gray"; is_low_conf = False
        
        if not is_qualified:
            is_low_conf = True
            conf_tag = f"⛔ {reason}"; conf_cls = "conf-red"
            final_kelly = -1 
        else:
            # 根据修正后的 Kelly 定级
            if ess < 2.5: 
                is_low_conf = True; conf_tag = f"⚠️ 样本极少({ess:.1f})"
                conf_cls = "conf-orange"
            # 这里的阈值可以根据 penalty 后的值调整
            elif final_kelly > 0.08: conf_tag = f"💎 {track}胆"; conf_cls = "conf-gold"
            elif final_kelly > 0.04: conf_tag = f"✅ {track}"; conf_cls = "conf-blue"
            else: 
                # 如果是因为熵惩罚导致 Kelly 变低
                if raw_kelly > 0.04 and penalty_factor < 0.5:
                    conf_tag = f"😵 混乱弃"; conf_cls = "conf-gray"
                else:
                    conf_tag = "😐 鸡肋"; conf_cls = "conf-gray"
        
        # 在 tag 中显示熵值，方便你调试观察 (E:0.8 代表很乱)
        tag_text = f"{res} (K:{final_kelly:.2f}/E:{norm_entropy:.2f})"
        
        raw = {
            'sel': res, 'prob': prob, 'odds': odds, 'odds_init': odds_init, 
            'kelly': final_kelly, 'ess': ess, 'is_low_conf': is_low_conf, 
            'kind': kind, 'reason': reason, 'qualified': is_qualified,
            'entropy': norm_entropy # 记录下来备用
        }
        
        return roi, tag_text, final_kelly, "", {'tag': conf_tag, 'cls': conf_cls}, raw

    def calculate_stake_suggestion(self, kelly, ess, kind):
        safe_kelly = kelly * 0.3
        score = safe_kelly * 100
        if ess > 10: score += 10 
        elif ess < 4: score -= 10 
        
        units = 0.5; stars = "⭐"; badge_cls = "stake-low"
        if score > 15 and ess > 6: units = 2.0; stars = "⭐⭐⭐⭐⭐"; badge_cls = "stake-high"
        elif score > 5: units = 1.0; stars = "⭐⭐⭐"; badge_cls = "stake-mid"
        if units > 5.0:units = 5.0
        return {'u': units, 'stars': stars, 'cls': badge_cls}

    def generate_dual_parlays(self, wdl_list, mixed_list):
        # 1. 预筛选：只取头部高质量选项进入组合池，减少计算量
        # 门槛：Kelly > 0.04 (稳健) / 0.05 (搏杀)
        wdl_pool = [c for c in wdl_list if c['kelly'] > 0.04 and c['ess'] >= 3.0]
        wdl_pool.sort(key=lambda x: x['kelly'], reverse=True)
        
        mixed_pool = [c for c in mixed_list if c['kelly'] > 0.05 and c['ess'] >= 3.0]
        mixed_pool.sort(key=lambda x: x['kelly'], reverse=True)
        
        def make(pool, t):
            raw_res = []
            # 扩大候选池到前 16 名，确保能凑出足够多的非重复组合
            candidates = pool[:16]
            combos = list(itertools.combinations(candidates, 2))
            
            for p1, p2 in combos:
                # --- 基础过滤：不能选同一场比赛 ---
                # 比较名字是否相同
                if p1['name'] == p2['name']: continue
                
                # 计算组合评分 (平均凯利值)
                k = (p1['kelly'] + p2['kelly']) / 2
                
                # 计算总注码建议
                # 逻辑：取两者ESS的平均值来定星级
                avg_ess = (p1['ess'] + p2['ess']) / 2
                stake = self.calculate_stake_suggestion(k, avg_ess, 'spf')
                
                raw_res.append({
                    'p1': p1, 
                    'p2': p2, 
                    'total_odds': p1['odds'] * p2['odds'], 
                    'kelly_score': k, 
                    'stake': stake
                })
            
            # 按评分降序排列
            raw_res.sort(key=lambda x: x['kelly_score'], reverse=True)
            
            # ==========================================
            # 🔥 核心修复：指纹去重 (Deduplication)
            # ==========================================
            final_res = []
            seen_pairs = set()
            
            for item in raw_res:
                # 生成唯一指纹：将两场比赛的名字排序后拼接
                # 这样 "A+B" 和 "B+A" 会生成相同的指纹，重复的 "A'+B" 也会被识别
                names = sorted([item['p1']['name'], item['p2']['name']])
                signature = f"{names[0]}|{names[1]}"
                
                if signature not in seen_pairs:
                    seen_pairs.add(signature)
                    final_res.append(item)
                
                # 只取前 3 个不重复的方案
                if len(final_res) >= 3: break
                
            return final_res

        # 分别生成稳健(WDL)和搏杀(Mix)的组合
        return make(wdl_pool, 'wdl'), make(mixed_pool, 'mix')

    def render_pc_odds_bar(self, odds_data):
        def get_trend_style(curr, init):
            if not init or init == 0: return "", ""
            pct = (curr - init) / init
            if pct < -0.05: return "background:#ffe6e6; color:#d0021b; font-weight:bold;", f"⬇ {abs(pct):.1%}"
            if pct < 0: return "color:#248a3d;", f"↓ {abs(pct):.1%}"
            if pct > 0.05: return "background:#e6f7ff; color:#007aff; font-weight:bold;", f"⬆ {abs(pct):.1%}"
            if pct > 0: return "color:#d70015;", f"↑ {abs(pct):.1%}"
            return "color:#999;", "-"

        def make_cell(name, curr, init):
            style, trend_txt = get_trend_style(curr, init)
            return f"""
            <div style="flex:1; text-align:center; padding:4px; margin:0 1px; border:1px solid #eee; border-radius:4px; {style}">
                <div style="font-size:10px; opacity:0.7;">{name}</div>
                <div style="font-size:13px; font-weight:bold;">{curr}</div>
                <div style="font-size:9px;">{trend_txt}</div>
            </div>
            """
        
        had_html = f"""
        <div style="display:flex; align-items:center; margin-bottom:4px;">
            <div style="width:30px; font-size:10px; font-weight:bold; color:#333; text-align:center;">胜平负</div>
            {make_cell("胜", odds_data['sw'], odds_data['sw_init'])}
            {make_cell("平", odds_data['sd'], odds_data['sd_init'])}
            {make_cell("负", odds_data['sl'], odds_data['sl_init'])}
        </div>
        """
        
        h_val = odds_data['handicap']
        h_color = "#248a3d" if h_val < 0 else "#d70015"
        h_badge = f"<div style='background:{h_color}; color:#fff; border-radius:50%; width:24px; height:24px; line-height:24px; text-align:center; font-size:10px; font-weight:bold;'>{h_val}</div>"
        
        hhad_html = f"""
        <div style="display:flex; align-items:center;">
            <div style="width:30px; display:flex; justify-content:center;">{h_badge}</div>
            {make_cell("让胜", odds_data['rw'], odds_data['rw_init'])}
            {make_cell("让平", odds_data['rd'], odds_data['rd_init'])}
            {make_cell("让负", odds_data['rl'], odds_data['rl_init'])}
        </div>
        """
        return f"<div style='background:#fafafa; padding:5px; border-radius:6px; border:1px solid #eee;'>{had_html}{hhad_html}</div>"

    def render_odds_trend(self, current, initial):
        if not current: return "-"
        style_curr = "font-weight:bold;font-size:14px;color:#333;"
        style_old = "color:#999;text-decoration:line-through;font-size:11px;margin-right:4px;"
        if not initial or initial == 0 or initial == current: return f"<span style='{style_curr}'>{current}</span>"
        pct = (current - initial) / initial * 100
        icon = "📉" if pct < 0 else "📈"
        color = "#248a3d" if pct < 0 else "#d70015"
        return f"""<span style='{style_old}'>{initial}</span>➝ <span style='{style_curr}'>{current}</span> <span style='font-size:10px;font-weight:bold;color:{color};margin-left:2px;'>{icon} {abs(pct):.0f}%</span>"""

    def analyze_winner_path_weighted(self, top_matches, handicap, top_spf_res, top_spf_prob):
        if top_matches is None or top_matches.empty: return None
        subset = top_matches[top_matches['胜平负结果'] == top_spf_res]
        subset_weight = subset['weight'].sum()
        if subset_weight == 0: return None
        
        grouped = subset.groupby('让球结果')['weight'].sum()
        rq_cond_stats = []
        for res in ['胜', '平', '负']:
            rq_cond_stats.append({'result': res, 'pct': grouped.get(res, 0) / subset_weight})
        rq_cond_stats.sort(key=lambda x: x['pct'], reverse=True)
        
        top_rq_res = rq_cond_stats[0]['result']
        top_rq_pct = rq_cond_stats[0]['pct']
        
        advice = ""; tag_cls = "tag-gray"; explain = ""
        
        if top_spf_res == '胜':
            if handicap < 0: 
                if top_rq_res == '胜': 
                    advice = "🚀 穿盘大胜"; tag_cls = "tag-fire"
                    explain = f"主胜概率 {top_spf_prob:.0%}，且其中 {top_rq_pct:.0%} 是穿盘大胜，信心十足。"
                elif top_rq_res == '平': 
                    advice = "⚠️ 赢球输盘"; tag_cls = "tag-orange"
                    explain = f"虽主胜概率 {top_spf_prob:.0%}，但 {top_rq_pct:.0%} 是一球小胜(让平)，谨防走水/输盘。"
                elif top_rq_res == '负': 
                    advice = "⛔ 只赢球不赢盘"; tag_cls = "tag-blue"
                    explain = "主队赢球能力有，但赢盘能力极差，不建议碰让球。"
            else: 
                advice = "🔥 爆冷赢球"; tag_cls = "tag-fire"
                explain = "受让方直接赢球，下盘超级稳胆。"
        elif top_spf_res == '负':
            if handicap > 0: 
                if top_rq_res == '平': 
                    advice = "👉 输球赢盘"; tag_cls = "tag-green"
                    explain = f"虽然输球，但 {top_rq_pct:.0%} 是小负，守住了受让盘。"
                elif top_rq_res == '负':
                    advice = "❄️ 惨败打穿"; tag_cls = "tag-blue"
                    explain = "防守极差，一输就是大比分，下盘也守不住。"
            else:
                advice = "❄️ 毫无悬念"; tag_cls = "tag-blue"
                explain = "强队难胜，直接去对面。"
        elif top_spf_res == '平':
            if handicap > 0: 
                advice = "🛡️ 下盘稳胆"; tag_cls = "tag-green"
                explain = "平局即赢盘，下盘非常稳健。"
            elif handicap < 0:
                advice = "❄️ 上盘必死"; tag_cls = "tag-blue"
                explain = "强队打平即输盘，去让负。"

        return {
            'advice': advice, 'tag_cls': tag_cls, 'explain': explain,
            'cond_stats': rq_cond_stats, 'top_spf_prob': top_spf_prob, 'top_spf_res': top_spf_res
        }

    def analyze_euro_asia_risk(self, odds_data, manual_info):
        """
        欧亚风控 + 市场凯利分析
        """
        if not manual_info or not odds_data: return None

        jc_w, jc_d, jc_l = odds_data.get('sw'), odds_data.get('sd'), odds_data.get('sl')
        avg_w, avg_d, avg_l = manual_info.get('avg_w'), manual_info.get('avg_d'), manual_info.get('avg_l')
        
        # 提取新读取的凯利值
        kw = manual_info.get('k_w', 0.95)
        kd = manual_info.get('k_d', 0.95)
        kl = manual_info.get('k_l', 0.95)

        if not (jc_w and avg_w and jc_w > 0 and avg_w > 0): return None

        res_list = []
        score_adj = 0
        
        # === 1. 欧亚折价率分析 (原有逻辑) ===
        items = [('胜', jc_w, avg_w), ('平', jc_d, avg_d), ('负', jc_l, avg_l)]
        for name, jc, avg in items:
            if avg == 0: continue
            ratio = jc / avg
            if jc < 2.50 and ratio > 0.95:
                res_list.append(f"⚠️ {name}诱盘(R:{ratio:.2f})")
                score_adj -= 2
            elif ratio < 0.83:
                res_list.append(f"🛡️ {name}防赔(R:{ratio:.2f})")
                score_adj += 1

        # === 2. 凯利指向性分析 (新增逻辑) ===
        # 逻辑：如果某一项的凯利值显著低于其他两项，说明庄家在该项风控最严
        
        # 找出最低的凯利值
        min_k = min(kw, kd, kl)
        
        # 只有当差异大于 0.03 时才认为有指向性 (防止 0.95 vs 0.94 这种噪音)
        diff_threshold = 0.03 
        
        if kw == min_k and (kd - kw) > diff_threshold and (kl - kw) > diff_threshold:
            # 凯利指向主胜 (例如：胜0.89 平0.96 负0.97)
            res_list.append(f"📉 凯利指胜({kw})")
            score_adj += 1.5
            
        elif kl == min_k and (kw - kl) > diff_threshold and (kd - kl) > diff_threshold:
            # 凯利指向客胜
            res_list.append(f"📉 凯利指负({kl})")
            
        # === 3. 凯利异常值检测 ===
        # 如果某项凯利值 > 1.0，代表赔付极高，通常是大坑
        if kw > 1.0: res_list.append(f"💣 主凯利爆表({kw})"); score_adj -= 3
        if kd > 1.0: res_list.append(f"💣 平凯利爆表({kd})")
        if kl > 1.0: res_list.append(f"💣 客凯利爆表({kl})")

        if not res_list: return None

        # 生成 HTML
        html_str = ""
        for tag in res_list:
            # 根据标签内容定色
            if "诱" in tag or "爆表" in tag: 
                bg="#fff1f0"; color="#d0021b"; border="#ffa39e" # 红
            elif "防赔" in tag or "指胜" in tag: 
                bg="#f6ffed"; color="#389e0d"; border="#b7eb8f" # 绿
            elif "指负" in tag:
                bg="#e6f7ff"; color="#0050b3"; border="#91d5ff" # 蓝
            else:
                bg="#f5f5f5"; color="#666"; border="#ddd"
                
            html_str += f"<span style='background:{bg};color:{color};border:1px solid {border};padding:1px 4px;border-radius:4px;font-size:10px;margin-right:4px;'>{tag}</span>"
        
        return {'html': html_str, 'adj': score_adj}

    def analyze_expert_strategies(self, odds_data, poisson_data, history_df, ess):
        """
        专家实战策略生成器
        """
        strategies = []
        sw = odds_data.get('sw')
        handicap = odds_data.get('handicap')
        
        # 基础数据准备
        if not sw or not poisson_data or history_df is None or history_df.empty:
            return ""

        # 1. xG 净胜球预测值
        xg_diff = poisson_data['lh'] - poisson_data['la']
        
        # 2. 历史同赔的冷门率 (平+负)
        total_weight = history_df['weight'].sum()
        upset_weight = history_df[history_df['胜平负结果'] != '胜']['weight'].sum()
        upset_rate = upset_weight / total_weight if total_weight > 0 else 0

        # === 策略一：蚊子肉避雷针 (Anti-Mosquito Trap) ===
        # 场景：主胜 < 1.45，但历史冷门率 > 30% 或 xG 优势不明显
        if sw < 1.45:
            if upset_rate > 0.30:
                strategies.append({'title': '💣 蚊子肉避雷', 'txt': f"低赔主胜({sw})历史冷门率达{upset_rate:.0%}，且ESS支持度{ess:.1f}，建议放弃或防平。", 'cls': 'tag-red'})
            elif xg_diff < 0.6: # xG 都不支持赢1个球
                strategies.append({'title': '⚠️ 虚高低赔', 'txt': f"赔率暗示必胜，但xG净胜仅{xg_diff:.2f}球，谨防平局。", 'cls': 'tag-orange'})

        # === 策略二：让负稳胆 (Handicap Loss Value) ===
        # 场景：主胜 1.70 - 2.15 (鸡肋区间)，竞彩强开主让-1
        # 逻辑：如果 xG 差距 < 0.8，且客队防守尚可，去下盘（让负）比博主胜划算太多
        if 1.70 <= sw <= 2.15 and handicap == -1:
            if xg_diff < 0.85:
                prob_rq_loss = poisson_data.get('rq_pl', 0) + poisson_data.get('rq_pd', 0) # 让平+让负
                strategies.append({'title': '💎 让负稳胆', 'txt': f"主队统治力不足(xG差{xg_diff:.2f})，难穿盘。推荐让球负(或让平)。", 'cls': 'tag-green'})

        # === 策略三：双平博单 (Double Draw) ===
        # 场景：势均力敌，赔率 2.60 - 3.00 - 2.60 左右
        # 逻辑：xG 预测平局概率高，且比分多指向 0:0, 1:1, 1:0
        if 2.50 <= sw <= 3.20 and abs(xg_diff) < 0.3:
            pd = poisson_data.get('pd', 0)
            if pd > 0.28:
                strategies.append({'title': '⚖️ 双平策略', 'txt': f"场面极度胶着，建议【平局 + 让球平】双选，覆盖1球小胜与平局。", 'cls': 'tag-blue'})

        # === 策略四：深盘无力 (Deep Handicap Risk) ===
        # 场景：让球 -2，但 xG 差距只有 1.2 左右
        if handicap <= -2 and xg_diff < 1.4:
             strategies.append({'title': '📉 深盘无力', 'txt': f"盘口深开让{handicap}，但xG数据不支持大胜，推荐让球客胜。", 'cls': 'tag-orange'})

        # 格式化输出
        html = ""
        for s in strategies:
            html += f"<div style='margin-top:4px;font-size:11px;padding:4px;background:#fff;border-left:3px solid #666;box-shadow:0 1px 2px rgba(0,0,0,0.05);'><span class='{s['cls']}'>{s['title']}</span> <span style='color:#555'>{s['txt']}</span></div>"
        
        return html

    def analyze_odds_sentiment(self, odds_data, history_df):
        """
        盘口情绪分析（盘口/赔率版）
        不使用 Elo 强弱判断，避免与当前策略口径冲突。
        """
        if history_df is None or history_df.empty:
            return {'title': '数据不足', 'txt': '历史样本不足', 'style': 'background:#eee;color:#999;font-size:11px;'}

        sw_curr, sw_init = odds_data.get('sw'), odds_data.get('sw_init')
        if not sw_curr or not sw_init: return None

        # === 仅用盘口/赔率定义主客强弱 ===
        sl_curr = odds_data.get('sl')
        handicap = odds_data.get('handicap', 0)
        # 优先看让球，其次看主/客胜赔率对比
        if handicap < 0:
            is_home_strong = True
        elif handicap > 0:
            is_home_strong = False
        else:
            is_home_strong = bool(sl_curr and sw_curr < sl_curr)
        identity = "盘口强势方" if is_home_strong else "盘口弱势方"
        
        # 计算赔率变化
        delta_sw = (sw_curr - sw_init) / sw_init 
        
        # 计算历史胜率 vs 理论概率
        implied_prob_h = 1 / sw_curr
        total_weight = history_df['weight'].sum()
        home_weight = history_df[history_df['胜平负结果'] == '胜']['weight'].sum()
        real_win_rate_h = home_weight / total_weight if total_weight > 0 else 0
        
        title = "数据平稳"; txt = "赔率与硬实力匹配，无异常。"; cls = "#f0f2f5; color:#666"

        # ==================================================
        # 场景 A: 主胜赔率大幅下降 (资金疯狂买入主胜)
        # ==================================================
        if delta_sw < -0.05: 
            if is_home_strong:
                # 盘口强势方降赔 (正路)
                if real_win_rate_h > (implied_prob_h + 0.05):
                    title = "🚀 众望所归"; cls = "#f6ffed; color:#389e0d; border:1px solid #b7eb8f"
                    txt = f"主队({identity})获资金支持降赔{delta_sw:.1%}，且历史胜率{real_win_rate_h:.0%}真实支撑，正路极稳。"
                else:
                    title = "🔥 强势方过热"; cls = "#fff0f0; color:#d0021b; border:1px solid #ffccc7"
                    txt = f"主队({identity})赔率骤降{delta_sw:.1%}，但历史胜率仅{real_win_rate_h:.0%}，热度虚高，谨防大热必死。"
            else:
                # 盘口弱势方降赔 (爆冷/诱下)
                if real_win_rate_h > 0.40:
                    title = "❄️ 爆冷预警"; cls = "#e6f7ff; color:#096dd9; border:1px solid #91d5ff"
                    txt = f"盘口弱势方(主)赔率异常骤降{delta_sw:.1%}，且历史有{real_win_rate_h:.0%}胜率，提防主胜爆冷。"
                else:
                    title = "🎣 诱下陷阱"; cls = "#fffbe6; color:#d48806; border:1px solid #ffe58f"
                    txt = f"盘口弱势方(主)却大幅降赔{delta_sw:.1%}，历史胜率极低，这是典型的诱导散户去下盘信号。"

        # ==================================================
        # 场景 B: 主胜赔率大幅上升 (资金抛弃主胜/阻上)
        # ==================================================
        elif delta_sw > 0.05:
            # 低赔升赔场景：先给中性提示，避免直接下“诱客/博主胜”结论
            if sw_curr <= 1.55:
                if real_win_rate_h >= implied_prob_h:
                    title = "⚠️ 低赔升幅警示"; cls = "#fffbe6; color:#d48806; border:1px solid #ffe58f"
                    txt = f"主胜仍处低赔({sw_curr:.2f})但较初赔上调{delta_sw:.1%}，资金与赔率出现分歧，建议控制仓位并防平。"
                else:
                    title = "📉 低赔走弱"; cls = "#fff1f0; color:#cf1322; border:1px solid #ffa39e"
                    txt = f"主胜低赔({sw_curr:.2f})仍上调{delta_sw:.1%}，且历史胜率{real_win_rate_h:.0%}未显著支撑，谨慎追主。"
                return {'title': title, 'txt': txt, 'style': f"background:{cls}; padding:6px; border-radius:4px; margin-top:6px; font-size:11px;"}

            if is_home_strong:
                # 盘口强势方升赔
                if real_win_rate_h > 0.60:
                    title = "🛡️ 强势方阻上"; cls = "#e6f7ff; color:#096dd9; border:1px solid #91d5ff"
                    txt = f"主队({identity})升赔{delta_sw:.1%}制造障碍，但硬实力与历史胜率({real_win_rate_h:.0%})足以支撑，庄家在阻挡上盘资金。"
                else:
                    title = "📉 真实看衰"; cls = "#fffbe6; color:#d48806; border:1px solid #ffe58f"
                    txt = f"主队({identity})赔率飙升，且历史统治力一般，基本面可能出了问题(如伤病)，建议放弃主胜。"
            else:
                # 盘口弱势方升赔
                if real_win_rate_h > 0.40:
                    title = "⚖️ 升赔分歧"; cls = "#fffbe6; color:#d48806; border:1px solid #ffe58f"
                    txt = f"主胜赔率上调{delta_sw:.1%}，但历史胜率仍有{real_win_rate_h:.0%}，信号分歧较大，建议降仓并防平。"
                else:
                    title = "💪 对手占优"; cls = "#f6ffed; color:#389e0d; border:1px solid #b7eb8f"
                    txt = f"盘口弱势方主胜赔率走高({delta_sw:.1%})，且历史胜率低迷，对手方向更占优。"

        return {'title': title, 'txt': txt, 'style': f"background:{cls}; padding:6px; border-radius:4px; margin-top:6px; font-size:11px;"}
    def process_logs_and_history(self, wdl_parlays, mixed_parlays, top_singles, all_matches_data, results=None):
        today_str = datetime.datetime.now().strftime("%Y-%m-%d")
        recomm_map = {}
        for s in top_singles: recomm_map[s['ti']] = 'Single'
        for p in wdl_parlays: recomm_map[p['p1']['name']] = 'Parlay_WDL'
        def format_score_trace(card):
            if not isinstance(card, list) or not card:
                return ""
            parts = []
            for it in card:
                if not isinstance(it, dict):
                    continue
                mod = str(it.get('module', ''))
                reason = str(it.get('reason', ''))
                try:
                    delta = float(it.get('delta', 0.0) or 0.0)
                except Exception:
                    delta = 0.0
                sign = "+" if delta >= 0 else ""
                parts.append(f"{mod}:{sign}{delta:.2f}({reason})")
            return " | ".join(parts)
        result_map = {}
        for r in (results or []):
            key = (str(r.get('lg', '')), str(r.get('ti', '')))
            result_map[key] = r
        
        log_rows = []
        for m in all_matches_data:
            key = (str(m.get('lg', '')), str(m.get('ti', '')))
            r = result_map.get(key, {})
            final_pick = (r.get('final_pick') or r.get('best_bet') or {})
            hard_hits = r.get('spf_hard_hits') or []
            soft_hits = r.get('spf_soft_hits') or []
            rec_type = recomm_map.get(m['ti'], 'NONE')
            spf_main = r.get('spf_stats_main') or []
            spf_top_prob = 0.0
            if spf_main:
                try:
                    spf_top_prob = float(spf_main[0].get('pct', 0) or 0)
                except Exception:
                    spf_top_prob = 0.0
            final_odds = final_pick.get('odds', 0) if isinstance(final_pick, dict) else 0
            final_prob = final_pick.get('prob', 0) if isinstance(final_pick, dict) else 0
            final_kelly = final_pick.get('kelly', 0) if isinstance(final_pick, dict) else 0
            score_card = r.get('score_card') or []
            try:
                score_card_json = json.dumps(score_card, ensure_ascii=False)
            except Exception:
                score_card_json = "[]"
            poi = m.get('poisson_data', {})
            odds = m.get('odds_data', {})
            log_rows.append({
                'Date': today_str, 'League': m['lg'], 'Match': m['ti'], 'Handicap': m['handicap'],
                'S_Odds': m['odds_data']['sw'], 'Sample': m['ess'],
                'Best_SPF': m['best_spf_sel'], 'SPF_Kelly': round(m['spf_kelly'], 3),
                'Best_RQ': m['best_rq_sel'],   'RQ_Kelly': round(m['rq_kelly'], 3),
                'Recomm_Type': rec_type,
                'Match_ID': m.get('match_id', ''),
                'Main_Score': round(float(r.get('score', 0) or 0), 3),
                'Main_Warn': r.get('warn', ''),
                'SPF_Top_Prob': round(spf_top_prob, 4),
                'SPF_Hard_Hits': "|".join(hard_hits),
                'SPF_Soft_Hits': "|".join(soft_hits),
                'SPF_Dyn_Bucket': r.get('spf_risk_bucket', ''),
                'SPF_Dyn_Band': r.get('spf_risk_band', ''),
                'SPF_Dyn_Source': r.get('spf_risk_source', ''),
                'Final_Kind': final_pick.get('kind', '-') if isinstance(final_pick, dict) else '-',
                'Final_Sel': final_pick.get('sel', '-') if isinstance(final_pick, dict) else '-',
                'Final_Odds': round(float(final_odds or 0), 4),
                'Final_Prob': round(float(final_prob or 0), 4),
                'Final_Kelly': round(float(final_kelly or 0), 4),
                'Score_Trace': format_score_trace(score_card),
                'Score_Card_JSON': score_card_json,
                # --- ML 模型训练特征落盘 ---
                'xG_Home': round(float(poi.get('lh') or 0), 3),
                'xG_Away': round(float(poi.get('la') or 0), 3),
                'Poi_W': round(float(poi.get('ph') or 0), 4),
                'Poi_D': round(float(poi.get('pd') or 0), 4),
                'Poi_L': round(float(poi.get('pl') or 0), 4),
                'Poi_RQ_W': round(float(poi.get('rq_ph') or 0), 4),
                'Poi_RQ_D': round(float(poi.get('rq_pd') or 0), 4),
                'Poi_RQ_L': round(float(poi.get('rq_pl') or 0), 4),
                'Odds_W_Init': float(odds.get('sw_init') or 0),
                'Odds_D_Init': float(odds.get('sd_init') or 0),
                'Odds_L_Init': float(odds.get('sl_init') or 0),
                'Odds_W_Curr': float(odds.get('sw') or 0),
                'Odds_D_Curr': float(odds.get('sd') or 0),
                'Odds_L_Curr': float(odds.get('sl') or 0),
                'Home_Elo': m.get('home_elo', ''),
                'Away_Elo': m.get('away_elo', ''),
            })
        if log_rows:
            new_log_df = pd.DataFrame(log_rows)
            if os.path.exists(FULL_LOG_FILE):
                try:
                    old_log_df = pd.read_excel(FULL_LOG_FILE)
                    merged = pd.concat([old_log_df, new_log_df], ignore_index=True, sort=False)

                    for col in ['Date', 'Match_ID', 'League', 'Match', 'Handicap']:
                        if col not in merged.columns:
                            merged[col] = ''
                        merged[col] = merged[col].fillna('').astype(str).str.strip()

                    use_match_id = merged['Match_ID'] != ''
                    merged['_dedupe_key'] = np.where(
                        use_match_id,
                        merged['Date'] + '|' + merged['Match_ID'],
                        merged['Date'] + '|' + merged['League'] + '|' + merged['Match'] + '|' + merged['Handicap']
                    )
                    merged = merged.drop_duplicates(subset=['_dedupe_key'], keep='last').drop(columns=['_dedupe_key'])
                    merged.to_excel(FULL_LOG_FILE, index=False)
                except Exception as e: print(f"⚠️ 写入全量日志失败({FULL_LOG_FILE}): {e}")
            else:
                try: new_log_df.to_excel(FULL_LOG_FILE, index=False)
                except Exception as e: print(f"⚠️ 创建全量日志失败({FULL_LOG_FILE}): {e}")
        return {'win_rate': 0, 'profit': 0, 'total': 0}

    def generate_html(self, results, wdl_parlays, mixed_parlays, stats):
        # 1. 定义字典的 HTML 内容
        dict_html = """
        <div id="dictModal" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:9999;">
            <div style="background:#fff;width:90%;max-width:600px;margin:50px auto;border-radius:8px;padding:15px;max-height:80vh;overflow-y:auto;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;border-bottom:1px solid #eee;padding-bottom:10px;">
                    <div style="font-weight:bold;font-size:16px;">📖 亚盘翻译字典 (主队让球视角)</div>
                    <div onclick="document.getElementById('dictModal').style.display='none'" style="cursor:pointer;font-size:20px;">×</div>
                </div>
                <table style="width:100%;border-collapse:collapse;font-size:12px;">
                    <tr style="background:#f5f5f5;"><th style="padding:5px;text-align:left;">盘口</th><th style="padding:5px;text-align:left;">俗称</th><th style="padding:5px;text-align:left;">输赢规则 (买上盘/让球方)</th></tr>
                    <tr><td style="border-bottom:1px solid #eee;padding:5px;">0</td><td>平手</td><td>赢球全赢，平局退本</td></tr>
                    <tr><td style="border-bottom:1px solid #eee;padding:5px;">-0.25</td><td>平/半</td><td>赢球全赢，<b>打平输一半</b></td></tr>
                    <tr><td style="border-bottom:1px solid #eee;padding:5px;">-0.5</td><td>半球</td><td><b>生死盘</b>：赢球全赢，打平全输</td></tr>
                    <tr><td style="border-bottom:1px solid #eee;padding:5px;">-0.75</td><td>半/一</td><td>赢2球全赢，<b>赢1球只赢一半</b></td></tr>
                    <tr><td style="border-bottom:1px solid #eee;padding:5px;">-1.0</td><td>一球</td><td>赢2球全赢，<b>赢1球走水(退本)</b></td></tr>
                    <tr><td style="border-bottom:1px solid #eee;padding:5px;">-1.25</td><td>一球/球半</td><td>赢2球全赢，<b>赢1球输一半</b></td></tr>
                    <tr><td style="border-bottom:1px solid #eee;padding:5px;">-1.5</td><td>球半</td><td>赢2球全赢，赢1球全输</td></tr>
                    <tr><td style="border-bottom:1px solid #eee;padding:5px;">-1.75</td><td>球半/两球</td><td>赢3球全赢，<b>赢2球只赢一半</b></td></tr>
                    <tr><td style="border-bottom:1px solid #eee;padding:5px;">-2.0</td><td>两球</td><td>赢3球全赢，赢2球走水</td></tr>
                </table>
                <div style="margin-top:10px;font-size:11px;color:#666;background:#fffbe6;padding:8px;border-radius:4px;">
                    💡 <b>记忆口诀：</b><br>
                    • <b>.25 (平/半)</b>：怕平局，平了要亏钱。<br>
                    • <b>.50 (半球)</b>：生死局，平局就是输。<br>
                    • <b>.75 (半/一)</b>：赢一个不过瘾，要赢两个才爽。<br>
                    • <b>1.0 (一球)</b>：赢一个等于没赢 (防平)。
                </div>
            </div>
        </div>
        """
        dashboard_panel = f"""
        <div class="dash-card" style="border-top: 3px solid #333; margin-bottom: 20px; background: #333; color: #fff;">
            <div style="text-align:center; padding:10px;">
                <div style="font-size:16px; font-weight:bold; color:#fff;">V104 Pro Expert</div>
                <div style="font-size:11px; color:#aaa; margin-bottom:8px;">去水修正 | 自适应搜索 | 泊松双核 | 熵值风控</div>
                <div onclick="document.getElementById('dictModal').style.display='block'" style="background:#f5a623;color:#fff;display:inline-block;padding:4px 12px;border-radius:15px;font-size:12px;font-weight:bold;cursor:pointer;">📖 打开盘口字典</div>
            </div>
        </div>
        {dict_html}
        """

        def build_card(title, plist, color_theme):
            if not plist: return f"<div style='color:#999;font-size:12px;text-align:center;padding:10px'>暂无{title}推荐</div>"
            html = f"<div class='col-title'>{title}</div><div class='parlay-container'>" 
            for idx, p in enumerate(plist):
                sel1 = p['p1']; opt1 = sel1.get('sel_disp', f"[{sel1['sel']}]")
                odds_str1 = self.render_odds_trend(sel1['odds'], sel1.get('odds_init'))
                sel2 = p['p2']; opt2 = sel2.get('sel_disp', f"[{sel2['sel']}]")
                odds_str2 = self.render_odds_trend(sel2['odds'], sel2.get('odds_init'))
                k_score = p['kelly_score'] * 100
                s = p['stake']
                badge = f"<span class='stake-badge {s['cls']}'>{s['stars']} {s['u']}u</span>"
                html += f"""<div class="dash-card parlay-card" style="border-top:3px solid {color_theme};"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;"><div style="font-size:12px;color:{color_theme};font-weight:bold;">方案 {idx+1} <span style="font-size:9px;color:#999;font-weight:normal;">(评分 {k_score:.0f})</span></div>{badge}</div><div style="margin-bottom:4px;border-bottom:1px dashed #eee;padding-bottom:4px;"><div style="font-size:12px;color:#333;font-weight:bold;">{sel1['name']} <span style="color:#007aff">{opt1}</span></div><div style="text-align:right;font-size:11px;">{odds_str1}</div></div><div><div style="font-size:12px;color:#333;font-weight:bold;">{sel2['name']} <span style="color:#007aff">{opt2}</span></div><div style="text-align:right;font-size:11px;">{odds_str2}</div></div><div style="margin-top:8px;background:#f9f9f9;padding:4px;text-align:center;border-radius:4px;font-size:13px;font-weight:bold;color:#333">2串1 总赔率: <span style="color:{color_theme};font-size:15px">{p['total_odds']:.2f}</span></div></div>"""
            html += "</div>"
            return html

        wdl_html = build_card("🛡️ 稳健理财 (只投胜平负)", wdl_parlays, "#248a3d")
        mixed_html = build_card("⚔️ 搏杀高赔 (只投让球)", mixed_parlays, "#d70015")

        top_picks = self._select_top_single_cards(results, limit=3)
        low_priority_picks = self._select_low_priority_single_cards(results, limit=6)
        singles_html = (
            "<div class='col-title' style='margin-top:10px'>重点参与</div>"
            "<div style='font-size:11px;color:#999;margin:4px 0 8px;'>"
            "仅保留稳胆 / 可博且过精选门槛的场次"
            "</div><div class='parlay-container'>"
        )
        for p in top_picks:
            h_str = f"让{p['handicap']}" if p['handicap'] < 0 else (f"受{p['handicap']}" if p['handicap'] > 0 else "平手")
            best_html = ""
            if p.get('best_bet'):
                bb = p['best_bet']
                odds_str = self.render_odds_trend(bb['odds'], bb.get('odds_init'))
                # 如果有熵值信息，显示出来
                entropy_info = ""
                if 'entropy' in bb: entropy_info = f" <span style='color:#999'>E:{bb['entropy']:.2f}</span>"
                best_html = f"<div style='margin-top:6px;padding:4px;background:#fff8e6;border:1px solid #f5a623;border-radius:4px;text-align:center;color:#d70015;font-size:11px;'>🎯 最佳: <b>{bb['sel_disp']}</b>{entropy_info}<br/>{odds_str}</div>"
            else:
                best_html = (
                    "<div style='margin-top:6px;padding:4px;background:#f5f5f5;"
                    "border:1px solid #d9d9d9;border-radius:4px;text-align:center;color:#666;font-size:11px;'>"
                    "⏸️ 暂无明确推荐，建议观望</div>"
                )
            
            # 双核警报的 Badge
            risk_badge = ""
            if p.get('risk_alert'):
                bg = "#ffccc7" if "诱盘" in p['risk_alert'] else "#d9f7be"
                col = "#d0021b" if "诱盘" in p['risk_alert'] else "#389e0d"
                risk_badge = f"<div style='background:{bg};color:{col};font-size:10px;padding:2px 4px;border-radius:4px;margin-top:2px;text-align:center;font-weight:bold;'>{p['risk_alert']}</div>"
            decision_level = p.get('decision_level') or {}
            decision_badge = ""
            if isinstance(decision_level, dict) and decision_level:
                badge_text = str(decision_level.get('badge_text') or decision_level.get('label') or '').strip()
                if badge_text:
                    decision_badge = (
                        f"<div style='margin-top:4px;font-size:10px;color:#666;text-align:center;'>"
                        f"决策等级：{badge_text}</div>"
                    )
            score_disp = fmt_score(p.get('score', 0.0))
            singles_html += f"""<div class="dash-card"><div style="font-size:11px;color:#999">{p['lg']}</div><div style="font-weight:bold;margin:2px 0;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">{p['ti']} <span style="color:#007aff;font-size:11px">{h_str}</span></div><div class="{p['tag_cls']}" style="display:inline-block;font-size:11px;padding:2px 6px">{p['warn']}</div>{risk_badge}{best_html}{decision_badge}<div style="font-size:10px;color:#d70015;margin-top:4px">★ 推荐指数: {score_disp}</div></div>"""
        if not top_picks:
            singles_html += (
                f"<div class='dash-card' style='color:#666;font-size:12px;text-align:center;padding:12px'>"
                f"当前无适合列入重点参与的场次（赔率≥{SINGLE_CARD_MIN_ODDS:.2f}，EV≥{SINGLE_CARD_MIN_EV:.2f}）</div>"
            )
        singles_html += "</div>"

        low_priority_html = ""
        if low_priority_picks:
            low_priority_html = (
                "<details style='margin-top:10px'>"
                "<summary style='cursor:pointer;font-size:13px;font-weight:bold;color:#ad6800;"
                "background:#fff7e6;border:1px solid #ffd591;padding:8px 10px;border-radius:8px;'>"
                "回避观察"
                "</summary>"
                "<div style='font-size:11px;color:#999;margin:8px 2px 0;'>"
                "分歧 / 回避EV / 回避风控 / 联赛屏蔽及未达精选门槛的场次统一收在这里"
                "</div>"
                "<div class='parlay-container' style='margin-top:8px;'>"
            )
            for p in low_priority_picks:
                bb = p.get('best_bet') or {}
                h_str = f"让{p['handicap']}" if p['handicap'] < 0 else (f"受{p['handicap']}" if p['handicap'] > 0 else "平手")
                odds_str = self.render_odds_trend(bb.get('odds', 0), bb.get('odds_init')) if bb else ""
                decision_level = p.get('decision_level') or {}
                level_text = str(decision_level.get('badge_text') or decision_level.get('label') or '').strip()
                level_reason = str(decision_level.get('reason') or '').strip()
                level_label = str(decision_level.get('label') or '').strip()
                if level_label in {"稳胆", "可博"} and not self._single_card_pass(p):
                    risk_text = "未达精选门槛"
                elif level_label == "回避EV":
                    risk_text = "性价比不足"
                elif level_label == "回避风控":
                    risk_text = "风控回避"
                elif level_label == "联赛屏蔽":
                    risk_text = "联赛屏蔽"
                elif level_label in {"无推荐", "放弃"}:
                    risk_text = "暂无方向"
                elif level_label == "分歧":
                    risk_text = "建议观察"
                else:
                    risk_text = str(p.get('risk_alert') or p.get('warn') or '低优先级').strip()
                level_line = f"{level_text} | {level_reason}" if level_reason else level_text
                pick_line = f"{bb.get('sel_disp', '')} {odds_str}".strip() if bb else "暂无明确推荐"
                low_priority_html += (
                    "<div class='dash-card' style='border-top:3px solid #ffd591;background:#fffdf7;'>"
                    f"<div style='font-size:11px;color:#999'>{p['lg']}</div>"
                    f"<div style='font-weight:bold;margin:2px 0;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'>{p['ti']} <span style='color:#ad6800;font-size:11px'>{h_str}</span></div>"
                    f"<div style='display:inline-block;font-size:11px;padding:2px 6px;background:#fff7e6;color:#ad6800;border-radius:10px;'>{risk_text}</div>"
                    f"<div style='margin-top:6px;font-size:11px;color:#333;'>当前处理：<b>{pick_line}</b></div>"
                    f"<div style='margin-top:4px;font-size:10px;color:#666;'>决策等级：{level_line}</div>"
                    "</div>"
                )
            low_priority_html += "</div></details>"

        rows = ""
        for idx, r in enumerate(results):
            row_id = f"match_{idx}"
            
            man = r.get('manual_show', {})
            man_html = ""
            if man:
                # 显示欧返 (RTP)
                rtp_val = man.get('avg_rtp', 0)
                if rtp_val > 0:
                    # 根据 RTP 高低变色
                    rtp_color = "#389e0d" if rtp_val > 0.95 else ("#d48806" if rtp_val < 0.91 else "#666")
                    man_html += f"<span style='color:#666'>欧返:</span> <b style='color:{rtp_color}'>{rtp_val:.1%}</b> <span style='margin-left:8px;color:#999'>|</span> "

                avg_w = man.get('avg_w', 0)
                if avg_w > 0: man_html += f"<span style='color:#666'>欧主:</span> <b>{avg_w:.2f}</b>"
                xg_h = man.get('xg_h')
                if xg_h is not None and xg_h != 0:
                    xg_color = "#d70015" if xg_h > 0 else "#248a3d"
                    man_html += f"<span style='margin-left:8px;color:#999'>|</span> <span style='color:#666'>xG:</span> <b style='color:{xg_color}'>{xg_h:+.1f}</b>"
                # 新增：显示联赛基准进球
                base_h = man.get('base_h')
                if base_h:
                    man_html += f"<span style='margin-left:8px;color:#999'>|</span> <span style='color:#666;font-size:10px'>基准: {base_h}/{man.get('base_a')}</span>"
            
            dashboard_html = ""
            if man_html:
                dashboard_html = f"""<div style="font-size:11px; background:#e6f7ff; border:1px solid #91d5ff; padding:4px 8px; border-radius:4px; margin-bottom:6px; display:flex; align-items:center; flex-wrap:wrap;">{man_html}</div>"""
            
            # --- 构建双核警报栏 ---
            risk_html_row = ""
            if r.get('risk_alert'):
                alert_txt = r['risk_alert']
                bg_style = "background:#fff1f0; border:1px solid #ffa39e; color:#cf1322;" # 默认红色(诱盘)
                if "共振" in alert_txt:
                    bg_style = "background:#f6ffed; border:1px solid #b7eb8f; color:#389e0d;" # 绿色(共振)
                elif "平局" in alert_txt:
                    bg_style = "background:#e6f7ff; border:1px solid #91d5ff; color:#0050b3;" # 蓝色(平局)
                
                risk_html_row = f"""<div style="{bg_style} padding:5px; border-radius:4px; font-size:11px; font-weight:bold; margin-bottom:6px; text-align:center;">{alert_txt}</div>"""

            # --- 新增 HTML 构建 ---
            # 1. 欧亚风控栏 (放在顶部信息栏下面，或者合并进去)
            ea_bar = ""
            if r.get('ea_risk_html'):
                ea_bar = f"<div style='margin-bottom:6px;'>{r['ea_risk_html']}</div>"

            # 2. 专家实战建议 (放在 决策建议 result-col 的最上方)
            kimi_html = ""
            if r.get('kimi_review_html'):
                kimi_html = r['kimi_review_html']
            expert_html = ""
            if r.get('expert_advice'):
                expert_html = r['expert_advice']
            # --------------------
            def render_bar(title, stats, roi_data=None, is_rq=False):
                if not stats: return "<div style='color:#ccc;font-size:11px'>暂无数据</div>"
                roi_html = ""
                if roi_data and roi_data['txt']:
                    k_color = "#333"; k_bg = "#eee"
                    if "⛔" in roi_data['tag'] or "混乱" in roi_data['tag']: k_color = "#d70015"; k_bg = "#fff0f0"
                    elif "💎" in roi_data['tag']: k_color = "#248a3d"; k_bg = "#e6ffec"
                    elif "✅" in roi_data['tag']: k_color = "#007aff"; k_bg = "#eef5ff"
                    roi_html = f"<div style='float:right;font-size:10px;color:{k_color};background:{k_bg};padding:1px 5px;'>{roi_data['tag']}</div>"
                
                bar_html = ""
                for item in stats:
                    pct = item['pct']
                    if pct < 0.01: continue
                    bg = {'胜':'#ff5e5e','平':'#4a90e2','负':'#50c878'}.get(item['result'], '#ccc')
                    disp_res = item['result']
                    if is_rq:
                        if disp_res == '胜': disp_res = "让胜"
                        elif disp_res == '平': disp_res = "让平"
                        elif disp_res == '负': disp_res = "让负"
                    bar_html += f"<div style='width:{pct*100:.1f}%;background:{bg};color:#fff;font-size:10px;display:flex;align-items:center;justify-content:center;border-right:1px solid #fff;'>{disp_res} {pct:.0%}</div>"
                return f"<div style='margin-bottom:8px;'><div style='font-size:11px;font-weight:bold;margin-bottom:2px;'>{title}</div>{roi_html}<div style='clear:both'></div><div style='display:flex;height:16px;border-radius:4px;overflow:hidden;background:#eee;'>{bar_html}</div></div>"

            flow_html = ""
            if r.get('path_analysis'):
                pa = r['path_analysis']
                w_spf = pa['top_spf_prob']
                spf_res = pa['top_spf_res']
                flow_bars = ""
                for item in pa['cond_stats']:
                    p = item['pct']
                    if p > 0.01:
                        c = {'胜':'#ff5e5e','平':'#4a90e2','负':'#50c878'}.get(item['result'], '#ccc')
                        lbl = f"让{item['result']}"
                        flow_bars += f"<div style='width:{p*100:.1f}%;background:{c};height:100%;border-right:1px solid #fff;color:#fff;font-size:9px;display:flex;align-items:center;justify-content:center;overflow:hidden;'>{lbl} {p:.0%}</div>"
                flow_html = f"""<div style="margin-top:8px;background:#f9f9f9;padding:6px;border-radius:6px;border:1px solid #eee;"><div style="font-size:10px;color:#666;margin-bottom:4px;"><span style="font-weight:bold;">🔍 条件让球 (基于主{spf_res}):</span> <span style="color:#333">主{spf_res}概率 {w_spf:.0%}</span></div><div style="width:100%;height:14px;background:#e0e0e0;border-radius:3px;overflow:hidden;display:flex;">{flow_bars}</div><div style="font-size:10px;color:#888;margin-top:4px;font-style:italic;">{pa['explain']}</div></div>"""

            # --- 构建泊松分布条 ---
            poisson_bar = ""
            poi = r.get('poisson')
            if poi:
                poi_stats = [
                    {'result': '胜', 'pct': poi['ph']},
                    {'result': '平', 'pct': poi['pd']},
                    {'result': '负', 'pct': poi['pl']}
                ]
                poi_stats.sort(key=lambda x: x['pct'], reverse=True)
                
                # 格式化波胆字符串，例如: "1:1(12%) 1:0(10%) 2:1(8%)"
                score_str = " ".join([f"{s['score']}({s['pct']:.0%})" for s in poi['scores']])
                
                # 将波胆显示在标题行，用灰色小字
                title_str = f"🔮 xG泊松 (λ:{poi['lh']:.1f}/{poi['la']:.1f}) <span style='float:right;color:#666;font-weight:normal;font-size:10px;'>🎯 {score_str}</span>"
                
                poisson_bar = render_bar(title_str, poi_stats, None, is_rq=False)

            main_spf = render_bar(
                f"🎯 主决策概率(统一) (ESS:{r['ess']:.1f})",
                r.get('spf_stats_main', r.get('spf_stats', [])),
                r['spf_roi']
            )
            hist_spf = render_bar(
                f"📜 历史相似(参考) (ESS:{r['ess']:.1f})",
                r.get('spf_stats_hist', r.get('spf_stats', [])),
                None
            )
            blend_spf = render_bar(
                "🧩 融合概率(展示)",
                r.get('spf_stats_blend', r.get('spf_stats', [])),
                None
            )
            # --- 新增：RQ 泊松条 ---
            rq_poisson_bar = ""
            if poi:
                rq_poi_stats = [
                    {'result': '胜', 'pct': poi.get('rq_ph', 0)},
                    {'result': '平', 'pct': poi.get('rq_pd', 0)},
                    {'result': '负', 'pct': poi.get('rq_pl', 0)}
                ]
                rq_poi_stats.sort(key=lambda x: x['pct'], reverse=True)
                # 标题
                rq_title = f"🔮 xG让球泊松 (让{r['handicap']})"
                rq_poisson_bar = render_bar(rq_title, rq_poi_stats, None, is_rq=True)

            hist_rq = render_bar("🌐 让球分布", r['rq_stats_indep'], r['rq_roi'], is_rq=True)
            ai_spf_bar = render_bar(f"🤖 AI预测", r['ai_spf'], None, is_rq=False)
            # --- 🔥 新增：RQ AI (让球) ---
            # is_rq=True 会自动把标签显示为 "让胜/让平/让负"
            ai_rq_bar = render_bar(f"🤖 AI预测(让球)", r['ai_rq'], None, is_rq=True)
            
            btn_cls = "view-btn" if r['sample'] > 0 else "view-btn btn-disabled"
            ess_val = r['ess']
            ess_cls = "ess-high" if ess_val > 6 else ("ess-low" if ess_val < 3 else "ess-mid")
            
            sent_html = ""
            if r.get('sentiment'):
                s = r['sentiment']
                sent_html = f"""<div style="{s['style']}"><b>{s['title']}：</b>{s['txt']}</div>"""
            
            row_html = f"""
            <div class="card {r['filters']}" onclick="toggle('{row_id}')">
                <div class="card-header">
                    <div style="font-weight:bold;">{r['lg']} | {r['ti']} <span style="color:#007aff">[{r['handicap']}]</span></div>
                    <div class="{r['tag_cls']}">{r['warn']}</div>
                </div>
                <div class="card-body">
                    <div class="stats-col">
                        {risk_html_row}
                        {dashboard_html}
                        {r['form_html']}  <!-- 近期状态/体能 -->
                        {r.get('injury_card_html', '')}
                        {r.get('schedule_card_html', '')}
                        {r.get('web_verification_html', '')}
                        {ea_bar}
                        {r['odds_bar']}
                        {r['bifa_html']}  <!-- 必发资金 -->
                        {r['pk_html']}    <!-- 亚盘对比 -->
                        {sent_html}
                        {main_spf}
                        {hist_spf}
                        {blend_spf}
                        {poisson_bar}
                        {rq_poisson_bar}
                        {ai_spf_bar}
                        {ai_rq_bar}
                        {flow_html}
                    </div>
                    <div style="width:1px;background:#eee;margin:0 10px;"></div>
                    <div class="result-col">
                        <!-- =========== 【修改位置 3】插入预测框 =========== -->
                        {r['best_bet_html']}
                        <!-- ============================================== -->

                        <div style="font-size:10px;color:#999;margin-bottom:5px;">💡 大模型预测与本地对照</div>
                        {kimi_html}
                        {expert_html}
                        {r['macro_risk'] if r['macro_risk'] else ''}
                        <div style="font-size:11px;background:#fff8e6;padding:5px;border-radius:4px;color:#666;">{r['explain']}</div>
                        {hist_rq}
                        <div style="margin-top:auto;text-align:right;"><span class="ess-badge {ess_cls}">ESS: {ess_val:.1f}</span></div>
                        <div style="text-align:right;margin-top:4px;"><span class="{btn_cls}">查看历史</span></div>
                    </div>
                </div>
                <div id="{row_id}" class="detail-panel" style="display:none;">{self.render_history_table(r['history_df'])}</div>
            </div>
            """
            rows += row_html

        html = f"""<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>V104 Expert Report</title><style>
        body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f0f2f5; padding: 10px; color: #333; }} 
        .main-container {{ max-width: 900px; margin: 0 auto; }}
        .parlay-container {{ display: flex; gap: 8px; overflow-x: auto; padding-bottom: 5px; }}
        .dash-card {{ background: #fff; padding: 10px; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.05); min-width: 160px; }}
        .parlay-card {{ background: #fff8e6; border-top: 3px solid #f5a623; }}
        .card {{ background: #fff; margin-bottom: 10px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); cursor:pointer; }} 
        .card-header {{ padding: 10px; background: #fafafa; border-bottom: 1px solid #eee; display:flex; justify-content:space-between; align-items:center; }} 
        .card-body {{ padding: 10px; display: flex; }} 
        .stats-col {{ flex: 6; }} 
        .result-col {{ flex: 4; display: flex; flex-direction: column; }} 
        .tag-fire {{ background: linear-gradient(135deg, #ff3b30, #ff9500); color: #fff; padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight:bold; }} 
        .tag-gray {{ background: #eee; color: #999; padding: 3px 8px; border-radius: 12px; font-size: 11px; }} 
        .tag-green {{ background: #e6ffec; color: #248a3d; border: 1px solid #248a3d; padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight:bold; }}
        .tag-orange {{ background: #fff8e6; color: #f5a623; border: 1px solid #f5a623; padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight:bold; }}
        .tag-blue {{ background: #eef5ff; color: #007aff; border: 1px solid #007aff; padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight:bold; }}
        .tag-red {{ background: #fff1f0; color: #cf1322; border: 1px solid #ffa39e; padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight:bold; }}
        .ess-badge {{ font-size: 10px; padding: 2px 6px; border-radius: 4px; color: #fff; font-weight: bold; }}
        .ess-high {{ background: #248a3d; }} .ess-mid {{ background: #f5a623; }} .ess-low {{ background: #d70015; }}
        .col-title {{ font-size: 11px; font-weight: bold; color: #999; margin-bottom: 5px; text-transform: uppercase; }}
        .stake-badge {{ font-size:10px; padding:2px 6px; border-radius:10px; font-weight:bold; color:#fff; }}
        .stake-high {{ background: #d70015; }} .stake-mid {{ background: #f5a623; }} .stake-low {{ background: #aaa; }}
        .mac-table {{ width: 100%; font-size: 11px; border-collapse: collapse; min-width: 600px; }}
        .mac-table th {{ background: #f5f5f5; color: #666; padding: 8px 10px; text-align: left; white-space: nowrap; }}
        .mac-table td {{ padding: 8px 10px; border-bottom: 1px solid #eee; color: #333; white-space: nowrap; }}
        .panlu-win {{ color: #fff; background: #d70015; padding: 2px 6px; border-radius: 4px; font-weight: bold; font-size: 10px; }}
        .panlu-loss {{ color: #fff; background: #248a3d; padding: 2px 6px; border-radius: 4px; font-weight: bold; font-size: 10px; }}
        .panlu-draw {{ color: #fff; background: #007aff; padding: 2px 6px; border-radius: 4px; font-weight: bold; font-size: 10px; }}
        .res-win {{ color: #d70015; font-weight: bold; }} .res-loss {{ color: #248a3d; font-weight: bold; }} .res-draw {{ color: #007aff; font-weight: bold; }}
        .view-btn {{ font-size: 11px; color: #666; background: #f0f0f0; padding: 4px 10px; border-radius: 12px; cursor: pointer; }}
        </style><script>function toggle(id){{var e=document.getElementById(id);e.style.display=e.style.display==='none'?'block':'none';}}</script></head><body><div class="main-container">{dashboard_panel}{wdl_html}<div style="height:10px"></div>{mixed_html}{singles_html}{low_priority_html}{rows}</div></body></html>"""
        with open(OUTPUT_HTML, 'w', encoding='utf-8') as f: f.write(html)
        print(f"\n🎉 V104 Pro Expert Report Updated: {OUTPUT_HTML}")

    def render_history_table(self, df):
        if df is None or df.empty: return "<div style='padding:10px;color:#999'>无历史数据</div>"
        count = len(df)
        rows = ""
        for _, r in df.iterrows():
            rq_res = r.get('让球结果')
            panlu = "-"
            if rq_res == '胜': panlu = "<span class='panlu-win'>🔴让胜</span>"
            elif rq_res == '平': panlu = "<span class='panlu-draw'>🔵让平</span>"
            elif rq_res == '负': panlu = "<span class='panlu-loss'>🟢让负</span>"

            spf_res = r.get('胜平负结果')
            spf_cls = ""
            if spf_res == '胜': spf_cls = "res-win"
            elif spf_res == '平': spf_cls = "res-draw"
            elif spf_res == '负': spf_cls = "res-loss"

            final_odds = f"{r.get('胜平负-最终-胜')}/{r.get('胜平负-最终-平')}/{r.get('胜平负-最终-负')}"
            rq_line = r.get('让球')
            rq_w = r.get('让球-最终-胜')
            rq_d = r.get('让球-最终-平')
            rq_l = r.get('让球-最终-负')
            if pd.isna(rq_line) or pd.isna(rq_w) or pd.isna(rq_d) or pd.isna(rq_l):
                rq_odds = "-"
            else:
                rq_odds = f"({rq_line}) {rq_w}/{rq_d}/{rq_l}"
            
            prem = r.get('cr_ratio', 0)
            rows += f"""<tr><td>{r.get('联赛类型')}</td><td>{r.get('主队')} vs {r.get('客队')}</td><td style='font-weight:bold'>{r.get('比分')}</td><td class='{spf_cls}'>{spf_res}</td><td>{panlu}</td><td style='color:#666;font-size:10px'>{final_odds}</td><td style='color:#666;font-size:10px'>{rq_odds}</td><td style='color:#999;font-size:10px'>溢价:{prem:.2f}</td><td style='color:#666;font-size:10px'>W:{r.get('weight',0):.2f}</td></tr>"""
        
        return f"""<div style="padding:10px;background:#fff;border-bottom:1px solid #eee;font-weight:bold;color:#333;">共找到 {count} 场结构与趋势相似比赛</div><table class="mac-table"><thead><tr><th>联赛</th><th>对阵</th><th>比分</th><th>赛果</th><th>盘路</th><th>胜平负赔</th><th>让球赔</th><th>特征</th><th>权重</th></tr></thead><tbody>{rows}</tbody></table>"""

    def run(self):
        t0_all = time.time()
        t0 = time.time()
        if not self.preflight_inputs(): return
        print(f"⏱️ 健康检查完成: {time.time() - t0:.2f}s")

        t0 = time.time()
        if not self.load_data(): return
        print(f"⏱️ 历史数据加载+训练完成: {time.time() - t0:.2f}s")

        t0 = time.time()
        try:
            with open(ODDS_FILE, 'r', encoding='utf-8') as f: matches = json.load(f)
        except Exception as e:
            print(f"❌ 读取赔率文件失败 ({ODDS_FILE}): {e}")
            return

        # =========== 【修改位置 3-A】加载新数据 ===========
        dynamic_map = self.load_match_excel_data() # 加载Excel数据
        dynamic_json_map = self.load_match_json_data()
        full_context_map = self.load_match_context_full()
        if dynamic_json_map:
            for m_id, extra in dynamic_json_map.items():
                base = dynamic_map.get(m_id, {}) or {}
                if isinstance(base, dict):
                    base.update(extra)
                    dynamic_map[m_id] = base
        if full_context_map:
            for m_id, extra in full_context_map.items():
                base = dynamic_map.get(m_id, {}) or {}
                if isinstance(base, dict):
                    base['full_context'] = extra
                    dynamic_map[m_id] = base
        # ===============================================

        bifa_db = self.load_bifa_data()

        pankou_db = self.load_pankou_data()
        print(f"⏱️ 赛前辅助数据加载完成: {time.time() - t0:.2f}s")

        print(f"🔍 扫描 {len(matches)} 场比赛 (V104 Pro Expert)...")
        results = []; wdl_candidates = []; mixed_candidates = []; all_matches_data = []
        spf_risk_cfg = resolve_spf_risk_profile()
        spf_hard_rules = spf_risk_cfg['hard_rules']
        spf_hard_threshold = spf_risk_cfg['hard_threshold']
        spf_soft_penalty = spf_risk_cfg['soft_penalty']
        spf_enabled_rules = spf_risk_cfg.get('enabled_rules', set())
        dyn_bucket_cnt = len((self.spf_dynamic_thresholds or {}).get('thresholds_by_bucket', {}))
        print(
            f"🧱 SPF风控模式: {spf_risk_cfg['mode']} | "
            f"硬规则={','.join(sorted(spf_hard_rules)) if spf_hard_rules else '无'} | "
            f"阈值={spf_hard_threshold}"
        )
        print(
            f"🧩 SPF规则白名单: 软规则={','.join(sorted(spf_soft_penalty.keys())) if spf_soft_penalty else '无'}"
        )
        print(
            f"🧮 SPF动态阈值: {'开启' if USE_DYNAMIC_SPF_THRESHOLDS else '关闭'} | "
            f"文件={SPF_DYNAMIC_THRESHOLDS_FILE} | 桶数={dyn_bucket_cnt}"
        )
        t0_loop = time.time()
        llm_prediction_calls = 0
        llm_max_matches = _get_llm_max_matches()
        llm_min_odds = _get_llm_min_odds()
        llm_limit_text = f"最多{llm_max_matches}场" if llm_max_matches else "不限场次"
        print(f"🤖 大模型门禁: 候选赔率≥{llm_min_odds:.2f} | {llm_limit_text}")
        USE_LLM = os.environ.get("USE_KIMI_REVIEW", "1").strip().lower() not in {"0", "false", "no"}
        llm_engine_enabled = False
        if USE_LLM:
            try:
                getattr(self, 'kimi_engine')
            except AttributeError:
                from llm_engine import KimiAnalyzer
                self.kimi_engine = KimiAnalyzer()
            llm_engine_enabled = bool(getattr(self.kimi_engine, "enabled", False))
        
        for idx, m in enumerate(matches, start=1):
            odds_data = self.parse_json(m)
            if odds_data['sw'] is None: continue
            # ===========【修改位置 1】在此处添加初始化 ===========
            rec_score = 0  # <--- 必须先定义它，初始为0
            score_card = []

            def add_score(delta, reason, module="general"):
                nonlocal rec_score
                try:
                    d = float(delta)
                except Exception:
                    return
                if abs(d) < 1e-12:
                    return
                rec_score += d
                score_card.append({
                    'module': str(module),
                    'delta': d,
                    'reason': str(reason),
                    'after': float(rec_score),
                })

            def cap_score_max(max_value, reason, module="cap"):
                nonlocal rec_score
                try:
                    mval = float(max_value)
                except Exception:
                    return
                old = float(rec_score)
                rec_score = min(rec_score, mval)
                if rec_score != old:
                    score_card.append({
                        'module': str(module),
                        'delta': float(rec_score - old),
                        'reason': str(reason),
                        'after': float(rec_score),
                    })

            is_kill_home = False # 否决主胜标志 (红牌)
            is_kill_away = False # 否决客胜标志 (红牌)
            veto_reason = ""     # 否决原因
            asia_decision = {
                'score_delta': 0.0,
                'notes': [],
                'kill_sides': set(),
                'veto_reason': ""
            }
            # SPF 风控默认值（用于日志输出，避免分支缺失）
            hard_hits = []
            soft_hits = []
            spf_rule_cfg = {
                'bucket': '',
                'band': '',
                'source': '',
                'prob_min': 0.0,
                'ev_min': 0.0,
            }

            def add_asia_signal(score_delta=0.0, note="", kill_side=None, kill_reason=""):
                asia_decision['score_delta'] += float(score_delta)
                if note:
                    asia_decision['notes'].append(note)
                if kill_side in ('home', 'away'):
                    asia_decision['kill_sides'].add(kill_side)
                if kill_reason and not asia_decision['veto_reason']:
                    asia_decision['veto_reason'] = kill_reason
            # ==================================================
            lg = m.get('league', '')
            match_name = m.get('display_name', '').replace(f"{lg}: ", "")
            league_prof = self.league_profiles.get(lg, {'tags': [], 'fav_rate': -1})
            
            h_name = ""; a_name = ""
            try:
                if 'homeTeam' in m: h_name = m['homeTeam']; a_name = m['awayTeam']
                else: 
                    parts = m.get('display_name', '').split('vs'); h_name = parts[0].split(':')[-1].strip(); a_name = parts[1].strip()
            except Exception as e:
                print(f"⚠️ 队名解析失败: {m.get('display_name', '')} ({e})")

            # =========== 【修改位置 3-B】获取当前比赛的动态数据 ===========
            # 用 matchId 精准匹配
            # 1. 尝试获取 ID (兼容 matchId 和 match_id)
            raw_id = m.get('matchId') or m.get('match_id')
            
            # 2. 强制转为整数 (int)，确保能匹配上 Excel 的键
            try:
                m_id = int(raw_id)
            except Exception:
                m_id = 0
            dyn_info = dynamic_map.get(m_id) # 获取该场比赛的Excel数据
            
            # 定义几个变量备用
            h_recent_lam = None
            a_recent_lam = None
            fatigue_penalty = 0
            history_alert = ""
            fatigue_txt = ""
            # 作用域安全默认值：避免后续分支调整后触发未定义变量
            h_rest = 99
            a_rest = 99
            theory_line = 0.0
            ref_odds = 0.0
            # 显式初始化：避免 locals() 反模式
            bf_data = None
            pk_info = None
        
            
            if dyn_info:
                # 1. 准备近期状态 Lam (用于后续修正泊松)
                # 进球能力 + (对手失球能力/联赛平均? 这里简化处理，直接用近期场均进球)
                h_recent_lam = dyn_info['h_recent']['gf']
                a_recent_lam = dyn_info['a_recent']['gf']
                
                # 2. 计算体能 (假设当前比赛时间是今天，或者你从m里解析比赛时间)
                # 这里我们简单假设比赛是 "2026-01-22" (根据你的上下文)
                # 实际建议：current_date = datetime.datetime.strptime(m['matchTime'][:10], "%Y-%m-%d")
                try:
                    # 尝试从 JSON 数据中获取比赛时间 (字段名通常是 matchDate 或 matchTime)
                    # 格式通常为 "2026-01-26 20:00:00" 或 "2026-01-26"
                    m_date_str = m.get('matchDate') or m.get('matchTime') or m.get('time')
                    
                    if m_date_str:
                        # 只取前10位 (YYYY-MM-DD)
                        current_match_date = datetime.datetime.strptime(str(m_date_str)[:10], "%Y-%m-%d")
                    else:
                        # 如果JSON里没时间，就用今天的系统时间
                        current_match_date = datetime.datetime.now()
                except Exception:
                    # 如果解析出错，也兜底用系统时间
                    current_match_date = datetime.datetime.now()

                    
                def check_rest(last_d_str):
                    if not last_d_str: return 99
                    try:
                        ld = datetime.datetime.strptime(last_d_str, "%Y-%m-%d")
                        return (current_match_date - ld).days
                    except Exception: return 99

                h_rest = check_rest(dyn_info['fatigue']['h_date'])
                a_rest = check_rest(dyn_info['fatigue']['a_date'])
                
                if h_rest < 3: 
                    fatigue_penalty += 1.5
                    fatigue_txt += f"<br>📉 <b>主队疲劳：</b>仅休息{h_rest}天。"
                if a_rest < 3:
                    # 客队疲劳对主队有利，给推荐分加分? 或者不做处理，只在分析里写
                    fatigue_txt += f"<br>📉 <b>客队疲劳：</b>仅休息{a_rest}天。"

                # 3. 简单的历史克星判定
                # 简单粗暴：如果历史字符串里，主队没赢过 (假设文本里有比分)
                # 这一步比较复杂，如果不确信文本格式，可以先只打印出来
                # 这里只做简单关键词匹配
                hist_str = dyn_info['history_raw']
                # 比如判断主队是否输多赢少，这里留给你后续完善逻辑
                if hist_str:
                    # 暂时只做展示，不自动扣分，防止误判
                    pass
            # ==========================================================
            # 匹配人工数据：优先主客队精确对阵，其次主队兜底
            manual_info = None
            if self.manual_data:
                def _norm_team_local(s):
                    t = str(s or "").strip().lower()
                    t = t.replace("FC", "").replace("fc", "").replace(" ", "")
                    t = t.replace("（", "(").replace("）", ")")
                    t = re.sub(r"[·\\-\\.()]", "", t)
                    return t

                n_h = _norm_team_local(h_name)
                n_a = _norm_team_local(a_name)

                if n_h and n_a:
                    manual_info = self.manual_data.get(f"__PAIR__{n_h}|{n_a}")
                if not manual_info and n_h:
                    manual_info = self.manual_data.get(f"__HOME__{n_h}")
                if not manual_info:
                    manual_info = self.manual_data.get(f"{h_name} VS {a_name}")
                if not manual_info:
                    # 最后兜底：兼容历史键值结构
                    for key, info in self.manual_data.items():
                        if not isinstance(key, str) or key.startswith("__"):
                            continue
                        if key in h_name or h_name in key:
                            manual_info = info
                            break

            # ==========================================
            # 🔥 专家级双核驱动：RQ独立匹配
            # ==========================================
            tier = self.assign_tier(lg)
            
            # SPF 核心 (胜平负专攻, market='spf')
            top_spf, ess_spf, _, focus_side = self.calculate_3d_weights(odds_data, lg, h_name, a_name, market='spf')
            
            # RQ 核心 (让球专攻, market='rq')
            # 优化点 1: RQ 独立匹配，不再用 SPF 骨架
            top_rq, ess_rq, _, _ = self.calculate_3d_weights(odds_data, lg, h_name, a_name, market='rq')

            # HTML展示主要以 SPF 样本为主
            top_matches, ess = top_spf, ess_spf

            # 统计
            curr_pw, curr_pd, curr_pl = self._get_true_probs(odds_data['sw'], odds_data['sd'], odds_data['sl'])
            if curr_pw is None:
                # 赔率/概率异常：直接跳过，避免污染近邻与平滑先验
                continue
            # 优化 2.1: SPF 使用联赛基底先验，消除市场概率双重计入
            # 回测验证: ROI 从 -8.34% → -3.64% (+4.7pp)
            SPF_LEAGUE_BASE = {
                'Tier1': {'胜': 0.424, '平': 0.250, '负': 0.326},
                'Tier2': {'胜': 0.390, '平': 0.279, '负': 0.331},
                'Tier3': {'胜': 0.449, '平': 0.240, '负': 0.311},
                'Tier4': {'胜': 0.392, '平': 0.234, '负': 0.374},
                'Other': {'胜': 0.431, '平': 0.240, '负': 0.328},
            }
            prior_spf = SPF_LEAGUE_BASE.get(tier, SPF_LEAGUE_BASE['Other'])
            # RQ 保持市场先验（回测证实 RQ 用市场先验更优）
            prior_rq = None
            if odds_data.get('rw') and odds_data.get('rd') and odds_data.get('rl'):
                rpw, rpd, rpl = self._get_true_probs_rq(odds_data['rw'], odds_data['rd'], odds_data['rl'])
                if rpw is not None:
                    prior_rq = {'胜': rpw, '平': rpd, '负': rpl}
            # 优化点 4: 传入 ess，启用动态 C（先用历史近邻得到基础分布）
            spf_stats_hist = self.get_weighted_stats(top_spf, '胜平负结果', ess=ess_spf, prior_probs=prior_spf)
            rq_stats_weighted = self.get_weighted_stats(top_rq, '让球结果', ess=ess_rq, prior_probs=prior_rq)

            # 主决策概率统一：历史相似 + 市场 + AI（先不引入后置修正项）
            ai_spf, ai_rq = self.get_ai_detailed(odds_data, lg)
            if not spf_stats_hist:
                spf_stats_hist = [{'result': '无', 'pct': 0}]
            mix_main_probs = self.blend_spf_probs(
                spf_stats_hist,
                prior_spf,
                ai_spf,
                None,
                odds_data=odds_data
            )
            spf_stats_main = [
                {'result': '胜', 'pct': mix_main_probs['胜']},
                {'result': '平', 'pct': mix_main_probs['平']},
                {'result': '负', 'pct': mix_main_probs['负']}
            ]
            spf_stats_main.sort(key=lambda x: x['pct'], reverse=True)
            
            path_analysis = None
            if spf_stats_main:
                top_spf_res = spf_stats_main[0]['result']
                top_spf_prob = spf_stats_main[0]['pct']
                path_analysis = self.analyze_winner_path_weighted(top_spf, odds_data['handicap'], top_spf_res, top_spf_prob)
            
            rq_calc_stats = [{'result': x['result'], 'pct': x['pct']} for x in rq_stats_weighted]

            spf_roi, spf_roi_txt, spf_kelly, spf_kelly_tag, spf_conf, spf_raw = self.calculate_kelly_roi_raw(spf_stats_main, odds_data, ess_spf, 'spf')
            rq_roi, rq_roi_txt, rq_kelly, rq_kelly_tag, rq_conf, rq_raw = self.calculate_kelly_roi_raw(rq_calc_stats, odds_data, ess_rq, 'rq')
            
            sample_count = len(top_spf) if top_spf is not None else 0
            warn = "⚠️ 观察"; tag_cls = "tag-gray"; explain_txt = "无明显倾向"; kimi_review_html = ""; web_verification_html = ""
            
            if sample_count < MIN_SAMPLES:
                warn = "⚠️ 数据不足"; tag_cls = "tag-gray"; explain_txt = "未找到足够的同结构样本。"
                spf_raw = None; rq_raw = None
            else:
                if path_analysis: warn = path_analysis['advice']; tag_cls = path_analysis['tag_cls']; explain_txt = path_analysis['explain']
                else: spf_r = spf_raw.get('reason', '无'); explain_txt = f"未达标: {spf_r}"

            explain_txt += fatigue_txt
            best_bet = None
            max_kelly = -999
            # 动态阈值：按 Tier x 赔率段 获取当前SPF门槛
            spf_gate_cfg = self.resolve_spf_thresholds(tier, odds_data.get('sw', 2.0))
            if spf_stats_main and len(spf_stats_main) > 0:
                spf_top_sel_for_gate = spf_stats_main[0]['result']
                spf_top_odds_for_gate = {
                    '胜': odds_data.get('sw', 0),
                    '平': odds_data.get('sd', 0),
                    '负': odds_data.get('sl', 0),
                }.get(spf_top_sel_for_gate, odds_data.get('sw', 2.0))
                if spf_top_odds_for_gate and spf_top_odds_for_gate > 0:
                    spf_gate_cfg = self.resolve_spf_thresholds(tier, spf_top_odds_for_gate)
            
            # 熵值检测
            is_chaotic = False
            if spf_stats_main and len(spf_stats_main) > 1:
                top = spf_stats_main[0]; second = spf_stats_main[1]
                if top['pct'] < spf_gate_cfg['top_min'] or (top['pct'] - second['pct']) < spf_gate_cfg['gap_min']:
                    is_chaotic = True; warn = "⚠️ 混乱"; tag_cls = "tag-gray"
                    explain_txt = "分布离散，无倾向。" + (f"<br>{explain_txt}" if explain_txt else "")
            
            if spf_raw and spf_raw['kelly'] > max_kelly and spf_raw['kelly'] > 0:
                max_kelly = spf_raw['kelly']; spf_raw['sel_disp'] = f"[{spf_raw['sel']}]"; best_bet = spf_raw
            if rq_raw and rq_raw['kelly'] > max_kelly and rq_raw['kelly'] > 0:
                max_kelly = rq_raw['kelly']; h = odds_data['handicap']
                rq_raw['sel_disp'] = f"[让{rq_raw['sel']} {h}]"; best_bet = rq_raw
            

            # ==========================================
            # 模块 A/B: 风控重构 (RiskEngine)
            # ==========================================
            context = {
                'tier': tier,
                'manual_info': manual_info,
                'match_name': match_name
            }
            
            # --- 人工风控评估 ---
            is_manual_vetoed, manual_limits, manual_explains = self.risk_engine.evaluate_manual_info(odds_data, manual_info)
            for txt in manual_explains:
                explain_txt += f"<br>{txt}"
                
            if is_manual_vetoed:
                if manual_limits.get('胜') and best_bet and best_bet.get('sel') == '胜': best_bet = None
                if manual_limits.get('平') and best_bet and best_bet.get('sel') == '平': best_bet = None
                if manual_limits.get('负') and best_bet and best_bet.get('sel') == '负': best_bet = None

            # --- SPF评估 ---
            spf_top_res = spf_stats_main[0]['result'] if spf_stats_main else '无'
            if spf_raw:
                spf_raw['name'] = match_name; spf_raw['handicap'] = odds_data['handicap']; spf_raw['ess'] = ess_spf
                spf_raw['stats'] = spf_stats_main
                
                is_spf_vetoed, spf_hit_rules, spf_explains = self.risk_engine.evaluate_spf(spf_raw, context)
                for txt in spf_explains:
                    explain_txt += f"<br>{txt}"
                    
                if is_spf_vetoed:
                    if best_bet and best_bet.get('kind') == 'spf':
                        best_bet = None
                else:
                    spf_raw['sel_disp'] = f"[{spf_raw['sel']}]"
                    if not best_bet:
                        best_bet = spf_raw
                    wdl_candidates.append(spf_raw)
                    
                if spf_hit_rules:
                    explain_txt += f"<br><span style='color:#999;font-size:10px'>[SPF风控]: {','.join(spf_hit_rules)}</span>"

            # --- RQ评估 ---
            if rq_raw and rq_raw['kelly'] > 0:
                rq_raw['name'] = match_name; rq_raw['handicap'] = odds_data['handicap']; rq_raw['ess'] = ess_rq
                is_rq_vetoed, rq_reason, rq_explains = self.risk_engine.evaluate_rq(rq_raw, context, spf_top_res)
                
                for txt in rq_explains:
                    explain_txt += f"<br>{txt}"
                    
                if not is_rq_vetoed:
                    rq_raw['sel_disp'] = f"[让{rq_raw['sel']} {rq_raw['handicap']}]"
                    mixed_candidates.append(rq_raw)
                    if not best_bet:
                        best_bet = rq_raw

            # ==========================================
            # 🔥 【修改位置 3】 高级泊松分布模块 + 价值校验
            # ==========================================
            poisson_data = None
            risk_alert = ""
            
            # --- A. 启动高级泊松计算 (基于新的3个Excel文件) ---
            
            # 1. 寻找联赛基准 (如果找不到，使用通用的保守值)
            # 尝试模糊匹配联赛名 (如 "英超" 匹配 "英格兰超级联赛")
            lg_stat = self.lg_data.get(lg)
            if not lg_stat:
                for k, v in self.lg_data.items():
                    if k in lg or lg in k:
                        lg_stat = v
                        break
            
            if not lg_stat:
                lg_base_h = 1.50 # 默认保底值
                lg_base_a = 1.20
            else:
                lg_base_h = lg_stat['avg_home']
                lg_base_a = lg_stat['avg_away']

            # 2. 寻找两队xG数据 (核心：队名匹配)
            # 国家队比赛跳过xG查找（xG库是俱乐部级的，国家队查不到属于正常情况）
            _NATIONAL_KEYWORDS = (
                '国际友谊', '友谊赛', '世预赛', '世界杯', '欧洲杯', '欧国联',
                '亚洲杯', '亚预赛', '美洲杯', '非洲杯', '中北美金杯',
                '东南亚杯', '奥运会', '东亚杯', '南美预选', '欧预赛',
            )
            is_national = any(kw in lg for kw in _NATIONAL_KEYWORDS)

            def get_team_stats(target_name):
                if is_national:
                    return None
                # A. 精确匹配
                if target_name in self.xg_data: return self.xg_data[target_name]
                # B. 模糊匹配 (包含关系)
                for k, v in self.xg_data.items():
                    if k in target_name or target_name in k:
                        return v
                return None

            h_stats = get_team_stats(h_name)
            a_stats = get_team_stats(a_name)

            # 3. 只有当两队数据都齐全时，才启动计算
            if h_stats and a_stats:
                # --- 核心算法：攻击力 x 防守系数 (乘法模型) ---
                
                # 逻辑：综合实力 = 60%赛季xG(底蕴) + 20%近5场数据(状态)
                # ==========================================================
                
                # 1. 获取基础数据
                # 赛季底蕴 (Base Strength) - 权重 0.8
                season_h_xg = h_stats['home_xg']
                season_a_xga = a_stats['away_xga']
                
                # 近期状态 (Recent Form) - 权重 0.2
                # 如果没有动态数据，就完全回退到赛季数据，保证安全
                if dyn_info:
                    rec_h_gf = dyn_info['h_recent']['gf']
                    rec_a_ga = dyn_info['a_recent']['ga']
                else:
                    rec_h_gf = season_h_xg
                    rec_a_ga = season_a_xga
                
                # ==========================================================
                # 🛡️ 稳健融合算法 (Conservative Fusion)
                # ==========================================================
                
                # 步骤 A: 极值抑制 (Clamping)
                # 逻辑：近期数据不能偏离赛季数据太远。
                # 如果赛季xG是1.5，近期居然踢出3.0？我们强制把它压到 1.5 * 1.5 = 2.25，不信它能一直这么猛
                
                def clamp_val(base, new_val):
                    if base == 0: return new_val
                    # 允许最大波动范围：上下 50%
                    upper = base * 1.5
                    lower = base * 0.5
                    return max(lower, min(upper, new_val))
                
                safe_rec_h_gf = clamp_val(season_h_xg, rec_h_gf)
                safe_rec_a_ga = clamp_val(season_a_xga, rec_a_ga)

                # 步骤 B: 加权计算 (80% 底蕴 + 20% 状态)
                # 这样既能感知到球队最近行不行，又不会被一场 7:0 虐菜局骗了
                final_att_h = (season_h_xg * 0.8) + (safe_rec_h_gf * 0.2)
                final_def_a = (season_a_xga * 0.8) + (safe_rec_a_ga * 0.2)
                
                # 计算主队 Lambda
                def_a_coef = final_def_a / lg_base_h if lg_base_h > 0 else 1.0
                lam_h = final_att_h * def_a_coef
                
                # --- 同理计算客队 ---
                rec_a_gf = dyn_info['a_recent']['gf'] if dyn_info else a_stats['away_xg']
                rec_h_ga = dyn_info['h_recent']['ga'] if dyn_info else h_stats['home_xga']
                
                safe_rec_a_gf = clamp_val(a_stats['away_xg'], rec_a_gf)
                safe_rec_h_ga = clamp_val(h_stats['home_xga'], rec_h_ga)
                
                final_att_a = (a_stats['away_xg'] * 0.8) + (safe_rec_a_gf * 0.2)
                final_def_h = (h_stats['home_xga'] * 0.8) + (safe_rec_h_ga * 0.2)
                
                def_h_coef = final_def_h / lg_base_a if lg_base_a > 0 else 1.0
                lam_a = final_att_a * def_h_coef

                # ==========================================================
                # 🔧 优化一：动态主场优势修正 (Dynamic HGA)
                # 逻辑：根据联赛基准分，计算主场自带的进球红利
                # ==========================================================
                
                # 1. 计算该联赛的主场净胜优势 (HGA)
                # 例如：主场均1.6，客场均1.2 -> 差0.4 -> 主场自带 +0.2球优势
                league_hga = (lg_base_h - lg_base_a) / 2
                
                # 2. 应用修正 (权重 0.5，微调即可，不要太激进)
                # 给主队加成，给客队削减 (零和博弈)
                lam_h += (league_hga * 0.5)
                lam_a -= (league_hga * 0.5)

                # ==========================================================

                # 最终修正
                lam_h = max(0.1, min(5.0, lam_h))
                lam_a = max(0.1, min(5.0, lam_a))

                if dyn_info:
                    explain_txt += f"<br>⚡ <b>微调：</b>引入20%近期状态修正。"

                # --- 调用泊松计算函数 (保持不变) ---
                p_poi_w, p_poi_d, p_poi_l, top_scores = self._calc_poisson_matrix(lam_h, lam_a)
                p_rq_poi_w, p_rq_poi_d, p_rq_poi_l = self._calc_rq_poisson(lam_h, lam_a, odds_data['handicap'])
                
                poisson_data = {
                    'ph': p_poi_w, 'pd': p_poi_d, 'pl': p_poi_l,
                    'lh': lam_h, 'la': lam_a,
                    'scores': top_scores,
                    'rq_ph': p_rq_poi_w, 'rq_pd': p_rq_poi_d, 'rq_pl': p_rq_poi_l
                }

                # ==========================================================
                # 🔧 优化二：均势僵局过滤器 (The Drawish Filter)
                # 逻辑：如果xG差距 < 0.25，说明谁赢都是运气，强推胜负风险大
                # ==========================================================
                
                lam_gap = abs(lam_h - lam_a)
                is_dead_even = (lam_gap < 0.25)
                
                if is_dead_even:
                    # 1. 如果当前 best_bet 是单选 [胜] 或 [负]，这是危险信号
                    if best_bet and best_bet['kind'] == 'spf' and best_bet['sel'] != '平':
                        add_score(-2.0, "xG均势僵局过滤", module="poisson_risk")
                        warn = "⚖️ 均势局"
                        tag_cls = "tag-blue"
                        explain_txt += f"<br>⚖️ <b>僵局预警：</b>xG显示两队实力极度接近(差{lam_gap:.2f})，强行分胜负完全靠运气，<b>建议防平或去下盘</b>。"

                # --- 4. 泊松风控判断 (双核共振/诱盘) ---
                # 获取去水后的市场概率
                m_pw, m_pd, m_pl = curr_pw, curr_pd, curr_pl 
                
                # SPF 逻辑
                if m_pw:
                    # [诱盘] 市场极度看好主胜，但xG不支持
                    if m_pw > 0.55 and p_poi_w < 0.40:
                        risk_alert = "⚠️ 诱盘警报"
                        warn = "⚠️ 诱盘风险"; tag_cls = "tag-red"
                        explain_txt += f"<br>📉 <b>数据背离：</b>赔率暗示{m_pw:.0%}，xG实算仅{p_poi_w:.0%}。"
                        if best_bet and best_bet['sel'] == '胜': best_bet = None
                    
                    # [共振] 市场和xG都看好
                    elif m_pw > 0.45 and p_poi_w > 0.48 and ess > 4:
                        risk_alert = "🔥 双核共振"
                        tag_cls = "tag-fire"
                        explain_txt += f"<br>🚀 <b>双核驱动：</b>xG数据支持主胜({p_poi_w:.0%})。"
                        add_score(2.0, "双核共振加分", module="poisson_signal")

                # RQ 逻辑
                # 计算 RQ 的市场真实概率 (去水后)
                m_rw, m_rd, m_rl = self._get_true_probs_rq(
                    odds_data.get('rw'), odds_data.get('rd'), odds_data.get('rl')
                )
                if m_rw:
                     # [让球诱盘]
                    if m_rw > 0.45 and p_rq_poi_w < 0.35:
                         risk_alert = "⚠️ 让球诱盘"
                         warn = "⚠️ 让球陷阱"; tag_cls = "tag-red"
                         explain_txt += f"<br>⛔ <b>RQ背离：</b>市场让胜虚高。"
                         if best_bet and best_bet['kind'] == 'rq' and best_bet['sel'] == '胜': best_bet = None
                    
                    # [提防让平]
                    if p_rq_poi_d > 0.30:
                         explain_txt += f"<br>🤏 <b>让平高危：</b>xG显示刚好赢{odds_data['handicap']}球概率大({p_rq_poi_d:.0%})。"
            else:
                # 如果没算出来，打印是谁没匹配上，方便你去Excel改名
                if not is_national:
                    if not h_stats: print(f"\n❌ 匹配失败: 主队[{h_name}] 未在xG库中找到")
                    if not a_stats: print(f"\n❌ 匹配失败: 客队[{a_name}] 未在xG库中找到")
            # --- B. 全球市场价值校验 (吸血赔率检测) ---
            # 这部分依然依赖 manual_data.xlsx 里的欧赔平均数据，所以保留 if manual_info
            if manual_info:
                check_list = [
                    {'name': '主胜', 'jc': odds_data.get('sw', 0), 'avg': manual_info.get('avg_w', 0)},
                    {'name': '平局', 'jc': odds_data.get('sd', 0), 'avg': manual_info.get('avg_d', 0)},
                    {'name': '客胜', 'jc': odds_data.get('sl', 0), 'avg': manual_info.get('avg_l', 0)}
                ]

                for item in check_list:
                    jc_val = item['jc']
                    avg_val = item['avg']
                    name = item['name']

                    if jc_val and jc_val > 0 and avg_val and avg_val > 0:
                        discount_rate = jc_val / avg_val
                        
                        # 情况A: 吸血赔率 (折价率 < 0.82)
                        if discount_rate < 0.82:
                            sel_map = {'主胜': '胜', '平局': '平', '客胜': '负'}
                            if best_bet and best_bet.get('sel') == sel_map.get(name, name):
                                warn = "🩸 吸血赔率"; tag_cls = "tag-gray"
                                explain_txt += f"<br>💸 <b>{name}巨坑：</b>折价{discount_rate:.2f} (性价比极低)。"
                                best_bet = None 
        
                        # 情况B: 超值赔率 (折价率 > 0.94)
                        elif 0.94 < discount_rate < 1.05:
                            explain_txt += f"<br>💰 <b>{name}超值：</b>折价{discount_rate:.2f} (良心价)。"
                # =======================================================

            all_matches_data.append({
                'ti': match_name, 'lg': lg, 'handicap': odds_data['handicap'], 'sample': sample_count,
                'odds_data': odds_data, 'ess': ess,
                'poisson_data': poisson_data or {},
                'home_elo': manual_info.get('home_elo') if manual_info else None,
                'away_elo': manual_info.get('away_elo') if manual_info else None,
                'best_spf_sel': spf_raw['sel'] if spf_raw else '-', 'spf_kelly': spf_raw['kelly'] if spf_raw else 0,
                'best_rq_sel': rq_raw['sel'] if rq_raw else '-', 'rq_kelly': rq_raw['kelly'] if rq_raw else 0,
                'match_id': m.get('matchId') or m.get('match_id') or ''
            })

            # ==========================================
            # 🔥 新增调用：欧亚风控 & 实战建议
            # ==========================================
            
            # 1. 欧亚风控
            ea_risk = self.analyze_euro_asia_risk(odds_data, manual_info)
            ea_html = ""
            if ea_risk:
                ea_html = ea_risk['html']
                add_score(ea_risk['adj'], "欧亚风控调整", module="euro_asia")

            # 2. 专家实战建议
            expert_advice_html = self.analyze_expert_strategies(odds_data, poisson_data, top_matches, ess)
            
            # 如果有“蚊子肉避雷”建议，强制扣分，避免推送到前面
            if "蚊子肉" in expert_advice_html:
                add_score(-5.0, "蚊子肉避雷", module="expert_strategy")
                warn = "⛔ 避雷"
                tag_cls = "tag-red"

            # ==========================================

            spf_stats_blend = None

            sentiment = self.analyze_odds_sentiment(odds_data, top_matches)

            # =================================================================
            # 👇👇👇 在这里粘贴 优化二(盘赔背离) 的代码 👇👇👇
            # =================================================================
            
            # === 新增：盘赔背离检测 (SPF降 vs RQ升) ===
            divergence_alert = ""
            
            # 1. 计算 SPF 主胜变化率 (负数代表降赔，看好主胜)
            sw_curr = odds_data.get('sw'); sw_init = odds_data.get('sw_init')
            delta_spf = (sw_curr - sw_init)/sw_init if (sw_curr and sw_init) else 0
            
            # 2. 计算 RQ 让胜变化率 (正数代表升赔，看衰穿盘)
            rw_curr = odds_data.get('rw'); rw_init = odds_data.get('rw_init')
            delta_rq = (rw_curr - rw_init)/rw_init if (rw_curr and rw_init) else 0
            
            # 逻辑：SPF 降幅超过 3% (庄家防主胜)，但 RQ 却涨幅超过 2% (庄家不看好大胜)
            # 这种“剪刀差”通常意味着：一球小胜(走水/卡盘) 或者 平局
            if delta_spf < -0.03 and delta_rq > 0.02:
                divergence_alert = "⚡ 盘赔背离"
                
                # 修改页面显示的警告标签
                warn = "⚠️ 谨防卡盘"; tag_cls = "tag-orange"
                explain_txt += "<br>⚡ <b>内部矛盾：</b>主胜降赔防守，让胜却升赔阻击，庄家不看好大胜。"
                
                # 风控动作：如果当前最好推荐是 [让胜]，直接杀掉，强制转为观望
                if best_bet and best_bet['kind'] == 'rq' and best_bet['sel'] == '胜':
                    best_bet = None
                    explain_txt += "<br>⛔ <b>风控撤单：</b>因盘赔背离，撤销让胜推荐。"
            
            # 将背离警报追加到 risk_alert 变量里，以便在 HTML 顶部显示
            if divergence_alert:
                if risk_alert: risk_alert += f" | {divergence_alert}"
                else: risk_alert = divergence_alert

            # =================================================================
            # 🤖 大模型主预测 (DeepSeek/Gemini/Kimi)
            # 输出独立的胜平负 / 大小球 / 比分，并与本地模型对照
            # =================================================================
            llm_task = None
            candidate_to_ask = best_bet
            if not candidate_to_ask and spf_raw:
                candidate_to_ask = spf_raw.copy()

            if llm_engine_enabled:
                ctx = {'tier': tier, 'match_name': match_name}
                info = self._build_llm_review_info(
                    candidate_to_ask,
                    odds_data,
                    manual_info,
                    poisson_data,
                    bf_data,
                    pk_info,
                    dyn_info
                )
                info['local_reference'] = self._build_local_llm_reference(
                    candidate_to_ask,
                    spf_stats_blend if spf_stats_blend else spf_stats_main,
                    poisson_data,
                )
                allow_llm, llm_skip_reason = should_run_llm_prediction(
                    candidate_to_ask,
                    info,
                    used_calls=0,
                    max_calls=0,
                )
                if not allow_llm:
                    kimi_review_html = render_gemini_status_card(llm_skip_reason)
                    web_verification_html = ""
                else:
                    llm_task = {
                        'ctx': ctx,
                        'info': info,
                        'candidate': candidate_to_ask,
                        'match_name': match_name,
                    }
                    kimi_review_html = render_gemini_status_card("等待全局择优：本地分析完成后进入大模型精选池")
                    web_verification_html = ""

            # =================================================================
            
            #rec_score = 0
            if best_bet:
                add_score(3.0, "存在有效推荐", module="pick_base")
                if best_bet['kelly'] > 0.08:
                    add_score(2.0, "Kelly高于0.08", module="pick_base")
                if ess > 5:
                    add_score(1.0, "ESS高于5", module="pick_base")
            
            macro_risk = None
            curr_fav = odds_data['sw'] if odds_data['sw'] and odds_data['sw'] < 1.55 else None
            if curr_fav and league_prof.get('fav_rate', 1) != -1 and league_prof.get('fav_rate', 1) < 0.55:
                macro_risk = f"⚠️ 剧本警报：该联赛低赔胜率仅 {league_prof.get('fav_rate'):.0%}，谨慎单选！"
                add_score(-2.0, "联赛低赔剧本风险", module="macro_risk")

            # =========== 【修改位置 3-D】插入在这里 ===========
            # 扣除之前计算的体能疲劳分
            # 注意：fatigue_penalty 必须在前面 Step 3-B 里定义过（默认为0）
            if fatigue_penalty > 0:
                add_score(-fatigue_penalty, "主队疲劳惩罚", module="fatigue")
            # ===============================================

            # =========== 【修改位置 3】在这里粘贴必发风控逻辑 ===========
            clean_h_name = h_name.strip().replace('FC', '').replace(' ', '')
            bf_data = bifa_db.get(clean_h_name)
            
            if not bf_data:
                for k in bifa_db:
                    if k in clean_h_name or clean_h_name in k:
                        bf_data = bifa_db[k]; break
            
            if bf_data:
                v_h = bf_data['vol']['h']; v_d = bf_data['vol']['d']; v_a = bf_data['vol']['a']
                total_vol = v_h + v_d + v_a
                
                if total_vol > 5000:
                    rate_h = v_h / total_vol
                    rate_d = v_d / total_vol
                    
                    bf_odds_h = bf_data['odds']['h']
                    if bf_odds_h > 1:
                        theory_prob = 1 / bf_odds_h
                        heat_diff = rate_h - theory_prob
                        
                        if heat_diff > 0.15:
                            add_score(-4.0, f"主胜资金爆表({heat_diff:.0%})", module="bifa_risk")
                            warn = "🔥 超级大热"; tag_cls = "tag-red"
                            explain_txt += f"<br>🔥 <b>资金爆表：</b>主胜热度{rate_h:.0%} (超标{heat_diff:.0%})，极高危。"
                            if best_bet and best_bet['sel'] == '胜': 
                                best_bet = None
                                explain_txt += " -> ⛔ 撤销主胜。"
                        elif heat_diff > 0.10:
                            add_score(-2.0, f"主胜资金过热({heat_diff:.0%})", module="bifa_risk")
                            explain_txt += f"<br>⚠️ <b>资金过热：</b>市场过分追捧主队。"

                    var_h = bf_data['var']['h']; var_d = bf_data['var']['d']; var_a = bf_data['var']['a']
                    min_var = min(var_h, var_d, var_a)
                    
                    if rate_h > 0.50: 
                        if var_d < 10 and var_d < var_h:
                            add_score(-2.0, "方差防平惩罚", module="bifa_risk")
                            explain_txt += f"<br>🛡️ <b>方差防平：</b>主队虽热，但庄家严防平局(方差{var_d})。"
                        if var_a < 10 and var_a < var_h:
                            add_score(-3.0, "方差诱主惩罚", module="bifa_risk")
                            explain_txt += f"<br>💣 <b>方差诱主：</b>资金全在主胜，庄家却看好客胜(方差{var_a})！"
                    
                    if rate_d > 0.30:
                        explain_txt += f"<br>⚖️ <b>平局吸金：</b>平局交易占比达{rate_d:.0%}，职业资金在防平。"

                    explain_txt += f"<br><span style='color:#999;font-size:10px'>[必发] 主量:{rate_h:.0%} 方差:{var_h}|{var_d}|{var_a}</span>"
            # ==========================================================

            # =========== 【修改位置 3】亚盘风控逻辑 (核心) ===========
            clean_h_name_pk = h_name.strip().replace('FC', '').replace(' ', '')
            pk_info = pankou_db.get(clean_h_name_pk)
            
            if not pk_info:
                for k in pankou_db:
                    if k in clean_h_name_pk or clean_h_name_pk in k:
                        pk_info = pankou_db[k]; break
            
            if pk_info:
                # 取出最新盘口用于静态风控
                pb_line = pk_info['pb']['curr_line']
                pb_water = pk_info['pb']['curr_water']
                mac_line = pk_info['mac']['curr_line']
                
                # 取出初盘用于动态分析 (后面会用到)
                pb_init_line = pk_info['pb']['init_line']
                pb_init_water = pk_info['pb']['init_water']
                
                # 1. 理论盘口折算 (不变)
                # A. 确定基准赔率 (Benchmark Odds)
                ref_odds = 0
                if manual_info and manual_info.get('avg_w', 0) > 0:
                    # 首选：使用 Excel 里的平均欧赔
                    ref_odds = manual_info.get('avg_w')
                else:
                    # 备选：如果没有欧赔数据，将竞彩赔率还原为理论欧赔 (除以返还率0.88)
                    # 这样才能和亚盘在同一个维度对比
                    jc_val = odds_data.get('sw', 0)
                    if jc_val > 0:
                        ref_odds = jc_val / 0.88

                # B. 查表：标准欧赔转亚盘 (Standard Mapping)
                theory_line = 0
                if ref_odds > 0:
                    if ref_odds <= 1.20: theory_line = -2.25 # 降维打击
                    elif ref_odds <= 1.28: theory_line = -2.0
                    elif ref_odds <= 1.35: theory_line = -1.75
                    elif ref_odds <= 1.44: theory_line = -1.5
                    elif ref_odds <= 1.53: theory_line = -1.25 # 布拉加欧赔1.45落在此处
                    elif ref_odds <= 1.68: theory_line = -1.0
                    elif ref_odds <= 1.92: theory_line = -0.75
                    elif ref_odds <= 2.25: theory_line = -0.5
                    elif ref_odds <= 2.65: theory_line = -0.25
                    else: theory_line = 0
                
                # 2. 静态风控信号 (先收集，后统一生效)
                line_diff = pb_line - theory_line
                static_is_shallow_trap = (theory_line < 0 and line_diff >= 0.5)
                has_protection = ("双核共振" in risk_alert)

                if pb_water < 0.85:
                    if static_is_shallow_trap and not has_protection:
                        add_asia_signal(
                            -2,
                            f"🎣 <b>低水诱盘：</b>欧赔({ref_odds:.2f})支撑让{theory_line}，实开{pb_line}显著偏浅，<b>谨防陷阱</b>。",
                            kill_side='home',
                            kill_reason="亚盘低水诱"
                        )
                    elif static_is_shallow_trap and has_protection:
                        add_asia_signal(1, "🛡️ <b>浅盘防赔：</b>盘口虽浅但xG支持，庄家压低水控赔。")
                    else:
                        add_asia_signal(1, f"💧 <b>超低水：</b>盘口合理({pb_line})且水位极低，<b>庄家严防，稳胆首选</b>。")
                elif pb_water > 1.05:
                    add_asia_signal(-2, "🌊 <b>超高水：</b>赔付风险太大，<b>庄家在做梦，千万别去</b>。")

                # 3. 平澳互怼 (操作指引)
                if abs(pb_line) > abs(mac_line):
                    add_asia_signal(1, "🛡️ <b>信平博：</b>平博盘口更严，<b>跟着平博方向买</b>。")
                
                # 4. 水位极值 (操作指引)
                #if pb_water < 0.82:
                #    rec_score += 1
                #    explain_txt += f"<br>💧 <b>超低水：</b>赔付压力极小，<b>庄家严防，稳胆首选</b>。"
                #elif pb_water > 1.05:
                #    rec_score -= 2
                #    explain_txt += f"<br>🌊 <b>超高水：</b>赔付风险太大，<b>庄家在做梦，千万别去</b>。"
            
            # (final_pick / best_bet_html 判定已移至亚盘风控之后，见下方)
            odds_bar_html = self.render_pc_odds_bar(odds_data)
            filter_tags = []
            if tag_cls in ['tag-fire', 'tag-red', 'tag-purple']: filter_tags.append('fire')
            if tag_cls in ['tag-green']: filter_tags.append('stable')
            if 'tag-blue' in tag_cls: filter_tags.append('cold')

            # ====================================================
            # 🔧 【修复显示】将新算的 xG 数据整合给 HTML 显示
            # ====================================================
            display_info = dict(manual_info) if manual_info else {}
            # 确保 rtp 也能被前端拿到 (如果 manual_info 里有的话)
            if manual_info:
                display_info['avg_rtp'] = manual_info.get('avg_rtp', 0)
            if poisson_data:
                # 1. 计算 xG 净胜值 (用于顶部显示 xG: +1.2)
                # 用我们算出来的 Lambda_Home - Lambda_Away
                net_xg = poisson_data['lh'] - poisson_data['la']
                display_info['xg_h'] = net_xg  
                
                # 2. 显示双方理论进球数 (用于显示 基准: 1.85/0.92)
                display_info['base_h'] = round(poisson_data['lh'], 2)
                display_info['base_a'] = round(poisson_data['la'], 2)

            # ====================================================
            full_context = (dyn_info or {}).get('full_context') or {}
            form_html = ""
            if dyn_info:
                h_g = dyn_info['h_recent']['gf']; h_l = dyn_info['h_recent']['ga']
                a_g = dyn_info['a_recent']['gf']; a_l = dyn_info['a_recent']['ga']
                
                # 体能翻译
                def get_rest_tag(days):
                    if days < 3: return f"<span style='color:#cf1322;font-weight:bold'>⚠️ 仅休{days}天</span>"
                    if days > 7: return f"<span style='color:#389e0d'>🔋 满油({days}天)</span>"
                    return f"<span style='color:#999'>休{days}天</span>"

                h_rest_tag = get_rest_tag(h_rest)
                a_rest_tag = get_rest_tag(a_rest)
                
                form_html = f"""
                <div style="font-size:10px;margin-bottom:6px;display:flex;justify-content:space-between;background:#f0f2f5;padding:5px;border-radius:4px;border:1px solid #e1e4e8;">
                    <div>🏠 主近5: <b>{h_g:.1f}</b>球 {h_rest_tag}</div>
                    <div>✈️ 客近5: <b>{a_g:.1f}</b>球 {a_rest_tag}</div>
                </div>
                """
            injury_card_html = render_injury_summary_card(full_context.get('lineup_injury') or {})
            schedule_card_html = render_schedule_pressure_card(
                full_context.get('schedule_context') or {},
                kickoff_time=full_context.get('kickoff_time') or odds_data.get('source_time') or '',
            )

            # ==========================================================
            # 【界面优化 2】构建“必发资金”显示栏 (紫色系)
            # ==========================================================
            bifa_html = ""
            if bf_data:
                # 提取前面算好的数据
                # 注意：确保你在前面 '必发风控逻辑' 里保留了 rate_h, var_h 等变量
                # 如果前面是在 if 块里定义的，这里可能需要重新获取一下，或者把变量定义提出来
                # 这里假设前面的变量还在作用域内，或者重新从 bf_data 读
                
                v_h = bf_data['vol']['h']; v_d = bf_data['vol']['d']; v_a = bf_data['vol']['a']
                tot = v_h + v_d + v_a
                if tot > 0:
                    rh = v_h/tot; rd = v_d/tot; ra = v_a/tot
                    vh = bf_data['var']['h']; vd = bf_data['var']['d']; va = bf_data['var']['a']
                    
                    # A. 热度翻译官
                    def trans_heat(rate):
                        if rate > 0.80: return "🔥 严重拥挤", "#cf1322", "bold"
                        if rate > 0.60: return "🔥 热度较高", "#d46b08", "normal"
                        if rate < 0.05: return "❄️ 无人问津", "#096dd9", "normal"
                        if rate > 0.30 and rate < 0.50: return "☁️ 资金正常", "#333", "normal"
                        return "☁️ 资金正常", "#666", "normal"

                    # B. 方差翻译官 (找最小值)
                    min_v = min(vh, vd, va)
                    def trans_var(val, is_min):
                        if is_min and val < 10: return "✅ 庄家统一", "#389e0d"
                        if val > 30: return "⚔️ 分歧巨大", "#cf1322"
                        return f"方差 {val}", "#999"

                    tag_h, col_h, w_h = trans_heat(rh); var_tag_h, var_col_h = trans_var(vh, vh==min_v)
                    tag_d, col_d, w_d = trans_heat(rd); var_tag_d, var_col_d = trans_var(vd, vd==min_v)
                    tag_a, col_a, w_a = trans_heat(ra); var_tag_a, var_col_a = trans_var(va, va==min_v)
                    
                    # 特殊：如果平局资金异常高
                    if rd > 0.25: tag_d, col_d, w_d = "🛡️ 资金防平", "#d48806", "bold"

                    bifa_html = f"""
                    <div style="margin-top:6px;border:1px solid #d3adf7;background:#f9f0ff;border-radius:4px;overflow:hidden;">
                        <div style="background:#722ed1;color:#fff;font-size:10px;padding:3px 6px;font-weight:bold;display:flex;justify-content:space-between;">
                            <span>📊 必发资金风向</span> <span>总量: {int(tot)}</span>
                        </div>
                        <div style="display:flex;text-align:center;background:#efdbff;font-size:10px;color:#722ed1;padding:2px 0;">
                            <div style="flex:1;">🏠 主胜资金</div>
                            <div style="flex:1;">⚖️ 平局资金</div>
                            <div style="flex:1;">✈️ 客胜资金</div>
                        </div>

                        <div style="display:flex;text-align:center;font-size:10px;padding:5px 0;">
                            <div style="flex:1;border-right:1px solid #e9d8fd;">
                                <div style="color:{col_h};font-weight:{w_h}">{rh:.0%} {tag_h}</div>
                                <div style="color:{var_col_h};font-size:9px;margin-top:2px;">{var_tag_h}</div>
                            </div>
                            <div style="flex:1;border-right:1px solid #e9d8fd;">
                                <div style="color:{col_d};font-weight:{w_d}">{rd:.0%} {tag_d}</div>
                                <div style="color:{var_col_d};font-size:9px;margin-top:2px;">{var_tag_d}</div>
                            </div>
                            <div style="flex:1;">
                                <div style="color:{col_a};font-weight:{w_a}">{ra:.0%} {tag_a}</div>
                                <div style="color:{var_col_a};font-size:9px;margin-top:2px;">{var_tag_a}</div>
                            </div>
                        </div>
                    </div>
                    """
            # 【界面优化 3】构建“亚盘对比”显示栏 (智能联动版)
            # ==========================================================
            pk_html = ""
            if pk_info:
                # 提取数据 (PB = Pinnacle, MAC = Macau)
                pb = pk_info['pb']
                mac = pk_info['mac']
                
                # 计算变化量 (终 - 初)
                # 盘口变化: 正数=升盘(主队门槛变高)，负数=降盘(主队门槛变低)
                delta_line = pb['curr_line'] - pb['init_line']
                # 水位变化: 正数=升水(回报变高/阻力变大)，负数=降水(回报变低/热度变大)
                delta_water = pb['curr_water'] - pb['init_water']
                
                # 获取竞彩让球数
                jc_h_val = odds_data.get('handicap', 0)
                jc_h_str = f"{int(jc_h_val):+d}" if jc_h_val != 0 else "0"
                
                # 辅助：竞彩建议
                def get_jc_strategy(target_is_home, line_val):
                    abs_line = abs(line_val)
                    decimal = abs_line - int(abs_line)
                    base_opt = f"让胜[{jc_h_str}]" if target_is_home else f"让负[{jc_h_str}]"
                    if decimal == 0 and abs_line > 0: return f"<b>{base_opt}</b> + <span style='color:#d48806'>防让平</span>"
                    elif decimal == 0.75: return f"<b>{base_opt}</b> + <span style='color:#d48806'>防让平</span>"
                    elif decimal == 0.5: return f"<b>{base_opt} (单选)</b>"
                    else: return f"<b>{base_opt} (博)</b>"

                # --- 1. 动态逻辑判定 (Dynamic Logic) ---
                attitude = ""
                jc_advice = "" 
                is_modela_shallow_trap = False     # 模型A盘浅陷阱
                is_high_water_risk = False         # 模型A高水风险
                is_dynamic_trap = False     # 🔥 新增：动态诱盘 (降盘/大热)
                
                pb_val = pb['curr_line']
                mac_val = mac['curr_line']
                pb_w = pb['curr_water']
                asian_fav_side = 'home' if pb_val < 0 else ('away' if pb_val > 0 else None)

                # --- 模型 A: 静态对比 (平博 vs 澳门) ---
                if abs(pb_val) > abs(mac_val): 
                    # 平博盘深 -> 理论看好
                    if pb_w > 1.02:
                        is_high_water_risk = True
                        attitude = f"<span style='color:#cf1322'>🌊 深盘高水: 阻力太大</span>"
                        jc_advice = get_jc_strategy(False, pb_val)
                    else:
                        attitude = f"<span style='color:#389e0d;font-weight:bold'>👉 信平博: 买上盘</span>"
                        jc_advice = get_jc_strategy(True, pb_val)
                        
                elif abs(pb_val) < abs(mac_val): 
                    # 平博盘浅 -> 嫌疑
                    attitude = f"<span style='color:#cf1322'>⚠️ 盘浅: 去客队</span>"
                    jc_advice = get_jc_strategy(False, pb_val)
                    if abs(pb_val) < abs(theory_line): is_modela_shallow_trap = True 
                
                else:
                    # 盘口一致
                    attitude = "<span style='color:#999'>👀 意见一致</span>"
                    if pb_w < 0.90: jc_advice = get_jc_strategy(True, pb_val)
                    elif pb_w > 1.02: jc_advice = get_jc_strategy(False, pb_val)
                    else: jc_advice = "<span style='color:#999'>观望</span>"

                # --- 模型 B: 动态趋势修正 (Time Series Correction) ---
                # 只有当数据发生变化时才触发
                trend_arrow = ""
                
                # 1. 降盘诱导 (初盘深 -> 终盘浅)
                if delta_line < 0:
                    # 比如从 -0.5 降到 -0.25，且水位还给你降到低水
                    if pb_w < 0.88:
                        is_dynamic_trap = True
                        add_asia_signal(
                            -3,
                            "💣 <b>变盘陷阱：</b>📉(降盘诱) 典型的庄家诱盘手法，利用降盘/降水吸纳资金，<b>上盘极危</b>。",
                            kill_side=asian_fav_side,
                            kill_reason="降盘低水诱导"
                        )
                        attitude = f"<span style='color:#cf1322;font-weight:bold'>📉 降盘低水: 诱杀上盘</span>"
                        jc_advice = get_jc_strategy(False, pb_val)
                        trend_arrow = "📉(降盘诱)"
                    else:
                        trend_arrow = "📉(退热)"

                # 2. 升盘阻力 (初盘浅 -> 终盘深)
                elif delta_line > 0:
                    # 比如从 -0.5 升到 -0.75
                    add_asia_signal(1, "📈 <b>升盘增强：</b>盘口升深，主流信心走强。")
                    attitude = f"<span style='color:#389e0d;font-weight:bold'>📈 升盘: 信心增强</span>"
                    jc_advice = get_jc_strategy(True, pb_val)
                    trend_arrow = "📈(升盘强)"
                
                # 3. 盘口不动，水位暴跌 (大热必死)
                elif delta_line == 0 and delta_water < -0.10:
                    # 比如从 1.00 跌到 0.80，却不升盘
                    is_dynamic_trap = True
                    add_asia_signal(
                        -3,
                        "🔥 <b>水位暴跌：</b>盘口不升但水位急跌，属于大热拥挤结构，<b>上盘高危</b>。",
                        kill_side=asian_fav_side,
                        kill_reason="水位暴跌大热"
                    )
                    attitude = f"<span style='color:#cf1322;font-weight:bold'>🔥 水位暴跌: 大热必死</span>"
                    jc_advice = get_jc_strategy(False, pb_val)
                    trend_arrow = "🔥(大热)"

                # --- 2. 智能水位翻译 ---
                def trans_water_smart(w, is_static_trap, is_dyn_trap, is_high_risk):
                    # 动态诱盘 (最高优先级)
                    if is_dyn_trap:
                        return f"<span style='color:#cf1322;font-weight:bold'>{w} (诱)</span>"

                    # 静态低水诱盘
                    if w < 0.85:
                        if is_static_trap:
                            return f"<span style='color:#cf1322;font-weight:bold'>{w} (低水诱)</span>"
                        return f"<span style='color:#389e0d;font-weight:bold'>{w} (低水稳)</span>"
                    
                    # 高水阻力
                    if w > 1.02:
                        return f"<span style='color:#cf1322;font-weight:bold'>{w} (高水坑)</span>"
                    
                    return f"<span style='color:#666'>{w}</span>"
                
                # 风控信号判定与渲染解耦：避免显示函数产生副作用
                if pb_w > 1.02 and is_high_water_risk:
                    add_asia_signal(
                        -1,
                        f"🌊 <b>深盘高水：</b>盘口深但水位({pb_w})过高，<b>打穿难度大，去下盘</b>。",
                        kill_side=asian_fav_side,
                        kill_reason="深盘高水阻"
                    )

                # 生成 HTML
                pb_w_html = trans_water_smart(
                    pb_w,
                    static_is_shallow_trap or is_modela_shallow_trap,
                    is_dynamic_trap,
                    is_high_water_risk
                )
                
                # 澳门显示 (简单处理)
                mac_w_disp = f"{mac['curr_water']}"
                if mac['curr_water'] < 0.85: mac_w_disp = f"<span style='color:#389e0d;font-weight:bold'>{mac['curr_water']}</span>"
                
                # 翻译盘口
                curr_pk_name = str(pb_val)
                curr_pk_rule = ""
                try: curr_pk_name, curr_pk_rule = self.get_handicap_translator(pb_val)
                except Exception as e:
                    print(f"⚠️ 盘口翻译失败: {match_name} 盘口={pb_val} ({e})")

                pk_html = f"""
                <div style="margin-top:6px;border:1px solid #ffd591;background:#fff7e6;border-radius:4px;overflow:hidden;">
                    <div style="background:#fa8c16;color:#fff;font-size:10px;padding:3px 6px;font-weight:bold;display:flex;justify-content:space-between;">
                        <span>⚖️ 亚盘动态博弈 {trend_arrow}</span> <span>{attitude}</span>
                    </div>
                    <div style="background:#fffbe6;padding:3px 6px;border-bottom:1px dashed #ffd591;color:#d46b08;font-size:10px;">
                        📖 <b>{curr_pk_name}</b> ({pb_val}): {curr_pk_rule}
                    </div>
                    <div style="padding:5px;font-size:10px;">
                        <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
                            <span style="color:#666">
                                平博: <span style="color:#999;font-size:9px">{pb['init_line']}</span>➝<b>{pb['curr_line']}</b> {pb_w_html}
                            </span>
                            <span style="color:#999">
                                澳门: {mac['init_line']}➝{mac['curr_line']} {mac_w_disp}
                            </span>
                        </div>
                        <div style="background:#fff;padding:3px;border-radius:2px;text-align:center;border:1px dashed #fa8c16;color:#d46b08;">
                            🇨🇳 <b>竞彩参考:</b> {jc_advice}
                        </div>
                    </div>
                </div>
                """

            # =========== 亚盘统一生效区 ===========
            if asia_decision['score_delta']:
                add_score(asia_decision['score_delta'], "亚盘统一信号汇总", module="asia_risk")
            if asia_decision['notes']:
                explain_txt += "".join(f"<br>{x}" for x in asia_decision['notes'])
            if 'home' in asia_decision['kill_sides']:
                is_kill_home = True
            if 'away' in asia_decision['kill_sides']:
                is_kill_away = True
            if asia_decision['veto_reason']:
                veto_reason = asia_decision['veto_reason']

            # =========== 【BugFix】最终判定移至所有风控之后 ===========
            # 确保亚盘/必发风控标志都已就位后，再做联合否决
            if (is_kill_home or is_kill_away) and manual_info and manual_info.get('avg_rtp', 0) > 0.955:
                add_score(-2.0, "高RTP+亚盘诱盘联合否决", module="joint_veto")
                explain_txt += "<br>💀 高RTP+亚盘诱盘联合否决"

            # 统一融合概率（仅展示层）：历史相似 + 市场 + AI + 泊松 + 欧亚/资金修正
            market_probs = {'胜': curr_pw, '平': curr_pd, '负': curr_pl}
            mix_probs = self.blend_spf_probs(
                spf_stats_hist,
                market_probs,
                ai_spf,
                poisson_data,
                odds_data=odds_data,
                manual_info=manual_info,
                asia_decision=asia_decision,
                bf_data=bf_data
            )
            spf_stats_blend = [
                {'result': '胜', 'pct': mix_probs['胜']},
                {'result': '平', 'pct': mix_probs['平']},
                {'result': '负', 'pct': mix_probs['负']}
            ]
            spf_stats_blend.sort(key=lambda x: x['pct'], reverse=True)

            if not best_bet and sample_count >= MIN_SAMPLES and not is_chaotic: warn = "⚠️ 观察"; tag_cls = "tag-gray"

            final_pick = None
            pick_type = ""
            pick_style = ""

            def pick_side(pick):
                if not pick:
                    return None
                sel = pick.get('sel')
                if sel == '胜':
                    return 'home'
                if sel == '负':
                    return 'away'
                return None
            
            # --- 层级 1: 风控否决层 (Veto Layer) ---
            veto_sides = set()
            if is_kill_home:
                veto_sides.add('home')
            if is_kill_away:
                veto_sides.add('away')

            # 如果当前 best_bet 命中否决方向，则撤销并尝试反向避险
            if best_bet and pick_side(best_bet) in veto_sides:
                best_bet = None # 撤销原推荐
                # 尝试反向推荐：仅保留未命中否决方向的候选
                candidates = [x for x in mixed_candidates if pick_side(x) not in veto_sides]
                if candidates:
                    candidates.sort(key=lambda x: x['kelly'], reverse=True)
                    final_pick = candidates[0]
                    pick_type = f"🛡️ 避险 ({veto_reason or '亚盘风控'})"
                    pick_style = "border:1px solid #52c41a;color:#389e0d;background:#f6ffed"
                    add_score(2.0, "触发避险替代推荐", module="veto_layer")
            
            if not final_pick:
                if best_bet:
                    final_pick = best_bet
                    pick_type = "🎯 最佳"
                    pick_style = "border:1px solid #f5a623;color:#d70015;background:#fff8e6"
                else:
                    if spf_stats_main:
                        top_s = spf_stats_main[0]
                        top_res = top_s.get('result')
                        if top_res in ['胜', '平', '负']:
                            top_side = 'home' if top_res == '胜' else ('away' if top_res == '负' else None)
                        else:
                            top_side = None
                        if top_res in ['胜', '平', '负'] and top_side not in veto_sides:
                            final_pick = {
                                'sel': top_res,
                                'odds': odds_data.get('sw') if top_res == '胜' else (odds_data.get('sd') if top_res == '平' else odds_data.get('sl')),
                                'odds_init': odds_data.get('sw_init') if top_res == '胜' else (odds_data.get('sd_init') if top_res == '平' else odds_data.get('sl_init')),
                                'prob': top_s['pct'],
                                'sel_disp': f"[{top_res}]",
                                'entropy': 0,
                                'kind': 'spf'
                            }
                            pick_type = "👀 博单"
                            pick_style = "border:1px solid #d9d9d9;color:#666;background:#f5f5f5"
                            cap_score_max(2.0, "博单推荐分上限=2", module="pick_cap")

            # ==========================================
            # 🛡️ 出手质量硬性过滤（数据驱动）
            # ==========================================
            _quality_veto_reason = ""
            if final_pick:
                _fp_sel = str(final_pick.get('sel', '')).strip()

                # 防线1: 联赛黑名单（回测 ROI < -30% 的联赛全部拦截）
                if lg in LEAGUE_BLACKLIST:
                    _quality_veto_reason = f"联赛风控：{lg}回测表现差，自动降级为观望"

                # 防线2: 禁止平局推荐（回测命中率仅 27.8%，模型不擅长预测平局）
                elif DISABLE_DRAW_PICK and _fp_sel == '平':
                    _quality_veto_reason = "平局过滤：模型平局预测命中率偏低，自动降级为观望"

                # 防线3: EV校准过滤（核心！用校准概率重算期望值）
                if not _quality_veto_reason:
                    _fp_prob = float(final_pick.get('prob', 0) or 0)
                    _fp_odds = float(final_pick.get('odds', 0) or 0)
                    if _fp_prob > 0 and _fp_odds > 0:
                        _cal_prob = calibrate_probability(_fp_prob)
                        _cal_ev = _cal_prob * _fp_odds
                        if _cal_ev < CALIBRATED_EV_THRESHOLD:
                            _quality_veto_reason = (
                                f"EV不足：校准概率{_cal_prob:.1%}×赔率{_fp_odds:.2f}"
                                f"=EV {_cal_ev:.2f}<{CALIBRATED_EV_THRESHOLD}"
                            )

                if _quality_veto_reason:
                    explain_txt += f"<br>🛡️ <b>质量过滤：</b>{_quality_veto_reason}"
                    final_pick = None
                    pick_type = ""
                    pick_style = ""
                    add_score(-3.0, _quality_veto_reason, module="quality_filter")

            decision_level = self._classify_decision_level(
                final_pick=final_pick,
                rec_score=rec_score,
                ess=ess,
                warn=warn,
                market_heat_warning="；".join(
                    [x for x in [warn, risk_alert] if str(x or '').strip()]
                ),
                draw_warning="",
                replay_attribution_brief="",
                quality_veto_reason=_quality_veto_reason,
            )
            
            # 生成 HTML 片段 (通用)
            score_disp = fmt_score(rec_score)
            best_bet_html = f"""
                <div style="margin-top:8px;padding:6px;border:1px solid #d9d9d9;color:#666;background:#f5f5f5;border-radius:4px;text-align:center;">
                    <div style="font-size:12px;font-weight:bold;">⏸️ 观望：暂无有效推荐</div>
                    <div style="font-size:10px;margin-top:2px;">推荐指数: ★☆☆☆☆ ({score_disp}分)</div>
                    <div style="font-size:10px;margin-top:3px;color:#666;">决策等级：{decision_level['label']} ({decision_level['reason']})</div>
                </div>
            """
            if final_pick:
                if ess < 15.0:
                    cap_score_max(2.0, "少样本推荐分上限=2", module="pick_cap")
                    star_cnt = 2
                    pick_style = "border:1px solid #d9d9d9;color:#666;background:#f5f5f5" 
                    pick_type += " (少样本)"
                else:
                    if "避险" in pick_type: star_cnt = 4 
                    elif rec_score >= 7: star_cnt = 5
                    elif rec_score >= 5: star_cnt = 4
                    elif rec_score >= 3: star_cnt = 3
                    elif rec_score >= 0: star_cnt = 2
                    else: star_cnt = 1
                
                stars = "★" * star_cnt + "☆" * (5-star_cnt)
                
                try: 
                    o_curr = final_pick.get('odds', 0)
                    o_init = final_pick.get('odds_init', 0)
                    odds_str = self.render_odds_trend(o_curr, o_init)
                except Exception: odds_str = ""
                
                disp_name = final_pick.get('sel_disp', f"[{final_pick['sel']}]")
                if 'handicap' in final_pick and final_pick.get('kind') == 'rq':
                    h_val = final_pick['handicap']
                    if h_val != 0: disp_name = f"[让{final_pick['sel']} {h_val}]"
                score_disp = fmt_score(rec_score)
                best_bet_html = f"""
                <div style="margin-top:8px;padding:6px;{pick_style};border-radius:4px;text-align:center;">
                    <div style="font-size:12px;font-weight:bold;">{pick_type}: {disp_name} <span style="font-weight:normal;font-size:10px;margin-left:4px">{odds_str}</span></div>
                    <div style="font-size:10px;margin-top:2px;">推荐指数: {stars} ({score_disp}分)</div>
                    <div style="font-size:10px;margin-top:3px;color:#666;">决策等级：{decision_level['badge_text']} ({decision_level['reason']})</div>
                </div>
                """
            # ==========================================================

            results.append({
                'manual_show': display_info,
                'lg': lg, 'ti': match_name, 'handicap': odds_data['handicap'],
                'odds_bar': odds_bar_html, 
                'form_html': form_html,   # 状态栏
                'injury_card_html': injury_card_html,
                'schedule_card_html': schedule_card_html,
                'web_verification_html': web_verification_html,
                'bifa_html': bifa_html,   # 必发栏
                'pk_html': pk_html,       # 亚盘栏
                'best_bet_html': best_bet_html,
                'spf_stats': spf_stats_main,
                'spf_stats_main': spf_stats_main,
                'spf_stats_hist': spf_stats_hist,
                'spf_stats_blend': spf_stats_blend if spf_stats_blend else spf_stats_main,
                'rq_stats_indep': rq_stats_weighted, 
                'spf_roi': {'txt': spf_roi_txt, 'tag': (spf_conf or {}).get('tag', ''), 'conf': spf_conf}, 
                'rq_roi': {'txt': rq_roi_txt, 'tag': (rq_conf or {}).get('tag', ''), 'conf': rq_conf},
                'path_analysis': path_analysis, 
                'sample': sample_count, 'ess': ess_spf,
                'warn': warn, 'tag_cls': tag_cls, 'history_df': top_spf,
                'score': rec_score, 'filters': " ".join(filter_tags), 'prof': league_prof, 
                'score_card': score_card,
                'macro_risk': macro_risk, 'ai_spf': ai_spf, 'ai_rq': ai_rq,
                'sentiment': sentiment,
                'poisson': poisson_data, # 新增
                'risk_alert': risk_alert, # 新增
                'ea_risk_html': ea_html,           # <--- 新增：欧亚风控HTML
                'kimi_review_html': kimi_review_html,
                'expert_advice': expert_advice_html, # <--- 新增：实战建议HTML
                'explain': explain_txt,
                'best_bet': final_pick,
                'final_pick': final_pick,
                'decision_level': decision_level,
                'raw_best_bet': best_bet,
                'spf_hard_hits': list(hard_hits),
                'spf_soft_hits': list(soft_hits),
                'spf_risk_bucket': spf_rule_cfg.get('bucket', ''),
                'spf_risk_band': spf_rule_cfg.get('band', ''),
                'spf_risk_source': spf_rule_cfg.get('source', ''),
                '_llm_task': llm_task,
            })
            print(".", end="", flush=True)
            if idx % 50 == 0:
                print(f"\n⏱️ 进度: {idx}/{len(matches)} 场, 已耗时 {time.time() - t0_loop:.1f}s")

        results.sort(key=lambda x: x['score'], reverse=True)
        if llm_engine_enabled:
            selected_llm_tasks, selected_llm_ids, eligible_llm_count = select_llm_prediction_tasks(
                results,
                limit=llm_max_matches,
            )
            if eligible_llm_count:
                print(
                    f"\n🤖 大模型精选: 从{eligible_llm_count}场赔率合格候选中择优"
                    f"{len(selected_llm_tasks)}场"
                )
            for llm_rank, (_llm_score, _order, result, llm_reason) in enumerate(selected_llm_tasks, start=1):
                task = result.get('_llm_task') or {}
                match_label = task.get('match_name') or result.get('ti') or '未知比赛'
                print(f"\n🤖 DeepSeek精选 {llm_rank}/{len(selected_llm_tasks)}: {match_label} | {llm_reason}", flush=True)
                llm_prediction_calls += 1
                llm_result = self.kimi_engine.predict_match(task.get('ctx') or {}, task.get('info') or {})
                result['kimi_review_html'] = llm_result.get('html', '') or ""
                result['web_verification_html'] = ""

            for result in results:
                if not result.get('_llm_task') or id(result) in selected_llm_ids:
                    continue
                _score, reason = score_llm_prediction_task(result)
                result['kimi_review_html'] = render_gemini_status_card(
                    f"未进入大模型精选{llm_max_matches}场：{reason}"
                )
                result['web_verification_html'] = ""

        for result in results:
            result.pop('_llm_task', None)

        wdl_parlays, mixed_parlays = self.generate_dual_parlays(wdl_candidates, mixed_candidates)
        top_singles = self._select_top_single_cards(results, limit=10)
        stats = self.process_logs_and_history(wdl_parlays, mixed_parlays, top_singles, all_matches_data, results)
        self.generate_html(results, wdl_parlays, mixed_parlays, stats)
        print(f"🤖 大模型实际预测: {llm_prediction_calls}/{len(matches)} 场")
        print(f"⏱️ 全流程完成: {time.time() - t0_all:.2f}s")

if __name__ == "__main__":
    PredictorV104_Expert().run()
