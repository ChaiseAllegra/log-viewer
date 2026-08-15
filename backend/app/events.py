"""Log-viewer event catalog: list, filter, stats, and dropdown metadata."""

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pymongo import ASCENDING, DESCENDING

from .auth import current_user
from .db import events

router = APIRouter()


def serialize(doc: dict) -> dict:
    doc.pop("_id", None)
    ts = doc.get("timestamp")
    if isinstance(ts, datetime):
        doc["timestamp"] = ts.strftime("%Y-%m-%dT%H:%M:%SZ")
    return doc


def parse_iso(value: str, param: str) -> datetime:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        raise HTTPException(status_code=422, detail=f"Invalid ISO timestamp for '{param}': {value}")


@router.get("/api/meta")
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
        "facilities": distinct("metadata.facility"),
        "total": events.estimated_document_count(),
    }


@router.get("/api/stats")
def stats(user: dict = Depends(current_user)):
    by_type = list(events.aggregate([
        {"$group": {"_id": "$event_type", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
    ]))
    return {
        "total": events.estimated_document_count(),
        "by_type": [{"event_type": r["_id"], "count": r["count"]} for r in by_type],
    }


@router.get("/api/events")
def list_events(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    event_type: Optional[str] = None,
    job_id: Optional[str] = None,
    machine_id: Optional[str] = None,
    part_id: Optional[str] = None,
    customer_id: Optional[str] = None,
    material: Optional[str] = None,
    facility: Optional[str] = None,
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
    if facility:
        query["metadata.facility"] = facility

    ts_range: dict = {}
    if start:
        ts_range["$gte"] = parse_iso(start, "start")
    if end:
        ts_range["$lte"] = parse_iso(end, "end")
    if ts_range:
        query["timestamp"] = ts_range

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
        "items": [serialize(d) for d in cursor],
    }


@router.get("/api/events/{event_id}")
def get_event(event_id: str, user: dict = Depends(current_user)):
    doc = events.find_one({"event_id": event_id})
    if not doc:
        raise HTTPException(status_code=404, detail="event not found")
    return serialize(doc)
