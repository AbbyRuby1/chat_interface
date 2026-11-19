#!/usr/bin/env bash
# Launch helper for Linux/Debian (and macOS). Works from any directory.
set -e
cd "$(dirname "$0")"

PY=${PYTHON:-python3}

if [ ! -d .venv ]; then
  echo "Creating virtual environment (.venv)..."
  "$PY" -m venv .venv
fi

# Debian/Ubuntu may be missing ensurepip; guide the user if so.
if ! "$PY" -m venv --help >/dev/null 2>&1; then
  echo "venv is unavailable. On Debian/Ubuntu run: sudo apt install python3-venv" >&2
  exit 1
fi

. .venv/bin/activate
pip install -q -r requirements.txt

HOST=${HOST:-127.0.0.1}
PORT=${PORT:-8000}
echo "Open http://localhost:$PORT"
exec uvicorn main:app --host "$HOST" --port "$PORT" --reload
