import re
from urllib.parse import urlparse, urlencode, parse_qsl, urlunparse
import ipaddress

# Query params that track users — strip these before storing
TRACKING_PARAMS = {
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "fbclid", "gclid", "ref", "referrer", "source", "_ga", "mc_cid", "mc_eid",
}

# Private/local IP ranges we should not allow as submission targets
_PRIVATE_RANGES = [
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("::1/128"),
]


def normalize_url(url: str) -> str:
    """Lowercase domain, strip tracking params, remove trailing slash from path."""
    parsed = urlparse(url.strip())
    # Lowercase scheme and host
    scheme = parsed.scheme.lower()
    netloc = parsed.netloc.lower()
    path = parsed.path.rstrip("/") or "/"
    # Remove tracking query params
    clean_params = [(k, v) for k, v in parse_qsl(parsed.query) if k.lower() not in TRACKING_PARAMS]
    query = urlencode(clean_params)
    return urlunparse((scheme, netloc, path, "", query, ""))


def extract_domain(url: str) -> str:
    """Return just the domain (host without www. prefix)."""
    host = urlparse(url).netloc.lower()
    return host.removeprefix("www.")


def validate_url(url: str) -> tuple[bool, str]:
    """
    Returns (is_valid, error_message).
    Rejects non-http(s) schemes and private/localhost targets.
    """
    try:
        parsed = urlparse(url)
    except Exception:
        return False, "Invalid URL format"

    if parsed.scheme not in ("http", "https"):
        return False, "Only http and https URLs are allowed"

    host = parsed.hostname
    if not host:
        return False, "URL has no host"

    if host in ("localhost", "127.0.0.1", "::1"):
        return False, "Local URLs are not allowed"

    # Reject percent-encoded characters in the hostname (e.g. "project%20hail%20mary")
    if "%" in host:
        return False, "Invalid URL — the domain contains encoded characters"

    # Reject hostnames without a dot — these are bare words, not real domains
    try:
        ipaddress.ip_address(host)
        # It's a valid IP — fall through to private-range check below
    except ValueError:
        # It's a domain name — must contain at least one dot
        if "." not in host:
            return False, "Invalid URL — not a valid domain"

    # Block submissions pointing at private IP ranges
    try:
        addr = ipaddress.ip_address(host)
        for network in _PRIVATE_RANGES:
            if addr in network:
                return False, "Private IP addresses are not allowed"
    except ValueError:
        pass  # host is a domain name, not an IP — that's fine

    return True, ""
