#!/bin/sh
# Local start: supervisor.js keeps server.js alive and restarts it after every patch.
cd "$(dirname "$0")" || exit 1
export DEV_PATCH=1
[ -d node_modules ] || npm install
exec node supervisor.js
