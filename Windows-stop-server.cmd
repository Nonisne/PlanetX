@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Planet X - Stop
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18 or newer is required. Install Node.js and try again.
  pause
  exit /b 1
)
node stop.mjs %*
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%
