'use strict';
/* devpatch.js - the in-app patch engine for WALLSPECTRUM (replaces patcher.py).
 *
 * Same workflow as the EXT OS patch bar: payload (index / lite parts) -> AI reply -> find-and-replace
 * blocks -> guards -> save -> reload/restart -> undo. The matching, parsing and part-splitting code is
 * copied 1:1 from EXT OS index.js, so a patch written for one works in the other.
 *
 * SAFETY RULES (do not weaken):
 *   - OFF unless DEV_PATCH=1. Needs a secret (DEV_SECRET, 16+ chars) sent as the x-dev-secret header.
 *   - Local only unless DEV_ALLOW_REMOTE=1 (set that on Render, together with a long DEV_SECRET).
 *   - This file, supervisor.js and public/dev.html are PROTECTED: the tool can never patch them.
 *     They are the recovery layer. Change them through git only.
 *   - Server-side patches must pass a boot canary (the patched server is started on a scratch port with
 *     the network and the trader switched off) before anything is written.
 *   - server.js loads this file inside try/catch, so a bug here can never stop the bot.
 *
 * Env: DEV_PATCH, DEV_SECRET, DEV_ALLOW_REMOTE, GH_TOKEN, GH_REPO (owner/repo), GH_BRANCH (default main),
 *      DEV_AUTO_STABLE=0 (turn off the 10-minute auto "stable" mark), DEV_SKIP_CANARY=1 (tests only).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const cp = require('child_process');

const ROOT = __dirname;
const ENABLED = process.env.DEV_PATCH === '1';
const ALLOW_REMOTE = process.env.DEV_ALLOW_REMOTE === '1';
const NO_SECRET = process.env.DEV_NO_SECRET === '1';
const ON_RENDER = !!process.env.RENDER;
const SUPERVISED = process.env.DEV_SUPERVISED === '1';
const BOOT_ID = crypto.randomBytes(6).toString('hex');
const DIR = path.join(ROOT, '.devpatch');
const BLOBS = path.join(DIR, 'blobs');
const HIST_FILE = path.join(DIR, 'history.json');
const PENDING = path.join(DIR, 'pending.json');
const RESTART_FLAG = path.join(DIR, 'restart.flag');
const LAST_ERR = path.join(DIR, 'last-error.json');
const SECRET_FILE = path.join(DIR, 'secret.txt');

const GH_TOKEN = process.env.GH_TOKEN || '';
const GH_REPO = process.env.GH_REPO || '';
const GH_BRANCH = process.env.GH_BRANCH || 'main';
const GH_API = String(process.env.GH_API_BASE || 'https://api.github.com').replace(/\/+$/, '');

// Files the tool may never create, overwrite or delete (the recovery layer + launchers + lock file + dot dirs)
const PROTECTED = /^(devpatch\.js|supervisor\.js|public\/dev\.html|start\.(bat|sh)|start_patcher\.bat|patcher\.py|package-lock\.json)$|^(\.|node_modules\/|backups\/|pull_backups\/|_to_delete\/)/;
const TEXT_RE = /\.(js|html|json|css)$/i;
const SKIP_DIRS = { '.git': 1, 'node_modules': 1, '.devpatch': 1, 'backups': 1, 'pull_backups': 1, '_to_delete': 1 };

const DEV_SPLIT = '===' + 'SPLIT' + '===';
const DEV_BLOCK = '===' + 'BLOCK' + '===';
const DEV_DELETE = '===' + 'DELETE' + '===';

const LOG = [];
function dlog(kind, msg) {
  const line = new Date().toTimeString().slice(0, 8) + ' ' + kind + ' ' + String(msg).slice(0, 400);
  LOG.push(line);
  if (LOG.length > 200) LOG.shift();
  try { console.log('[DEVPATCH] ' + kind + ' ' + String(msg).slice(0, 300)); } catch (e) { /* ignore */ }
}

// ---------- shared state used by the copied engine code ----------
let devWorkspace = {};
let devFailOld = '';
let devHist = { undo: [], redo: [] };
let CLIENT_ERRS = [];
function devSessionErrors() { return CLIENT_ERRS; }

// ---------- the patch-format prompt (bot version of EXT OS SUPER_PROMPT) ----------
const SUPER_PROMPT = [
  '[Give me the result as Find-and-Replace blocks for a multi-file project (a Node.js trading-data bot: server.js, public/index.html, package.json).',
  'FORMAT: the WHOLE patch goes in ONE fenced code block (triple backticks). The first line inside the fence is the FILE header, and the fence contains ONLY headers, OLD code, ' + DEV_SPLIT + ' lines, NEW code and ' + DEV_BLOCK + ' lines, never a sentence:',
  '==== FILE: server.js ====',
  '(OLD code, copied exactly from the code shown, unique inside that file, with 6-8 lines of unchanged context)',
  DEV_SPLIT,
  '(NEW code, same context lines kept)',
  'Several independent fixes: keep them all inside the same single fenced code block and separate the blocks with ' + DEV_BLOCK + ' on its own line. Every block needs its own FILE header. If any block fails, NOTHING is applied.',
  'New file: put its path in the FILE header, leave the OLD part empty and write the whole file after the ' + DEV_SPLIT + ' line. Delete a file: empty OLD and the single line ' + DEV_DELETE + ' after the split line. Files in subfolders are addressed by path, for example public/index.html.',
  'The 11 Surgery Scenarios You Must Handle:',
  'Scenario 1 (The Swap): changing one value or line for another.',
  'Scenario 2 (The Excision): deleting code while keeping the rest of the file clean.',
  'Scenario 3 (The Injection): bolting new features onto existing code.',
  'Scenario 4 (The Interceptor): adding a safety check or a rule inside an existing process.',
  'Scenario 5 (The Migration): moving a button or a piece of logic from one place to another.',
  'Scenario 6 (The Refactor): rewriting a complex formula or loop to make it faster.',
  'Scenario 7 (The Sweep): renaming a word/variable everywhere it appears.',
  'Scenario 8 (The Database Bump): updating saved data settings so the app does not crash on old info.',
  'Scenario 9 (The Link Shift): changing where the app connects to (APIs, URLs, tokens).',
  'Scenario 10 (The Sync): when you change one side of a pair (server.js endpoint and the page that calls it, a response header and the code that reads it) you must also fix the other side.',
  'Scenario 11 (The Layer Fix): fixing UI issues where things are hidden or unclickable.',
  'If any variable is declared with const or let inside a function or block that gets re-executed, move the declaration outside or convert it to var. Never declare the same identifier twice in the same scope.',
  'server.js and package.json need a server restart (the tool does it, after a boot test). public/index.html only reloads the page. Never touch devpatch.js, supervisor.js or public/dev.html: they are protected. Never put a line longer than 3000 characters or a base64 blob in a patch.',
  'OUTPUT RULE (strict, the tool reads your reply by machine): your reply is exactly ONE fenced code block with the whole patch in it, preceded by at most ONE plain sentence naming the confirmed cause. Nothing at all after the fence and nothing between fences. Never put prose, comments about the patch, warnings, error messages or annotations inside the fence. A patch written outside a fenced code block is rejected. If you have a concern about the existing code, state it in that one plain sentence BEFORE the fence, never inside it.',
  'ROOT-CAUSE RULE: never patch from a guess. Before any patch, trace the cause end to end: what produces the behaviour, what calls, overrides, saves or restores it, and what runs it at startup. If any link of that chain is not in the code shown, reply with ONLY the @names of the parts you need and NO patch. Once the cause is confirmed, give ONE definitive set of blocks (no alternatives, no apply-this-if options) and put one plain sentence naming the confirmed cause before the code.',
  'LIVE TRADER RULE: this server may place demo trades. Never change stake, account type, or anything that could place orders unless the request says so explicitly.',
  'Before you give me the solution, double-check that you have not left any bracket } or parenthesis ) unclosed.]'
].join('\n') + '\n';

function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

// =====================================================================================================
// The patch engine: block parser, find-and-replace matcher, parts ("lite mode"), labels.
// Pure functions over devWorkspace ({ 'path': 'text with \n line ends' }). No DOM, no network.
// =====================================================================================================
const LITE_SMALL = 45000;   // whole project at or below this many characters: send everything, no parts
const PART_SOFT = 6000;     // a part ends at the first good boundary after this many characters
const PART_HARD = 12000;    // ...or at the latest here

function normNL(s) { return String(s == null ? '' : s).replace(/\r\n?/g, '\n'); }
function trimBlankEdges(s) { return s.replace(/^(?:[ \t]*\n)+/, '').replace(/(?:\n[ \t]*)+$/, ''); }
function lineNorm(s) { return s.replace(/\s+/g, ' ').trim(); }
function countOcc(hay, needle) { let n = 0, i = 0; while ((i = hay.indexOf(needle, i)) >= 0) { n++; i += 1; } return n; }

// ---------- parsing ----------
function devFences(text) {
  const out = [];
  let cur = null;
  normNL(text).split('\n').forEach(function (ln) {
    const t = ln.trim();
    if (cur === null) { if (/^```/.test(t)) cur = []; return; }
    if (t === '```') { out.push(cur.join('\n')); cur = null; return; }
    cur.push(ln);
  });
  if (cur && cur.length) out.push(cur.join('\n'));   // fence never closed
  return out;
}

// Returns [{ filename, oldCode, newCode, error? }]. Accepts a whole AI reply (fenced) or the bare text a
// "copy code" button gives (no fences).
function parseAllBlocks(text) {
  text = normNL(text);
  let body;
  const fenced = devFences(text).filter(function (f) { return f.indexOf(DEV_SPLIT) >= 0; });
  if (fenced.length) body = fenced.join('\n' + DEV_BLOCK + '\n');
  else {
    body = text;
    const h = body.search(/^[ \t]*={2,}[ \t]*FILE:/mi);
    if (h > 0) body = body.slice(h);
  }
  const HDR = /^\s*={2,}\s*FILE:\s*(.+?)\s*={2,}\s*$/i;
  const blocks = [];
  let cur = null;
  function open(fn) { cur = { filename: fn || '', old: [], neu: [], split: false }; }
  function flush() {
    if (!cur) return;
    const o = trimBlankEdges(cur.old.join('\n')), n = trimBlankEdges(cur.neu.join('\n'));
    if (cur.split) blocks.push({ filename: cur.filename, oldCode: o, newCode: n });
    else if (o.trim()) blocks.push({ filename: cur.filename, oldCode: o, newCode: '', error: 'This block has no ' + DEV_SPLIT + ' line.' });
    cur = null;
  }
  body.split('\n').forEach(function (ln) {
    const t = ln.trim();
    if (t === DEV_BLOCK) { flush(); return; }
    const m = HDR.exec(ln);
    if (m) { flush(); open(m[1].replace(/\\/g, '/').replace(/^\.?\//, '')); return; }
    if (t === DEV_SPLIT && !(cur && cur.split)) { if (!cur) open(''); cur.split = true; return; }
    if (!cur) { if (!t) return; open(''); }
    (cur.split ? cur.neu : cur.old).push(ln);
  });
  flush();
  return blocks;
}

// ---------- applying one block to devWorkspace ----------
function devFindFile(old) {
  const names = Object.keys(devWorkspace);
  if (names.length === 1) return { file: names[0] };
  const hits = names.filter(function (f) { return devWorkspace[f].indexOf(old) >= 0; });
  if (hits.length === 1) return { file: hits[0] };
  if (hits.length > 1) return { error: 'Ambiguous: the OLD code appears in several files (' + hits.join(', ') + '). Add a ==== FILE: name ==== header.' };
  return { error: 'Chunk not found: no file contains the OLD code. Add a ==== FILE: name ==== header and copy OLD exactly from the code shown.' };
}

function devApplyBlock(b) {
  if (b.error) return { success: false, error: b.error };
  const old = normNL(b.oldCode), neu = normNL(b.newCode);
  let f = b.filename || '';

  // new file / delete file: OLD is empty
  if (!old.trim()) {
    if (!f) return { success: false, error: 'A new-file or delete block needs a ==== FILE: name ==== header.' };
    if (!TEXT_RE.test(f) || PROTECTED.test(f) || !safeRel(f)) return { success: false, error: f + ' cannot be created or deleted by the tool (only .js .html .json .css files inside the project, never a protected file).' };
    if (neu.trim() === DEV_DELETE) {
      if (!Object.prototype.hasOwnProperty.call(devWorkspace, f)) return { success: false, error: 'Cannot delete ' + f + ': file not found.' };
      delete devWorkspace[f];
      return { success: true };
    }
    if (Object.prototype.hasOwnProperty.call(devWorkspace, f)) return { success: false, error: f + ' already exists: a new-file block must have an empty OLD. Use OLD code to edit an existing file.' };
    if (!neu.trim()) return { success: false, error: 'The new file ' + f + ' is empty.' };
    devWorkspace[f] = neu.replace(/\n*$/, '\n');
    return { success: true };
  }

  // edit
  if (!f) {
    const r = devFindFile(old);
    if (r.error) { devFailOld = old; return { success: false, error: r.error }; }
    f = r.file;
  }
  if (!Object.prototype.hasOwnProperty.call(devWorkspace, f)) return { success: false, error: 'File not found: ' + f + '. Files: ' + Object.keys(devWorkspace).join(', ') };
  const text = devWorkspace[f];
  devFailOld = old;

  const n = countOcc(text, old);
  if (n === 1) {
    const i = text.indexOf(old);
    devWorkspace[f] = text.slice(0, i) + neu + text.slice(i + old.length);
    devFailOld = '';
    return { success: true };
  }
  if (n > 1) return { success: false, error: 'Ambiguous: the OLD code appears ' + n + ' times in ' + f + '. Add more unchanged context lines so it is unique.' };

  // forgiving pass: ignore indentation, trailing spaces and blank-line differences (still needs a unique match)
  const oL = old.split('\n'), tL = text.split('\n');
  const oS = oL.map(lineNorm).filter(Boolean);
  const tN = tL.map(lineNorm);
  const idx = [];
  tN.forEach(function (l, i) { if (l) idx.push(i); });
  if (oS.length) {
    const hits = [];
    for (let s = 0; s + oS.length <= idx.length; s++) {
      let ok = true;
      for (let k = 0; k < oS.length; k++) { if (tN[idx[s + k]] !== oS[k]) { ok = false; break; } }
      if (ok) hits.push(s);
    }
    if (hits.length > 1) return { success: false, error: 'Ambiguous: the OLD code (ignoring spaces) appears ' + hits.length + ' times in ' + f + '. Add more unchanged context lines so it is unique.' };
    if (hits.length === 1) {
      if (oS.length < 3 && oS.join('').length < 40) return { success: false, error: 'Low confidence: the OLD code in ' + f + ' only matches when spaces are ignored and it is too short to trust. Copy it exactly and add more unchanged context lines.' };
      const a = idx[hits[0]], z = idx[hits[0] + oS.length - 1];
      let nl = neu.split('\n');
      const fi = /^[ \t]*/.exec(tL[a])[0];
      const oi = /^[ \t]*/.exec(oL.filter(function (l) { return l.trim(); })[0])[0];
      if (fi !== oi) {
        if (fi.slice(0, oi.length) === oi) { const add = fi.slice(oi.length); nl = nl.map(function (l) { return l.trim() ? add + l : l; }); }
        else if (oi.slice(0, fi.length) === fi) { const cut = oi.slice(fi.length); nl = nl.map(function (l) { return l.indexOf(cut) === 0 ? l.slice(cut.length) : l; }); }
      }
      tL.splice.apply(tL, [a, z - a + 1].concat(nl));
      devWorkspace[f] = tL.join('\n');
      devFailOld = '';
      return { success: true };
    }
    let near = -1;
    for (let i = 0; i < tN.length; i++) { if (tN[i] === oS[0]) { near = i; break; } }
    return { success: false, error: 'Chunk not found in ' + f + ': the OLD code does not match the file' + (near >= 0 ? ' (its first line is at line ' + (near + 1) + ', so a later line differs)' : ' (its first line is not in the file)') + '. Copy OLD exactly from the code shown.' };
  }
  return { success: false, error: 'Chunk not found: the OLD code is empty.' };
}

function devDescribe(f, a, b) {
  if (a == null) return 'new ' + f + ' (' + String(b).split('\n').length + ' lines)';
  if (b == null) return 'deleted ' + f;
  const x = a.split('\n'), y = b.split('\n');
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let s = 0;
  while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
  return f + ' (+' + (y.length - p - s) + ' -' + (x.length - p - s) + ', near line ' + (p + 1) + ')';
}

// ---------- parts ("lite mode"): split big files so the AI only sees what it asks for ----------
function isBoundary(cur, next) {
  if (!/^(?:async\s+function|function|class|const|let|var|\/\/|\/\*|<script|<style|<\/script|<\/style|<div|<section|<header|<main|@media|\.|#)/.test(next)) return false;
  return /^\s*$/.test(cur) || /^[}\])]/.test(cur) || /^<\//.test(cur);
}
function partNames(lines, s, e) {
  const out = [];
  for (let i = s; i <= e && out.length < 60; i++) {
    const m = /^\s{0,4}(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(lines[i]) || /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(lines[i]);
    if (m && out.indexOf(m[1]) < 0) out.push(m[1]);
  }
  return out;
}
function buildChunks() {
  const files = Object.keys(devWorkspace).sort(function (a, b) {
    const ra = a === 'server.js' ? 0 : (a.indexOf('public/') === 0 ? 2 : 1), rb = b === 'server.js' ? 0 : (b.indexOf('public/') === 0 ? 2 : 1);
    return ra - rb || (a < b ? -1 : 1);
  });
  const chunks = [];
  let n = 0;
  files.forEach(function (f) {
    const lines = devWorkspace[f].split('\n');
    let s = 0, size = 0;
    function push(e) {
      n++;
      chunks.push({ n: n, file: f, s: s + 1, e: e + 1, t: lines.slice(s, e + 1).join('\n'), names: partNames(lines, s, e) });
      s = e + 1;
      size = 0;
    }
    for (let i = 0; i < lines.length; i++) {
      size += lines[i].length + 1;
      if (i === lines.length - 1) { push(i); break; }
      if (size >= PART_HARD || (size >= PART_SOFT && isBoundary(lines[i], lines[i + 1]))) push(i);
    }
  });
  return chunks;
}
function liteBuild() {
  let total = 0;
  Object.keys(devWorkspace).forEach(function (f) { total += devWorkspace[f].length; });
  return total <= LITE_SMALL ? [] : buildChunks();
}
function liteTags(s) {
  const out = [];
  (String(s || '').match(/@[\w$-]+/g) || []).forEach(function (t) { const n = t.slice(1); if (out.indexOf(n) < 0) out.push(n); });
  return out;
}
function tagChunks(tags, chunks) {
  const pick = {};
  tags.forEach(function (t) {
    const lo = String(t).toLowerCase();
    const m = /^p(?:art)?(\d+)$/.exec(lo);
    if (m) { chunks.forEach(function (c) { if (c.n === Number(m[1])) pick[c.n] = 1; }); return; }
    let hit = false;
    chunks.forEach(function (c) {
      const base = c.file.split('/').pop();
      if (lo === base.toLowerCase() || lo === base.replace(/\.[^.]+$/, '').toLowerCase()) { pick[c.n] = 1; hit = true; }
    });
    if (hit) return;
    chunks.forEach(function (c) { if (c.names.indexOf(t) >= 0) { pick[c.n] = 1; hit = true; } });
    if (hit) return;
    chunks.forEach(function (c) { if (c.names.some(function (x) { return x.toLowerCase() === lo; })) pick[c.n] = 1; });
  });
  return chunks.filter(function (c) { return pick[c.n]; });
}
function devKnownTag(t) {
  const name = String(t).replace(/^@/, '');
  if (name.toLowerCase() === 'auto') return true;
  return tagChunks([name], buildChunks()).length > 0;
}
function partHeader(c) { return '=== PART ' + c.n + ' ' + c.file + ' (lines ' + c.s + '-' + c.e + ') @part' + c.n + ' ==='; }
function outline(chunks) {
  return chunks.map(function (c) { return '@part' + c.n + '  ' + c.file + ' lines ' + c.s + '-' + c.e + ' (' + (Math.round(c.t.length / 100) / 10) + 'k chars)' + (c.names.length ? ' : ' + c.names.slice(0, 10).join(', ') + (c.names.length > 10 ? ', +' + (c.names.length - 10) + ' more' : '') : ''); }).join('\n');
}
function liteIndex() {
  const ch = buildChunks();
  return 'INDEX MODE: the code is NOT included, only a map of its parts. Read the request, then reply with ONLY the @names of the parts you need to see (for example @part3 @part7, or a function name such as @renderRows), nothing else and NO patch. Ask for every part the cause could pass through: the code that produces the behaviour, whatever calls, overrides, saves or restores it, the startup code, and the other side of any server.js / page pair.\n\nPARTS:\n' + outline(ch);
}
// arg = the instruction (with @tags) or, for the error report, the OLD code that failed to match
function liteSource(arg, compact) {
  const ch = buildChunks();
  if (!ch.length) return '(no project files)';
  arg = String(arg || '');
  const tags = liteTags(arg).filter(function (x) { return x.toLowerCase() !== 'auto'; });
  let sel = [];
  if (tags.length) sel = tagChunks(tags, ch);
  else if (!arg.trim() || /@auto\b/i.test(arg)) sel = ch;
  if (!sel.length && arg.trim()) {
    const want = arg.split('\n').map(function (l) { return l.trim(); }).filter(function (l, i, a) { return l.length >= 12 && a.indexOf(l) === i; }).sort(function (a, b) { return b.length - a.length; }).slice(0, 12);
    const scored = ch.map(function (c) { return { c: c, s: want.filter(function (l) { return c.t.indexOf(l) >= 0; }).length }; }).filter(function (x) { return x.s > 0; }).sort(function (a, b) { return b.s - a.s; }).slice(0, 3);
    sel = scored.map(function (x) { return x.c; }).sort(function (a, b) { return a.n - b.n; });
  }
  if (!sel.length) {
    let total = 0;
    ch.forEach(function (c) { total += c.t.length; });
    if (total <= LITE_SMALL) sel = ch; else return liteIndex();
  }
  let out = 'LITE MODE: only the requested parts are shown in full. Line numbers are those of the file.\n\n' + sel.map(function (c) { return partHeader(c) + '\n' + c.t; }).join('\n\n');
  const rest = ch.filter(function (c) { return sel.indexOf(c) < 0; });
  if (rest.length) {
    // compact (follow-up round in the same AI chat): the AI already has the full part index, so do not send it again
    out += compact
      ? '\n\n(These are only the NEW parts you asked for; the parts shown earlier in this chat are unchanged. The other parts are in the index above. If the cause may pass through a part that is still not shown, reply with ONLY its @name and NO patch.)'
      : '\n\nOTHER PARTS (not shown):\n' + outline(rest) + '\nIf the cause may pass through a part that is not shown, reply with ONLY its @name and NO patch.';
  }
  return out;
}
function devFmtErr(e, chunks) {
  let s = '- ' + String(e.m || e.message || '').slice(0, 300);
  if (e.f) {
    s += ' [' + e.f + (e.l ? ':' + e.l + (e.c ? ':' + e.c : '') : '');
    const hit = (chunks || []).filter(function (ch) { return ch.file === e.f && e.l >= ch.s && e.l <= ch.e; })[0];
    if (hit) s += ', part ' + hit.n + ' @part' + hit.n;
    s += ']';
  }
  return s;
}
// server paths that the page also uses (a change on one side usually needs the other side too)
function devLinks(chunks) {
  const re = /['"`](\/[A-Za-z][\w\-./]*)['"`]/g;
  const map = {};
  chunks.forEach(function (c) {
    const side = c.file.indexOf('public/') === 0 ? 'page' : (/\.js$/i.test(c.file) ? 'server' : '');
    if (!side) return;
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(c.t))) {
      const e = map[m[1]] || (map[m[1]] = { server: {}, page: {} });
      e[side]['@part' + c.n] = 1;
    }
  });
  return Object.keys(map).filter(function (p) { return Object.keys(map[p].server).length && Object.keys(map[p].page).length; }).slice(0, 14).map(function (p) {
    const cut = function (o) { const k = Object.keys(o); return k.slice(0, 5).join(' ') + (k.length > 5 ? ' +' + (k.length - 5) : ''); };
    return p + '  server: ' + cut(map[p].server) + '  page: ' + cut(map[p].page);
  });
}
function devExtras(idx, instruction, links) {
  const out = [];
  if (links && links.length) out.push('CROSS-FILE LINKS (a path used by both server.js and the page):\n' + links.join('\n'));
  if (!idx && devHist && devHist.undo && devHist.undo.length) out.push('RECENT PATCHES (oldest first):\n' + devHist.undo.slice(-3).map(function (e) { return '- ' + e.label; }).join('\n'));
  if (CLIENT_ERRS.length) { const ch = buildChunks(); out.push('ERRORS SEEN IN THE PREVIEW:\n' + CLIENT_ERRS.map(function (e) { return devFmtErr(e, ch); }).join('\n')); }
  return out;
}

// =====================================================================================================
// Everything below is new glue (server side): storage, history, guards, boot canary, apply, GitHub, HTTP
// =====================================================================================================

// ---------- workspace on disk ----------
function isPatchable(rel) { return TEXT_RE.test(rel) && !PROTECTED.test(rel); }
function isServerSide(f) { return f === 'package.json' || (/\.js$/i.test(f) && f.indexOf('public/') !== 0); }
function safeRel(rel) {
  const r = String(rel || '').replace(/\\/g, '/').replace(/^\.?\//, '');
  if (!r || r.split('/').indexOf('..') >= 0 || path.isAbsolute(r)) return '';
  const abs = path.resolve(ROOT, r);
  return abs.indexOf(ROOT + path.sep) === 0 ? r : '';
}
function scanWorkspace() {
  const ws = {}, crlf = {}, raw = {};
  (function walk(dir, prefix, depth) {
    if (depth > 4) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    ents.forEach(function (en) {
      if (en.isDirectory()) {
        if (!SKIP_DIRS[en.name] && en.name.charAt(0) !== '.') walk(path.join(dir, en.name), prefix + en.name + '/', depth + 1);
        return;
      }
      const rel = prefix + en.name;
      if (!isPatchable(rel)) return;
      const abs = path.join(dir, en.name);
      let st;
      try { st = fs.statSync(abs); } catch (e) { return; }
      if (st.size > 3e6) return;
      const buf = fs.readFileSync(abs);
      const t = buf.toString('utf8');
      crlf[rel] = t.indexOf('\r\n') >= 0;
      ws[rel] = t.replace(/\r\n/g, '\n');
      raw[rel] = sha(buf);
    });
  })(ROOT, '', 0);
  return { ws: ws, crlf: crlf, raw: raw };
}
function writeAtomic(rel, text, useCrlf) {
  const abs = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const data = Buffer.from(useCrlf ? text.replace(/\n/g, '\r\n') : text, 'utf8');
  const tmp = abs + '.devtmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, abs);
  return data;
}
function readRaw(rel) { try { return fs.readFileSync(path.join(ROOT, rel)); } catch (e) { return null; } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
function writeJsonAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, p);
}

// ---------- history (undo / redo) with a blob store, survives restarts ----------
let hist = { undo: [], redo: [] };
(function histLoad() {
  const h = readJson(HIST_FILE);
  if (h && Array.isArray(h.undo) && Array.isArray(h.redo)) hist = h;
})();
function putBlob(buf) {
  const h = sha(buf);
  const p = path.join(BLOBS, h);
  if (!fs.existsSync(p)) { fs.mkdirSync(BLOBS, { recursive: true }); fs.writeFileSync(p, buf); }
  return h;
}
function getBlob(h) { return fs.readFileSync(path.join(BLOBS, h)); }
function histSave() {
  while (hist.undo.length > 15) hist.undo.shift();
  writeJsonAtomic(HIST_FILE, hist);
  const keep = {};
  hist.undo.concat(hist.redo).forEach(function (en) {
    Object.keys(en.files).forEach(function (f) { if (en.files[f].b) keep[en.files[f].b] = 1; if (en.files[f].a) keep[en.files[f].a] = 1; });
  });
  try { fs.readdirSync(BLOBS).forEach(function (n) { if (!keep[n]) { try { fs.unlinkSync(path.join(BLOBS, n)); } catch (e) { /* ignore */ } } }); } catch (e) { /* ignore */ }
}
function histView() {
  return {
    undo: hist.undo.map(function (en) {
      const files = {};
      Object.keys(en.files).forEach(function (f) {
        const o = { a: en.files[f].a };
        Object.defineProperty(o, 'b', { get: function () { const h = en.files[f].b; return h ? getBlob(h).toString('utf8').replace(/\r\n/g, '\n') : null; } });
        files[f] = o;
      });
      return { t: en.t, label: en.label, files: files };
    }),
    redo: []
  };
}

// ---------- syntax guard (Node's own parser: nothing is executed) ----------
function jsProblem(name, text) {
  try {
    new vm.Script('(function (exports, require, module, __filename, __dirname) {' + text + '\n})', { filename: name });
    return '';
  } catch (e) {
    const m = /:(\d+)\b/.exec(String(e.stack || '').split('\n')[0]);
    return (m ? 'line ' + m[1] + ': ' : '') + e.name + ': ' + e.message;
  }
}
function htmlProblem(name, text) {
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(text))) {
    const attrs = m[1];
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const ty = (/\btype\s*=\s*["']?([^"'\s>]*)/i.exec(attrs) || [0, ''])[1].toLowerCase();
    if (ty && ty !== 'text/javascript' && ty !== 'application/javascript') continue;
    try { new vm.Script(m[2], { filename: name }); } catch (e) {
      const off = text.slice(0, m.index + m[0].indexOf('>') + 1).split('\n').length - 1;
      const mm = /:(\d+)\b/.exec(String(e.stack || '').split('\n')[0]);
      return 'inline script' + (mm ? ' at line ' + (off + Number(mm[1])) : '') + ': ' + e.name + ': ' + e.message;
    }
  }
  return '';
}
function syntaxProblem(name, text) {
  if (/\.json$/i.test(name)) { try { JSON.parse(text); return ''; } catch (e) { return 'is not valid JSON: ' + e.message; } }
  if (/\.js$/i.test(name)) return jsProblem(name, text);
  if (/\.html?$/i.test(name)) return htmlProblem(name, text);
  return '';
}
// before / after = {file: text or null}. Blames the patch only when the file parsed before and does not now.
function guardChanges(before, after) {
  for (const f of Object.keys(after)) {
    if (after[f] == null) continue;
    const why = syntaxProblem(f, after[f]);
    if (why && (before[f] == null || !syntaxProblem(f, before[f]))) {
      return '\ud83d\uded1 SYNTAX GUARD: ' + f + ' ' + why + '\n\nThe patch was NOT applied and NOTHING WAS CHANGED. Check that every block closes its brackets and that OLD and NEW keep the same surrounding lines.';
    }
  }
  return '';
}
function refProblems(ws) {
  const out = [];
  Object.keys(ws).forEach(function (f) {
    if (!/\.js$/i.test(f) || f.indexOf('public/') === 0) return;
    const re = /require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;
    let m;
    while ((m = re.exec(ws[f]))) {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]));
      const ok = [base, base + '.js', base + '.json', base + '/index.js'].some(function (c) {
        return Object.prototype.hasOwnProperty.call(ws, c) || fs.existsSync(path.join(ROOT, c));
      });
      if (!ok) out.push(f + ' requires ' + m[1]);
    }
  });
  return out;
}

// ---------- boot canary: start the patched server for a few seconds, with network + trader OFF ----------
const STUB = [
  "const Module = require('module'); const EE = require('events');",
  "class FakeWS extends EE { constructor() { super(); this.readyState = 0; } send() {} close() { this.readyState = 3; } terminate() { this.readyState = 3; } ping() {} pong() {} }",
  "FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3; FakeWS.WebSocket = FakeWS;",
  "class FakeServer extends EE { constructor() { super(); this.clients = new Set(); } handleUpgrade() {} close(cb) { if (cb) cb(); } }",
  "FakeWS.Server = FakeServer; FakeWS.WebSocketServer = FakeServer;",
  "const orig = Module._load;",
  "Module._load = function (request) { if (request === 'ws') return FakeWS; return orig.apply(this, arguments); };",
  "globalThis.fetch = function () { return Promise.reject(new Error('network disabled in the boot canary')); };"
].join('\n');

function httpGet(port, p, ms) {
  return new Promise(function (resolve) {
    const req = require('http').get({ host: '127.0.0.1', port: port, path: p, timeout: ms || 2000 }, function (res) {
      let b = '';
      res.on('data', function (c) { b += c; });
      res.on('end', function () { resolve({ status: res.statusCode, body: b }); });
    });
    req.on('error', function () { resolve(null); });
    req.on('timeout', function () { req.destroy(); resolve(null); });
  });
}
async function bootCanary(ws) {
  if (process.env.DEV_SKIP_CANARY === '1') return '';
  const dir = path.join(DIR, 'canary-' + Date.now());
  const port = 20000 + Math.floor(Math.random() * 20000);
  let child = null, err = '';
  const tail = [];
  try {
    Object.keys(ws).forEach(function (f) {
      const abs = path.join(dir, f);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, ws[f]);
    });
    if (!fs.existsSync(path.join(dir, 'server.js'))) return 'CANARY: server.js is missing in the patched project.';
    fs.writeFileSync(path.join(dir, '__stub.js'), STUB);
    const env = Object.assign({}, process.env, { PORT: String(port), DRV_AUTO: '0', DRV_LOG_FILE: 'off', API_TOKEN: '', ACCESS_TOKEN: '', DEV_PATCH: '0', DEV_SUPERVISED: '0', GH_TOKEN: '' });
    child = cp.spawn(process.execPath, ['--require', path.join(dir, '__stub.js'), 'server.js'], { cwd: dir, env: env, stdio: ['ignore', 'pipe', 'pipe'] });
    let dead = false;
    child.on('exit', function () { dead = true; });
    [child.stdout, child.stderr].forEach(function (s) { s.on('data', function (d) { String(d).split('\n').forEach(function (l) { if (l.trim() && !/\(node:|^\s+at .*node:internal|__stub\.js/.test(l)) { tail.push(l); if (tail.length > 14) tail.shift(); } }); }); });
    let up = false;
    for (let i = 0; i < 70 && !dead; i++) {
      await new Promise(function (r) { setTimeout(r, 300); });
      const r = await httpGet(port, '/ping');
      if (r && r.status === 200) { up = true; break; }
    }
    if (!up) err = dead ? 'the patched server exited during startup' : 'the patched server did not answer /ping within 20 s';
    if (!err) {
      const st = await httpGet(port, '/status');
      if (!st || st.status !== 200) err = '/status did not answer 200 on the patched server';
      else { try { JSON.parse(st.body); } catch (e) { err = '/status did not return valid JSON'; } }
    }
    if (!err) {
      await new Promise(function (r) { setTimeout(r, 2500); });
      if (dead) err = 'the patched server crashed 2 s after it started';
    }
  } catch (e) { err = 'canary could not run: ' + e.message; }
  try { if (child && child.exitCode === null) child.kill('SIGTERM'); } catch (e) { /* ignore */ }
  await new Promise(function (r) { setTimeout(r, 400); });
  try { if (child && child.exitCode === null) child.kill('SIGKILL'); } catch (e) { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  if (!err) return '';
  return '\ud83d\uded1 BOOT CANARY: ' + err + '.\n\n' + (tail.length ? 'Last output of the patched server:\n' + tail.slice(-10).join('\n') + '\n\n' : '') + 'The patch was NOT applied and NOTHING WAS CHANGED.';
}

// ---------- apply ----------
let busy = false;
function patchErrorReport(msg) {
  let r = 'PATCH ERROR: your last patch was NOT applied and nothing was changed (all blocks are applied together or not at all).\n\nError: ' + msg;
  if (/^(Block \d+ of \d+ failed: )?(Chunk not found|Ambiguous|Low confidence)/.test(msg) && devFailOld) {
    try { r += '\n\nCURRENT CODE (copy the OLD text from here exactly):\n\n' + liteSource(devFailOld); } catch (e) { /* ignore */ }
  }
  r += '\n\nFix it and resend ALL blocks of the corrected patch in the same format: the WHOLE patch in ONE fenced code block (==== FILE: name ==== header, OLD' + DEV_SPLIT + 'NEW, ' + DEV_BLOCK + ' between blocks, no prose inside the fence), plus at most one plain sentence before the fence naming the confirmed cause. Nothing after the fence.';
  return r;
}
function fail(msg) { dlog('PATCH', 'FAILED: ' + String(msg).slice(0, 200)); return { ok: false, error: String(msg), report: patchErrorReport(String(msg)) }; }

function scheduleRestart(entryId) {
  if (entryId) writeJsonAtomic(PENDING, { t: Date.now(), id: entryId });   // undo / redo restarts are never auto-rolled-back
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(RESTART_FLAG, String(Date.now()));
  dlog('RESTART', 'server restart requested (supervisor will start it again)');
  setTimeout(function () { try { process.kill(process.pid, 'SIGTERM'); } catch (e) { /* ignore */ } }, 700);
}
function afterChange(changed, entryId) {
  if (!changed.some(isServerSide)) return { kind: 'page', note: 'Page file saved: the preview reloads.' };
  if (ON_RENDER) return { kind: 'staged', note: 'Saved on this Render instance only (a restart or redeploy wipes it). Push it to GitHub to deploy.' };
  if (SUPERVISED) { scheduleRestart(entryId); return { kind: 'restarting', note: 'Server files changed: restarting the server (auto-rollback if it dies in the first 30 s).' }; }
  return { kind: 'manual', note: 'Server files changed. Restart the server yourself (start.bat) to run them.' };
}

async function applyPatch(text) {
  const w = scanWorkspace();
  const before = Object.assign({}, w.ws);
  devWorkspace = Object.assign({}, w.ws);
  devFailOld = '';
  if (!Object.keys(devWorkspace).length) return fail('No project files found next to devpatch.js.');
  const blocks = parseAllBlocks(String(text || ''));
  if (!blocks.length) return fail('No valid patch found.\nExpected:\n==== FILE: filename ====\nOLD code\n' + DEV_SPLIT + '\nNEW code\n\nSeparate several blocks with ' + DEV_BLOCK + '.');
  const MAX_LINE = 3000;
  for (let k = 0; k < blocks.length; k++) {
    let worst = 0;
    (blocks[k].newCode || '').split('\n').forEach(function (l) { if (l.length > worst) worst = l.length; });
    const b64 = /base64,[A-Za-z0-9+\/=]{2000,}/.test(blocks[k].newCode || '');
    if (worst > MAX_LINE || b64) return fail('\ud83d\udeab PATCH BLOCKED (block ' + (k + 1) + ')\n\n' + (b64 ? 'It contains an embedded base64 blob.' : 'It has a line of ' + worst + ' characters (limit ' + MAX_LINE + ').') + '\n\nNOTHING WAS CHANGED. Keep that data in a separate file or use a normal multi-line format.');
  }
  for (let k = 0; k < blocks.length; k++) {
    const fnm = blocks[k].filename ? String(blocks[k].filename).replace(/\\/g, '/').replace(/^\.?\//, '') : '';
    if (fnm && (PROTECTED.test(fnm) || !safeRel(fnm))) return fail('Block ' + (k + 1) + ' of ' + blocks.length + ' failed: ' + fnm + ' is protected or outside the project. devpatch.js, supervisor.js and public/dev.html can only be changed through git.\n\nNOTHING WAS CHANGED.');
  }
  dlog('PATCH', 'Applying ' + blocks.length + ' block(s)');
  for (let k = 0; k < blocks.length; k++) {
    const r = devApplyBlock(blocks[k]);
    if (!r.success) return fail('Block ' + (k + 1) + ' of ' + blocks.length + ' failed: ' + r.error + '\n\nNOTHING WAS CHANGED (all blocks are applied together or not at all).');
  }
  const keys = Object.keys(devWorkspace).concat(Object.keys(before).filter(function (k) { return !(k in devWorkspace); }));
  const changed = keys.filter(function (f) { return devWorkspace[f] !== before[f]; });
  if (!changed.length) return { ok: false, error: 'The patch changed nothing (NEW equals OLD).', noop: true };
  for (const f of changed) {
    if (PROTECTED.test(f) || !safeRel(f)) return fail(f + ' is protected or outside the project.\n\nNOTHING WAS CHANGED.');
  }
  const bMap = {}, aMap = {};
  changed.forEach(function (f) { bMap[f] = (f in before) ? before[f] : null; aMap[f] = (f in devWorkspace) ? devWorkspace[f] : null; });
  const guard = guardChanges(bMap, aMap);
  if (guard) return fail(guard);
  const wasRef = {};
  refProblems(before).forEach(function (x) { wasRef[x] = 1; });
  const badRef = refProblems(devWorkspace).filter(function (x) { return !wasRef[x]; });
  if (badRef.length) return fail('\ud83d\uded1 REFERENCE CHECK: ' + badRef.join('; ') + '.\n\nThe patch was NOT applied and NOTHING WAS CHANGED. Create the file in the same patch (FILE header, empty OLD) or fix the reference.');
  if (changed.some(isServerSide)) {
    dlog('CANARY', 'booting the patched server on a scratch port...');
    const c = await bootCanary(devWorkspace);
    if (c) return fail(c);
    dlog('CANARY', 'passed');
  }
  // commit: blobs first (so undo always works), then the files, then the history entry
  const files = {};
  changed.forEach(function (f) {
    const oldRaw = readRaw(f);
    files[f] = { b: oldRaw ? putBlob(oldRaw) : null, a: null };
  });
  changed.forEach(function (f) {
    if (aMap[f] == null) { try { fs.unlinkSync(path.join(ROOT, f)); } catch (e) { /* ignore */ } files[f].a = null; return; }
    const data = writeAtomic(f, aMap[f], !!w.crlf[f]);
    files[f].a = putBlob(data);
  });
  const label = changed.map(function (f) { return devDescribe(f, before[f] == null ? null : before[f], devWorkspace[f] == null ? null : devWorkspace[f]); }).join(' | ');
  const entry = { id: crypto.randomBytes(5).toString('hex'), t: Date.now(), label: label, files: files };
  hist.undo.push(entry);
  hist.redo = [];
  histSave();
  dlog('PATCH', 'OK ' + blocks.length + ' block(s): ' + label);
  const next = afterChange(changed, entry.id);
  return { ok: true, changed: changed, label: label, kind: next.kind, note: next.note, entry: entry.id };
}

async function stepHistory(mode, force) {
  const from = mode === 'undo' ? hist.undo : hist.redo;
  const to = mode === 'undo' ? hist.redo : hist.undo;
  if (!from.length) return { ok: false, error: 'Nothing to ' + mode + '.' };
  const en = from[from.length - 1];
  const names = Object.keys(en.files);
  const expect = mode === 'undo' ? 'a' : 'b', put = mode === 'undo' ? 'b' : 'a';
  const stale = names.filter(function (f) {
    const raw = readRaw(f);
    return (raw ? sha(raw) : null) !== (en.files[f][expect] || null);
  });
  if (stale.length && !force) return { ok: false, needConfirm: true, stale: stale, error: stale.join(', ') + ' changed since this patch (edited by hand or by another patch).' };
  names.forEach(function (f) {
    const h = en.files[f][put];
    if (!h) { try { fs.unlinkSync(path.join(ROOT, f)); } catch (e) { /* ignore */ } }
    else {
      const abs = path.join(ROOT, f);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs + '.devtmp', getBlob(h));
      fs.renameSync(abs + '.devtmp', abs);
    }
  });
  from.pop();
  to.push(en);
  histSave();
  dlog('PATCH', mode + ': ' + en.label);
  const next = afterChange(names, null);
  return { ok: true, label: en.label, kind: next.kind, note: next.note };
}

// ---------- payload (index / lite / full, same decision logic as EXT OS devMakePayload) ----------
function makePayload(instruction, flags, errors) {
  flags = flags || {};
  CLIENT_ERRS = Array.isArray(errors) ? errors.slice(0, 6) : [];
  devWorkspace = scanWorkspace().ws;
  devHist = histView();
  const wantUser = flags.user !== false, wantSuper = flags.prompt !== false, wantSource = flags.source !== false, wantLite = flags.lite !== false;
  const delta = flags.delta === true;   // follow-up round: only the newly asked parts, no extras (the AI chat already has the rest)
  if (!Object.keys(devWorkspace).length && wantSource) return { ok: false, error: 'No project files found.' };
  const parts = [];
  const tg = liteTags(instruction || '');
  const isAuto = tg.indexOf('auto') >= 0;
  const hasTags = tg.filter(function (x) { return x !== 'auto'; }).length > 0;
  const chunks = (wantSource && wantLite) ? liteBuild() : [];
  const big = chunks.length > 0;
  const idx = !!(big && wantUser && instruction && !hasTags && !isAuto);
  if (wantSuper && !idx) parts.push(SUPER_PROMPT);
  if (wantUser && instruction) parts.push('User Instruction: ' + instruction);
  if (wantSource) {
    if (idx) parts.push(liteIndex(instruction));
    else if (big) parts.push(liteSource(instruction || '', delta && hasTags));
    else {
      let all = '';
      Object.keys(devWorkspace).forEach(function (f) { all += '==== FILE: ' + f + ' ====\n' + devWorkspace[f] + '\n\n'; });
      parts.push(all.trim());
    }
    if (!(delta && hasTags)) devExtras(idx, instruction, chunks.length ? devLinks(chunks) : []).forEach(function (x) { if (x) parts.push(x); });
  }
  if (!parts.length) return { ok: false, error: 'Nothing to copy.' };
  return { ok: true, text: parts.join('\n\n'), idx: idx, big: big, hasTags: hasTags || isAuto };
}
function classify(text) {
  text = String(text || '');
  if (/Surgery Scenarios|^\s*(LITE MODE|INDEX MODE|RUNTIME ERROR|PATCH ERROR)/.test(text)) return { kind: 'other' };
  if (text.indexOf(DEV_SPLIT) >= 0) return { kind: 'patch' };
  if (!text.trim() || text.length > 4000 || /^\s*PATCH ERROR/.test(text) || /LITE MODE|INDEX MODE|Surgery Scenarios|RUNTIME ERROR/.test(text)) return { kind: 'other' };
  devWorkspace = scanWorkspace().ws;
  const found = (text.match(/@[\w$-]+/g) || []).filter(function (t, i, a) { return a.indexOf(t) === i && devKnownTag(t); });
  if (!found.length) return { kind: 'other' };
  return { kind: 'tags', tags: found, req: text.replace(/@[\w$-]+/g, ' ').replace(/\s+/g, ' ').trim() };
}
function runtimeReport(errors) {
  devWorkspace = scanWorkspace().ws;
  CLIENT_ERRS = (Array.isArray(errors) ? errors : []).slice(0, 5);
  if (!CLIENT_ERRS.length) return { ok: false, error: 'No errors recorded.' };
  const chunks = liteBuild();
  const txt = CLIENT_ERRS.map(function (e) { return devFmtErr(e, chunks); }).join('\n');
  let extra = '';
  const e1 = CLIENT_ERRS[0];
  const hit = chunks.filter(function (ch) { return ch.file === e1.f && e1.l >= ch.s && e1.l <= ch.e; })[0];
  if (hit) extra = '=== PART ' + hit.n + ' ' + hit.file + ' (lines ' + hit.s + '-' + hit.e + ') ===\n' + hit.t;
  return {
    ok: true,
    text: 'RUNTIME ERROR after your last patch: the patch was applied and saved, but the page now throws.\n\n' + txt + '\n\n' + (extra ? 'CODE AROUND THE ERROR:\n\n' + extra + '\n\n' : '') +
      'Find the cause and resend a corrected patch in the same format: the WHOLE patch in ONE fenced code block (==== FILE: name ==== header, OLD' + DEV_SPLIT + 'NEW, no prose inside the fence), plus at most one plain sentence before the fence naming the confirmed cause. Nothing after the fence.'
  };
}

// ---------- GitHub: push (one commit), mark stable, restore stable ----------
function ghReady() { return !!(GH_TOKEN && /^[\w.-]+\/[\w.-]+$/.test(GH_REPO)); }
async function gh(method, p, body) {
  const res = await fetch(GH_API + '/repos/' + GH_REPO + p, {
    method: method,
    headers: { Authorization: 'Bearer ' + GH_TOKEN, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'devpatch', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* ignore */ }
  if (!res.ok) { const er = new Error(method + ' ' + p.split('?')[0] + ' -> ' + res.status + ' ' + ((data && data.message) || res.statusText)); er.status = res.status; throw er; }
  return data;
}
function blobSha(buf) { return crypto.createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + buf.length + '\0'), buf])).digest('hex'); }
const PUSH_BASE = ['server.js', 'package.json', 'package-lock.json', 'public/index.html', 'public/dev.html', 'devpatch.js', 'supervisor.js', 'start.bat', 'start.sh', 'README.md', 'DEVPATCH.md', '.gitignore'];

async function pushToGitHub() {
  if (!ghReady()) throw new Error('GitHub is not configured: set GH_TOKEN and GH_REPO (owner/repo) in the environment.');
  const names = PUSH_BASE.concat(Object.keys(scanWorkspace().ws)).filter(function (f, i, a) { return a.indexOf(f) === i && safeRel(f) && fs.existsSync(path.join(ROOT, f)); });
  const items = [];
  names.forEach(function (f) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
    const bad = TEXT_RE.test(f) ? syntaxProblem(f, text) : '';
    if (bad) throw new Error('Not pushing: ' + f + ' ' + bad);
    items.push({ f: f, buf: Buffer.from(text, 'utf8') });
  });
  const ref = await gh('GET', '/git/ref/heads/' + GH_BRANCH);
  const head = ref.object.sha;
  const commit = await gh('GET', '/git/commits/' + head);
  const tree = await gh('GET', '/git/trees/' + commit.tree.sha + '?recursive=1');
  if (tree.truncated) throw new Error('The repo tree is too large to compare in one request.');
  const remote = {};
  tree.tree.forEach(function (e) { if (e.type === 'blob') remote[e.path] = e; });
  const entries = [], changed = [];
  items.forEach(function (it) {
    const r = remote[it.f];
    if (r && r.sha === blobSha(it.buf)) return;
    changed.push(it.f);
    entries.push({ path: it.f, mode: r ? r.mode : '100644', type: 'blob', content: it.buf.toString('utf8') });
  });
  if (!entries.length) return { ok: true, nothing: true, msg: 'GitHub already matches this folder.' };
  const nt = await gh('POST', '/git/trees', { base_tree: commit.tree.sha, tree: entries });
  const msg = 'DevPatch: ' + changed.slice(0, 5).join(', ') + (changed.length > 5 ? ' +' + (changed.length - 5) + ' more' : '');
  const nc = await gh('POST', '/git/commits', { message: msg, tree: nt.sha, parents: [head] });
  await gh('PATCH', '/git/refs/heads/' + GH_BRANCH, { sha: nc.sha });
  dlog('PUSH', msg + ' | ' + nc.sha);
  return { ok: true, sha: nc.sha, files: changed, msg: 'Pushed ' + changed.length + ' file(s) to ' + GH_BRANCH + ' (' + nc.sha.slice(0, 7) + ').' + (ON_RENDER ? ' Render will redeploy and restart this server.' : '') };
}
async function setStableRef(sha) {
  try { await gh('GET', '/git/ref/heads/stable'); await gh('PATCH', '/git/refs/heads/stable', { sha: sha, force: true }); }
  catch (e) {
    if (e.status === 404) await gh('POST', '/git/refs', { ref: 'refs/heads/stable', sha: sha });
    else throw e;
  }
}
async function stableAction(action) {
  if (!ghReady()) throw new Error('GitHub is not configured: set GH_TOKEN and GH_REPO.');
  if (action === 'mark') {
    const sha = process.env.RENDER_GIT_COMMIT || (await gh('GET', '/git/ref/heads/' + GH_BRANCH)).object.sha;
    await setStableRef(sha);
    dlog('STABLE', 'marked ' + sha);
    return { ok: true, msg: 'Marked ' + sha.slice(0, 7) + ' as the stable version.' };
  }
  if (action === 'restore') {
    let st;
    try { st = await gh('GET', '/git/ref/heads/stable'); } catch (e) { if (e.status === 404) throw new Error('No stable version marked yet.'); throw e; }
    const head = (await gh('GET', '/git/ref/heads/' + GH_BRANCH)).object.sha;
    const sc = await gh('GET', '/git/commits/' + st.object.sha);
    const hc = await gh('GET', '/git/commits/' + head);
    if (sc.tree.sha === hc.tree.sha) return { ok: true, msg: GH_BRANCH + ' already matches the stable version.' };
    const nc = await gh('POST', '/git/commits', { message: 'DevPatch: restore stable ' + st.object.sha.slice(0, 7), tree: sc.tree.sha, parents: [head] });
    await gh('PATCH', '/git/refs/heads/' + GH_BRANCH, { sha: nc.sha });
    dlog('STABLE', 'restored ' + st.object.sha);
    return { ok: true, msg: 'Restored the stable version as a new commit (' + nc.sha.slice(0, 7) + ').' + (ON_RENDER ? ' Render will redeploy.' : '') };
  }
  throw new Error('Unknown action.');
}

// ---------- HTTP ----------
function loopback(req) {
  const a = req.socket && req.socket.remoteAddress;
  return (a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1') && !req.headers['x-forwarded-for'];
}
const fails = {};
function clientKey(req) { return String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '').split(',')[0].trim(); }
function secretOk(req, SECRET) {
  const k = clientKey(req), now = Date.now();
  const f = fails[k] || (fails[k] = { n: 0, t: now });
  if (now - f.t > 60000) { f.n = 0; f.t = now; }
  if (f.n >= 8) return 429;
  const got = String(req.headers['x-dev-secret'] || '');
  const a = crypto.createHash('sha256').update(got).digest(), b = crypto.createHash('sha256').update(SECRET).digest();
  if (crypto.timingSafeEqual(a, b)) return 200;
  f.n++;
  return 401;
}
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}
function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    let n = 0;
    const ch = [];
    req.on('data', function (c) { n += c.length; if (n > limit) { reject(new Error('Request too large')); req.destroy(); return; } ch.push(c); });
    req.on('end', function () { resolve(Buffer.concat(ch).toString('utf8')); });
    req.on('error', reject);
  });
}
function stateObj() {
  const w = scanWorkspace();
  const le = readJson(LAST_ERR);
  return {
    ok: true,
    boot: BOOT_ID,
    uptime: Math.round(process.uptime()),
    mode: ON_RENDER ? 'render' : (SUPERVISED ? 'local' : 'local-unsupervised'),
    canRestart: SUPERVISED && !ON_RENDER,
    commit: process.env.RENDER_GIT_COMMIT || '',
    files: Object.keys(w.ws).map(function (f) { return { path: f, lines: w.ws[f].split('\n').length }; }),
    undo: hist.undo.map(function (e) { return e.label; }).slice(-5),
    undoCount: hist.undo.length,
    redoCount: hist.redo.length,
    gh: { configured: ghReady(), repo: GH_REPO, branch: GH_BRANCH },
    lastError: le,
    log: LOG.slice(-30)
  };
}

function makeHandler(SECRET) {
  const routes = {
    state: async function () { return stateObj(); },
    payload: async function (b) { return makePayload(String(b.instruction || '').trim(), b.flags, b.errors); },
    classify: async function (b) { return Object.assign({ ok: true }, classify(b.text)); },
    errreport: async function (b) { return runtimeReport(b.errors); },
    apply: async function (b) { return applyPatch(b.patch); },
    undo: async function (b) { return stepHistory('undo', !!b.force); },
    redo: async function (b) { return stepHistory('redo', !!b.force); },
    restart: async function () {
      if (!(SUPERVISED && !ON_RENDER)) return { ok: false, error: ON_RENDER ? 'A restart on Render would wipe unpushed patches: push to deploy instead.' : 'The server was not started by supervisor.js (use start.bat / start.sh).' };
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(RESTART_FLAG, String(Date.now()));
      setTimeout(function () { try { process.kill(process.pid, 'SIGTERM'); } catch (e) { /* ignore */ } }, 500);
      return { ok: true, msg: 'Restarting...' };
    },
    push: async function () { return pushToGitHub(); },
    stable: async function (b) { return stableAction(String(b.action || '')); },
    ackerror: async function () { try { fs.unlinkSync(LAST_ERR); } catch (e) { /* ignore */ } return { ok: true }; }
  };
  const locked = { apply: 1, undo: 1, redo: 1, push: 1, stable: 1 };
  return function handle(req, res, pathname) {
    if (!ENABLED) return false;
    if (!ALLOW_REMOTE && !loopback(req)) return false;
    if (pathname === '/dev' || pathname === '/dev/') {
      if (req.method !== 'GET') return false;
      fs.readFile(path.join(ROOT, 'public', 'dev.html'), function (err, buf) {
        if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('public/dev.html not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(buf);
      });
      return true;
    }
    if (pathname.indexOf('/dev/api/') !== 0) return false;
    const name = pathname.slice(9);
    if (req.method !== 'POST' || !routes[name]) { send(res, 404, { ok: false, error: 'Not found' }); return true; }
    const origin = req.headers.origin;
    if (origin) { let oh = ''; try { oh = new URL(origin).host; } catch (e) { /* ignore */ } if (oh !== req.headers.host) { send(res, 403, { ok: false, error: 'Cross-origin request refused' }); return true; } }
    const sc = NO_SECRET ? 200 : secretOk(req, SECRET);
    if (sc !== 200) { send(res, sc, { ok: false, error: sc === 429 ? 'Too many wrong secrets: wait a minute.' : 'Wrong or missing dev secret.' }); return true; }
    readBody(req, 3 * 1024 * 1024).then(function (raw) {
      let b = {};
      try { b = raw ? JSON.parse(raw) : {}; } catch (e) { send(res, 400, { ok: false, error: 'Bad JSON' }); return null; }
      if (locked[name]) {
        if (busy) { send(res, 409, { ok: false, error: 'Busy: another patch action is running.' }); return null; }
        busy = true;
      }
      return routes[name](b).then(function (r) { send(res, 200, r); }, function (e) { send(res, 200, { ok: false, error: String((e && e.message) || e) }); })
        .then(function () { if (locked[name]) busy = false; });
    }).catch(function (e) { busy = false; try { send(res, 500, { ok: false, error: String((e && e.message) || e) }); } catch (x) { /* ignore */ } });
    return true;
  };
}

// ---------- startup ----------
let handle = function () { return false; };
if (ENABLED) {
  let secret = String(process.env.DEV_SECRET || '');
  if (!secret && !ON_RENDER) {
    try {
      secret = fs.existsSync(SECRET_FILE) ? fs.readFileSync(SECRET_FILE, 'utf8').trim() : '';
      if (!secret) { fs.mkdirSync(DIR, { recursive: true }); secret = crypto.randomBytes(12).toString('hex'); fs.writeFileSync(SECRET_FILE, secret); }
      dlog('SECRET', 'local dev secret is in .devpatch/secret.txt: ' + secret);
    } catch (e) { secret = ''; }
  }
  if (secret.length < 16 && !NO_SECRET) {
    dlog('OFF', 'DEV_PATCH=1 but DEV_SECRET is missing or shorter than 16 characters: the patch tool stays OFF.');
  } else {
    handle = makeHandler(secret);
    dlog('ON', 'patch tool at /dev (' + (ALLOW_REMOTE ? 'REMOTE ALLOWED' : 'local only') + ', ' + (ON_RENDER ? 'render' : (SUPERVISED ? 'supervised' : 'unsupervised')) + ', boot ' + BOOT_ID + ')');
    // a restart after a patch counts as healthy when it survives 20 s
    const pend = readJson(PENDING);
    if (pend && pend.t && Date.now() - pend.t < 180000) {
      setTimeout(function () { try { fs.unlinkSync(PENDING); } catch (e) { /* ignore */ } dlog('HEALTH', 'new version survived 20 s'); }, 20000).unref();
    } else if (pend) { try { fs.unlinkSync(PENDING); } catch (e) { /* ignore */ } }
    // on Render: a deploy that stays up 10 minutes without an uncaught exception becomes "stable"
    let crashed = false;
    process.on('uncaughtExceptionMonitor', function () { crashed = true; });
    if (ON_RENDER && ghReady() && process.env.RENDER_GIT_COMMIT && process.env.DEV_AUTO_STABLE !== '0') {
      setTimeout(function () {
        if (crashed) { dlog('STABLE', 'not marked: an uncaught exception happened'); return; }
        setStableRef(process.env.RENDER_GIT_COMMIT).then(function () { dlog('STABLE', 'auto-marked ' + process.env.RENDER_GIT_COMMIT); }, function (e) { dlog('STABLE', 'auto-mark failed: ' + e.message); });
      }, 10 * 60 * 1000).unref();
    }
  }
}

// One-line hook for server.js:  require('./devpatch').attach(require('http'));
// Wraps the HTTP 'request' event, so it works for plain http and for express alike. Does nothing unless DEV_PATCH=1.
function attach(httpMod) {
  if (!ENABLED || !httpMod || !httpMod.Server || httpMod.Server.prototype.__devpatch) return false;
  const orig = httpMod.Server.prototype.emit;
  httpMod.Server.prototype.emit = function (ev, req, res) {
    if (ev === 'request' && req && res) {
      try { if (handle(req, res, String(req.url || '/').split('?')[0])) return true; } catch (e) { dlog('ERR', 'handler: ' + e.message); }
    }
    return orig.apply(this, arguments);
  };
  httpMod.Server.prototype.__devpatch = true;
  return true;
}

module.exports = {
  attach: attach,
  handle: function (req, res, pathname) { return handle(req, res, pathname); },
  _test: { parseAllBlocks: parseAllBlocks, scanWorkspace: scanWorkspace, makePayload: makePayload, syntaxProblem: syntaxProblem, classify: classify, bootCanary: bootCanary }
};
