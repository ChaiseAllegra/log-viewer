"""Log viewer REST API.

Creates the FastAPI app, mounts feature routers, and serves the static
frontend bundle.
"""

import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import auth, events, flow
from .db import events as events_col

STATIC_DIR = Path(os.environ.get("STATIC_DIR", "/app/static"))

app = FastAPI(title="Manufacturing Log Viewer API")
app.include_router(auth.router)
app.include_router(events.router)
app.include_router(flow.router)


@app.get("/api/health")
def health():
    return {"status": "ok", "events": events_col.estimated_document_count()}


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
