from fastapi import APIRouter, HTTPException, Query
from services import url_utils
from services.metadata import fetch_metadata

router = APIRouter()


@router.get("/metadata")
async def get_metadata(url: str = Query(...)):
    is_valid, error = url_utils.validate_url(url)
    if not is_valid:
        raise HTTPException(status_code=400, detail=error)
    return await fetch_metadata(url)
