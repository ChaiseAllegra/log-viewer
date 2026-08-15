"""Seed MongoDB from the manufacturing events JSONL file.

Runs on container startup. Skips seeding when the collection already holds
the expected number of documents, so restarts with a persistent volume are
fast and idempotent.
"""

import hashlib
import json
import os
import secrets
import sys
import time
from datetime import datetime, timezone

from pymongo import ASCENDING, DESCENDING, MongoClient
from pymongo.errors import ConnectionFailure

MONGO_URI = os.environ.get("MONGO_URI", "mongodb://127.0.0.1:27017")
DB_NAME = os.environ.get("MONGO_DB", "logviewer")
COLLECTION = os.environ.get("MONGO_COLLECTION", "events")
JSONL_PATH = os.environ.get("EVENTS_FILE", "/app/data/manufacturing_events.jsonl")
BATCH_SIZE = 2000

DEFAULT_ADMIN_USER = os.environ.get("DEFAULT_ADMIN_USER", "admin")
DEFAULT_ADMIN_PASSWORD = os.environ.get("DEFAULT_ADMIN_PASSWORD", "test123#")
PBKDF2_ITERATIONS = 600_000


def hash_password(password: str) -> str:
    """PBKDF2-SHA256 salted hash, stored as 'salt:hash' hex."""
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ITERATIONS)
    return f"{salt.hex()}:{digest.hex()}"


def seed_users(db) -> None:
    users = db["users"]
    users.create_index([("user_name", ASCENDING)], unique=True)
    if users.count_documents({"user_name": DEFAULT_ADMIN_USER}):
        print(f"User seed skipped: '{DEFAULT_ADMIN_USER}' already exists")
        return
    users.insert_one({
        "user_name": DEFAULT_ADMIN_USER,
        "password_hash": hash_password(DEFAULT_ADMIN_PASSWORD),
        "permission": "admin",
        "created_at": datetime.now(timezone.utc),
    })
    print(f"Created default user '{DEFAULT_ADMIN_USER}' with permission 'admin'")


def wait_for_mongo(client: MongoClient, timeout_s: int = 60) -> None:
    deadline = time.monotonic() + timeout_s
    while True:
        try:
            client.admin.command("ping")
            return
        except ConnectionFailure:
            if time.monotonic() > deadline:
                print("ERROR: MongoDB did not become ready in time", file=sys.stderr)
                sys.exit(1)
            time.sleep(1)


def parse_line(line: str) -> dict:
    doc = json.loads(line)
    # Store timestamps as real datetimes so range queries and sorting work.
    doc["timestamp"] = datetime.fromisoformat(doc["timestamp"].replace("Z", "+00:00")).replace(tzinfo=None)
    return doc


def seed_events(events) -> None:
    with open(JSONL_PATH, "r", encoding="utf-8") as f:
        lines = [line for line in f if line.strip()]

    expected = len(lines)
    existing = events.count_documents({})
    if existing == expected:
        print(f"Seed skipped: collection already has {existing} events")
        return

    if existing:
        print(f"Collection has {existing} events, expected {expected}; reseeding")
        events.drop()

    batch = []
    inserted = 0
    for line in lines:
        batch.append(parse_line(line))
        if len(batch) >= BATCH_SIZE:
            events.insert_many(batch, ordered=False)
            inserted += len(batch)
            batch = []
    if batch:
        events.insert_many(batch, ordered=False)
        inserted += len(batch)

    events.create_index([("timestamp", DESCENDING)])
    events.create_index([("event_type", ASCENDING)])
    events.create_index([("job_id", ASCENDING)])
    events.create_index([("machine_id", ASCENDING)])
    # Not unique: the source log contains a handful of duplicated event_ids.
    events.create_index([("event_id", ASCENDING)])

    print(f"Seeded {inserted} events into {DB_NAME}.{COLLECTION}")


def main() -> None:
    client = MongoClient(MONGO_URI)
    wait_for_mongo(client)
    db = client[DB_NAME]
    seed_events(db[COLLECTION])
    seed_users(db)


if __name__ == "__main__":
    main()
