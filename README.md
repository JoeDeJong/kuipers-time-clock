# Kuipers Time Clock

A simple, PIN-based employee time clock built to run on a wall-mounted or counter tablet.

- **Employees** tap in their PIN, see whether they're clocked in or out, and press one big **Clock In** / **Clock Out** button.
- **Regular and overtime hours** are calculated automatically (weekly overtime after 40 h by default, with optional daily overtime).
- **Admins** (separate admin PIN) can add, edit and delete punches, clock out someone who forgot, manage employees, run timesheets, export CSV for payroll, and download backups.
- Every clock-in, clock-out and admin change is written to an **audit log**.

## How it works

```
 ┌──────────────┐        Wi-Fi / LAN        ┌──────────────────────────┐
 │   Tablet     │  ───────────────────────▶ │  Shop PC / mini PC       │
 │  (browser,   │   http://<pc-ip>:3000     │  node server/index.js    │
 │  full screen)│                           │  data/timeclock.db       │
 └──────────────┘                           └──────────────────────────┘
```

The server stores everything in one SQLite file (`data/timeclock.db`). The tablet just opens a web page, so any tablet works: iPad, Android or Windows. You can open the admin pages from the tablet or from any computer on the same network.

> You can also run the server *on* the tablet itself (e.g. a Windows tablet), then open `http://localhost:3000`.

## Requirements

- **Node.js 22.13 or newer** (https://nodejs.org, use the LTS installer). There are no other dependencies, so you don't need `npm install`.

## Running it

```bash
npm start
```

On startup it prints the addresses to use:

```
Time clock running.
  Database: .../data/timeclock.db
  Kiosk:    http://localhost:3000/
  Tablet:   http://192.168.1.50:3000/   (admin: http://192.168.1.50:3000/admin)
```

Optional environment variables:

| Variable  | Default               | Purpose                                              |
|-----------|-----------------------|------------------------------------------------------|
| `PORT`    | `3000`                | Port to listen on                                    |
| `HOST`    | `0.0.0.0`             | Address to bind to                                   |
| `DB_PATH` | `data/timeclock.db`   | Where the database file lives                        |
| `TZ`      | system time zone      | Time zone for days and workweeks, e.g. `America/Chicago` |

## First-time setup

1. Start the server and open `http://<pc-ip>:3000/admin`.
2. **Choose an admin PIN** (4 to 8 digits). Don't lose it.
3. Under **Settings**, check:
   - **Company name** (shown on the time clock)
   - **Employee PIN length** (4, 5 or 6; it can only be changed before you add employees)
   - **Overtime rules:** weekly threshold (default 40), daily threshold (default off), and the day your workweek starts
4. Under **Employees**, add each person with a unique PIN. The **Random PIN** button can make one for you.

## Setting up the tablet

1. Connect the tablet to the same network as the server PC.
2. Open `http://<pc-ip>:3000/` in the browser.
3. Add it to the home screen so it opens full screen with no address bar:
   - **iPad (Safari):** Share → *Add to Home Screen*
   - **Android (Chrome):** ⋮ menu → *Add to Home screen* / *Install app*
4. Lock the tablet to the app:
   - **iPad:** Settings → Accessibility → **Guided Access**
   - **Android:** Settings → Security → **App pinning** (or use a kiosk browser such as Fully Kiosk)
5. Keep it plugged in and set the screen to never sleep. The page also asks the browser to keep the screen awake where that's supported.

Tip: give the server PC a **fixed IP address** (a DHCP reservation in your router) so the tablet's bookmark doesn't break.

## Daily use

**Employees:** enter your PIN → check your name → tap **CLOCK IN** or **CLOCK OUT**. The screen shows the time recorded and your regular and overtime hours so far this week, then resets by itself.

**Admin** (`/admin`):

| Tab            | What it's for                                                                 |
|----------------|-------------------------------------------------------------------------------|
| **Who's In**   | Who is clocked in right now, plus each person's hours this week. A **Clock out now** button covers anyone who forgot. |
| **Timesheets** | Regular, overtime and total hours per employee for any date range. Tap a row for the daily breakdown. Export CSV (summary or daily) or print. |
| **Punches**    | View, **edit**, **add** or **delete** individual clock-in/out records. Edited punches are tagged. Overlapping punches are blocked. |
| **Employees**  | Add employees, rename them, reset PINs, deactivate people who leave (their history is kept). |
| **Settings**   | Company name, overtime rules, admin PIN, and **Download backup**.             |
| **Audit Log**  | Every clock-in, clock-out and admin change, with before and after times.      |

## How overtime is calculated

- Hours are split at midnight and assigned to the day they were worked. A night shift from 10 PM to 6 AM counts 2 h on the first day and 6 h on the next.
- **Weekly:** within each workweek, hours beyond the weekly threshold (default 40) are overtime.
- **Daily (optional):** hours beyond the daily threshold in one day are overtime. Those daily-overtime hours don't also count toward the weekly 40, so nothing is counted twice.
- A timesheet that starts mid-week still accounts for hours worked earlier in that workweek, so overtime is always correct.
- Hours are shown in decimal for payroll (7.50 = 7 h 30 m).

Check your state's rules (some have daily overtime or double time). This app handles weekly and daily overtime; it doesn't do double time or seventh-day rules.

## Security notes

- PINs are stored as keyed hashes, never in plain text.
- After 5 wrong PINs in a row, the clock locks for 60 seconds.
- Admin sessions expire after 12 hours.
- The app is meant for a **trusted local network**. Don't expose port 3000 to the internet.

## Backups

Use **Settings → Download backup** regularly (for example, after each payroll run) and keep the file somewhere safe. To restore, stop the server, replace `data/timeclock.db` with the backup file, and start it again.

## Running automatically at startup

- **Windows:** create a shortcut or Task Scheduler task that runs `npm start` in this folder at logon. Alternatively, use a service wrapper such as NSSM.
- **Linux / Raspberry Pi:** create a systemd service with `WorkingDirectory=` set to this folder and `ExecStart=/usr/bin/npm start`.

## Development

```bash
npm test     # overtime calculations + API tests
```

Code layout:

```
server/index.js   HTTP server + API routes
server/db.js      SQLite storage (employees, punches, audit log, settings)
server/hours.js   Regular / overtime calculation
public/           Kiosk page (index.html) and admin page (admin.html)
test/             Tests (node --test)
```
