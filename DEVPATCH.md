# DevPatch: setup

Files (all in the project root, next to server.js):

    devpatch.js          the patch engine (protected: the tool cannot patch it)
    supervisor.js        restarts server.js after a patch, rolls back a patch that crashes (protected)
    public/dev.html      the /dev page with the patch bar (protected)
    start.bat / start.sh local launchers (protected)

## 1. One line in server.js (put it above the line that creates the server)

    try { require('./devpatch').attach(require('http')); } catch (e) { console.error('[DEVPATCH] not loaded: ' + e.message); }

It wraps the HTTP "request" event, so it works for plain http and express. With DEV_PATCH unset it does nothing.

## 2. .gitignore (the secret lives in .devpatch/)

    .devpatch/
    node_modules/

## 3. Local

Run start.bat (Windows) or start.sh. Open http://localhost:PORT/dev.
The secret is printed in the console and stored in .devpatch/secret.txt.
Server-file patches: boot canary -> save -> automatic restart -> rolled back by itself if the new server dies within 30 s.
Page patches (public/index.html): save -> the preview reloads.

## 4. Render (start command stays: node server.js)

    DEV_PATCH=1
    DEV_ALLOW_REMOTE=1
    DEV_SECRET=<long random, 24+ characters>
    GH_TOKEN=<fine-grained token, Contents: read/write on this repo only>
    GH_REPO=owner/repo
    GH_BRANCH=main            (optional)
    DEV_AUTO_STABLE=0         (optional: turn off the 10-minute auto "stable" mark)

On Render a patch is only STAGED on the instance (a restart wipes it). Push (button) is the deploy.
The canary still runs before a server patch is accepted, with the Deriv socket and the trader off.

## Buttons

    up-triangle  copy the prompt (index of parts, or the tagged parts)
    lightning    auto mode: watches the clipboard (page must be focused)
    command      apply the patch in the clipboard
    undo/redo    history survives restarts (15 steps)
    push         one commit with every changed project file; refuses a file that does not parse
    check        mark the running version as STABLE (branch "stable")
    restore      new commit on main that equals the stable version (history kept)
    restart      local only
    bug / log    runtime-error report for the AI / tool log
