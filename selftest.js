'use strict';
/* selftest.js - run it with test.bat (Windows) or: node selftest.js
 *
 * Checks that the folder is complete, starts the bot under supervisor.js on a spare port (default 3999) with
 * trading switched off, and walks the patch tool through its whole chain using throwaway probe files:
 *   page patch -> undo, then a server-side patch (boot canary -> automatic restart) -> undo (restart again).
 * It never edits your server.js or public/index.html. Everything it creates is removed again.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const ROOT = __dirname;
const PORT = Number(process.env.SELFTEST_PORT || 3999);
const SECRET = crypto.randomBytes(16).toString('hex');
const BASE = 'http://127.0.0.1:' + PORT;
const FENCE = '```';
let bad = 0, warns = 0, sup = null;
const tail = [];

function say(m) { console.log(m); }
function ok(m) { say('  [ OK ] ' + m); }
function no(m) { bad++; say('  [FAIL] ' + m); }
function wn(m) { warns++; say('  [warn] ' + m); }
function head(m) { say('\n' + m); }
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
const exists = function (f) { return fs.existsSync(path.join(ROOT, f)); };
const reply = function (code) { return 'Selftest.\n\n' + FENCE + '\n' + code + '\n' + FENCE + '\n'; };

async function api(name, body, secret) {
  try {
    const r = await fetch(BASE + '/dev/api/' + name, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-dev-secret': secret === undefined ? SECRET : secret }, body: JSON.stringify(body || {}) });
    const j = await r.json();
    j._status = r.status;
    return j;
  } catch (e) { return { ok: false, down: true, error: 'cannot reach the server', _status: 0 }; }
}
async function ping() {
  try { const r = await fetch(BASE + '/ping'); return r.status === 200; } catch (e) { return false; }
}
async function waitUp(seconds) {
  for (let i = 0; i < seconds * 2; i++) { if (await ping()) return true; await sleep(500); }
  return false;
}
async function waitBoot(prevBoot, seconds) {
  for (let i = 0; i < seconds * 2; i++) {
    await sleep(500);
    const s = await api('state');
    if (s.ok && s.boot && s.boot !== prevBoot) return s;
  }
  return null;
}
function stopAll() {
  if (!sup) return;
  try {
    if (process.platform === 'win32') cp.spawnSync('taskkill', ['/pid', String(sup.pid), '/T', '/F'], { stdio: 'ignore' });
    else sup.kill('SIGTERM');
  } catch (e) { /* ignore */ }
  sup = null;
}
function finish(hadDir) {
  stopAll();
  setTimeout(function () {
    if (!hadDir) { try { fs.rmSync(path.join(ROOT, '.devpatch'), { recursive: true, force: true }); } catch (e) { /* ignore */ } }
    ['public/__selftest.js', '__selftest_probe.js'].forEach(function (f) { try { fs.unlinkSync(path.join(ROOT, f)); } catch (e) { /* ignore */ } });
    say('\n==================================================');
    if (bad) {
      say(' RESULT: ' + bad + ' check(s) FAILED. Copy everything above and send it to me.');
      if (tail.length) say('\n Last lines the bot printed:\n    ' + tail.slice(-25).join('\n    '));
    } else {
      say(' RESULT: ALL GOOD' + (warns ? ' (' + warns + ' warning(s) above)' : '') + '. The patch tool works on this folder.');
    }
    say('==================================================');
    process.exit(bad ? 1 : 0);
  }, 1500);
}

(async function main() {
  const hadDir = exists('.devpatch');

  head('1. Folder check');
  const need = ['server.js', 'package.json', 'devpatch.js', 'supervisor.js', 'public/index.html', 'public/dev.html'];
  const missing = need.filter(function (f) { return !exists(f); });
  missing.forEach(function (f) { no('missing: ' + f + (f === 'public/dev.html' ? ' (dev.html must be inside the public folder)' : '')); });
  if (missing.length) { say('\n  Put every file in ONE folder (server.js, package.json, devpatch.js, supervisor.js, start.bat, test.bat, selftest.js)\n  and dev.html + index.html inside a folder called public.'); return finish(hadDir); }
  ok('all required files are here');
  if (Number(process.versions.node.split('.')[0]) >= 18) ok('Node ' + process.versions.node); else no('Node ' + process.versions.node + ' is too old: install Node 18 or newer');
  if (exists('node_modules/ws')) ok('node_modules/ws is installed'); else no('node_modules/ws is missing: run  npm install  in this folder, then run the test again');
  ['server.js', 'devpatch.js', 'supervisor.js'].forEach(function (f) {
    const r = cp.spawnSync(process.execPath, ['--check', path.join(ROOT, f)], { encoding: 'utf8' });
    if (r.status === 0) ok(f + ' has no syntax errors'); else no(f + ' has a syntax error:\n' + String(r.stderr || '').split('\n').slice(0, 6).join('\n'));
  });
  const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  if (/require\(\s*["']\.\/devpatch["']\s*\)\s*\.attach\(/.test(srv)) ok('server.js has the devpatch hook'); else no('server.js does not have the hook line:  try { require("./devpatch").attach(http); } catch (e) { ... }');
  if (/function attach\(/.test(fs.readFileSync(path.join(ROOT, 'devpatch.js'), 'utf8'))) ok('devpatch.js is the current version (has attach)'); else no('devpatch.js is an old copy: use the one from the kit');
  const gi = exists('.gitignore') ? fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8') : '';
  if (/^\.devpatch\/?\s*$/m.test(gi)) ok('.gitignore protects .devpatch/'); else wn('.gitignore does not list .devpatch/ : add that line before you ever push (the secret and undo history live there)');
  if (bad) return finish(hadDir);

  head('2. Starting the bot under supervisor.js on port ' + PORT + ' (trading switched off for this test)');
  const env = {};
  Object.keys(process.env).forEach(function (k) { if (!/TOKEN|DRV|SECRET|^GH_|^DEV_|^RENDER/i.test(k)) env[k] = process.env[k]; });
  Object.assign(env, { PORT: String(PORT), DEV_PATCH: '1', DEV_SECRET: SECRET, DRV_AUTO: '0', API_TOKEN: '', ACCESS_TOKEN: '' });
  if (await ping()) { no('something already answers on port ' + PORT + '. Close the other copy or run:  set SELFTEST_PORT=4100  and try again'); return finish(hadDir); }
  sup = cp.spawn(process.execPath, ['supervisor.js'], { cwd: ROOT, env: env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  [sup.stdout, sup.stderr].forEach(function (s) { s.on('data', function (d) { String(d).split('\n').forEach(function (l) { if (l.trim()) { tail.push(l.slice(0, 220)); if (tail.length > 60) tail.shift(); } }); }); });
  if (!(await waitUp(90))) { no('the bot did not answer /ping within 90 s'); return finish(hadDir); }
  ok('the bot is up (answers /ping)');

  head('3. The /dev page and its lock');
  const page = await fetch(BASE + '/dev').then(function (r) { return r.status === 200 ? r.text() : ''; }).catch(function () { return ''; });
  if (page.indexOf('patch tool') >= 0) ok('/dev serves the patch page'); else no('/dev did not serve public/dev.html');
  let r = await api('state', {}, 'wrong-secret');
  if (r._status === 401) ok('a wrong secret is refused (401)'); else no('a wrong secret was NOT refused (status ' + r._status + ')');
  r = await api('state');
  if (r.ok && r.mode === 'local' && r.canRestart) ok('state: supervised, can restart'); else no('state is not supervised-local: ' + JSON.stringify({ ok: r.ok, mode: r.mode, canRestart: r.canRestart, error: r.error }));
  const paths = (r.files || []).map(function (f) { return f.path; });
  if (paths.indexOf('server.js') >= 0 && paths.indexOf('public/index.html') >= 0) ok('the tool sees ' + paths.length + ' project file(s)'); else no('the tool does not see server.js / public/index.html (sees: ' + paths.join(', ') + ')');
  if (paths.some(function (p) { return /devpatch|supervisor|dev\.html/.test(p); })) no('a protected file is listed as patchable'); else ok('devpatch.js, supervisor.js and dev.html are protected');
  if (bad) return finish(hadDir);
  let boot = r.boot;

  head('4. Page patch (a throwaway file in public/)');
  r = await api('apply', { patch: reply('==== FILE: public/__selftest.js ====\n\n===SPLIT===\nwindow.__selftest = 1;') });
  if (r.ok && r.kind === 'page' && exists('public/__selftest.js')) ok('page patch applied (no restart needed)'); else no('page patch failed: ' + (r.error || JSON.stringify(r)).slice(0, 500));
  r = await api('undo');
  if (r.ok && !exists('public/__selftest.js')) ok('undo removed it again'); else no('undo failed: ' + String(r.error || '').slice(0, 300));

  head('5. Server patch: boot canary, automatic restart, undo (a throwaway server-side file)');
  say('  (the canary boots a copy of your server on a scratch port with the network off; this can take up to 30 s)');
  r = await api('apply', { patch: reply('==== FILE: __selftest_probe.js ====\n\n===SPLIT===\nmodule.exports = 1;') });
  if (r.ok && r.kind === 'restarting') ok('canary passed, the server is restarting by itself');
  else { no('server patch failed: ' + (r.error || JSON.stringify(r)).slice(0, 900)); return finish(hadDir); }
  let s = await waitBoot(boot, 90);
  if (s) { ok('the bot came back after the patch restart'); boot = s.boot; } else { no('the bot did not come back within 90 s after the patch restart'); return finish(hadDir); }
  if (await waitUp(60)) ok('/ping answers again'); else no('/ping does not answer after the restart');
  r = await api('undo');
  if (r.ok && r.kind === 'restarting') ok('undo restores the files and restarts again'); else no('undo failed: ' + String(r.error || JSON.stringify(r)).slice(0, 400));
  s = await waitBoot(boot, 90);
  if (s) ok('the bot came back after the undo restart'); else no('the bot did not come back after the undo restart');
  if (!exists('__selftest_probe.js')) ok('the probe file is gone'); else no('the probe file is still there');
  if (await waitUp(60)) ok('/ping answers at the end'); else no('/ping does not answer at the end');

  finish(hadDir);
})().catch(function (e) { no('the self-test itself crashed: ' + (e && e.stack || e)); finish(false); });
