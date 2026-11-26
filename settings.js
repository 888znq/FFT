"use strict";

const FB_URL = process.env.SETTINGS_FB_URL || "https://system-data-bf026-default-rtdb.asia-southeast1.firebasedatabase.app/wallspectrum_1s_settings.json";
const SCHEMA_VER = 5;
const GROUP_KEYS = ["DRV", "MTL", "ALL"];

const SESSION_OPTIONS = [
  { value: 60, label: "1h" },
  { value: 120, label: "2h" },
  { value: 180, label: "3h" },
  { value: 240, label: "4h" },
  { value: 360, label: "6h" },
  { value: 480, label: "8h" },
  { value: 720, label: "12h" },
  { value: 1440, label: "24h" }
];

const SETTINGS_SCHEMA = [
  { key: "mode", label: "ACCOUNT", scope: "trader", type: "select", options: [{ value: "demo", label: "DEMO" }, { value: "real", label: "REAL" }], default: (process.env.TRADE_MODE === "real") ? "real" : "demo", persist: true, editable: true, group: "summary" },
  { key: "auto", label: "AUTO TRADE", scope: "trader", type: "bool", default: process.env.AUTO_TRADE !== "false", persist: true, editable: true, group: "summary" },
  { key: "stake", label: "STAKE", scope: "trader", type: "number", min: 0.35, max: 10000, step: 0.05, decimals: 2, unit: "USD", default: Number(process.env.TRADE_STAKE) || 0.35, persist: true, editable: true, group: "summary" },
  { key: "minC", label: "CYCLE MIN", scope: "scanner", type: "int", min: 15, max: 900, step: 1, unit: "s", default: 30, persist: true, editable: true, group: "summary" },
  { key: "maxC", label: "CYCLE MAX", scope: "scanner", type: "int", min: 15, max: 900, step: 1, unit: "s", default: 30, persist: true, editable: true, group: "summary" },
  { key: "scanInt", label: "SCAN INT", scope: "scanner", type: "int", min: 5, max: 600, step: 1, unit: "s", default: 30, persist: true, editable: true, group: "summary" },
  { key: "ssMin", label: "SESSION", scope: "scanner", type: "select", valueType: "int", options: SESSION_OPTIONS, min: 0, max: 1440, default: 60, persist: true, editable: true, group: "summary" },
  { key: "lvl", label: "LEVEL", scope: "scanner", type: "int", min: 1, max: 1, step: 1, prefix: "X", default: 1, persist: false, editable: false, group: "extra" },
  { key: "lockMinPct", label: "LOCK MIN %", scope: "scanner", type: "int", min: 0, max: 100, step: 1, unit: "%", default: 60, persist: true, editable: true, group: "extra" },
  { key: "lockMinC1", label: "LOCK MIN C1", scope: "scanner", type: "int", min: 1, max: 500, step: 1, default: 10, persist: true, editable: true, group: "extra" },
  { key: "r0Only", label: "R0 ONLY", scope: "scanner", type: "bool", default: false, persist: true, editable: true, group: "extra" },
  { key: "topLimit", label: "TOP LIMIT", scope: "scanner", type: "int", min: 1, max: 50, step: 1, default: 16, persist: true, editable: true, group: "extra" }
];

const MTL_SCHEMA = [
  { key: "mode", label: "ACCOUNT", scope: "trader", type: "select", options: [{ value: "demo", label: "DEMO" }, { value: "real", label: "REAL" }], default: (process.env.TRADE_MODE === "real") ? "real" : "demo", persist: false, editable: true, group: "summary" },
  { key: "auto", label: "MTL TRADE", scope: "trader", type: "bool", default: false, persist: true, editable: true, group: "summary" },
  { key: "stake", label: "STAKE", scope: "trader", type: "number", min: 0.35, max: 10000, step: 0.05, decimals: 2, unit: "USD", default: 0.50, persist: true, editable: true, group: "summary" },
  { key: "minC", label: "CYCLE MIN", scope: "scanner", type: "int", min: 300, max: 900, step: 1, unit: "s", default: 300, persist: true, editable: true, group: "summary" },
  { key: "maxC", label: "CYCLE MAX", scope: "scanner", type: "int", min: 300, max: 900, step: 1, unit: "s", default: 300, persist: true, editable: true, group: "summary" },
  { key: "scanInt", label: "SCAN INT", scope: "scanner", type: "int", min: 5, max: 600, step: 1, unit: "s", default: 60, persist: true, editable: true, group: "summary" },
  { key: "ssMin", label: "SESSION", scope: "scanner", type: "select", valueType: "int", options: SESSION_OPTIONS, min: 0, max: 1440, default: 120, persist: true, editable: true, group: "summary" },
  { key: "lvl", label: "LEVEL", scope: "scanner", type: "int", min: 1, max: 1, step: 1, prefix: "X", default: 1, persist: false, editable: false, group: "extra" },
  { key: "lockMinPct", label: "LOCK MIN %", scope: "scanner", type: "int", min: 0, max: 100, step: 1, unit: "%", default: 60, persist: true, editable: true, group: "extra" },
  { key: "lockMinC1", label: "LOCK MIN C1", scope: "scanner", type: "int", min: 1, max: 500, step: 1, default: 10, persist: true, editable: true, group: "extra" },
  { key: "r0Only", label: "R0 ONLY", scope: "scanner", type: "bool", default: false, persist: true, editable: true, group: "extra" },
  { key: "topLimit", label: "TOP LIMIT", scope: "scanner", type: "int", min: 1, max: 50, step: 1, default: 16, persist: true, editable: true, group: "extra" }
];

const ALL_SCHEMA = [
  { key: "minC", label: "CYCLE MIN", scope: "scanner", type: "int", min: 15, max: 900, step: 1, unit: "s", default: 30, persist: true, editable: true, group: "summary" },
  { key: "maxC", label: "CYCLE MAX", scope: "scanner", type: "int", min: 15, max: 900, step: 1, unit: "s", default: 30, persist: true, editable: true, group: "summary" },
  { key: "scanInt", label: "SCAN INT", scope: "scanner", type: "int", min: 5, max: 600, step: 1, unit: "s", default: 30, persist: true, editable: true, group: "summary" },
  { key: "ssMin", label: "SESSION", scope: "scanner", type: "select", valueType: "int", options: SESSION_OPTIONS, min: 0, max: 1440, default: 60, persist: true, editable: true, group: "summary" },
  { key: "lvl", label: "LEVEL", scope: "scanner", type: "int", min: 1, max: 1, step: 1, prefix: "X", default: 1, persist: false, editable: false, group: "extra" },
  { key: "lockMinPct", label: "LOCK MIN %", scope: "scanner", type: "int", min: 0, max: 100, step: 1, unit: "%", default: 60, persist: false, editable: false, group: "extra" },
  { key: "lockMinC1", label: "LOCK MIN C1", scope: "scanner", type: "int", min: 1, max: 500, step: 1, default: 10, persist: false, editable: false, group: "extra" },
  { key: "r0Only", label: "R0 ONLY", scope: "scanner", type: "bool", default: false, persist: true, editable: true, group: "extra" },
  { key: "topLimit", label: "TOP LIMIT", scope: "scanner", type: "int", min: 1, max: 50, step: 1, default: 37, persist: false, editable: false, group: "extra" }
];

const GROUP_SCHEMAS = { DRV: SETTINGS_SCHEMA, MTL: MTL_SCHEMA, ALL: ALL_SCHEMA };
const GROUP_MAPS = {};
for (let gi = 0; gi < GROUP_KEYS.length; gi++) {
  const gk = GROUP_KEYS[gi];
  const sc = GROUP_SCHEMAS[gk];
  const mp = {};
  for (let fi = 0; fi < sc.length; fi++) mp[sc[fi].key] = sc[fi];
  GROUP_MAPS[gk] = mp;
}
const SCHEMA_MAP = GROUP_MAPS.DRV;
const SHARED_SCAN_KEYS = ["minC", "maxC", "scanInt", "ssMin"];

function normGroup(g) {
  return (g === "MTL" || g === "ALL") ? g : "DRV";
}

function coerceValue(field, raw) {
  if (field.type === "bool") {
    if (typeof raw === "boolean") return { ok: true, value: raw };
    if (raw === 1 || raw === "1" || raw === "true" || raw === "ON") return { ok: true, value: true };
    if (raw === 0 || raw === "0" || raw === "false" || raw === "OFF") return { ok: true, value: false };
    return { ok: false, error: field.label + " must be ON or OFF" };
  }
  if (field.type === "select") {
    const isInt = field.valueType === "int";
    const v = isInt ? Math.round(Number(raw)) : String(raw == null ? "" : raw).trim();
    if (isInt && !Number.isFinite(v)) return { ok: false, error: field.label + " must be a number" };
    if (Array.isArray(field.options) && field.options.length) {
      const hit = field.options.some(o => o.value === v);
      if (hit) return { ok: true, value: v };
      if (isInt && typeof field.min === "number" && typeof field.max === "number" && v >= field.min && v <= field.max) {
        return { ok: true, value: v };
      }
      return { ok: false, error: "Invalid " + field.label };
    }
    return { ok: true, value: v };
  }
  if (field.type === "int" || field.type === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) return { ok: false, error: field.label + " must be a valid number" };
    let v = field.type === "int" ? Math.round(n) : n;
    if (typeof field.decimals === "number") {
      const p = Math.pow(10, field.decimals);
      v = Math.round(v * p) / p;
    }
    if (typeof field.min === "number" && v < field.min) {
      return { ok: false, error: field.label + " min is " + field.min };
    }
    if (typeof field.max === "number" && v > field.max) {
      return { ok: false, error: field.label + " max is " + field.max };
    }
    return { ok: true, value: v };
  }
  const s = String(raw == null ? "" : raw).trim();
  if (typeof field.maxLen === "number" && s.length > field.maxLen) {
    return { ok: false, error: field.label + " is too long" };
  }
  return { ok: true, value: s };
}

function createSettings(ctx) {
  const log = (ctx && typeof ctx.log === "function") ? ctx.log : () => {};
  const fbUrl = (ctx && ctx.fbUrl) || FB_URL;
  const profiles = { DRV: {}, MTL: {}, ALL: {} };
  const listeners = [];
  let version = 1;
  let loaded = false;
  let storeReady = false;
  let retryTimer = null;

  for (let gi = 0; gi < GROUP_KEYS.length; gi++) {
    const gk = GROUP_KEYS[gi];
    const sc = GROUP_SCHEMAS[gk];
    for (let i = 0; i < sc.length; i++) {
      profiles[gk][sc[i].key] = sc[i].default;
    }
  }
  const values = profiles.DRV;

  function getGroupValues(group) {
    const g = normGroup(group);
    const out = Object.assign({}, profiles[g]);
    if (g === "MTL") out.mode = profiles.DRV.mode;
    return out;
  }

  function getGroupSchema(group) {
    const g = normGroup(group);
    return GROUP_SCHEMAS[g].map(f => Object.assign({}, f));
  }

  function getAllGroupValues() {
    return {
      DRV: getGroupValues("DRV"),
      MTL: getGroupValues("MTL"),
      ALL: getGroupValues("ALL")
    };
  }

  function getAllGroupSchemas() {
    return {
      DRV: getGroupSchema("DRV"),
      MTL: getGroupSchema("MTL"),
      ALL: getGroupSchema("ALL")
    };
  }

  function getValues() {
    return getGroupValues("DRV");
  }

  function getSchema() {
    return getGroupSchema("DRV");
  }

  function get(key, group) {
    const g = normGroup(group);
    if (g === "MTL" && key === "mode") return profiles.DRV.mode;
    return profiles[g][key];
  }

  function getVersion() {
    return version;
  }

  function isLoaded() {
    return loaded;
  }

  function onChange(fn) {
    if (typeof fn === "function") listeners.push(fn);
  }

  function forGroup(group) {
    const g = normGroup(group);
    return {
      group: g,
      values: profiles[g],
      get: key => get(key, g),
      getValues: () => getGroupValues(g),
      getSchema: () => getGroupSchema(g),
      onChange: fn => {
        if (typeof fn !== "function") return;
        onChange((changed, vals, prev, opts) => {
          if (normGroup(opts && opts.group) !== g) return;
          return fn(changed, vals, prev, opts);
        });
      }
    };
  }

  function validate(patch, group) {
    if (!patch || typeof patch !== "object") {
      return { ok: false, error: "Invalid settings payload" };
    }
    const g = normGroup(group);
    const schema = GROUP_SCHEMAS[g];
    const map = GROUP_MAPS[g];
    const cur = getGroupValues(g);
    const next = Object.assign({}, cur);
    const touched = {};
    const keys = Object.keys(patch);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (k === "action" || k === "patch" || k === "settings" || k === "group") continue;
      const f = map[k];
      if (!f || f.editable === false) continue;
      const c = coerceValue(f, patch[k]);
      if (!c.ok) return { ok: false, error: c.error };
      next[k] = c.value;
      touched[k] = 1;
    }

    if (touched.minC && !touched.maxC && next.minC > next.maxC) next.maxC = next.minC;
    if (touched.maxC && !touched.minC && next.maxC < next.minC) next.minC = next.maxC;
    if (next.minC > next.maxC) {
      const tmp = next.minC;
      next.minC = next.maxC;
      next.maxC = tmp;
    }
    if (next.maxC - next.minC > 300) {
      return { ok: false, error: "Cycle range span max is 300s" };
    }

    const changed = {};
    for (let j = 0; j < schema.length; j++) {
      const key = schema[j].key;
      if (next[key] !== cur[key]) changed[key] = next[key];
    }
    return { ok: true, group: g, next, changed };
  }

  function scheduleLoadRetry() {
    if (retryTimer || storeReady) return;
    retryTimer = setTimeout(() => { retryTimer = null; load(); }, 15000);
    if (retryTimer.unref) retryTimer.unref();
  }

  function save(attempt) {
    if (!storeReady) {
      log("SETTINGS", "save skipped: stored settings not loaded yet, retrying load in 15s");
      scheduleLoadRetry();
      return Promise.resolve(false);
    }
    const cfg = {};
    for (let i = 0; i < SETTINGS_SCHEMA.length; i++) {
      const f = SETTINGS_SCHEMA[i];
      if (f.persist) cfg[f.key] = profiles.DRV[f.key];
    }
    const mtlCfg = {};
    for (let i = 0; i < MTL_SCHEMA.length; i++) {
      const f = MTL_SCHEMA[i];
      if (f.persist) mtlCfg[f.key] = profiles.MTL[f.key];
    }
    const allCfg = {};
    for (let i = 0; i < ALL_SCHEMA.length; i++) {
      const f = ALL_SCHEMA[i];
      if (f.persist) allCfg[f.key] = profiles.ALL[f.key];
    }
    const payload = {
      schemaVer: SCHEMA_VER,
      cfg,
      profiles: {
        MTL: mtlCfg,
        ALL: allCfg
      },
      mode: profiles.DRV.mode,
      auto: profiles.DRV.auto,
      amt: Number(profiles.DRV.stake || 0.35).toFixed(2),
      cycle: { minC: profiles.DRV.minC, maxC: profiles.DRV.maxC, scanInt: profiles.DRV.scanInt, ssMin: profiles.DRV.ssMin },
      updatedAt: Date.now()
    };
    const retrySave = () => {
      if ((attempt || 0) < 3) {
        const rt = setTimeout(() => { save((attempt || 0) + 1); }, 5000);
        if (rt.unref) rt.unref();
      }
    };
    return fetch(fbUrl, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(6000)
    }).then(r => {
      if (!r.ok) {
        log("SETTINGS", "save failed: HTTP " + r.status);
        retrySave();
        return false;
      }
      return true;
    }).catch(e => {
      log("SETTINGS", "save failed: " + (e && e.message ? e.message : String(e)));
      retrySave();
      return false;
    });
  }

  async function apply(patch, opts) {
    opts = opts || {};
    const g = normGroup(opts.group);
    const v = validate(patch, g);
    if (!v.ok) return { ok: false, error: v.error };
    const changedKeys = Object.keys(v.changed);
    if (!changedKeys.length) {
      return { ok: true, group: g, changed: {}, settings: getGroupValues(g), settingsByGroup: getAllGroupValues(), version };
    }
    const prev = getGroupValues(g);
    const prevMode = profiles.DRV.mode;
    Object.assign(profiles[g], v.next);
    if (Object.prototype.hasOwnProperty.call(v.changed, "mode")) {
      profiles.DRV.mode = v.next.mode;
      profiles.MTL.mode = v.next.mode;
    }
    const emitOpts = Object.assign({}, opts, { group: g });
    try {
      for (let i = 0; i < listeners.length; i++) {
        await listeners[i](v.changed, profiles[g], prev, emitOpts);
      }
    } catch (e) {
      Object.assign(profiles[g], prev);
      profiles.DRV.mode = prevMode;
      profiles.MTL.mode = prevMode;
      for (let j = 0; j < listeners.length; j++) {
        try { await listeners[j](prev, profiles[g], v.next, Object.assign({}, emitOpts, { rollback: true, noRescan: true })); } catch {}
      }
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
    if (!opts.noMirror && (g === "DRV" || g === "ALL")) {
      const mirrorPatch = {};
      for (let mi = 0; mi < SHARED_SCAN_KEYS.length; mi++) {
        const mk = SHARED_SCAN_KEYS[mi];
        if (Object.prototype.hasOwnProperty.call(v.changed, mk)) mirrorPatch[mk] = v.next[mk];
      }
      if (Object.keys(mirrorPatch).length) {
        await apply(mirrorPatch, { source: (opts.source || "update") + "-mirror", group: g === "DRV" ? "ALL" : "DRV", persist: false, noMirror: true, noRescan: opts.noRescan });
      }
    }
    version++;
    const map = GROUP_MAPS[g];
    const shouldPersist = opts.persist !== false && changedKeys.some(k => (map[k] && map[k].persist) || k === "mode");
    const saved = shouldPersist ? await save() : true;
    const summary = changedKeys.map(k => k + "=" + profiles[g][k]).join(", ");
    log("SETTINGS", "[" + g + "] " + (opts.source || "update") + ": " + summary);
    return { ok: true, group: g, changed: v.changed, saved: saved, settings: getGroupValues(g), settingsByGroup: getAllGroupValues(), version };
  }

  async function reset(opts) {
    opts = opts || {};
    const g = normGroup(opts.group);
    const schema = GROUP_SCHEMAS[g];
    const patch = {};
    for (let i = 0; i < schema.length; i++) {
      const f = schema[i];
      if (f.editable !== false) patch[f.key] = f.default;
    }
    return apply(patch, Object.assign({ source: "reset", group: g }, opts));
  }

  async function load() {
    loaded = true;
    try {
      const r = await fetch(fbUrl, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) { scheduleLoadRetry(); return false; }
      const j = await r.json();
      storeReady = true;
      if (!j || typeof j !== "object") return false;
      let loadedAny = false;
      const ver = Number(j.schemaVer) || 1;
      if (j.cfg && typeof j.cfg === "object") {
        const cfgIn = Object.assign({}, j.cfg);
        if (ver < 2) {
          delete cfgIn.lvl;
          delete cfgIn.topLimit;
        }
        if (ver < 4) {
          delete cfgIn.scanInt;
        }
        if (ver < 5) {
          delete cfgIn.minC;
          delete cfgIn.maxC;
          delete cfgIn.scanInt;
        }
        await apply(cfgIn, { group: "DRV", persist: false, source: "firebase", noRescan: true, noMirror: true });
        loadedAny = true;
      } else if (j.mode === "demo" || j.mode === "real") {
        await apply({ mode: j.mode }, { group: "DRV", persist: false, source: "firebase", noRescan: true });
        loadedAny = true;
      }
      if (j.cycle && typeof j.cycle === "object") {
        const cyc = {};
        ["minC", "maxC", "scanInt", "ssMin"].forEach(k => {
          if (j.cycle[k] !== null && j.cycle[k] !== undefined && Number.isFinite(Number(j.cycle[k]))) cyc[k] = j.cycle[k];
        });
        if (Object.keys(cyc).length) {
          await apply(cyc, { group: "DRV", persist: false, source: "firebase-cycle", noRescan: true, noMirror: true });
          loadedAny = true;
        }
      }
      if (j.profiles && j.profiles.MTL && typeof j.profiles.MTL === "object") {
        const mtlIn = Object.assign({}, j.profiles.MTL);
        if (mtlIn.minC != null && Number(mtlIn.minC) < 300) mtlIn.minC = 300;
        if (mtlIn.maxC != null && Number(mtlIn.maxC) < 300) mtlIn.maxC = 300;
        if (ver < 4) {
          delete mtlIn.scanInt;
        }
        await apply(mtlIn, { group: "MTL", persist: false, source: "firebase", noRescan: true });
      }
      await apply({
        minC: profiles.DRV.minC,
        maxC: profiles.DRV.maxC,
        scanInt: profiles.DRV.scanInt,
        ssMin: profiles.DRV.ssMin,
        r0Only: (j.profiles && j.profiles.ALL && typeof j.profiles.ALL.r0Only === "boolean") ? j.profiles.ALL.r0Only : profiles.ALL.r0Only
      }, { group: "ALL", persist: false, source: "firebase-inherit", noRescan: true, noMirror: true });
      if (ver < SCHEMA_VER) save();
      return loadedAny;
    } catch {}
    if (!storeReady) scheduleLoadRetry();
    return false;
  }

  return {
    values,
    profiles,
    schema: SETTINGS_SCHEMA,
    get,
    getValues,
    getSchema,
    getGroupValues,
    getGroupSchema,
    getAllGroupValues,
    getAllGroupSchemas,
    forGroup,
    getVersion,
    isLoaded,
    onChange,
    validate,
    apply,
    reset,
    load,
    save
  };
}

module.exports = { createSettings, SETTINGS_SCHEMA, GROUP_SCHEMAS, GROUP_KEYS, FB_URL };
