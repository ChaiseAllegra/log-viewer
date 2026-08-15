"""Part factory flow: aggregate a part's jobs into a stage graph."""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pymongo import ASCENDING

from .auth import current_user
from .db import events

router = APIRouter()

# Per-stage metadata field worth summarizing in the flow diagram drawer.
BREAKDOWN_FIELDS = {
    "inspection_failed": "defect_code",
    "job_blocked": "reason",
    "job_unblocked": "reason",
    "sensor_glitch": "signal",
    "job_created": "priority",
}


def _fmt(ts: datetime) -> str:
    return ts.strftime("%Y-%m-%dT%H:%M:%SZ")


def _load_part_events(part_id: str) -> list:
    docs = list(
        events.find({"part_id": part_id, "job_id": {"$ne": None}})
        .sort([("timestamp", ASCENDING), ("event_id", ASCENDING)])
    )
    if not docs:
        raise HTTPException(status_code=404, detail=f"no events for part '{part_id}'")
    return docs


def _group_by_job(docs: list) -> dict:
    per_job: dict = {}
    for doc in docs:
        per_job.setdefault(doc["job_id"], []).append(doc)
    return per_job


def _collapse_consecutive(evs: list) -> list:
    """Turn a job's event list into stage visits; repeats of the same type merge."""
    steps: list = []
    for e in evs:
        et = e["event_type"]
        ts = e["timestamp"]
        if steps and steps[-1]["event_type"] == et:
            steps[-1]["count"] += 1
            steps[-1]["last"] = ts
            steps[-1]["last_metadata"] = e.get("metadata") or {}
        else:
            steps.append({
                "event_type": et,
                "count": 1,
                "first": ts,
                "last": ts,
                "first_metadata": e.get("metadata") or {},
                "last_metadata": e.get("metadata") or {},
            })
    return steps


def _story_for_job(job_id: str, evs: list, steps: list) -> dict:
    completed = next((e for e in reversed(evs) if e["event_type"] == "job_completed"), None)
    completed_meta = (completed.get("metadata") or {}) if completed else {}
    return {
        "job_id": job_id,
        "outcome": "completed" if completed else "stalled",
        "last_stage": steps[-1]["event_type"] if steps else None,
        "good_quantity": completed_meta.get("good_quantity"),
        "scrap_quantity": completed_meta.get("scrap_quantity"),
        "steps": [
            {
                "step": i,
                "event_type": s["event_type"],
                "count": s["count"],
                "first": _fmt(s["first"]),
                "last": _fmt(s["last"]),
                "metadata": s["last_metadata"] if s["event_type"] == "job_completed" else s["first_metadata"],
            }
            for i, s in enumerate(steps, 1)
        ],
    }


def _add_path_edges(steps: list, edge_counts: dict) -> None:
    path = [s["event_type"] for s in steps]
    for a, b in zip(path, path[1:]):
        edge_counts[(a, b)] = edge_counts.get((a, b), 0) + 1


def _tally_event(event: dict, job_id: str, graph: dict) -> None:
    """Update per-stage volumes, job lists, time range, and breakdowns."""
    et = event["event_type"]
    ts = event["timestamp"]
    graph["node_events"][et] = graph["node_events"].get(et, 0) + 1
    graph["node_jobs"].setdefault(et, set()).add(job_id)
    per_job_counts = graph["node_job_counts"].setdefault(et, {})
    per_job_counts[job_id] = per_job_counts.get(job_id, 0) + 1
    if et not in graph["node_first"] or ts < graph["node_first"][et]:
        graph["node_first"][et] = ts
    if et not in graph["node_last"] or ts > graph["node_last"][et]:
        graph["node_last"][et] = ts
    field = BREAKDOWN_FIELDS.get(et)
    value = (event.get("metadata") or {}).get(field) if field else None
    if value is not None:
        graph["breakdowns"].setdefault(et, {})
        graph["breakdowns"][et][value] = graph["breakdowns"][et].get(value, 0) + 1


def _build_nodes(graph: dict) -> list:
    nodes = []
    for et, count in graph["node_events"].items():
        nodes.append({
            "event_type": et,
            "events": count,
            "jobs": len(graph["node_jobs"][et]),
            "job_counts": [
                {"job_id": jid, "count": c}
                for jid, c in sorted(graph["node_job_counts"][et].items(), key=lambda x: (-x[1], x[0]))
            ],
            "first": _fmt(graph["node_first"][et]),
            "last": _fmt(graph["node_last"][et]),
            "breakdown_field": BREAKDOWN_FIELDS.get(et),
            "breakdown": sorted(
                ({"value": v, "count": c} for v, c in graph["breakdowns"].get(et, {}).items()),
                key=lambda x: -x["count"],
            )[:6],
        })
    return nodes


def _build_edges(edge_counts: dict) -> list:
    return [
        {"from": a, "to": b, "count": n}
        for (a, b), n in sorted(edge_counts.items(), key=lambda x: -x[1])
    ]


def _build_funnel(job_stories: dict, jobs: list) -> dict:
    return {
        "total_jobs": len(jobs),
        "created": sum(1 for s in job_stories.values() if any(st["event_type"] == "job_created" for st in s["steps"])),
        "started": sum(1 for s in job_stories.values() if any(st["event_type"] == "job_started" for st in s["steps"])),
        "completed": sum(1 for s in job_stories.values() if s["outcome"] == "completed"),
    }


@router.get("/api/flow")
def flow(part_id: str, user: dict = Depends(current_user)):
    """Aggregate a part's per-job event sequences into a stage graph."""
    per_job = _group_by_job(_load_part_events(part_id))

    graph = {
        "node_events": {},
        "node_jobs": {},
        "node_job_counts": {},
        "node_first": {},
        "node_last": {},
        "breakdowns": {},
    }
    edge_counts: dict = {}
    job_stories: dict = {}

    for job_id, evs in per_job.items():
        steps = _collapse_consecutive(evs)
        _add_path_edges(steps, edge_counts)
        job_stories[job_id] = _story_for_job(job_id, evs, steps)
        for event in evs:
            _tally_event(event, job_id, graph)

    jobs = sorted(per_job)
    return {
        "part_id": part_id,
        "jobs": jobs,
        "funnel": _build_funnel(job_stories, jobs),
        "nodes": _build_nodes(graph),
        "edges": _build_edges(edge_counts),
        "job_stories": job_stories,
    }
