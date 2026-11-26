"use strict";

const DAY_SECS = 86400;
const PRE_ROLL_SECS = 900;

function applyCumulative(hist, maxS) {
  let cum = 0;
  const res = {};
  for (let i = maxS; i >= 1; i--) {
    const v = hist[i];
    if (v) cum += v;
    if (cum > 0) res[i] = cum;
  }
  return res;
}

function ssDefSel(nowEpoch, ssMin) {
  if (ssMin <= 0) return 0;
  const n = Math.max(1, Math.round(1440 / ssMin));
  const ss = Math.round(DAY_SECS / n);
  const ix = Math.floor((nowEpoch % DAY_SECS) / ss);
  return Math.max(1, Math.min(n, ix + 1));
}

function ssBounds(ssMin, sess) {
  const n = ssMin > 0 ? Math.max(1, Math.round(1440 / ssMin)) : 1;
  if (ssMin <= 0 || sess < 1 || sess > n) return { a: 0, b: DAY_SECS + 1, n };
  const ss = Math.round(DAY_SECS / n);
  return { a: (sess - 1) * ss, b: sess === n ? DAY_SECS + 1 : sess * ss + 1, n };
}

function ssRow(r, c, startTsUtc, ssMin, sess) {
  const a = ssBounds(ssMin, sess).a;
  return a + ((((r - ((startTsUtc || 0) + a)) % c) + c) % c);
}

function buildPre(a, dayArr, preArr) {
  const out = new Float64Array(PRE_ROLL_SECS).fill(-1.0);
  for (let k = 0; k < PRE_ROLL_SECS; k++) {
    const ix = a - PRE_ROLL_SECS + k;
    if (ix >= 0 && ix < dayArr.length) out[k] = dayArr[ix];
    else if (ix < 0 && preArr && ix + PRE_ROLL_SECS >= 0 && ix + PRE_ROLL_SECS < preArr.length) {
      out[k] = preArr[ix + PRE_ROLL_SECS];
    }
  }
  return out;
}

function scanPairSlice(pair, dayArr, preArr, activeDayEpoch, minC, maxC, ssMin, sess) {
  const SB = ssBounds(ssMin, sess);
  const sliceLen = SB.b - SB.a;
  const prices = new Float64Array(sliceLen).fill(-1.0);
  const copyEnd = Math.min(SB.b, dayArr.length);
  if (copyEnd > SB.a) prices.set(dayArr.subarray(SB.a, copyEnd), 0);

  const pre = SB.a > 0 ? buildPre(SB.a, dayArr, preArr) : preArr;
  const baseTs = activeDayEpoch + SB.a;
  const preLen = pre ? pre.length : 0;
  const len = prices.length;
  if (!len) return { revs: [], moms: [] };

  const rowColor = new Int8Array(maxC);
  const rowStreak = new Int16Array(maxC);
  const rowCol = new Int32Array(maxC);
  const nG1 = new Int32Array(maxC);
  const nG2 = new Int32Array(maxC);
  const nR1 = new Int32Array(maxC);
  const nR2 = new Int32Array(maxC);
  const fG1 = new Float64Array(maxC);
  const fR1 = new Float64Array(maxC);
  const revs = [];
  const moms = [];

  for (let c = minC; c <= maxC; c++) {
    rowColor.fill(0, 0, c);
    rowStreak.fill(0, 0, c);
    rowCol.fill(-2, 0, c);
    nG1.fill(0, 0, c);
    nG2.fill(0, 0, c);
    nR1.fill(0, 0, c);
    nR2.fill(0, 0, c);
    fG1.fill(0, 0, c);
    fR1.fill(0, 0, c);

    for (let i = 0; i < len; i++) {
      const p = prices[i];
      let prevP = -1.0;
      if (i >= c) prevP = prices[i - c];
      else if (pre) {
        const pk = preLen + i - c;
        if (pk >= 0 && pk < preLen) prevP = pre[pk];
      }
      const col = Math.floor((baseTs + i) / c);
      const row = (baseTs + i) % c;
      let newColor, newStreak;
      if (prevP === -1.0) {
        newColor = (p === -1.0 || i < c) ? 0 : 1;
        newStreak = newColor;
      } else if (p === -1.0) {
        newColor = 0;
        newStreak = 0;
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

      if (newStreak === 1 && rowStreak[row] > 0 && rowColor[row] !== 0 && rowCol[row] === col - 1) {
        const s = rowStreak[row];
        if (rowColor[row] === 1) {
          nG1[row]++;
          if (s >= 2) nG2[row]++;
        } else {
          nR1[row]++;
          if (s >= 2) nR2[row]++;
        }
      }
      if (newStreak === 1 && newColor !== 0) {
        if (newColor === 1) {
          if (fG1[row] === 0) fG1[row] = baseTs + i;
        } else if (fR1[row] === 0) {
          fR1[row] = baseTs + i;
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
        nG1[row]++;
        if (liveLen >= 2) nG2[row]++;
      } else {
        nR1[row]++;
        if (liveLen >= 2) nR2[row]++;
      }
    }

    for (let r = 0; r < c; r++) {
      for (let ci = 0; ci < 2; ci++) {
        const c1 = ci === 0 ? nG1[r] : nR1[r];
        if (c1 < 1) continue;
        const c2 = ci === 0 ? nG2[r] : nR2[r];
        const colColor = ci === 0 ? "G" : "R";
        const fs = (ci === 0 ? fG1[r] : fR1[r]) || 0;
        const pctRev = 100 - Math.round((c2 / c1) * 100);
        const pctMom = Math.round((c2 / c1) * 100);
        if (pctRev >= MIN_SIG_PCT) revs.push({ pair, c, r, s1: 1, s2: 2, c1, c2, pct: pctRev, col: colColor, type: "REV", sess, fs });
        if (pctMom >= MIN_SIG_PCT) moms.push({ pair, c, r, s1: 1, s2: 2, c1, c2, pct: pctMom, col: colColor, type: "MOM", sess, fs });
      }
    }
  }
  return { revs, moms };
}

function wsWins(x) {
  return x.type === "MOM" ? (+x.c2 || 0) : Math.max(0, (+x.c1 || 0) - (+x.c2 || 0));
}

function wsC2(x) {
  return x.type === "MOM" ? Math.max(0, (+x.c1 || 0) - (+x.c2 || 0)) : (+x.c2 || 0);
}

function wsNet(x) {
  return wsWins(x) - wsC2(x);
}

function wsFirst(x) {
  return (x && (x.first || x.fs)) ? (x.first || x.fs) : Number.MAX_SAFE_INTEGER;
}

function wsCmp(a, b) {
  return (wsPctOf(b) - wsPctOf(a)) || (wsNet(b) - wsNet(a)) || (wsC2(a) - wsC2(b)) || (wsWins(b) - wsWins(a)) || (wsFirst(a) - wsFirst(b)) || (a.c - b.c) || (a.r - b.r) || (a.s1 - b.s1) || (a.type === b.type ? 0 : (a.type === "REV" ? -1 : 1)) || String(a.pair || "").localeCompare(String(b.pair || ""));
}

const TOP_LIMIT = 16;
const LOCK_SLOTS = 8;
const LOCKED_LVL = 1;
const MIN_SIG_PCT = 80;

function wsPctOf(x) {
  return +(x && x.pct) || 0;
}

function copySig(x) {
  return x ? Object.assign({}, x) : null;
}

function wsRank(a, b) {
  return (wsPctOf(b) - wsPctOf(a))
    || (wsNet(b) - wsNet(a))
    || (wsC2(a) - wsC2(b))
    || (wsWins(b) - wsWins(a))
    || (wsFirst(a) - wsFirst(b));
}

function wsBeats(a, b) {
  var ap = wsPctOf(a), bp = wsPctOf(b);
  if (ap !== bp) return ap > bp;
  var an = wsNet(a), bn = wsNet(b);
  if (an !== bn) return an > bn;
  var al = wsC2(a), bl = wsC2(b);
  if (al !== bl) return al < bl;
  return wsWins(a) > wsWins(b);
}

function wsBuild(list, lvl, topLimit) {
  var bestByPair = {};
  for (var i = 0; i < list.length; i++) {
    var x = list[i];
    if (!x || !x.pair || (lvl && +x.s1 !== lvl)) continue;
    if (x.type !== "REV" && x.type !== "MOM") continue;
    if (wsWins(x) <= 0 || wsNet(x) < 0) continue;
    var k = x.pair;
    if (!bestByPair[k] || wsRank(x, bestByPair[k]) < 0) {
      bestByPair[k] = x;
    }
  }
  var top = Object.values(bestByPair);
  top.sort(wsRank);
  return top.slice(0, Math.max(1, Number(topLimit) || TOP_LIMIT));
}

function wsBuildRev(list, lvl, topLimit) {
  var bestByPair = {};
  for (var i = 0; i < list.length; i++) {
    var x = list[i];
    if (!x || x.type !== "REV" || !x.pair) continue;
    if (lvl && +x.s1 !== lvl) continue;
    if (!bestByPair[x.pair] || wsRank(x, bestByPair[x.pair]) < 0) {
      bestByPair[x.pair] = x;
    }
  }
  var top = Object.values(bestByPair);
  top.sort(wsRank);
  return top.slice(0, Math.max(1, Number(topLimit) || TOP_LIMIT));
}

function wsIsBuy(x) {
  return !!x && ((x.type === "REV" && x.col === "R") || (x.type === "MOM" && x.col === "G"));
}

function wsPickLocks(buyList, sellList, slots) {
  var bSrc = Array.isArray(buyList) ? buyList : [];
  var sSrc = Array.isArray(sellList) ? sellList : [];
  var all = bSrc.concat(sSrc);
  var perPair = {};

  for (var i = 0; i < all.length; i++) {
    var x = all[i];
    if (!x || !x.pair) continue;
    if (!perPair[x.pair] || wsRank(x, perPair[x.pair]) < 0) {
      perPair[x.pair] = x;
    }
  }

  var pairLocks = Object.values(perPair);
  pairLocks.sort(wsRank);
  var lim = Math.max(1, Number(slots) || LOCK_SLOTS);
  var topLocks = pairLocks.slice(0, lim);
  var globalBest = topLocks.length ? topLocks[0] : null;
  var buyLocks = [];
  var sellLocks = [];
  for (var j = 0; j < topLocks.length; j++) {
    if (wsIsBuy(topLocks[j])) buyLocks.push(topLocks[j]);
    else sellLocks.push(topLocks[j]);
  }

  return {
    pairLocks: pairLocks,
    topLocks: topLocks,
    globalBest: globalBest,
    buyLocks: buyLocks,
    sellLocks: sellLocks
  };
}

function wsPinLocksTop(list, locks, topLimit) {
  var lim = Math.max(1, Number(topLimit) || TOP_LIMIT);
  if (!locks || !locks.length) return list.slice(0, lim);
  var lockedKeys = {};
  for (var i = 0; i < locks.length; i++) {
    if (locks[i]) lockedKeys[locks[i].pair] = 1;
  }
  var head = locks.slice();
  var rest = [];
  for (var j = 0; j < list.length; j++) {
    if (!lockedKeys[list[j].pair]) rest.push(list[j]);
  }
  return head.concat(rest).slice(0, lim);
}

function tcLastReal(pr, from) {
  for (let i = Math.min(from, pr.length - 1); i >= 0; i--) {
    if (pr[i] !== -1) return i;
  }
  return -1;
}

function preRef(preArr, k) {
  if (!preArr) return -1;
  const j = preArr.length + k;
  return (j >= 0 && j < preArr.length) ? preArr[j] : -1;
}

function evalSignalPlan(sig, prices, preArr, lim, sEnd, activeDayEpoch, ssMin) {
  const SB = ssBounds(ssMin, sig.sess || 0);
  const c = sig.c;
  const r = ssRow(sig.r, c, activeDayEpoch, ssMin, sig.sess || 0);
  const colCode = sig.col === "G" ? 1 : 2;
  let color = 0, streak = 0, lastI = -1;
  const maxLim = Math.min(lim, SB.b - 1, prices.length - 1);
  const maxEnd = Math.min(sEnd, SB.b);

  for (let i = r; i <= maxLim; i += c) {
    const p = prices[i];
    const q = i >= c ? prices[i - c] : preRef(preArr, i - c);
    let nc, ns;
    if (q === -1) nc = ns = (p === -1 || i - SB.a < c) ? 0 : 1;
    else if (p === -1) nc = ns = 0;
    else if (p > q) { nc = 1; ns = (color === 1 && streak > 0) ? streak + 1 : 1; }
    else if (p < q) { nc = 2; ns = (color === 2 && streak > 0) ? streak + 1 : 1; }
    else { nc = color; ns = 0; }
    color = nc;
    streak = ns;
    lastI = i;
  }

  if (color === colCode && streak === sig.s1 && lastI >= 0) {
    return { kind: "FIRED", idx: lastI, need: 0 };
  }
  if (color === colCode && streak > sig.s1) {
    return { kind: "NONE", idx: -1, need: 0, missed: true, streak };
  }
  const need = Math.max(1, sig.s1 - (color === colCode ? streak : 0));
  const idx = (lastI < 0 ? r : lastI + c) + (need - 1) * c;
  if (idx >= maxEnd) return { kind: "NONE", idx: -1, need: 0 };
  return { kind: "FUT", idx, need };
}

const SLICE_CACHE = {};
const SLICE_MAX_AGE_MS = 4000;

function cachedSlice(pair, dayArr, preArr, dayEpoch, minC, maxC, ssMin, sess) {
  const ck = pair + "|" + minC + "|" + maxC + "|" + ssMin;
  const sig = dayEpoch + "|" + sess;
  const e = SLICE_CACHE[ck];
  if (e && e.sig === sig && Date.now() - e.ts < SLICE_MAX_AGE_MS) return e.res;
  const res = scanPairSlice(pair, dayArr, preArr, dayEpoch, minC, maxC, ssMin, sess);
  SLICE_CACHE[ck] = { sig: sig, ts: Date.now(), res: res };
  return res;
}

function createScanner(ctx) {
  const groupName = ctx.group || "DRV";
  const disableLock = !!(ctx.disableLock || groupName === "ALL");
  const sv = (ctx.settings && ctx.settings.values) || {};
  const cfg = {
    minC: sv.minC != null ? sv.minC : 132,
    maxC: sv.maxC != null ? sv.maxC : 132,
    scanInt: sv.scanInt != null ? sv.scanInt : 60,
    ssMin: sv.ssMin != null ? sv.ssMin : 60,
    lvl: LOCKED_LVL,
    r0Only: sv.r0Only != null ? !!sv.r0Only : false,
    lockMinPct: sv.lockMinPct != null ? sv.lockMinPct : 60,
    lockMinC1: sv.lockMinC1 != null ? sv.lockMinC1 : 10,
    topLimit: sv.topLimit != null ? sv.topLimit : TOP_LIMIT,
    lockSlots: disableLock ? 0 : LOCK_SLOTS
  };

  const staggerMs = groupName === "MTL" ? 2000 : 0;
  const state = {
    pending: false,
    lastScanAt: 0,
    nextScanAt: Date.now() + cfg.scanInt * 1000 + staggerMs,
    ssSel: ssDefSel(ctx.nowSec(), cfg.ssMin),
    buyTop: [],
    sellTop: [],
    lock: { buy: null, sell: null, buys: [], sells: [] },
    scannedPairs: 0,
    lastDurationMs: 0
  };

  let lastDayEpoch = ctx.getDayEpoch();
  let lastSession = state.ssSel;
  let seen = {};
  let heldBuy = null;
  let heldSell = null;
  let heldLock = null;
  let rescanQueued = false;

  function syncFromSettings(changed, vals, prev, opts) {
    if (!vals) return;
    cfg.minC = vals.minC != null ? vals.minC : cfg.minC;
    cfg.maxC = vals.maxC != null ? vals.maxC : cfg.maxC;
    cfg.scanInt = vals.scanInt != null ? vals.scanInt : cfg.scanInt;
    cfg.ssMin = vals.ssMin != null ? vals.ssMin : cfg.ssMin;
    cfg.lvl = LOCKED_LVL;
    cfg.r0Only = vals.r0Only != null ? !!vals.r0Only : cfg.r0Only;
    cfg.lockMinPct = vals.lockMinPct != null ? vals.lockMinPct : cfg.lockMinPct;
    cfg.lockMinC1 = vals.lockMinC1 != null ? vals.lockMinC1 : cfg.lockMinC1;
    cfg.topLimit = vals.topLimit != null ? vals.topLimit : cfg.topLimit;

    const ruleKeys = ["minC", "maxC", "ssMin", "lvl", "r0Only", "lockMinPct", "lockMinC1", "topLimit"];
    const rulesChanged = !changed || ruleKeys.some(k => Object.prototype.hasOwnProperty.call(changed, k));
    if (rulesChanged) {
      seen = {};
      heldBuy = null;
      heldSell = null;
      heldLock = null;
      state.ssSel = ssDefSel(ctx.nowSec(), cfg.ssMin);
      lastSession = state.ssSel;
    }
    if (!changed || Object.prototype.hasOwnProperty.call(changed, "scanInt")) {
      state.nextScanAt = (state.lastScanAt || Date.now()) + cfg.scanInt * 1000;
    }
    if (rulesChanged && !(opts && opts.noRescan)) {
      const hasData = ctx.pairs.some(p => ctx.filled[p] > 0 && ctx.bfPending[p] === 0);
      if (hasData) {
        if (state.pending) rescanQueued = true;
        else runScan("settings");
      }
    }
  }

  if (ctx.settings && typeof ctx.settings.onChange === "function") {
    ctx.settings.onChange(syncFromSettings);
  }

  function sigKey(x) {
    return x.pair + "|" + x.c + "|" + x.r + "|" + x.s1 + "|" + x.col + "|" + x.type + "|S" + (x.sess || 0);
  }

  function stampAndSort(buyList, sellList, now) {
    const next = {};
    const stamp = function (list) {
      for (let i = 0; i < list.length; i++) {
        const x = list[i];
        const k = sigKey(x);
        const o = seen[k];
        x.first = x.fs ? x.fs : (o ? o.first : (x.first || now));
        next[k] = { first: x.first };
      }
      list.sort(wsRank);
    };
    stamp(buyList);
    stamp(sellList);
    seen = next;
  }

  function withAge(x, nowS) {
    return x ? Object.assign({}, x, { age: Math.max(0, nowS - (x.first || nowS)) }) : null;
  }

  function lockOk(x) {
    return !!x && (x.type === "REV" || x.type === "MOM") && (+x.s1 === LOCKED_LVL) &&
      wsWins(x) > 0 && wsNet(x) >= 0 &&
      (+x.c1 || 0) > 0 && (+x.pct || 0) >= Math.max(MIN_SIG_PCT, cfg.lockMinPct);
  }

  function holdLock(held, all, now) {
    var cur = null, best = null, hk = held ? sigKey(held) : "";
    for (var i = 0; i < all.length; i++) {
      var x = all[i];
      if (!lockOk(x)) continue;
      if (hk && !cur && sigKey(x) === hk) cur = x;
      if (!best || wsRank(x, best) < 0) best = x;
    }
    if (cur) {
      cur.first = cur.fs ? cur.fs : (held.first || now);
      if (best && best !== cur && wsBeats(best, cur)) cur = best;
    } else {
      cur = best;
    }
    if (!cur) return null;
    if (!cur.first) cur.first = cur.fs || now;
    return copySig(cur);
  }

  function resetForRollover() {
    seen = {};
    heldBuy = null;
    heldSell = null;
    heldLock = null;
    state.buyTop = [];
    state.sellTop = [];
    state.lock = { buy: null, sell: null, buys: [], sells: [] };
    state.scannedPairs = 0;
    state.ssSel = ssDefSel(ctx.nowSec(), cfg.ssMin);
    lastSession = state.ssSel;
    lastDayEpoch = ctx.getDayEpoch();
  }

  function runScan(reason) {
    if (state.pending) return;
    const now = ctx.nowSec();
    const dayEpoch = ctx.getDayEpoch();
    if (dayEpoch !== lastDayEpoch) resetForRollover();

    const sess = ssDefSel(now, cfg.ssMin);
    state.ssSel = sess;
    lastSession = sess;
    state.pending = true;
    const t0 = Date.now();

    try {
      const buyCand = [];
      const sellCand = [];
      let scanned = 0;

      for (const pair of ctx.pairs) {
        if (ctx.bfPending[pair] > 0) continue;
        if (typeof ctx.isPairClosed === "function" && ctx.isPairClosed(pair)) continue;
        const dayArr = ctx.dayTicks[pair];
        const preArr = ctx.preTicks[pair];
        if (!dayArr || ctx.filled[pair] === 0) continue;

        const scanRes = cachedSlice(pair, dayArr, preArr, dayEpoch, cfg.minC, cfg.maxC, cfg.ssMin, sess);
        scanned++;
        for (let i = 0; i < scanRes.revs.length; i++) {
          const x0 = scanRes.revs[i];
          if (+x0.s1 !== LOCKED_LVL) continue;
          if (wsPctOf(x0) < MIN_SIG_PCT) continue;
          if (cfg.r0Only && x0.r !== 0) continue;
          const x = Object.assign({}, x0);
          if (wsIsBuy(x)) buyCand.push(x);
          else sellCand.push(x);
        }
        for (let i = 0; i < scanRes.moms.length; i++) {
          const x0 = scanRes.moms[i];
          if (+x0.s1 !== LOCKED_LVL) continue;
          if (wsPctOf(x0) < MIN_SIG_PCT) continue;
          if (cfg.r0Only && x0.r !== 0) continue;
          const x = Object.assign({}, x0);
          if (wsIsBuy(x)) buyCand.push(x);
          else sellCand.push(x);
        }
      }

      const allCand = buyCand.concat(sellCand);
      const bestPerPair = wsBuild(allCand, LOCKED_LVL, Math.max(cfg.topLimit * 4, ctx.pairs.length * 2));
      let buyTop = bestPerPair.filter(wsIsBuy).slice(0, cfg.topLimit);
      let sellTop = bestPerPair.filter(x => !wsIsBuy(x)).slice(0, cfg.topLimit);
      stampAndSort(buyTop, sellTop, now);

      var buyLocks = [];
      var sellLocks = [];
      var topLocks = [];
      var pairLocks = [];
      var globalBest = null;

      if (disableLock) {
        heldBuy = null;
        heldSell = null;
        heldLock = null;
        state.buyTop = buyTop.slice(0, cfg.topLimit).map(copySig);
        state.sellTop = sellTop.slice(0, cfg.topLimit).map(copySig);
      } else {
        var buyPairSet = {};
        var sellPairSet = {};
        for (var bi = 0; bi < buyTop.length; bi++) buyPairSet[buyTop[bi].pair] = 1;
        for (var si = 0; si < sellTop.length; si++) sellPairSet[sellTop[si].pair] = 1;
        var buyPool = allCand.filter(function (x) { return x.type === "REV"; });
        var sellPool = allCand.filter(function (x) { return x.type === "MOM"; });

        var lockPool = allCand.filter(lockOk);
        var heldMap = (heldLock && typeof heldLock === "object") ? heldLock : {};
        var bestLockByPair = {};
        for (var lpi = 0; lpi < lockPool.length; lpi++) {
          var lpx = lockPool[lpi];
          if (!bestLockByPair[lpx.pair] || wsRank(lpx, bestLockByPair[lpx.pair]) < 0) bestLockByPair[lpx.pair] = lpx;
        }
        var lockPicks = [];
        for (var lpk in bestLockByPair) {
          var lpBest = bestLockByPair[lpk];
          var lpOld = heldMap[lpk] || null;
          var lpKeep = null;
          if (lpOld) {
            for (var lhi = 0; lhi < lockPool.length; lhi++) {
              if (lockPool[lhi].pair === lpk && sigKey(lockPool[lhi]) === sigKey(lpOld)) { lpKeep = lockPool[lhi]; break; }
            }
          }
          var lpCur = (lpKeep && !wsBeats(lpBest, lpKeep)) ? lpKeep : lpBest;
          lpCur.first = lpCur.fs ? lpCur.fs : ((lpCur === lpKeep && lpOld && lpOld.first) ? lpOld.first : (lpCur.first || now));
          lockPicks.push(copySig(lpCur));
        }
        lockPicks.sort(wsRank);
        lockPicks = lockPicks.slice(0, Math.max(1, Number(cfg.lockSlots) || LOCK_SLOTS));
        var nextHeldMap = {};
        for (var nhi = 0; nhi < lockPicks.length; nhi++) nextHeldMap[lockPicks[nhi].pair] = lockPicks[nhi];
        heldLock = nextHeldMap;
        heldBuy = null;
        heldSell = null;
        buyLocks = lockPicks.filter(function (x) { return x.type === "REV"; });
        sellLocks = lockPicks.filter(function (x) { return x.type === "MOM"; });
        topLocks = lockPicks.slice();
        var lockBuyDir = topLocks.filter(function (x) { return wsIsBuy(x); });
        var lockSellDir = topLocks.filter(function (x) { return !wsIsBuy(x); });
        sellTop = sellTop.filter(function (x) { return !lockBuyDir.some(function (l) { return l.pair === x.pair; }); });
        buyTop = buyTop.filter(function (x) { return !lockSellDir.some(function (l) { return l.pair === x.pair; }); });
        if (topLocks.length === 2 && wsRank(topLocks[1], topLocks[0]) < 0) {
          topLocks = [topLocks[1], topLocks[0]];
        }
        pairLocks = topLocks.slice();
        globalBest = topLocks.length ? topLocks[0] : null;
        state.buyTop = wsPinLocksTop(buyTop, lockBuyDir, cfg.topLimit).map(copySig);
        state.sellTop = wsPinLocksTop(sellTop, lockSellDir, cfg.topLimit).map(copySig);
      }

      state.lock = {
        buy: buyLocks[0] || null,
        sell: sellLocks[0] || null,
        buys: buyLocks,
        sells: sellLocks,
        topLocks: topLocks,
        globalBest: globalBest,
        pairLocks: pairLocks
      };
      state.scannedPairs = scanned;
      state.lastScanAt = Date.now();
      state.lastDurationMs = state.lastScanAt - t0;
      state.nextScanAt = state.lastScanAt + cfg.scanInt * 1000;

      if (reason && reason !== "interval") {
        if (disableLock) {
          ctx.log("SCAN", `[${groupName}] ${reason} (${scanned}/${ctx.pairs.length} pairs, ${state.lastDurationMs}ms) VIEW-ONLY BUY:${state.buyTop.length} | SELL:${state.sellTop.length}`);
        } else {
          var lockTxt = function (arr) {
            return (arr && arr.length) ? arr.map(function (x) { return x.pair + " " + x.type + " R" + x.r + " X" + x.s1 + " " + x.c1 + "/" + x.c2 + " " + x.pct + "%"; }).join(", ") : "NONE";
          };
          ctx.log("SCAN", `[${groupName}] ${reason} (${scanned}/${ctx.pairs.length} pairs, ${state.lastDurationMs}ms) BUY[${buyLocks.length}]:${lockTxt(buyLocks)} | SELL[${sellLocks.length}]:${lockTxt(sellLocks)}`);
        }
      }
    } catch (e) {
      ctx.log("SCAN_ERR", e && e.message ? e.message : String(e));
    } finally {
      state.pending = false;
      if (rescanQueued) {
        rescanQueued = false;
        setImmediate(() => runScan("settings"));
      }
    }
  }

  function start() {
    setInterval(() => {
      const now = ctx.nowSec();
      const dayEpoch = ctx.getDayEpoch();
      if (dayEpoch !== lastDayEpoch) {
        resetForRollover();
        runScan("rollover");
        return;
      }
      const sess = ssDefSel(now, cfg.ssMin);
      if (sess !== lastSession) {
        lastSession = sess;
        runScan("new-session-S" + sess);
        return;
      }
      if (Date.now() >= state.nextScanAt) {
        runScan("interval");
      }
    }, 1000).unref();
  }

  function getSnapshot() {
    var nowS = ctx.nowSec();
    var rem = Math.max(0, Math.ceil((state.nextScanAt - Date.now()) / 1000));
    return {
      group: groupName,
      cycle: cfg.minC,
      minC: cfg.minC,
      maxC: cfg.maxC,
      scanInt: cfg.scanInt,
      ssMin: cfg.ssMin,
      ssSel: state.ssSel,
      lvl: cfg.lvl,
      r0Only: cfg.r0Only,
      lockMinPct: cfg.lockMinPct,
      lockMinC1: cfg.lockMinC1,
      topLimit: cfg.topLimit,
      lockEnabled: !disableLock,
      lockSlots: disableLock ? 0 : cfg.lockSlots,
      pending: state.pending,
      countdownSec: rem,
      scannedPairs: state.scannedPairs,
      lastDurationMs: state.lastDurationMs,
      buyTop: state.buyTop.map(function (x) { return withAge(x, nowS); }),
      sellTop: state.sellTop.map(function (x) { return withAge(x, nowS); }),
      lock: disableLock
        ? { buy: null, sell: null, buys: [], sells: [], topLocks: [], globalBest: null, pairLocks: [] }
        : {
          buy: withAge(state.lock.buy, nowS),
          sell: withAge(state.lock.sell, nowS),
          buys: (state.lock.buys || []).slice(0, LOCK_SLOTS).map(function (x) { return withAge(x, nowS); }),
          sells: (state.lock.sells || []).slice(0, LOCK_SLOTS).map(function (x) { return withAge(x, nowS); }),
          topLocks: (state.lock.topLocks || []).slice(0, LOCK_SLOTS).map(function (x) { return withAge(x, nowS); }),
          globalBest: withAge(state.lock.globalBest, nowS),
          pairLocks: (state.lock.pairLocks || []).map(function (x) { return withAge(x, nowS); })
        }
    };
  }

  return { cfg, state, start, runScan, resetForRollover, getSnapshot, evalSignalPlan, tcLastReal };
}

module.exports = { createScanner, evalSignalPlan, tcLastReal, ssBounds, ssDefSel };
