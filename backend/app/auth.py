"""Session cookie auth: login, logout, and the current_user dependency."""

import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Cookie, Depends, HTTPException, Response
from pydantic import BaseModel

from .db import sessions, users

SESSION_COOKIE = "session"
SESSION_TTL = timedelta(days=7)
PBKDF2_ITERATIONS = 600_000  # must match scripts/seed_db.py

router = APIRouter()


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


@router.post("/api/login")
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


@router.post("/api/logout")
def logout(response: Response, session: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE)):
    if session:
        sessions.delete_one({"token": session})
    response.delete_cookie(SESSION_COOKIE)
    return {"ok": True}


@router.get("/api/me")
def me(user: dict = Depends(current_user)):
    return user
