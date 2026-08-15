# ---------- Stage 1: build the TypeScript frontend ----------
FROM node:20-slim AS frontend-build
WORKDIR /build
COPY frontend/package.json frontend/tsconfig.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# ---------- Stage 2: Ubuntu runtime with MongoDB + FastAPI ----------
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# System deps + MongoDB 8.0 from the official repo
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl gnupg ca-certificates python3 python3-venv && \
    curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc | \
        gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor && \
    echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/8.0 multiverse" \
        > /etc/apt/sources.list.d/mongodb-org-8.0.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends mongodb-org-server mongodb-org-shell && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Python virtualenv (Ubuntu 24.04 blocks system-wide pip installs)
COPY backend/requirements.txt /tmp/requirements.txt
RUN python3 -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app

COPY backend/ /app/backend/
COPY scripts/seed_db.py /app/scripts/seed_db.py
COPY scripts/entrypoint.sh /app/scripts/entrypoint.sh
COPY manufacturing_events.jsonl /app/data/manufacturing_events.jsonl
COPY --from=frontend-build /build/dist/ /app/static/

RUN chmod +x /app/scripts/entrypoint.sh && mkdir -p /data/db

ENV STATIC_DIR=/app/static \
    EVENTS_FILE=/app/data/manufacturing_events.jsonl \
    PORT=8000

EXPOSE 8000

ENTRYPOINT ["/app/scripts/entrypoint.sh"]
