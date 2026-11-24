#!/bin/sh
set -eu

STORAGE_DIR="${STORAGE_DIR:-/app/storage}"
mkdir -p "$STORAGE_DIR"

# Railway mounts volumes at runtime, replacing image directory ownership.
# Fix mounted-volume permissions, then run the app as the unprivileged node user.
chown -R node:node "$STORAGE_DIR"
chmod u+rwX "$STORAGE_DIR"

cd /app
exec su-exec node:node node server.js
