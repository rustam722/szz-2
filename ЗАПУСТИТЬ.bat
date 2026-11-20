@echo off
title SZZ Tool - Proxy

echo ============================================
echo   SZZ Tool - Local Proxy (port 8767)
echo ============================================
echo.

:: Try py launcher first (Windows Python launcher), then python
py --version >nul 2>&1
if not errorlevel 1 (
    set PY_CMD=py
    goto :found
)
python --version >nul 2>&1
if not errorlevel 1 (
    set PY_CMD=python
    goto :found
)

echo ERROR: Python not found.
echo Install from https://www.python.org/downloads/
echo Check "Add Python to PATH" during install.
echo.
pause
exit /b 1

:found
echo Python OK: %PY_CMD%
echo.

:: Install dependencies if not already installed
echo Checking dependencies...
%PY_CMD% -c "import pynspd" >nul 2>&1
if errorlevel 1 (
    echo Installing pynspd...
    %PY_CMD% -m pip install pynspd --quiet
)
%PY_CMD% -c "import hishel" >nul 2>&1
if errorlevel 1 (
    echo Installing hishel...
    %PY_CMD% -m pip install hishel --quiet
)
%PY_CMD% -c "import shapely" >nul 2>&1
if errorlevel 1 (
    echo Installing shapely...
    %PY_CMD% -m pip install shapely --quiet
)
echo.

:: Kill any old proxy already on port 8767
for /f "tokens=5" %%p in ('netstat -ano 2^>nul ^| findstr ":8767 " ^| findstr "LISTENING"') do (
    taskkill /PID %%p /F >nul 2>&1
)

echo Starting proxy...
start "SZZ Proxy" %PY_CMD% "%~dp0proxy.py"

timeout /t 2 /nobreak >nul

echo Opening browser...
start "" "%~dp0index.html"

echo.
echo ============================================
echo Proxy running. Keep this window open.
echo Closing it stops the proxy.
echo ============================================
echo.
pause
