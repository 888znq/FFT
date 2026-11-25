"use strict";
// WallSpectrum All-in-One Server: 1s tick ingestion, backfill, server-side C60 scanner, Deriv auto-trader, and thin-client hosting.
const fs = require("fs");
const path = require("path");
const http = require("http");
try { require("./devpatch").attach(http); } catch (e) { console.error("[DEVPATCH] not loaded: " + e.message); }
const zlib = require("zlib");
const WebSocket = require("ws");
const { createSettings } = require("./settings");
const { createScanner } = require("./scanner");
const { createTrader } = require("./trader");

const PORT = Number(process.env.PORT) || 3000;
const WS_URL = "wss://api.derivws.com/trading/v1/options/ws/public?app_id=1089";
const DAY_SECS = 86400, PRE_ROLL_SECS = 900, CHUNK_SECS = 4999, BACKFILL_CONCURRENCY = 3;
const FX_CLOSE_SEC = 21 * 3600, FX_OPEN_SUN_SEC = 86400;

// Pair groups: DRV (8 Deriv 1s pairs, prioritized first), MTL (XAU/XAG), and ALL (all 37 pairs)
const DRV_PAIRS = [
  "1HZ10V", "1HZ15V", "1HZ25V", "1HZ30V", "1HZ50V", "1HZ75V", "1HZ90V", "1HZ100V"
];
const MTL_PAIRS = [
  "frxXAUUSD", "frxXAGUSD"
];
const EXTRA_PAIRS = [
  "frxAUDCAD", "frxAUDCHF", "frxAUDJPY", "frxAUDNZD", "frxAUDUSD",
  "cryBTCUSD", "cryETHUSD",
  "frxEURAUD", "frxEURCAD", "frxEURCHF", "frxEURGBP", "frxEURJPY", "frxEURNZD", "frxEURUSD",
  "frxGBPAUD", "frxGBPCAD", "frxGBPCHF", "frxGBPJPY", "frxGBPNZD", "frxGBPUSD",
  "frxNZDJPY", "frxNZDUSD",
  "frxUSDCAD", "frxUSDCHF", "frxUSDJPY", "frxUSDMXN",
  "frxXPTUSD"
];
const ALL_PAIRS = DRV_PAIRS.concat(MTL_PAIRS, EXTRA_PAIRS);
const PAIR_GROUPS = { DRV: DRV_PAIRS, MTL: MTL_PAIRS, ALL: ALL_PAIRS };
const DRV_SET = new Set(DRV_PAIRS);
const MTL_SET = new Set(MTL_PAIRS);
const PAIR_SET = new Set(ALL_PAIRS);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);
const calcDayEpoch = sec => sec - (sec % DAY_SECS);
const isFxPair = p => /^frx/i.test(String(p));

const startedAtIso = new Date().toISOString(), startedAtEpoch = nowSec(), recentEvents = [];
function log(type, reason) {
  const e = { ts: new Date().toISOString(), epoch: nowSec(), type, reason };
  recentEvents.push(e);
  if (recentEvents.length > 120) recentEvents.shift();
  console.log(`[${e.ts}] [${type}] ${reason}`);
}
process.on("uncaughtException", e => log("UNCAUGHT_EXCEPTION", e && e.stack ? e.stack : String(e)));
process.on("unhandledRejection", e => log("UNHANDLED_REJECTION", e && e.stack ? e.stack : String(e)));

// ── buffers: one slot per second, -1 = empty ──
let activeDayEpoch = calcDayEpoch(nowSec());
const dayTicks = {}, preTicks = {}, lastTickTime = {};
const filled = {}, liveN = {}, bfN = {}, bfPending = {};
let totalLive = 0, totalBf = 0;
for (const p of ALL_PAIRS) {
  dayTicks[p] = new Float64Array(DAY_SECS).fill(-1);
  preTicks[p] = new Float64Array(PRE_ROLL_SECS).fill(-1);
  lastTickTime[p] = null;
  filled[p] = liveN[p] = bfN[p] = bfPending[p] = 0;
}

function checkRollover() {
  const cur = calcDayEpoch(nowSec());
  if (cur === activeDayEpoch) return;
  const adjacent = cur - activeDayEpoch === DAY_SECS;
  for (const p of ALL_PAIRS) {
    if (adjacent) preTicks[p].set(dayTicks[p].subarray(DAY_SECS - PRE_ROLL_SECS, DAY_SECS));
    else preTicks[p].fill(-1);
    dayTicks[p].fill(-1);
    filled[p] = liveN[p] = bfN[p] = 0;
  }
  totalLive = totalBf = 0;
  log("ROLLOVER", `05:30 IST rollover ${activeDayEpoch} -> ${cur}`);
  activeDayEpoch = cur;
  if (scanners) {
    scanners.DRV.resetForRollover();
    scanners.MTL.resetForRollover();
    scanners.ALL.resetForRollover();
  }
}
setInterval(checkRollover, 1000);

function recordTick(pair, epochSec, price, src) {
  if (!PAIR_SET.has(pair)) return;
  const ts = Math.floor(Number(epochSec)), val = Number(price);
  if (!Number.isFinite(ts) || !Number.isFinite(val)) return;
  checkRollover();
  const idx = ts - activeDayEpoch;
  let wasEmpty;
  if (idx >= 0 && idx < DAY_SECS) {
    wasEmpty = dayTicks[pair][idx] === -1;
    if (wasEmpty) filled[pair]++;
    dayTicks[pair][idx] = val;
  } else if (idx >= -PRE_ROLL_SECS && idx < 0) {
    wasEmpty = preTicks[pair][PRE_ROLL_SECS + idx] === -1;
    preTicks[pair][PRE_ROLL_SECS + idx] = val;
  } else return;
  lastTickTime[pair] = Math.max(lastTickTime[pair] || 0, ts);
  if (src === "L") { liveN[pair]++; totalLive++; } else if (src === "B" && wasEmpty) { bfN[pair]++; totalBf++; }
}

// ── load sampler ──
let cpuPct = 0, lagMs = 0, lagMax = 0, prevCpu = process.cpuUsage(), prevAt = Date.now(), lagPrev = Date.now();
setInterval(() => { const n = Date.now(); lagMax = Math.max(lagMax, n - lagPrev - 1000); lagPrev = n; }, 1000).unref();
setInterval(() => {
  const n = Date.now(), c = process.cpuUsage();
  cpuPct = ((c.user - prevCpu.user) + (c.system - prevCpu.system)) / ((n - prevAt) * 1000) * 100;
  prevCpu = c; prevAt = n; lagMs = lagMax; lagMax = 0;
}, 5000).unref();

// ── FX weekly hours (1HZ runs 24x7) ──
function fxClosedAt(sec) {
  const d = new Date(sec * 1000), dow = d.getUTCDay();
  const s = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
  return dow === 6 || (dow === 5 && s >= FX_CLOSE_SEC) || (dow === 0 && s < FX_OPEN_SUN_SEC);
}
function fxFetchEnd(pair, endSec) {
  if (!isFxPair(pair) || !fxClosedAt(endSec)) return endSec;
  const dayStart = endSec - (endSec % DAY_SECS);
  if (new Date(endSec * 1000).getUTCDay() === 5) return Math.min(endSec, dayStart + FX_CLOSE_SEC);
  return -1;
}

// ── backfill from ticks_history ──
let backfillState = { active: false, pct: 100, doneChunks: 0, totalChunks: 0, currentPair: null, reason: null };
let queuedReason = null, backfillSeq = 0, gapRetryCount = 0;
const preBackfillDay = {};

function fetchChunk(pair, t0, t1) {
  return new Promise(resolve => {
    const map = {};
    let settled = false, ws = null;
    const done = (ok, closedMarket, rateLimited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ws) { try { ws.terminate(); } catch {} }
      resolve({ ok: !!ok, closedMarket: !!closedMarket, rateLimited: !!rateLimited, map });
    };
    const timer = setTimeout(() => done(false, false, false), 25000);
    try {
      ws = new WebSocket(WS_URL);
      ws.on("open", () => ws.send(JSON.stringify({ ticks_history: pair, start: t0, end: t1, count: 5000, style: "ticks" })));
      ws.on("message", raw => {
        try {
          const d = JSON.parse(raw.toString());
          if (d.history && Array.isArray(d.history.times)) {
            for (let i = 0; i < d.history.times.length; i++) map[+d.history.times[i]] = +d.history.prices[i];
            done(true, false, false);
          } else if (d.error) {
            const code = d.error.code || "";
            const closedMkt = code === "MarketIsClosed" || code === "InvalidSymbol";
            done(closedMkt, closedMkt, code === "RateLimit");
          }
        } catch { done(false, false, false); }
      });
      ws.on("error", () => done(false, false, false));
      ws.on("close", () => done(false, false, false));
    } catch { done(false, false, false); }
  });
}

function findPairGaps(pair, dayEpoch, endSec, forceFromSec) {
  const gapMin = /^(cry|1HZ)/i.test(pair) ? 120 : 900;
  const gaps = [];
  let preMiss = 0;
  for (let i = 0; i < PRE_ROLL_SECS; i++) if (preTicks[pair][i] === -1) preMiss++;
  if (preMiss > 0 && preBackfillDay[pair] !== dayEpoch) gaps.push([dayEpoch - PRE_ROLL_SECS, dayEpoch - 1]);
  const maxIdx = Math.min(DAY_SECS - 1, Math.max(0, endSec - dayEpoch));
  const prices = dayTicks[pair];
  let gapStart = -1;
  for (let i = 0; i <= maxIdx; i++) {
    const ts = dayEpoch + i;
    if (prices[i] === -1) {
      if (gapStart === -1) gapStart = ts;
    } else if (gapStart !== -1) {
      const gapEnd = ts - 1;
      if (gapEnd - gapStart + 1 >= gapMin || (forceFromSec != null && gapEnd >= forceFromSec)) gaps.push([gapStart, gapEnd]);
      gapStart = -1;
    }
  }
  if (gapStart !== -1) gaps.push([gapStart, dayEpoch + maxIdx]);
  return gaps;
}

async function runBackfill(reason, forceFromSec) {
  if (backfillState.active) { queuedReason = reason; return; }
  checkRollover();
  if (reason !== "gap-retry") gapRetryCount = 0;
  const targetDay = activeDayEpoch, endSec = nowSec(), queue = [];
  for (const pair of ALL_PAIRS) {
    const pairEnd = fxFetchEnd(pair, endSec);
    if (pairEnd < 0) continue;
    for (const [a, b] of findPairGaps(pair, targetDay, pairEnd, forceFromSec)) {
      for (let s = a; s <= b; s += CHUNK_SECS + 1) queue.push({ pair, s, e: Math.min(s + CHUNK_SECS, b) });
    }
  }
  if (!queue.length) {
    log("BACKFILL_COMPLETE", `complete (${reason}) - 0 missing chunks`);
    scanners.DRV.runScan("backfill-0");
    scanners.MTL.runScan("backfill-0");
    scanners.ALL.runScan("backfill-0");
    return;
  }
  backfillState = { active: true, pct: 0, doneChunks: 0, totalChunks: queue.length, currentPair: queue[0].pair, reason };
  log("BACKFILL_START", `start (${reason}): ${queue.length} chunks (concurrency ${BACKFILL_CONCURRENCY})`);
  for (const p of ALL_PAIRS) bfPending[p] = 0;
  for (const q of queue) bfPending[q.pair]++;
  const closed = {};
  let cursor = 0, failedChunks = 0;
  const slot = async n => {
    if (n) await sleep(n * 450);
    while (activeDayEpoch === targetDay) {
      const t = queue[cursor++];
      if (!t) return;
      backfillState.currentPair = t.pair;
      if (!closed[t.pair]) {
        let res = { ok: false, closedMarket: false, rateLimited: false, map: {} };
        for (let tr = 0; tr <= 5; tr++) {
          if (tr) {
            const baseWait = res.rateLimited ? 3000 : 1500;
            await sleep(Math.min(20000, baseWait * Math.pow(2, tr - 1)));
          }
          res = await fetchChunk(t.pair, t.s, t.e);
          if (res.ok) break;
        }
        if (!res.ok) failedChunks++;
        if (res.closedMarket) closed[t.pair] = true;
        for (const ts in res.map) recordTick(t.pair, +ts, res.map[ts], "B");
        if (res.ok && t.e < targetDay) preBackfillDay[t.pair] = targetDay;
        await sleep(150);
      }
      if (bfPending[t.pair] > 0) {
        bfPending[t.pair]--;
        if (bfPending[t.pair] === 0) {
          // Trigger incremental scans for DRV & MTL ASAP as their pairs finish backfill
          if (DRV_SET.has(t.pair)) scanners.DRV.runScan("pair-ready:" + t.pair);
          if (MTL_SET.has(t.pair)) scanners.MTL.runScan("pair-ready:" + t.pair);
        }
      }
      backfillState.doneChunks++;
      backfillState.pct = Math.min(100, Math.round(backfillState.doneChunks / backfillState.totalChunks * 100));
    }
  };
  await Promise.all(Array.from({ length: BACKFILL_CONCURRENCY }, (_, i) => slot(i)));
  backfillState = { active: false, pct: 100, doneChunks: backfillState.doneChunks, totalChunks: queue.length, currentPair: null, reason: null };
  backfillSeq++;
  for (const p of ALL_PAIRS) bfPending[p] = 0;
  log("BACKFILL_COMPLETE", `complete (${reason}) - ${backfillState.doneChunks}/${queue.length} chunks` + (failedChunks ? ` (${failedChunks} failed)` : ""));
  scanners.DRV.runScan("backfill-done");
  scanners.MTL.runScan("backfill-done");
  scanners.ALL.runScan("backfill-done");
  if (queuedReason) {
    const next = queuedReason; queuedReason = null; runBackfill(next, null);
  } else if (failedChunks > 0 && gapRetryCount < 2 && !shuttingDown) {
    gapRetryCount++;
    log("BACKFILL_RETRY", `scheduling gap-retry #${gapRetryCount} in 15s for ${failedChunks} missed chunks`);
    setTimeout(() => { if (!shuttingDown) runBackfill("gap-retry", null); }, 15000).unref();
  }
}

// ── live Deriv tick socket ──
let liveWs = null, wsConnected = false, attempts = 0, reconnectTimer = null, pingTimer = null, resubTimer = null, downAt = null, shuttingDown = false;
const subscribed = new Set();
const feedState = () => (!wsConnected ? "RECONNECTING" : backfillState.active ? "BACKFILLING" : "LIVE");
function clearTimers() { clearInterval(pingTimer); clearInterval(resubTimer); pingTimer = resubTimer = null; }

async function subscribeAll(ws) {
  let id = 1;
  for (const pair of ALL_PAIRS) {
    if (ws !== liveWs || ws.readyState !== WebSocket.OPEN) return;
    if (subscribed.has(pair) || (isFxPair(pair) && fxClosedAt(nowSec()))) continue;
    try { ws.send(JSON.stringify({ ticks: pair, subscribe: 1, req_id: id++ })); } catch {}
    await sleep(45);
  }
}

function scheduleReconnect(reason) {
  if (shuttingDown || reconnectTimer) return;
  attempts++;
  const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(attempts - 1, 5)));
  log("RECONNECTING", `in ${delay}ms (attempt ${attempts}): ${reason}`);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connectLiveWs(true); }, delay);
}

function connectLiveWs(isReconnect) {
  if (shuttingDown) return;
  clearTimers();
  subscribed.clear();
  let ws;
  try { ws = new WebSocket(WS_URL); } catch (err) { wsConnected = false; scheduleReconnect(err.message); return; }
  liveWs = ws;
  ws.on("open", () => {
    if (ws !== liveWs) return;
    wsConnected = true;
    const missedFrom = downAt;
    downAt = null;
    attempts = 0;
    log("DERIV_OPEN", `connected; subscribing to ${ALL_PAIRS.length} pairs`);
    subscribeAll(ws);
    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) { try { ws.ping(); ws.send(JSON.stringify({ ping: 1 })); } catch {} }
    }, 25000);
    let fxWasClosed = fxClosedAt(nowSec()), ticks = 0;
    resubTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ticks++;
      const fxClosed = fxClosedAt(nowSec()), fxJustOpened = fxWasClosed && !fxClosed;
      fxWasClosed = fxClosed;
      if (fxClosed) for (const p of ALL_PAIRS) if (isFxPair(p)) subscribed.delete(p);
      if (fxJustOpened || (ticks % 10 === 0 && subscribed.size < ALL_PAIRS.length)) subscribeAll(ws);
    }, 30000);
    if (isReconnect) runBackfill("reconnect-recovery", missedFrom || (nowSec() - 300));
  });
  ws.on("message", raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.msg_type === "tick" && msg.tick) {
        subscribed.add(msg.tick.symbol);
        recordTick(msg.tick.symbol, msg.tick.epoch, msg.tick.quote, "L");
      } else if (msg.error && msg.echo_req && msg.echo_req.ticks && msg.error.code === "RateLimit") {
        const sym = msg.echo_req.ticks;
        setTimeout(() => {
          if (ws === liveWs && ws.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify({ ticks: sym, subscribe: 1 })); } catch {} }
        }, 3000);
      }
    } catch {}
  });
  ws.on("error", err => log("DERIV_ERROR", err && err.message ? err.message : String(err)));
  ws.on("close", (code, reasonBuf) => {
    if (ws !== liveWs) return;
    wsConnected = false;
    clearTimers();
    if (!downAt) downAt = nowSec();
    log("DERIV_CLOSED", `code ${code}${reasonBuf && reasonBuf.length ? " (" + reasonBuf.toString() + ")" : ""}`);
    scheduleReconnect(`closed with code ${code}`);
  });
}

// ── initialize unified settings, independent group scanners (DRV, MTL, ALL) & trader ──
const settings = createSettings({ log });

const scannerDrv = createScanner({
  group: "DRV",
  pairs: DRV_PAIRS,
  dayTicks,
  preTicks,
  filled,
  bfPending,
  nowSec,
  getDayEpoch: () => activeDayEpoch,
  settings: settings.forGroup("DRV"),
  log
});

const scannerMtl = createScanner({
  group: "MTL",
  pairs: MTL_PAIRS,
  dayTicks,
  preTicks,
  filled,
  bfPending,
  nowSec,
  getDayEpoch: () => activeDayEpoch,
  settings: settings.forGroup("MTL"),
  log
});

const scannerAll = createScanner({
  group: "ALL",
  disableLock: true,
  pairs: ALL_PAIRS,
  dayTicks,
  preTicks,
  filled,
  bfPending,
  nowSec,
  getDayEpoch: () => activeDayEpoch,
  settings: settings.forGroup("ALL"),
  log
});

const scanners = { DRV: scannerDrv, MTL: scannerMtl, ALL: scannerAll };
const scanner = scannerDrv;

const trader = createTrader({
  pairs: ALL_PAIRS,
  pairGroups: PAIR_GROUPS,
  dayTicks,
  preTicks,
  bfPending,
  nowSec,
  getDayEpoch: () => activeDayEpoch,
  isWsConnected: () => wsConnected,
  scanner: scannerDrv,
  scanners,
  settings,
  log
});

// ── HTTP helpers ──
function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
      if (data.length > 65536) { reject(new Error("Body too large")); req.destroy(); }
    });
    req.on("end", () => {
      if (!data.trim()) { resolve({}); return; }
      try { resolve(JSON.parse(data)); } catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

const INDEX_HTML_PATH = path.join(__dirname, "public", "index.html");

const MONITOR_PAGE = String.raw`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>WallSpectrum Server Monitor</title>
<style>
*{box-sizing:border-box}
html,body{height:100%;margin:0;overflow:hidden;background:#0b0f1a;color:#dfe6ff;font:11px/1.3 ui-monospace,Menlo,Consolas,monospace}
body{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:6px;height:100vh;height:100dvh}
#pg{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px;min-height:0;min-width:0}
.p{border:1px solid #243056;background:#121a2e;border-radius:4px;padding:3px 7px;display:flex;flex-direction:column;justify-content:center;min-width:0;white-space:nowrap;overflow:hidden}
.p span{font-size:clamp(9px,.9vw,13px);opacity:.8;overflow:hidden;text-overflow:ellipsis}
.p b{font-size:clamp(14px,1.8vw,26px);line-height:1.2}
#lg{background:#121a2e;border:1px solid #243056;border-radius:6px;padding:6px 8px;overflow:auto;font-size:11px;min-height:0;min-width:0}
#lg div{white-space:nowrap}
#lg h6{margin:6px 0 2px;color:#8d9ac8;font-size:9px;letter-spacing:.08em}
.ok{color:#4ade80}.warn{color:#facc15}.bad{color:#f87171}.dim{color:#7d8ab5}
@media(max-width:600px){body{grid-template-columns:1fr;grid-template-rows:minmax(0,1fr) minmax(0,1fr)}}
</style>
<body><div id=pg></div><div id=lg></div>
<script>
let prev = null, lr = 0, br = 0, np = 8;
const f = n => Number(n).toLocaleString();
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const dur = s => { s = Math.max(0, Math.round(s)); return Math.floor(s / 3600) + 'h ' + Math.floor(s % 3600 / 60) + 'm ' + (s % 60) + 's'; };
const ln = (k, v) => '<div><span class=dim>' + k + '</span> ' + v + '</div>';
function fit() {
  const r = pg.getBoundingClientRect();
  let best = 1, bs = -1e9, c, rows, cw, ch, sc;
  for (c = 1; c <= 10; c++) {
    rows = Math.ceil(np / c); cw = (r.width - (c - 1) * 4) / c; ch = (r.height - (rows - 1) * 4) / rows;
    sc = -Math.abs(Math.log(cw / ch / 2.2)) - (cw < 90 || ch < 32 ? 10 : 0);
    if (sc > bs) { bs = sc; best = c; }
  }
  pg.style.gridTemplateColumns = 'repeat(' + best + ',minmax(0,1fr))';
  pg.style.gridTemplateRows = 'repeat(' + Math.ceil(np / best) + ',minmax(0,1fr))';
}
addEventListener('resize', fit);
async function go() {
  try {
    const r = await fetch('/status', { cache: 'no-store' });
    const j = await r.json(), now = Date.now() / 1000, b = j.backfill, left = j.activeDayEpoch + 86400 - now, bp = j.bfPending || {};
    if (prev && now > prev.t) {
      const dt = now - prev.t, inst = Math.max(0, (b.doneChunks - prev.chunks) / dt);
      lr = Math.max(0, (j.totalLive - prev.live) / dt);
      br = br ? br * 0.7 + inst * 0.3 : inst;
    }
    prev = { t: now, live: j.totalLive, chunks: b.doneChunks };
    const st = j.feedState, sc = st === 'LIVE' ? 'ok' : st === 'BACKFILLING' ? 'warn' : 'bad';
    const eta = b.active && br > 0 ? dur((b.totalChunks - b.doneChunks) / br) : '-';
    let cells = '', rows = '';
    np = Object.keys(j.lastTickTime).length;
    for (const p in j.lastTickTime) {
      const a = j.lastTickTime[p], age = a ? now - a : null, pend = bp[p] || 0;
      const cov = j.elapsed ? Math.min(100, j.filled[p] / j.elapsed * 100) : 0;
      const ac = age === null ? 'dim' : age < 10 ? 'ok' : age < 60 ? 'warn' : 'bad';
      cells += '<div class="p ' + (!j.wsConnected || pend > 0 ? 'bad' : 'ok') + '"><span>' + p + '</span><b>' + f(j.filled[p]) + '</b></div>';
      rows += ln(p, '<span class=' + ac + '>' + (age === null ? '-' : Math.round(age) + 's') + '</span> L ' + f(j.liveN[p]) + ' B ' + f(j.bfN[p]) + ' pend ' + pend + ' cov ' + cov.toFixed(0) + '%');
    }
    pg.innerHTML = cells; fit();
    var tr = j.trader || {}, lk = j.lock || {};
    var fmtLk = function (arr) {
      var list = (arr || []).filter(Boolean).slice(0, 8);
      return list.length ? esc(list.map(function (x) { return x.pair + ' C' + x.c + ' R' + x.r + ' X' + x.s1 + ' ' + x.type + ' ' + x.pct + '%'; }).join(' | ')) : 'WAITING';
    };
    var lkBuys = Array.isArray(lk.buys) ? lk.buys.slice(0, 8) : [lk.buy];
    var lkSells = Array.isArray(lk.sells) ? lk.sells.slice(0, 8) : [lk.sell];
    var cfg = j.settings || {};
    var cycTxt = (cfg.minC === cfg.maxC) ? (cfg.minC + 's') : (cfg.minC + '-' + cfg.maxC + 's');
    var trG = tr.groups || {};
    var drvG = trG.DRV || { auto: tr.auto, stake: tr.stake };
    var mtlG = trG.MTL || { auto: false, stake: 0.50 };
    lg.innerHTML = '<h6>STATUS</h6>' +
      ln('UI', '<a href="/" style="color:#4ade80">OPEN WALLSPECTRUM DASHBOARD</a>') +
      ln('FEED', '<span class=' + sc + '>' + st + '</span> WS ' + (j.wsConnected ? 'up' : 'DOWN') + ' subs ' + j.subscribedCount + '/' + j.totalPairs) +
      ln('TRADER', (tr.ready ? '<span class=ok>ONLINE</span>' : '<span class=bad>WAIT</span>') + ' ' + String(tr.mode || 'demo').toUpperCase() + ' DRV:' + (drvG.auto ? 'ON' : 'OFF') + '($' + Number(drvG.stake || 0).toFixed(2) + ') MTL:' + (mtlG.auto ? 'ON' : 'OFF') + '($' + Number(mtlG.stake || 0).toFixed(2) + ')') +
      ln('DRV PARAMS', 'CYCLE:' + esc(cycTxt) + ' SCAN:' + esc(cfg.scanInt) + 's SESS:' + (cfg.ssMin ? esc(cfg.ssMin) + 'm' : 'DAY') + ' LVL:' + (cfg.lvl ? 'X' + esc(cfg.lvl) : 'ALL') + ' PCT>=' + esc(cfg.lockMinPct) + '% C1>=' + esc(cfg.lockMinC1)) +
      ln('DRV REV', fmtLk(lkBuys)) +
      ln('DRV MOM', fmtLk(lkSells)) +
      ln('UPTIME', dur(j.uptime) + ' backfill runs ' + j.backfillSeq) +
      ln('MEMORY', '<span class=' + (j.rssMB > 400 ? 'bad' : 'ok') + '>' + j.rssMB + ' MB</span> of 512 MB') +
      ln('CPU', '<span class=' + (j.cpuPct > 8 ? 'bad' : 'ok') + '>' + j.cpuPct + '%</span> cap ~10% lag ' + j.lagMs + 'ms') +
      ln('LIVE TICKS', f(j.totalLive) + ' (' + lr.toFixed(1) + ' / sec)') +
      ln('BACKFILLED TICKS', f(j.totalBf)) +
      ln('BACKFILL', b.active ? b.pct + '% ' + b.currentPair + ' ' + f(b.doneChunks) + '/' + f(b.totalChunks) + ' chunks ' + br.toFixed(1) + '/s ETA ' + eta : 'idle') +
      ln('DAY (05:30 IST)', Math.floor(j.elapsed / 864) + '% reset in ' + dur(left)) +
      '<h6>PAIRS</h6>' + rows +
      '<h6>EVENTS</h6>' + j.recentEvents.slice().reverse().map(e => ln(e.ts.slice(11, 19), esc(e.type) + ' ' + esc(e.reason))).join('');
  } catch (e) { lg.innerHTML = '<div class=bad>ERROR ' + esc(e.message) + '</div>'; }
}
go(); setInterval(go, 2000);
</script>`;

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`), pathname = u.pathname;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Api-Token");
  res.setHeader("Access-Control-Expose-Headers", "X-Day-Epoch, X-From-Index, X-To-Index, X-Pre-Length");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.method === "POST" && pathname === "/control") {
    try {
      const body = await readJsonBody(req);
      const out = await trader.handleControl(body);
      sendJson(res, 200, out);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e && e.message ? e.message : "Bad request" });
    }
    return;
  }

  if (req.method !== "GET") { res.writeHead(404); res.end("Not found"); return; }

  if (pathname === "/") {
    var fetchDest = String(req.headers["sec-fetch-dest"] || "");
    if (fetchDest !== "iframe" && fetchDest !== "frame") {
      res.writeHead(302, { "Location": "/dev", "Cache-Control": "no-store" });
      res.end();
      return;
    }
  }

  if (pathname === "/" || pathname === "/index.html") {
    if (fs.existsSync(INDEX_HTML_PATH)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(fs.readFileSync(INDEX_HTML_PATH));
    } else {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(MONITOR_PAGE);
    }
    return;
  }

  if (pathname === "/monitor") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(MONITOR_PAGE);
    return;
  }

  if (pathname === "/ping") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end("ok");
    return;
  }

  if (pathname === "/state") {
    checkRollover();
    const drvSnap = scanners.DRV.getSnapshot();
    const mtlSnap = scanners.MTL.getSnapshot();
    const allSnap = scanners.ALL.getSnapshot();
    var syncNow = nowSec();
    var syncFxClosed = fxClosedAt(syncNow);
    var syncedCount = 0;
    for (var si = 0; si < ALL_PAIRS.length; si++) {
      var sp = ALL_PAIRS[si];
      var spClosed = syncFxClosed && /^frx/i.test(sp);
      var spBfOk = (bfPending[sp] || 0) === 0 && ((filled[sp] || 0) > 0 || spClosed);
      var spLast = lastTickTime[sp];
      var spLim = /^1HZ/i.test(sp) ? 10 : 90;
      var spLiveOk = spClosed || (wsConnected && spLast != null && (syncNow - spLast) <= spLim);
      if (spBfOk && spLiveOk) syncedCount++;
    }
    var allSynced = ALL_PAIRS.length > 0 && syncedCount === ALL_PAIRS.length && !backfillState.active;
    sendJson(res, 200, {
      dayEpoch: activeDayEpoch,
      feedState: feedState(),
      wsConnected,
      backfill: backfillState,
      pairs: DRV_PAIRS,
      allPairs: ALL_PAIRS,
      pairGroups: PAIR_GROUPS,
      readyPairs: ALL_PAIRS.filter(p => bfPending[p] === 0 && filled[p] > 0),
      trader: trader.getSnapshot(),
      scan: drvSnap,
      scans: {
        DRV: drvSnap,
        MTL: mtlSnap,
        ALL: allSnap
      },
      settings: settings.getGroupValues("DRV"),
      settingsByGroup: settings.getAllGroupValues(),
      settingsSchema: settings.getGroupSchema("DRV"),
      settingsSchemas: settings.getAllGroupSchemas(),
      settingsVersion: settings.getVersion(),
      sync: {
        nowSec: syncNow,
        uptime: Math.floor(process.uptime()),
        subscribedCount: subscribed.size,
        totalPairs: ALL_PAIRS.length,
        syncedCount: syncedCount,
        allSynced: allSynced,
        backfillSeq,
        elapsed: Math.min(DAY_SECS, syncNow - activeDayEpoch + 1),
        fxClosed: syncFxClosed,
        totalLive,
        totalBf,
        lastTickTime,
        filled,
        liveN,
        bfN,
        bfPending
      },
      payouts: trader.payouts,
      trades: trader.trades,
      logs: trader.consoleLogs
    });
    return;
  }

  if (pathname === "/status") {
    checkRollover();
    sendJson(res, 200, {
      uptime: Math.floor(process.uptime()), lastRestart: startedAtIso, lastRestartEpoch: startedAtEpoch,
      activeDayEpoch, feedState: feedState(), wsConnected, subscribedCount: subscribed.size, totalPairs: ALL_PAIRS.length,
      backfill: backfillState, backfillSeq, serverScan: true, rssMB: Math.round(process.memoryUsage().rss / 1048576),
      lastTickTime, recentEvents, filled, liveN, bfN, bfPending, totalLive, totalBf,
      elapsed: Math.min(DAY_SECS, nowSec() - activeDayEpoch + 1), cpuPct: Math.round(cpuPct * 10) / 10, lagMs,
      trader: trader.getSnapshot(),
      settings: settings.getGroupValues("DRV"),
      settingsByGroup: settings.getAllGroupValues(),
      lock: scanners.DRV.state.lock,
      locks: {
        DRV: scanners.DRV.state.lock,
        MTL: scanners.MTL.state.lock,
        ALL: scanners.ALL.state.lock
      }
    });
    return;
  }

  if (pathname === "/scan") {
    checkRollover();
    const grpParam = String(u.searchParams.get("group") || "DRV").toUpperCase();
    const targetSc = scanners[grpParam] || scanners.DRV;
    sendJson(res, 200, Object.assign({ ok: true, dayEpoch: activeDayEpoch }, targetSc.getSnapshot()));
    return;
  }

  if (pathname === "/ticks") {
    const pair = u.searchParams.get("pair") || "";
    if (!PAIR_SET.has(pair)) { sendJson(res, 400, { error: "Invalid pair" }); return; }
    checkRollover();
    const nowIdx = Math.max(0, Math.min(DAY_SECS - 1, nowSec() - activeDayEpoch));
    let from = parseInt(u.searchParams.get("from") || "0", 10);
    if (!Number.isFinite(from) || from < 0) from = 0;
    const clientDay = u.searchParams.get("day");
    if (clientDay && Number(clientDay) !== activeDayEpoch) from = 0;
    if (from > nowIdx) from = nowIdx;
    const preLen = from === 0 && u.searchParams.get("pre") === "1" ? PRE_ROLL_SECS : 0;
    const sliceLen = Math.max(0, nowIdx - from + 1);
    const out = new Float64Array(preLen + sliceLen);
    if (preLen) out.set(preTicks[pair], 0);
    if (sliceLen > 0) out.set(dayTicks[pair].subarray(from, nowIdx + 1), preLen);
    zlib.gzip(Buffer.from(out.buffer, out.byteOffset, out.byteLength), { level: 1 }, (err, gz) => {
      if (err) { sendJson(res, 500, { error: "Compression error" }); return; }
      res.writeHead(200, {
        "Content-Type": "application/octet-stream", "Content-Encoding": "gzip", "Cache-Control": "no-store",
        "X-Day-Epoch": String(activeDayEpoch), "X-From-Index": String(from), "X-To-Index": String(nowIdx), "X-Pre-Length": String(preLen)
      });
      res.end(gz);
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
});
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => { fetch(process.env.RENDER_EXTERNAL_URL + "/ping").catch(() => {}); }, 4 * 60 * 1000).unref();
}

function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("SHUTDOWN", `${sig} received`);
  clearTimers();
  clearTimeout(reconnectTimer);
  try { if (liveWs) liveWs.close(1000, "shutting down"); } catch {}
  trader.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(PORT, async () => {
  log("START", `WallSpectrum server on port ${PORT}, activeDayEpoch ${activeDayEpoch}, ${ALL_PAIRS.length} pairs`);
  await settings.load();
  connectLiveWs(false);
  scanners.DRV.start();
  scanners.MTL.start();
  scanners.ALL.start();
  trader.start();
  runBackfill("startup", null);
});
