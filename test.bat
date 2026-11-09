@echo off
rem Self-test of the patch tool. Safe: uses throwaway probe files and a spare port, trading is switched off.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or not in PATH. Install Node 18 or newer from nodejs.org, then run this again.
  pause
  exit /b 1
)
if not exist node_modules\ws call npm install
node selftest.js
pause
