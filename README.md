# Manufacturing Log Viewer

A self-contained log viewer for `manufacturing_events.jsonl`:

- **Frontend** — HTML / CSS / TypeScript (no framework), with filtering, full-text search, sorting, pagination, and a JSON detail drawer.
- **Backend** — Python FastAPI + uvicorn REST API backed by MongoDB.
- **Container** — a single Ubuntu 24.04 image that runs MongoDB, seeds it from the JSONL file on startup, and serves the site.

## Project layout

```
├── backend/            FastAPI app
│   └── app/            main.py wires routers: auth, events, flow
├── frontend/           index.html, styles.css, src/main.ts (built with tsc)
├── scripts/
│   ├── seed_db.py      Seeds MongoDB from the JSONL (idempotent)
│   └── start_application.sh  Container startup: mongod -> seed -> uvicorn
├── Dockerfile          Multi-stage build (node builds frontend, ubuntu runtime)
├── deploy-gcp.sh       Push to Artifact Registry + deploy to Cloud Run
└── manufacturing_events.jsonl
```

## Run locally

```bash
docker build -t log-viewer .
docker run --rm -p 8000:8000 log-viewer
```

Then open http://localhost:8000

To persist the Mongo data between runs (skips reseeding):

```bash
docker run --rm -p 8000:8000 -v log-viewer-data:/data/db log-viewer
```

## API

| Endpoint | Description |
| --- | --- |
| `GET /api/events` | Paginated events. Query params: `page`, `page_size`, `event_type`, `job_id`, `machine_id`, `search`, `start`, `end`, `sort_by`, `sort_dir` |
| `GET /api/events/{event_id}` | Single event |
| `GET /api/stats` | Total + counts by event type |
| `GET /api/meta` | Distinct event types / machines for filter dropdowns |
| `GET /api/health` | Health check |

## Deploy to GCP (Cloud Run)

One-time setup: install the [gcloud CLI](https://cloud.google.com/sdk/docs/install) and run `gcloud auth login`.

```bash
PROJECT_ID=project-1009f246-ccb8-4692-92c ./deploy-gcp.sh
```

Replace `PROJECT_ID` with your own GCP project ID if deploying elsewhere.
Optional overrides: `REGION` (default `us-central1`), `SERVICE`, `REPO`, `TAG`.

The same command redeploys after code changes: it rebuilds the image, pushes
it, and rolls out a new Cloud Run revision with zero downtime.

Current deployment: https://log-viewer-m7gnp5mlyq-uc.a.run.app

To tear it down:

```bash
gcloud run services delete log-viewer --region us-central1
```

The script enables the required APIs, creates the Artifact Registry repo if
needed, builds the image for `linux/amd64`, pushes it, and deploys to Cloud
Run. The service seeds its own MongoDB from the baked-in JSONL on each cold
start (takes a few seconds), so no external database is needed.

## Local development without Docker

```bash
# Terminal 1: MongoDB (any local install or container)
docker run --rm -p 27017:27017 mongo:8

# Terminal 2: seed + API
cd backend && pip install -r requirements.txt
EVENTS_FILE=../manufacturing_events.jsonl python3 ../scripts/seed_db.py
STATIC_DIR=../frontend/dist uvicorn app.main:app --reload

# Terminal 3: frontend build (rebuild after TS changes)
cd frontend && npm install && npm run build
```
