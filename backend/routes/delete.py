import os
from fastapi import APIRouter, Header, HTTPException
from firebase_client import get_db
from routes.submit import _verify_token

router = APIRouter()


@router.delete("/submission/{doc_id}")
async def delete_submission(
    doc_id: str,
    x_submit_token: str | None = Header(default=None),
):
    if os.getenv("ENFORCE_TOKEN", "true").lower() != "false":
        if not _verify_token(x_submit_token):
            raise HTTPException(status_code=403, detail="invalid or missing submit token.")

    db = get_db()
    doc_ref = db.collection("submissions").document(doc_id)
    doc = doc_ref.get()

    if not doc.exists:
        raise HTTPException(status_code=404, detail="submission not found.")

    count = doc.to_dict().get("count", 1)
    if count > 1:
        doc_ref.update({"count": count - 1})
    else:
        doc_ref.delete()

    return {"ok": True}
