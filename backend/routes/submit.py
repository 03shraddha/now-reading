import asyncio
import hashlib
import hmac
import ipaddress
import os
import re
import time
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Request, Header, HTTPException
from pydantic import BaseModel
from google.cloud.firestore_v1 import SERVER_TIMESTAMP, Increment

from firebase_client import get_db
from services import geoip, url_utils, moderation
from services.metadata import fetch_metadata

router = APIRouter()

# ── Token validation ───────────────────────────────────────────────────────
TOKEN_SECRET = os.getenv("SUBMIT_TOKEN_SECRET", "dev-secret-change-me")
TOKEN_WINDOW = 300  # must match main.py

# In-memory nonce store: nonce -> expiry timestamp.
# Prevents replay attacks without a Firestore round trip.
# Trade-off: doesn't survive server restarts (acceptable — tokens expire in 5 min anyway).
_USED_NONCES: dict[str, float] = {}


def _make_token(window: int, nonce: str) -> str:
    msg = f"submit:{window}:{nonce}".encode()
    return hmac.new(TOKEN_SECRET.encode(), msg, hashlib.sha256).hexdigest()


def _check_nonce(nonce: str) -> bool:
    """Return False if this nonce was already used (replay attack). In-memory, O(n) prune on overflow."""
    now = time.time()
    # Prune expired entries when the dict gets large
    if len(_USED_NONCES) > 5000:
        expired = [k for k, v in _USED_NONCES.items() if v < now]
        for k in expired:
            del _USED_NONCES[k]

    expiry = now + TOKEN_WINDOW * 2
    if _USED_NONCES.get(nonce, 0) > now:
        return False  # already used
    _USED_NONCES[nonce] = expiry
    return True


def _verify_token(token: str | None) -> bool:
    if not token:
        return False
    parts = token.split(":")
    if len(parts) != 2:
        return False
    token_hex, nonce = parts[0], parts[1]
    now = int(time.time())
    window = now // TOKEN_WINDOW
    for w in (window, window - 1):
        if hmac.compare_digest(_make_token(w, nonce), token_hex):
            if not _check_nonce(nonce):
                raise HTTPException(status_code=403, detail="invalid or missing submit token.")
            return True
    return False


# ── Rate limits ────────────────────────────────────────────────────────────
_RATE_LIMIT    = 5
_RATE_WINDOW   = 60
_HOURLY_LIMIT  = 20
_HOURLY_WINDOW = 3600
_DOMAIN_WINDOW = 10 * 60
_URL_FLOOD_LIMIT  = 60
_URL_FLOOD_WINDOW = 3600


def _check_all_rate_limits_sync(ip_hash: str, domain: str, normalized_url: str) -> None:
    """
    Check all rate limits with a single batched Firestore read and a single batch write.
    Previously: 4 reads + 4 writes (8 RPCs). Now: 1 read + 1 write (2 RPCs).
    Synchronous — call via asyncio.to_thread().
    """
    now = time.time()
    db = get_db()

    url_hash_16 = hashlib.sha256(normalized_url.encode()).hexdigest()[:16]
    burst_ref  = db.collection("rate_limits").document(f"burst_{ip_hash}")
    hourly_ref = db.collection("rate_limits").document(f"hourly_{ip_hash}")
    domain_ref = db.collection("rate_limits").document(f"domain_{ip_hash}_{domain}")
    url_ref    = db.collection("rate_limits").document(f"url_{url_hash_16}")

    # Single RPC to fetch all 4 docs
    docs_by_id = {doc.id: doc for doc in db.get_all([burst_ref, hourly_ref, domain_ref, url_ref])}

    burst_doc  = docs_by_id.get(f"burst_{ip_hash}")
    hourly_doc = docs_by_id.get(f"hourly_{ip_hash}")
    domain_doc = docs_by_id.get(f"domain_{ip_hash}_{domain}")
    url_doc    = docs_by_id.get(f"url_{url_hash_16}")

    def _times(doc, key="times") -> list:
        return (doc.get(key) or []) if (doc and doc.exists) else []

    # Burst check
    burst_start = now - _RATE_WINDOW
    burst_times = [t for t in _times(burst_doc) if t > burst_start]
    if len(burst_times) >= _RATE_LIMIT:
        raise HTTPException(status_code=429, detail="too many submissions. please wait a moment.")
    burst_times.append(now)

    # Hourly check
    hour_start = now - _HOURLY_WINDOW
    hourly_times = [t for t in _times(hourly_doc) if t > hour_start]
    if len(hourly_times) >= _HOURLY_LIMIT:
        raise HTTPException(status_code=429, detail="hourly submission limit reached. try again later.")
    hourly_times.append(now)

    # Domain dedupe
    last = (domain_doc.get("last") if domain_doc and domain_doc.exists else None) or 0
    if last and now - last < _DOMAIN_WINDOW:
        remaining = int((_DOMAIN_WINDOW - (now - last)) / 60)
        raise HTTPException(
            status_code=429,
            detail=f"you already shared from {domain} recently. try again in ~{remaining} min."
        )

    # URL flood
    window_start = now - _URL_FLOOD_WINDOW
    url_times = [t for t in _times(url_doc) if t > window_start]
    if len(url_times) >= _URL_FLOOD_LIMIT:
        raise HTTPException(status_code=429, detail="this url is being submitted too frequently. try again later.")
    url_times.append(now)

    # Single batch write for all 4 docs
    batch = db.batch()
    batch.set(burst_ref,  {"times": burst_times,  "expires_at": datetime.fromtimestamp(now + _RATE_WINDOW,   tz=timezone.utc)})
    batch.set(hourly_ref, {"times": hourly_times, "expires_at": datetime.fromtimestamp(now + _HOURLY_WINDOW, tz=timezone.utc)})
    batch.set(domain_ref, {"last": now,            "expires_at": datetime.fromtimestamp(now + _DOMAIN_WINDOW, tz=timezone.utc)})
    batch.set(url_ref,    {"times": url_times,     "expires_at": datetime.fromtimestamp(now + _URL_FLOOD_WINDOW, tz=timezone.utc)})
    batch.commit()


def _make_doc_id(normalized_url: str, country_code: str, city: str) -> str:
    url_hash = hashlib.sha256(normalized_url.encode()).hexdigest()[:8]
    city_slug = city.lower().replace(" ", "_")[:12]
    return f"{url_hash}_{country_code}_{city_slug}"


# Number of trusted reverse proxies in front of this server.
# Render appends the real client IP as the last XFF entry, so default is 1.
# Change via env var if your infra differs (e.g. 2 for an extra CDN layer).
_TRUSTED_PROXY_COUNT = int(os.getenv("TRUSTED_PROXY_COUNT", "1"))


def _extract_client_ip(request: Request) -> str:
    """
    Extract the real client IP, accounting for reverse proxies.

    X-Forwarded-For: <client>, <proxy1>, ..., <last_proxy>
    We trust the last TRUSTED_PROXY_COUNT entries to have been added by our
    infra, so we pick the entry just before those — i.e. index [-count].

    After extraction the value is:
      - validated with ipaddress (rejects garbage strings)
      - unwrapped from IPv4-mapped IPv6 (::ffff:1.2.3.4 → 1.2.3.4)

    Returns "" if the IP cannot be determined or is invalid.
    """
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        parts = [p.strip() for p in forwarded.split(",")]
        # Guard: if there are fewer entries than expected, take the first one
        idx = -_TRUSTED_PROXY_COUNT if _TRUSTED_PROXY_COUNT <= len(parts) else 0
        raw = parts[idx]
    else:
        raw = (request.client.host if request.client else "") or ""

    if not raw:
        return ""

    try:
        addr = ipaddress.ip_address(raw)
        # Unwrap IPv4-mapped IPv6 addresses (e.g. from dual-stack listeners)
        if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
            return str(addr.ipv4_mapped)
        return str(addr)
    except ValueError:
        return ""


def _hash_ip(ip: str) -> str:
    return hashlib.sha256(ip.encode()).hexdigest()[:16]


class SubmitRequest(BaseModel):
    url:            str
    display_name:   Optional[str] = None
    twitter_handle: Optional[str] = None
    lat:            Optional[float] = None  # browser geolocation (opt-in)
    lng:            Optional[float] = None


@router.post("/submit")
async def submit(
    body: SubmitRequest,
    request: Request,
    x_submit_token: str | None = Header(default=None),
):
    # 0. Verify HMAC token
    if os.getenv("ENFORCE_TOKEN", "true").lower() != "false":
        if not _verify_token(x_submit_token):
            raise HTTPException(status_code=403, detail="invalid or missing submit token.")

    # 1. Validate URL and extract domain (fast, local)
    is_valid, error = url_utils.validate_url(body.url)
    if not is_valid:
        raise HTTPException(status_code=400, detail=error)

    moderation.check_domain_blocklist(body.url)

    client_ip = _extract_client_ip(request)
    if not client_ip:
        raise HTTPException(status_code=400, detail="could not determine client IP.")
    ip_hash = _hash_ip(client_ip)

    normalized = url_utils.normalize_url(body.url)
    domain     = url_utils.extract_domain(normalized)

    # 2. Rate limits + Safe Browsing in parallel
    #    Rate limits run in a thread (sync Firestore, 1 batch read + 1 batch write)
    #    Safe Browsing is async HTTP (skipped if no API key)
    await asyncio.gather(
        asyncio.to_thread(_check_all_rate_limits_sync, ip_hash, domain, normalized),
        moderation.check_safe_browsing(body.url),
    )

    # 3. Location + metadata fetch in parallel.
    #    If the client sent browser geolocation coordinates, reverse-geocode them
    #    (more accurate). Otherwise fall back to IP-based lookup.
    has_coords = body.lat is not None and body.lng is not None
    location_coro = (
        geoip.reverse_geocode(body.lat, body.lng)  # type: ignore[arg-type]
        if has_coords
        else geoip.lookup(client_ip)
    )
    location, meta = await asyncio.gather(location_coro, fetch_metadata(normalized))

    # 4. Sanitize optional identity fields
    display_name = (body.display_name or "").strip().lower()[:50] or None
    raw_handle   = (body.twitter_handle or "").strip().lstrip("@").lower()
    twitter_handle = raw_handle if re.match(r'^[a-z0-9_]{1,15}$', raw_handle) else None

    # 5. Write to Firestore (deduplicated by URL + city composite key)
    db = get_db()
    doc_id  = _make_doc_id(normalized, location["country_code"], location["city"])
    doc_ref = db.collection("submissions").document(doc_id)

    existing = doc_ref.get()
    if existing.exists:
        count = (existing.get("count") or 0) + 1
        doc_ref.update({
            "count": Increment(1),
            "updated_at": SERVER_TIMESTAMP,
            "display_name":   display_name,
            "twitter_handle": twitter_handle,
        })
    else:
        count = 1
        doc_ref.set({
            "url": normalized,
            "domain": domain,
            "title": meta.get("title") if meta.get("title") != domain else None,
            "favicon_url": meta.get("favicon_url", f"https://www.google.com/s2/favicons?domain={domain}&sz=32"),
            "city": location["city"],
            "country": location["country"],
            "country_code": location["country_code"],
            "lat": location["lat"],
            "lng": location["lng"],
            "count": 1,
            "updated_at": SERVER_TIMESTAMP,
            "display_name":   display_name,
            "twitter_handle": twitter_handle,
        })

    return {
        "id": doc_id,
        "lat": location["lat"],
        "lng": location["lng"],
        "city": location["city"],
        "country": location["country"],
        "country_code": location["country_code"],
        "domain": domain,
        "title": meta.get("title") if meta.get("title") != domain else None,
        "favicon_url": meta.get("favicon_url", f"https://www.google.com/s2/favicons?domain={domain}&sz=32"),
        "count": count,
        "display_name":   display_name,
        "twitter_handle": twitter_handle,
    }
