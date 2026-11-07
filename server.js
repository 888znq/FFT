"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { URL } = require("url");
const WebSocket = require("ws");
const { Worker } = require("worker_threads");

const PORT = Number(process.env.PORT) || 3000;
const API_TOKEN = (process.env.API_TOKEN || process.env.ACCESS_TOKEN || "").trim();
const WS_URL = "wss://api.derivws.com/trading/v1/options/ws/public?app_id=1089";

const IST_OFFSET = 19800;
const DAY_SECS = 86400;
const PRE_ROLL_SECS = 900;
const CHUNK_SECS = 900;
const BACKFILL_CONCURRENCY = 6;
const MAX_EVENTS = 100;

const ALL_PAIRS = [
  "frxAUDCAD", "frxAUDCHF", "frxAUDJPY", "frxAUDNZD", "frxAUDUSD",
  "cryBTCUSD", "cryETHUSD",
  "frxEURAUD", "frxEURCAD", "frxEURCHF", "frxEURGBP", "frxEURJPY", "frxEURNZD", "frxEURUSD",
  "frxGBPAUD", "frxGBPCAD", "frxGBPCHF", "frxGBPJPY", "frxGBPNZD", "frxGBPUSD",
  "frxNZDJPY", "frxNZDUSD",
  "frxUSDCAD", "frxUSDCHF", "frxUSDJPY", "frxUSDMXN",
  "1HZ10V", "1HZ15V", "1HZ25V", "1HZ30V", "1HZ50V", "1HZ75V", "1HZ90V", "1HZ100V",
  "frxXAGUSD", "frxXAUUSD", "frxXPTUSD"
];
const PAIR_SET = new Set(ALL_PAIRS);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);
const calcDayEpoch = sec => sec - (sec % DAY_SECS);

// ── observability & event log ──
const startedAtIso = new Date().toISOString();
const startedAtEpoch = nowSec();
const recentEvents = [];

function logEvent(type, reason, extra) {
  const entry = Object.assign(
    { ts: new Date().toISOString(), epoch: nowSec(), type, reason },
    extra || {}
  );
  recentEvents.push(entry);
  if (recentEvents.length > MAX_EVENTS) recentEvents.shift();
  console.log(`[${entry.ts}] [${type}] ${reason}`);
}

process.on("uncaughtException", err => {
  logEvent("UNCAUGHT_EXCEPTION", err && err.stack ? err.stack : String(err));
});

process.on("unhandledRejection", reason => {
  logEvent("UNHANDLED_REJECTION", reason && reason.stack ? reason.stack : String(reason));
});

// ── in-memory store + future Firebase RTDB interface ──
var activeDayEpoch = calcDayEpoch(nowSec());
const dayTicks = {};
const preTicks = {};
const lastTickTime = {};
const dirtyPairs = new Set();

function initBuffers() {
  for (const p of ALL_PAIRS) {
    dayTicks[p] = new Float64Array(DAY_SECS).fill(-1);
    preTicks[p] = new Float64Array(PRE_ROLL_SECS).fill(-1);
    lastTickTime[p] = null;
  }
}
initBuffers();

const store = {
  async load(dayEpoch) {
    // Memory is the store for now; Firebase RTDB loader plugs in here later.
    return null;
  },
  async save(dayEpoch, pairsToFlush) {
    // Batched every 45s; Firebase RTDB writer plugs in here later.
    return true;
  }
};

setInterval(async () => {
  if (!dirtyPairs.size) return;
  const batch = Array.from(dirtyPairs);
  dirtyPairs.clear();
  try {
    await store.save(activeDayEpoch, batch);
  } catch (err) {
    logEvent("STORE_ERROR", `Failed batched save: ${err.message}`);
  }
}, 45000);

// ── 05:30 IST (00:00 UTC) active-day rollover ──
function checkRollover() {
  const curEpoch = calcDayEpoch(nowSec());
  if (curEpoch === activeDayEpoch) return false;

  const prevEpoch = activeDayEpoch;
  const isAdjacentDay = curEpoch - prevEpoch === DAY_SECS;

  for (const p of ALL_PAIRS) {
    if (isAdjacentDay) {
      preTicks[p].set(dayTicks[p].subarray(DAY_SECS - PRE_ROLL_SECS, DAY_SECS));
    } else {
      preTicks[p].fill(-1);
    }
    dayTicks[p].fill(-1);
    dirtyPairs.add(p);
  }

  activeDayEpoch = curEpoch;
  logEvent(
    "ROLLOVER",
    `05:30 IST rollover from ${prevEpoch} to new active day ${curEpoch} (kept ${PRE_ROLL_SECS}s pre-roll)`
  );
  return true;
}

setInterval(checkRollover, 1000);

// ── FX weekly market hours (crypto and 1HZ volatility run 24x7) ──
const FX_CLOSE_SEC = 21 * 3600;
const FX_OPEN_SUN_SEC = 86400;
const isFxPair = pair => /^frx/i.test(String(pair));
function fxClosedAt(sec) {
  const d = new Date(sec * 1000);
  const dow = d.getUTCDay();
  const s = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
  if (dow === 6) return true;
  if (dow === 5 && s >= FX_CLOSE_SEC) return true;
  if (dow === 0 && s < FX_OPEN_SUN_SEC) return true;
  return false;
}
function fxFetchEnd(pair, endSec) {
  if (!isFxPair(pair) || !fxClosedAt(endSec)) return endSec;
  const dayStart = endSec - (endSec % DAY_SECS);
  if (new Date(endSec * 1000).getUTCDay() === 5) return Math.min(endSec, dayStart + FX_CLOSE_SEC);
  return -1;
}

(function logServerConfig() {
  var cryN = ALL_PAIRS.filter(p => /^cry/i.test(p)).length;
  var volN = ALL_PAIRS.filter(p => /^1HZ/i.test(p)).length;
  var fxN = ALL_PAIRS.filter(p => /^frx/i.test(p)).length;
  logEvent("CONFIG", `PAIRS ${ALL_PAIRS.length} = crypto ${cryN} + volatility ${volN} + fx ${fxN}`);
  logEvent("CONFIG", `DAY 05:30 IST -> 05:30 IST (00:00 UTC rollover), pre-roll ${PRE_ROLL_SECS}s, 1h sessions x 24`);
  if (typeof fxClosedAt === "function") {
    logEvent("CONFIG", `FX RULE ACTIVE: closes Fri ${FX_CLOSE_SEC / 3600}:00 UTC, opens Mon ${FX_OPEN_SUN_SEC / 3600 - 24}:00 UTC, now ${fxClosedAt(nowSec()) ? "CLOSED" : "OPEN"}; crypto + volatility run 24x7`);
  } else {
    logEvent("CONFIG", "FX RULE NOT APPLIED on server");
  }
  logEvent("CONFIG", `PAIR LIST: ${ALL_PAIRS.join(", ")}`);
})();

// ── tick recording (bucket per second: last tick wins) ──
function recordTick(pair, epochSec, price) {
  if (!PAIR_SET.has(pair)) return;
  const ts = Math.floor(Number(epochSec));
  const val = Number(price);
  if (!Number.isFinite(ts) || !Number.isFinite(val)) return;

  checkRollover();

  const idx = ts - activeDayEpoch;
  if (idx >= 0 && idx < DAY_SECS) {
    dayTicks[pair][idx] = val;
    lastTickTime[pair] = Math.max(lastTickTime[pair] || 0, ts);
    dirtyPairs.add(pair);
  } else if (idx >= -PRE_ROLL_SECS && idx < 0) {
    preTicks[pair][PRE_ROLL_SECS + idx] = val;
    lastTickTime[pair] = Math.max(lastTickTime[pair] || 0, ts);
    dirtyPairs.add(pair);
  }
}

// ── ticks_history chunk fetcher & backfill ──
var backfillState = {
  active: false,
  pct: 100,
  doneChunks: 0,
  totalChunks: 0,
  currentPair: null,
  reason: null
};
var backfillQueuedReason = null;
var backfillSeq = 0; // bumps each time a backfill finishes, so pages know to re-pull the day

function fetchChunk(pair, t0, t1) {
  return new Promise(resolve => {
    const map = {};
    var settled = false;
    var ws = null;

    const done = (ok, closedMarket) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ws) {
        try { ws.terminate(); } catch {}
      }
      resolve({ ok: !!ok, closedMarket: !!closedMarket, map });
    };

    const timer = setTimeout(() => done(false, false), 25000);

    try {
      ws = new WebSocket(WS_URL);
      ws.on("open", () => {
        ws.send(JSON.stringify({
          ticks_history: pair,
          start: t0,
          end: t1,
          count: 5000,
          style: "ticks"
        }));
      });
      ws.on("message", raw => {
        try {
          const d = JSON.parse(raw.toString());
          if (d.history && Array.isArray(d.history.times)) {
            const times = d.history.times;
            const prices = d.history.prices;
            for (var i = 0; i < times.length; i++) {
              map[+times[i]] = +prices[i];
            }
            done(true, false);
          } else if (d.error) {
            const code = d.error.code || "";
            if (code === "MarketIsClosed" || code === "InvalidSymbol") {
              done(true, true);
            } else {
              done(false, false);
            }
          }
        } catch {
          done(false, false);
        }
      });
      ws.on("error", () => done(false, false));
      ws.on("close", () => done(false, false));
    } catch {
      done(false, false);
    }
  });
}

function findPairGaps(pair, dayEpoch, endSec, forceFromSec) {
  const gapMin = /^(cry|1HZ)/i.test(pair) ? 120 : 900;
  const scanFromIdx = Math.max(0, (endSec - (endSec % 3600)) - PRE_ROLL_SECS - dayEpoch);
  const gaps = [];

  // Check 900s pre-roll reference if completely empty
  var hasPre = false;
  const preArr = preTicks[pair];
  for (var pi = 0; pi < PRE_ROLL_SECS; pi++) {
    if (preArr[pi] !== -1) { hasPre = true; break; }
  }
  if (!hasPre && endSec >= dayEpoch && scanFromIdx === 0) {
    gaps.push([dayEpoch - PRE_ROLL_SECS, dayEpoch - 1]);
  }

  const maxIdx = Math.min(DAY_SECS - 1, Math.max(0, endSec - dayEpoch));
  const prices = dayTicks[pair];
  var gapStart = -1;

  for (var i = scanFromIdx; i <= maxIdx; i++) {
    const ts = dayEpoch + i;
    if (prices[i] === -1) {
      if (gapStart === -1) gapStart = ts;
    } else if (gapStart !== -1) {
      const gapEnd = ts - 1;
      const len = gapEnd - gapStart + 1;
      const overlapsDisconnect = forceFromSec != null && gapEnd >= forceFromSec;
      if (len >= gapMin || overlapsDisconnect) {
        gaps.push([gapStart, gapEnd]);
      }
      gapStart = -1;
    }
  }
  if (gapStart !== -1) {
    gaps.push([gapStart, dayEpoch + maxIdx]);
  }

  return gaps;
}

async function runBackfill(reason, forceFromSec) {
  if (backfillState.active) {
    backfillQueuedReason = reason;
    return;
  }

  checkRollover();
  const targetDayEpoch = activeDayEpoch;
  const endSec = nowSec();

  const pairPlans = [];
  var totalChunks = 0;

  for (const pair of ALL_PAIRS) {
    const pairEnd = fxFetchEnd(pair, endSec);
    if (pairEnd < 0) continue;
    const gaps = findPairGaps(pair, targetDayEpoch, pairEnd, forceFromSec);
    if (!gaps.length) continue;
    const chunks = [];
    for (const [a, b] of gaps) {
      for (var s = a; s <= b; s += CHUNK_SECS + 1) {
        chunks.push([s, Math.min(s + CHUNK_SECS, b)]);
      }
    }
    if (chunks.length) {
      pairPlans.push({ pair, gaps, chunks });
      totalChunks += chunks.length;
    }
  }

  if (!totalChunks) {
    logEvent("BACKFILL_COMPLETE", `BACKFILL complete (${reason}) - 0 missing chunks`);
    return;
  }

  backfillState = {
    active: true,
    pct: 0,
    doneChunks: 0,
    totalChunks,
    currentPair: pairPlans[0].pair,
    reason
  };

  logEvent(
    "BACKFILL_START",
    `Starting backfill (${reason}): ${pairPlans.length} pairs, ${totalChunks} chunks`
  );

  for (const plan of pairPlans) {
    if (activeDayEpoch !== targetDayEpoch) break;
    const { pair, gaps, chunks } = plan;
    backfillState.currentPair = pair;

    const firstStart = gaps[0][0];
    const lastEnd = gaps[gaps.length - 1][1];
    logEvent(
      "BACKFILL_PAIR",
      `BACKFILL ${pair} missing range ${firstStart}..${lastEnd} (${chunks.length} chunk(s), ${gaps.length} gap(s))`
    );

    var marketClosed = false;
    for (var i = 0; i < chunks.length; i += BACKFILL_CONCURRENCY) {
      if (activeDayEpoch !== targetDayEpoch) break;
      const batch = chunks.slice(i, i + BACKFILL_CONCURRENCY);

      if (marketClosed) {
        backfillState.doneChunks += batch.length;
        backfillState.pct = Math.min(100, Math.round((backfillState.doneChunks / backfillState.totalChunks) * 100));
        continue;
      }

      const results = await Promise.all(
        batch.map(async (c, idx) => {
          var res = { ok: false, closedMarket: false, map: {} };
          var retries = 0;
          var delay = idx * 250;
          while (retries <= 3) {
            if (delay) await sleep(delay);
            res = await fetchChunk(pair, c[0], c[1]);
            if (res.ok) break;
            retries++;
            delay = 1500 * retries;
          }
          return res;
        })
      );

      for (const res of results) {
        if (res.closedMarket) marketClosed = true;
        for (const ts in res.map) {
          recordTick(pair, +ts, res.map[ts]);
        }
      }

      backfillState.doneChunks += batch.length;
      backfillState.pct = Math.min(100, Math.round((backfillState.doneChunks / backfillState.totalChunks) * 100));
      await sleep(400);
    }
  }

  const doneCount = backfillState.doneChunks;
  backfillState = {
    active: false,
    pct: 100,
    doneChunks: doneCount,
    totalChunks,
    currentPair: null,
    reason: null
  };

  backfillSeq++;
  logEvent(
    "BACKFILL_COMPLETE",
    `BACKFILL complete (${reason}) - processed ${doneCount}/${totalChunks} chunks`
  );

  if (backfillQueuedReason) {
    const nextReason = backfillQueuedReason;
    backfillQueuedReason = null;
    runBackfill(nextReason, null);
  }
}

// ── persistent Deriv live WebSocket connection ──
var liveWs = null;
var wsConnected = false;
var reconnectAttempts = 0;
var reconnectTimer = null;
var pingTimer = null;
var resubscribeTimer = null;
var disconnectedAtSec = null;
var shuttingDown = false;
const subscribedPairs = new Set();

function getFeedState() {
  if (!wsConnected) return "RECONNECTING";
  if (backfillState.active) return "BACKFILLING";
  return "LIVE";
}

function clearWsTimers() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  if (resubscribeTimer) { clearInterval(resubscribeTimer); resubscribeTimer = null; }
}

async function subscribeAllPairs(ws) {
  var reqId = 1;
  for (const pair of ALL_PAIRS) {
    if (ws !== liveWs || ws.readyState !== WebSocket.OPEN) return;
    if (subscribedPairs.has(pair)) continue;
    if (isFxPair(pair) && fxClosedAt(nowSec())) continue;
    try {
      ws.send(JSON.stringify({ ticks: pair, subscribe: 1, req_id: reqId++ }));
    } catch {}
    await sleep(45);
  }
}

function scheduleReconnect(reason) {
  if (shuttingDown || reconnectTimer) return;
  reconnectAttempts++;
  const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(reconnectAttempts - 1, 5)));
  logEvent("RECONNECTING", `Reconnecting to Deriv WS in ${delay}ms (attempt ${reconnectAttempts}): ${reason}`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectLiveWs(true);
  }, delay);
}

function connectLiveWs(isReconnect) {
  if (shuttingDown) return;
  clearWsTimers();
  subscribedPairs.clear();

  var ws;
  try {
    ws = new WebSocket(WS_URL);
  } catch (err) {
    wsConnected = false;
    scheduleReconnect(err.message);
    return;
  }
  liveWs = ws;

  ws.on("open", () => {
    if (ws !== liveWs) return;
    wsConnected = true;
    const missedFrom = disconnectedAtSec;
    disconnectedAtSec = null;
    reconnectAttempts = 0;

    logEvent("DERIV_OPEN", "Connected to Deriv public WebSocket; subscribing to " + ALL_PAIRS.length + " pairs");
    subscribeAllPairs(ws);

    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.ping();
          ws.send(JSON.stringify({ ping: 1 }));
        } catch {}
      }
    }, 25000);

    // Retry subscribing any pair that was closed; FX is dropped at the weekly close and re-subscribed at the open
    var fxWasClosed = fxClosedAt(nowSec());
    var resubTicks = 0;
    resubscribeTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      resubTicks++;
      var fxClosed = fxClosedAt(nowSec());
      var fxJustOpened = fxWasClosed && !fxClosed;
      fxWasClosed = fxClosed;
      if (fxClosed) {
        for (const p of ALL_PAIRS) { if (isFxPair(p)) subscribedPairs.delete(p); }
      }
      if (fxJustOpened || (resubTicks % 10 === 0 && subscribedPairs.size < ALL_PAIRS.length)) {
        subscribeAllPairs(ws);
      }
    }, 30000);

    if (isReconnect) {
      runBackfill("reconnect-recovery", missedFrom || (nowSec() - 300));
    }
  });

  ws.on("message", raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.msg_type === "tick" && msg.tick) {
        subscribedPairs.add(msg.tick.symbol);
        recordTick(msg.tick.symbol, msg.tick.epoch, msg.tick.quote);
      } else if (msg.error && msg.echo_req && msg.echo_req.ticks) {
        const sym = msg.echo_req.ticks;
        const code = msg.error.code || "ERR";
        if (code === "RateLimit") {
          setTimeout(() => {
            if (ws === liveWs && ws.readyState === WebSocket.OPEN) {
              try { ws.send(JSON.stringify({ ticks: sym, subscribe: 1 })); } catch {}
            }
          }, 3000);
        }
      }
    } catch {}
  });

  ws.on("error", err => {
    logEvent("DERIV_ERROR", `Deriv WS error: ${err && err.message ? err.message : String(err)}`);
  });

  ws.on("close", (code, reasonBuf) => {
    if (ws !== liveWs) return;
    wsConnected = false;
    clearWsTimers();
    if (!disconnectedAtSec) disconnectedAtSec = nowSec();
    const rText = reasonBuf ? reasonBuf.toString() : "";
    logEvent(
      "DERIV_CLOSED",
      `DERIV connection closed with code ${code}${rText ? " (" + rText + ")" : ""}`
    );
    scheduleReconnect(`closed with code ${code}`);
  });
}

// ── HTTP server & routes ──
const SCAN_MAX_WORK = 50000000;
const SCAN_CACHE_MS = 15000;
var scanWorker = null;
var scanJobs = {};
var scanJobId = 0;
var scanCache = { key: "", t: 0, buf: null };
var scanInflight = null;
var lastScanInfo = null;

function scanWorkerMain() {
  var wt = require("worker_threads");
  function applyCumulative(hist, maxS) {
    var cum = 0;
    var res = {};
    for (var i = maxS; i >= 1; i--) {
      var v = hist[i];
      if (v) cum += v;
      if (cum > 0) res[i] = cum;
    }
    return res;
  }
  function computeGapMapFromEvents(events) {
    var curRun = [];
    var runPeaks = [];
    for (var i = 0; i < events.length; i++) {
      var L = events[i];
      for (var s = 1; s < L; s++) {
        curRun[s] = (curRun[s] || 0) + 1;
      }
      if (curRun[L] > 0) {
        if (!runPeaks[L]) runPeaks[L] = [];
        runPeaks[L].push(curRun[L]);
      }
      curRun[L] = 0;
    }
    var modeRun = [];
    var modeCount = [];
    var maxLen = Math.max(curRun.length, runPeaks.length);
    for (var s2 = 1; s2 < maxLen; s2++) {
      var freq = {};
      if (runPeaks[s2]) {
        for (var q = 0; q < runPeaks[s2].length; q++) {
          var pv = runPeaks[s2][q];
          if (pv < 1) continue;
          freq[pv] = (freq[pv] || 0) + 1;
        }
      }
      var liveLen = curRun[s2] || 0;
      if (liveLen >= 1) freq[liveLen] = (freq[liveLen] || 0) + 1;
      var lens = Object.keys(freq);
      if (lens.length === 0) continue;
      var bestLen = 0, bestCount = 0;
      for (var z = 0; z < lens.length; z++) {
        var ln = lens[z] | 0;
        var cnt = freq[lens[z]];
        if (cnt > bestCount || (cnt === bestCount && ln > bestLen)) { bestCount = cnt; bestLen = ln; }
      }
      modeRun[s2] = bestLen;
      modeCount[s2] = bestCount;
    }
    return { modeRun: modeRun, curRun: curRun, modeCount: modeCount };
  }
  function computeMomGapFromEvents(events) {
    var curRun = [];
    var runPeaks = [];
    for (var i = 0; i < events.length; i++) {
      var L = events[i];
      for (var s = 1; s < L; s++) {
        if (curRun[s] > 0) {
          if (!runPeaks[s]) runPeaks[s] = [];
          runPeaks[s].push(curRun[s]);
          curRun[s] = 0;
        }
      }
      curRun[L] = (curRun[L] || 0) + 1;
    }
    var modeRun = [];
    var modeCount = [];
    var maxLen = Math.max(curRun.length, runPeaks.length);
    for (var s2 = 1; s2 < maxLen; s2++) {
      var freq = {};
      if (runPeaks[s2]) {
        for (var q = 0; q < runPeaks[s2].length; q++) {
          var pv = runPeaks[s2][q];
          if (pv < 1) continue;
          freq[pv] = (freq[pv] || 0) + 1;
        }
      }
      var liveLen = curRun[s2] || 0;
      if (liveLen >= 1) freq[liveLen] = (freq[liveLen] || 0) + 1;
      var lens = Object.keys(freq);
      if (lens.length === 0) continue;
      var bestLen = 0, bestCount = 0;
      for (var z = 0; z < lens.length; z++) {
        var ln = lens[z] | 0;
        var cnt = freq[lens[z]];
        if (cnt > bestCount || (cnt === bestCount && ln > bestLen)) { bestCount = cnt; bestLen = ln; }
      }
      modeRun[s2] = bestLen;
      modeCount[s2] = bestCount;
    }
    return { modeRun: modeRun, curRun: curRun, modeCount: modeCount };
  }
  function scanOne(d) {
    const pair = d.pair, prices = d.prices, minC = d.minC, maxC = d.maxC;
    const baseTs = d.startTsUtc || 0;
    const preArr = d.pre || null;
    const preLen = preArr ? preArr.length : 0;
    const len = prices.length;
    const revs = [];
    const moms = [];
    const allDeadSigs = [];
    if (len === 0) return { revs: revs, moms: moms, dead: allDeadSigs };
    const sStart = 0;
    const sEnd = len;
    const rowColor = new Int8Array(maxC);
    const rowStreak = new Int16Array(maxC);
    const rowCol = new Int32Array(maxC);
    const shGMax = new Int16Array(maxC);
    const shRMax = new Int16Array(maxC);
    for (let c = minC; c <= maxC; c++) {
      rowColor.fill(0, 0, c);
      rowStreak.fill(0, 0, c);
      rowCol.fill(-2, 0, c);
      shGMax.fill(0, 0, c);
      shRMax.fill(0, 0, c);
      const shG = new Array(c).fill(null);
      const shR = new Array(c).fill(null);
      const termLenG = new Array(c).fill(null);
      const termLenR = new Array(c).fill(null);
      const survivalG = {};
      const survivalR = {};
      const deathLogG = {};
      const deathLogR = {};
      const dethronedCycle = [];
      for (let i = sStart; i < sEnd; i++) {
        const p = prices[i];
        let prevP = -1.0;
        if (i >= sStart + c) {
          prevP = prices[i - c];
        } else if (sStart === 0 && preArr) {
          const pk = preLen + i - c;
          if (pk >= 0 && pk < preLen) prevP = preArr[pk];
        }
        const col = Math.floor((baseTs + i) / c);
        const row = (baseTs + i) % c;
        let newColor, newStreak;
        if (prevP === -1.0) {
          if (p === -1.0) { newColor = 0; newStreak = 0; }
          else if (i < sStart + c) { newColor = 0; newStreak = 0; }
          else { newColor = 1; newStreak = 1; }
        } else if (p === -1.0) {
          newColor = 0; newStreak = 0;
        } else if (p > prevP) {
          newColor = 1;
          newStreak = (rowCol[row] === col - 1 && rowColor[row] === 1 && rowStreak[row] > 0) ? rowStreak[row] + 1 : 1;
        } else if (p < prevP) {
          newColor = 2;
          newStreak = (rowCol[row] === col - 1 && rowColor[row] === 2 && rowStreak[row] > 0) ? rowStreak[row] + 1 : 1;
        } else {
          newColor = rowColor[row];
          newStreak = 0;
        }
        if (rowStreak[row] > 0 && (newStreak <= 1 || newColor !== rowColor[row])) {
          const s = rowStreak[row];
          const isG = rowColor[row] === 1;
          if (isG) {
            if (!survivalG[row]) survivalG[row] = {};
            if (!deathLogG[row]) deathLogG[row] = {};
            for (let x = 1; x <= s; x++) {
              if (!deathLogG[row][x]) survivalG[row][x] = (survivalG[row][x] || 0) + 1;
            }
            if (!deathLogG[row][s]) {
              dethronedCycle.push({ pair: pair, c: c, r: row, s1: s, s2: s + 1, c1: survivalG[row][s], c2: 1, col: 'G', type: 'REV', dethroned: true, deathIdx: (rowCol[row] * c) + row - baseTs });
              deathLogG[row][s] = true;
            }
          } else {
            if (!survivalR[row]) survivalR[row] = {};
            if (!deathLogR[row]) deathLogR[row] = {};
            for (let x = 1; x <= s; x++) {
              if (!deathLogR[row][x]) survivalR[row][x] = (survivalR[row][x] || 0) + 1;
            }
            if (!deathLogR[row][s]) {
              dethronedCycle.push({ pair: pair, c: c, r: row, s1: s, s2: s + 1, c1: survivalR[row][s], c2: 1, col: 'R', type: 'REV', dethroned: true, deathIdx: (rowCol[row] * c) + row - baseTs });
              deathLogR[row][s] = true;
            }
          }
        }
        if (newStreak === 1 && rowStreak[row] > 0 && rowColor[row] !== 0 && rowCol[row] === col - 1) {
          const s = rowStreak[row];
          if (rowColor[row] === 1) {
            if (!shG[row]) shG[row] = {};
            shG[row][s] = (shG[row][s] || 0) + 1;
            if (s > shGMax[row]) shGMax[row] = s;
            if (!termLenG[row]) termLenG[row] = [];
            termLenG[row].push(s);
          } else {
            if (!shR[row]) shR[row] = {};
            shR[row][s] = (shR[row][s] || 0) + 1;
            if (s > shRMax[row]) shRMax[row] = s;
            if (!termLenR[row]) termLenR[row] = [];
            termLenR[row].push(s);
          }
        }
        rowColor[row] = newColor;
        rowStreak[row] = newStreak;
        rowCol[row] = col;
      }
      for (let row = 0; row < c; row++) {
        const liveLen = rowStreak[row];
        if (liveLen < 1 || rowColor[row] === 0) continue;
        if (rowColor[row] === 1) {
          if (!shG[row]) shG[row] = {};
          shG[row][liveLen] = (shG[row][liveLen] || 0) + 1;
          if (liveLen > shGMax[row]) shGMax[row] = liveLen;
          if (!termLenG[row]) termLenG[row] = [];
          termLenG[row].push(liveLen);
        } else {
          if (!shR[row]) shR[row] = {};
          shR[row][liveLen] = (shR[row][liveLen] || 0) + 1;
          if (liveLen > shRMax[row]) shRMax[row] = liveLen;
          if (!termLenR[row]) termLenR[row] = [];
          termLenR[row].push(liveLen);
        }
      }
      for (let r = 0; r < c; r++) {
        const gapDataG = computeGapMapFromEvents(termLenG[r] || []);
        const gapDataR = computeGapMapFromEvents(termLenR[r] || []);
        const gapMomG = computeMomGapFromEvents(termLenG[r] || []);
        const gapMomR = computeMomGapFromEvents(termLenR[r] || []);
        for (let ci = 0; ci < 2; ci++) {
          const raw = ci === 0 ? shG[r] : shR[r];
          const maxS = ci === 0 ? shGMax[r] : shRMax[r];
          if (!raw || maxS === 0) continue;
          const colColor = ci === 0 ? 'G' : 'R';
          const gapMap = ci === 0 ? gapDataG.modeRun : gapDataR.modeRun;
          const curGapMap = ci === 0 ? gapDataG.curRun : gapDataR.curRun;
          const gapCountMap = ci === 0 ? gapDataG.modeCount : gapDataR.modeCount;
          const cum = applyCumulative(raw, maxS);
          for (const sStr in cum) {
            const s = sStr | 0;
            if (s < 1) continue;
            const c1 = cum[s];
            const c2 = cum[s + 1] || 0;
            const pctRev = c1 > 0 ? 100 - Math.round((c2 / c1) * 100) : 0;
            const pctMom = c1 > 0 ? Math.round((c2 / c1) * 100) : 0;
            const gap = gapMap[s] || 0;
            const curGap = curGapMap[s] || 0;
            const gapCount = (gapCountMap && gapCountMap[s]) || 0;
            revs.push({ pair: pair, c: c, r: r, s1: s, s2: s + 1, c1: c1, c2: c2, pct: pctRev, col: colColor, type: 'REV', gap: gap, curGap: curGap, gapCount: gapCount });
            if (c1 > 1) {
              var momGapD = ci === 0 ? gapMomG : gapMomR;
              moms.push({ pair: pair, c: c, r: r, s1: s, s2: s + 1, c1: c1, c2: c2, pct: pctMom, col: colColor, type: 'MOM', gap: momGapD.modeRun[s] || 0, curGap: momGapD.curRun[s] || 0, gapCount: (momGapD.modeCount && momGapD.modeCount[s]) || 0 });
            }
          }
        }
      }
      dethronedCycle.sort(function (a, b) { return b.deathIdx - a.deathIdx; });
      const topDead = dethronedCycle.slice(0, 100);
      for (let i = 0; i < topDead.length; i++) allDeadSigs.push(topDead[i]);
    }
    return { revs: revs, moms: moms, dead: allDeadSigs };
  }
  wt.parentPort.on("message", function (m) {
    try {
      const r = scanOne(m);
      wt.parentPort.postMessage({ id: m.id, pair: m.pair, json: JSON.stringify(r) });
    } catch (e) {
      wt.parentPort.postMessage({ id: m.id, pair: m.pair, error: String(e && e.stack ? e.stack : e) });
    }
  });
}

function failScanJobs(w, err) {
  for (const id in scanJobs) {
    if (scanJobs[id].w === w) {
      const job = scanJobs[id];
      delete scanJobs[id];
      job.reject(err);
    }
  }
}

function getScanWorker() {
  if (scanWorker) return scanWorker;
  const w = new Worker("(" + scanWorkerMain.toString() + ")()", { eval: true });
  w.on("message", m => {
    const job = scanJobs[m.id];
    if (!job) return;
    delete scanJobs[m.id];
    if (m.error) job.reject(new Error(m.error));
    else job.resolve(m.json);
  });
  w.on("error", err => {
    logEvent("SCAN_WORKER_ERROR", err && err.stack ? err.stack : String(err));
    if (scanWorker === w) scanWorker = null;
    failScanJobs(w, err instanceof Error ? err : new Error(String(err)));
  });
  w.on("exit", code => {
    if (scanWorker === w) scanWorker = null;
    failScanJobs(w, new Error("scan worker exited with code " + code));
  });
  w.unref();
  scanWorker = w;
  return w;
}

function runScanJob(msg, transfer) {
  return new Promise((resolve, reject) => {
    var w;
    try {
      w = getScanWorker();
    } catch (e) {
      reject(e);
      return;
    }
    const id = ++scanJobId;
    const timer = setTimeout(() => {
      const job = scanJobs[id];
      if (!job) return;
      delete scanJobs[id];
      if (scanWorker === w) scanWorker = null;
      try { w.terminate(); } catch {}
      reject(new Error("scan job timeout"));
    }, 60000);
    scanJobs[id] = {
      w: w,
      resolve: v => { clearTimeout(timer); resolve(v); },
      reject: e => { clearTimeout(timer); reject(e); }
    };
    msg.id = id;
    try {
      w.postMessage(msg, transfer);
    } catch (e) {
      delete scanJobs[id];
      clearTimeout(timer);
      reject(e);
    }
  });
}

async function buildScan(pairs, minC, maxC, start, dur) {
  const t0 = Date.now();
  const dayAtStart = activeDayEpoch;
  const len = dur + 1;
  const startIdx = start - dayAtStart;
  const parts = [];
  for (const pair of pairs) {
    const arr = dayTicks[pair];
    const prices = new Float64Array(len).fill(-1);
    const hi = Math.min(DAY_SECS, startIdx + len);
    if (hi > startIdx) prices.set(arr.subarray(startIdx, hi), 0);
    let has = false;
    for (let i = 0; i < len; i++) {
      if (prices[i] !== -1) { has = true; break; }
    }
    if (!has) {
      parts.push(JSON.stringify(pair) + ':{"revs":[],"moms":[],"dead":[]}');
      continue;
    }
    const pre = new Float64Array(PRE_ROLL_SECS).fill(-1);
    for (let k = 0; k < PRE_ROLL_SECS; k++) {
      const j = startIdx - PRE_ROLL_SECS + k;
      if (j >= 0) pre[k] = arr[j];
      else if (j >= -PRE_ROLL_SECS) pre[k] = preTicks[pair][PRE_ROLL_SECS + j];
    }
    const json = await runScanJob(
      { pair: pair, prices: prices, pre: pre, minC: minC, maxC: maxC, startTsUtc: start },
      [prices.buffer, pre.buffer]
    );
    parts.push(JSON.stringify(pair) + ":" + json);
  }
  if (activeDayEpoch !== dayAtStart) throw new Error("day rollover during scan");
  const ms = Date.now() - t0;
  const body = '{"ok":true,"day":' + dayAtStart + ',"start":' + start + ',"dur":' + dur + ',"minC":' + minC + ',"maxC":' + maxC + ',"scanMs":' + ms + ',"pairs":{' + parts.join(",") + "}}";
  const gz = await new Promise((resolve, reject) => {
    zlib.gzip(body, { level: 1 }, (err, out) => (err ? reject(err) : resolve(out)));
  });
  lastScanInfo = { at: new Date().toISOString(), ms: ms, pairs: pairs.length, minC: minC, maxC: maxC, dur: dur, jsonBytes: body.length, gzBytes: gz.length };
  scanBusyMsTotal += ms;
  scanCount++;
  if (ms > 20000) logEvent("SCAN_SLOW", "Server scan took " + ms + "ms for " + pairs.length + " pairs (cycles " + minC + "-" + maxC + ")");
  return gz;
}

function sendGz(res, buf) {
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Encoding": "gzip",
    "Cache-Control": "no-store",
    "Content-Length": String(buf.length)
  });
  res.end(buf);
}

async function handleScan(req, res, urlObj) {
  if (!isAuthorized(req, urlObj)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }
  checkRollover();
  const sp = urlObj.searchParams;
  const pairs = Array.from(new Set((sp.get("pairs") || "").split(",").filter(p => PAIR_SET.has(p)))).sort();
  const minC = parseInt(sp.get("minC"), 10);
  const maxC = parseInt(sp.get("maxC"), 10);
  const start = parseInt(sp.get("start"), 10);
  const dur = parseInt(sp.get("dur"), 10);
  if (!pairs.length || !(minC >= 1) || !(maxC >= minC) || maxC > 3600 || !(dur >= 10 && dur <= DAY_SECS) || !Number.isFinite(start)) {
    sendJson(res, 400, { ok: false, reason: "bad parameters" });
    return;
  }
  if (start < activeDayEpoch || start - activeDayEpoch >= DAY_SECS) {
    sendJson(res, 200, { ok: false, reason: "session is not in the active day" });
    return;
  }
  if (!wsConnected || backfillState.active) {
    sendJson(res, 200, { ok: false, reason: wsConnected ? "server is back-filling" : "server feed is down" });
    return;
  }
  if ((maxC - minC + 1) * pairs.length * dur > SCAN_MAX_WORK) {
    sendJson(res, 200, { ok: false, reason: "range too large for the server" });
    return;
  }
  const key = pairs.join(",") + "|" + minC + "|" + maxC + "|" + start + "|" + dur + "|" + activeDayEpoch;
  if (scanCache.buf && scanCache.key === key && Date.now() - scanCache.t < SCAN_CACHE_MS) {
    sendGz(res, scanCache.buf);
    return;
  }
  if (scanInflight && scanInflight.key !== key) {
    sendJson(res, 503, { ok: false, reason: "busy" });
    return;
  }
  if (!scanInflight) {
    const promise = buildScan(pairs, minC, maxC, start, dur).then(buf => {
      scanCache = { key: key, t: Date.now(), buf: buf };
      return buf;
    });
    const cur = { key: key, promise: promise };
    scanInflight = cur;
    promise.then(
      () => { if (scanInflight === cur) scanInflight = null; },
      () => { if (scanInflight === cur) scanInflight = null; }
    );
  }
  const out = await scanInflight.promise;
  sendGz(res, out);
}

// ── load monitor (CPU / memory / event-loop lag / scan duty) ──
const LOAD_CPU_LIMIT = parseFloat(process.env.LOAD_CPU_LIMIT) || 0.1;       // Render free tier ~0.1 CPU
const LOAD_MEM_LIMIT_MB = parseFloat(process.env.LOAD_MEM_LIMIT_MB) || 512; // Render free tier 512 MB
const LOAD_SCAN_INTERVAL_MS = 30000;
var scanBusyMsTotal = 0;
var scanCount = 0;
const loadSamples = [];
var loadPrevCpu = process.cpuUsage();
var loadPrevAt = Date.now();
var loadPrevScanBusy = 0;
var loadLagMax = 0;
var loadLagPrev = Date.now();

setInterval(() => {
  const now = Date.now();
  const lag = Math.max(0, now - loadLagPrev - 1000);
  loadLagPrev = now;
  if (lag > loadLagMax) loadLagMax = lag;
}, 1000).unref();

setInterval(() => {
  const now = Date.now();
  const wallMs = now - loadPrevAt;
  if (wallMs <= 0) return;
  const cpu = process.cpuUsage();
  const cpuMicros = (cpu.user - loadPrevCpu.user) + (cpu.system - loadPrevCpu.system);
  const cpuPct = cpuMicros / (wallMs * 1000) * 100; // % of one full core (includes scan worker thread)
  const busy = scanBusyMsTotal - loadPrevScanBusy;
  const mem = process.memoryUsage();
  loadSamples.push({
    t: now,
    cpuPct: cpuPct,
    scanBusyPct: Math.min(100, busy / wallMs * 100),
    lagMaxMs: loadLagMax,
    rssMB: mem.rss / 1048576
  });
  if (loadSamples.length > 36) loadSamples.shift(); // keep ~3 minutes
  loadPrevCpu = cpu;
  loadPrevAt = now;
  loadPrevScanBusy = scanBusyMsTotal;
  loadLagMax = 0;
}, 5000).unref();

function getLoadInfo() {
  const mem = process.memoryUsage();
  const n = loadSamples.length;
  const last = n ? loadSamples[n - 1] : null;
  var avgCpu = 0, peakCpu = 0, avgBusy = 0, peakLag = 0;
  for (const s of loadSamples) {
    avgCpu += s.cpuPct;
    avgBusy += s.scanBusyPct;
    if (s.cpuPct > peakCpu) peakCpu = s.cpuPct;
    if (s.lagMaxMs > peakLag) peakLag = s.lagMaxMs;
  }
  if (n) { avgCpu /= n; avgBusy /= n; }
  const limitPct = LOAD_CPU_LIMIT * 100;
  const cpuSat = limitPct > 0 ? avgCpu / limitPct * 100 : 0;
  const memPct = mem.rss / 1048576 / LOAD_MEM_LIMIT_MB * 100;
  const scanMs = lastScanInfo ? lastScanInfo.ms : 0;
  const scanDuty = scanMs / LOAD_SCAN_INTERVAL_MS * 100;
  var verdict = "OK";
  if (cpuSat > 60 || memPct > 65 || scanDuty > 50 || peakLag > 500) verdict = "HIGH";
  if (cpuSat > 85 || memPct > 85 || scanDuty > 90 || peakLag > 2000) verdict = "OVERLOADED";
  const r1 = x => Math.round(x * 10) / 10;
  return {
    verdict: verdict,
    windowSec: n * 5,
    cpuNowPctOfCore: last ? r1(last.cpuPct) : 0,
    cpuAvgPctOfCore: r1(avgCpu),
    cpuPeakPctOfCore: r1(peakCpu),
    cpuLimitCores: LOAD_CPU_LIMIT,
    cpuFreeTierUsedPct: r1(cpuSat),
    rssMB: r1(mem.rss / 1048576),
    heapUsedMB: r1(mem.heapUsed / 1048576),
    externalMB: r1((mem.external + mem.arrayBuffers) / 1048576),
    memLimitMB: LOAD_MEM_LIMIT_MB,
    memUsedPct: r1(memPct),
    eventLoopLagPeakMs: Math.round(peakLag),
    scanCount: scanCount,
    lastScanMs: scanMs,
    scanDutyPctOf30s: r1(scanDuty),
    scanBusyAvgPct: r1(avgBusy)
  };
}

function isAuthorized(req, urlObj) {
  if (!API_TOKEN) return true;
  const qToken = urlObj.searchParams.get("token");
  if (qToken === API_TOKEN) return true;

  const hToken = req.headers["x-api-token"];
  if (hToken === API_TOKEN) return true;

  const auth = req.headers["authorization"] || "";
  if (auth === API_TOKEN || auth === `Bearer ${API_TOKEN}`) return true;

  const ref = req.headers["referer"] || "";
  if (ref) {
    try {
      const refUrl = new URL(ref);
      if (refUrl.searchParams.get("token") === API_TOKEN) return true;
    } catch {}
  }
  return false;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = urlObj.pathname;

  res.setHeader("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Api-Token");
  res.setHeader("Access-Control-Expose-Headers", "X-Day-Epoch, X-From-Index, X-To-Index, X-Pre-Length");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && pathname === "/ping") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end("ok");
    return;
  }

  if (req.method === "GET" && pathname === "/status") {
    if (!isAuthorized(req, urlObj)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }
    checkRollover();
    sendJson(res, 200, {
      uptime: Math.floor(process.uptime()),
      lastRestart: startedAtIso,
      lastRestartEpoch: startedAtEpoch,
      activeDayEpoch,
      feedState: getFeedState(),
      wsConnected,
      subscribedCount: subscribedPairs.size,
      totalPairs: ALL_PAIRS.length,
      backfill: backfillState,
      backfillSeq,
      scan: lastScanInfo,
      load: getLoadInfo(),
      lastTickTime,
      recentEvents
    });
    return;
  }

  if (req.method === "GET" && pathname === "/scan") {
    handleScan(req, res, urlObj).catch(err => {
      logEvent("SCAN_ERROR", err && err.stack ? err.stack : String(err));
      if (!res.headersSent) sendJson(res, 500, { ok: false, reason: "scan failed" });
    });
    return;
  }

  if (req.method === "GET" && pathname === "/ticks") {
    if (!isAuthorized(req, urlObj)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }
    const pair = urlObj.searchParams.get("pair") || "";
    if (!PAIR_SET.has(pair)) {
      sendJson(res, 400, { error: "Invalid pair" });
      return;
    }

    checkRollover();
    const curSec = nowSec();
    const nowIdx = Math.max(0, Math.min(DAY_SECS - 1, curSec - activeDayEpoch));

    var from = parseInt(urlObj.searchParams.get("from") || "0", 10);
    if (!Number.isFinite(from) || from < 0) from = 0;

    const clientDay = urlObj.searchParams.get("day");
    if (clientDay && Number(clientDay) !== activeDayEpoch) {
      from = 0;
    }
    if (from > nowIdx) from = nowIdx;

    const includePre = from === 0 && urlObj.searchParams.get("pre") === "1";
    const preLen = includePre ? PRE_ROLL_SECS : 0;
    const sliceLen = Math.max(0, nowIdx - from + 1);
    const out = new Float64Array(preLen + sliceLen);

    if (preLen) {
      out.set(preTicks[pair], 0);
    }
    if (sliceLen > 0) {
      out.set(dayTicks[pair].subarray(from, nowIdx + 1), preLen);
    }

    const rawBuf = Buffer.from(out.buffer, out.byteOffset, out.byteLength);
    zlib.gzip(rawBuf, (err, gzBuf) => {
      if (err) {
        sendJson(res, 500, { error: "Compression error" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Encoding": "gzip",
        "Cache-Control": "no-store",
        "X-Day-Epoch": String(activeDayEpoch),
        "X-From-Index": String(from),
        "X-To-Index": String(nowIdx),
        "X-Pre-Length": String(preLen)
      });
      res.end(gzBuf);
    });
    return;
  }

  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    const filePath = path.join(__dirname, "public", "index.html");
    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("public/index.html not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache"
      });
      res.end(content);
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

// ── graceful shutdown ──
function handleShutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  logEvent("SIGTERM", `${sig} received - flushing state and closing connections`);
  clearWsTimers();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (liveWs) {
    try { liveWs.close(1000, "Server shutting down"); } catch {}
  }
  store.save(activeDayEpoch, ALL_PAIRS).finally(() => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

process.on("SIGTERM", () => handleShutdown("SIGTERM"));
process.on("SIGINT", () => handleShutdown("SIGINT"));

// ── startup sequence ──
(async () => {
  logEvent("START", `Starting WALLSPECTRUM server on port ${PORT} for activeDayEpoch ${activeDayEpoch}`);
  try {
    await store.load(activeDayEpoch);
  } catch (err) {
    logEvent("STORE_ERROR", `Initial store load failed: ${err.message}`);
  }
  server.listen(PORT, () => {
    logEvent("HTTP_READY", `HTTP server listening on http://localhost:${PORT}`);
    connectLiveWs(false);
    runBackfill("startup", null);
  });
})();