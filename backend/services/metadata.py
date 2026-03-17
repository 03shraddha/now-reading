import re
import html as html_mod
import socket
import ipaddress
import time
import httpx
from urllib.parse import urlparse

_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; ReadingMapBot/1.0)"}

# Private/loopback ranges — never fetch these (SSRF prevention)
_BLOCKED_NETWORKS: list[ipaddress.IPv4Network | ipaddress.IPv6Network] = [
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("169.254.0.0/16"),  # link-local / AWS metadata
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
]

# Cache: url -> (result_dict, expiry_timestamp). TTL = 10 minutes.
_META_CACHE: dict[str, tuple[dict, float]] = {}
_META_TTL = 600


def _resolves_to_private(host: str) -> bool:
    """Return True if the host resolves to any private/loopback address."""
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return True  # unresolvable → treat as blocked
    for info in infos:
        addr_str = info[4][0]
        try:
            addr = ipaddress.ip_address(addr_str)
            if any(addr in net for net in _BLOCKED_NETWORKS):
                return True
        except ValueError:
            pass
    return False


async def fetch_metadata(url: str) -> dict:
    """Scrape og:title, og:description, and favicon for a URL. Never raises."""
    # Return cached result if still fresh
    cached = _META_CACHE.get(url)
    if cached and time.time() < cached[1]:
        return cached[0]

    parsed = urlparse(url)
    domain = (parsed.netloc or "").replace("www.", "")
    favicon_url = f"https://www.google.com/s2/favicons?domain={domain}&sz=32"
    fallback = {"title": domain, "description": None, "domain": domain, "favicon_url": favicon_url}

    # SSRF guard — resolve hostname before any HTTP I/O (not cached; no real attempt made)
    if _resolves_to_private(parsed.hostname or ""):
        return fallback

    try:
        # follow_redirects=False prevents redirect-chain SSRF bypass
        async with httpx.AsyncClient(timeout=6.0, follow_redirects=False) as client:
            resp = await client.get(url, headers=_HEADERS)
            if resp.status_code >= 400:
                # Cache failed HTTP responses so we don't hammer unreachable URLs
                if len(_META_CACHE) > 1000:
                    _META_CACHE.clear()
                _META_CACHE[url] = (fallback, time.time() + _META_TTL)
                return fallback
            html = resp.text
    except Exception:
        return fallback

    title = (
        _first_match(html, r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)["\']')
        or _first_match(html, r'<title[^>]*>([^<]+)</title>')
        or domain
    )
    description = (
        _first_match(html, r'<meta[^>]+property=["\']og:description["\'][^>]+content=["\']([^"\']+)["\']')
        or _first_match(html, r'<meta[^>]+name=["\']description["\'][^>]+content=["\']([^"\']+)["\']')
    )

    result = {
        "title": html_mod.unescape(title.strip())[:120],
        "description": html_mod.unescape(description.strip())[:200] if description else None,
        "domain": domain,
        "favicon_url": favicon_url,
    }
    # Simple eviction: clear entire cache if it grows too large before inserting
    if len(_META_CACHE) > 1000:
        _META_CACHE.clear()
    _META_CACHE[url] = (result, time.time() + _META_TTL)
    return result


def _first_match(html: str, pattern: str) -> str | None:
    m = re.search(pattern, html, re.I | re.S)
    return m.group(1) if m else None
