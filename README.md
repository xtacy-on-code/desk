# Desk: a dashboard that runs on your spare phone

The Galaxy A13 runs a small Python server in Termux and shows the dashboard full-screen in landscape.

- **Today:** clock, date, weather, countdowns, today's classes, and a focus timer that logs your minutes.
- **Grind:** LeetCode solved by difficulty, your streak, active days and rank, an 18-week activity heatmap, today's daily problem (with whether you've solved it), and upcoming LeetCode and Codeforces contests.
- **Hunt:** your internship pipeline (Applied, OA, Interview, Offer, Closed), recent applications, and this week's goals. Goals come from the playbooks: submissions, cold DMs, applications and mock interviews.

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
   pkg update && pkg install python termux-api
   termux-setup-storage
   ```
   Tap **Allow** when it asks for storage access.

## 2. Copy the folder over

Connect the phone to your laptop over USB, choose **File transfer**, and copy this whole `phone-dashboard` folder into the phone's **Download** folder. Then, in Termux:

```
cp -r ~/storage/downloads/phone-dashboard ~/
```

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

## 6. Manage the tracker from your laptop

1. Find the phone's IP address under **Settings → Connections → Wi-Fi**: tap the gear next to your network and look for the IP address (for example `192.168.1.23`).
2. On your laptop, on the same Wi-Fi, open `http://192.168.1.23:8080/edit` and enter the PIN.
3. Add applications and change their stage. The phone picks up changes within a minute.

The +1 buttons for cold DMs and mock interviews are on the phone's Hunt page.

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
| `city` | Weather location (currently `"Bhilai"`). If left empty, the weather line is hidden |
| `timetable` | Weekly classes, as `"mon": [["09:30", "10:30", "Compiler", "LHC 104"], ...]` (start, end, name, room) |
| `ical_feeds` | Classroom or Moodle calendar links for assignment deadlines (see section 7) |
| `events` | Fixed one-off items, with the same fields as the editor. Prefer the editor, which saves to `data/events.json` |
| `countdowns` | `{"label": "End-sem exams", "date": "2026-11-24"}`. Each entry disappears after its date |
| `weekly_goals` | Targets for `dsa` (LeetCode submissions), `dms`, `apps` and `mocks` |
| `rotate_seconds` | How long each page stays up before it auto-rotates |
| `night_start` / `night_end` | The window for the dim clock-only screen |
| `focus_presets` | The focus timer buttons, in minutes |

Edit the file in Termux with `nano ~/phone-dashboard/config.json`, or edit the laptop copy and copy it over again. The server picks up changes without a restart.

## Where your data lives

The `data/` folder holds `tracker.json` (applications), `events.json` (exams and tests), `counters.json` (weekly +1 counts), `focus.json` (focus minutes per day) and `pin.txt`. To back it up, copy the folder somewhere. Delete `pin.txt` to get a new PIN.

## Notes

- The **LeetCode submissions** goal counts submissions since Monday from LeetCode's activity calendar, not unique problems.
- **"Solved today"** on the daily problem is based on LeetCode's reset time (05:30 IST).
- LeetCode's data comes from the same unofficial GraphQL endpoint the LeetCode website uses. If LeetCode changes it, the Grind page shows a "LeetCode failed" status in the top bar until it's fixed.
- To run it on the laptop for testing: run `python server.py`, then open http://localhost:8080.
