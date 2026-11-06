# Desk: a dashboard that runs on your spare phone

The Galaxy A13 runs a small Python server in Termux and shows the dashboard full-screen in landscape.

- **Today:** clock, date, weather, countdowns, a focus timer that logs your minutes, and your class schedule. Once today's last class ends, the schedule switches to the next day that has classes.
- **Grind:** your LeetCode streak with a live countdown to when it breaks (05:30 IST), your POTD chain (days in a row you solved the problem of the day, with the last 14 days as pips), problems solved split into Easy, Medium and Hard, the daily problem as a quest, tiny next targets (the next 10 LeetCode solves, the next 25 Codeforces rating), today's submissions against yesterday's, and a countdown to the next contest.
- **Quests:** daily, weekly and monthly goals that earn XP. XP fills levels, perfect days build a streak, and badges unlock along the way. Quests sit on the right, with your level, perfect-day streak and badges on the left. A toast in the top bar shows each XP gain.

**Extras:**
- **Auto-rotate:** pages change every 30 s, and swiping changes them by hand.
- **Contest alert:** shows in the top bar 90 minutes before a contest starts.
- **Night mode:** from 00:30 to 07:00 the screen shows only a dim clock. Tap it to wake the dashboard for a minute.
- **Burn-in protection:** the layout shifts a few pixels every 5 minutes.
- **Battery and heat:** a battery and temperature readout, which turns red at 42°C or above.

There are no API keys and no installs beyond Python, which comes from the Python standard library and Termux.

---

## 1. Install the apps on the phone (once)

1. Install **F-Droid** from f-droid.org. **Don't use the Play Store version of Termux**, because it's outdated and broken.
2. From F-Droid, install:
   - **Termux**
   - **Termux:API**, for the battery readout
   - **Termux:Boot** (optional), to start the dashboard automatically after a reboot
3. Open Termux and run:
   ```
   pkg update && pkg install python termux-api git
   termux-setup-storage
   ```
   Tap **Allow** when it asks for storage access.

## 2. Get the code

In Termux:

```
git clone https://github.com/xtacy-on-code/desk.git ~/phone-dashboard
```

That's the whole dashboard. Your own settings and data go in `~/phone-dashboard/data/`, which git never touches (see "Updating" below).

## 3. Start it

```
cd ~/phone-dashboard
termux-wake-lock
python server.py
```

It prints the dashboard address and a **6-digit PIN**. You'll need the PIN on your laptop.

## 4. Make it a full-screen app

1. Open **Chrome** on the phone and go to `http://localhost:8080`.
2. Open the menu, choose **Add to home screen**, then **Install**.
3. Open **Desk** from the home screen. It opens full-screen in landscape.

## 5. Keep it alive

- **Settings → About phone → Software information:** tap **Build number** 7 times to unlock Developer options.
- **Settings → Developer options → Stay awake:** on. This keeps the screen on while the phone is charging.
- **Settings → Apps → Termux → Battery:** set to **Unrestricted** so Android doesn't kill the server.
- **Settings → Battery → More battery settings → Protect battery:** on. This caps charging at 85%, which is better for a phone that stays plugged in all the time.

## 6. Edit goals from your laptop

1. Find the phone's IP address under **Settings → Connections → Wi-Fi**: tap the gear next to your network and look for the IP address (for example `192.168.1.23`).
2. On your laptop, on the same Wi-Fi, open `http://192.168.1.23:8080/edit` and enter the PIN.
3. Under **Goals**, add, change or remove goals, then press **Save goals**. The phone picks up changes within a minute.

Each goal resets daily, weekly or monthly and is tracked one of these ways:

| Tracked by | Counts |
|---|---|
| Me (+1 on phone) | Taps on the phone's Quests page (− undoes one) |
| LeetCode POTD | 1 once you've solved today's daily problem |
| LeetCode problems | Different problems accepted today (weekly/monthly goals count submissions instead) |
| Codeforces contests | Rated Codeforces contests in the period |
| Focus minutes | Minutes logged with the focus timer |

**XP:** a daily goal is worth 10 XP, weekly 50, monthly 120. Hitting every daily goal adds a 20 XP *perfect day* bonus (this is what the streak counts), and every weekly goal adds 60. Every 10 LeetCode problems solved is worth 20 XP, and every 25 Codeforces rating (your best rating) 40 XP. Steps you'd already passed before goals were turned on count with no XP. Undoing a +1 also takes back the XP for the current day, week or month.

## 7. Exams, tests and assignment deadlines

All of these show up under **Coming up** on the Today page. Anything happening today also appears in **Schedule**.

**Exams, tests, quizzes, lab exams, vivas, OAs:** use any of these three ways.
1. **Tell Claude in chat**, for example "OS mid-sem on 12 Nov at 10:00 in LHC". Claude adds it straight to the phone over Wi-Fi. This needs the laptop and phone on the same network, plus the phone's IP and PIN (see "Updating from chat" below).
2. **Add it yourself** in the editor at `http://<phone-ip>:8080/edit`, under *Add an exam, test or deadline*.
3. **On the phone itself**, open `http://localhost:8080/edit` in Chrome. No PIN is needed there.

**Assignment deadlines, automatically:** the dashboard reads the private calendar link from Google Classroom or Moodle.
- **Google Classroom:** go to calendar.google.com, then **Settings**, then click your class calendar under *Settings for my calendars* (each class has its own). Under **Integrate calendar**, copy **Secret address in iCal format**.
- **Moodle:** open **Calendar**, then **Export calendar**, choose *All events* and *Recent and next 60 days*, click **Get calendar URL**, and copy it.

Paste each link into `config.json` **on the phone**:
```json
"ical_feeds": [
  { "name": "Classroom", "url": "https://calendar.google.com/calendar/ical/.../basic.ics" }
]
```
Deadlines for the next 3 weeks appear as **DUE** and refresh every 30 minutes.

> **Treat that link like a password.** Anyone who has it can read that calendar, so paste it into the config file yourself and don't share it in chat. If it ever leaks, use the *Reset* button next to it in Google Calendar.

### Updating from chat

Claude runs on your laptop, so it can only reach the phone if both are on the **same Wi-Fi network**. Campus Wi-Fi often blocks devices from talking to each other. If that happens, turn on your laptop's **Mobile hotspot** (Windows Settings, then Network, then Mobile hotspot) and connect the phone to it.

When you want Claude to add something, give it the phone's IP address and the PIN printed in Termux. Claude then sends the item to `/api/events` on the phone.

## 8. Start automatically after a reboot (optional, needs Termux:Boot)

In Termux:
```
mkdir -p ~/.termux/boot
printf '#!/data/data/com.termux/files/usr/bin/sh\ntermux-wake-lock\ncd ~/phone-dashboard && python server.py\n' > ~/.termux/boot/start-desk
chmod +x ~/.termux/boot/start-desk
```
Open the Termux:Boot app once so Android allows it to run at startup.

---

## Settings (`config.json`)

| Key | What it does |
|---|---|
| `leetcode_username` | Your LeetCode username (currently `xtacy`) |
| `codeforces_handle` | Your Codeforces handle (currently `VedantZ`), for rating, rank and contest goals |
| `city` | Weather location (currently `"Bhilai"`). If left empty, the weather line is hidden |
| `timetable` | Weekly classes, as `"mon": [["09:30", "10:30", "Compiler", "LHC 104"], ...]` (start, end, name, room) |
| `ical_feeds` | Classroom or Moodle calendar links for assignment deadlines (see section 7) |
| `events` | Fixed one-off items, with the same fields as the editor. Prefer the editor, which saves to `data/events.json` |
| `countdowns` | `{"label": "End-sem exams", "date": "2026-11-24"}`. Each entry disappears after its date |
| `rotate_seconds` | How long each page stays up before it auto-rotates |
| `night_start` / `night_end` | The window for the dim clock-only screen |
| `focus_presets` | The focus timer buttons, in minutes |

`config.json` holds the defaults and comes from GitHub. **Put your own changes in `data/config.json` instead**: any key there overrides the same key in `config.json`, and updates never touch it. For example, to add Classroom links, in Termux run `nano ~/phone-dashboard/data/config.json` and write:

```
{
  "ical_feeds": [{"name": "Classroom", "url": "https://calendar.google.com/calendar/ical/.../basic.ics"}]
}
```

The server picks up changes without a restart.

## Updating

On the phone, in Termux: stop the server with **Ctrl+C**, then run

```
cd ~/phone-dashboard && sh update.sh
```

It pulls the latest version from GitHub and starts the server again. Your `data/` folder (PIN, exams, XP, quests, `data/config.json`) is never touched. If the update fails for any reason (no internet, say), nothing changes and the version you already have starts.

### Moving an older phone install over (once)

If the phone still has a folder that was copied over USB, swap it for the git version without losing anything:

```
mv ~/phone-dashboard ~/phone-dashboard-old
git clone https://github.com/xtacy-on-code/desk.git ~/phone-dashboard
cp -r ~/phone-dashboard-old/data ~/phone-dashboard/
cp ~/phone-dashboard-old/config.json ~/phone-dashboard/data/config.json
```

The last line turns your old settings (timetable, calendar links) into your personal `data/config.json`. Once everything works, you can delete the old copy with `rm -rf ~/phone-dashboard-old`.

## Where your data lives

The `data/` folder holds `events.json` (exams and tests), `goals.json` (your goals), `counters.json` (+1 counts), `xp.json` (XP, streak and milestones), `potd.json` (which days you solved the POTD), `focus.json` (focus minutes per day), `config.json` (your own settings, if any) and `pin.txt`. To back it up, copy the folder somewhere. Delete `pin.txt` to get a new PIN.

## Notes

- The **POTD chain** shows `8+` at first: LeetCode's public data only covers your last 20 accepted submissions (about a week), so the server starts its own log from there. Days before that show as hollow pips.
- The look is "Royal loot": purple and gold with soft glass panels, in the **Bungee** (numbers and labels) and **Rubik** (text) fonts. Both are bundled in `static/fonts/` under the SIL Open Font License (see the `OFL-*.txt` files), so it works offline.
- **"Solved today"** on the daily problem is based on LeetCode's reset time (05:30 IST).
- LeetCode's data comes from the same unofficial GraphQL endpoint the LeetCode website uses. If LeetCode changes it, the Grind page shows a "LeetCode failed" status in the top bar until it's fixed.
- To run it on the laptop for testing: run `python server.py`, then open http://localhost:8080.
