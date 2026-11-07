@echo off
title WALLSPECTRUM LIVE
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found. Install Node 18 or newer from https://nodejs.org
  echo         then run this file again.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Installing dependencies ^(first run only^)...
  call npm install --omit=dev
  if errorlevel 1 (
    echo [ERROR] npm install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

if "%PORT%"=="" set PORT=3000

echo Starting WALLSPECTRUM on http://localhost:%PORT%
echo Close this window or press Ctrl+C to stop.
echo.

rem Open the browser a few seconds AFTER the server has had time to start
start "" /min cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:%PORT%"

node server.js
echo.
echo Server stopped.
pause
