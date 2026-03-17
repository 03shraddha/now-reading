import re
import httpx
from urllib.parse import urlparse

_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; ReadingMapBot/1.0)"}


async def fetch_metadata(url: str) -> dict:
    """Scrape og:title, og:description, and favicon for a URL. Never raises."""
    domain = urlparse(url).netloc.replace("www.", "")
    favicon_url = f"https://www.google.com/s2/favicons?domain={domain}&sz=32"
    fallback = {"title": domain, "description": None, "domain": domain, "favicon_url": favicon_url}

    try:
        async with httpx.AsyncClient(timeout=6.0, follow_redirects=True) as client:
            resp = await client.get(url, headers=_HEADERS)
            if resp.status_code >= 400:
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

    return {
        "title": title.strip()[:120],
        "description": description.strip()[:200] if description else None,
        "domain": domain,
        "favicon_url": favicon_url,
    }


def _first_match(html: str, pattern: str) -> str | None:
    m = re.search(pattern, html, re.I | re.S)
    return m.group(1) if m else None
