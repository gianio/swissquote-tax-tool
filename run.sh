#!/usr/bin/env bash
# Start the Swissquote → eCH-0196 converter web app.
#
#   ./run.sh                # http://127.0.0.1:8000
#   PORT=9000 ./run.sh      # custom port
#
# First run: create a venv and install requirements.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8000}"
HOST="${HOST:-127.0.0.1}"

if [ ! -d .venv ]; then
  echo "Creating virtual environment (.venv) …"
  python3 -m venv .venv
  ./.venv/bin/pip install --upgrade pip >/dev/null
  ./.venv/bin/pip install -r requirements.txt
fi

exec ./.venv/bin/python -m uvicorn backend.main:app --host "$HOST" --port "$PORT"
