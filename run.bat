@echo off
REM Launch helper for Windows. Works from any directory.
setlocal
cd /d "%~dp0"

where py >nul 2>nul && set PY=py || set PY=python

if not exist .venv (
    echo Creating virtual environment .venv...
    %PY% -m venv .venv
    if errorlevel 1 (
        echo Failed to create venv. Make sure Python 3.10+ is installed and on PATH.
        exit /b 1
    )
)

call .venv\Scripts\activate.bat
python -m pip install -q -r requirements.txt

if "%HOST%"=="" set HOST=127.0.0.1
if "%PORT%"=="" set PORT=8000
echo Open http://localhost:%PORT%
uvicorn main:app --host %HOST% --port %PORT% --reload
