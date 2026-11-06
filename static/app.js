"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const inr = new Intl.NumberFormat("en-IN");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const STAGES = ["Applied", "OA", "Interview", "Offer", "Rejected"];

let state = null;
let page = 0;
let lastTouch = 0;
let nightWake = 0;

/* ---------------- time helpers ---------------- */

const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const toMin = (s) => { const [h, m] = (s || "").split(":").map(Number); return h * 60 + (m || 0); };

function until(sec) {
  const s = Math.max(0, Math.round(sec));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

function ago(isoDate) {
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(isoDate + "T00:00").getTime()) / 864e5);
  return days <= 0 ? "today" : days === 1 ? "1d" : `${days}d`;
}

function mins(m) {
  if (!m) return "0m";
  const h = Math.floor(m / 60);
  return h ? `${h}h ${pad(m % 60)}m` : `${m}m`;
}

/* ---------------- pages ---------------- */

const pages = [...document.querySelectorAll(".page")];
const tabs = [...document.querySelectorAll(".tab")];

function show(i) {
  page = (i + pages.length) % pages.length;
  pages.forEach((p, n) => p.classList.toggle("is-active", n === page));
  tabs.forEach((t, n) => n === page ? t.setAttribute("aria-current", "page") : t.removeAttribute("aria-current"));
  $("topClock").hidden = page === 0;
}

tabs.forEach((t) => t.addEventListener("click", () => { lastTouch = Date.now(); show(+t.dataset.page); }));

// Swipe between pages
let downX = null;
$("pages").addEventListener("pointerdown", (e) => { downX = e.clientX; });
$("pages").addEventListener("pointerup", (e) => {
  if (downX === null) return;
  const dx = e.clientX - downX;
  downX = null;
  if (Math.abs(dx) > 50) { lastTouch = Date.now(); show(page + (dx < 0 ? 1 : -1)); }
});
document.addEventListener("pointerdown", () => { lastTouch = Date.now(); });

/* ---------------- clock, night mode, rotation ---------------- */

function inNight(now) {
  const d = state?.display || {};
  if (!d.night_start || !d.night_end) return false;
  const m = now.getHours() * 60 + now.getMinutes(), s = toMin(d.night_start), e = toMin(d.night_end);
  return s < e ? m >= s && m < e : m >= s || m < e;
}

function tick() {
  const now = new Date();
  $("clock").innerHTML = `${hm(now)}<small>${pad(now.getSeconds())}</small>`;
  $("topClock").textContent = hm(now);
  $("date").textContent = `${DAYS[now.getDay()]}, ${pad(now.getDate())} ${MONTHS[now.getMonth()]}`;

  const night = inNight(now) && Date.now() - nightWake > 60_000 && !focus.running();
  $("night").hidden = !night;
  if (night) $("nightClock").textContent = hm(now);

  renderFocus();
  renderContestAlert();
}

// Tap the night screen to wake the dashboard for a minute
$("night").addEventListener("pointerdown", () => { nightWake = Date.now(); tick(); });

// Auto-rotate pages, but not for 2 minutes after a touch, and stay on Today while focusing.
let lastRotate = Date.now();
setInterval(() => {
  const every = (state?.display?.rotate_seconds || 30) * 1000;
  if (focus.running()) { if (page !== 0) show(0); lastRotate = Date.now(); return; }
  if (Date.now() - lastTouch > 120_000 && Date.now() - lastRotate >= every) {
    lastRotate = Date.now();
    show(page + 1);
  }
}, 1000);

// Shift the whole layout a few pixels every 5 minutes so nothing burns into the screen.
setInterval(() => {
  const r = () => Math.round(Math.random() * 6 - 3);
  $("app").style.transform = `translate(${r()}px, ${r()}px)`;
  $("nightClock").style.transform = `translate(${r() * 6}px, ${r() * 4}px)`;
}, 5 * 60_000);

/* ---------------- focus timer ---------------- */

const focus = {
  get: () => { try { return JSON.parse(localStorage.getItem("focus") || "null"); } catch { return null; } },
  set: (v) => { try { v ? localStorage.setItem("focus", JSON.stringify(v)) : localStorage.removeItem("focus"); } catch {} },
  running() { const f = this.get(); return !!(f && !f.pausedLeft); },
};

function startFocus(minutes) {
  focus.set({ minutes, endAt: Date.now() + minutes * 60_000 });
  renderFocus(true);
}

function pauseFocus() {
  const f = focus.get();
  if (!f) return;
  if (f.pausedLeft) focus.set({ minutes: f.minutes, endAt: Date.now() + f.pausedLeft });
  else focus.set({ minutes: f.minutes, endAt: f.endAt, pausedLeft: f.endAt - Date.now() });
  renderFocus(true);
}

function stopFocus() { focus.set(null); renderFocus(true); }

async function finishFocus(minutes) {
  focus.set(null);
  try { navigator.vibrate?.([200, 100, 200]); } catch {}
  await api("POST", "/api/focus", { minutes });
  load();
}

let lastFocusKey = "";
function renderFocus(force) {
  const f = focus.get();
  const presets = state?.focus?.presets || [25, 50];
  const C = 175.93;
  let left = presets[0] * 60_000, total = left;
  if (f) {
    total = f.minutes * 60_000;
    left = f.pausedLeft ?? f.endAt - Date.now();
    if (left <= 0) { finishFocus(f.minutes); left = 0; }
  }
  const s = Math.ceil(left / 1000);
  $("focusTime").textContent = `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
  $("ringFg").style.strokeDashoffset = f ? String(C * (left / total)) : String(C);

  const key = f ? (f.pausedLeft ? "paused" : "running") : "idle:" + presets.join(",");
  if (key !== lastFocusKey || force) {
    lastFocusKey = key;
    const a = $("focusActions");
    if (!f) {
      a.innerHTML = presets.map((m) => `<button class="btn" data-start="${m}">${m} min</button>`).join("");
    } else {
      a.innerHTML = `<button class="btn primary" data-act="pause">${f.pausedLeft ? "Resume" : "Pause"}</button>
                     <button class="btn" data-act="stop">Stop</button>`;
    }
  }
}

$("focusActions").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.start) startFocus(+b.dataset.start);
  else if (b.dataset.act === "pause") pauseFocus();
  else if (b.dataset.act === "stop") stopFocus();
});

/* ---------------- data ---------------- */

async function api(method, url, body) {
  const r = await fetch(url, {
    method, headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}

async function load() {
  try {
    state = await api("GET", "/api/state");
    setSync(true);
    render();
  } catch {
    setSync(false);
  }
}

function setSync(ok) {
  const el = $("sync");
  const errs = state ? Object.keys(state.errors || {}) : [];
  el.className = "sync " + (ok && !errs.length ? "ok" : "bad");
  const names = { lc: "LeetCode", cf: "Codeforces", wx: "weather", vt: "battery", ic: "deadlines feed" };
  el.lastElementChild.textContent = !ok ? "Server offline"
    : errs.length ? `${errs.map((e) => names[e] || e).join(", ")} failed` : "Live";
}

/* ---------------- render ---------------- */

function render() {
  renderTop();
  renderToday();
  renderGrind();
  renderHunt();
  renderFocus(true);
}

function renderTop() {
  const v = state.vitals, el = $("battery");
  el.hidden = !v;
  if (v) {
    el.textContent = `${v.battery}%${v.charging ? " charging" : ""} · ${v.temp}°C`;
    el.classList.toggle("battery-hot", v.temp >= 42);
  }
}

function renderContestAlert() {
  const el = $("alert");
  const now = Date.now() / 1000;
  const c = (state?.contests || []).find((c) => c.start - now < 90 * 60 && c.start + c.duration > now);
  el.hidden = !c;
  if (c) el.textContent = c.start > now ? `${c.name} starts in ${until(c.start - now)}` : `${c.name} is live`;
}

function renderToday() {
  const w = state.weather;
  $("weather").innerHTML = w
    ? `<b>${w.temp}°</b> ${esc(w.text)} · feels ${w.feels}° · ${w.hi}°/${w.lo}° · rain ${w.rain}% · ${esc(w.place)}`
    : `Set <code class="num">"city"</code> in config.json for weather`;

  const today = new Date().setHours(0, 0, 0, 0);
  const up = state.upcoming.slice(0, 3);
  const more = state.upcoming.length - up.length;
  $("upcomingMore").textContent = more > 0 ? `+${more} more` : "";
  $("upcoming").innerHTML = up.length ? up.map((u) => {
    const d = new Date(u.ts * 1000);
    const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - today) / 864e5);
    const when = days === 0 ? "today" : days === 1 ? "tmrw" : `${days}d`;
    const urgent = days <= 1 ? " urgent" : "";
    const kind = u.kind ? `<span class="kind kind-${esc(u.kind.replace(/\s/g, ""))}">${esc(u.kind)}</span>` : "";
    const at = `${DAYS[d.getDay()].slice(0, 3)} ${pad(d.getDate())} ${MONTHS[d.getMonth()]}${u.allDay ? "" : " · " + hm(d)}`;
    return `<li class="${urgent}"><span class="t num">${when}</span>
            <span class="main">${kind}${esc(u.title)}</span><span class="side num">${at}</span></li>`;
  }).join("") : `<li class="empty">Nothing coming up. Exams, tests and assignment deadlines appear here.</li>`;

  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const sch = state.schedule;
  $("schedule").innerHTML = sch.length ? sch.map((s) => {
    const st = toMin(s.start), en = s.end ? toMin(s.end) : st + 60;
    const cls = s.start && nowMin >= st && nowMin < en ? "now" : s.start && nowMin >= en ? "past" : "";
    const kind = s.kind ? `<span class="kind kind-${esc(s.kind.replace(/\s/g, ""))}">${esc(s.kind)}</span>` : "";
    return `<li class="${cls}"><span class="t num">${esc(s.start || "—")}</span>
            <span class="main">${kind}${esc(s.title)}</span><span class="side">${esc(s.where)}</span></li>`;
  }).join("") : `<li class="empty">Nothing scheduled today. Add classes to <code>"timetable"</code> in config.json.</li>`;

  const f = state.focus;
  $("focusTotal").textContent = `Focus today ${mins(f.today)} · this week ${mins(f.week)}`;
}

function renderGrind() {
  const lc = state.leetcode;
  if (!lc) {
    $("solvedTotal").textContent = "—";
    $("daily").innerHTML = `<span class="sk" style="width:80%"></span><span class="sk" style="width:40%"></span>`;
    return;
  }
  const s = lc.solved, t = lc.totals;
  $("solvedTotal").textContent = s.All;
  $("solvedOf").textContent = `/ ${inr.format(t.All)}`;
  const parts = [["Easy", "var(--easy)"], ["Medium", "var(--med)"], ["Hard", "var(--hard)"]];
  $("split").innerHTML = parts.map(([k, c]) => `<i style="flex:${s[k] || 0.01};background:${c}"></i>`).join("");
  $("legend").innerHTML = parts.map(([k, c]) =>
    `<span><i class="dot" style="background:${c}"></i>${k}<b>${s[k]}</b></span>`).join("");
  $("stats").innerHTML = `
    <div><b class="${lc.streak ? "" : "muted"}">${lc.streak}</b><span>day streak</span></div>
    <div><b>${lc.activeDays}</b><span>active days</span></div>
    <div><b>${lc.contestRating ?? "—"}</b><span>${lc.contestRating ? "contest rating" : "no contests yet"}</span></div>
    <div><b>${inr.format(lc.ranking)}</b><span>global rank</span></div>`;

  // 18-week heatmap (columns = weeks, Monday on top)
  const weeks = 18, today = new Date(); today.setHours(0, 0, 0, 0);
  const start = new Date(today); start.setDate(today.getDate() - ((today.getDay() + 6) % 7) - (weeks - 1) * 7);
  const cells = [];
  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const n = lc.calendar[key] || 0;
    const lvl = n === 0 ? "" : n < 3 ? "l1" : n < 6 ? "l2" : n < 10 ? "l3" : "l4";
    const cls = d > today ? "future" : `${lvl}${+d === +today ? " today" : ""}`;
    cells.push(`<i class="${cls}" title="${key}: ${n}"></i>`);
  }
  $("heat").innerHTML = cells.join("");

  const dl = lc.daily;
  $("daily").href = dl.url;
  $("daily").innerHTML = `<div class="title">${esc(dl.title)}</div>
    <div class="meta"><span class="${dl.difficulty.toLowerCase()}">${esc(dl.difficulty)}</span>
    <span class="${dl.done ? "done" : ""}">${dl.done ? "Solved today" : "Not solved yet"}</span></div>`;

  const now = Date.now() / 1000;
  const cs = state.contests.slice(0, 4);
  $("contests").innerHTML = cs.length ? cs.map((c) => {
    const d = new Date(c.start * 1000);
    const live = c.start <= now;
    return `<li class="${live ? "now" : ""}"><span class="t">${c.site === "LeetCode" ? "LC" : "CF"}</span>
      <span class="main">${esc(c.name)}</span>
      <span class="side num">${live ? "live" : `${DAYS[d.getDay()].slice(0, 3)} ${hm(d)} · ${until(c.start - now)}`}</span></li>`;
  }).join("") : `<li class="empty">No contests in the next week.</li>`;
}

function renderHunt() {
  const apps = state.tracker;
  const count = (st) => apps.filter((a) => a.stage === st || (st === "Rejected" && a.stage === "Ghosted")).length;
  $("pipeline").innerHTML = STAGES.map((st) => {
    const n = count(st);
    return `<div class="${n ? "" : "zero"}"><b>${n}</b><span>${st === "Rejected" ? "Closed" : st}</span></div>`;
  }).join("");

  const active = [...apps].sort((a, b) =>
    (["Offer", "Interview", "OA", "Applied", "Rejected", "Ghosted"].indexOf(a.stage)) -
    (["Offer", "Interview", "OA", "Applied", "Rejected", "Ghosted"].indexOf(b.stage)));
  $("apps").innerHTML = apps.length ? active.slice(0, 5).map((a) => `
    <li><span class="t stage-${esc(a.stage)}">${esc(a.stage)}</span>
      <span class="main">${esc(a.company)} <span class="muted">· ${esc(a.role)}</span></span>
      <span class="side num">${ago(a.updated)}</span></li>`).join("")
    : `<li class="empty">No applications yet. On your laptop, open<br><code>http://&lt;phone-ip&gt;:${location.port || 80}/edit</code></li>`;

  $("goals").innerHTML = state.goals.map((g) => {
    const v = g.value ?? 0, pct = Math.min(1, v / g.goal);
    return `<li class="${v >= g.goal ? "met" : ""}">
      <span class="g-label">${esc(g.label)}${g.auto ? "<small>auto</small>" : ""}</span>
      <span class="g-val"><b>${g.value ?? "—"}</b> / ${g.goal}</span>
      ${g.auto ? "" : `<button class="btn" data-goal="${g.key}" aria-label="Add one to ${esc(g.label)}">+1</button>`}
      <span class="bar"><i style="transform:scaleX(${pct})"></i></span></li>`;
  }).join("");
}

$("goals").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-goal]");
  if (!b) return;
  b.disabled = true;
  try { await api("POST", "/api/counter", { key: b.dataset.goal, delta: 1 }); await load(); }
  finally { b.disabled = false; }
});

/* ---------------- keep the screen on ---------------- */

async function keepAwake() {
  try { await navigator.wakeLock?.request("screen"); } catch {}
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) keepAwake(); });

// Full screen. Installed as an app it opens full-screen by itself. Otherwise the browser
// only allows it on a completed tap ("click"), not on pointerdown, so retry on every tap.
const isFull = () => !!document.fullscreenElement || matchMedia("(display-mode: fullscreen)").matches;
function goFull() {
  if (isFull() || !document.documentElement.requestFullscreen) return;
  document.documentElement.requestFullscreen({ navigationUI: "hide" })
    .then(() => screen.orientation?.lock?.("landscape").catch(() => {}))
    .catch(() => {});
}
function updateFsBtn() { $("fsBtn").hidden = isFull() || !document.documentElement.requestFullscreen; }
document.addEventListener("click", () => { goFull(); keepAwake(); });
document.addEventListener("fullscreenchange", updateFsBtn);
updateFsBtn();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

/* ---------------- start ---------------- */

show(0);
tick();
load();
keepAwake();
setInterval(tick, 1000);
setInterval(load, 60_000);
