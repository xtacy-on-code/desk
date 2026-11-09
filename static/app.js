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

/* ---------------- pages ---------------- */

const pages = [...document.querySelectorAll(".page")];
const tabs = [...document.querySelectorAll(".tab")];

function show(i, dir = 1) {
  const next = (i + pages.length) % pages.length;
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
  if (Math.abs(dx) > 50) { lastTouch = Date.now(); show(page + (dx < 0 ? 1 : -1), dx < 0 ? 1 : -1); }
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
  renderGoals();
  celebrate();
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
  const up = state.upcoming.slice(0, 4);
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

/* ---------------- helpers ---------------- */

// n pill pips with `filled` of them lit (for countable steps).
function pips(filled, n = 10) {
  const f = Math.max(0, Math.min(n, Math.round(filled)));
  return Array.from({ length: n }, (_, i) => `<i class="${i < f ? "on" : ""}"></i>`).join("");
}

function hms(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h >= 24 ? until(s) : `${pad(h)}:${pad(m)}:${pad(s % 60)}`;
}

/* ---------------- grind ---------------- */

function renderGrind() {
  const g = state.grind || {}, lc = state.leetcode;
  if (g.streak === undefined) {
    $("lcStreak").textContent = "--";
    $("streakTimer").textContent = "LeetCode loading";
  } else {
    $("lcStreak").textContent = g.streak;

    const p = g.potd;
    $("potd").innerHTML = p ? `
      <h2>POTD chain <span class="val disp">${p.streak}${p.atLeast ? "+" : ""} <small>${p.streak === 1 ? "day" : "days"}</small></span></h2>
      <div class="pips" aria-label="POTD solved in the last 14 days">${p.last14.map((d, i) =>
        `<i class="${d ? "on" : d === null ? "unk" : ""}${i === 13 && !d ? " today" : ""}"></i>`).join("")}</div>
      <div class="sub">${p.doneToday ? `<b>Today's done</b> · the chain grows tomorrow` : `Solve today's POTD to make it ${p.streak + 1}`}</div>`
      : `<h2>POTD chain</h2><div class="sub">Starts counting once your solves load.</div>`;

    const s = g.solved, parts = [["Easy", "easy"], ["Medium", "medium"], ["Hard", "hard"]];
    $("solved").innerHTML = `
      <h2>Solved <span class="val disp">${s.All} <small>/ ${inr.format(g.totalQuestions)}</small></span></h2>
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
        <a class="btn gold" href="${esc(dl.url)}" target="_blank" rel="noopener">${dl.done ? "Open" : "Solve"}</a></div>`;
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
  if (g.dayEnds) {
    const left = g.dayEnds - now;
    const risky = !g.safeToday;
    $("streakState").textContent = risky ? "Streak · at risk" : "Streak · safe today";
    $("streakState").classList.toggle("danger", risky && left < 6 * 3600);
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
  $("lvl").textContent = g.level;
  $("lvlTitle").textContent = g.title;
  $("xpFill").style.transform = `scaleX(${g.into / g.need})`;
  $("lvlXp").textContent = `${g.into} / ${g.need} XP to level ${g.level + 1}`;
  $("streak").textContent = g.streak;
  $("bestPerfect").textContent = g.bestStreak;
  $("xpTotal").textContent = inr.format(g.xp);

  const got = g.badges.filter((b) => b.got).length;
  $("badgeCount").textContent = `${got}/${g.badges.length}`;
  $("badges").innerHTML = g.badges.map((b) => `<span class="${b.got ? "got" : ""}">${esc(b.name)}</span>`).join("");

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
      ${manual ? `<span class="q-btns"><button class="btn ghost" data-goal="${esc(x.id)}" data-delta="-1" aria-label="Take one off ${esc(x.label)}">−</button><button class="btn gold" data-goal="${esc(x.id)}" data-delta="1" aria-label="Add one to ${esc(x.label)}">+1</button></span>` : ""}
    </li>`;
  }).join("") : `<li class="empty">No quests yet. Add some from the editor on your laptop (/edit).</li>`;
}

$("goals").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-goal]");
  if (!b) return;
  b.disabled = true;
  try { await api("POST", "/api/counter", { id: b.dataset.goal, delta: +b.dataset.delta }); await load(); }
  catch {} finally { b.disabled = false; }
});

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
  if (lastLevel !== null && g.level > lastLevel) toastQueue.push({ big: `Level ${g.level}`, text: g.title, level: true });
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
show(Math.max(0, ["#today", "#grind", "#quests"].indexOf(location.hash)));
tick();
load();
keepAwake();
setInterval(tick, 1000);
setInterval(load, 60_000);
