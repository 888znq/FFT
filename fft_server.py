#!/usr/bin/env python3
"""
fft_server.py - server-side engine for the FFT live app (single pair at a time).

The server keeps the Deriv tick feed for ONE symbol, builds the same 1-second price grid the page builds
(-1.0 = no tick), runs the exact REV / MOM / dead scan of the browser worker (verified identical), and
serves the result. The page only needs to fetch it, so it opens already running.

Run locally:   python fft_server.py            (http://127.0.0.1:8765, serves index.html or live.html)
Offline test:  python fft_server.py --demo     (simulated ticks)
Render:        start command  python fft_server.py   (PORT is read from the environment)

Endpoints
  GET  /                serves index.html (or live.html) from this folder
  GET  /status          human-readable check page (feed status, scan counts, top signals)
  GET  /api/state       light state: prices (delta via ?from=&epoch=), status, scan meta, config
  GET  /api/scan        full scan result: revs, moms, dead (cached per scan, gzip)
  POST /api/config      change symbol / cycles / session (needs ADMIN_KEY header, or localhost when not hosted)
  GET  /health          "ok"

Environment: PORT, ADMIN_KEY, DERIV_WS (optional websocket url override)
No trading code and no token live in this file.
"""
import sys
import argparse
import asyncio
import hmac
import json
import math
import os
import random
import re
import subprocess
import time
from collections import deque
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

try:
    from aiohttp import web, ClientSession, WSMsgType
except ImportError:
    print("First run: installing aiohttp ...")
    try:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "aiohttp"])
    except Exception:
        sys.exit("Auto-install failed. Run this yourself:  %s -m pip install aiohttp" % sys.executable)
    from aiohttp import web, ClientSession, WSMsgType

HERE = Path(__file__).resolve().parent
IS_HOSTED = bool(os.environ.get("PORT"))
MISSING = -1.0

# ───────────────────────── scanner (exact port of the live.html worker) ─────────────────────────
def _js_round(x):
    return math.floor(x + 0.5)  # JS Math.round (Python round() is banker's rounding)


def apply_cumulative(hist, max_s):
    cum, res = 0, {}
    for i in range(max_s, 0, -1):
        v = hist.get(i)
        if v:
            cum += v
        if cum > 0:
            res[i] = cum
    return res


def compute_gap_map(events):
    cur, peaks = {}, {}
    for L in events:
        for s in range(1, L):
            cur[s] = cur.get(s, 0) + 1
        if cur.get(L, 0) > 0:
            peaks.setdefault(L, []).append(cur[L])
        cur[L] = 0
    mode_run, mode_count, freq_map = {}, {}, {}
    top = max(max(cur, default=0), max(peaks, default=0))
    for s in range(1, top + 1):
        freq = {}
        for v in peaks.get(s, ()):
            if v >= 1:
                freq[v] = freq.get(v, 0) + 1
        live = cur.get(s, 0)
        if live >= 1:
            freq[live] = freq.get(live, 0) + 1
        if not freq:
            continue
        best_len = best_cnt = 0
        for ln, cnt in freq.items():
            if cnt > best_cnt or (cnt == best_cnt and ln > best_len):
                best_cnt, best_len = cnt, ln
        mode_run[s], mode_count[s], freq_map[s] = best_len, best_cnt, freq
    return mode_run, cur, mode_count, freq_map


def scan_cycle_full(prices, base_ts, c, s_start, s_end, pair):
    """One cycle length c. Returns (revs, moms, dead) exactly like the browser worker."""
    s_end = min(s_end, len(prices))
    rc, rs, rcol = [0] * c, [0] * c, [-2] * c
    sh, term, mx = ({}, {}), ({}, {}), ([0] * c, [0] * c)
    surv, dlog = ({}, {}), ({}, {})
    dead = []

    def rec(k, row, s):
        d = sh[k].setdefault(row, {})
        d[s] = d.get(s, 0) + 1
        if s > mx[k][row]:
            mx[k][row] = s
        term[k].setdefault(row, []).append(s)

    for i in range(s_start, s_end):
        p = prices[i]
        pp = prices[i - c] if i >= s_start + c else MISSING
        t = base_ts + i
        col, row = t // c, t % c
        oc, os_ = rc[row], rs[row]
        if pp == MISSING:
            nc, ns = (0, 0) if p == MISSING else (1, 1)
        elif p == MISSING:
            nc, ns = 0, 0
        elif p > pp:
            nc = 1
            ns = os_ + 1 if (rcol[row] == col - 1 and oc == 1 and os_ > 0) else 1
        elif p < pp:
            nc = 2
            ns = os_ + 1 if (rcol[row] == col - 1 and oc == 2 and os_ > 0) else 1
        else:
            nc, ns = oc, 0

        # graveyard / dethroned engine
        if os_ > 0 and (ns <= 1 or nc != oc):
            k = 0 if oc == 1 else 1
            sv = surv[k].setdefault(row, {})
            dl = dlog[k].setdefault(row, set())
            for x in range(1, os_ + 1):
                if x not in dl:
                    sv[x] = sv.get(x, 0) + 1
            if os_ not in dl:
                dead.append({"pair": pair, "c": c, "r": row, "s1": os_, "s2": os_ + 1, "c1": sv[os_], "c2": 1,
                             "col": "G" if k == 0 else "R", "type": "REV", "dethroned": True,
                             "deathIdx": rcol[row] * c + row - base_ts})
                dl.add(os_)

        if ns == 1 and os_ > 0 and oc != 0 and rcol[row] == col - 1:
            rec(0 if oc == 1 else 1, row, os_)
        rc[row], rs[row], rcol[row] = nc, ns, col

    for row in range(c):  # live edge injection
        if rs[row] >= 1 and rc[row] != 0:
            rec(0 if rc[row] == 1 else 1, row, rs[row])

    revs, moms = [], []
    for r in range(c):
        gaps = (compute_gap_map(term[0].get(r, [])), compute_gap_map(term[1].get(r, [])))
        for ci in (0, 1):
            raw, max_s = sh[ci].get(r), mx[ci][r]
            if not raw or max_s == 0:
                continue
            gmode, gcur, gcnt, gfreq = gaps[ci]
            colc = "G" if ci == 0 else "R"
            cum = apply_cumulative(raw, max_s)
            for s in sorted(cum):
                c1, c2 = cum[s], cum.get(s + 1, 0)
                pct_rev = 100 - _js_round(c2 / c1 * 100) if c1 > 0 else 0
                pct_mom = _js_round(c2 / c1 * 100) if c1 > 0 else 0
                revs.append({"pair": pair, "c": c, "r": r, "s1": s, "s2": s + 1, "c1": c1, "c2": c2,
                             "pct": pct_rev, "col": colc, "type": "REV",
                             "gap": gmode.get(s, 0), "curGap": gcur.get(s, 0),
                             "gapCount": gcnt.get(s, 0), "gapFreq": gfreq.get(s, {})})
                if c1 > 1:
                    moms.append({"pair": pair, "c": c, "r": r, "s1": s, "s2": s + 1, "c1": c1, "c2": c2,
                                 "pct": pct_mom, "col": colc, "type": "MOM"})
    dead.sort(key=lambda d: -d["deathIdx"])
    return revs, moms, dead[:100]


def scan_pair(prices, base_ts, min_c, max_c, pair, s_start=0, s_end=None):
    """All cycles min_c..max_c for one pair (what the browser does per pair across its workers)."""
    if s_end is None:
        s_end = len(prices)
    R, M, D = [], [], []
    for c in range(min_c, max_c + 1):
        r, m, d = scan_cycle_full(prices, base_ts, c, s_start, s_end, pair)
        R += r
        M += m
        D += d
    return R, M, D


# ───────────────────────── config / session ─────────────────────────
CFG_FILE = HERE / "fft_config.json"
CFG = {"symbol": "cryBTCUSD", "minC": 60, "maxC": 120, "session": 3600, "winStart": 0, "winEnd": 1440,
       "interval": 10, "minPct": 85, "level": 0, "start": 0, "duration": 3600}
WS_URLS = ["wss://api.derivws.com/trading/v1/options/ws/public",
           "wss://ws.derivws.com/websockets/v3?app_id=1089",
           "wss://ws.binaryws.com/websockets/v3?app_id=1089"]
if os.environ.get("DERIV_WS"):
    WS_URLS = [os.environ["DERIV_WS"]] + WS_URLS
SYMBOL_RE = re.compile(r"^[A-Za-z0-9_]{3,24}$")
S = {"gen": 0, "epoch": 0, "start": 0, "len": 0, "prices": [], "ticks": 0, "last_tick": 0, "status": "starting",
     "error": None, "scan": None, "scan_seq": 0, "demo": False, "loaded_key": None}
LOG = deque(maxlen=120)
POOL = None


def now():
    return int(time.time())


def elog(level, msg):
    LOG.append("%s [%s] %s" % (time.strftime("%H:%M:%S"), level, str(msg)[:300]))
    try:
        print(LOG[-1], flush=True)
    except Exception:
        pass


def clean_cfg(d, base):
    """Validate a config dict; returns a new dict or raises ValueError."""
    c = dict(base)
    def ival(k, lo, hi):
        if k in d:
            try:
                v = int(d[k])
            except (TypeError, ValueError):
                raise ValueError("%s must be a number" % k)
            if not lo <= v <= hi:
                raise ValueError("%s must be %d..%d" % (k, lo, hi))
            c[k] = v
    if "symbol" in d:
        if not SYMBOL_RE.match(str(d["symbol"])):
            raise ValueError("bad symbol")
        c["symbol"] = str(d["symbol"])
    ival("minC", 2, 600)
    ival("maxC", 2, 600)
    ival("session", 60, 86400)
    ival("winStart", 0, 1440)
    ival("winEnd", 1, 1440)
    ival("interval", 1, 3600)
    ival("duration", 60, 86400)
    if "start" in d:
        try:
            v = int(d["start"])
        except (TypeError, ValueError):
            raise ValueError("start must be a number")
        if v != 0 and not 1000000000 <= v <= 4000000000:
            raise ValueError("bad start")
        c["start"] = v  # 0 = server picks the session itself; otherwise the exact session the page asks for
    ival("minPct", 0, 100)
    ival("level", 0, 100)
    if c["minC"] > c["maxC"]:
        c["minC"], c["maxC"] = c["maxC"], c["minC"]
    if c["maxC"] - c["minC"] > 300:
        raise ValueError("at most 300 cycles per scan")
    if c["winEnd"] <= c["winStart"]:
        raise ValueError("winEnd must be after winStart")
    return c


def eff_session(c):
    if c.get("start"):
        return c["duration"]
    win = (c["winEnd"] - c["winStart"]) * 60
    ses = c["session"]
    return ses if win % ses == 0 else win  # same rule as the page: non-dividing length = whole window


def session_start(t=None, c=None):
    """Start (unix s) of the current session. Inside the window this is the session containing now;
    outside it, it clamps to the first/last session of the window (the page's boot behaviour)."""
    c = c or CFG
    if c.get("start"):
        return c["start"]
    t = now() if t is None else t
    day = t - t % 86400
    ws, we, ses = c["winStart"] * 60, c["winEnd"] * 60, eff_session(c)
    n = max(1, (we - ws) // ses)
    idx = min(max((t - day - ws) // ses, 0), n - 1)
    return day + ws + idx * ses


def new_session(st):
    n = eff_session(CFG) + 1  # the page's grid includes the end second: duration + 1 points
    S.update(start=st, len=n, prices=[MISSING] * n, ticks=0, last_tick=0, scan=None)
    S["epoch"] += 1


def put(ts, p):
    i = ts - S["start"]
    if 0 <= i < S["len"]:
        if S["prices"][i] == MISSING:
            S["ticks"] += 1
        S["prices"][i] = float(p)
        S["last_tick"] = max(S["last_tick"], ts)


def setst(msg):
    S["status"] = msg
    elog("ERROR" if msg.startswith("FAILED") else "INFO", msg)


# ───────────────────────── price feed ─────────────────────────
async def backfill(call, gen):
    st = S["start"]
    en = min(st + S["len"] - 1, now())
    sym = CFG["symbol"]
    for s in range(st, en + 1, 901):
        if gen != S["gen"]:
            return
        d = await call({"ticks_history": sym, "start": s, "end": min(s + 900, en), "count": 1000, "style": "ticks"})
        if gen != S["gen"]:
            return
        if "error" in d:
            S["error"] = d["error"].get("message", "history error")
            elog("ERROR", "history chunk failed: %s" % S["error"])
            continue
        h = d.get("history", {})
        for t, p in zip(h.get("times", []), h.get("prices", [])):
            put(t, p)
        await asyncio.sleep(0.15)
    S["error"] = None
    S["epoch"] += 1
    S["loaded_key"] = (gen, st)
    elog("INFO", "history loaded: %s, %d ticks" % (sym, S["ticks"]))
    S["scan_now"].set()


async def deriv_feed():
    n = 0
    while True:
        url = WS_URLS[n % len(WS_URLS)]
        host = url.split("/")[2]
        try:
            setst("connecting to " + host)
            async with ClientSession() as sess:
                ws = await asyncio.wait_for(sess.ws_connect(url, heartbeat=20), 15)
                try:
                    pending, rid = {}, [0]

                    async def call(req):
                        rid[0] += 1
                        req["req_id"] = rid[0]
                        fut = asyncio.get_running_loop().create_future()
                        pending[rid[0]] = fut
                        await ws.send_json(req)
                        return await asyncio.wait_for(fut, 30)

                    async def reader():
                        async for m in ws:
                            if m.type != WSMsgType.TEXT:
                                continue
                            d = json.loads(m.data)
                            f = pending.pop(d.get("req_id"), None)
                            if f and not f.done():
                                f.set_result(d)
                            elif d.get("msg_type") == "tick" and "tick" in d:
                                tk = d["tick"]
                                if tk.get("symbol") == CFG["symbol"]:
                                    put(int(tk["epoch"]), tk["quote"])

                    rt = asyncio.create_task(reader())
                    try:
                        sub_gen, sub_at = -1, now()
                        while not rt.done():
                            if sub_gen != S["gen"] or S["resync"].is_set():
                                S["resync"].clear()
                                sub_gen = S["gen"]
                                sym = CFG["symbol"]
                                setst("loading history %s" % sym)
                                await ws.send_json({"forget_all": "ticks"})
                                await backfill(call, sub_gen)
                                if sub_gen == S["gen"]:
                                    await ws.send_json({"ticks": sym, "subscribe": 1})
                                    sub_at = now()
                                    setst("LIVE %s via %s" % (sym, host))
                                continue
                            # watchdog: a live subscription that goes silent is reconnected (and the next endpoint tried)
                            if S["status"].startswith("LIVE") and now() < S["start"] + S["len"] + 5:
                                limit = 180 if CFG["symbol"].startswith("frx") else 20
                                quiet = now() - max(S["last_tick"], sub_at)
                                if quiet > limit:
                                    n += 1
                                    setst("FAILED stalled: no ticks for %ds - reconnecting" % quiet)
                                    break
                            await asyncio.sleep(1)
                        if not S["status"].startswith("FAILED"):
                            setst("disconnected from " + host)
                    finally:
                        rt.cancel()
                finally:
                    await ws.close()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            setst("FAILED %s: %s %s" % (host, type(e).__name__, str(e)[:120]))
            n += 1
        await asyncio.sleep(3)


async def demo_feed():
    S["status"] = "DEMO (simulated ticks)"
    price, gen = 1.08, -1
    while True:
        if gen != S["gen"] or S["resync"].is_set():
            S["resync"].clear()
            gen = S["gen"]
            for t in range(S["start"], min(now(), S["start"] + S["len"])):
                price += random.choice([-0.0002, -0.0001, 0.0, 0.0001, 0.0002])
                if random.random() > 0.03:
                    put(t, round(price, 5))
            S["epoch"] += 1
            S["loaded_key"] = (gen, S["start"])
            S["scan_now"].set()
        await asyncio.sleep(1)
        price += random.choice([-0.0002, -0.0001, 0.0, 0.0001, 0.0002])
        put(now(), round(price, 5))


async def roller():
    while True:
        await asyncio.sleep(1)
        st = session_start()
        if st != S["start"] or eff_session(CFG) + 1 != S["len"]:
            new_session(st)
            S["resync"].set()
            elog("INFO", "new session started at %s UTC" % time.strftime("%Y-%m-%d %H:%M", time.gmtime(st)))


async def scanner():
    loop = asyncio.get_running_loop()
    last_ms = 0
    while True:
        wait = max(CFG["interval"], 2 * last_ms / 1000.0)
        try:
            await asyncio.wait_for(S["scan_now"].wait(), wait)
        except asyncio.TimeoutError:
            pass
        S["scan_now"].clear()
        if not S["last_tick"]:
            continue
        prices, st, sym, gen = list(S["prices"]), S["start"], CFG["symbol"], S["gen"]
        mn, mx = CFG["minC"], CFG["maxC"]
        t0 = time.time()
        try:
            revs, moms, dead = await loop.run_in_executor(POOL, scan_pair, prices, st, mn, mx, sym)
        except Exception as e:
            elog("ERROR", "scan failed: %s %s" % (type(e).__name__, e))
            continue
        if gen != S["gen"] or st != S["start"]:
            continue
        dead.sort(key=lambda d: -d["deathIdx"])  # newest first, page shows 150
        last_ms = int((time.time() - t0) * 1000)
        S["scan_seq"] += 1
        S["scan"] = {"seq": S["scan_seq"], "at": now(), "ms": last_ms, "symbol": sym, "start": st,
                     "minC": mn, "maxC": mx, "revs": revs, "moms": moms, "dead": dead[:150], "_bytes": None}
        elog("INFO", "SCAN %s cycles %d-%d: %d REV %d MOM %d dead in %dms" % (
            sym, CFG["minC"], CFG["maxC"], len(revs), len(moms), len(dead), last_ms))


# ───────────────────────── http ─────────────────────────
def public_cfg():
    return {k: CFG[k] for k in ("symbol", "minC", "maxC", "session", "winStart", "winEnd", "interval", "minPct", "level", "start", "duration")}


async def api_state(request):
    q = request.query
    try:
        frm, ep = int(q.get("from", 0)), int(q.get("epoch", -1))
    except ValueError:
        frm, ep = 0, -1
    light = bool(q.get("light"))
    p = S["prices"]
    lo = 0 if ep != S["epoch"] else max(0, min(frm, len(p)) - 30)
    sc = S["scan"]
    resp = web.json_response({
        "symbol": CFG["symbol"], "gen": S["gen"], "epoch": S["epoch"], "start": S["start"], "len": S["len"],
        "now": now(), "status": S["status"], "error": S["error"], "ticks": S["ticks"], "lastTick": S["last_tick"],
        "from": lo, "prices": ([] if light else p[lo:]), "cfg": public_cfg(),
        "ready": S["loaded_key"] == (S["gen"], S["start"]),
        "scan": ({"seq": sc["seq"], "at": sc["at"], "ms": sc["ms"], "revN": len(sc["revs"]),
                  "momN": len(sc["moms"]), "symbol": sc["symbol"], "start": sc["start"],
                  "minC": sc["minC"], "maxC": sc["maxC"]} if sc else None)})
    resp.enable_compression()
    return resp


async def api_scan(request):
    if request.query.get("fresh"):
        sc0, seq0 = S["scan"], S["scan_seq"]
        if sc0 is None or now() - sc0["at"] >= 3:
            S["scan_now"].set()
            t0 = time.time()
            while S["scan_seq"] == seq0 and time.time() - t0 < 15:
                await asyncio.sleep(0.1)
    sc = S["scan"]
    if not sc:
        return web.json_response({"seq": 0})
    if sc["_bytes"] is None:
        sc["_bytes"] = json.dumps({"seq": sc["seq"], "symbol": sc["symbol"], "start": sc["start"],
                                   "minC": sc["minC"], "maxC": sc["maxC"], "revs": sc["revs"],
                                   "moms": sc["moms"], "dead": sc["dead"]}, separators=(",", ":")).encode()
    resp = web.Response(body=sc["_bytes"], content_type="application/json")
    resp.enable_compression()
    return resp


def can_admin(request):
    # Security disabled: anyone who can reach the server may change its config.
    return True


async def api_config(request):
    if not can_admin(request):
        return web.json_response({"error": "not allowed (set ADMIN_KEY and send it as X-Admin-Key)"}, status=403)
    try:
        d = await request.json()
        new = clean_cfg(d, CFG)
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    except Exception:
        return web.json_response({"error": "bad json"}, status=400)
    if new.get("start") and "start" in d and all(k in d for k in ("winStart", "winEnd", "session")):
        # The page also sent its window + session length. If those rules give exactly the session the page asked
        # for, do not pin it: the server then rolls to every next session by itself and is already loaded when
        # the page opens (a pinned session would stay frozen on the old hour until someone visits).
        t = dict(new, start=0)
        if session_start(c=t) == new["start"] and eff_session(t) == new["duration"]:
            new = t
    changed = {k for k in new if new[k] != CFG.get(k)}
    same_session = (new["symbol"], session_start(c=new), eff_session(new) + 1) == (CFG["symbol"], S["start"], S["len"])
    CFG.update(new)
    if changed & {"symbol", "session", "winStart", "winEnd", "start", "duration"} and not same_session:
        S["gen"] += 1
        new_session(session_start())
        S["resync"].set()
    if changed & {"minC", "maxC", "minPct", "level", "interval"}:
        S["scan_now"].set()
    try:
        CFG_FILE.write_text(json.dumps(public_cfg(), indent=2))
    except Exception:
        pass
    elog("INFO", "config changed: %s" % ", ".join(sorted(changed)) if changed else "config unchanged")
    return web.json_response({"ok": True, "cfg": public_cfg(), "changed": sorted(changed)})


def _rows(lst, n, pct_key=True):
    rows = []
    for x in lst[:n]:
        rows.append("<tr>%s</tr>" % "".join("<td>%s</td>" % x.get(k, "") for k in
                                            ("c", "r", "col", "s1", "s2", "c1", "c2", "pct", "gap", "curGap")))
    return "".join(rows)


async def status_page(request):
    sc = S["scan"]
    top = lambda l: sorted((x for x in l if x["pct"] >= CFG["minPct"] and (CFG["level"] == 0 or x["s1"] == CFG["level"])),
                           key=lambda x: -(x["pct"] * x["c1"]))
    th = "<tr><th>C</th><th>R</th><th>col</th><th>s1</th><th>s2</th><th>c1</th><th>c2</th><th>pct</th><th>gap</th><th>curGap</th></tr>"
    age = (now() - S["last_tick"]) if S["last_tick"] else -1
    html = ("<html><head><meta charset=utf-8><meta http-equiv=refresh content=5><title>FFT server</title>"
            "<style>body{font:13px monospace;background:#111;color:#ddd;padding:12px}td,th{padding:2px 8px;border:1px solid #333}"
            "h3{color:#6c6}</style></head><body><h3>FFT server status</h3>"
            "<div>symbol <b>%s</b> | status: %s | error: %s</div>"
            "<div>session start %s UTC, length %ds, ticks %d, last tick %ss ago</div>"
            "<div>config: %s</div><div>%s</div>"
            % (CFG["symbol"], S["status"], S["error"],
               time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(S["start"])), S["len"], S["ticks"], age,
               json.dumps(public_cfg()),
               ("scan #%d: %d REV, %d MOM, %d dead, %dms, %ds ago" % (sc["seq"], len(sc["revs"]), len(sc["moms"]), len(sc["dead"]),
                                                                      sc["ms"], now() - sc["at"]) if sc else "no scan yet")))
    if sc:
        html += "<h3>top REV (min%% %d, level %d)</h3><table>%s%s</table>" % (CFG["minPct"], CFG["level"], th, _rows(top(sc["revs"]), 10))
        html += "<h3>top MOM</h3><table>%s%s</table>" % (th, _rows(top(sc["moms"]), 10))
        html += "<h3>newest dead</h3><table>%s%s</table>" % (th, _rows(sc["dead"], 10))
    html += "<h3>log</h3><pre>%s</pre></body></html>" % "\n".join(list(LOG)[-25:])
    return web.Response(text=html, content_type="text/html")


async def index(_):
    for name in ("index.html", "live.html"):
        f = HERE / name
        if f.is_file():
            resp = web.Response(text=f.read_text(encoding="utf-8", errors="replace"), content_type="text/html",
                                headers={"Cache-Control": "no-cache"})
            resp.enable_compression()
            return resp
    return web.Response(text="index.html / live.html not found next to fft_server.py - open /status", status=404)


async def health(_):
    return web.Response(text="ok")


async def guard(factory):
    while True:
        try:
            await factory()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            elog("ERROR", "%s crashed: %s %s - restarting" % (factory.__name__, type(e).__name__, e))
            await asyncio.sleep(2)


async def on_start(app):
    S.update(resync=asyncio.Event(), scan_now=asyncio.Event())
    new_session(session_start())
    feed = demo_feed if S["demo"] else deriv_feed
    app["tasks"] = [asyncio.create_task(guard(f)) for f in (feed, roller, scanner)]


async def on_stop(app):
    for t in app["tasks"]:
        t.cancel()
    await asyncio.gather(*app["tasks"], return_exceptions=True)


def make_app():
    app = web.Application()
    app.add_routes([web.get("/", index), web.get("/health", health), web.get("/status", status_page),
                    web.get("/api/state", api_state), web.get("/api/scan", api_scan),
                    web.post("/api/config", api_config)])
    app.on_startup.append(on_start)
    app.on_cleanup.append(on_stop)
    return app


def main():
    global POOL, CFG
    a = argparse.ArgumentParser()
    a.add_argument("--symbol")
    a.add_argument("--session", type=int)
    a.add_argument("--min-cycle", type=int, dest="minC")
    a.add_argument("--max-cycle", type=int, dest="maxC")
    a.add_argument("--host", default="0.0.0.0" if IS_HOSTED else "127.0.0.1")
    a.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8765)))
    a.add_argument("--demo", action="store_true")
    args = a.parse_args()
    try:
        if CFG_FILE.is_file():
            CFG = clean_cfg(json.loads(CFG_FILE.read_text()), CFG)
    except Exception as e:
        print("fft_config.json ignored:", e)
    over = {k: getattr(args, k) for k in ("symbol", "session", "minC", "maxC") if getattr(args, k) is not None}
    CFG = clean_cfg(over, CFG)
    if CFG.get("start") and CFG["start"] + CFG["duration"] <= now():
        CFG["start"] = 0  # a pinned session that already ended: go back to the self-rolling session
    S["demo"] = bool(args.demo)
    try:
        POOL = ProcessPoolExecutor(max_workers=1)  # scan runs in its own process so ticks/HTTP never stall
    except Exception:
        POOL = None
    elog("INFO", "starting: %s session=%ds cycles %d-%d demo=%s" % (CFG["symbol"], eff_session(CFG), CFG["minC"], CFG["maxC"], S["demo"]))
    web.run_app(make_app(), host=args.host, port=args.port, access_log=None,
                print=lambda *_: print("FFT server: http://%s:%d  (Ctrl+C to stop)" % (args.host, args.port)))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
