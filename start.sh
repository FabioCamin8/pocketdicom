#!/bin/sh
set -eu
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  if command -v uv >/dev/null 2>&1; then uv venv --python 3.12 .venv; else python3 -m venv .venv; fi
fi
if [ ! -f .venv/.pocket-requirements ] || ! cmp -s requirements.txt .venv/.pocket-requirements; then
  if command -v uv >/dev/null 2>&1; then uv pip install --python .venv/bin/python -r requirements.txt; else .venv/bin/python -m pip install -r requirements.txt; fi
  cp requirements.txt .venv/.pocket-requirements
fi
exec .venv/bin/python server.py "$@"
