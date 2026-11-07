# WALLSPECTRUM LIVE

Active-day Deriv tick collector (39 pairs) with a 30-second live streak scanner.
A small Node.js server collects ticks from Deriv's public WebSocket and serves them to a single-page dashboard in your browser.

---

## 1. Quick start

**Requirements:** [Node.js](https://nodejs.org) 18 or newer, and an internet connection.

| System | How to start |
| --- | --- |
| **Windows** | Double-click `start.bat` |
| **macOS / Linux** | Run `./start.sh` in a terminal (if needed: `chmod +x start.sh` first) |
| **Any system** | `npm install` once, then `npm start` |

The first run installs the one dependency (`ws`). Your browser opens at **http://localhost:3000**.
To stop the server, close the window or press `Ctrl+C`; it shuts down cleanly.

> **Important:** the server must keep running for data to be collected. The dashboard only shows what the server has gathered.

---

## 2. What's in the folder

```text
wallspectrum/
  start.bat          Windows launcher (checks Node, installs, opens browser)
  start.sh           macOS / Linux launcher
  package.json       Project info; depends only on "ws"
  package-lock.json  Pins exact dependency versions
  server.js          Collector + HTTP API + static file server
  public/
    index.html       The dashboard (scanner UI, all in one file)
  patcher.py         Optional local patch tool (AI-assisted edits, with backups)
  start_patcher.bat  Windows launcher for patcher.py
  README.md          This guide
  .gitignore         Keeps node_modules and local backups out of version control
```

---

## 3. How it works

1. **Collect.** On start, the server opens one WebSocket to Deriv and subscribes to all 39 symbols: 4 metals, 25 forex pairs, BTC/ETH, and 8 Volatility (1HZ) indices.
2. **Store.** Each pair has one slot per second for the whole active day. If several ticks land in the same second, the last one wins. All data is held **in memory**.
3. **Serve.** The dashboard polls `/ticks` and `/status` and pulls only the seconds it has not seen yet, sent as a compressed binary array.
4. **Heal.** If the connection drops, the server reconnects (backoff 1s → 30s) and automatically back-fills the missed time from Deriv's tick history.

### The "active day"

The day runs from **05:30 IST to 05:30 IST** (that is 00:00 UTC). At rollover the server clears the day's buffers but keeps the last **15 minutes** of ticks as a pre-roll reference, so streaks near the start of the new day have context. The dashboard detects the rollover and resets itself.

### Back-fill

Back-fill runs at startup and after every reconnect. It looks for holes in each pair's second-by-second data and re-downloads them in 15-minute chunks (6 in parallel).

- Gaps shorter than **15 minutes** (forex and metals) or **2 minutes** (crypto and 1HZ indices) are ignored on a normal start. This is normal for quiet markets.
- Pairs whose market is closed (for example forex on weekends) are skipped quickly.
- While back-filling, the dashboard badge shows `BACKFILLING n%`.

---

## 4. Configuration

All settings are environment variables. None are required.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port the server listens on |
| `API_TOKEN` (or `ACCESS_TOKEN`) | *(empty = no auth)* | If set, `/status` and `/ticks` require this token |

**Windows (Command Prompt):**

```bat
set PORT=8080
set API_TOKEN=my-secret
start.bat
```

**macOS / Linux:**

```bash
PORT=8080 API_TOKEN=my-secret ./start.sh
```

### Using a token

Open the dashboard once with the token in the URL:

```text
http://localhost:3000/?token=my-secret
```

The page remembers it in your browser (localStorage) and attaches it to every request. The API also accepts an `x-api-token` header or `Authorization: Bearer <token>`.

> The token protects the **data endpoints**. The page itself (`/`) and `/ping` are always public. If you expose the server to the internet, treat the token as a light gate, not strong security, and serve it over HTTPS.

---

## 5. HTTP endpoints

| Endpoint | Auth | Returns |
| --- | --- | --- |
| `GET /` | no | The dashboard (`public/index.html`) |
| `GET /ping` | no | Plain `ok` (handy for uptime monitors) |
| `GET /status` | yes* | JSON: uptime, feed state (`LIVE` / `BACKFILLING` / `RECONNECTING`), subscribed pair count, back-fill progress, last tick time per pair, and the last 100 events |
| `GET /ticks?pair=frxEURUSD&from=0&pre=1&day=<epoch>` | yes* | Gzipped binary `Float64Array` of prices for the day. `-1` marks a second with no tick |

\* Only when `API_TOKEN` is set.

`/ticks` parameters: `pair` (required, must be one of the 39), `from` (second index to start from, default 0), `pre=1` (prepend the 900-second pre-roll; only honoured when `from=0`), and `day` (the client's day epoch; if it differs from the server's, the server restarts from 0). Response headers `X-Day-Epoch`, `X-From-Index`, `X-To-Index` and `X-Pre-Length` describe the slice.

Quick health check:

```bash
curl http://localhost:3000/ping
curl http://localhost:3000/status
```

---

## 6. Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| `start.bat` says Node.js was not found | Install Node 18+ from nodejs.org, reopen the window, run again |
| Browser says "can't connect" right away | The server needs a few seconds. Refresh after 3–5 seconds |
| `EADDRINUSE` / port already in use | Another program uses port 3000. Set a different `PORT` (see section 4) |
| Badge shows `RECONNECTING` | Server can't reach Deriv or the server is down. Check your internet and firewall; the server retries by itself. Details are in the console and in `/status` → `recentEvents` |
| Badge shows `BACKFILLING` for a long time | Normal after a fresh start mid-day (hundreds of chunks across 39 pairs). It finishes by itself |
| Some forex pairs are empty | Forex and metals are closed on weekends. They resume when the market reopens (the server rechecks every 5 minutes) |
| `401 Unauthorized` | `API_TOKEN` is set. Open the page once with `?token=...` |
| Fonts look different offline | Fonts load from Google Fonts. The page still works with fallback fonts |
| Data disappeared after a restart | By design, see "Known limitations" below |

---

## 7. Known limitations

- **Memory only.** Ticks live in RAM. Restarting the server clears them; on the next start the server back-fills the day from Deriv's history. The `store` object in `server.js` is a stub where persistent storage (such as Firebase RTDB) can be added later.
- **One day at a time.** Only the current active day plus a 15-minute pre-roll is kept.
- **One-second resolution.** Several ticks in the same second collapse to the last one.
- **Memory use.** The tick buffers are about 27 MB (39 pairs × 86,400 s × 8 bytes). The whole process measured about 90 MB, well inside Render's 512 MB free tier.
- **Public Deriv endpoint.** Connects to `wss://api.derivws.com/trading/v1/options/ws/public?app_id=1089`. If Deriv changes this URL or app ID, update `WS_URL` at the top of `server.js`.

---

## 8. Deploy on Render (free web service)

Render deploys from a Git repository, so put this folder on GitHub (or GitLab) first.

### 8.1 Push the code

```bash
cd wallspectrum
git init
git add .
git commit -m "WALLSPECTRUM LIVE"
# create an empty repo on GitHub, then:
git remote add origin https://github.com/<you>/wallspectrum.git
git branch -M main
git push -u origin main
```

`node_modules/` is excluded by `.gitignore`. Render installs it itself.

### 8.2 Create the service

1. In the Render dashboard choose **New → Web Service** and connect the repository.
2. Fill in:

| Field | Value |
| --- | --- |
| Language / Runtime | Node |
| Branch | `main` |
| **Build Command** | `npm install` |
| **Start Command** | `node server.js` |
| Instance Type | Free (512 MB) |

3. Under **Environment Variables** add:

| Key | Value |
| --- | --- |
| `API_TOKEN` | a long random string of your choice (see 8.4) |

   Do **not** set `PORT`; Render provides it and `server.js` reads it automatically.
4. Click **Create Web Service**. When the deploy is live you get a URL like `https://wallspectrum-xxxx.onrender.com`.
5. Check it: open `https://<your-app>.onrender.com/ping`. It should show `ok`.

### 8.3 Keep it awake with cron-job.org

Free Render services go to sleep after about 15 minutes without incoming traffic, which would stop tick collection. A ping every 5 minutes prevents that.

1. Create a free account at [cron-job.org](https://cron-job.org) and click **Create cronjob**.
2. **URL:** `https://<your-app>.onrender.com/ping`
3. **Schedule:** every **5 minutes**.
4. Save and enable it. Use the job's history to confirm each run returns HTTP 200.

`/ping` is intentionally open (no token), so cron-job.org needs no extra setup.

### 8.4 Open the dashboard with your token

```text
https://<your-app>.onrender.com/?token=<your API_TOKEN>
```

Open it once per browser. The page remembers the token and sends it with every data request. Anyone without the token gets `401` from `/status` and `/ticks`.

### 8.5 After a restart or redeploy

Memory is the only store, so a restart starts empty. The server reconnects, then back-fills the active day from Deriv's history. A restart late in the day means more to download (roughly 100 requests per pair for a full day), so the badge may show `BACKFILLING` for several minutes; the scanner works on whatever has arrived so far.

---

## 9. Test checklist

Use `/status` (or the dashboard badge) to watch each step. Add `?token=...` if a token is set.

### A. Fresh start
- [ ] Console shows `START` then `HTTP_READY` then `DERIV_OPEN`.
- [ ] `/status` → `wsConnected: true`, `subscribedCount: 39` (forex pairs may stay lower on weekends).
- [ ] `lastTickTime` fills in for crypto and the 1HZ indices within seconds.
- [ ] Badge shows `BACKFILLING n%`, then `LIVE`.
- [ ] `backfillSeq` is `1` or higher after the first backfill.

### B. Restart recovery
- [ ] Let it run 10+ minutes, then stop it (Ctrl+C). Console shows `SIGTERM`/`SIGINT received`.
- [ ] Start it again. It back-fills the day; `BACKFILL_PAIR` lines list each missing range.
- [ ] The dashboard shows no flat hole for the downtime once backfill reaches `100%`.
- [ ] On Render: **Manual Deploy → Restart** gives the same result.

### C. Reconnect
- [ ] Turn off your internet (or Wi-Fi) for about a minute.
- [ ] Console: `DERIV_CLOSED` then `RECONNECTING` with growing delays (1s, 2s, 4s … max 30s). Badge: `RECONNECTING`.
- [ ] Turn the internet on. Expect `DERIV_OPEN`, then `BACKFILL_START (reconnect-recovery)`, then `BACKFILL_COMPLETE`.
- [ ] The missed minute is filled in on the dashboard.

### D. Rollover (05:30 IST)
- [ ] Keep it running past 05:30 IST (00:00 UTC).
- [ ] Console: `ROLLOVER ... (kept 900s pre-roll)`; `/status` → `activeDayEpoch` increases by 86400.
- [ ] Dashboard resets to the fresh, empty day and keeps scanning (pairs need a few minutes of new ticks before results appear).
- [ ] A browser tab left open overnight picks up the new day without a refresh.

### E. Security and keep-alive
- [ ] `/status` without a token → `401`; with `?token=` → JSON.
- [ ] `/ping` → `ok` without a token.
- [ ] cron-job.org history shows HTTP 200 every 5 minutes, and the Render service does not sleep.
