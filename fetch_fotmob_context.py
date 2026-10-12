import argparse
import json
import re
import time
from datetime import datetime, timedelta
from difflib import SequenceMatcher
from pathlib import Path
from urllib.parse import urlencode

import requests
from bs4 import BeautifulSoup
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

from match_context_pipeline import (
    canonicalize_team_name,
    load_base_matches,
    load_json,
    load_team_alias_map,
    normalize_name,
    save_json,
    team_names_match,
)


BASE_DIR = Path(__file__).resolve().parent
OUTPUT_FILE = BASE_DIR / "fotmob_context.json"
FULL_CONTEXT_FILE = BASE_DIR / "match_context_full.json"
CACHE_DIR = BASE_DIR / "output" / "fotmob_cache"
FOTMOB_BASE_URL = "https://www.fotmob.com"
FOTMOB_MATCHES_API = f"{FOTMOB_BASE_URL}/api/data/matches"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/123.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json,text/html;q=0.9,*/*;q=0.8",
    "Referer": FOTMOB_BASE_URL + "/",
}
TIMEZONE = "Asia/Shanghai"


def safe_slug(text):
    text = str(text or "").strip().lower()
    text = re.sub(r"['’]", "", text)
    text = re.sub(r"[^a-z0-9]+", "-", text)
    return text.strip("-") or "team"


def build_fotmob_date(value=None):
    if value:
        text = str(value).strip()
        if re.fullmatch(r"\d{8}", text):
            return text
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
            return text.replace("-", "")
        raise ValueError("日期格式应为 YYYYMMDD 或 YYYY-MM-DD")
    return (datetime.now() + timedelta(days=1)).strftime("%Y%m%d")


def build_fotmob_dates(value=None):
    if value:
        raw_parts = re.split(r"[,，\s]+", str(value).strip())
        dates = []
        seen = set()
        for raw in raw_parts:
            if not raw:
                continue
            normalized = build_fotmob_date(raw)
            if normalized not in seen:
                seen.add(normalized)
                dates.append(normalized)
        if dates:
            return dates
        raise ValueError("至少提供一个有效日期")

    base = datetime.now()
    return [
        base.strftime("%Y%m%d"),
        (base + timedelta(days=1)).strftime("%Y%m%d"),
    ]


def build_matches_api_url(date_text):
    query = urlencode({"date": date_text, "timezone": TIMEZONE, "ccode3": "USA"})
    return f"{FOTMOB_MATCHES_API}?{query}"


def build_fallback_match_url(home_name, away_name, match_id):
    # FotMob 用 hash 定位 matchId；真实短码稍后会从赛程页 href 里补齐。
    home_slug = safe_slug(home_name)
    away_slug = safe_slug(away_name)
    return f"{FOTMOB_BASE_URL}/matches/{away_slug}-vs-{home_slug}/match#{match_id}"


def _to_number(value):
    if value in (None, ""):
        return None
    try:
        number = float(str(value).replace(",", ""))
    except Exception:
        return None
    if number.is_integer():
        return int(number)
    return round(number, 2)


def _compact_number(value):
    number = _to_number(value)
    if number is None:
        return ""
    return str(number)


def _compact_rating(value):
    number = _to_number(value)
    if number is None:
        return ""
    return f"{float(number):.1f}"


def _best_text(value):
    return str(value or "").strip()


def _role_from_position_text(label):
    text = _best_text(label).lower()
    if not text:
        return "", ""
    if any(key in text for key in ["goalkeeper", "keeper"]):
        return "G", "门将"
    if any(key in text for key in ["back", "defender", "centre-back", "center-back", "wing-back"]):
        return "D", "后卫"
    if any(key in text for key in ["midfielder", "midfield"]):
        return "M", "中场"
    if any(key in text for key in ["forward", "striker", "winger", "attacker", "second striker"]):
        return "F", "前锋"
    return "", ""


def flatten_fotmob_matches(schedule_json, schedule_date=None):
    rows = []
    for league in (schedule_json or {}).get("leagues") or []:
        league_name = _best_text(league.get("name"))
        league_id = league.get("id") or league.get("primaryId")
        for match in league.get("matches") or []:
            home = match.get("home") or {}
            away = match.get("away") or {}
            match_id = match.get("id")
            if not match_id:
                continue
            home_name = _best_text(home.get("longName") or home.get("name"))
            away_name = _best_text(away.get("longName") or away.get("name"))
            if not home_name or not away_name:
                continue
            rows.append(
                {
                    "match_id": int(match_id),
                    "league_id": league_id or match.get("leagueId"),
                    "league_name": league_name,
                    "home_id": home.get("id"),
                    "away_id": away.get("id"),
                    "home_name": home_name,
                    "home_short_name": _best_text(home.get("name")),
                    "away_name": away_name,
                    "away_short_name": _best_text(away.get("name")),
                    "utc_time": ((match.get("status") or {}).get("utcTime") or ""),
                    "time": _best_text(match.get("time")),
                    "schedule_date": schedule_date or "",
                    "url": build_fallback_match_url(home_name, away_name, match_id),
                }
            )
    return rows


def _local_team_variants(local_match, side):
    full_context = local_match.get("full_context") or {}
    match_info = full_context.get("match_info") or {}
    variants = [
        local_match.get(f"{side}_team"),
        full_context.get(f"{side}_team"),
        match_info.get(f"{side}_team"),
    ]
    out = []
    seen = set()
    for value in variants:
        text = _best_text(value)
        key = normalize_name(text)
        if text and key not in seen:
            seen.add(key)
            out.append(text)
    return out


def _candidate_team_variants(candidate, side):
    return [
        candidate.get(f"{side}_name"),
        candidate.get(f"{side}_short_name"),
    ]


def _pair_name_score(local_names, fotmob_names, alias_map):
    best = 0.0
    for local in local_names or []:
        for remote in fotmob_names or []:
            if not local or not remote:
                continue
            if team_names_match(local, remote, alias_map or {}):
                best = max(best, 1.0)
                continue
            local_canon = canonicalize_team_name(local, alias_map or {})
            remote_canon = canonicalize_team_name(remote, alias_map or {})
            left = normalize_name(local_canon)
            right = normalize_name(remote_canon)
            if not left or not right:
                continue
            score = SequenceMatcher(None, left, right).ratio()
            if left in right or right in left:
                score = max(score, 0.88)
            best = max(best, score)
    return best


def find_best_fotmob_match(local_match, candidates, alias_map=None):
    home_variants = _local_team_variants(local_match, "home")
    away_variants = _local_team_variants(local_match, "away")
    scored = []
    for candidate in candidates or []:
        home_score = _pair_name_score(home_variants, _candidate_team_variants(candidate, "home"), alias_map or {})
        away_score = _pair_name_score(away_variants, _candidate_team_variants(candidate, "away"), alias_map or {})
        average = round((home_score + away_score) / 2.0, 4)
        scored.append((average, home_score, away_score, candidate))

    if not scored:
        return None
    average, home_score, away_score, candidate = max(scored, key=lambda item: item[0])
    if home_score < 0.72 or away_score < 0.72 or average < 0.78:
        return None

    confidence = "high" if average >= 0.92 else "medium"
    result = dict(candidate)
    result.update(
        {
            "match_confidence": confidence,
            "score": average,
            "home_score": round(home_score, 4),
            "away_score": round(away_score, 4),
        }
    )
    return result


def _importance_rank(label):
    return {
        "核心": 0,
        "主力/重要轮换": 1,
        "轮换/替补": 2,
        "重要性待核验": 3,
    }.get(label or "", 9)


def build_player_importance(stats):
    stats = stats or {}
    matches = _to_number(stats.get("matches")) or 0
    started = _to_number(stats.get("started")) or 0
    minutes = _to_number(stats.get("minutes")) or 0
    goals = _to_number(stats.get("goals")) or 0
    assists = _to_number(stats.get("assists")) or 0
    rating = _to_number(stats.get("rating")) or 0

    if started >= 18 or minutes >= 1500 or matches >= 24 or (rating >= 7 and matches >= 15):
        return "核心"
    if started >= 8 or minutes >= 700 or matches >= 12 or goals + assists >= 5:
        return "主力/重要轮换"
    if matches > 0 or started > 0 or minutes > 0:
        return "轮换/替补"
    return "重要性待核验"


def _normalize_absence(row, player_stats):
    row = row or {}
    player_id = row.get("id")
    stats = dict((player_stats or {}).get(player_id) or (player_stats or {}).get(str(player_id)) or {})
    performance = row.get("performance") or {}
    unavailable = row.get("unavailability") or {}
    reason = _best_text(stats.get("reason") or unavailable.get("reason") or unavailable.get("type") or "injury")
    expected_return = _best_text(
        stats.get("expected_return")
        or unavailable.get("expectedReturn")
        or unavailable.get("expected_return")
    )

    goals = _to_number(stats.get("goals"))
    if goals is None:
        goals = _to_number(performance.get("seasonGoals")) or 0
    assists = _to_number(stats.get("assists"))
    if assists is None:
        assists = _to_number(performance.get("seasonAssists")) or 0
    rating = _to_number(stats.get("rating"))
    if rating is None:
        rating = _to_number(performance.get("seasonRating"))

    normalized = {
        "source": "fotmob",
        "id": player_id,
        "name": _best_text(row.get("name")),
        "role": _best_text(stats.get("role")) or _position_label(row),
        "position_group": _best_text(stats.get("position_group")),
        "reason": reason,
        "status": expected_return,
        "status_label": "缺阵" if unavailable.get("type") == "injury" else _best_text(unavailable.get("type")),
        "expected_return": expected_return,
        "goals": goals,
        "assists": assists,
        "started": _to_number(stats.get("started")) or 0,
        "matches": _to_number(stats.get("matches")) or 0,
        "minutes": _to_number(stats.get("minutes")) or 0,
        "rating": rating,
        "market_value": row.get("marketValue"),
        "country": _best_text(row.get("countryName")),
    }
    normalized["games_played"] = normalized["matches"]
    normalized["importance_label"] = build_player_importance(normalized)
    return normalized


def _position_label(row):
    position_id = row.get("positionId") or row.get("usualPlayingPositionId")
    mapping = {
        11: "GK",
        0: "GK",
        20: "D",
        30: "M",
        40: "F",
    }
    return mapping.get(position_id, "")


def normalize_fotmob_absences(detail_json, player_stats=None):
    lineup = (((detail_json or {}).get("content") or {}).get("lineup") or {})
    home_team = lineup.get("homeTeam") or {}
    away_team = lineup.get("awayTeam") or {}
    home_absences = [_normalize_absence(row, player_stats or {}) for row in home_team.get("unavailable") or []]
    away_absences = [_normalize_absence(row, player_stats or {}) for row in away_team.get("unavailable") or []]
    home_absences.sort(key=lambda item: (_importance_rank(item.get("importance_label")), item.get("name") or ""))
    away_absences.sort(key=lambda item: (_importance_rank(item.get("importance_label")), item.get("name") or ""))
    return {
        "source": "fotmob",
        "lineup_confirmed": bool((home_team.get("starters") or []) or (away_team.get("starters") or [])),
        "home_team": _best_text(home_team.get("name")),
        "away_team": _best_text(away_team.get("name")),
        "home_starting": [x.get("name") for x in home_team.get("starters") or [] if x.get("name")],
        "away_starting": [x.get("name") for x in away_team.get("starters") or [] if x.get("name")],
        "home_absences": home_absences,
        "away_absences": away_absences,
        "injury_status": {
            "home": "fotmob_hit" if home_absences else "fotmob_no_absence",
            "away": "fotmob_hit" if away_absences else "fotmob_no_absence",
        },
    }


def _format_absence_item(row):
    parts = [row.get("importance_label") or "重要性待核验"]
    matches = _compact_number(row.get("matches"))
    started = _compact_number(row.get("started"))
    if matches or started:
        parts.append(f"{matches or 0}场{started or 0}首发")
    goals = _compact_number(row.get("goals"))
    assists = _compact_number(row.get("assists"))
    if goals or assists:
        parts.append(f"{goals or 0}球{assists or 0}助")
    rating = _compact_rating(row.get("rating"))
    if rating:
        parts.append(f"评分{rating}")
    reason = _best_text(row.get("reason"))
    if reason and reason.lower() not in {"injury", "unknown"}:
        parts.append(reason)
    expected = _best_text(row.get("expected_return") or row.get("status"))
    if expected and expected.lower() not in {"unknown", "-", "none"}:
        parts.append(expected)
    return f"{row.get('name')}(" + "，".join(parts) + ")"


def build_fotmob_injury_summary(injury_payload, limit_per_side=4):
    injury_payload = injury_payload or {}
    home_absences = [x for x in injury_payload.get("home_absences") or [] if isinstance(x, dict)]
    away_absences = [x for x in injury_payload.get("away_absences") or [] if isinstance(x, dict)]
    if not home_absences and not away_absences:
        return "FotMob伤停：双方暂无明确伤停"

    def side_text(label, rows):
        if not rows:
            return f"{label}暂无明确伤停"
        rows = sorted(rows, key=lambda item: (_importance_rank(item.get("importance_label")), item.get("name") or ""))
        detail = "、".join(_format_absence_item(row) for row in rows[:limit_per_side])
        extra = len(rows) - limit_per_side
        if extra > 0:
            detail += f"等{len(rows)}人"
        return f"{label}伤停{len(rows)}人：{detail}"

    return "FotMob伤停：" + "；".join(
        [
            side_text("主队", home_absences),
            side_text("客队", away_absences),
        ]
    )


def extract_player_stats_from_html(html):
    soup = BeautifulSoup(html or "", "html.parser")
    script = soup.find("script", id="__NEXT_DATA__")
    if not script or not script.string:
        return {}
    data = json.loads(script.string)
    player_data = (((data.get("props") or {}).get("pageProps") or {}).get("data") or {})
    stats = {item.get("title"): item.get("value") for item in (player_data.get("mainLeague") or {}).get("stats") or []}
    injury_info = player_data.get("injuryInformation") or {}
    expected_return = injury_info.get("expectedReturn") or {}
    position_desc = player_data.get("positionDescription") or {}
    primary_position = (position_desc.get("primaryPosition") or {}).get("label")
    role, position_group = _role_from_position_text(primary_position)
    return {
        "reason": _best_text(injury_info.get("name")),
        "expected_return": _best_text(expected_return.get("expectedReturnFallback")),
        "goals": _to_number(stats.get("Goals")) or 0,
        "assists": _to_number(stats.get("Assists")) or 0,
        "started": _to_number(stats.get("Started")) or 0,
        "matches": _to_number(stats.get("Matches")) or 0,
        "minutes": _to_number(stats.get("Minutes played")) or 0,
        "rating": _to_number(stats.get("Rating")),
        "yellow_cards": _to_number(stats.get("Yellow cards")) or 0,
        "red_cards": _to_number(stats.get("Red cards")) or 0,
        "league": _best_text((player_data.get("mainLeague") or {}).get("leagueName")),
        "season": _best_text((player_data.get("mainLeague") or {}).get("season")),
        "role": role,
        "position_group": position_group,
        "primary_position": _best_text(primary_position),
    }


def extract_match_detail_from_html(html):
    soup = BeautifulSoup(html or "", "html.parser")
    script = soup.find("script", id="__NEXT_DATA__")
    if not script or not script.string:
        return {}
    data = json.loads(script.string)
    page_props = ((data.get("props") or {}).get("pageProps") or {})
    if not page_props.get("general") or not page_props.get("content"):
        return {}
    return {
        "general": page_props.get("general") or {},
        "header": page_props.get("header") or {},
        "nav": page_props.get("nav") or [],
        "ongoing": page_props.get("ongoing"),
        "hasPendingVAR": page_props.get("hasPendingVAR"),
        "content": page_props.get("content") or {},
        "seo": page_props.get("seo") or {},
    }


def build_browser_context(playwright):
    browser = playwright.chromium.launch(
        headless=True,
        args=["--disable-blink-features=AutomationControlled"],
    )
    context = browser.new_context(
        user_agent=HEADERS["User-Agent"],
        viewport={"width": 1440, "height": 2200},
        locale="en-US",
        timezone_id=TIMEZONE,
    )
    context.add_init_script(
        """
Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']});
Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
        """
    )
    return browser, context


def fetch_json(url, cache_key=None, attempts=2):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = CACHE_DIR / f"{cache_key}.json" if cache_key else None
    last_error = None
    for attempt in range(1, attempts + 1):
        try:
            response = requests.get(url, headers=HEADERS, timeout=30)
            if response.status_code == 200 and "application/json" in response.headers.get("content-type", ""):
                payload = response.json()
                if cache_path:
                    save_json(cache_path, payload)
                return payload
            last_error = RuntimeError(f"HTTP {response.status_code}: {response.text[:120]}")
        except Exception as exc:
            last_error = exc
        time.sleep(1.5 * attempt)
    if cache_path and cache_path.exists():
        print(f"   ↳ FotMob 使用缓存: {cache_path}")
        return load_json(cache_path, {})
    raise RuntimeError(f"FotMob JSON 抓取失败: {url} | {last_error}")


def fetch_schedule(date_text):
    return fetch_json(build_matches_api_url(date_text), cache_key=f"schedule_{date_text}", attempts=2)


def scrape_match_hrefs(page, date_text, expected_ids=None):
    expected_ids = {int(x) for x in (expected_ids or []) if x}
    url = f"{FOTMOB_BASE_URL}/?date={date_text}"
    hrefs = {}
    max_scroll_rounds = 72
    for attempt in range(2):
        page.goto(url, wait_until="domcontentloaded", timeout=45000)
        page.wait_for_timeout(2500 + attempt * 1500)
        for _ in range(max_scroll_rounds):
            anchors = page.eval_on_selector_all(
                "a[href*='#']",
                """els => els.map(a => a.href).filter(Boolean)""",
            )
            for href in anchors or []:
                match = re.search(r"#(\d+)", href)
                if match and "/matches/" in href:
                    hrefs[int(match.group(1))] = href
            if expected_ids and expected_ids.issubset(set(hrefs.keys())):
                return hrefs
            page.evaluate("window.scrollBy(0, Math.max(1200, window.innerHeight))")
            page.wait_for_timeout(650)
        if hrefs and not expected_ids:
            break
    return hrefs


def fetch_match_detail_with_browser(page, match_url, match_id):
    cache_path = CACHE_DIR / f"match_{match_id}.json"
    if cache_path.exists():
        return load_json(cache_path, {})

    target_fragment = f"/api/data/matchDetails?matchId={match_id}"
    detail = {}

    def on_response(response):
        if target_fragment in response.url and response.status == 200:
            try:
                detail.update(response.json())
            except Exception:
                pass

    page.on("response", on_response)
    last_error = None
    try:
        for attempt in range(2):
            detail.clear()
            try:
                page.goto(match_url, wait_until="domcontentloaded", timeout=45000)
                for _ in range(18):
                    page.wait_for_timeout(1000)
                    if detail:
                        break
                if not detail:
                    detail = extract_match_detail_from_html(page.content())
                if detail:
                    break
            except Exception as exc:
                last_error = exc
                page.wait_for_timeout(2500 + 1500 * attempt)
    finally:
        page.remove_listener("response", on_response)
    if not detail:
        raise RuntimeError(f"未抓到 FotMob 比赛详情: {match_url} | {last_error}")
    save_json(cache_path, detail)
    return detail


def _player_cache_path(player_id):
    return CACHE_DIR / f"player_{player_id}.json"


def fetch_player_stats_with_browser(page, player):
    player = player or {}
    player_id = player.get("id")
    if not player_id:
        return {}
    cache_path = _player_cache_path(player_id)
    if cache_path.exists():
        cached = load_json(cache_path, {})
        if isinstance(cached, dict) and cached.get("role"):
            return cached

    url = f"{FOTMOB_BASE_URL}/players/{player_id}/{safe_slug(player.get('name'))}"
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=45000)
        page.wait_for_timeout(3500)
        stats = extract_player_stats_from_html(page.content())
        if stats:
            save_json(cache_path, stats)
        return stats
    except PlaywrightTimeoutError:
        return {}
    except Exception:
        return {}


def collect_unavailable_players(detail_json):
    lineup = (((detail_json or {}).get("content") or {}).get("lineup") or {})
    players = []
    for side in ("homeTeam", "awayTeam"):
        for player in (lineup.get(side) or {}).get("unavailable") or []:
            if player.get("id"):
                players.append(player)
    return players


def load_full_context_map(path=FULL_CONTEXT_FILE):
    payload = load_json(path, {})
    return payload if isinstance(payload, dict) else {}


def enrich_local_matches(base_matches, full_context_map):
    out = []
    for row in base_matches or []:
        item = dict(row)
        item["full_context"] = (full_context_map or {}).get(str(row.get("match_id"))) or {}
        out.append(item)
    return out


def build_match_context_entry(local_match, fotmob_match, detail_json, player_stats):
    injury_payload = normalize_fotmob_absences(detail_json, player_stats)
    injury_payload["summary"] = build_fotmob_injury_summary(injury_payload)
    general = detail_json.get("general") or {}
    return {
        "source": "fotmob",
        "match": {
            "local_match_id": str(local_match.get("match_id")),
            "local_home": local_match.get("home_team"),
            "local_away": local_match.get("away_team"),
            "fotmob_home": fotmob_match.get("home_name") or general.get("homeTeam", {}).get("name"),
            "fotmob_away": fotmob_match.get("away_name") or general.get("awayTeam", {}).get("name"),
            "fotmob_match_id": fotmob_match.get("match_id"),
            "fotmob_league": fotmob_match.get("league_name") or general.get("leagueName"),
            "url": fotmob_match.get("url"),
            "match_confidence": fotmob_match.get("match_confidence"),
            "match_score": fotmob_match.get("score"),
        },
        "injury": injury_payload,
    }


def load_existing_fotmob_context(path=OUTPUT_FILE, force_all=False):
    if force_all:
        return {}
    payload = load_json(path, {})
    return payload if isinstance(payload, dict) else {}


def current_match_ids(local_matches):
    return {str(row.get("match_id") or "") for row in local_matches or [] if row.get("match_id") not in (None, "")}


def reusable_fotmob_entries(existing_payload, local_matches):
    ids = current_match_ids(local_matches)
    return {
        str(match_id): entry
        for match_id, entry in (existing_payload or {}).items()
        if str(match_id) in ids and str(match_id) != "_meta" and isinstance(entry, dict)
    }


def fetch_fotmob_context(date_text=None, limit=None, existing_payload=None, force_all=False):
    date_texts = build_fotmob_dates(date_text)
    alias_map = load_team_alias_map()
    full_context_map = load_full_context_map()
    local_matches = enrich_local_matches(load_base_matches(), full_context_map)
    if limit:
        local_matches = local_matches[: int(limit)]
    reused_entries = reusable_fotmob_entries(existing_payload or {}, local_matches) if not force_all else {}
    pending_matches = [row for row in local_matches if str(row.get("match_id") or "") not in reused_entries]

    candidates = []
    for current_date in date_texts:
        schedule = fetch_schedule(current_date)
        candidates.extend(flatten_fotmob_matches(schedule, schedule_date=current_date))
    output = {
        "_meta": {
            "source": "fotmob",
            "date": ",".join(date_texts),
            "dates": list(date_texts),
            "generated_at": datetime.now().isoformat(timespec="seconds"),
            "matched": len(reused_entries),
            "reused": len(reused_entries),
            "unmatched": [],
            "errors": [],
        }
    }
    output.update(reused_entries)

    if reused_entries:
        print(f"♻️ 复用已有 FotMob 情报: {len(reused_entries)} 场")
    if not pending_matches:
        return output
    print(f"🔎 本次仅补抓缺失 FotMob 比赛: {len(pending_matches)} 场")

    with sync_playwright() as playwright:
        browser, context = build_browser_context(playwright)
        preliminary_matches = {}
        expected_ids_by_date = {}
        for local_match in pending_matches:
            best = find_best_fotmob_match(local_match, candidates, alias_map)
            if best:
                preliminary_matches[str(local_match.get("match_id"))] = best
                schedule_date = str(best.get("schedule_date") or "").strip()
                if schedule_date:
                    expected_ids_by_date.setdefault(schedule_date, []).append(best.get("match_id"))

        hrefs_by_date = {}
        for current_date in date_texts:
            ids = expected_ids_by_date.get(current_date) or []
            href_page = context.new_page()
            try:
                hrefs_by_date[current_date] = scrape_match_hrefs(href_page, current_date, expected_ids=ids)
            finally:
                href_page.close()
        for candidate in candidates:
            schedule_date = str(candidate.get("schedule_date") or "").strip()
            hrefs = hrefs_by_date.get(schedule_date) or {}
            if candidate.get("match_id") in hrefs:
                candidate["url"] = hrefs[candidate["match_id"]]

        for local_match in pending_matches:
            best = preliminary_matches.get(str(local_match.get("match_id")))
            best_hrefs = hrefs_by_date.get(str((best or {}).get("schedule_date") or "").strip()) or {}
            if best and best.get("match_id") in best_hrefs:
                best = dict(best)
                best["url"] = best_hrefs[best["match_id"]]
            if not best:
                output["_meta"]["unmatched"].append(
                    {
                        "match_id": str(local_match.get("match_id")),
                        "home_team": local_match.get("home_team"),
                        "away_team": local_match.get("away_team"),
                        "reason": "未在 FotMob 日期赛程中匹配到双方",
                    }
                )
                continue

            match_id = best.get("match_id")
            work_page = None
            try:
                if "/match#" in str(best.get("url") or ""):
                    raise RuntimeError("未从 FotMob 赛程页拿到真实比赛链接")
                print(f"🔎 FotMob: {local_match.get('home_team')} vs {local_match.get('away_team')} -> {best.get('home_name')} vs {best.get('away_name')}")
                work_page = context.new_page()
                detail = fetch_match_detail_with_browser(work_page, best.get("url"), match_id)
                player_stats = {}
                for player in collect_unavailable_players(detail):
                    stats = fetch_player_stats_with_browser(work_page, player)
                    if stats:
                        player_stats[player.get("id")] = stats
                output[str(local_match.get("match_id"))] = build_match_context_entry(local_match, best, detail, player_stats)
                output["_meta"]["matched"] += 1
                if work_page:
                    work_page.close()
            except Exception as exc:
                try:
                    if work_page:
                        work_page.close()
                except Exception:
                    pass
                output["_meta"]["errors"].append(
                    {
                        "match_id": str(local_match.get("match_id")),
                        "fotmob_match_id": match_id,
                        "error": str(exc),
                    }
                )
                print(f"   ⚠️ FotMob 抓取失败: {local_match.get('home_team')} vs {local_match.get('away_team')} | {exc}")
        browser.close()

    return output


def main():
    parser = argparse.ArgumentParser(description="抓取 FotMob 伤停与球员赛季数据，生成 fotmob_context.json")
    parser.add_argument("--date", default=None, help="FotMob 日期，格式 YYYYMMDD 或 YYYY-MM-DD；默认明天")
    parser.add_argument("--limit", type=int, default=None, help="只抓前 N 场，调试用")
    parser.add_argument("--output", default=str(OUTPUT_FILE), help="输出 JSON 路径")
    parser.add_argument("--force-all", action="store_true", help="忽略已有 fotmob_context.json，重新全量抓取。")
    args = parser.parse_args()

    existing_payload = load_existing_fotmob_context(args.output, force_all=args.force_all)
    payload = fetch_fotmob_context(
        date_text=args.date,
        limit=args.limit,
        existing_payload=existing_payload,
        force_all=args.force_all,
    )
    save_json(args.output, payload)
    print(f"✅ FotMob 数据已保存: {args.output}")
    print(
        f"   匹配 {payload['_meta']['matched']} 场，复用 {payload['_meta'].get('reused', 0)} 场，"
        f"未匹配 {len(payload['_meta']['unmatched'])} 场，错误 {len(payload['_meta']['errors'])} 场"
    )
    if payload["_meta"]["unmatched"]:
        print("⚠️ FotMob 未匹配比赛:")
        for item in payload["_meta"]["unmatched"]:
            print(
                " - "
                f"{item.get('match_id', '')} | {item.get('home_team', '')} vs {item.get('away_team', '')}"
                f" | {item.get('reason', '')}"
            )
    if payload["_meta"]["errors"]:
        print("⚠️ FotMob 抓取错误:")
        for item in payload["_meta"]["errors"]:
            print(
                " - "
                f"{item.get('match_id', '')} | FotMob:{item.get('fotmob_match_id', '')}"
                f" | {item.get('error', '')}"
            )


if __name__ == "__main__":
    main()
