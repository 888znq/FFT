@echo off
rem Local start: supervisor.js keeps server.js alive and restarts it after every patch.
cd /d "%~dp0"
set DEV_PATCH=1
if not exist node_modules call npm install
node supervisor.js
pause
