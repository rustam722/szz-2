@echo off
title NSPD Auto

py --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python not found. Install from https://python.org
    pause
    exit /b 1
)

if not exist ".installed" (
    echo Installing Playwright...
    py -m pip install playwright
    if errorlevel 1 ( echo Install failed & pause & exit /b 1 )
    echo Installing Chromium...
    py -m playwright install chromium
    if errorlevel 1 ( echo Chromium install failed & pause & exit /b 1 )
    echo. > .installed
)

py main.py coords.csv
pause
