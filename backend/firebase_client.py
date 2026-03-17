import os
import firebase_admin
from firebase_admin import credentials, firestore
from dotenv import load_dotenv

load_dotenv()

_db = None


def get_db():
    """Return the Firestore client, initializing Firebase on first call."""
    global _db
    if _db is None:
        if not firebase_admin._apps:
            # Prefer JSON string from env var (for cloud deployments like Render)
            creds_json = os.getenv("FIREBASE_CREDENTIALS_JSON")
            if creds_json:
                import json
                cred = credentials.Certificate(json.loads(creds_json))
            else:
                creds_path = os.getenv("FIREBASE_CREDENTIALS_PATH", "./serviceAccountKey.json")
                cred = credentials.Certificate(creds_path)
            firebase_admin.initialize_app(cred)
        _db = firestore.client()
    return _db
