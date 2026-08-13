@echo off
setlocal
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo Python not found. Install Python 3.10+ from https://python.org and re-run.
  pause
  exit /b 1
)

if not exist .venv (
  echo Creating virtual environment...
  python -m venv .venv
  if errorlevel 1 goto :fail
)

call .venv\Scripts\activate.bat

rem Reinstall dependencies only when requirements.txt changed since last run
fc /b requirements.txt .venv\requirements.installed >nul 2>nul
if errorlevel 1 (
  echo Installing dependencies...
  python -m pip install --upgrade pip
  pip install -r requirements.txt
  if errorlevel 1 goto :fail
  copy /y requirements.txt .venv\requirements.installed >nul
)

echo.
echo Starting scene labeler on http://127.0.0.1:8756
echo First start downloads the tagger model (~1.2 GB) - keep this window open.
echo.
uvicorn server:app --host 127.0.0.1 --port 8756
pause
exit /b 0

:fail
echo Setup failed.
pause
exit /b 1
