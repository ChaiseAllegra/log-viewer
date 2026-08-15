"""MongoDB connection shared by the API routers."""

import os

from pymongo import MongoClient

MONGO_URI = os.environ.get("MONGO_URI", "mongodb://127.0.0.1:27017")
DB_NAME = os.environ.get("MONGO_DB", "logviewer")
COLLECTION = os.environ.get("MONGO_COLLECTION", "events")

client = MongoClient(MONGO_URI)
db = client[DB_NAME]
events = db[COLLECTION]
users = db["users"]
sessions = db["sessions"]
# Mongo removes expired sessions automatically via this TTL index.
sessions.create_index("expires_at", expireAfterSeconds=0)
