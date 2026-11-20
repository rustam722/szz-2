@echo off
chcp 65001 >nul
echo ============================================
echo  СЗЗ Инструмент — сборка установщика
echo ============================================

REM Ищем ISCC (компилятор Inno Setup)
set ISCC=
for %%P in (
  "C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
  "C:\Program Files\Inno Setup 6\ISCC.exe"
  "C:\Program Files (x86)\Inno Setup 5\ISCC.exe"
) do (
  if exist %%P set ISCC=%%P
)

if "%ISCC%"=="" (
  echo.
  echo [ОШИБКА] Inno Setup не найден!
  echo Скачайте и установите: https://jrsoftware.org/isdl.php
  echo.
  pause
  exit /b 1
)

echo Компилятор: %ISCC%
echo.

REM Офлайн-пакет WebView2 — без него установщик будет качать его из интернета
if exist "MicrosoftEdgeWebView2RuntimeInstallerX64.exe" (
  echo [OK] WebView2: офлайн-пакет найден, установка пойдёт без интернета
) else (
  echo [ВНИМАНИЕ] Нет файла MicrosoftEdgeWebView2RuntimeInstallerX64.exe
  echo            Установщик будет качать WebView2 из сети при установке.
  echo            Скачать: https://go.microsoft.com/fwlink/?linkid=2124701
)
echo.

REM Создаём папку для готового установщика
if not exist installer_output mkdir installer_output

REM Компилируем
%ISCC% installer.iss
if errorlevel 1 (
  echo.
  echo [ОШИБКА] Сборка завершилась с ошибкой.
  pause
  exit /b 1
)

echo.
echo [OK] Установщик создан в папке installer_output\
echo.
pause
