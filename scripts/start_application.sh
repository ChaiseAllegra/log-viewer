#!/usr/bin/env bash
# Container startup: start MongoDB, seed it from the JSONL file, then
# start the FastAPI app with uvicorn.
set -euo pipefail

MONGO_DBPATH="${MONGO_DBPATH:-/data/db}"
PORT="${PORT:-8000}"

mkdir -p "$MONGO_DBPATH"

echo "[start_application] starting mongod..."
mongod --dbpath "$MONGO_DBPATH" \
       --bind_ip 127.0.0.1 \
       --fork \
       --logpath /var/log/mongod.log

echo "[start_application] seeding database..."
python3 /app/scripts/seed_db.py

echo "[start_application] starting uvicorn on port ${PORT}..."
exec uvicorn app.main:app --app-dir /app/backend --host 0.0.0.0 --port "$PORT"
