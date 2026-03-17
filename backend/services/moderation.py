"""
URL moderation: domain blocklist + Google Safe Browsing API check.
Called before a submission is written to Firestore.
"""

import os
import httpx
from fastapi import HTTPException

# ── Domain blocklist ────────────────────────────────────────────────────────
# Known NSFW, spam, or low-quality domains that shouldn't appear on the map.

_BLOCKED_DOMAINS: set[str] = {
    # Adult content
    "pornhub.com", "xvideos.com", "xnxx.com", "xhamster.com",
    "redtube.com", "youporn.com", "tube8.com", "spankbang.com",
    "brazzers.com", "onlyfans.com", "fapello.com", "eporner.com",
    "tnaflix.com", "4tube.com", "beeg.com", "porntrex.com",
    "hentaigasm.com", "rule34.xxx", "e621.net", "gelbooru.com",

    # Shock / gore
    "bestgore.com", "liveleak.com", "goregrish.com", "kaotic.com",

    # Scam / phishing (common patterns)
    "freebitcoin.io", "claimbtc.com",

    # Malware distribution (well-known)
    "adfly.com", "adf.ly",

    # Spam URL shorteners that hide destinations
    "shrinkme.io", "ouo.io", "bc.vc",
}


def _extract_base_domain(url: str) -> str:
    """Extract registrable domain from a URL (e.g. sub.example.com → example.com)."""
    from urllib.parse import urlparse
    host = urlparse(url).netloc.lower().lstrip("www.")
    # Keep last two parts: subdomain.example.co.uk → example.co.uk (rough heuristic)
    parts = host.split(".")
    return ".".join(parts[-2:]) if len(parts) >= 2 else host


def check_domain_blocklist(url: str) -> None:
    """Raise HTTP 400 if the URL's domain is on the blocklist."""
    domain = _extract_base_domain(url)
    if domain in _BLOCKED_DOMAINS:
        raise HTTPException(status_code=400, detail="this url is not allowed.")


# ── Google Safe Browsing API ────────────────────────────────────────────────
# Checks URLs against Google's malware, phishing, and unwanted software lists.
# Free tier: 10,000 lookups/day.
# Requires SAFE_BROWSING_API_KEY env var.
# Get a key: https://console.cloud.google.com/apis/library/safebrowsing.googleapis.com

_SAFE_BROWSING_URL = "https://safebrowsing.googleapis.com/v4/threatMatches:find"

_THREAT_TYPES = [
    "MALWARE",
    "SOCIAL_ENGINEERING",       # phishing
    "UNWANTED_SOFTWARE",
    "POTENTIALLY_HARMFUL_APPLICATION",
]


async def check_safe_browsing(url: str) -> None:
    """
    Raise HTTP 400 if Google Safe Browsing flags the URL.
    Silently passes if the API key is not configured or the API is unreachable.
    """
    api_key = os.getenv("SAFE_BROWSING_API_KEY")
    if not api_key:
        return  # feature disabled — skip silently

    payload = {
        "client": {"clientId": "global-map", "clientVersion": "1.0"},
        "threatInfo": {
            "threatTypes": _THREAT_TYPES,
            "platformTypes": ["ANY_PLATFORM"],
            "threatEntryTypes": ["URL"],
            "threatEntries": [{"url": url}],
        },
    }

    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.post(
                _SAFE_BROWSING_URL,
                params={"key": api_key},
                json=payload,
            )
        if resp.status_code == 200:
            data = resp.json()
            if data.get("matches"):
                raise HTTPException(
                    status_code=400,
                    detail="this url has been flagged as unsafe and cannot be shared."
                )
    except HTTPException:
        raise
    except Exception:
        pass  # API unreachable — fail open, don't block legitimate submissions
