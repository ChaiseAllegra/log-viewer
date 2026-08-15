"""Log viewer REST API.

Serves the manufacturing event log stored in MongoDB, plus the static
frontend bundle.
"""

import hashlib
import os
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from fastapi import Cookie, Depends, FastAPI, HTTPException, Query, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from pymongo import ASCENDING, DESCENDING, MongoClient

MONGO_URI = os.environ.get("MONGO_URI", "mongodb://127.0.0.1:27017")
DB_NAME = os.environ.get("MONGO_DB", "logviewer")
COLLECTION = os.environ.get("MONGO_COLLECTION", "events")
STATIC_DIR = Path(os.environ.get("STATIC_DIR", "/app/static"))

SESSION_COOKIE = "session"
SESSION_TTL = timedelta(days=7)
PBKDF2_ITERATIONS = 600_000  # must match scripts/seed_db.py

client = MongoClient(MONGO_URI)
db = client[DB_NAME]
events = db[COLLECTION]
users = db["users"]
sessions = db["sessions"]
# Mongo removes expired sessions automatically via this TTL index.
sessions.create_index("expires_at", expireAfterSeconds=0)

app = FastAPI(title="Manufacturing Log Viewer API")


# ---------- Authentication ----------

class LoginRequest(BaseModel):
    user_name: str
    password: str


def _verify_password(password: str, stored: str) -> bool:
    salt, digest = stored.split(":")
    check = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), PBKDF2_ITERATIONS)
    return secrets.compare_digest(check.hex(), digest)


def current_user(session: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE)) -> dict:
    if session:
        record = sessions.find_one({
            "token": session,
            "expires_at": {"$gt": datetime.now(timezone.utc)},
        })
        if record:
            return {"user_name": record["user_name"], "permission": record["permission"]}
    raise HTTPException(status_code=401, detail="not signed in")


@app.post("/api/login")
def login(payload: LoginRequest, response: Response):
    user = users.find_one({"user_name": payload.user_name})
    if not user or not _verify_password(payload.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="invalid username or password")

    token = secrets.token_urlsafe(32)
    sessions.insert_one({
        "token": token,
        "user_name": user["user_name"],
        "permission": user["permission"],
        "expires_at": datetime.now(timezone.utc) + SESSION_TTL,
    })
    response.set_cookie(
        SESSION_COOKIE,
        token,
        httponly=True,
        samesite="lax",
        max_age=int(SESSION_TTL.total_seconds()),
    )
    return {"user_name": user["user_name"], "permission": user["permission"]}


@app.post("/api/logout")
def logout(response: Response, session: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE)):
    if session:
        sessions.delete_one({"token": session})
    response.delete_cookie(SESSION_COOKIE)
    return {"ok": True}


@app.get("/api/me")
def me(user: dict = Depends(current_user)):
    return user


def _serialize(doc: dict) -> dict:
    doc.pop("_id", None)
    ts = doc.get("timestamp")
    if isinstance(ts, datetime):
        doc["timestamp"] = ts.strftime("%Y-%m-%dT%H:%M:%SZ")
    return doc


def _parse_iso(value: str, param: str) -> datetime:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        raise HTTPException(status_code=422, detail=f"Invalid ISO timestamp for '{param}': {value}")


@app.get("/api/health")
def health():
    return {"status": "ok", "events": events.estimated_document_count()}


@app.get("/api/meta")
def meta(user: dict = Depends(current_user)):
    """Distinct values used to populate the filter dropdowns."""
    def distinct(field: str) -> list:
        return sorted(v for v in events.distinct(field) if v)

    return {
        "event_types": distinct("event_type"),
        "machines": distinct("machine_id"),
        "jobs": distinct("job_id"),
        "parts": distinct("part_id"),
        "customers": distinct("customer_id"),
        "materials": distinct("material"),
        "total": events.estimated_document_count(),
    }


@app.get("/api/stats")
def stats(user: dict = Depends(current_user)):
    by_type = list(events.aggregate([
        {"$group": {"_id": "$event_type", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
    ]))
    return {
        "total": events.estimated_document_count(),
        "by_type": [{"event_type": r["_id"], "count": r["count"]} for r in by_type],
    }


# Per-stage metadata field worth summarizing in the flow diagram drawer.
BREAKDOWN_FIELDS = {
    "inspection_failed": "defect_code",
    "job_blocked": "reason",
    "job_unblocked": "reason",
    "sensor_glitch": "signal",
    "job_created": "priority",
}


@app.get("/api/flow")
def flow(part_id: str, user: dict = Depends(current_user)):
    """Aggregate a part's per-job event sequences into a stage graph:
    nodes (event types), edges (observed transitions), a job funnel, and
    each job's collapsed path for drill-down highlighting."""
    docs = list(
        events.find({"part_id": part_id, "job_id": {"$ne": None}})
        .sort([("timestamp", ASCENDING), ("event_id", ASCENDING)])
    )
    if not docs:
        raise HTTPException(status_code=404, detail=f"no events for part '{part_id}'")

    per_job: dict = {}
    for doc in docs:
        per_job.setdefault(doc["job_id"], []).append(doc)

    node_events: dict = {}
    node_jobs: dict = {}
    node_first: dict = {}
    node_last: dict = {}
    breakdowns: dict = {}
    edge_counts: dict = {}
    job_paths: dict = {}

    for job_id, evs in per_job.items():
        # Collapse consecutive repeats (e.g. 40 cycle_completed in a row)
        # into single stage visits so edges represent stage changes.
        path = []
        for e in evs:
            et = e["event_type"]
            if not path or path[-1] != et:
                path.append(et)
        job_paths[job_id] = path
        for a, b in zip(path, path[1:]):
            edge_counts[(a, b)] = edge_counts.get((a, b), 0) + 1

        for e in evs:
            et = e["event_type"]
            node_events[et] = node_events.get(et, 0) + 1
            node_jobs.setdefault(et, set()).add(job_id)
            ts = e["timestamp"]
            if et not in node_first or ts < node_first[et]:
                node_first[et] = ts
            if et not in node_last or ts > node_last[et]:
                node_last[et] = ts
            field = BREAKDOWN_FIELDS.get(et)
            value = (e.get("metadata") or {}).get(field) if field else None
            if value is not None:
                breakdowns.setdefault(et, {})
                breakdowns[et][value] = breakdowns[et].get(value, 0) + 1

    def fmt(ts: datetime) -> str:
        return ts.strftime("%Y-%m-%dT%H:%M:%SZ")

    nodes = [
        {
            "event_type": et,
            "events": count,
            "jobs": len(node_jobs[et]),
            "first": fmt(node_first[et]),
            "last": fmt(node_last[et]),
            "breakdown_field": BREAKDOWN_FIELDS.get(et),
            "breakdown": sorted(
                ({"value": v, "count": c} for v, c in breakdowns.get(et, {}).items()),
                key=lambda x: -x["count"],
            )[:6],
        }
        for et, count in node_events.items()
    ]

    jobs = sorted(per_job)
    return {
        "part_id": part_id,
        "jobs": jobs,
        "funnel": {
            "total_jobs": len(jobs),
            "created": sum(1 for p in job_paths.values() if "job_created" in p),
            "started": sum(1 for p in job_paths.values() if "job_started" in p),
            "completed": sum(1 for p in job_paths.values() if "job_completed" in p),
        },
        "nodes": nodes,
        "edges": [
            {"from": a, "to": b, "count": n}
            for (a, b), n in sorted(edge_counts.items(), key=lambda x: -x[1])
        ],
        "job_paths": job_paths,
    }


@app.get("/api/events")
def list_events(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    event_type: Optional[str] = None,
    job_id: Optional[str] = None,
    machine_id: Optional[str] = None,
    part_id: Optional[str] = None,
    customer_id: Optional[str] = None,
    material: Optional[str] = None,
    start: Optional[str] = None,
    end: Optional[str] = None,
    sort_dir: str = Query("desc", pattern="^(asc|desc)$"),
    user: dict = Depends(current_user),
):
    query: dict = {}
    exact_filters = {
        "event_type": event_type,
        "job_id": job_id,
        "machine_id": machine_id,
        "part_id": part_id,
        "customer_id": customer_id,
        "material": material,
    }
    for field, value in exact_filters.items():
        if value:
            query[field] = value

    ts_range: dict = {}
    if start:
        ts_range["$gte"] = _parse_iso(start, "start")
    if end:
        ts_range["$lte"] = _parse_iso(end, "end")
    if ts_range:
        query["timestamp"] = ts_range

    # Only chronological sorting is supported; event_id breaks ties.
    direction = DESCENDING if sort_dir == "desc" else ASCENDING

    total = events.count_documents(query)
    cursor = (
        events.find(query)
        .sort([("timestamp", direction), ("event_id", direction)])
        .skip((page - 1) * page_size)
        .limit(page_size)
    )
    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "pages": max(1, -(-total // page_size)),
        "items": [_serialize(d) for d in cursor],
    }


@app.get("/api/events/{event_id}")
def get_event(event_id: str, user: dict = Depends(current_user)):
    doc = events.find_one({"event_id": event_id})
    if not doc:
        raise HTTPException(status_code=404, detail="event not found")
    return _serialize(doc)


class NoCacheStaticFiles(StaticFiles):
    """Force browsers to revalidate assets so a rebuilt frontend is always
    picked up (they still get 304s when nothing changed)."""

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache"
        return response


# Static frontend — mounted last so /api/* wins.
if STATIC_DIR.is_dir():
    app.mount("/assets", NoCacheStaticFiles(directory=STATIC_DIR / "assets"), name="assets")

    def _page(name: str) -> FileResponse:
        return FileResponse(STATIC_DIR / name, headers={"Cache-Control": "no-cache"})

    @app.get("/")
    def index():
        return _page("index.html")

    @app.get("/logs")
    def logs_page():
        return _page("logs.html")

    @app.get("/flow")
    def flow_page():
        return _page("flow.html")
