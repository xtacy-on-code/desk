"""Desk dashboard server. Python standard library only, so it runs as-is in Termux.

    python server.py            # serves on http://localhost:8080 (port from config.json)

The phone opens http://localhost:8080. Your laptop opens http://<phone-ip>:8080/edit
to manage exams and goals (needs the PIN printed at startup).
"""
import datetime as dt
import json
import os
import secrets
import subprocess
import threading
import time
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(ROOT, "static")
DATA = os.path.join(ROOT, "data")
os.makedirs(DATA, exist_ok=True)

LOCK = threading.Lock()
XP_LOCK = threading.Lock()
CACHE = {"leetcode": None, "codeforces": None, "contests": [], "weather": None, "vitals": None,
         "deadlines": [], "errors": {}}


# ---------- small helpers ----------

def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_json(path, value):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(value, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


def config():
    return load_json(os.path.join(ROOT, "config.json"), {})


def data_path(name):
    return os.path.join(DATA, name)


def http_json(url, body=None, headers=None, timeout=20):
    h = {"User-Agent": "desk-dashboard/1.0"}
    h.update(headers or {})
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def week_key(day=None):
    y, w, _ = (day or dt.date.today()).isocalendar()
    return f"{y}-W{w:02d}"


def week_start(day=None):
    day = day or dt.date.today()
    return day - dt.timedelta(days=day.weekday())


def get_pin():
    path = data_path("pin.txt")
    if not os.path.exists(path):
        with open(path, "w") as f:
            f.write(f"{secrets.randbelow(10**6):06d}")
    with open(path) as f:
        return f.read().strip()


# ---------- data sources (refreshed in a background thread) ----------

LC_QUERY = """query($u:String!){
 matchedUser(username:$u){ submitStats{ acSubmissionNum{ difficulty count } }
   userCalendar{ streak totalActiveDays submissionCalendar } profile{ ranking } }
 allQuestionsCount{ difficulty count }
 userContestRanking(username:$u){ rating attendedContestsCount topPercentage }
 recentAcSubmissionList(username:$u, limit:20){ title titleSlug timestamp }
 activeDailyCodingChallengeQuestion{ date link question{ title titleSlug difficulty } }
 topTwoContests{ title titleSlug startTime duration }
}"""


def fetch_leetcode(username):
    d = http_json("https://leetcode.com/graphql",
                  {"query": LC_QUERY, "variables": {"u": username}},
                  {"Referer": "https://leetcode.com"})["data"]
    mu = d.get("matchedUser")
    if not mu:
        raise ValueError(f"LeetCode user '{username}' not found")
    solved = {x["difficulty"]: x["count"] for x in mu["submitStats"]["acSubmissionNum"]}
    totals = {x["difficulty"]: x["count"] for x in d["allQuestionsCount"]}
    # submissionCalendar keys are UTC-midnight timestamps -> submissions that day
    raw = json.loads(mu["userCalendar"]["submissionCalendar"] or "{}")
    by_day = {}
    for ts, n in raw.items():
        day = dt.datetime.fromtimestamp(int(ts), dt.timezone.utc).date().isoformat()
        by_day[day] = by_day.get(day, 0) + n
    daily = d["activeDailyCodingChallengeQuestion"]
    recent = d.get("recentAcSubmissionList") or []
    # The daily problem resets at 00:00 UTC, so "done" means accepted since then.
    today_utc = dt.datetime.now(dt.timezone.utc).date()
    daily_done = any(
        s["titleSlug"] == daily["question"]["titleSlug"]
        and dt.datetime.fromtimestamp(int(s["timestamp"]), dt.timezone.utc).date() >= today_utc
        for s in recent)
    contest = d.get("userContestRanking")
    lc_contests = [{"site": "LeetCode", "name": c["title"], "start": c["startTime"],
                    "duration": c["duration"],
                    "url": f"https://leetcode.com/contest/{c['titleSlug']}"}
                   for c in d.get("topTwoContests") or []]
    return {
        "username": username,
        "solved": solved, "totals": totals,
        "streak": mu["userCalendar"]["streak"],
        "activeDays": mu["userCalendar"]["totalActiveDays"],
        "ranking": mu["profile"]["ranking"],
        "contestRating": round(contest["rating"]) if contest else None,
        "calendar": by_day,
        "recent": [{"title": s["title"], "slug": s["titleSlug"], "ts": int(s["timestamp"])}
                   for s in recent],
        "daily": {"title": daily["question"]["title"], "difficulty": daily["question"]["difficulty"],
                  "slug": daily["question"]["titleSlug"],
                  "url": "https://leetcode.com" + daily["link"], "done": daily_done},
    }, lc_contests


def fetch_codeforces_user(handle):
    info = http_json(f"https://codeforces.com/api/user.info?handles={urllib.parse.quote(handle)}")["result"][0]
    hist = http_json(f"https://codeforces.com/api/user.rating?handle={urllib.parse.quote(handle)}")["result"]
    return {"handle": info["handle"], "rating": info.get("rating"), "maxRating": info.get("maxRating"),
            "rank": info.get("rank", "unrated"),
            "contests": [{"name": c["contestName"], "ts": c["ratingUpdateTimeSeconds"],
                          "old": c["oldRating"], "new": c["newRating"]} for c in hist[-30:]]}


def fetch_codeforces():
    res = http_json("https://codeforces.com/api/contest.list?gym=false")["result"]
    out = []
    for c in res:
        if c["phase"] != "BEFORE":
            continue
        name = c["name"]
        if "Div. 1" in name and "Div. 2" not in name:
            continue  # Div. 1-only rounds aren't useful yet
        out.append({"site": "Codeforces", "name": name, "start": c["startTimeSeconds"],
                    "duration": c["durationSeconds"],
                    "url": f"https://codeforces.com/contests/{c['id']}"})
    return out


WMO = {0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Fog",
       51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 61: "Light rain", 63: "Rain",
       65: "Heavy rain", 71: "Light snow", 73: "Snow", 75: "Heavy snow", 80: "Showers",
       81: "Showers", 82: "Heavy showers", 95: "Thunderstorm", 96: "Thunderstorm", 99: "Thunderstorm"}


def fetch_weather(city):
    geo_path = data_path("geo.json")
    geo = load_json(geo_path, {})
    if geo.get("query") != city:
        q = urllib.parse.quote(city)
        r = http_json(f"https://geocoding-api.open-meteo.com/v1/search?name={q}&count=1")
        if not r.get("results"):
            raise ValueError(f"Couldn't find the city '{city}'")
        top = r["results"][0]
        geo = {"query": city, "name": top["name"], "lat": top["latitude"], "lon": top["longitude"]}
        save_json(geo_path, geo)
    w = http_json(
        "https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}"
        "&current=temperature_2m,apparent_temperature,weather_code"
        "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max"
        "&timezone=auto&forecast_days=1".format(**geo))
    cur, day = w["current"], w["daily"]
    return {"place": geo["name"], "temp": round(cur["temperature_2m"]),
            "feels": round(cur["apparent_temperature"]),
            "text": WMO.get(cur["weather_code"], "—"),
            "hi": round(day["temperature_2m_max"][0]), "lo": round(day["temperature_2m_min"][0]),
            "rain": day["precipitation_probability_max"][0]}


def _ics_time(prop, value):
    """Turn an iCal DTSTART/DUE value into (epoch seconds, all_day)."""
    value = value.strip()
    if "T" not in value:
        d = dt.datetime.strptime(value[:8], "%Y%m%d").replace(hour=23, minute=59)
        return time.mktime(d.timetuple()), True  # all-day deadline = end of that day
    if value.endswith("Z"):
        d = dt.datetime.strptime(value, "%Y%m%dT%H%M%SZ").replace(tzinfo=dt.timezone.utc)
        return d.timestamp(), False
    # TZID=... or floating time: treat as the phone's local time (IST)
    d = dt.datetime.strptime(value[:15], "%Y%m%dT%H%M%S")
    return time.mktime(d.timetuple()), False


def parse_ics(text, source):
    lines = []
    for raw in text.replace("\r\n", "\n").split("\n"):
        if raw[:1] in (" ", "\t") and lines:
            lines[-1] += raw[1:]  # folded line
        else:
            lines.append(raw)
    items, cur = [], None
    for line in lines:
        if line in ("BEGIN:VEVENT", "BEGIN:VTODO"):
            cur = {}
        elif line in ("END:VEVENT", "END:VTODO") and cur is not None:
            if cur.get("title") and cur.get("ts"):
                items.append(cur)
            cur = None
        elif cur is not None and ":" in line:
            prop, value = line.split(":", 1)
            name = prop.split(";", 1)[0]
            if name == "SUMMARY":
                cur["title"] = value.replace("\\,", ",").replace("\\;", ";").replace("\\n", " ").strip()
            elif name in ("DUE", "DTSTART") and (name == "DUE" or "ts" not in cur):
                try:
                    cur["ts"], cur["allDay"] = _ics_time(prop, value)
                except ValueError:
                    pass
    for it in items:
        it["source"] = source
        it["kind"] = "Due"
    return items


def fetch_ical(feeds):
    now = time.time()
    out = []
    for feed in feeds:
        req = urllib.request.Request(feed["url"], headers={"User-Agent": "desk-dashboard/1.0"})
        with urllib.request.urlopen(req, timeout=25) as r:
            text = r.read().decode("utf-8", "replace")
        out += [i for i in parse_ics(text, feed.get("name", "Calendar"))
                if now - 3600 < i["ts"] < now + 21 * 86400]
    return sorted(out, key=lambda i: i["ts"])


def fetch_vitals():
    """Battery info from Termux:API. Returns None anywhere else (e.g. on the laptop)."""
    try:
        out = subprocess.run(["termux-battery-status"], capture_output=True, text=True, timeout=8)
        b = json.loads(out.stdout)
        return {"battery": b["percentage"], "temp": round(b["temperature"], 1),
                "charging": b["status"] in ("CHARGING", "FULL")}
    except Exception:
        return None


def refresh_loop():
    next_run = {"lc": 0, "cf": 0, "cu": 0, "wx": 0, "vt": 0, "ic": 0}
    lc_contests = []
    while True:
        cfg = config()
        now = time.time()
        every = {"lc": cfg.get("leetcode_refresh_min", 10) * 60, "cf": 3600, "cu": 30 * 60,
                 "wx": 20 * 60, "vt": 60, "ic": 30 * 60}
        needs = {"wx": cfg.get("city"), "ic": cfg.get("ical_feeds"), "cu": cfg.get("codeforces_handle")}
        jobs = [j for j in next_run if now >= next_run[j] and needs.get(j, True)]
        if not cfg.get("ical_feeds"):
            CACHE["deadlines"] = []
        for job in jobs:
            try:
                if job == "lc" and cfg.get("leetcode_username"):
                    lc, lc_contests = fetch_leetcode(cfg["leetcode_username"])
                    with LOCK:
                        CACHE["leetcode"] = lc
                    snapshot_solved(lc["solved"].get("All", 0))
                elif job == "cf":
                    cf = fetch_codeforces()
                    with LOCK:
                        CACHE["cf"] = cf
                elif job == "cu":
                    cu = fetch_codeforces_user(cfg["codeforces_handle"])
                    with LOCK:
                        CACHE["codeforces"] = cu
                elif job == "wx":
                    wx = fetch_weather(cfg["city"])
                    with LOCK:
                        CACHE["weather"] = wx
                elif job == "vt":
                    v = fetch_vitals()
                    with LOCK:
                        CACHE["vitals"] = v
                elif job == "ic":
                    dl = fetch_ical(cfg["ical_feeds"])
                    with LOCK:
                        CACHE["deadlines"] = dl
                next_run[job] = now + every[job]
                CACHE["errors"].pop(job, None)
            except Exception as e:  # keep serving the last good data, retry in 2 min
                CACHE["errors"][job] = str(e)[:200]
                next_run[job] = now + 120
        with LOCK:
            merged = lc_contests + CACHE.get("cf", [])
            horizon = now + 8 * 86400
            CACHE["contests"] = sorted([c for c in merged if now - c["duration"] < c["start"] < horizon],
                                       key=lambda c: c["start"])[:6]
        time.sleep(15)


# ---------- state assembled for the dashboard ----------

def snapshot_solved(total):
    """Keep one LeetCode solved-count per day so the Grind page can show a real pace."""
    path = data_path("lc_history.json")
    hist = load_json(path, {})
    today = dt.date.today().isoformat()
    if hist.get(today) == total:
        return
    hist[today] = total
    cutoff = (dt.date.today() - dt.timedelta(days=60)).isoformat()
    save_json(path, {d: n for d, n in hist.items() if d >= cutoff})


LC_MILESTONES = [25, 50, 75, 100, 150, 200, 250, 300, 400, 500, 600, 750, 1000, 1250, 1500, 2000, 2500, 3000]
CF_MILESTONES = [(1200, "Pupil"), (1400, "Specialist"), (1600, "Expert"), (1900, "Candidate Master"),
                 (2100, "Master"), (2300, "International Master"), (2400, "Grandmaster")]


def lc_pace(total):
    """Problems per week over the last 4 weeks of snapshots, and when the next milestone lands."""
    hist = load_json(data_path("lc_history.json"), {})
    today = dt.date.today()
    window = sorted((d, n) for d, n in hist.items() if d >= (today - dt.timedelta(days=28)).isoformat())
    nxt = next((m for m in LC_MILESTONES if m > total), None)
    if not window:
        return {"days": 0, "next": nxt}
    first_day, first_n = window[0]
    days = (today - dt.date.fromisoformat(first_day)).days
    if days < 3:
        return {"days": days, "next": nxt}
    per_day = (total - first_n) / days
    eta = None
    if nxt and per_day > 0:
        eta = (today + dt.timedelta(days=round((nxt - total) / per_day))).isoformat()
    return {"days": days, "perWeek": round(per_day * 7, 1), "next": nxt, "eta": eta}


def schedule_for(day, cfg, all_events):
    classes = [{"start": c[0], "end": c[1], "title": c[2], "where": c[3] if len(c) > 3 else ""}
               for c in cfg.get("timetable", {}).get(day.strftime("%a").lower(), [])]
    events = [{"start": e.get("time", ""), "end": e.get("end", ""), "where": e.get("where", ""),
               "title": e["title"], "kind": e.get("kind", "")}
              for e in all_events if e.get("date") == day.isoformat() and e.get("title")]
    return sorted(classes + events, key=lambda x: x["start"] or "99")


def _hhmm(s):
    h, m = (s or "0:0").split(":")[:2]
    return int(h) * 60 + int(m)


def pick_schedule(cfg, all_events):
    """Today's schedule, or the next day that has something once today's last item has ended."""
    now = dt.datetime.now()
    today = now.date()
    items = schedule_for(today, cfg, all_events)
    timed = [x for x in items if x["start"]]
    last_end = max((_hhmm(x["end"]) if x["end"] else _hhmm(x["start"]) + 60 for x in timed), default=None)
    over = not items or (last_end is not None and now.hour * 60 + now.minute >= last_end)
    if not over:
        return {"label": "Today", "isToday": True, "items": items}
    for ahead in range(1, 8):
        day = today + dt.timedelta(days=ahead)
        nxt = schedule_for(day, cfg, all_events)
        if nxt:
            label = "Tomorrow" if ahead == 1 else day.strftime("%A")
            return {"label": label, "isToday": False, "items": nxt}
    return {"label": "Today", "isToday": True, "items": items}


# ---------- goals, XP and levels ----------

DEFAULT_GOALS = [
    {"id": "potd", "label": "LeetCode POTD", "period": "day", "metric": "lc_potd", "target": 1},
    {"id": "lc2", "label": "LeetCode problems", "period": "day", "metric": "lc_solved", "target": 2},
    {"id": "dms", "label": "Referral DMs / cold mails", "period": "week", "metric": "manual", "target": 10},
    {"id": "apps", "label": "Applications sent", "period": "week", "metric": "manual", "target": 5},
    {"id": "cfc", "label": "Codeforces contests", "period": "month", "metric": "cf_contests", "target": 3},
]
METRICS = ["manual", "lc_potd", "lc_solved", "cf_contests", "focus_min"]
PERIODS = ["day", "week", "month"]
GOAL_XP = {"day": 10, "week": 50, "month": 120}
BONUS_XP = {"day": 20, "week": 60}  # every goal of that period met
MILESTONE_XP = {"lc": 100, "cf": 200}
TITLES = ["Rookie", "Apprentice", "Grinder", "Solver", "Problem Slayer", "Hacker", "Architect", "Wizard",
          "Legend", "Mythic"]


def goal_defs():
    path = data_path("goals.json")
    if not os.path.exists(path):
        save_json(path, DEFAULT_GOALS)
    return load_json(path, DEFAULT_GOALS)


def period_key(period, day):
    if period == "day":
        return day.isoformat()
    if period == "week":
        return week_key(day)
    return day.strftime("%Y-%m")


def level_of(xp):
    level, need = 1, 100
    while xp >= need:
        xp -= need
        level += 1
        need = 100 + 50 * (level - 1)
    return {"level": level, "into": xp, "need": need, "title": TITLES[min((level - 1) // 2, len(TITLES) - 1)]}


def goal_value(g, today, lc, cu, counters, focus):
    """Current progress for one goal, or None when its data source hasn't loaded yet."""
    m = g["metric"]
    if m == "manual":
        return counters.get(period_key(g["period"], today), {}).get(g["id"], 0)
    if m in ("lc_potd", "lc_solved"):
        if not lc:
            return None
        todays = {s["slug"] for s in lc.get("recent", [])
                  if dt.datetime.fromtimestamp(s["ts"]).date() == today}
        if m == "lc_potd":
            return 1 if lc["daily"].get("slug") in todays else 0
        if g["period"] == "day":
            return len(todays)
        # Weekly/monthly problem counts come from the activity calendar (submissions, not unique).
        start = week_start(today) if g["period"] == "week" else today.replace(day=1)
        return sum(n for d, n in lc.get("calendar", {}).items() if start.isoformat() <= d <= today.isoformat())
    if m == "cf_contests":
        if not cu:
            return None
        start = {"day": today, "week": week_start(today), "month": today.replace(day=1)}[g["period"]]
        return sum(1 for c in cu["contests"] if dt.datetime.fromtimestamp(c["ts"]).date() >= start)
    if m == "focus_min":
        if g["period"] == "day":
            return focus.get(today.isoformat(), 0)
        start = week_start(today) if g["period"] == "week" else today.replace(day=1)
        return sum(n for d, n in focus.items() if start.isoformat() <= d <= today.isoformat())
    return None


def sync_goals(today, lc, cu, counters, focus):
    """Work out goal progress and keep data/xp.json in step with it.

    XP for the current day/week/month follows the goal: hit it and the XP lands, undo a +1 and it
    goes again. Past periods are frozen. Milestones already passed on the first run count as a
    baseline (no XP), so turning this on doesn't dump hundreds of XP at once.
    """
    defs = goal_defs()
    rows = []
    for g in defs:
        v = goal_value(g, today, lc, cu, counters, focus)
        rows.append({**g, "value": v, "xp": GOAL_XP.get(g["period"], 10),
                     "key": f"g:{g['id']}:{period_key(g['period'], today)}"})

    wanted = {}   # award key -> (xp, label), for everything decided right now
    undecided = set()
    for r in rows:
        if r["value"] is None:
            undecided.add(r["key"])
        elif r["value"] >= r["target"]:
            wanted[r["key"]] = (r["xp"], r["label"])
    for period, bonus in BONUS_XP.items():
        group = [r for r in rows if r["period"] == period]
        key = f"perfect:{period}:{period_key(period, today)}"
        if not group or any(r["value"] is None for r in group):
            undecided.add(key)
        elif all(r["value"] >= r["target"] for r in group):
            wanted[key] = (bonus, "Perfect day" if period == "day" else "Perfect week")

    with XP_LOCK:
        path = data_path("xp.json")
        store = load_json(path, {})
        awards = store.setdefault("awards", {})
        floors = store.setdefault("baseline", {})
        changed = False
        current = {r["key"] for r in rows} | {f"perfect:{p}:{period_key(p, today)}" for p in BONUS_XP}
        for key in current - undecided:
            if key in wanted and key not in awards:
                xp, label = wanted[key]
                awards[key] = {"xp": xp, "label": label, "ts": time.time()}
                changed = True
            elif key not in wanted and key in awards:
                del awards[key]
                changed = True

        def milestone(track, value, steps, xp):
            nonlocal changed
            if value is None:
                return
            if track not in floors:
                floors[track] = value
                changed = True
            for step, name in steps:
                key = f"ms:{track}:{step}"
                if value >= step and key not in awards:
                    gained = 0 if step <= floors[track] else xp
                    awards[key] = {"xp": gained, "label": name, "ts": time.time()}
                    changed = True

        lc_total = lc["solved"].get("All") if lc else None
        milestone("lc", lc_total, [(m, f"{m} LeetCode solved") for m in LC_MILESTONES], MILESTONE_XP["lc"])
        milestone("cf", cu.get("maxRating") if cu else None,
                  [(r, f"Codeforces {name}") for r, name in CF_MILESTONES], MILESTONE_XP["cf"])

        perfect_days = {k.split(":", 2)[2] for k in awards if k.startswith("perfect:day:")}
        day = today if today.isoformat() in perfect_days else today - dt.timedelta(days=1)
        streak = 0
        while day.isoformat() in perfect_days:
            streak += 1
            day -= dt.timedelta(days=1)
        if streak > store.get("bestStreak", 0):
            store["bestStreak"] = streak
            changed = True
        if changed:
            save_json(path, store)
        total = sum(a["xp"] for a in awards.values())
        recent = sorted(({"key": k, **a} for k, a in awards.items() if a["xp"] > 0),
                        key=lambda a: a["ts"], reverse=True)[:5]
        best = store.get("bestStreak", 0)
        has_perfect_week = any(k.startswith("perfect:week:") for k in awards)
        first = any(a["xp"] > 0 for a in awards.values())

    lvl = level_of(total)
    cf_max = (cu or {}).get("maxRating") or 0
    badges = [
        ("First tick", first), ("3-day streak", best >= 3), ("7-day streak", best >= 7),
        ("30-day streak", best >= 30), ("Perfect week", has_perfect_week), ("Level 5", lvl["level"] >= 5),
        ("Level 10", lvl["level"] >= 10), ("Specialist", cf_max >= 1400), ("Expert", cf_max >= 1600),
    ]

    def next_step(value, steps):
        prev = 0
        for step, name in steps:
            if value < step:
                return {"value": value, "from": prev, "to": step, "name": name}
            prev = step
        return {"value": value, "from": prev, "to": None, "name": "All done"}

    milestones = []
    if lc_total is not None:
        milestones.append({"track": "LeetCode", "unit": "solved",
                           **next_step(lc_total, [(m, f"{m} solved") for m in LC_MILESTONES])})
    if cu and cu.get("rating") is not None:
        milestones.append({"track": "Codeforces", "unit": "rating",
                           **next_step(cu["rating"], CF_MILESTONES)})
    return {
        "goals": [{k: r[k] for k in ("id", "label", "period", "metric", "target", "value", "xp")}
                  | {"met": r["value"] is not None and r["value"] >= r["target"]} for r in rows],
        "xp": total, **lvl, "streak": streak, "bestStreak": best,
        "recent": recent, "badges": [{"name": n, "got": g} for n, g in badges],
        "milestones": milestones, "defs": defs, "metrics": METRICS, "periods": PERIODS,
    }


# ---------- state assembled for the dashboard ----------

def build_state():
    cfg = config()
    today = dt.date.today()
    counters = load_json(data_path("counters.json"), {})
    focus = load_json(data_path("focus.json"), {})
    with LOCK:
        lc = CACHE["leetcode"]
        cu = CACHE["codeforces"]
        state = {k: CACHE[k] for k in ("leetcode", "codeforces", "contests", "weather", "vitals")}
        state["errors"] = dict(CACHE["errors"])

    ws = week_start(today)
    week_days = [(ws + dt.timedelta(days=i)).isoformat() for i in range(7)]
    state["progress"] = sync_goals(today, lc, cu, counters, focus)
    if lc:
        state["pace"] = lc_pace(lc["solved"].get("All", 0))
        state["lcWeek"] = sum(lc.get("calendar", {}).get(d, 0) for d in week_days)
    state["focus"] = {"today": focus.get(today.isoformat(), 0),
                      "week": sum(focus.get(d, 0) for d in week_days),
                      "presets": cfg.get("focus_presets", [25, 50])}
    # Exams/tests/etc. come from data/events.json (editor + API) and config.json "events".
    all_events = load_json(data_path("events.json"), []) + cfg.get("events", [])
    state["schedule"] = pick_schedule(cfg, all_events)

    # "Coming up": exams/tests, assignment deadlines from calendar feeds, and plain countdowns.
    def local_ts(date, hhmm=""):
        d = dt.datetime.strptime(f"{date} {hhmm or '00:00'}", "%Y-%m-%d %H:%M")
        return time.mktime(d.timetuple())

    upcoming = []
    for e in all_events:
        try:
            upcoming.append({"title": e["title"], "kind": e.get("kind", "Event"), "where": e.get("where", ""),
                             "ts": local_ts(e["date"], e.get("time")), "allDay": not e.get("time")})
        except (KeyError, ValueError):
            continue
    for c in cfg.get("countdowns", []):
        try:
            upcoming.append({"title": c["label"], "kind": "", "where": "", "ts": local_ts(c["date"]), "allDay": True})
        except (KeyError, ValueError):
            continue
    with LOCK:
        upcoming += [dict(d) for d in CACHE.get("deadlines", [])]
    start_of_today = local_ts(today.isoformat())
    state["upcoming"] = sorted([u for u in upcoming if u["ts"] >= start_of_today], key=lambda u: u["ts"])
    state["events"] = sorted(load_json(data_path("events.json"), []), key=lambda e: (e["date"], e.get("time", "")))
    state["display"] = {k: cfg.get(k) for k in ("rotate_seconds", "night_start", "night_end", "name")}
    state["serverTime"] = time.time()
    return state


# ---------- HTTP ----------

EVENT_KINDS = ["Exam", "Test", "Quiz", "Lab exam", "Viva", "Due", "OA", "Event"]


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=STATIC, **kw)

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else "") and "GET" in (args[0] if args else ""):
            return  # don't spam the Termux console with polling
        super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, value, code=200):
        body = json.dumps(value).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def allowed_to_write(self):
        # The phone itself (localhost) can always write; other devices need the PIN.
        if self.client_address[0] in ("127.0.0.1", "::1"):
            return True
        return self.headers.get("X-Pin", "") == get_pin()

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/state":
            return self.send_json(build_state())
        if path == "/api/ping":
            return self.send_json({"ok": True, "local": self.client_address[0] in ("127.0.0.1", "::1")})
        if path == "/edit":
            self.path = "/edit.html"
        return super().do_GET()

    def do_POST(self):
        self.write("POST")

    def do_PUT(self):
        self.write("PUT")

    def do_DELETE(self):
        self.write("DELETE")

    def write(self, method):
        path = urllib.parse.urlparse(self.path).path
        if not self.allowed_to_write():
            return self.send_json({"error": "Wrong or missing PIN"}, 401)
        try:
            body = self.read_body()
        except json.JSONDecodeError:
            return self.send_json({"error": "Body must be JSON"}, 400)
        today = dt.date.today()
        with LOCK:
            if path == "/api/pin-check":
                return self.send_json({"ok": True})
            if path == "/api/counter" and method == "POST":
                goal = next((g for g in goal_defs() if g["id"] == body.get("id")), None)
                if not goal or goal["metric"] != "manual":
                    return self.send_json({"error": "Unknown manual goal"}, 400)
                counters = load_json(data_path("counters.json"), {})
                bucket = counters.setdefault(period_key(goal["period"], today), {})
                delta = max(-1, min(1, int(body.get("delta", 1))))
                bucket[goal["id"]] = max(0, bucket.get(goal["id"], 0) + delta)
                save_json(data_path("counters.json"), counters)
                return self.send_json({"value": bucket[goal["id"]]})
            if path == "/api/goals" and method == "PUT":
                return self.save_goals(body)
            if path == "/api/focus" and method == "POST":
                minutes = int(body.get("minutes", 0))
                if not 0 < minutes <= 240:
                    return self.send_json({"error": "minutes must be 1-240"}, 400)
                focus = load_json(data_path("focus.json"), {})
                focus[today.isoformat()] = focus.get(today.isoformat(), 0) + minutes
                save_json(data_path("focus.json"), focus)
                return self.send_json({"today": focus[today.isoformat()]})
            if path.startswith("/api/events"):
                return self.events(method, path, body)
        return self.send_json({"error": "Not found"}, 404)

    def events(self, method, path, body):
        items = load_json(data_path("events.json"), [])
        item_id = path[len("/api/events/"):] if path.startswith("/api/events/") else None
        if method == "POST" and not item_id:
            title = (body.get("title") or "").strip()
            date = (body.get("date") or "").strip()
            hhmm = (body.get("time") or "").strip()
            try:
                dt.date.fromisoformat(date)
                if hhmm:
                    dt.datetime.strptime(hhmm, "%H:%M")
            except ValueError:
                return self.send_json({"error": "date must be YYYY-MM-DD and time HH:MM"}, 400)
            if not title:
                return self.send_json({"error": "Title is required"}, 400)
            kind = body.get("kind") if body.get("kind") in EVENT_KINDS else "Event"
            item = {"id": secrets.token_hex(4), "kind": kind, "title": title[:80], "date": date,
                    "time": hhmm, "end": (body.get("end") or "").strip()[:5],
                    "where": (body.get("where") or "").strip()[:40]}
            items.append(item)
            save_json(data_path("events.json"), items)
            return self.send_json(item, 201)
        match = next((i for i in items if i["id"] == item_id), None)
        if method == "DELETE" and match:
            items.remove(match)
            save_json(data_path("events.json"), items)
            return self.send_json({"ok": True})
        return self.send_json({"error": "No such event"}, 404)

    def save_goals(self, body):
        """Replace the goal list. Keeps ids stable so progress and XP stay attached."""
        incoming = body.get("goals")
        if not isinstance(incoming, list) or len(incoming) > 20:
            return self.send_json({"error": "Send {\"goals\": [...]} with at most 20 goals"}, 400)
        out, seen = [], set()
        for g in incoming:
            label = str(g.get("label") or "").strip()[:60]
            if not label:
                return self.send_json({"error": "Every goal needs a name"}, 400)
            if g.get("period") not in PERIODS or g.get("metric") not in METRICS:
                return self.send_json({"error": f"Bad period or tracking for '{label}'"}, 400)
            try:
                target = int(g.get("target"))
            except (TypeError, ValueError):
                target = 0
            if not 1 <= target <= 10000:
                return self.send_json({"error": f"Target for '{label}' must be 1-10000"}, 400)
            gid = str(g.get("id") or "").strip()[:24] or secrets.token_hex(3)
            if gid in seen:
                gid = secrets.token_hex(3)
            seen.add(gid)
            out.append({"id": gid, "label": label, "period": g["period"], "metric": g["metric"], "target": target})
        save_json(data_path("goals.json"), out)
        return self.send_json({"goals": out})


def main():
    cfg = config()
    port = int(cfg.get("port", 8080))
    threading.Thread(target=refresh_loop, daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"Dashboard:       http://localhost:{port}")
    print(f"Editor:          http://<this-phone's-ip>:{port}/edit   (PIN {get_pin()})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
