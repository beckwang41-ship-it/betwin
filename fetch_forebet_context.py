import argparse
import difflib
import re
import time
from collections import defaultdict
from pathlib import Path

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

from forebet_context import (
    FOREBET_LEAGUE_URL_MAP,
    build_forebet_detail_payload,
    extract_league_fixture_candidates,
    find_best_fixture,
    parse_detail_injuries,
    parse_injured_players_page,
    parse_match_centre_lineups,
    parse_match_centre_url,
)
from match_context_pipeline import (
    canonicalize_team_name,
    compute_motivation_signals,
    load_base_matches,
    load_json,
    load_team_alias_map,
    parse_iso_datetime,
    save_json,
    team_names_match,
)


BASE_DIR = Path(__file__).resolve().parent
OUTPUT_FILE = BASE_DIR / "forebet_context.json"
INDEX_FILE = BASE_DIR / "forebet_match_index.json"
ALIAS_HINT_FILE = BASE_DIR / "forebet_alias_hints.json"
CACHE_DIR = BASE_DIR / "output" / "forebet_cache"
INJURED_PLAYERS_URL = "https://www.forebet.com/en/football/injured-players"
LEGACY_INJURED_CACHE = BASE_DIR / "output" / "forebet_injured_players.html"


def safe_slug(text):
    return re.sub(r"[^\w-]+", "_", str(text or ""), flags=re.UNICODE).strip("_") or "page"


def build_browser_context(playwright):
    browser = playwright.chromium.launch(
        headless=True,
        args=["--disable-blink-features=AutomationControlled"],
    )
    context = browser.new_context(
        user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
        viewport={"width": 1440, "height": 2200},
        locale="en-US",
        timezone_id="Asia/Shanghai",
    )
    context.add_init_script(
        """
Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']});
Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
        """
    )
    return browser, context


def fetch_html(page, url, cache_key, expected_selector=None, attempts=2):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    last_error = None
    for attempt in range(1, attempts + 1):
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=60000)
            if expected_selector:
                try:
                    page.wait_for_selector(expected_selector, state="attached", timeout=20000)
                except PlaywrightTimeoutError:
                    html = page.content()
                    title = page.title()
                    if "Just a moment" not in title and "cf-mitigated" not in html:
                        if expected_selector == ".schema" and extract_league_fixture_candidates(html):
                            cache_path = CACHE_DIR / f"{cache_key}.html"
                            cache_path.write_text(html, encoding="utf-8")
                            return html
                    raise
            page.wait_for_timeout(2500 + 1500 * attempt)
            html = page.content()
            title = page.title()
            if "Just a moment" in title or "cf-mitigated" in html:
                raise RuntimeError(f"Cloudflare challenge 未通过: {title}")
            cache_path = CACHE_DIR / f"{cache_key}.html"
            cache_path.write_text(html, encoding="utf-8")
            return html
        except Exception as exc:
            last_error = exc
            page.wait_for_timeout(3000)
    raise RuntimeError(f"抓取失败: {url} | {last_error}")


def fetch_league_html(page, url, cache_key, attempts=3):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    last_error = None
    for attempt in range(1, attempts + 1):
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(3500 + 1500 * attempt)
            html = page.content()
            title = page.title()
            if "Just a moment" in title or "cf-mitigated" in html:
                raise RuntimeError(f"Cloudflare challenge 未通过: {title}")
            candidates = extract_league_fixture_candidates(html)
            if candidates:
                cache_path = CACHE_DIR / f"{cache_key}.html"
                cache_path.write_text(html, encoding="utf-8")
                return html
            last_error = RuntimeError("联赛页未解析出任何候选比赛")
        except Exception as exc:
            last_error = exc
        page.wait_for_timeout(3000)
    raise RuntimeError(f"抓取失败: {url} | {last_error}")


def build_standings_payload(standings_snapshot, home_team, away_team, league_name, alias_map=None):
    rows = []
    canonical_snapshot = {}
    for team_name, data in (standings_snapshot or {}).items():
        canonical_team = canonicalize_team_name(team_name, alias_map or {})
        row = {
            "team": canonical_team,
            "rank": data.get("rank"),
            "points": data.get("pts"),
        }
        rows.append(row)
        canonical_snapshot[canonical_team] = data

    total_teams = len(rows)
    home_sig = compute_motivation_signals(rows, home_team, league_name, total_teams)
    away_sig = compute_motivation_signals(rows, away_team, league_name, total_teams)

    home_data = canonical_snapshot.get(home_team, {})
    away_data = canonical_snapshot.get(away_team, {})
    return {
        "home_rank": home_data.get("rank"),
        "away_rank": away_data.get("rank"),
        "home_points": home_data.get("pts"),
        "away_points": away_data.get("pts"),
        "home_pressure": home_sig.get("pressure", "unknown"),
        "away_pressure": away_sig.get("pressure", "unknown"),
        "home_motivation": home_sig.get("motivation", "暂无积分榜信息"),
        "away_motivation": away_sig.get("motivation", "暂无积分榜信息"),
        "home_snapshot": home_data,
        "away_snapshot": away_data,
    }


def build_history_payload(detail_payload):
    basics = detail_payload.get("match_info") or {}
    sections = detail_payload.get("history_context") or {}
    intro = basics.get("intro_paragraphs") or []
    return {
        "head_to_head_matches": sections.get("head_to_head") or [],
        "home_last6_matches": sections.get("home_last6") or [],
        "away_last6_matches": sections.get("away_last6") or [],
        "home_matches": sections.get("home_matches") or [],
        "away_matches": sections.get("away_matches") or [],
        "intro_paragraphs": intro[:6],
    }


def _safe_int(value, default=0):
    try:
        return int(value)
    except Exception:
        return default


def _safe_float(value, default=0.0):
    try:
        return float(value)
    except Exception:
        return default


def _parse_score_pair(score_text):
    text = str(score_text or "").strip()
    match = re.search(r"(\d+)\s*[-:]\s*(\d+)", text)
    if not match:
        return None, None
    return int(match.group(1)), int(match.group(2))


def _streak(outcomes, target):
    cnt = 0
    for item in outcomes:
        if item == target:
            cnt += 1
        else:
            break
    return cnt


def _unbeaten_streak(outcomes):
    cnt = 0
    for item in outcomes:
        if item in {"W", "D"}:
            cnt += 1
        else:
            break
    return cnt


def summarize_team_form(rows, team_name, alias_map):
    rows = [x for x in (rows or []) if isinstance(x, dict)]
    outcomes = []
    gf = ga = over25 = btts = clean_sheet = failed_to_score = 0
    valid = 0
    for row in rows:
        hs, as_ = _parse_score_pair(row.get("score"))
        if hs is None:
            continue
        home = row.get("home_team")
        away = row.get("away_team")
        if team_names_match(team_name, home, alias_map):
            tg, og = hs, as_
        elif team_names_match(team_name, away, alias_map):
            tg, og = as_, hs
        else:
            continue

        valid += 1
        gf += tg
        ga += og
        total = tg + og
        if total >= 3:
            over25 += 1
        if tg > 0 and og > 0:
            btts += 1
        if og == 0:
            clean_sheet += 1
        if tg == 0:
            failed_to_score += 1

        if tg > og:
            outcomes.append("W")
        elif tg == og:
            outcomes.append("D")
        else:
            outcomes.append("L")

    wins = outcomes.count("W")
    draws = outcomes.count("D")
    losses = outcomes.count("L")
    form = f"{wins}-{draws}-{losses}" if outcomes else ""
    avg_total_goals = round((gf + ga) / valid, 3) if valid else 0.0
    avg_goals_for = round(gf / valid, 3) if valid else 0.0
    avg_goals_against = round(ga / valid, 3) if valid else 0.0

    return {
        "matches": valid,
        "form_wdl": form,
        "wins": wins,
        "draws": draws,
        "losses": losses,
        "goals_for": gf,
        "goals_against": ga,
        "over25_count": over25,
        "btts_count": btts,
        "clean_sheet_count": clean_sheet,
        "failed_to_score_count": failed_to_score,
        "avg_total_goals": avg_total_goals,
        "avg_goals_for": avg_goals_for,
        "avg_goals_against": avg_goals_against,
        "win_streak": _streak(outcomes, "W"),
        "unbeaten_streak": _unbeaten_streak(outcomes),
    }


def summarize_h2h(rows, home_team, away_team, alias_map):
    rows = [x for x in (rows or []) if isinstance(x, dict)]
    home_wins = draws = away_wins = over25 = btts = 0
    valid = 0
    for row in rows:
        hs, as_ = _parse_score_pair(row.get("score"))
        if hs is None:
            continue
        row_home = row.get("home_team")
        row_away = row.get("away_team")
        if team_names_match(home_team, row_home, alias_map) and team_names_match(away_team, row_away, alias_map):
            hg, ag = hs, as_
        elif team_names_match(home_team, row_away, alias_map) and team_names_match(away_team, row_home, alias_map):
            hg, ag = as_, hs
        else:
            continue

        valid += 1
        if hg > ag:
            home_wins += 1
        elif hg == ag:
            draws += 1
        else:
            away_wins += 1
        if hg + ag >= 3:
            over25 += 1
        if hg > 0 and ag > 0:
            btts += 1

    return {
        "matches": valid,
        "home_wins": home_wins,
        "draws": draws,
        "away_wins": away_wins,
        "over25_count": over25,
        "btts_count": btts,
    }


def _normalize_match_specific_trends(trend_payload):
    trend_payload = trend_payload or {}
    return {
        "home_trends": list(trend_payload.get("home") or []),
        "away_trends": list(trend_payload.get("away") or []),
        "home_team": str(trend_payload.get("home_team") or ""),
        "away_team": str(trend_payload.get("away_team") or ""),
    }


def _trend_note(prefix, item):
    item = item or {}
    trend_type = str(item.get("trend_type") or "").strip()
    record = str(item.get("record") or "").strip()
    league_scope = str(item.get("league_scope") or "").strip()
    if not trend_type:
        return ""
    trend_type_map = {
        "Undefeated": "不败",
        "Unbeaten": "不败",
        "Winless": "不胜",
        "Lost": "失利",
        "Draws at HT": "半场平局",
        "Both scored": "双方进球",
        "Scored None": "未进球",
        "Clean sheet": "零封",
    }
    trend_type = trend_type_map.get(trend_type, trend_type)
    if re.search(r"[A-Za-z]", trend_type):
        trend_type = "趋势信号"
    note = f"{prefix}{trend_type}"
    if record:
        note += f" {record}"
    if league_scope:
        note += f" ({league_scope})"
    return note


def build_trend_context_from_history(history_payload, home_team, away_team, alias_map, match_specific_trends=None):
    history_payload = history_payload or {}
    home_last6 = (history_payload.get("home_last6_matches") or [])[:6]
    away_last6 = (history_payload.get("away_last6_matches") or [])[:6]
    h2h = (history_payload.get("head_to_head_matches") or [])[:3]
    trend_cards = _normalize_match_specific_trends(match_specific_trends)

    home_form = summarize_team_form(home_last6, home_team, alias_map)
    away_form = summarize_team_form(away_last6, away_team, alias_map)
    h2h_summary = summarize_h2h(h2h, home_team, away_team, alias_map)

    notes = []
    if home_form.get("matches"):
        notes.append(f"主队近况{home_form.get('form_wdl')}")
    if away_form.get("matches"):
        notes.append(f"客队近况{away_form.get('form_wdl')}")
    if h2h_summary.get("matches"):
        notes.append(
            f"交锋{h2h_summary.get('home_wins')}-{h2h_summary.get('draws')}-{h2h_summary.get('away_wins')}"
        )
    home_trends = trend_cards.get("home_trends") or []
    away_trends = trend_cards.get("away_trends") or []
    if home_trends:
        note = _trend_note("主队趋势:", home_trends[0])
        if note:
            notes.append(note)
    if away_trends:
        note = _trend_note("客队趋势:", away_trends[0])
        if note:
            notes.append(note)

    return {
        "source": "forebet_match_trends+history_stats",
        "method": "比赛专属趋势卡片 + 本场双方交锋与近期战绩统计，不使用Top trends",
        "home_form": home_form,
        "away_form": away_form,
        "h2h_form": h2h_summary,
        "home_trends": home_trends,
        "away_trends": away_trends,
        "notes": notes[:6],
    }


def _extract_stat_slice(side_payload, index):
    side_payload = side_payload or {}
    played = _safe_int((side_payload.get("pl") or [0, 0, 0])[index], 0)
    goals_for = _safe_int((side_payload.get("scr") or [0, 0, 0])[index], 0)
    goals_against = _safe_int((side_payload.get("cnd") or [0, 0, 0])[index], 0)
    under15 = _safe_int((side_payload.get("un1.5") or [0, 0, 0])[index], 0)
    under25 = _safe_int((side_payload.get("un2.5") or [0, 0, 0])[index], 0)
    under35 = _safe_int((side_payload.get("un3.5") or [0, 0, 0])[index], 0)
    btts_yes = _safe_int((side_payload.get("bts") or [0, 0, 0])[index], 0)
    shots_total = _safe_int((side_payload.get("shots_total") or [0, 0, 0])[index], 0)
    shots_on = _safe_int((side_payload.get("shots_on_target") or [0, 0, 0])[index], 0)
    shots_off = _safe_int((side_payload.get("shots_off_target") or [0, 0, 0])[index], 0)
    shots_inside = _safe_int((side_payload.get("shots_insidebox") or [0, 0, 0])[index], 0)
    shots_outside = _safe_int((side_payload.get("shots_outsidebox") or [0, 0, 0])[index], 0)
    blocked = _safe_int((side_payload.get("shots_blocked") or [0, 0, 0])[index], 0)
    passes_total = _safe_int((side_payload.get("passes_total") or [0, 0, 0])[index], 0)
    passes_accurate = _safe_int((side_payload.get("passes_accurate") or [0, 0, 0])[index], 0)
    possession_avg = _safe_float((side_payload.get("ball_poss") or [0, 0, 0])[index], 0.0)

    return {
        "played": played,
        "goals_for": goals_for,
        "goals_against": goals_against,
        "goals_for_per_game": round(goals_for / played, 3) if played else 0.0,
        "goals_against_per_game": round(goals_against / played, 3) if played else 0.0,
        "under_1_5": under15,
        "over_1_5": max(0, played - under15),
        "under_2_5": under25,
        "over_2_5": max(0, played - under25),
        "under_3_5": under35,
        "over_3_5": max(0, played - under35),
        "btts_yes": btts_yes,
        "btts_no": max(0, played - btts_yes),
        "shots_total": shots_total,
        "shots_per_game": round(shots_total / played, 3) if played else 0.0,
        "shots_on_target_pct": round(shots_on * 100.0 / shots_total, 3) if shots_total else 0.0,
        "shots_off_target_pct": round(shots_off * 100.0 / shots_total, 3) if shots_total else 0.0,
        "shots_inside_box_pct": round(shots_inside * 100.0 / (shots_inside + shots_outside), 3)
        if (shots_inside + shots_outside)
        else 0.0,
        "shots_outside_box_pct": round(shots_outside * 100.0 / (shots_inside + shots_outside), 3)
        if (shots_inside + shots_outside)
        else 0.0,
        "blocked_shots": blocked,
        "blocked_shots_per_game": round(blocked / played, 3) if played else 0.0,
        "passes_total": passes_total,
        "passes_per_game": round(passes_total / played, 3) if played else 0.0,
        "pass_accuracy_pct": round(passes_accurate * 100.0 / passes_total, 3) if passes_total else 0.0,
        "possession_avg": round(possession_avg, 3),
    }


def _build_scope_summary(home_payload, away_payload, scope_key, scope_label):
    home_scope = ((home_payload or {}).get(scope_key) or {}).get("ft") or {}
    away_scope = ((away_payload or {}).get(scope_key) or {}).get("ft") or {}
    return {
        "label": scope_label,
        "home": _extract_stat_slice(home_scope, 0),
        "away": _extract_stat_slice(away_scope, 0),
    }


def _build_home_away_scope_summary(home_payload, away_payload, scope_key, scope_label):
    home_scope = ((home_payload or {}).get(scope_key) or {}).get("ft") or {}
    away_scope = ((away_payload or {}).get(scope_key) or {}).get("ft") or {}
    return {
        "label": scope_label,
        "home": _extract_stat_slice(home_scope, 1),
        "away": _extract_stat_slice(away_scope, 2),
    }


def build_technical_stats_context(technical_stats_payload):
    technical_stats_payload = technical_stats_payload or {}
    if not technical_stats_payload:
        return {}

    labels = dict(technical_stats_payload.get("league_labels") or {})
    home_payload = technical_stats_payload.get("home") or {}
    away_payload = technical_stats_payload.get("away") or {}
    primary_key = next((key for key in labels.keys() if key != "all"), "")

    context = {
        "source": "forebet_overall_stats",
        "method": "Forebet overall statistics full-time summary",
        "league_labels": labels,
        "overall": {
            "all": _build_scope_summary(home_payload, away_payload, "all", labels.get("all", "All Leagues")),
        },
        "home_away": {
            "all": _build_home_away_scope_summary(home_payload, away_payload, "all", labels.get("all", "All Leagues")),
        },
        "under_over_btts": {
            "all": {
                "home": _build_scope_summary(home_payload, away_payload, "all", labels.get("all", "All Leagues"))["home"],
                "away": _build_scope_summary(home_payload, away_payload, "all", labels.get("all", "All Leagues"))["away"],
            }
        },
    }

    if primary_key:
        league_label = labels.get(primary_key, primary_key)
        context["overall"]["league"] = _build_scope_summary(home_payload, away_payload, primary_key, league_label)
        context["home_away"]["league"] = _build_home_away_scope_summary(home_payload, away_payload, primary_key, league_label)
        context["under_over_btts"]["league"] = {
            "home": context["overall"]["league"]["home"],
            "away": context["overall"]["league"]["away"],
        }

    return context


def build_injury_lookup(injuries_by_team, alias_map):
    lookup = {}
    for team_name, players in (injuries_by_team or {}).items():
        canonical = canonicalize_team_name(team_name, alias_map or {})
        lookup[canonical] = players
    return lookup


def is_valid_injuries_html(html):
    text = str(html or "")
    return "Current list of injured and suspended players" in text or 'table class="suspended"' in text


def fetch_injuries_lookup(page, alias_map):
    html = ""
    try:
        html = fetch_html(
            page,
            INJURED_PLAYERS_URL,
            cache_key="injured_players",
            attempts=1,
        )
        if not is_valid_injuries_html(html):
            html = ""
    except Exception:
        html = ""

    if not html:
        for cache_path in (LEGACY_INJURED_CACHE, CACHE_DIR / "injured_players.html"):
            if cache_path.exists():
                candidate = cache_path.read_text(encoding="utf-8", errors="ignore")
                if is_valid_injuries_html(candidate):
                    html = candidate
                    print(f"   ↳ 伤停页使用缓存: {cache_path}")
                    break

    if not html:
        print("   ⚠️ Forebet 伤停总表抓取失败，且无本地缓存")
        return {}
    return build_injury_lookup(parse_injured_players_page(html), alias_map)


def build_lineup_payload(lineups, source_url="", home_absences=None, away_absences=None):
    lineups = lineups or {}
    home_starting = lineups.get("home_starting") or []
    away_starting = lineups.get("away_starting") or []
    home_subs = lineups.get("home_subs") or []
    away_subs = lineups.get("away_subs") or []
    return {
        "lineup_confirmed": bool(home_starting or away_starting),
        "source": "forebet_match_centre" if source_url else "forebet",
        "source_url": source_url,
        "home_starting": home_starting,
        "away_starting": away_starting,
        "home_subs": home_subs,
        "away_subs": away_subs,
        "home_absences": home_absences or [],
        "away_absences": away_absences or [],
    }


def merge_absence_lists(primary, fallback):
    primary = [x for x in (primary or []) if isinstance(x, dict)]
    fallback = [x for x in (fallback or []) if isinstance(x, dict)]
    return primary or fallback


def resolve_absences_for_team(lookup, team_name, alias_map, fallback=None):
    canonical = canonicalize_team_name(team_name, alias_map or {})
    return merge_absence_lists((lookup or {}).get(canonical, []), fallback or [])


def detect_team_injury_status(global_lookup, detail_lookup, team_name, alias_map):
    global_absences = resolve_absences_for_team(global_lookup, team_name, alias_map, [])
    if global_absences:
        return "global_hit"
    detail_absences = resolve_absences_for_team(detail_lookup, team_name, alias_map, [])
    if detail_absences:
        return "detail_hit"
    return "no_data"


def build_injury_status(global_lookup, detail_lookup, home_team, away_team, alias_map, global_page_available):
    return {
        "home": detect_team_injury_status(global_lookup, detail_lookup, home_team, alias_map),
        "away": detect_team_injury_status(global_lookup, detail_lookup, away_team, alias_map),
        "global_page_available": bool(global_page_available),
    }


def group_matches_by_league(matches):
    grouped = defaultdict(list)
    for row in matches:
        league = str(row.get("league") or "").strip()
        if league:
            grouped[league].append(row)
    return grouped


def load_existing_context_for_current_matches(base_matches, force_all=False):
    if force_all:
        return {}
    current_ids = {str(row.get("match_id") or "") for row in base_matches or []}
    existing = load_json(OUTPUT_FILE, {})
    if not isinstance(existing, dict):
        return {}
    return {
        str(match_id): payload
        for match_id, payload in existing.items()
        if str(match_id) in current_ids and isinstance(payload, dict)
    }


def load_existing_index(force_all=False):
    if force_all:
        return {}
    existing = load_json(INDEX_FILE, {})
    return existing if isinstance(existing, dict) else {}


def normalize_alias_key(name):
    text = str(name or "").strip().lower()
    return re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "", text)


def pick_alias_candidates(local_name, pool_names, alias_map, limit=3):
    local_canonical = canonicalize_team_name(local_name, alias_map or {})
    local_key = normalize_alias_key(local_canonical or local_name)
    if not local_key:
        return []

    scored = []
    seen = set()
    for name in pool_names or []:
        candidate = str(name or "").strip()
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        candidate_canonical = canonicalize_team_name(candidate, alias_map or {})
        candidate_key = normalize_alias_key(candidate_canonical or candidate)
        if not candidate_key:
            continue
        score = difflib.SequenceMatcher(None, local_key, candidate_key).ratio()
        if local_key in candidate_key or candidate_key in local_key:
            score = max(score, 0.86)
        scored.append((score, candidate))

    scored.sort(key=lambda x: (x[0], x[1]), reverse=True)
    picked = []
    for score, candidate in scored[:limit]:
        if score < 0.45:
            continue
        picked.append({"forebet_team": candidate, "score": round(float(score), 3)})
    return picked


def pick_kickoff_candidates(local_kickoff_time, candidates, limit=3):
    local_dt = parse_iso_datetime(local_kickoff_time)
    if not local_dt:
        return []

    scored = []
    for row in candidates or []:
        candidate_dt = parse_iso_datetime((row or {}).get("kickoff_iso"))
        if not candidate_dt:
            continue
        gap_hours = abs((candidate_dt - local_dt).total_seconds()) / 3600.0
        scored.append((gap_hours, row))

    scored.sort(key=lambda x: x[0])
    picked = []
    for gap_hours, row in scored[:limit]:
        picked.append(
            {
                "home_team": str((row or {}).get("home_team") or ""),
                "away_team": str((row or {}).get("away_team") or ""),
                "kickoff_iso": str((row or {}).get("kickoff_iso") or ""),
                "hours_gap": round(float(gap_hours), 2),
            }
        )
    return picked


def build_alias_hint(match_row, candidates, alias_map):
    home_pool = [str((row or {}).get("home_team") or "").strip() for row in (candidates or [])]
    away_pool = [str((row or {}).get("away_team") or "").strip() for row in (candidates or [])]
    hint = {
        "match_id": str((match_row or {}).get("match_id") or ""),
        "league": str((match_row or {}).get("league") or ""),
        "home_team": str((match_row or {}).get("home_team") or ""),
        "away_team": str((match_row or {}).get("away_team") or ""),
        "home_alias_candidates": pick_alias_candidates((match_row or {}).get("home_team"), home_pool, alias_map),
        "away_alias_candidates": pick_alias_candidates((match_row or {}).get("away_team"), away_pool, alias_map),
        "kickoff_candidates": pick_kickoff_candidates((match_row or {}).get("kickoff_time"), candidates),
    }
    return hint


def format_alias_hint(hint):
    parts = []
    home_top = ((hint or {}).get("home_alias_candidates") or [])
    away_top = ((hint or {}).get("away_alias_candidates") or [])
    if home_top:
        top = home_top[0]
        parts.append(f"主队候选:{top['forebet_team']}({top['score']:.2f})")
    if away_top:
        top = away_top[0]
        parts.append(f"客队候选:{top['forebet_team']}({top['score']:.2f})")
    kickoff_top = ((hint or {}).get("kickoff_candidates") or [])
    if kickoff_top:
        top = kickoff_top[0]
        parts.append(
            "时间候选:"
            f"{top.get('home_team', '')} vs {top.get('away_team', '')}"
            f"({float(top.get('hours_gap') or 0):.1f}h)"
        )
    return "；".join(parts)


def main():
    parser = argparse.ArgumentParser(description="抓取 Forebet 情报；默认只补抓当前比赛中缺失的场次。")
    parser.add_argument("--force-all", action="store_true", help="忽略已有 forebet_context.json，重新全量抓取。")
    args = parser.parse_args()

    base_matches = load_base_matches()
    alias_map = load_team_alias_map()
    output = load_existing_context_for_current_matches(base_matches, force_all=args.force_all)
    index_map = load_existing_index(force_all=args.force_all)
    pending_matches = [row for row in base_matches if str(row.get("match_id") or "") not in output]
    grouped = group_matches_by_league(pending_matches)

    detail_injury_map = {}
    unmatched = []
    alias_hints = []
    skipped = []

    if output and not args.force_all:
        print(f"♻️ 复用已有 Forebet 情报: {len(output)} 场")
    if not pending_matches:
        save_json(OUTPUT_FILE, output)
        save_json(INDEX_FILE, index_map)
        save_json(ALIAS_HINT_FILE, [])
        print(f"\n✅ Forebet 情报已是最新: {OUTPUT_FILE} | 命中 {len(output)}/{len(base_matches)} 场")
        return
    print(f"🔎 本次仅补抓缺失比赛: {len(pending_matches)} 场")

    with sync_playwright() as playwright:
        browser, context = build_browser_context(playwright)
        page = context.new_page()

        for league, matches in grouped.items():
            league_url = FOREBET_LEAGUE_URL_MAP.get(league)
            if not league_url:
                skipped.append(f"{league}: 未配置 Forebet 联赛页")
                continue

            print(f"\n🌐 抓取联赛页: {league} -> {league_url}")
            league_html = fetch_league_html(
                page,
                league_url,
                cache_key=f"league_{safe_slug(league)}",
            )
            candidates = extract_league_fixture_candidates(league_html)
            print(f"   联赛页候选比赛: {len(candidates)} 场")

            for match_row in matches:
                match_id = str(match_row["match_id"])
                fixture = find_best_fixture(match_row, candidates, alias_map)
                if not fixture:
                    hint = build_alias_hint(match_row, candidates, alias_map)
                    hint_text = format_alias_hint(hint)
                    if hint_text:
                        unmatched.append(
                            f"{league} | {match_row['home_team']} vs {match_row['away_team']} | 联赛页未定位 | {hint_text}"
                        )
                    else:
                        unmatched.append(f"{league} | {match_row['home_team']} vs {match_row['away_team']} | 联赛页未定位")
                    if hint.get("home_alias_candidates") or hint.get("away_alias_candidates"):
                        alias_hints.append(hint)
                    continue

                detail_url = fixture["url"]
                detail_match_id = fixture.get("match_id") or ""
                print(f"   ↳ 命中 {match_id}: {match_row['home_team']} vs {match_row['away_team']} -> {detail_match_id}")
                detail_html = fetch_html(
                    page,
                    detail_url,
                    cache_key=f"detail_{detail_match_id or safe_slug(match_id)}",
                    expected_selector=".predictioncontain",
                )

                detail_payload = build_forebet_detail_payload(detail_html)
                basics = detail_payload.get("match_info") or {}
                standings_snapshot = detail_payload.get("standings_snapshot") or {}
                detail_injuries = build_injury_lookup(parse_detail_injuries(detail_html), alias_map)
                history_payload = build_history_payload(detail_payload)
                trend_payload = build_trend_context_from_history(
                    history_payload,
                    match_row["home_team"],
                    match_row["away_team"],
                    alias_map,
                    match_specific_trends=detail_payload.get("match_specific_trends") or {},
                )
                technical_stats_payload = build_technical_stats_context(detail_payload.get("technical_stats") or {})
                detail_injury_map[match_id] = detail_injuries
                match_centre_url = parse_match_centre_url(detail_html)
                lineup_payload = {}
                if match_centre_url:
                    try:
                        match_centre_html = fetch_html(
                            page,
                            match_centre_url,
                            cache_key=f"match_centre_{detail_match_id or safe_slug(match_id)}",
                            expected_selector="#st_hostTeam",
                        )
                        lineup_payload = build_lineup_payload(
                            parse_match_centre_lineups(match_centre_html),
                            source_url=match_centre_url,
                            home_absences=resolve_absences_for_team(detail_injuries, match_row["home_team"], alias_map),
                            away_absences=resolve_absences_for_team(detail_injuries, match_row["away_team"], alias_map),
                        )
                    except Exception as exc:
                        print(f"     ⚠️ Match centre 抓取失败 {match_id}: {exc}")

                standings_payload = build_standings_payload(
                    standings_snapshot,
                    match_row["home_team"],
                    match_row["away_team"],
                    basics.get("league_name") or league,
                    alias_map=alias_map,
                )
                if not lineup_payload:
                    lineup_payload = build_lineup_payload(
                        {},
                        home_absences=resolve_absences_for_team(detail_injuries, match_row["home_team"], alias_map),
                        away_absences=resolve_absences_for_team(detail_injuries, match_row["away_team"], alias_map),
                    )
                output[match_id] = {
                    "source": "forebet",
                    "source_url": detail_url,
                    "source_match_id": detail_match_id,
                    "match_info": basics,
                    "standings_snapshot": standings_snapshot,
                    "standings_motivation": standings_payload,
                    "lineup_injury": lineup_payload,
                    "history_context": history_payload,
                    "schedule_context": detail_payload.get("schedule_context") or {},
                    "trend_context": trend_payload,
                    "technical_stats_context": technical_stats_payload,
                }
                index_map[f"{league}|{match_row['home_team']}|{match_row['away_team']}"] = {
                    "url": detail_url,
                    "forebet_match_id": detail_match_id,
                }
                time.sleep(0.8)

        injuries_lookup = fetch_injuries_lookup(page, alias_map)
        if injuries_lookup:
            for match_row in pending_matches:
                match_id = str(match_row["match_id"])
                payload = output.get(match_id)
                if not payload:
                    continue
                lineup_payload = payload.get("lineup_injury") or {}
                detail_injuries = detail_injury_map.get(match_id) or {}
                lineup_payload["home_absences"] = resolve_absences_for_team(
                    injuries_lookup,
                    match_row["home_team"],
                    alias_map,
                    resolve_absences_for_team(
                        detail_injuries,
                        match_row["home_team"],
                        alias_map,
                        lineup_payload.get("home_absences", []),
                    ),
                )
                lineup_payload["away_absences"] = resolve_absences_for_team(
                    injuries_lookup,
                    match_row["away_team"],
                    alias_map,
                    resolve_absences_for_team(
                        detail_injuries,
                        match_row["away_team"],
                        alias_map,
                        lineup_payload.get("away_absences", []),
                    ),
                )
                lineup_payload["injury_status"] = build_injury_status(
                    injuries_lookup,
                    detail_injuries,
                    match_row["home_team"],
                    match_row["away_team"],
                    alias_map,
                    global_page_available=bool(injuries_lookup),
                )
                payload["lineup_injury"] = lineup_payload
        else:
            for match_row in pending_matches:
                match_id = str(match_row["match_id"])
                payload = output.get(match_id)
                if not payload:
                    continue
                lineup_payload = payload.get("lineup_injury") or {}
                detail_injuries = detail_injury_map.get(match_id) or {}
                lineup_payload["injury_status"] = build_injury_status(
                    {},
                    detail_injuries,
                    match_row["home_team"],
                    match_row["away_team"],
                    alias_map,
                    global_page_available=False,
                )
                payload["lineup_injury"] = lineup_payload

        browser.close()

    save_json(OUTPUT_FILE, output)
    save_json(INDEX_FILE, index_map)
    save_json(ALIAS_HINT_FILE, alias_hints)

    print(f"\n✅ Forebet 情报生成完成: {OUTPUT_FILE} | 命中 {len(output)}/{len(base_matches)} 场")
    print(f"🧩 别名提示文件: {ALIAS_HINT_FILE} | {len(alias_hints)} 场可手动补别名")
    if skipped:
        print("⚠️ 未配置联赛:")
        for item in skipped:
            print(f" - {item}")
    if unmatched:
        print("⚠️ 未命中的比赛:")
        for item in unmatched:
            print(f" - {item}")


if __name__ == "__main__":
    main()
