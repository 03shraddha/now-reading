import re
import html as html_mod
import socket
import ipaddress
import time
import httpx
from urllib.parse import urlparse, unquote

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
            # Unwrap IPv4-mapped IPv6 (e.g. ::ffff:10.0.0.1 → 10.0.0.1) so
            # _BLOCKED_NETWORKS IPv4 entries match correctly.
            if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
                addr = addr.ipv4_mapped
            if any(addr in net for net in _BLOCKED_NETWORKS):
                return True
        except ValueError:
            pass
    return False


def _extract_og_title(html: str) -> str | None:
    """Extract og:title regardless of whether property or content comes first."""
    for tag_match in re.finditer(r'<meta\s[^>]+>', html, re.I | re.S):
        tag = tag_match.group(0)
        if not re.search(r'property=["\']og:title["\']', tag, re.I):
            continue
        content = re.search(r'content=["\']([^"\']+)["\']', tag, re.I)
        if content:
            return content.group(1)
    return None


def _extract_og_description(html: str) -> str | None:
    """Extract og:description regardless of whether property or content comes first."""
    for tag_match in re.finditer(r'<meta\s[^>]+>', html, re.I | re.S):
        tag = tag_match.group(0)
        if not re.search(r'property=["\']og:description["\']', tag, re.I):
            continue
        content = re.search(r'content=["\']([^"\']+)["\']', tag, re.I)
        if content:
            return content.group(1)
    return None


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
    fallback         = {"title": slug_title or domain, "description": None, "domain": domain, "favicon_url": favicon_url, "reachable": True}
    unreachable_fallback = {**fallback, "reachable": False}

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
                _META_CACHE[url] = (unreachable_fallback, time.time() + _META_TTL)
                return unreachable_fallback
            html = resp.text
    except Exception:
        return fallback

    scraped_title = (
        _extract_og_title(html)
        or _first_match(html, r'<title[^>]*>([^<]+)</title>')
    )
    if scraped_title:
        scraped_title = _clean_scraped_title(scraped_title)
    if scraped_title and _is_junk_scraped_title(scraped_title, domain):
        scraped_title = None  # prefer slug/domain over junk title
    title = scraped_title or slug_title or domain
    description = (
        _extract_og_description(html)
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
# Leading numeric ID used by Goodreads etc.: "44421460-book-title" → strip "44421460-"
_LEADING_ID_RE = re.compile(r'^\d+-')
# Common file extensions to strip from URL path segments before slug extraction
_FILE_EXT_RE = re.compile(r'\.(pdf|html?|aspx?|php|jsp|cfm)$', re.I)
# arXiv-style paper IDs (e.g. 2301.00001) — not useful as a title slug
_ARXIV_ID_RE = re.compile(r'^\d{4}\.\d{4,5}$')
# Titles that indicate bot-challenge / error pages — not real article titles
_JUNK_TITLES = {
    "just a moment", "access denied", "403 forbidden", "404 not found",
    "please wait", "checking your browser", "attention required",
}

# Matches titles that are a short prefix + long numeric ID: "P 187790585", "ID 4567890"
_JUNK_ID_RE = re.compile(r'^[A-Za-z]{0,3}\s*\d{5,}$')

# Trailing long numeric ID: "Reverend Insanity 7996858406002505"
_TRAILING_NUM_RE = re.compile(r'\s+\d{6,}$')

# Words in a scraped title that suggest a paywall/login page — prefer slug fallback over these
_PAYWALL_WORDS = {
    "subscribe", "subscription", "already a subscriber",
    "sign in", "sign up", "sign up for free",
    "log in", "login",
    "register", "create account", "create a free account",
    "premium", "members only", "members-only",
    "unlock", "get access", "paywall",
}


def _clean_scraped_title(title: str) -> str:
    """
    Strip common noise from scraped <title> and og:title values:
    - Percent-encoding (%20 etc.)
    - URL fragments (https://, http://)
    - Site-name suffixes separated by |, ·, —, –, or spaced hyphen ( - )
    - File extensions (.html, .pdf, etc.)
    - Trailing/leading whitespace
    """
    # Decode percent-encoding first (e.g. %20 -> space)
    try:
        title = unquote(title)
    except Exception:
        pass
    # Cut off at the first occurrence of a URL scheme
    for scheme in ("https://", "http://", "https:", "http:"):
        idx = title.find(scheme)
        if idx > 0:
            title = title[:idx]
    # Strip common site-name separators (| · — – and spaced dash) — keep only the first part
    title = re.split(r'\s*[|·—–]\s*|\s+-\s+', title, maxsplit=1)[0]
    # Strip file extensions from the title itself (e.g. "Baby.Html" -> "Baby")
    title = _FILE_EXT_RE.sub("", title)
    return title.strip()


def _is_junk_scraped_title(title: str, domain: str) -> bool:
    """Return True if the scraped title is not a real article title."""
    if not title or len(title) < 4:
        return True
    t_lower = title.lower().strip()
    if t_lower == domain.lower():
        return True
    if _JUNK_ID_RE.match(title.strip()):       # "P 187790585", "12345678"
        return True
    if _TRAILING_NUM_RE.search(title):          # "Reverend Insanity 7996858406002505"
        return True
    if '%' in title and re.search(r'%[0-9A-Fa-f]{2}', title):  # still has encoding
        return True
    if t_lower in _JUNK_TITLES:
        return True
    if any(w in t_lower for w in _PAYWALL_WORDS):
        return True
    return False


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

        # Strip file extension before further checks (e.g. "2301.00001.pdf" → "2301.00001")
        seg = _FILE_EXT_RE.sub("", seg)
        if not seg:
            continue

        if _ARXIV_ID_RE.match(seg):    # arXiv paper ID (e.g. 2301.00001) → skip
            continue
        if len(seg) < 6:               # too short to be meaningful
            continue

        # Strip trailing platform hash ID (e.g. Medium's "-abc123def456")
        clean = _HASH_RE.sub("", seg)
        # Strip leading numeric ID (e.g. Goodreads' "44421460-book-title")
        clean = _LEADING_ID_RE.sub("", clean)
        if len(clean) < 4:             # stripping left nothing useful
            continue

        return clean.replace("-", " ").replace("_", " ").title()

    return None
