"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const inr = new Intl.NumberFormat("en-IN");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

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

function mins(m) {
  if (!m) return "0m";
  const h = Math.floor(m / 60);
  return h ? `${h}h ${pad(m % 60)}m` : `${m}m`;
}

/* ---------------- fit the 800x360 stage to the screen ---------------- */

let scale = 1;
function fit() {
  const w = innerWidth, h = innerHeight;
  scale = Math.min(w / 800, h / 360);
  const x = (w - 800 * scale) / 2, y = (h - 360 * scale) / 2;
  $("stage").style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
}
fit();
addEventListener("resize", fit);
screen.orientation?.addEventListener?.("change", () => setTimeout(fit, 200));

/* ---------------- pages ---------------- */

const pages = [...document.querySelectorAll(".page")];
const tabs = [...document.querySelectorAll(".tab")];

// Pages whose tab is hidden (Exams outside exam season) are skipped by swipes and auto-rotate.
const visible = () => pages.map((_, i) => i).filter((i) => !tabs[i].hidden);
function step(from, dir) {
  const v = visible(), k = v.indexOf(from);
  return v[(k === -1 ? 0 : k + dir + v.length) % v.length];
}

function show(i, dir = 1) {
  const next = tabs[i] && !tabs[i].hidden ? i : step(i, 1);
  if (next !== page) {
    // Enter from the side you're heading to, leave towards the other: swipes feel spatial.
    const inc = pages[next], out = pages[page];
    inc.style.transition = "none";
    inc.style.transform = `translateX(${12 * dir}px)`;
    void inc.offsetWidth;
    inc.style.transition = "";
    inc.style.transform = "";
    out.style.transform = `translateX(${-12 * dir}px)`;
  }
  page = next;
  pages.forEach((p, n) => p.classList.toggle("is-active", n === page));
  tabs.forEach((t, n) => n === page ? t.setAttribute("aria-current", "page") : t.removeAttribute("aria-current"));
  $("topClock").hidden = page === 0;
  moveTabInd();
  renderDots();
}

function renderDots() {
  $("dots").innerHTML = visible().map((i) => `<i class="${i === page ? "on" : ""}"></i>`).join("");
}

function moveTabInd() {
  const t = tabs[page], ind = $("tabInd");
  ind.style.transform = `translateX(${t.offsetLeft - 4}px)`;
}
addEventListener("resize", moveTabInd);

tabs.forEach((t) => t.addEventListener("click", () => { lastTouch = Date.now(); show(+t.dataset.page, Math.sign(+t.dataset.page - page) || 1); }));

// Swipe between pages
let downX = null;
$("pages").addEventListener("pointerdown", (e) => { downX = e.clientX; });
$("pages").addEventListener("pointerup", (e) => {
  if (downX === null) return;
  const dx = e.clientX - downX;
  downX = null;
  if (Math.abs(dx) > 50) { lastTouch = Date.now(); show(step(page, dx < 0 ? 1 : -1), dx < 0 ? 1 : -1); }
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
  $("date").textContent = `${DAYS[now.getDay()]} · ${pad(now.getDate())} ${MONTHS[now.getMonth()]}`;

  const night = inNight(now) && Date.now() - nightWake > 60_000 && !focus.running();
  $("night").hidden = !night;
  document.body.classList.toggle("is-night", night);
  if (night) $("nightClock").textContent = hm(now);

  renderFocus();
  renderContestAlert();
  if (state) renderTimers();
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
    show(step(page, 1));
  }
}, 1000);

// Shift the whole layout a few pixels every 5 minutes so nothing burns into the screen.
setInterval(() => {
  const r = () => Math.round(Math.random() * 6 - 3);
  $("app").style.transform = `translate(${r()}px, ${r()}px)`;
  $("nightClock").style.transform = `translate(${r() * 6}px, ${r() * 4}px)`;
}, 5 * 60_000);

/* ---------------- focus mode ---------------- */

// A running session lives in localStorage so it survives a reload:
// {kind: "focus" | "break", minutes, endAt, pausedLeft?, hidden?}
const focus = {
  get: () => { try { return JSON.parse(localStorage.getItem("focus") || "null"); } catch { return null; } },
  set: (v) => { try { v ? localStorage.setItem("focus", JSON.stringify(v)) : localStorage.removeItem("focus"); } catch {} },
  running() { const f = this.get(); return !!(f && !f.pausedLeft); },
};
let focusDone = null;   // {kind, minutes}: what the full screen shows after a session ends
let audio = null;       // created on a tap, since browsers only allow sound after one

const leftMs = (f) => f.pausedLeft ?? f.endAt - Date.now();

function chime() {
  try {
    const t = audio.currentTime;
    [0, 0.25, 0.5].forEach((d, i) => {
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = i === 2 ? 1046 : 784;
      g.gain.setValueAtTime(0.0001, t + d);
      g.gain.exponentialRampToValueAtTime(0.3, t + d + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.22);
      o.connect(g).connect(audio.destination);
      o.start(t + d); o.stop(t + d + 0.25);
    });
  } catch {}
}

function startFocus(minutes, kind = "focus") {
  try { audio = audio || new AudioContext(); audio.resume(); } catch {}
  focusDone = null;
  focus.set({ kind, minutes, endAt: Date.now() + minutes * 60_000 });
  renderFocus(true);
}

function pauseFocus() {
  const f = focus.get();
  if (!f) return;
  if (f.pausedLeft) { f.endAt = Date.now() + f.pausedLeft; delete f.pausedLeft; }
  else f.pausedLeft = f.endAt - Date.now();
  focus.set(f); renderFocus(true);
}

function addFive() {
  const f = focus.get();
  if (!f) return;
  f.minutes += 5;
  if (f.pausedLeft) f.pausedLeft += 300_000; else f.endAt += 300_000;
  focus.set(f); renderFocus(true);
}

function setHidden(hidden) {
  const f = focus.get();
  if (!f) return;
  f.hidden = hidden; focus.set(f); renderFocus(true);
}

// Stopping early still counts the minutes you actually did, if it was at least 5.
async function stopFocus() {
  const f = focus.get();
  focus.set(null);
  renderFocus(true);
  if (f && f.kind !== "break") {
    const done = Math.floor((f.minutes * 60_000 - Math.max(0, leftMs(f))) / 60_000);
    if (done >= 5) { try { await api("POST", "/api/focus", { minutes: done }); } catch {} load(); }
  }
}

async function finishFocus(f) {
  focus.set(null);
  focusDone = { kind: f.kind || "focus", minutes: f.minutes };
  try { navigator.vibrate?.([200, 100, 200, 100, 400]); } catch {}
  chime();
  renderFocus(true);
  if (focusDone.kind !== "break") { try { await api("POST", "/api/focus", { minutes: f.minutes }); } catch {} load(); }
}

const smallClock = (s) => `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
function bigClock(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = pad(s % 60);
  return `${h ? `${h}:${pad(m)}` : pad(m)}<span>:${sec}</span>`;
}

let lastFocusKey = "";
function renderFocus(force) {
  const f = focus.get();
  const presets = state?.focus?.presets || [25, 50];
  const C = 175.93;
  let left = presets[0] * 60_000, total = left;
  if (f) {
    total = f.minutes * 60_000;
    left = leftMs(f);
    if (left <= 0) { finishFocus(f); return; }
  }
  const s = Math.ceil(left / 1000);
  $("focusTime").textContent = smallClock(s);
  $("ringFg").style.strokeDashoffset = f ? String(C * (left / total)) : String(C);

  const full = (f && !f.hidden) || !!focusDone;
  $("fscreen").hidden = !full;
  if (f && full) {
    $("fsTime").innerHTML = bigClock(s);
    $("fsBar").style.transform = `scaleX(${1 - left / total})`;
    $("fsEnds").textContent = f.pausedLeft ? "Paused" : `Ends at ${hm(new Date(f.endAt))}`;
    $("fsMeta").textContent = f.kind === "break"
      ? "Stand up, drink some water, look at something far away"
      : `${f.minutes} min session · focus today ${mins(state?.focus?.today || 0)}`;
  }

  const key = (f ? `${f.kind}:${f.pausedLeft ? "p" : "r"}:${f.hidden ? "h" : "v"}` : focusDone ? `done:${focusDone.kind}` : "idle") + presets.join(",");
  if (key === lastFocusKey && !force) return;
  lastFocusKey = key;

  $("focusActions").innerHTML = f
    ? `<button class="btn ink" data-act="open">Full screen</button><button class="btn" data-act="stop">Stop</button>`
    : presets.map((m) => `<button class="btn" data-start="${m}">${m} min</button>`).join("");

  if (f) {
    $("fsTag").textContent = f.kind === "break" ? "Break" : "Focus";
    $("fsTag").classList.toggle("safe", f.kind === "break");
    $("fsHide").hidden = false;
    $("fsActions").innerHTML = `<button class="btn ink" data-act="pause">${f.pausedLeft ? "Resume" : "Pause"}</button>
      <button class="btn" data-act="plus">+5 min</button><button class="btn" data-act="stop">Stop</button>`;
  } else if (focusDone) {
    const brk = focusDone.kind === "break";
    $("fsTag").textContent = brk ? "Break over" : "Done";
    $("fsTag").classList.toggle("safe", !brk);
    $("fsHide").hidden = true;
    $("fsTime").innerHTML = brk ? "Back to it" : `+${focusDone.minutes} min`;
    $("fsBar").style.transform = "scaleX(1)";
    $("fsEnds").textContent = "";
    $("fsMeta").textContent = brk ? "Pick your next session" : `Logged · focus today ${mins(state?.focus?.today || 0)}`;
    $("fsActions").innerHTML = brk
      ? presets.map((m) => `<button class="btn ink" data-start="${m}">${m} min</button>`).join("") + `<button class="btn" data-act="close">Close</button>`
      : `<button class="btn ink" data-break="5">5 min break</button><button class="btn" data-start="${focusDone.minutes}">Another ${focusDone.minutes}</button><button class="btn" data-act="close">Close</button>`;
  }
}

function onFocusClick(e) {
  const b = e.target.closest("button");
  if (!b) return;
  lastTouch = Date.now();
  if (b.dataset.start) startFocus(+b.dataset.start);
  else if (b.dataset.break) startFocus(+b.dataset.break, "break");
  else ({ pause: pauseFocus, stop: stopFocus, plus: addFive, open: () => setHidden(false),
          close: () => { focusDone = null; renderFocus(true); } })[b.dataset.act]?.();
}
$("focusActions").addEventListener("click", onFocusClick);
$("fsActions").addEventListener("click", onFocusClick);
$("fsHide").addEventListener("click", () => setHidden(true));

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
  renderPlan();
  renderArena();
  renderExamsPage();
  renderGoals();
  runTicks();
  celebrate();
  maybeRecap();
  if (location.hash === "#recap" && !render.recapOpened) { render.recapOpened = true; showRecap(); }
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
    ? `<b>${w.temp}°</b> ${esc(w.text)} · feels ${w.feels}° · ${w.hi}°/${w.lo}° · rain ${w.rain}%`
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
  if (sch.mode === "exams") return renderExams(sch, nowMin);
  $("schedule").classList.remove("exams");
  $("schedLabel").textContent = sch.isToday ? "Schedule" : `Schedule · ${sch.label}`;
  $("schedule").innerHTML = sch.items.length ? sch.items.map((s) => {
    const st = toMin(s.start), en = s.end ? toMin(s.end) : st + 60;
    const cls = !sch.isToday ? "" : s.start && nowMin >= st && nowMin < en ? "now" : s.start && nowMin >= en ? "past" : "";
    const kind = s.kind ? `<span class="kind kind-${esc(s.kind.replace(/\s/g, ""))}">${esc(s.kind)}</span>` : "";
    return `<li class="${cls}"><span class="t num">${esc(s.start || "—")}</span>
            <span class="main">${kind}${esc(s.title)}</span><span class="side">${esc(s.where)}</span></li>`;
  }).join("") : `<li class="empty">Nothing scheduled this week. Add classes to <code>"timetable"</code> in config.json.</li>`;

  const f = state.focus;
  $("focusTotal").textContent = `Focus ${mins(f.today)} today · ${mins(f.week)} this week`;
}

// Exam week: no classes, the Schedule panel lists every remaining exam with its day and countdown.
function renderExams(sch, nowMin) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  $("schedLabel").textContent = sch.label;
  $("schedule").classList.add("exams");
  $("schedule").innerHTML = sch.items.map((x) => {
    const d = new Date(x.date + "T00:00");
    const days = Math.round((d - today) / 864e5);
    const day = days === 0 ? "Today" : days === 1 ? "Tmrw" : `${DAYS[d.getDay()].slice(0, 3)} ${d.getDate()}`;
    const done = days === 0 && x.start && nowMin >= toMin(x.start) + 180;
    const soon = days === 0 && !done;
    const kind = x.kind && x.kind !== "Exam" ? `<span class="kind kind-${esc(x.kind.replace(/\s/g, ""))}">${esc(x.kind)}</span>` : "";
    return `<li class="${done ? "past" : soon ? "now" : ""}"><span class="t">${day}</span>
      <span class="main">${kind}${esc(x.title)}</span>
      <span class="side">${[esc(x.start || ""), days > 1 ? `in ${days}d` : ""].filter(Boolean).join(" · ")}</span></li>`;
  }).join("");
  const f = state.focus;
  $("focusTotal").textContent = `Focus ${mins(f.today)} today · ${mins(f.week)} this week`;
}

/* ---------------- helpers ---------------- */

// n pill pips with `filled` of them lit (for countable steps).
function pips(filled, n = 10) {
  const f = Math.max(0, Math.min(n, Math.round(filled)));
  return Array.from({ length: n }, (_, i) => `<i class="${i < f ? "on" : ""}"></i>`).join("");
}

function hms(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${pad(h % 24)}h`;
  return `${pad(h)}:${pad(m)}:${pad(s % 60)}`;
}

/* ---------------- grind ---------------- */

function renderGrind() {
  const g = state.grind || {}, lc = state.leetcode;
  if (g.streak === undefined) {
    $("lcStreak").textContent = "--";
    $("streakTimer").textContent = "LeetCode loading";
  } else {
    tickTo($("lcStreak"), g.streak);

    const p = g.potd;
    $("potd").innerHTML = p ? `
      <h2>POTD chain <span class="val disp">${p.streak}${p.atLeast ? "+" : ""} <small>${p.streak === 1 ? "day" : "days"}</small></span></h2>
      <div class="pips" aria-label="POTD solved in the last 14 days">${p.last14.map((d, i) =>
        `<i class="${d ? "on" : d === null ? "unk" : ""}${i === 13 && !d ? " today" : ""}"></i>`).join("")}</div>
      <div class="sub">${p.doneToday ? `<b>Today's done</b> · the chain grows tomorrow` : `Solve today's POTD to make it ${p.streak + 1}`}</div>`
      : `<h2>POTD chain</h2><div class="sub">Starts counting once your solves load.</div>`;

    const s = g.solved, parts = [["Easy", "easy"], ["Medium", "medium"], ["Hard", "hard"]];
    $("solved").innerHTML = `
      <h2>Solved <span class="val disp"><span class="tick" data-key="solved" data-to="${s.All}">${s.All}</span> <small>/ ${inr.format(g.totalQuestions)}</small></span></h2>
      <div class="split">${parts.map(([k, c]) => `<i class="${c}" style="flex:${s[k] || 0.01}"></i>`).join("")}</div>
      <div class="s-row">
        <div class="legend">${parts.map(([k, c]) => `<span class="${c}">${k} <b>${s[k]}</b></span>`).join("")}</div>
        ${weekBars(g.last7 || [])}
      </div>`;
  }

  if (lc) {
    const dl = lc.daily, potd = state.progress.goals.find((x) => x.metric === "lc_potd");
    const q = $("daily");
    q.classList.toggle("cleared", dl.done);
    q.innerHTML = `<h2>Daily quest${potd ? ` <span class="more">+${potd.xp} XP</span>` : ""}</h2>
      <div class="q-title">${esc(dl.title)}</div>
      <div class="q-foot"><span class="${dl.difficulty.toLowerCase()}">${esc(dl.difficulty)}</span>
        <span class="muted">${dl.done ? "Cleared" : "Not cleared"}</span>
        <a class="btn primary" href="${esc(dl.url)}" target="_blank" rel="noopener">${dl.done ? "Open" : "Solve"}</a></div>`;
  }

  const t = g.lcNext;
  $("lcTarget").innerHTML = t ? `
    <h2>Next target <span class="val disp">${t.value} <small>/ ${t.to}</small></span></h2>
    <div class="pips">${pips(t.value - t.from, t.to - t.from)}</div>
    <div class="sub"><b>${t.to - t.value}</b> ${t.to - t.value === 1 ? "solve" : "solves"} to unlock <b>+${xpFor("LeetCode")} XP</b></div>`
    : `<h2>Next target</h2><div class="sub">Shows up once LeetCode loads.</div>`;
  renderTimers();
}

// Last 7 LeetCode days as little gold bars; today is outlined until you submit.
function weekBars(days) {
  if (!days.length) return "";
  const max = Math.max(1, ...days.map((d) => d.n)), total = days.reduce((a, d) => a + d.n, 0);
  return `<div class="week">
    <div class="w-head"><span>Last 7 days</span><span>${total}</span></div>
    <div class="w-bars" aria-label="Submissions over the last 7 days">${days.map((d, i) =>
      `<i class="${d.n ? "" : "zero"}${i === days.length - 1 ? " today" : ""}" style="height:${d.n ? Math.max(12, (d.n / max) * 100) : 12}%" title="${d.date}: ${d.n}"></i>`).join("")}</div>
  </div>`;
}

function xpFor(track) {
  return state.progress.milestones.find((m) => m.track === track)?.xp ?? 0;
}

// Runs every second from tick(): streak countdown and next-contest countdown.
function renderTimers() {
  const g = state?.grind;
  if (!g) return;
  const now = Date.now() / 1000;
  const ex = state.exams?.[0];
  if (ex && $("examIn")) $("examIn").textContent = examWhen(ex);
  if (g.dayEnds) {
    const left = g.dayEnds - now;
    const risky = !g.safeToday;
    const tag = $("riskTag");
    tag.hidden = false;
    tag.textContent = risky ? "At risk" : "Safe today";
    tag.classList.toggle("safe", !risky);
    $("streakTimer").textContent = risky ? `breaks in ${hms(left)}` : `next day in ${hms(left)}`;
    $("streakTimer").classList.toggle("danger", risky);
  }
  const cs = (state.contests || []).filter((x) => x.start + x.duration > now).slice(0, 2);
  $("raid").innerHTML = cs.length
    ? `<h2>Next contests</h2>${cs.map((c) => `
       <div class="r-row"><span class="r-site disp">${c.site === "LeetCode" ? "LC" : "CF"}</span>
       <span class="r-name">${esc(c.name)}</span>
       <span class="r-time disp">${c.start <= now ? "LIVE" : hms(c.start - now)}</span></div>`).join("")}`
    : `<h2>Next contests</h2><div class="sub">Nothing in the next week.</div>`;
}

/* ---------------- quests ---------------- */

const PERIOD_TAG = { day: "Day", week: "Week", month: "Month" };

function renderGoals() {
  const g = state.progress;
  tickTo($("lvl"), g.level);
  $("lvlTitle").textContent = g.title;
  $("xpFill").style.transform = `scaleX(${g.into / g.need})`;
  $("lvlXp").textContent = `${g.into} / ${g.need} XP to level ${g.level + 1}`;
  $("streak").textContent = g.streak;
  $("bestPerfect").textContent = g.bestStreak;
  tickTo($("xpTotal"), g.xp);

  const got = g.badges.filter((b) => b.got).length;
  $("badgeCount").textContent = `${got}/${g.badges.length}`;
  const sorted = [...g.badges].sort((a, b) => b.got - a.got);
  const SHOW = 7;
  $("badges").innerHTML = sorted.slice(0, SHOW).map((b) => `<span class="${b.got ? "got" : ""}">${esc(b.name)}</span>`).join("")
    + (sorted.length > SHOW ? `<span class="more-b">+${sorted.length - SHOW} more</span>` : "");

  const order = { day: 0, week: 1, month: 2 };
  const goals = [...g.goals].sort((a, b) => order[a.period] - order[b.period]);
  $("goalsMore").textContent = `${goals.filter((x) => x.met).length}/${goals.length} cleared`;
  $("goals").innerHTML = goals.length ? goals.map((x) => {
    const v = Math.min(x.value ?? 0, x.target), manual = x.metric === "manual";
    const progress = x.target <= 10
      ? `<span class="pips">${pips(v, x.target)}</span>`
      : `<span class="bar"><i style="transform:scaleX(${v / x.target})"></i></span>`;
    return `<li class="${x.met ? "met" : ""}${manual ? "" : " auto"}">
      <span class="q-label"><span class="q-tag">${PERIOD_TAG[x.period]}</span>${esc(x.label)}<span class="q-xp">+${x.xp} XP${manual ? "" : " · auto"}</span></span>
      ${progress}
      <span class="q-val"><b>${x.value ?? "-"}</b> / ${x.target}</span>
      ${manual ? `<span class="q-btns"><button class="btn ghost" data-goal="${esc(x.id)}" data-delta="-1" aria-label="Take one off ${esc(x.label)}">−</button><button class="btn ink" data-goal="${esc(x.id)}" data-delta="1" aria-label="Add one to ${esc(x.label)}">+1</button></span>` : ""}
    </li>`;
  }).join("") : `<li class="empty">No quests yet. Add some from the editor on your laptop (/edit).</li>`;
}

$("goals").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-goal]");
  if (!b) return;
  b.disabled = true;
  if (+b.dataset.delta > 0) pop(b);
  try { await api("POST", "/api/counter", { id: b.dataset.goal, delta: +b.dataset.delta }); await load(); }
  catch {} finally { b.disabled = false; }
});

/* ---------------- plan: top 3 + mess ---------------- */

function renderPlan() {
  const t = state.tasks || [];
  $("tasksMore").textContent = t.length ? `${t.filter((x) => x.done).length}/${t.length} done` : "";
  $("tasks").innerHTML = t.length ? t.map((x, i) => `
    <li class="${x.done ? "done" : ""}"><button class="check" data-task="${i}" aria-label="${x.done ? "Untick" : "Tick"} ${esc(x.text)}">${x.done ? "&#10003;" : ""}</button>
      <span class="task-text">${esc(x.text)}</span></li>`).join("")
    : `<li class="empty">No tasks for today yet. Add your top 3 from the editor on your laptop (/edit).</li>`;

  const m = state.mess;
  const day = DAYS[new Date().getDay()];
  const t12 = (hhmm) => { const [h, mm] = hhmm.split(":").map(Number); return `${h % 12 || 12}${mm ? ":" + pad(mm) : ""}`; };
  $("mess").innerHTML = m ? `<h2>Mess · ${esc(m.day)}${m.tomorrow ? " (tomorrow)" : ""}</h2><ul class="meals">${m.meals.map((x) => `
      <li class="${x.name === m.next ? "next" : ""}"><span class="meal">${x.name}${x.name === m.next ? ` <span class="tag mini">Next</span>` : ""}
        ${x.time ? `<small>${x.time.split("-").map(t12).join("–")}</small>` : ""}</span>
      <span class="items">${esc(x.items)}</span></li>`).join("")}</ul>`
    : `<h2>Mess · ${day}</h2><p class="empty">No menu yet. Add the weekly menu in the editor (/edit).</p>`;
}

$("tasks").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-task]");
  if (!b) return;
  lastTouch = Date.now();
  if (!b.closest("li").classList.contains("done")) pop(b);
  try { await api("POST", "/api/tasks/toggle", { index: +b.dataset.task }); await load(); } catch {}
});

/* ---------------- arena: pet, boss, rating ---------------- */

// The desk pet grows with your level and reacts to the streak and the time of day.
function petSvg(level, mood) {
  const stage = level >= 10 ? 4 : level >= 7 ? 3 : level >= 4 ? 2 : level >= 2 ? 1 : 0;
  const ink = "#16130f", red = "#e23b2e", card = "#fffdf8";
  if (stage === 0) {
    return `<svg viewBox="0 0 120 120" class="pet-svg"><ellipse cx="60" cy="66" rx="30" ry="38" fill="${card}" stroke="${ink}" stroke-width="4"/>
      <path d="M38 62 l8 -6 l8 7 l8 -7 l8 7 l8 -6 l6 5" fill="none" stroke="${ink}" stroke-width="3" stroke-linejoin="round"/>
      <circle cx="50" cy="80" r="3.5" fill="${ink}"/><circle cx="70" cy="80" r="3.5" fill="${ink}"/></svg>`;
  }
  const r = 26 + stage * 3, cy = 72;
  const eyes = mood === "sleepy"
    ? `<path d="M${60 - 13} ${cy - 4} q5 4 10 0 M${60 + 3} ${cy - 4} q5 4 10 0" fill="none" stroke="${ink}" stroke-width="3" stroke-linecap="round"/>`
    : `<circle cx="${60 - 9}" cy="${cy - 5}" r="4.5" fill="${ink}"/><circle cx="${60 + 9}" cy="${cy - 5}" r="4.5" fill="${ink}"/>`;
  const mouth = mood === "worried" ? `<path d="M52 ${cy + 12} q8 -6 16 0" fill="none" stroke="${ink}" stroke-width="3" stroke-linecap="round"/>`
    : mood === "sleepy" ? `<ellipse cx="60" cy="${cy + 11}" rx="4" ry="3" fill="${ink}"/>`
    : `<path d="M50 ${cy + 7} q10 10 20 0" fill="none" stroke="${ink}" stroke-width="3" stroke-linecap="round"/>`;
  const cape = stage >= 3 ? `<path d="M${60 - r + 4} ${cy - 6} L${60 - r - 10} ${cy + r + 6} L${60 + r + 10} ${cy + r + 6} L${60 + r - 4} ${cy - 6} Z" fill="${red}" stroke="${ink}" stroke-width="3" stroke-linejoin="round"/>` : "";
  const arms = stage >= 2 ? `<path d="M${60 - r + 2} ${cy + 4} l-12 8 M${60 + r - 2} ${cy + 4} l12 -10" stroke="${ink}" stroke-width="4" stroke-linecap="round"/>` : "";
  const crown = stage >= 4 ? `<path d="M44 ${cy - r - 2} l4 -14 l8 9 l4 -12 l4 12 l8 -9 l4 14 Z" fill="${ink}"/><circle cx="60" cy="${cy - r - 12}" r="3" fill="${red}"/>` : "";
  const sweat = mood === "worried" ? `<path d="M${60 + r - 2} ${cy - r + 6} q6 10 0 14 q-6 -4 0 -14 Z" fill="#9fd3ff" stroke="${ink}" stroke-width="2"/>` : "";
  const zzz = mood === "sleepy" ? `<text x="${60 + r - 6}" y="${cy - r + 4}" font-family="Bangers" font-size="18" fill="${ink}">z z</text>` : "";
  return `<svg viewBox="0 0 120 120" class="pet-svg">${cape}${arms}
    <ellipse cx="60" cy="${cy}" rx="${r}" ry="${r - 3}" fill="${card}" stroke="${ink}" stroke-width="4"/>
    <ellipse cx="${60 - 17}" cy="${cy + 6}" rx="5" ry="3" fill="${red}" opacity="0.35"/><ellipse cx="${60 + 17}" cy="${cy + 6}" rx="5" ry="3" fill="${red}" opacity="0.35"/>
    ${eyes}${mouth}${crown}${sweat}${zzz}</svg>`;
}

function renderArena() {
  const g = state.progress, gr = state.grind || {};
  const hour = new Date().getHours();
  const risky = gr.dayEnds && !gr.safeToday && hour >= 18;
  const mood = inNight(new Date()) ? "sleepy" : risky ? "worried" : "happy";
  const stageName = ["Egg", "Hatchling", "Kid", "Hero", "Legend"][g.level >= 10 ? 4 : g.level >= 7 ? 3 : g.level >= 4 ? 2 : g.level >= 2 ? 1 : 0];
  const next = g.level < 2 ? 2 : g.level < 4 ? 4 : g.level < 7 ? 7 : g.level < 10 ? 10 : null;
  const line = mood === "worried" ? "Worried about your streak. Solve one?"
    : mood === "sleepy" ? "Sleeping. Tap the screen to wake"
    : gr.streak ? `Happy. ${gr.streak} days fed` : "Happy";
  $("pet").innerHTML = `${petSvg(g.level, mood)}
    <div class="pet-body"><div class="pet-name disp">${esc(state.pet?.name || "Bit")}</div>
      <div class="pet-stage">${stageName} · level ${g.level}</div>
      <div class="sub">${line}</div>
      <div class="sub">${next ? `Evolves at level ${next}` : "Fully evolved"}</div></div>`;

  // Codeforces rating as a small inked line, last point in red.
  const cs = (state.codeforces?.contests || []).slice(-20);
  if (cs.length >= 2) {
    const vals = cs.map((c) => c.new), lo = Math.min(...vals), hi = Math.max(...vals);
    const W = 320, H = 72, span = hi - lo || 1;
    const pts = vals.map((v, i) => [(i / (vals.length - 1)) * W, H - 6 - ((v - lo) / span) * (H - 12)]);
    const last = pts[pts.length - 1], d = cs[cs.length - 1].new - cs[cs.length - 1].old;
    $("rating").innerHTML = `<h2>Codeforces rating <span class="val disp">${vals[vals.length - 1]}</span></h2>
      <svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Rating over the last ${cs.length} contests">
        <line x1="0" y1="${H - 6}" x2="${W}" y2="${H - 6}" class="grid"/><line x1="0" y1="6" x2="${W}" y2="6" class="grid"/>
        <polyline points="${pts.map((p) => p.join(",")).join(" ")}" class="line"/>
        <circle cx="${last[0]}" cy="${last[1]}" r="5" class="dot"/></svg>
      <div class="sub">${lo} to ${hi} over ${cs.length} contests · last round ${d >= 0 ? "+" : ""}${d}</div>`;
  } else {
    $("rating").innerHTML = `<h2>Codeforces rating</h2><p class="empty">The graph shows up after two rated contests.</p>`;
  }

  // Weekly boss: HP is the XP you need to earn this week.
  const b = g.boss;
  if (b) {
    const left = b.hp - b.dealt, pct = left / b.hp;
    $("boss").innerHTML = `<span class="tag">${b.defeated ? "Defeated" : "Week boss"}</span>
      <h2>Weekly boss</h2>
      <div class="boss-row">${bossSvg(b.defeated)}
        <div><div class="boss-name disp">${esc(b.name)}</div>
          <div class="sub">${b.defeated ? "Beaten this week. +100 XP" : `${left} HP left`} · ends in ${hms(b.endsAt - Date.now() / 1000)}</div></div></div>
      <div class="hp"><i style="transform:scaleX(${pct})"></i></div>
      <div class="hp-nums"><span><span class="tick" data-key="dealt" data-to="${b.dealt}">${b.dealt}</span> damage dealt</span><span>${b.hp} HP</span></div>
      <ul class="dmg"><li>Clear a daily quest<b>10</b></li><li>Clear a weekly quest<b>50</b></li><li>Hit a next target<b>20+</b></li><li>Perfect day<b>20</b></li></ul>`;
  }
}

function bossSvg(defeated) {
  const ink = "#16130f", red = "#e23b2e";
  const eyes = defeated
    ? `<path d="M40 44 l10 10 M50 44 l-10 10 M70 44 l10 10 M80 44 l-10 10" stroke="${ink}" stroke-width="4" stroke-linecap="round"/>`
    : `<path d="M36 40 l16 6 M84 40 l-16 6" stroke="${ink}" stroke-width="4" stroke-linecap="round"/><circle cx="46" cy="52" r="5" fill="${ink}"/><circle cx="74" cy="52" r="5" fill="${ink}"/>`;
  const mouth = defeated ? `<path d="M48 76 q12 -8 24 0" fill="none" stroke="${ink}" stroke-width="4" stroke-linecap="round"/>`
    : `<path d="M44 70 h32 l-4 8 h-24 Z" fill="${ink}"/><path d="M50 70 v4 M58 70 v4 M66 70 v4" stroke="#fff" stroke-width="2"/>`;
  return `<svg viewBox="0 0 120 100" class="boss-svg"><path d="M30 26 l-10 -16 l22 10 M90 26 l10 -16 l-22 10" fill="${red}" stroke="${ink}" stroke-width="3" stroke-linejoin="round"/>
    <rect x="22" y="22" width="76" height="70" rx="20" fill="${defeated ? "#e8e1d3" : red}" stroke="${ink}" stroke-width="4"/>${eyes}${mouth}</svg>`;
}

/* ---------------- exams page ---------------- */

function examWhen(e) {
  const at = new Date(`${e.date}T${e.time || "09:00"}`);
  const s = (at - Date.now()) / 1000;
  return s <= 0 ? "Today" : hms(s);
}

function renderExamsPage() {
  const ex = state.exams || [];
  const tab = tabs[5];
  const was = tab.hidden;
  tab.hidden = !ex.length;
  if (was !== tab.hidden) { if (tab.hidden && page === 5) show(0); else renderDots(); }
  // Opened with /#exams before the tab existed: jump there once the exams have loaded.
  if (!tab.hidden && location.hash === "#exams" && !renderExamsPage.jumped) { renderExamsPage.jumped = true; show(5); }
  if (!ex.length) return;
  const e = ex[0];
  const pct = e.total ? Math.round((e.done / e.total) * 100) : 0;
  const d = new Date(e.date + "T00:00");
  const shown = e.topics.slice(0, 5);
  $("examHero").innerHTML = `<span class="tag">Next exam</span>
    <h2>${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}${e.time ? ` · ${esc(e.time)}` : ""}${e.kind !== "Exam" ? ` · ${esc(e.kind)}` : ""}</h2>
    <div class="exam-top"><span class="exam-subj disp">${esc(e.title)}</span><span class="exam-in disp" id="examIn">${examWhen(e)}</span></div>
    <div class="hp ink"><i style="transform:scaleX(${e.total ? e.done / e.total : 0})"></i></div>
    <div class="hp-nums"><span>Syllabus ${e.done}/${e.total} topics</span><span>${pct}%</span></div>
    <ul class="topics">${shown.length ? shown.map((t, i) => `<li class="${t.done ? "done" : ""}"><button class="check" data-topic="${i}" data-subject="${esc(e.subject)}" aria-label="${t.done ? "Untick" : "Tick"} ${esc(t.topic)}">${t.done ? "&#10003;" : ""}</button><span>${esc(t.topic)}</span></li>`).join("")
      : `<li class="empty">No topics yet. Add the syllabus in the editor (/edit).</li>`}${e.topics.length > 5 ? `<li class="more-t">+${e.topics.length - 5} more topics</li>` : ""}</ul>`;
  $("examList").innerHTML = `<h2>All exams <span class="more">${ex.length}</span></h2><ul class="rows exam-rows">${ex.map((x) => {
      const xd = new Date(x.date + "T00:00"), p = x.total ? x.done / x.total : 0;
      return `<li><span class="t">${DAYS[xd.getDay()].slice(0, 3)} ${xd.getDate()}</span><span class="main">${esc(x.title)}${x.kind !== "Exam" ? ` <span class="kind kind-${esc(x.kind.replace(/\s/g, ""))}">${esc(x.kind)}</span>` : ""}</span>
        <span class="side"><span class="mini-bar"><i style="transform:scaleX(${p})"></i></span>${x.total ? Math.round(p * 100) + "%" : "no topics"}</span></li>`;
    }).join("")}</ul>`;
}

$("examHero").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-topic]");
  if (!b) return;
  lastTouch = Date.now();
  if (!b.closest("li").classList.contains("done")) pop(b);
  try { await api("POST", "/api/syllabus/toggle", { subject: b.dataset.subject, index: +b.dataset.topic }); await load(); } catch {}
});

/* ---------------- comic moments ---------------- */

// A word pops out of whatever you just tapped.
const POPS = ["Ka-ching", "Pow", "Bam", "Boom", "Zap", "Yes"];
function pop(el) {
  const r = el.getBoundingClientRect(), st = $("stage").getBoundingClientRect(), w = document.createElement("span");
  w.className = "pop disp";
  w.textContent = POPS[Math.floor(Math.random() * POPS.length)];
  w.style.left = `${(r.left + r.width / 2 - st.left) / scale}px`;
  w.style.top = `${(r.top - st.top) / scale}px`;
  $("stage").appendChild(w);
  w.addEventListener("animationend", () => w.remove());
  try { navigator.vibrate?.(30); } catch {}
}

// Numbers roll up to their new value instead of jumping.
const tickPrev = {};
function tickTo(el, to) {
  const from = el.dataset.v === undefined ? to : +el.dataset.v;
  el.dataset.v = to;
  animateNum(el, from, to);
}
function runTicks() {
  document.querySelectorAll(".tick[data-key]").forEach((el) => {
    const key = el.dataset.key, to = +el.dataset.to;
    const from = tickPrev[key] ?? to;
    tickPrev[key] = to;
    animateNum(el, from, to);
  });
}
function animateNum(el, from, to) {
  if (from === to || matchMedia("(prefers-reduced-motion: reduce)").matches) { el.textContent = inr.format(to); return; }
  const t0 = performance.now(), dur = 600;
  const stepFn = (t) => {
    const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    el.textContent = inr.format(Math.round(from + (to - from) * e));
    if (k < 1) requestAnimationFrame(stepFn);
  };
  requestAnimationFrame(stepFn);
}

// Big comic splash for the rare moments: level up, boss down, perfect day, Sunday recap.
function splash(word, title, sub, recap) {
  const spikes = 18, pts = [];
  for (let i = 0; i < spikes * 2; i++) {
    const a = (Math.PI * i) / spikes, r = i % 2 ? 0.62 : 1;
    pts.push(`${50 + Math.cos(a) * 48 * r},${50 + Math.sin(a) * 48 * r}`);
  }
  $("burst").innerHTML = `<svg viewBox="0 0 100 100"><polygon points="${pts.join(" ")}" fill="#e23b2e" stroke="#16130f" stroke-width="2" stroke-linejoin="round"/></svg>`;
  $("splashWord").textContent = word;
  $("splashTitle").textContent = title;
  $("splashSub").textContent = sub || "";
  $("recap").hidden = !recap;
  $("recap").innerHTML = recap || "";
  $("splash").hidden = false;
  try { navigator.vibrate?.([80, 60, 160]); } catch {}
}
$("splashClose").addEventListener("click", () => { $("splash").hidden = true; lastTouch = Date.now(); });

// Sunday from 20:00 the week recap opens once by itself; tapping Total XP on Quests opens it any time.
function maybeRecap() {
  const r = state.progress.recap;
  if (!r || !r.isSunday || new Date().getHours() < 20 || store.get("recapSeen") === r.week) return;
  store.set("recapSeen", r.week);
  showRecap();
}

function showRecap() {
  const r = state?.progress?.recap, b = state?.progress?.boss;
  if (!r) return;
  $("rcRange").textContent = `Week ${r.week.slice(-2)} · ${r.range}${r.isSunday ? "" : " · so far"}`;
  $("rcSubs").textContent = r.subs ?? "-";
  $("rcSubsSub").textContent = r.activeDays != null ? `submissions · active ${r.activeDays} of 7 days` : "submissions";
  const days = r.subsByDay || [], max = Math.max(1, ...days);
  $("rcBars").innerHTML = days.map((n, i) => `<div><i class="${n ? "" : "zero"}" style="height:${n ? Math.max(8, (n / max) * 100) : 6}%"></i><span>${"MTWTFSS"[i]}</span></div>`).join("");
  $("rcFocus").textContent = mins(r.focus);
  $("rcXp").textContent = inr.format(r.xp);
  $("rcQuests").textContent = r.quests;
  $("rcPerfect").textContent = `${r.perfectDays}/7`;
  $("rcBoss").innerHTML = b ? `${bossSvg(b.defeated)}<div><b>${esc(b.name)}</b>
      <span class="sub">${b.defeated ? "Defeated this week, +100 XP" : `Survived with ${b.hp - b.dealt} of ${b.hp} HP`}</span></div>` : "";
  $("rcNext").textContent = r.nextBoss ? `Next week's boss: ${r.nextBoss}` : "";
  $("recapScreen").hidden = false;
}
$("rcClose").addEventListener("click", () => { $("recapScreen").hidden = true; lastTouch = Date.now(); });
document.querySelector(".perfect div:last-child").addEventListener("click", () => { lastTouch = Date.now(); showRecap(); });

/* ---------------- XP toasts ---------------- */

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const toastQueue = [];
let toastBusy = false;

// Called after each load: any XP award newer than the last one we showed gets a toast.
function celebrate() {
  const g = state.progress;
  const lastTs = store.get("xpSeenTs");
  const lastLevel = store.get("xpSeenLevel");
  const newest = g.recent[0]?.ts || 0;
  if (lastTs === null) {  // first run on this device: don't replay history
    store.set("xpSeenTs", newest); store.set("xpSeenLevel", g.level);
    return;
  }
  const fresh = g.recent.filter((a) => a.ts > lastTs).reverse();
  fresh.forEach((a) => toastQueue.push({ big: `+${a.xp} XP`, text: a.label }));
  const bossWin = fresh.find((a) => a.key.startsWith("boss:"));
  const perfect = fresh.find((a) => a.key.startsWith("perfect:day:"));
  if (lastLevel !== null && g.level > lastLevel) splash("Level up", `Level ${g.level}`, g.title);
  else if (bossWin) splash("Defeated", bossWin.label.replace(/^Beat /, ""), `+${bossWin.xp} XP, boss down`);
  else if (perfect) splash("Perfect day", "All quests cleared", `+${perfect.xp} XP bonus`);
  if (newest > lastTs) store.set("xpSeenTs", newest);
  store.set("xpSeenLevel", g.level);
  if (fresh.length) try { navigator.vibrate?.(60); } catch {}
  nextToast();
}

function nextToast() {
  if (toastBusy || !toastQueue.length) return;
  toastBusy = true;
  const t = toastQueue.shift(), el = $("toast");
  el.innerHTML = `<b class="num">${esc(t.big)}</b><span>${esc(t.text)}</span>`;
  el.classList.toggle("level", !!t.level);
  el.classList.add("show");
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => { toastBusy = false; nextToast(); }, 200);
  }, t.level ? 5000 : 3200);
}

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

// Open a page directly with /#today, /#grind or /#quests (handy for bookmarks and screenshots).
show(Math.max(0, ["#today", "#plan", "#grind", "#arena", "#quests", "#exams"].indexOf(location.hash)));
tick();
load();
keepAwake();
setInterval(tick, 1000);
setInterval(load, 60_000);
