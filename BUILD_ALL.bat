@echo off
title SZZ-Tool Build
setlocal enabledelayedexpansion

REM -- Switch to script directory
cd /d "%~dp0"

REM -- Check admin rights
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Restarting as Administrator...
    powershell -Command "Start-Process cmd.exe -ArgumentList '/c \"\"%~f0\"\"' -Verb RunAs -Wait"
    exit /b 0
)

echo ================================================
echo   SZZ-Tool - Build EXE + Installer
echo ================================================
echo.

REM -- Find Python
set PY_CMD=
py --version >nul 2>&1
if not errorlevel 1 ( set PY_CMD=py & goto :py_ok )
python --version >nul 2>&1
if not errorlevel 1 ( set PY_CMD=python & goto :py_ok )
echo [ERROR] Python not found!
pause
exit /b 1

:py_ok
echo Python: %PY_CMD%
echo.

REM -- Install dependencies
echo [1/3] Installing dependencies...
%PY_CMD% -m pip install pyinstaller pywebview pynspd hishel shapely flask python-docx openpyxl --quiet --upgrade
if errorlevel 1 ( echo [ERROR] pip failed & pause & exit /b 1 )
echo OK
echo.

REM -- Kill running app
echo Stopping SZZ-Tool.exe if running...
taskkill /F /IM SZZ-Tool.exe /T >nul 2>&1
timeout /t 2 /nobreak >nul

REM -- Build EXE
echo [2/3] Building EXE (PyInstaller)...
if exist dist rmdir /s /q dist
if exist build rmdir /s /q build
powershell -Command "Remove-Item -Path 'dist','build' -Recurse -Force -ErrorAction SilentlyContinue" >nul 2>&1

%PY_CMD% -m PyInstaller SZZ-Tool.spec -y --noconfirm
if errorlevel 1 ( echo [ERROR] PyInstaller failed & pause & exit /b 1 )

if not exist "dist\SZZ-Tool\SZZ-Tool.exe" (
  echo [ERROR] EXE not created!
  pause
  exit /b 1
)

REM -- Sanity check: all runtime files must be inside the bundle
set MISSING=
for %%F in (
  "_internal\index.html"
  "_internal\version.txt"
  "_internal\main_icon.ico"
  "_internal\lib\leaflet.js"
  "_internal\lib\leaflet.css"
  "_internal\lib\proj4.js"
  "_internal\lib\turf.min.js"
  "_internal\js\map.js"
  "_internal\css\main.css"
  "_internal\risk_server\app.py"
  "_internal\risk_server\cas_rfc_full.json"
) do (
  if not exist "dist\SZZ-Tool\%%~F" (
    echo [ERROR] Missing in bundle: %%~F
    set MISSING=1
  )
)
if defined MISSING (
  echo [ERROR] Bundle is incomplete - check datas in SZZ-Tool.spec!
  pause
  exit /b 1
)
echo OK - dist\SZZ-Tool\SZZ-Tool.exe (bundle verified)
echo.

REM -- Build installer (Inno Setup)
echo [3/3] Building installer (Inno Setup)...
set "ISCC="
REM Ищем от новых версий к старым. Сравнение через defined: путь в кавычках
REM ломает конструкцию if "%ISCC%"=="" (пробелы в Program Files)
for %%P in (
  "C:\Program Files\Inno Setup 7\ISCC.exe"
  "C:\Program Files (x86)\Inno Setup 7\ISCC.exe"
  "C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
  "C:\Program Files\Inno Setup 6\ISCC.exe"
  "C:\Program Files (x86)\Inno Setup 5\ISCC.exe"
  "C:\Program Files\Inno Setup 5\ISCC.exe"
) do (
  if not defined ISCC if exist %%P set "ISCC=%%~P"
)
if not defined ISCC for /f "delims=" %%I in ('where ISCC.exe 2^>nul') do (
  if not defined ISCC set "ISCC=%%I"
)

if not defined ISCC (
  echo [WARNING] Inno Setup not found - installer skipped.
  echo   Скачайте: https://jrsoftware.org/isdl.php
  goto :done
)

echo Compiler: "%ISCC%"

REM -- WebView2 bootstrapper is embedded into the installer
if not exist "MicrosoftEdgeWebview2Setup.exe" (
  echo Downloading WebView2 bootstrapper...
  powershell -Command "[Net.ServicePointManager]::SecurityProtocol='Tls12'; Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile 'MicrosoftEdgeWebview2Setup.exe' -UseBasicParsing"
  if not exist "MicrosoftEdgeWebview2Setup.exe" (
    echo [ERROR] Could not download MicrosoftEdgeWebview2Setup.exe
    pause
    exit /b 1
  )
)

set /p APP_VER=<version.txt
if not exist installer_output mkdir installer_output
REM Антивирус проверяет только что записанный Setup.exe и держит его, пока
REM Inno Setup вписывает иконку: "EndUpdateResource failed (110)". Через пару
REM секунд проверка заканчивается — поэтому повторяем сборку до трёх раз.
set "ISS_TRY=0"
:iss_retry
set /a ISS_TRY+=1
if exist "installer_output\SZZ-Tool-Setup-%APP_VER%.exe" del /f /q "installer_output\SZZ-Tool-Setup-%APP_VER%.exe" >nul 2>&1
"%ISCC%" installer.iss
if not errorlevel 1 goto :iss_ok
if %ISS_TRY% GEQ 3 ( echo [ERROR] Inno Setup failed & pause & exit /b 1 )
echo [WARNING] Inno Setup failed, attempt %ISS_TRY% of 3 - retry in 5 s...
timeout /t 5 /nobreak >nul
goto :iss_retry
:iss_ok
if not exist "installer_output\SZZ-Tool-Setup-%APP_VER%.exe" ( echo [ERROR] Installer file not created! & pause & exit /b 1 )
echo OK - installer_output\SZZ-Tool-Setup-%APP_VER%.exe
echo.

:done
echo ================================================
echo   DONE!
echo   EXE:       dist\SZZ-Tool\SZZ-Tool.exe
if defined ISCC echo   Installer: installer_output\SZZ-Tool-Setup-%APP_VER%.exe
echo ================================================
pause
exit /b 0
