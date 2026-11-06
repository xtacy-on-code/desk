"""Desk dashboard server. Python standard library only, so it runs as-is in Termux.

    python server.py            # serves on http://localhost:8080 (port from config.json)

The phone opens http://localhost:8080. Your laptop opens http://<phone-ip>:8080/edit
to manage the internship tracker (needs the PIN printed at startup).
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
CACHE = {"leetcode": None, "contests": [], "weather": None, "vitals": None, "deadlines": [], "errors": {}}


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
 recentAcSubmissionList(username:$u, limit:15){ title titleSlug timestamp }
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
                   for s in recent[:5]],
        "daily": {"title": daily["question"]["title"], "difficulty": daily["question"]["difficulty"],
                  "url": "https://leetcode.com" + daily["link"], "done": daily_done},
    }, lc_contests


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
    next_run = {"lc": 0, "cf": 0, "wx": 0, "vt": 0, "ic": 0}
    lc_contests = []
    while True:
        cfg = config()
        now = time.time()
        every = {"lc": cfg.get("leetcode_refresh_min", 10) * 60, "cf": 3600, "wx": 20 * 60, "vt": 60, "ic": 30 * 60}
        needs = {"wx": cfg.get("city"), "ic": cfg.get("ical_feeds")}
        jobs = [j for j in next_run if now >= next_run[j] and needs.get(j, True)]
        if not cfg.get("ical_feeds"):
            CACHE["deadlines"] = []
        for job in jobs:
            try:
                if job == "lc" and cfg.get("leetcode_username"):
                    lc, lc_contests = fetch_leetcode(cfg["leetcode_username"])
                    with LOCK:
                        CACHE["leetcode"] = lc
                elif job == "cf":
                    cf = fetch_codeforces()
                    with LOCK:
                        CACHE["cf"] = cf
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

def build_state():
    cfg = config()
    today = dt.date.today()
    tracker = load_json(data_path("tracker.json"), [])
    counters = load_json(data_path("counters.json"), {})
    focus = load_json(data_path("focus.json"), {})
    with LOCK:
        lc = CACHE["leetcode"]
        state = {k: CACHE[k] for k in ("leetcode", "contests", "weather", "vitals")}
        state["errors"] = dict(CACHE["errors"])

    ws = week_start(today)
    week_days = [(ws + dt.timedelta(days=i)).isoformat() for i in range(7)]
    dsa_week = sum((lc or {}).get("calendar", {}).get(d, 0) for d in week_days) if lc else None
    apps_week = sum(1 for a in tracker if a.get("applied", "") >= ws.isoformat())
    wk = counters.get(week_key(today), {})
    goals_cfg = cfg.get("weekly_goals", {})
    state["goals"] = [
        {"key": "dsa", "label": "LeetCode submissions", "value": dsa_week, "goal": goals_cfg.get("dsa", 14), "auto": True},
        {"key": "dms", "label": "Referral asks / cold DMs", "value": wk.get("dms", 0), "goal": goals_cfg.get("dms", 10), "auto": False},
        {"key": "apps", "label": "Applications sent", "value": apps_week, "goal": goals_cfg.get("apps", 5), "auto": True},
        {"key": "mocks", "label": "Mock interviews", "value": wk.get("mocks", 0), "goal": goals_cfg.get("mocks", 1), "auto": False},
    ]
    state["focus"] = {"today": focus.get(today.isoformat(), 0),
                      "week": sum(focus.get(d, 0) for d in week_days),
                      "presets": cfg.get("focus_presets", [25, 50])}
    state["tracker"] = tracker
    day_name = today.strftime("%a").lower()
    classes = [{"start": c[0], "end": c[1], "title": c[2], "where": c[3] if len(c) > 3 else ""}
               for c in cfg.get("timetable", {}).get(day_name, [])]
    # Exams/tests/etc. come from data/events.json (editor + API) and config.json "events".
    all_events = load_json(data_path("events.json"), []) + cfg.get("events", [])
    todays = [{"start": e.get("time", ""), "end": e.get("end", ""), "where": e.get("where", ""),
               "title": e["title"], "kind": e.get("kind", "")}
              for e in all_events if e.get("date") == today.isoformat()]
    state["schedule"] = sorted(classes + todays, key=lambda x: x["start"] or "99")

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

STAGES = ["Applied", "OA", "Interview", "Offer", "Rejected", "Ghosted"]
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
                key = body.get("key")
                if key not in ("dms", "mocks"):
                    return self.send_json({"error": "Unknown counter"}, 400)
                counters = load_json(data_path("counters.json"), {})
                wk = counters.setdefault(week_key(today), {})
                wk[key] = max(0, wk.get(key, 0) + int(body.get("delta", 1)))
                save_json(data_path("counters.json"), counters)
                return self.send_json({"value": wk[key]})
            if path == "/api/focus" and method == "POST":
                minutes = int(body.get("minutes", 0))
                if not 0 < minutes <= 240:
                    return self.send_json({"error": "minutes must be 1-240"}, 400)
                focus = load_json(data_path("focus.json"), {})
                focus[today.isoformat()] = focus.get(today.isoformat(), 0) + minutes
                save_json(data_path("focus.json"), focus)
                return self.send_json({"today": focus[today.isoformat()]})
            if path.startswith("/api/tracker"):
                return self.tracker(method, path, body, today)
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

    def tracker(self, method, path, body, today):
        items = load_json(data_path("tracker.json"), [])
        item_id = path[len("/api/tracker/"):] if path.startswith("/api/tracker/") else None
        if method == "POST" and not item_id:
            company = (body.get("company") or "").strip()
            if not company:
                return self.send_json({"error": "Company is required"}, 400)
            stage = body.get("stage") if body.get("stage") in STAGES else "Applied"
            item = {"id": secrets.token_hex(4), "company": company[:60],
                    "role": (body.get("role") or "SWE Intern").strip()[:60],
                    "stage": stage, "applied": body.get("applied") or today.isoformat(),
                    "updated": today.isoformat(), "via": (body.get("via") or "").strip()[:40],
                    "notes": (body.get("notes") or "").strip()[:200]}
            items.insert(0, item)
            save_json(data_path("tracker.json"), items)
            return self.send_json(item, 201)
        match = next((i for i in items if i["id"] == item_id), None)
        if not match:
            return self.send_json({"error": "No such application"}, 404)
        if method == "DELETE":
            items.remove(match)
            save_json(data_path("tracker.json"), items)
            return self.send_json({"ok": True})
        if method == "PUT":
            for k in ("company", "role", "via", "notes", "applied"):
                if k in body:
                    match[k] = str(body[k]).strip()[:200]
            if body.get("stage") in STAGES and body["stage"] != match["stage"]:
                match["stage"] = body["stage"]
                match["updated"] = today.isoformat()
            save_json(data_path("tracker.json"), items)
            return self.send_json(match)
        return self.send_json({"error": "Method not allowed"}, 405)


def main():
    cfg = config()
    port = int(cfg.get("port", 8080))
    threading.Thread(target=refresh_loop, daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"Dashboard:       http://localhost:{port}")
    print(f"Tracker editor:  http://<this-phone's-ip>:{port}/edit   (PIN {get_pin()})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
