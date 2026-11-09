'use strict';
/* supervisor.js - runs server.js and keeps it alive. PROTECTED: the patch tool can never change this file.
 *
 *   - devpatch.js writes .devpatch/restart.flag and stops the server  -> this file starts it again.
 *   - if the new version dies within 30 s of a patch restart          -> the patch is rolled back
 *     (files restored from .devpatch/blobs), the reason is saved to .devpatch/last-error.json, and the
 *     old version is started.
 *   - any other crash                                                  -> restart with a short delay
 *     (gives up after 5 crashes inside one minute so a broken boot cannot loop forever).
 * Used by start.bat / start.sh. On Render keep using:  node server.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DIR = path.join(ROOT, '.devpatch');
const FLAG = path.join(DIR, 'restart.flag');
const PENDING = path.join(DIR, 'pending.json');
const HIST = path.join(DIR, 'history.json');
const BLOBS = path.join(DIR, 'blobs');
const LAST_ERR = path.join(DIR, 'last-error.json');

let stopping = false;
let child = null;
const crashes = [];

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
function unlink(p) { try { fs.unlinkSync(p); } catch (e) { /* ignore */ } }

function rollback(pend, tail) {
  const h = readJson(HIST);
  if (!h || !Array.isArray(h.undo) || !h.undo.length) return false;
  const en = h.undo.find(function (e) { return e.id === pend.id; });
  if (!en) return false;
  Object.keys(en.files).forEach(function (f) {
    const abs = path.resolve(ROOT, f);
    if (abs.indexOf(ROOT + path.sep) !== 0) return;
    const b = en.files[f].b;
    try {
      if (!b) unlink(abs);
      else {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs + '.devtmp', fs.readFileSync(path.join(BLOBS, b)));
        fs.renameSync(abs + '.devtmp', abs);
      }
    } catch (e) { console.error('[SUPERVISOR] rollback of ' + f + ' failed: ' + e.message); }
  });
  h.undo = h.undo.filter(function (e) { return e !== en; });
  h.redo = (h.redo || []).concat([en]);
  const tmp = HIST + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(h));
  fs.renameSync(tmp, HIST);
  fs.writeFileSync(LAST_ERR, JSON.stringify({ t: Date.now(), msg: 'The patch crashed the server right after it started, so it was rolled back automatically.\n\nPatch: ' + en.label + '\n\nLast output:\n' + tail.join('\n') }));
  return true;
}

function run() {
  const t0 = Date.now();
  const tail = [];
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { DEV_SUPERVISED: '1' }),
    stdio: ['inherit', 'inherit', 'pipe']
  });
  child.stderr.on('data', function (d) {
    process.stderr.write(d);
    String(d).split('\n').forEach(function (l) { if (l.trim()) { tail.push(l); if (tail.length > 20) tail.shift(); } });
  });
  child.on('exit', function (code, sig) {
    child = null;
    if (stopping) process.exit(code || 0);
    if (fs.existsSync(FLAG)) {            // a planned restart (patch, undo or the restart button)
      unlink(FLAG);
      console.log('[SUPERVISOR] restarting the server');
      setTimeout(run, 300);
      return;
    }
    const pend = readJson(PENDING);
    if (pend && Date.now() - t0 < 30000) {  // died soon after a patch restart: roll the patch back
      unlink(PENDING);
      const ok = rollback(pend, tail);
      console.error('[SUPERVISOR] the patched server died within 30 s: ' + (ok ? 'patch rolled back' : 'could not roll back'));
      setTimeout(run, 500);
      return;
    }
    if (code === 0 || sig === 'SIGINT' || sig === 'SIGTERM') process.exit(0);   // normal stop (Ctrl+C, shutdown)
    const now = Date.now();
    crashes.push(now);
    while (crashes.length && now - crashes[0] > 60000) crashes.shift();
    if (crashes.length >= 5) { console.error('[SUPERVISOR] 5 crashes in one minute: giving up. Fix the server and start it again.'); process.exit(1); }
    console.error('[SUPERVISOR] server exited (code ' + code + '), restarting in 2 s');
    setTimeout(run, 2000);
  });
}

function stop() {
  stopping = true;
  if (child) { try { child.kill('SIGTERM'); } catch (e) { /* ignore */ } setTimeout(function () { process.exit(0); }, 4000).unref(); }
  else process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
unlink(FLAG);
run();
