@echo off
setlocal
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found.
  echo Install Node.js 20 or later, then run this file again.
  pause
  exit /b 1
)

if not exist "node_modules\.bin\electron.cmd" (
  echo node_modules was not found. Running npm install...
  npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

npm run app
pause
