import hashlib
import hmac
import os
import time
from collections import defaultdict
from datetime import datetime, timezone

from fastapi import APIRouter, Request, Header, HTTPException
from pydantic import BaseModel
from google.cloud.firestore_v1 import SERVER_TIMESTAMP, Increment

from firebase_client import get_db
from services import geoip, url_utils

router = APIRouter()

# ── Token validation ───────────────────────────────────────────────────────
TOKEN_SECRET = os.getenv("SUBMIT_TOKEN_SECRET", "dev-secret-change-me")
TOKEN_WINDOW = 300  # must match main.py


def _make_token(window: int) -> str:
    msg = f"submit:{window}".encode()
    return hmac.new(TOKEN_SECRET.encode(), msg, hashlib.sha256).hexdigest()


def _verify_token(token: str | None) -> bool:
    if not token:
        return False
    now = int(time.time())
    window = now // TOKEN_WINDOW
    # Accept current window and the previous one (handles clock skew / near-boundary submits)
    for w in (window, window - 1):
        if hmac.compare_digest(_make_token(w), token):
            return True
    return False


# ── Rate limits ────────────────────────────────────────────────────────────
# Per-IP sliding windows (hashed IPs, never raw)

_rate_store:   dict[str, list[float]] = defaultdict(list)  # burst: 5 / 60 s
_hourly_store: dict[str, list[float]] = defaultdict(list)  # hourly: 20 / 3600 s
_RATE_LIMIT    = 5
_RATE_WINDOW   = 60
_HOURLY_LIMIT  = 20
_HOURLY_WINDOW = 3600

# Domain dedupe: same IP can't submit the same domain within 10 minutes
_domain_store: dict[str, dict[str, float]] = defaultdict(dict)
_DOMAIN_WINDOW = 10 * 60

# URL-level flood: a single URL can't get more than N global submissions/hour
# (prevents coordinated upvote brigading of one link)
_url_flood_store: dict[str, list[float]] = defaultdict(list)
_URL_FLOOD_LIMIT  = 60
_URL_FLOOD_WINDOW = 3600


def _check_rate_limit(ip_hash: str) -> None:
    now = time.time()
    # Burst window
    burst_start = now - _RATE_WINDOW
    _rate_store[ip_hash] = [t for t in _rate_store[ip_hash] if t > burst_start]
    if len(_rate_store[ip_hash]) >= _RATE_LIMIT:
        raise HTTPException(status_code=429, detail="too many submissions. please wait a moment.")
    _rate_store[ip_hash].append(now)

    # Hourly cap
    hour_start = now - _HOURLY_WINDOW
    _hourly_store[ip_hash] = [t for t in _hourly_store[ip_hash] if t > hour_start]
    if len(_hourly_store[ip_hash]) >= _HOURLY_LIMIT:
        raise HTTPException(status_code=429, detail="hourly submission limit reached. try again later.")
    _hourly_store[ip_hash].append(now)


def _check_domain_dedupe(ip_hash: str, domain: str) -> None:
    now = time.time()
    last = _domain_store[ip_hash].get(domain, 0)
    if now - last < _DOMAIN_WINDOW:
        remaining = int((_DOMAIN_WINDOW - (now - last)) / 60)
        raise HTTPException(
            status_code=429,
            detail=f"you already shared from {domain} recently. try again in ~{remaining} min."
        )
    _domain_store[ip_hash][domain] = now


def _check_url_flood(normalized_url: str) -> None:
    """Prevent coordinated brigading of a single URL."""
    now = time.time()
    window_start = now - _URL_FLOOD_WINDOW
    _url_flood_store[normalized_url] = [
        t for t in _url_flood_store[normalized_url] if t > window_start
    ]
    if len(_url_flood_store[normalized_url]) >= _URL_FLOOD_LIMIT:
        raise HTTPException(status_code=429, detail="this url is being submitted too frequently. try again later.")
    _url_flood_store[normalized_url].append(now)


def _make_doc_id(normalized_url: str, country_code: str, city: str) -> str:
    """Same URL + same city → same Firestore doc (atomic counter)."""
    url_hash = hashlib.sha256(normalized_url.encode()).hexdigest()[:8]
    city_slug = city.lower().replace(" ", "_")[:12]
    return f"{url_hash}_{country_code}_{city_slug}"


def _hash_ip(ip: str) -> str:
    """One-way hash of IP — we never store or log the raw IP."""
    return hashlib.sha256(ip.encode()).hexdigest()[:16]


class SubmitRequest(BaseModel):
    url: str


@router.post("/submit")
async def submit(
    body: SubmitRequest,
    request: Request,
    x_submit_token: str | None = Header(default=None),
):
    # 0. Verify HMAC token (anti-bot, not a hard auth wall — soft reject in dev)
    if os.getenv("ENFORCE_TOKEN", "true").lower() != "false":
        if not _verify_token(x_submit_token):
            raise HTTPException(status_code=403, detail="invalid or missing submit token.")

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

    # 3b. Domain dedupe — prevent same IP flooding same site
    _check_domain_dedupe(ip_hash, domain)

    # 3c. URL-level flood guard
    _check_url_flood(normalized)

    # 4. GeoIP lookup (async, with localhost fallback)
    location = await geoip.lookup(client_ip)

    # 5. Write to Firestore (deduplicated by URL + city composite key)
    db = get_db()
    doc_id = _make_doc_id(normalized, location["country_code"], location["city"])
    doc_ref = db.collection("submissions").document(doc_id)

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
