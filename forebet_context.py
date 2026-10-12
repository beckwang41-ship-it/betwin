import json
import re
from datetime import datetime
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from match_context_pipeline import canonicalize_team_name, team_names_match


FOREBET_BASE_URL = "https://www.forebet.com"
FOREBET_LEAGUE_URL_MAP = {
    "欧冠": "https://www.forebet.com/en/predictions-europe/uefa-champions-league",
    "世界杯": "https://www.forebet.com/en/predictions-world/world-cup",
    "UEFA Champions League": "https://www.forebet.com/en/predictions-europe/uefa-champions-league",
    "欧罗巴": "https://www.forebet.com/en/predictions-europe/uefa-europa-league",
    "UEFA Europa League": "https://www.forebet.com/en/predictions-europe/uefa-europa-league",
    "欧协联": "https://www.forebet.com/en/predictions-europe/uefa-europa-conference-league",
    "UEFA Europa Conference League": "https://www.forebet.com/en/predictions-europe/uefa-europa-conference-league",
    "解放者杯": "https://www.forebet.com/en/south-america/copa-libertadores",
    "CONMEBOL Libertadores": "https://www.forebet.com/en/south-america/copa-libertadores",
    "英超": "https://www.forebet.com/en/football-tips-and-predictions-for-england/premier-league",
    "英冠": "https://www.forebet.com/en/football-tips-and-predictions-for-england/championship",
    "西甲": "https://www.forebet.com/en/football-tips-and-predictions-for-spain/primera-division",
    "德甲": "https://www.forebet.com/en/football-tips-and-predictions-for-germany/bundesliga",
    "德乙": "https://www.forebet.com/en/football-tips-and-predictions-for-germany/2-bundesliga",
    "意甲": "https://www.forebet.com/en/football-tips-and-predictions-for-italy/serie-a",
    "法甲": "https://www.forebet.com/en/football-tips-and-predictions-for-france/ligue1",
    "法乙": "https://www.forebet.com/en/football-tips-and-predictions-for-france/ligue2",
    "荷甲": "https://www.forebet.com/en/football-tips-and-predictions-for-netherlands/eredivisie",
    "荷乙": "https://www.forebet.com/en/football-tips-and-predictions-for-netherlands/erstedivision",
    "葡超": "https://www.forebet.com/en/football-tips-and-predictions-for-portugal/liga-portugal",
    "澳超": "https://www.forebet.com/en/tips-and-predictions-for-australia/a-league",
    "美职": "https://www.forebet.com/en/football-tips-and-predictions-for-usa/mls",
    "美职联": "https://www.forebet.com/en/football-tips-and-predictions-for-usa/mls",
    "瑞超": "https://www.forebet.com/en/football-tips-and-predictions-for-sweden/allsvenskan",
    "芬超": "https://www.forebet.com/en/football-tips-and-predictions-for-finland/veikkausliiga",
    "挪超": "https://www.forebet.com/en/football-tips-and-predictions-for-norway/eliteserien",
    "沙职": "https://www.forebet.com/en/football-tips-and-predictions-for-saudi-arabia/professional-league",
    "日职联": "https://www.forebet.com/en/football-tips-and-predictions-for-japan/j1-league",
    "日职": "https://www.forebet.com/en/football-tips-and-predictions-for-japan/j1-league",
    "韩职": "https://www.forebet.com/en/football-tips-and-predictions-for-south-korea/k-league-1",
    "韩职联": "https://www.forebet.com/en/football-tips-and-predictions-for-south-korea/k-league-1",
    "西国王杯": "https://www.forebet.com/en/football-tips-and-predictions-for-spain/copa-del-rey",
    "国王杯": "https://www.forebet.com/en/football-tips-and-predictions-for-spain/copa-del-rey",
    "英足总杯": "https://www.forebet.com/en/football-tips-and-predictions-for-england/fa-cup",
    "沙特联": "https://www.forebet.com/en/football-tips-and-predictions-for-saudi-arabia/professional-league",
}


def _soup(html):
    return BeautifulSoup(html or "", "html.parser")


def _clean_text(text):
    return re.sub(r"\s+", " ", str(text or "")).strip()


def _safe_int(value, default=0):
    text = _clean_text(value)
    if not text:
        return default
    match = re.search(r"-?\d+", text)
    return int(match.group(0)) if match else default


def _match_id_from_url(url):
    match = re.search(r"-(\d+)(?:$|[?#])", str(url or ""))
    return match.group(1) if match else ""


def extract_fixture_candidates(html):
    soup = _soup(html)
    candidates = []
    for row in soup.select("div.rcnt"):
        team_spans = row.select(".tnms .homeTeam, .tnms .awayTeam")
        if len(team_spans) >= 2:
            home_team = _clean_text(team_spans[0].get_text(" ", strip=True))
            away_team = _clean_text(team_spans[1].get_text(" ", strip=True))
        else:
            teams = [_clean_text(x.get_text(" ", strip=True)) for x in row.select(".tnms span") if _clean_text(x.get_text(" ", strip=True))]
            if len(teams) < 2:
                continue
            home_team, away_team = teams[0], teams[1]

        anchor = row.find("a", href=re.compile(r"/en/football/matches/"))
        href = anchor.get("href", "") if anchor else ""
        kickoff = row.select_one("time[itemprop='startDate']")
        kickoff_iso = kickoff.get("datetime", "") if kickoff else ""
        kickoff_text = _clean_text((row.select_one(".date_bah") or {}).get_text(" ", strip=True) if row.select_one(".date_bah") else "")
        url = urljoin(FOREBET_BASE_URL, href) if href else ""
        candidates.append(
            {
                "home_team": home_team,
                "away_team": away_team,
                "kickoff_iso": kickoff_iso,
                "kickoff_text": kickoff_text,
                "url": url,
                "match_id": _match_id_from_url(url),
            }
        )
    return candidates


def extract_league_fixture_candidates(html):
    soup = _soup(html)
    schema = None
    header = soup.select_one(".tb1x2-league")
    if header:
        schema = header.find_next("div", class_="schema")
    if not schema:
        schema = soup.select_one(".schema")
    return extract_fixture_candidates(str(schema or ""))


def parse_match_basics(html):
    soup = _soup(html)
    pred = soup.select_one(".predictioncontain")
    home = pred.select_one("[itemprop='homeTeam'] [itemprop='name']") if pred else None
    away = pred.select_one("[itemprop='awayTeam'] [itemprop='name']") if pred else None
    venue = pred.select_one(".weather_main_pr [itemprop='name address']") if pred else None
    date_node = pred.select_one("time[itemprop='startDate']") if pred else None
    league_node = pred.select_one(".leagpred_btn") if pred else None
    weather_node = pred.select_one(".weather_main_pr") if pred else None
    intro = soup.select(".match_intro_text p")

    temperature = ""
    if weather_node:
        weather_text = _clean_text(weather_node.get_text(" ", strip=True))
        temp_match = re.search(r"(-?\d+\s*°[FC])", weather_text, re.IGNORECASE)
        if temp_match:
            temperature = temp_match.group(1).replace(" ", "")

    return {
        "home_team": _clean_text(home.get_text(" ", strip=True) if home else ""),
        "away_team": _clean_text(away.get_text(" ", strip=True) if away else ""),
        "stadium": _clean_text(venue.get_text(" ", strip=True) if venue else ""),
        "temperature": temperature,
        "kickoff_iso": date_node.get("datetime", "") if date_node else "",
        "kickoff_text": _clean_text((pred.select_one(".date_bah") or {}).get_text(" ", strip=True) if pred and pred.select_one(".date_bah") else ""),
        "league_name": _clean_text(league_node.get_text(" ", strip=True) if league_node else ""),
        "league_url": urljoin(FOREBET_BASE_URL, league_node.get("href", "")) if league_node and league_node.get("href") else "",
        "intro_paragraphs": [_clean_text(p.get_text(" ", strip=True)) for p in intro if _clean_text(p.get_text(" ", strip=True))],
    }


def parse_match_centre_url(html):
    soup = _soup(html)
    node = soup.find("a", href=re.compile(r"/en/football-predictions/match-center/"))
    if not node:
        return ""
    return urljoin(FOREBET_BASE_URL, node.get("href", ""))


def parse_standings_table(html):
    soup = _soup(html)
    table = {}
    for row in soup.select("table.standings tr"):
        team_node = row.select_one(".standing-second-td a")
        rank_node = row.select_one(".std_zn") or row.select_one(".std_pos")
        if not team_node:
            continue
        cells = row.find_all("td")
        if len(cells) < 10:
            continue
        rank_val = _safe_int(rank_node.get_text(" ", strip=True) if rank_node else "")
        if rank_val <= 0:
            rank_val = _safe_int(cells[0].get_text(" ", strip=True) if cells else "")
        if rank_val <= 0:
            continue
        team_name = _clean_text(team_node.get_text(" ", strip=True))
        table[team_name] = {
            "rank": rank_val,
            "pts": _safe_int(cells[2].get_text(" ", strip=True)),
            "gp": _safe_int(cells[3].get_text(" ", strip=True)),
            "w": _safe_int(cells[4].get_text(" ", strip=True)),
            "d": _safe_int(cells[5].get_text(" ", strip=True)),
            "l": _safe_int(cells[6].get_text(" ", strip=True)),
            "gf": _safe_int(cells[7].get_text(" ", strip=True)),
            "ga": _safe_int(cells[8].get_text(" ", strip=True)),
            "gd": _safe_int(cells[9].get_text(" ", strip=True)),
        }
    return table


def parse_stat_rows(html):
    soup = _soup(html)
    rows = []
    for row in soup.select(".st_rmain .st_row"):
        home_node = row.select_one(".st_hteam a")
        away_node = row.select_one(".st_ateam a")
        score_node = row.select_one(".st_res")
        if not home_node or not away_node or not score_node:
            continue
        link = row.find("a", class_="stat_link", href=True)
        date_node = row.select_one(".st_date")
        rows.append(
            {
                "date_text": _clean_text(date_node.get_text(" ", strip=True) if date_node else ""),
                "home_team": _clean_text(home_node.get_text(" ", strip=True)),
                "away_team": _clean_text(away_node.get_text(" ", strip=True)),
                "score": _clean_text(score_node.get_text(" ", strip=True)),
                "half_time_score": _clean_text((row.select_one(".st_htscr") or {}).get_text(" ", strip=True) if row.select_one(".st_htscr") else ""),
                "league_tag": _clean_text((row.select_one(".st_ltag") or {}).get_text(" ", strip=True) if row.select_one(".st_ltag") else ""),
                "url": urljoin(FOREBET_BASE_URL, link.get("href", "")) if link else "",
                "match_id": _match_id_from_url(link.get("href", "") if link else ""),
            }
        )
    return rows


def parse_stat_sections(html):
    soup = _soup(html)
    sections = {
        "head_to_head": [],
        "home_last6": [],
        "away_last6": [],
        "home_matches": [],
        "away_matches": [],
    }
    last6_seen = 0
    for module in soup.select(".moduletable"):
        title_node = module.select_one(".mptlt")
        block = module.select_one(".st_scrblock")
        if not title_node or not block:
            continue
        title_parts = [_clean_text(x.get_text(" ", strip=True)) for x in title_node.find_all("div", recursive=False)]
        title = " ".join([x for x in title_parts if x]) or _clean_text(title_node.get_text(" ", strip=True))
        title_norm = _clean_text(title).lower()
        rows = parse_stat_rows(str(block))
        if not rows:
            continue
        if "head to head" in title_norm:
            sections["head_to_head"] = rows
        elif "last 6 matches" in title_norm:
            last6_seen += 1
            key = "home_last6" if last6_seen == 1 else "away_last6"
            sections[key] = rows
        elif "home matches" in title_norm:
            sections["home_matches"] = rows
        elif "away matches" in title_norm:
            sections["away_matches"] = rows
    return sections


def parse_match_specific_trends(html):
    soup = _soup(html)
    blocks = []

    for module in soup.select(".moduletable"):
        title_node = module.select_one(".mptlt.dskhide")
        title = _clean_text(title_node.get_text(" ", strip=True) if title_node else "")
        if not title or "trends" not in title.lower():
            continue

        team_name = re.sub(r"\s*trends\s*$", "", title, flags=re.IGNORECASE).strip()
        items = []
        for node in module.select(".short_trends .trend, .hid_trends .trend"):
            klass = " ".join(node.get("class") or [])
            tone = ""
            if "trend_p" in klass:
                tone = "positive"
            elif "trend_n" in klass:
                tone = "negative"
            elif "trend_c" in klass:
                tone = "caution"

            trend_type = _clean_text((node.select_one(".trend_type span") or {}).get_text(" ", strip=True))
            record = _clean_text((node.select_one(".trend_recent_m span") or {}).get_text(" ", strip=True))
            percentage = _safe_int((node.select_one(".trend_perc span") or {}).get_text(" ", strip=True), default=0)
            league_scope = _clean_text((node.select_one(".trend_league span") or {}).get_text(" ", strip=True))
            description = _clean_text((node.select_one("p") or {}).get_text(" ", strip=True))
            if not trend_type or not description:
                continue
            items.append(
                {
                    "trend_type": trend_type,
                    "record": record,
                    "percentage": percentage,
                    "league_scope": league_scope,
                    "description": description,
                    "tone": tone,
                }
            )

        if items:
            blocks.append({"team_name": team_name, "items": items})

    payload = {"blocks": blocks}
    if len(blocks) >= 1:
        payload["home_team"] = blocks[0]["team_name"]
        payload["home"] = blocks[0]["items"]
    if len(blocks) >= 2:
        payload["away_team"] = blocks[1]["team_name"]
        payload["away"] = blocks[1]["items"]
    return payload


def _extract_json_object(text, start_idx):
    if start_idx < 0 or start_idx >= len(text) or text[start_idx] != "{":
        return "", start_idx
    depth = 0
    in_string = False
    escaped = False
    for idx in range(start_idx, len(text)):
        ch = text[idx]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start_idx:idx + 1], idx + 1
    return "", start_idx


def parse_overall_stats_payload(html):
    text = str(html or "")
    fn_idx = text.find("function get_ovd(type)")
    if fn_idx < 0:
        return {}

    home_return = text.find("return ", fn_idx)
    home_start = text.find("{", home_return)
    home_json, home_end = _extract_json_object(text, home_start)
    if not home_json:
        return {}

    away_else = text.find("else", home_end)
    away_return = text.find("return ", away_else)
    away_start = text.find("{", away_return)
    away_json, _ = _extract_json_object(text, away_start)
    if not away_json:
        return {}

    try:
        home_payload = json.loads(home_json)
        away_payload = json.loads(away_json)
    except Exception:
        return {}

    soup = _soup(html)
    labels = {}
    label_nodes = soup.select(".navmenu-ss.__os .tabs-ul li span")
    for idx, node in enumerate(label_nodes):
        label = _clean_text(node.get_text(" ", strip=True))
        if not label:
            continue
        key = "all" if idx == 0 else str(idx)
        labels[key] = label

    return {
        "league_labels": labels,
        "home": home_payload,
        "away": away_payload,
    }


def find_best_fixture(local_match, candidates, alias_map):
    home_team = canonicalize_team_name(local_match.get("home_team"), alias_map)
    away_team = canonicalize_team_name(local_match.get("away_team"), alias_map)
    scored = []
    for row in candidates or []:
        if not team_names_match(home_team, row.get("home_team"), alias_map):
            continue
        if not team_names_match(away_team, row.get("away_team"), alias_map):
            continue
        score = 0
        if normalize_key(home_team) == normalize_key(row.get("home_team")):
            score += 2
        if normalize_key(away_team) == normalize_key(row.get("away_team")):
            score += 2
        scored.append((score, row))
    if not scored:
        return None
    scored.sort(key=lambda item: item[0], reverse=True)
    return scored[0][1]


def normalize_key(name):
    return re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "", _clean_text(name).lower())


def build_forebet_detail_payload(html):
    basics = parse_match_basics(html)
    standings = parse_standings_table(html)
    sections = parse_stat_sections(html)
    trends = parse_match_specific_trends(html)
    technical_stats = parse_overall_stats_payload(html)
    return {
        "match_info": basics,
        "standings_snapshot": standings,
        "history_context": sections,
        "match_specific_trends": trends,
        "technical_stats": technical_stats,
        "schedule_context": {
            "distance": parse_distance_context(html),
            "next_matches": parse_next_matches(html),
        },
    }


def parse_match_centre_lineups(html):
    soup = _soup(html)

    def names(selector):
        out = []
        seen = set()
        for node in soup.select(selector):
            name = _clean_text(node.get_text(" ", strip=True))
            if not name or name in seen:
                continue
            seen.add(name)
            out.append(name)
        return out

    return {
        "home_starting": names("#st_hostTeam .pl_name"),
        "away_starting": names("#st_guestTeam .pl_name"),
        "home_subs": names("#st_hostSubs .pl_name_sub"),
        "away_subs": names("#st_guestSubs .pl_name_sub"),
    }


def parse_injured_players_page(html):
    soup = _soup(html)
    result = {}

    current_team = ""
    current_rows = []

    def flush():
        nonlocal current_team, current_rows
        if current_team:
            result[current_team] = current_rows
        current_team = ""
        current_rows = []

    for row in soup.select("table.suspended tr"):
        team_node = row.select_one("h4")
        if team_node:
            flush()
            current_team = _clean_text(team_node.get_text(" ", strip=True))
            continue
        if not current_team:
            continue
        classes = row.get("class") or []
        if "susp_heading2" in classes:
            continue
        cells = row.find_all("td")
        if len(cells) < 4:
            continue
        player_cell = _clean_text(cells[0].get_text(" ", strip=True))
        if not player_cell:
            continue
        role_match = re.match(r"(.+?)\s*\(([A-Z])\)$", player_cell)
        name = _clean_text(role_match.group(1) if role_match else player_cell)
        role = role_match.group(2) if role_match else ""
        status = _clean_text(cells[3].get_text(" ", strip=True))
        status_parts = [x.strip() for x in status.split("-", 1)] if "-" in status else [status]
        status_label = status_parts[0] if status_parts else ""
        status_date = status_parts[1] if len(status_parts) > 1 else ""
        current_rows.append(
            {
                "name": name,
                "role": role,
                "games_played": _safe_int(cells[1].get_text(" ", strip=True), default=0),
                "reason": _clean_text(cells[2].get_text(" ", strip=True)),
                "status": status,
                "status_label": status_label,
                "status_date": status_date,
            }
        )

    flush()
    return result


def parse_detail_injuries(html):
    soup = _soup(html)
    title_node = None
    for node in soup.select(".mptlt"):
        if _clean_text(node.get_text(" ", strip=True)).lower() == "injured and suspended":
            title_node = node
            break
    if not title_node:
        return {}

    tabs_wrap = title_node.find_next("div", class_="tbl_head")
    if not tabs_wrap:
        return {}
    team_names = [
        _clean_text(btn.get_text(" ", strip=True))
        for btn in tabs_wrap.select(".tabs-ul li button")
        if _clean_text(btn.get_text(" ", strip=True))
    ]
    if not team_names:
        return {}

    result = {}
    team_blocks = []
    node = tabs_wrap.find_next_sibling()
    while node:
        classes = node.get("class") or []
        if "sdl_team" in classes:
            team_blocks.append(node)
            if len(team_blocks) >= len(team_names):
                break
        elif node.name == "td":
            break
        node = node.find_next_sibling()

    for idx, team_name in enumerate(team_names):
        block = team_blocks[idx] if idx < len(team_blocks) else None
        players = []
        if block:
            for row in block.select(".sdl_player"):
                player_name = _clean_text((row.select_one(".sdl_player-name") or {}).get_text(" ", strip=True))
                if not player_name or player_name.lower() == "player":
                    continue
                role_match = re.match(r"(.+?)\s*\(([A-Z])\)$", player_name)
                name = _clean_text(role_match.group(1) if role_match else player_name)
                role = role_match.group(2) if role_match else ""
                reason = _clean_text((row.select_one(".sdl_injury") or {}).get_text(" ", strip=True))
                until = _clean_text((row.select_one(".sdl_until") or {}).get_text(" ", strip=True))
                players.append(
                    {
                        "name": name,
                        "role": role,
                        "games_played": 0,
                        "reason": reason,
                        "status": until or "-",
                        "status_label": "",
                        "status_date": until if until and until != "-" else "",
                    }
                )
        result[team_name] = players
    return result


def parse_distance_context(html):
    soup = _soup(html)
    block = soup.select_one(".dist_cnt")
    if not block:
        return {}

    city_nodes = block.select(".dist_cities > div")
    home_city = _clean_text(city_nodes[0].select_one(".fw-bold").get_text(" ", strip=True)) if len(city_nodes) > 0 and city_nodes[0].select_one(".fw-bold") else ""
    home_country = _clean_text(city_nodes[0].find_all("span")[-1].get_text(" ", strip=True)) if len(city_nodes) > 0 and city_nodes[0].find_all("span") else ""
    away_city = _clean_text(city_nodes[1].select_one(".fw-bold").get_text(" ", strip=True)) if len(city_nodes) > 1 and city_nodes[1].select_one(".fw-bold") else ""
    away_country = _clean_text(city_nodes[1].find_all("span")[-1].get_text(" ", strip=True)) if len(city_nodes) > 1 and city_nodes[1].find_all("span") else ""

    dist_txt = _clean_text((block.select_one(".dist_km span") or {}).get_text(" ", strip=True) if block.select_one(".dist_km span") else "")
    dist_match = re.search(r"(\d+)\s*mi", dist_txt, re.IGNORECASE)
    locab = block.select(".dist_locab span")
    return {
        "home_city": home_city,
        "home_country": home_country,
        "away_city": away_city,
        "away_country": away_country,
        "distance_text": dist_txt,
        "distance_mi": int(dist_match.group(1)) if dist_match else 0,
        "stadium": _clean_text(locab[0].get_text(" ", strip=True)) if len(locab) > 0 else "",
        "stadium_city": _clean_text(locab[1].get_text(" ", strip=True)) if len(locab) > 1 else "",
    }


def parse_next_matches(html):
    soup = _soup(html)
    containers = soup.select(".diff_blocks_container")

    def parse_rows(container):
        rows = []
        for row in container.select(".diff_blocks_row"):
            team_node = row.select_one(".active-team a")
            if not team_node:
                continue
            team_text = _clean_text(team_node.get_text(" ", strip=True))
            team_match = re.match(r"(.+?)\s*\(([HA])\)$", team_text)
            opponent = _clean_text(team_match.group(1) if team_match else team_text)
            venue = team_match.group(2) if team_match else ""
            diff_node = row.select_one(".team_diff")
            rows.append(
                {
                    "opponent": opponent,
                    "venue": venue,
                    "league": _clean_text((row.select_one(".diff_league") or {}).get_text(" ", strip=True) if row.select_one(".diff_league") else ""),
                    "date": _clean_text((row.select_one(".diff_date") or {}).get_text(" ", strip=True) if row.select_one(".diff_date") else ""),
                    "difficulty": _safe_int(diff_node.get_text(" ", strip=True), default=0) if diff_node else 0,
                }
            )
        return rows

    return {
        "home": parse_rows(containers[0]) if len(containers) > 0 else [],
        "away": parse_rows(containers[1]) if len(containers) > 1 else [],
    }
