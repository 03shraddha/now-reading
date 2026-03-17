import hashlib
import time
from collections import defaultdict
from datetime import datetime, timezone

from fastapi import APIRouter, Request, HTTPException
from pydantic import BaseModel
from google.cloud.firestore_v1 import SERVER_TIMESTAMP, Increment

from firebase_client import get_db
from services import geoip, url_utils

router = APIRouter()

# Simple in-memory rate limiter: {ip_hash: [unix_timestamps]}
# Max 5 submissions per IP per 60 seconds. Good enough for local dev.
_rate_store: dict[str, list[float]] = defaultdict(list)
_RATE_LIMIT = 5
_RATE_WINDOW = 60  # seconds


class SubmitRequest(BaseModel):
    url: str


def _make_doc_id(normalized_url: str, country_code: str, city: str) -> str:
    """Same URL + same city → same Firestore doc (atomic counter)."""
    url_hash = hashlib.sha256(normalized_url.encode()).hexdigest()[:8]
    city_slug = city.lower().replace(" ", "_")[:12]
    return f"{url_hash}_{country_code}_{city_slug}"


def _hash_ip(ip: str) -> str:
    """One-way hash of IP — we never store or log the raw IP."""
    return hashlib.sha256(ip.encode()).hexdigest()[:16]


def _check_rate_limit(ip_hash: str) -> None:
    now = time.time()
    window_start = now - _RATE_WINDOW
    # Keep only timestamps within the current window
    _rate_store[ip_hash] = [t for t in _rate_store[ip_hash] if t > window_start]
    if len(_rate_store[ip_hash]) >= _RATE_LIMIT:
        raise HTTPException(status_code=429, detail="Too many submissions. Please wait a moment.")
    _rate_store[ip_hash].append(now)


@router.post("/submit")
async def submit(body: SubmitRequest, request: Request):
    # 1. Validate URL
    is_valid, error = url_utils.validate_url(body.url)
    if not is_valid:
        raise HTTPException(status_code=400, detail=error)

    # 2. Rate limit by hashed IP
    client_ip = request.client.host if request.client else ""
    ip_hash = _hash_ip(client_ip)
    _check_rate_limit(ip_hash)

    # 3. Normalize URL and extract domain
    normalized = url_utils.normalize_url(body.url)
    domain = url_utils.extract_domain(normalized)

    # 4. GeoIP lookup (async, with localhost fallback)
    location = await geoip.lookup(client_ip)

    # 5. Write to Firestore (deduplicated by URL + city composite key)
    db = get_db()
    doc_id = _make_doc_id(normalized, location["country_code"], location["city"])
    doc_ref = db.collection("submissions").document(doc_id)

    # Check if doc exists to get current count
    existing = doc_ref.get()
    if existing.exists:
        count = (existing.get("count") or 0) + 1
        doc_ref.update({
            "count": Increment(1),
            "updated_at": SERVER_TIMESTAMP,
        })
    else:
        count = 1
        doc_ref.set({
            "url": normalized,
            "domain": domain,
            "city": location["city"],
            "country": location["country"],
            "country_code": location["country_code"],
            "lat": location["lat"],
            "lng": location["lng"],
            "count": 1,
            "updated_at": SERVER_TIMESTAMP,
        })

    return {
        "id": doc_id,
        "lat": location["lat"],
        "lng": location["lng"],
        "city": location["city"],
        "domain": domain,
        "count": count,
    }
