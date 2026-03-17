import re
import html as html_mod
import socket
import ipaddress
import time
import httpx
from urllib.parse import urlparse

_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

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
    slug_title = _title_from_url(url)  # last-resort: readable slug from URL path
    fallback = {"title": slug_title or domain, "description": None, "domain": domain, "favicon_url": favicon_url}

    # SSRF guard — resolve hostname before any HTTP I/O (not cached; no real attempt made)
    if _resolves_to_private(parsed.hostname or ""):
        return fallback

    async def _on_redirect(response: httpx.Response) -> None:
        """Block redirects that point to private/internal addresses (SSRF guard)."""
        location = response.headers.get("location", "")
        if location:
            redir_host = (urlparse(location).hostname or "")
            if redir_host and _resolves_to_private(redir_host):
                raise ValueError(f"Redirect to private address blocked: {location}")

    try:
        async with httpx.AsyncClient(
            timeout=6.0,
            follow_redirects=True,
            max_redirects=5,
            event_hooks={"response": [_on_redirect]},
        ) as client:
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

    scraped_title = (
        _first_match(html, r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)["\']')
        or _first_match(html, r'<title[^>]*>([^<]+)</title>')
    )
    # Discard bot-challenge/error page titles that aren't real article titles
    _JUNK_TITLES = {"just a moment", "access denied", "403 forbidden", "404 not found",
                    "please wait", "checking your browser", "attention required"}
    if scraped_title and scraped_title.strip().lower() in _JUNK_TITLES:
        scraped_title = None
    title = scraped_title or slug_title or domain
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


# Date-like segments to skip when extracting slug title (YYYY, YYYY-MM-DD, etc.)
_DATE_RE    = re.compile(r'^\d{4}(-\d{2}(-\d{2})?)?$')
# Trailing hash ID appended by platforms like Medium: "-abc123def456" (8-16 hex/alnum chars)
_HASH_RE    = re.compile(r'-[0-9a-f]{8,16}$', re.I)
# Segments that are entirely hex (CMS content IDs, UUIDs, etc.)
_ALL_HEX_RE = re.compile(r'^[0-9a-f\-]{8,}$', re.I)


def _title_from_url(url: str) -> str | None:
    """
    Extract a human-readable title from the URL slug as a last-resort fallback.
    e.g. /leaders/2026/03/12/chinas-hereditary-elite-is-taking-shape
         -> "Chinas Hereditary Elite Is Taking Shape"
    e.g. /@john/my-great-article-abc123def456  (Medium)
         -> "My Great Article"
    Returns None if no meaningful slug is found.
    """
    path = urlparse(url).path.rstrip("/")
    segments = [s for s in path.split("/") if s]

    for seg in reversed(segments):
        if seg.startswith("@"):        # @username segment → skip
            continue
        if _DATE_RE.match(seg):        # date component → skip
            continue
        if re.match(r'^\d+$', seg):    # pure numeric ID → skip
            continue
        if _ALL_HEX_RE.match(seg):     # UUID / pure hex ID → skip
            continue
        if len(seg) < 6:               # too short to be meaningful
            continue

        # Strip trailing platform hash ID (e.g. Medium's "-abc123def456")
        clean = _HASH_RE.sub("", seg)
        if len(clean) < 4:             # stripping left nothing useful
            continue

        return clean.replace("-", " ").replace("_", " ").title()

    return None
