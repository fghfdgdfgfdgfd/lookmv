#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
echo "Starting lookmv on http://localhost:${PORT:-3000}"
exec node server.js
