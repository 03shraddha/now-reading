import hashlib
import os

from fastapi import APIRouter, Header, HTTPException
from google.cloud.firestore_v1 import SERVER_TIMESTAMP, Increment
from pydantic import BaseModel

from firebase_client import get_db
from routes.submit import _verify_token  # reuse existing HMAC token validation

router = APIRouter()


class ReactRequest(BaseModel):
    url: str
    action: str  # "add" or "remove"


@router.post("/react")
async def react(
    body: ReactRequest,
    x_submit_token: str | None = Header(default=None),
):
    # Validate token (same mechanism as /submit)
    if os.getenv("ENFORCE_TOKEN", "true").lower() != "false":
        if not _verify_token(x_submit_token):
            raise HTTPException(status_code=403, detail="invalid or missing submit token.")

    if body.action not in ("add", "remove"):
        raise HTTPException(status_code=400, detail="action must be 'add' or 'remove'")

    url_hash = hashlib.sha256(body.url.encode()).hexdigest()[:16]
    db = get_db()
    doc_ref = db.collection("link_reactions").document(url_hash)
    delta = 1 if body.action == "add" else -1

    doc_ref.set(
        {
            "url": body.url,
            "reaction_count": Increment(delta),
            "updated_at": SERVER_TIMESTAMP,
        },
        merge=True,
    )

    return {"ok": True}
