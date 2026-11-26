"use strict";

const WebSocket = require("ws");

const PUBLIC_WS_URL = "wss://api.derivws.com/trading/v1/options/ws/public?app_id=1089";
const FB_URL = "https://system-data-bf026-default-rtdb.asia-southeast1.firebasedatabase.app/wallspectrum_1s_settings.json";

const DV_APP = (process.env.DERIV_APP_ID || "33VdMoKptaW40mOpanwBg").trim();
const DV_TOK = (process.env.DERIV_API_TOKEN || "pat_4b2171c2b96c25dd073fe246d5111b37325fb67a07b50aa887c384b7c181175f").trim();

// Master switch: set to true to re-enable DRV/MTL auto-trading (placing orders).
const AUTO_TRADE_ENABLED = false;

function pairDisp(p) {
  const v = /^1HZ(\d+)V$/.exec(String(p));
  if (v) return "V" + v[1] + "/USD";
  const m = /^(frx|cry)([A-Z]{3})([A-Z]{3})$/.exec(String(p));
  return m ? m[2] + "/" + m[3] : String(p);
}

function fmtIstTime(ms) {
  const d = new Date((ms || Date.now()) + 19800000);
  const p2 = n => (n < 10 ? "0" + n : "" + n);
  return p2(d.getUTCHours()) + ":" + p2(d.getUTCMinutes()) + ":" + p2(d.getUTCSeconds());
}

function createTrader(ctx) {
  const sv = (ctx.settings && ctx.settings.values) || {};
  const dv = {
    mode: (sv.mode === "real" || sv.mode === "demo") ? sv.mode : ((process.env.TRADE_MODE === "real") ? "real" : "demo"),
    auto: sv.auto != null ? !!sv.auto : (process.env.AUTO_TRADE !== "false"),
    stake: sv.stake != null ? Number(sv.stake) : (Number(process.env.TRADE_STAKE) || 0.35),
    ws: null,
    ready: false,
    bal: { demo: null, real: null },
    cur: { demo: "USD", real: "USD" },
    acc: {},
    rid: 10,
    pend: {},
    pingTimer: null,
    reconnTimer: null
  };

  const trades = [];
  const consoleLogs = [];
  const payouts = {};
  const firedKeys = new Set();
  const inFlightKeys = new Set();
  let lastDayEpoch = ctx.getDayEpoch();
  let shuttingDown = false;

  function addLog(msg, forceCat) {
    const s = String(msg);
    let cat = forceCat || "SYS";
    if (!forceCat) {
      if (/^(ERR\b|ERROR\b)/i.test(s) || /\b(LOST|FAILED|OFFLINE)\b/i.test(s)) cat = "ERR";
      else if (/^OK\s+/i.test(s) || /\b(WON|BUY|SELL)\b/.test(s)) cat = "TRADE";
    }
    consoleLogs.push({ t: fmtIstTime(Date.now()), c: cat, m: s });
    if (consoleLogs.length > 400) consoleLogs.shift();
    ctx.log("TRADER_" + cat, s);
  }

  function clearLogs() {
    consoleLogs.length = 0;
  }

  const TRADABLE_GROUPS = ["DRV", "MTL"];

  function getGroupCfg(grp) {
    if (ctx.settings && typeof ctx.settings.getGroupValues === "function") {
      return ctx.settings.getGroupValues(grp);
    }
    if (grp === "MTL") return { auto: false, stake: 0.50 };
    return { auto: dv.auto, stake: dv.stake };
  }

  async function onSettingsChanged(changed, vals, prev, opts) {
    if (!vals) return;
    const grp = (opts && (opts.group === "MTL" || opts.group === "ALL")) ? opts.group : "DRV";
    const silent = !!(opts && (opts.source === "firebase" || opts.source === "firebase-inherit" || opts.rollback));
    if (Object.prototype.hasOwnProperty.call(changed, "auto") && grp !== "ALL") {
      if (grp === "DRV") dv.auto = !!vals.auto;
      if (!silent) addLog("[" + grp + "] Auto-trade set to " + (vals.auto ? "ON" : "OFF"), "SYS");
    }
    if (Object.prototype.hasOwnProperty.call(changed, "stake") && grp !== "ALL") {
      const stVal = Math.round(Number(vals.stake) * 100) / 100;
      if (grp === "DRV") dv.stake = stVal;
      if (!silent) addLog("[" + grp + "] Stake updated to " + stVal.toFixed(2), "SYS");
    }
    if (Object.prototype.hasOwnProperty.call(changed, "mode")) {
      if (silent) {
        dv.mode = vals.mode === "real" ? "real" : "demo";
      } else {
        const ok = await connect(vals.mode);
        if (!ok) throw new Error("Failed to connect " + String(vals.mode).toUpperCase() + " account");
      }
    }
    if (Object.prototype.hasOwnProperty.call(changed, "minC") && !silent && grp !== "ALL") {
      fetchPayouts();
    }
    if (!silent) {
      const other = Object.keys(changed).filter(k => k !== "auto" && k !== "stake" && k !== "mode");
      if (other.length) {
        addLog("[" + grp + "] Settings updated: " + other.map(k => k + "=" + vals[k]).join(", "), "SYS");
      }
    }
  }

  if (ctx.settings && typeof ctx.settings.onChange === "function") {
    ctx.settings.onChange(onSettingsChanged);
  }

  function dvSend(obj) {
    return new Promise((res, rej) => {
      if (!dv.ready || !dv.ws || dv.ws.readyState !== WebSocket.OPEN) {
        rej(new Error("not connected"));
        return;
      }
      const id = ++dv.rid;
      obj.req_id = id;
      const t = setTimeout(() => {
        delete dv.pend[id];
        rej(new Error("timeout"));
      }, 15000);
      dv.pend[id] = d => {
        clearTimeout(t);
        delete dv.pend[id];
        if (d.error) rej(new Error(d.error.message || "error"));
        else res(d);
      };
      try {
        dv.ws.send(JSON.stringify(obj));
      } catch (e) {
        clearTimeout(t);
        delete dv.pend[id];
        rej(e);
      }
    });
  }

  async function loadAccounts() {
    try {
      const r = await fetch("https://api.derivws.com/trading/v1/options/accounts", {
        headers: { "Authorization": "Bearer " + DV_TOK, "Deriv-App-ID": DV_APP },
        signal: AbortSignal.timeout(12000)
      });
      const j = await r.json();
      const L = j && j.data ? (Array.isArray(j.data) ? j.data : [j.data]) : [];
      for (const a of L) {
        if (!a || a.status === "inactive") continue;
        const t = a.account_type === "real" ? "real" : "demo";
        if (dv.acc[t]) continue;
        dv.acc[t] = a.account_id;
        dv.bal[t] = +a.balance;
        dv.cur[t] = a.currency || "USD";
      }
      if (!L.length) addLog("ERR accounts: " + (j && j.errors ? JSON.stringify(j.errors) : r.status), "ERR");
    } catch (e) {
      addLog("ERR accounts failed: " + (e && e.message ? e.message : String(e)), "ERR");
    }
  }

  function clearWsTimers() {
    clearInterval(dv.pingTimer);
    clearTimeout(dv.reconnTimer);
    dv.pingTimer = null;
    dv.reconnTimer = null;
  }

  function onPoc(p) {
    for (let i = 0; i < trades.length; i++) {
      if (trades[i].id !== String(p.contract_id)) continue;
      const tr = trades[i];
      const en = +p.entry_spot || +p.entry_tick || 0;
      if (en) tr.entry = en;
      if (+p.date_start) tr.t0 = +p.date_start;
      if (+p.date_expiry) tr.exp = +p.date_expiry;
      if (+p.payout) tr.payout = +p.payout;
      if (p.profit !== undefined && p.profit !== null) tr.pnl = +p.profit;
      if (p.is_sold || p.status === "won" || p.status === "lost") {
        tr.status = (p.status === "won" || +p.profit > 0) ? "won" : "lost";
        if (!tr._lg) {
          tr._lg = 1;
          addLog(
            pairDisp(tr.pair) + " " + tr.dir + " " + tr.amt.toFixed(2) + " " + tr.status.toUpperCase() +
            (tr.pnl !== null ? " " + (tr.pnl >= 0 ? "+" : "") + tr.pnl.toFixed(2) : ""),
            tr.status === "won" ? "TRADE" : "ERR"
          );
        }
      }
    }
  }

  async function connect(mode) {
    if (shuttingDown) return false;
    mode = mode === "real" ? "real" : "demo";
    if (!dv.acc[mode]) await loadAccounts();
    if (!dv.acc[mode]) {
      addLog("ERR no " + mode + " account found", "ERR");
      return false;
    }
    clearWsTimers();
    const old = dv.ws;
    dv.ws = null;
    dv.ready = false;
    dv.mode = mode;
    if (old) {
      try { old.removeAllListeners(); old.close(); } catch {}
    }

    try {
      const r = await fetch(
        "https://api.derivws.com/trading/v1/options/accounts/" + encodeURIComponent(dv.acc[mode]) + "/otp",
        {
          method: "POST",
          headers: { "Authorization": "Bearer " + DV_TOK, "Deriv-App-ID": DV_APP },
          signal: AbortSignal.timeout(12000)
        }
      );
      const j = await r.json();
      if (!j || !j.data || !j.data.url) throw new Error("OTP rejected");

      const ws = new WebSocket(j.data.url);
      dv.ws = ws;

      ws.on("message", raw => {
        let d;
        try { d = JSON.parse(raw.toString()); } catch { return; }
        if (d.msg_type === "balance" && d.balance) {
          dv.bal[mode] = +d.balance.balance;
          dv.cur[mode] = d.balance.currency || "USD";
        }
        if (d.proposal_open_contract) onPoc(d.proposal_open_contract);
        if (d.req_id && dv.pend[d.req_id]) dv.pend[d.req_id](d);
      });

      ws.on("close", () => {
        if (dv.ws !== ws) return;
        dv.ready = false;
        clearInterval(dv.pingTimer);
        dv.pingTimer = null;
        if (!shuttingDown) {
          addLog("Trading WS closed (" + mode.toUpperCase() + "), reconnecting in 5s", "SYS");
          dv.reconnTimer = setTimeout(() => {
            if (dv.ws === ws) connect(dv.mode);
          }, 5000);
        }
      });

      ws.on("error", err => {
        addLog("ERR trading WS: " + (err && err.message ? err.message : String(err)), "ERR");
      });

      await new Promise((res, rej) => {
        const tm = setTimeout(() => rej(new Error("socket open timeout")), 12000);
        ws.once("open", () => { clearTimeout(tm); res(); });
        ws.once("error", () => { clearTimeout(tm); rej(new Error("socket error")); });
      });

      if (dv.ws !== ws) return false;
      dv.ready = true;
      ws.send(JSON.stringify({ balance: 1, subscribe: 1 }));
      dv.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.ping(); ws.send(JSON.stringify({ ping: 1 })); } catch {}
        }
      }, 25000);

      // Resubscribe any currently open contracts after reconnect
      for (const tr of trades) {
        if (tr.status === "open") {
          try { ws.send(JSON.stringify({ proposal_open_contract: 1, contract_id: Number(tr.id), subscribe: 1 })); } catch {}
        }
      }

      addLog("Connected Deriv " + mode.toUpperCase() + " (" + dv.acc[mode] + ")", "SYS");
      return true;
    } catch (e) {
      addLog("ERR connect failed: " + (e && e.message ? e.message : String(e)), "ERR");
      if (!shuttingDown) {
        dv.reconnTimer = setTimeout(() => connect(dv.mode), 8000);
      }
      return false;
    }
  }

  async function placeTrade(dir, amt, dur, pair, group) {
    const grp = group === "MTL" ? "MTL" : "DRV";
    try {
      if (grp === "MTL" && Number(dur) < 300) {
        addLog("ERR [MTL] " + pairDisp(pair) + " blocked: duration " + dur + "s < 300s", "ERR");
        return false;
      }
      if (!dv.ready && !(await connect(dv.mode))) return false;
      const pr = await dvSend({
        proposal: 1,
        amount: amt,
        basis: "stake",
        contract_type: dir === "BUY" ? "CALL" : "PUT",
        currency: dv.cur[dv.mode] || "USD",
        duration: dur,
        duration_unit: "s",
        underlying_symbol: pair
      });
      const by = await dvSend({ buy: pr.proposal.id, price: +pr.proposal.ask_price || amt });
      if (by.buy) {
        const tr = {
          pair,
          group: grp,
          id: String(by.buy.contract_id),
          dir,
          amt: +by.buy.buy_price || amt,
          dur,
          t0: +by.buy.start_time || +by.buy.purchase_time || ctx.nowSec(),
          exp: (+by.buy.start_time || +by.buy.purchase_time || ctx.nowSec()) + dur,
          payout: +by.buy.payout || +(pr.proposal && pr.proposal.payout) || 0,
          entry: null,
          pnl: null,
          status: "open",
          mode: dv.mode
        };
        trades.push(tr);
        if (trades.length > 50) trades.shift();
        try {
          if (dv.ws && dv.ready) {
            dv.ws.send(JSON.stringify({ proposal_open_contract: 1, contract_id: by.buy.contract_id, subscribe: 1 }));
          }
        } catch {}
      }
      addLog("OK  [" + grp + "] " + pairDisp(pair) + " " + dir + " " + amt.toFixed(2) + " " + dur + "s #" + (by.buy ? by.buy.contract_id : ""), "TRADE");
      return true;
    } catch (e) {
      addLog("ERR [" + grp + "] " + pairDisp(pair) + " " + dir + " failed: " + (e && e.message ? e.message : String(e)), "ERR");
      return false;
    }
  }

  function settleFallback() {
    const nowS = ctx.nowSec();
    const dayEpoch = ctx.getDayEpoch();
    for (const tr of trades) {
      if (tr.status !== "open") continue;
      const ex = tr.exp || (tr.t0 + tr.dur);
      if (nowS <= ex + 4) continue;
      const ap = ctx.dayTicks[tr.pair];
      if (!ap) continue;
      const ei = tr.t0 - dayEpoch;
      const xi = ex - dayEpoch;
      let en = tr.entry;
      if (!en && ei >= 0 && ei < ap.length) {
        const ri = ctx.scanner.tcLastReal(ap, ei);
        if (ri >= 0) en = ap[ri];
      }
      if (!en) continue;
      const rx = (xi >= 0 && xi < ap.length) ? ctx.scanner.tcLastReal(ap, xi) : -1;
      if (rx >= 0) {
        const won = tr.dir === "BUY" ? ap[rx] > en : ap[rx] < en;
        tr.entry = en;
        tr.status = won ? "won" : "lost";
        tr.pnl = won ? (tr.payout - tr.amt) : -tr.amt;
        if (!tr._lg) {
          tr._lg = 1;
          addLog(
            pairDisp(tr.pair) + " " + tr.dir + " " + tr.amt.toFixed(2) + " " + tr.status.toUpperCase() +
            " " + (tr.pnl >= 0 ? "+" : "") + tr.pnl.toFixed(2),
            won ? "TRADE" : "ERR"
          );
        }
      }
    }
  }

  function autoTick() {
    const dayEpoch = ctx.getDayEpoch();
    if (dayEpoch !== lastDayEpoch) {
      firedKeys.clear();
      inFlightKeys.clear();
      lastDayEpoch = dayEpoch;
    }
    settleFallback();

    if (!AUTO_TRADE_ENABLED) return;
    if (!dv.ready) return;
    if (!ctx.isWsConnected()) return;

    const nowSec = ctx.nowSec() - dayEpoch;
    if (nowSec < 0 || nowSec >= 86400) return;

    var openPairs = {};
    for (var ti = 0; ti < trades.length; ti++) {
      if (trades[ti] && trades[ti].status === "open") openPairs[trades[ti].pair] = 1;
    }

    for (var gi = 0; gi < TRADABLE_GROUPS.length; gi++) {
      var grp = TRADABLE_GROUPS[gi];
      var gCfg = getGroupCfg(grp);
      var gStake = Math.round(Number(gCfg && gCfg.stake || 0) * 100) / 100;
      if (!gCfg || !gCfg.auto || !(gStake > 0)) continue;

      var sc = (ctx.scanners && ctx.scanners[grp]) || (grp === "DRV" ? ctx.scanner : null);
      var lk = sc && sc.state && sc.state.lock;
      if (!lk) continue;

      var lockLimit = Number(sc.cfg && sc.cfg.lockSlots) || 8;
      var tableLocks = [];
      var lockPairSeen = {};
      var pushLock = function (lx) {
        if (lx && lx.pair && !lockPairSeen[lx.pair]) { lockPairSeen[lx.pair] = 1; tableLocks.push(lx); }
      };
      (Array.isArray(lk.buys) && lk.buys.length ? lk.buys : [lk.buy]).forEach(pushLock);
      (Array.isArray(lk.sells) && lk.sells.length ? lk.sells : [lk.sell]).forEach(pushLock);
      var sides = tableLocks.length
        ? tableLocks.slice(0, lockLimit)
        : (Array.isArray(lk.topLocks) ? lk.topLocks.filter(Boolean).slice(0, lockLimit) : []);

      for (var s = 0; s < sides.length; s++) {
        var x = sides[s];
        if (!x) continue;
        if (grp === "MTL" && (+x.c || 0) < 300) continue;
        var pair = x.pair;
        if (openPairs[pair]) continue;
        if (ctx.bfPending[pair] > 0) continue;
        var ap = ctx.dayTicks[pair];
        var pre = ctx.preTicks[pair];
        if (!ap || !ap.length) continue;

        var lim = Math.min(nowSec, ap.length - 1, 86399);
        var pl = sc.evalSignalPlan(x, ap, pre, lim, 86400, dayEpoch, sc.cfg.ssMin);
        if (pl.kind !== "FIRED" || nowSec - pl.idx > 3) continue;

        var key = grp + "|" + pair + "|" + x.type + "|" + x.c + "|" + x.r + "|" + x.s1 + "|" + x.col + "|" + pl.idx;
        if (firedKeys.has(key) || inFlightKeys.has(key)) continue;

        openPairs[pair] = 1;
        inFlightKeys.add(key);
        firedKeys.add(key);
        var up = x.type === "REV" ? x.col === "R" : x.col === "G";
        (function (k, stAmt, durSec, sym, gName, isUp) {
          placeTrade(isUp ? "BUY" : "SELL", stAmt, durSec, sym, gName).finally(() => {
            inFlightKeys.delete(k);
          });
        })(key, gStake, x.c, pair, grp, up);
      }
    }
  }

  function fetchPayouts() {
    const drvSc = (ctx.scanners && ctx.scanners.DRV) || ctx.scanner;
    const mtlSc = (ctx.scanners && ctx.scanners.MTL) || null;
    const allSc = (ctx.scanners && ctx.scanners.ALL) || drvSc;
    const drvSet = new Set((ctx.pairGroups && ctx.pairGroups.DRV) || []);
    const mtlSet = new Set((ctx.pairGroups && ctx.pairGroups.MTL) || []);
    const drvDur = Math.round(drvSc && drvSc.cfg ? drvSc.cfg.minC : 60) || 60;
    const mtlDur = Math.max(300, Math.round(mtlSc && mtlSc.cfg ? mtlSc.cfg.minC : 300) || 300);
    const allDur = Math.round(allSc && allSc.cfg ? allSc.cfg.minC : drvDur) || drvDur;
    const pl = ctx.pairs.slice();
    const got = {};
    let nGot = 0, done = false, ws = null, t = null;

    function fin() {
      if (done) return;
      done = true;
      clearTimeout(t);
      if (ws) { try { ws.close(); } catch {} }
    }

    try { ws = new WebSocket(PUBLIC_WS_URL); } catch { fin(); return; }
    t = setTimeout(fin, 15000);
    ws.on("open", () => {
      for (let i = 0; i < pl.length; i++) {
        const p = pl[i];
        let dur = drvDur;
        if (mtlSet.has(p)) dur = mtlDur;
        else if (!drvSet.has(p)) dur = /^frx/i.test(p) ? Math.max(300, allDur) : allDur;
        ws.send(JSON.stringify({
          proposal: 1, amount: 1, basis: "stake", contract_type: "CALL",
          currency: "USD", duration: dur, duration_unit: "s",
          underlying_symbol: p, req_id: i + 1
        }));
      }
    });
    ws.on("message", raw => {
      let d;
      try { d = JSON.parse(raw.toString()); } catch { return; }
      const k = d.req_id ? pl[d.req_id - 1] : null;
      if (!k || got[k]) return;
      got[k] = 1;
      nGot++;
      if (d.error) payouts[k] = "N/A";
      else if (d.proposal) {
        const ap = +d.proposal.ask_price, po = +d.proposal.payout;
        payouts[k] = (ap > 0 && po > 0) ? Math.round((po / ap - 1) * 100) + "%" : "--%";
      }
      if (nGot >= pl.length) fin();
    });
    ws.on("error", fin);
    ws.on("close", fin);
  }

  async function start() {
    if (ctx.settings) {
      if (!ctx.settings.isLoaded()) await ctx.settings.load();
      dv.mode = ctx.settings.values.mode === "real" ? "real" : "demo";
      dv.auto = !!ctx.settings.values.auto;
      dv.stake = Math.round(Number(ctx.settings.values.stake || 0.35) * 100) / 100;
      addLog("Active settings loaded (" + dv.mode.toUpperCase() + ", stake " + dv.stake.toFixed(2) + ")", "SYS");
    }
    await connect(dv.mode);
    fetchPayouts();
    setInterval(autoTick, 500).unref();
    setInterval(fetchPayouts, 60000).unref();
  }

  async function handleControl(body) {
    const action = body && body.action;
    const group = (body && (body.group === "MTL" || body.group === "ALL")) ? body.group : "DRV";
    if (action === "set_settings") {
      if (!ctx.settings) return { ok: false, error: "Settings engine unavailable" };
      const patch = (body.patch && typeof body.patch === "object") ? body.patch : ((body.settings && typeof body.settings === "object") ? body.settings : body);
      return await ctx.settings.apply(patch, { source: "control", group });
    }
    if (action === "reset_settings") {
      if (!ctx.settings) return { ok: false, error: "Settings engine unavailable" };
      return await ctx.settings.reset({ source: "control", group });
    }
    if (action === "toggle_mode") {
      const next = dv.mode === "demo" ? "real" : "demo";
      const out = ctx.settings ? await ctx.settings.apply({ mode: next }, { source: "control", group: "DRV" }) : { ok: await connect(next) };
      return Object.assign({}, out, { mode: dv.mode });
    }
    if (action === "set_mode" && (body.mode === "demo" || body.mode === "real")) {
      const out = ctx.settings ? await ctx.settings.apply({ mode: body.mode }, { source: "control", group: "DRV" }) : { ok: await connect(body.mode) };
      return Object.assign({}, out, { mode: dv.mode });
    }
    if (action === "set_auto") {
      if (group === "ALL") return { ok: false, error: "Trading disabled in ALL mode" };
      if (!AUTO_TRADE_ENABLED) return { ok: false, error: "Auto trading is disabled on the server" };
      const out = ctx.settings ? await ctx.settings.apply({ auto: !!body.auto }, { source: "control", group }) : { ok: true };
      if (!ctx.settings && group === "DRV") dv.auto = !!body.auto;
      const gCfg = getGroupCfg(group);
      return Object.assign({}, out, { group, auto: !!gCfg.auto });
    }
    if (action === "set_stake") {
      if (group === "ALL") return { ok: false, error: "Trading disabled in ALL mode" };
      const v = Number(body.stake);
      if (ctx.settings) {
        const out = await ctx.settings.apply({ stake: v }, { source: "control", group });
        const gCfg = getGroupCfg(group);
        return Object.assign({}, out, { group, stake: Number(gCfg.stake || 0.35) });
      }
      if (Number.isFinite(v) && v >= 0.35) {
        dv.stake = Math.round(v * 100) / 100;
        addLog("[" + group + "] Stake updated to " + dv.stake.toFixed(2), "SYS");
        return { ok: true, group, stake: dv.stake };
      }
      return { ok: false, error: "Invalid stake" };
    }
    if (action === "rescan") {
      const sc = (ctx.scanners && ctx.scanners[group]) || ctx.scanner;
      if (sc) sc.runScan("manual");
      return { ok: true, group };
    }
    if (action === "clear_logs") {
      clearLogs();
      return { ok: true };
    }
    return { ok: false, error: "Unknown action" };
  }

  function shutdown() {
    shuttingDown = true;
    clearWsTimers();
    try { if (dv.ws) dv.ws.close(1000, "shutting down"); } catch {}
  }

  function getSnapshot() {
    const drvCfg = getGroupCfg("DRV");
    const mtlCfg = getGroupCfg("MTL");
    return {
      ready: dv.ready,
      mode: dv.mode,
      autoEnabled: AUTO_TRADE_ENABLED,
      auto: AUTO_TRADE_ENABLED && !!drvCfg.auto,
      stake: Number(drvCfg.stake || dv.stake || 0.35),
      groups: {
        DRV: { canTrade: true, auto: AUTO_TRADE_ENABLED && !!drvCfg.auto, stake: Number(drvCfg.stake || 0.35) },
        MTL: { canTrade: true, auto: AUTO_TRADE_ENABLED && !!mtlCfg.auto, stake: Number(mtlCfg.stake || 0.50) },
        ALL: { canTrade: false, auto: false, stake: 0 }
      },
      bal: dv.bal,
      cur: dv.cur,
      accountId: dv.acc[dv.mode] || null
    };
  }

  return { start, shutdown, handleControl, getSnapshot, trades, consoleLogs, payouts, addLog };
}

module.exports = { createTrader };
