@echo off
REM Resep in aja - Quick Start (Windows)
REM Klik dua kali file ini

cd /d "%~dp0"

echo ==========================================
echo   Resep in aja - Multi-Provider Server
echo ==========================================
echo.

where python >nul 2>nul
if %errorlevel%==0 (
  set PY=python
  goto :run
)

where python3 >nul 2>nul
if %errorlevel%==0 (
  set PY=python3
  goto :run
)

echo ❌ Python tidak ditemukan. Install dari https://python.org
pause
exit /b 1

:run
echo Menggunakan: %PY%
echo.

REM Auto-load .env kalau ada
if exist .env (
  echo Loading .env...
  for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
    set "%%a=%%b"
  )
)

echo Buka browser ke http://localhost:8787 setelah server jalan.
echo Tekan Ctrl+C untuk berhenti.
echo.

%PY% server.py
pause
