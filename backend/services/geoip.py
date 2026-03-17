import random
import time
import httpx

# Fallback cities used when the request comes from localhost (dev mode)
_INDIA_FALLBACK_CITIES = [
    {"city": "Mumbai",    "country": "India", "country_code": "IN", "lat": 19.0760, "lng": 72.8777},
    {"city": "Delhi",     "country": "India", "country_code": "IN", "lat": 28.6139, "lng": 77.2090},
    {"city": "Bangalore", "country": "India", "country_code": "IN", "lat": 12.9716, "lng": 77.5946},
    {"city": "Chennai",   "country": "India", "country_code": "IN", "lat": 13.0827, "lng": 80.2707},
    {"city": "Kolkata",   "country": "India", "country_code": "IN", "lat": 22.5726, "lng": 88.3639},
    {"city": "Hyderabad", "country": "India", "country_code": "IN", "lat": 17.3850, "lng": 78.4867},
    {"city": "Pune",      "country": "India", "country_code": "IN", "lat": 18.5204, "lng": 73.8567},
    {"city": "Ahmedabad", "country": "India", "country_code": "IN", "lat": 23.0225, "lng": 72.5714},
]

_LOCAL_IPS = {"127.0.0.1", "::1", "localhost", ""}

# Cache: ip -> (result_dict, expiry_timestamp). TTL = 24 hours.
_GEO_CACHE: dict[str, tuple[dict, float]] = {}
_GEO_TTL = 86_400


def _add_jitter(lat: float, lng: float) -> tuple[float, float]:
    """Add ±0.05° random offset so even the city centroid isn't exact."""
    return (
        round(lat + random.uniform(-0.05, 0.05), 4),
        round(lng + random.uniform(-0.05, 0.05), 4),
    )


async def reverse_geocode(lat: float, lng: float) -> dict:
    """
    Reverse-geocode GPS coordinates to city-level location using Nominatim.
    Used when the client provides browser geolocation instead of relying on IP.
    Falls back to the nearest Indian city on failure.
    """
    cache_key = f"coords:{round(lat, 2)},{round(lng, 2)}"
    cached = _GEO_CACHE.get(cache_key)
    if cached and time.time() < cached[1]:
        return cached[0]

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(
                "https://nominatim.openstreetmap.org/reverse",
                params={"lat": lat, "lon": lng, "format": "json", "zoom": 10},
                headers={"User-Agent": "GlobalReadingMap/1.0"},
            )
            data = resp.json()

        addr = data.get("address", {})
        city = (
            addr.get("city")
            or addr.get("town")
            or addr.get("village")
            or addr.get("county")
            or "Unknown"
        )
        country      = addr.get("country", "Unknown")
        country_code = addr.get("country_code", "").upper()

        jlat, jlng = _add_jitter(lat, lng)
        result = {
            "city":         city,
            "country":      country,
            "country_code": country_code,
            "lat":          jlat,
            "lng":          jlng,
        }
        _GEO_CACHE[cache_key] = (result, time.time() + _GEO_TTL)
        return result
    except Exception:
        pass

    location = random.choice(_INDIA_FALLBACK_CITIES).copy()
    location["lat"], location["lng"] = _add_jitter(location["lat"], location["lng"])
    return location


async def lookup(ip: str) -> dict:
    """
    Resolve an IP address to approximate city-level location.
    Returns dict with: city, country, country_code, lat, lng.
    Falls back to a random Indian city for localhost/private IPs.
    """
    if ip in _LOCAL_IPS or ip.startswith("192.168.") or ip.startswith("10."):
        # Dev mode: pick a random Indian city so the map has something to show
        location = random.choice(_INDIA_FALLBACK_CITIES).copy()
        location["lat"], location["lng"] = _add_jitter(location["lat"], location["lng"])
        return location

    # Return cached result if still fresh
    cached = _GEO_CACHE.get(ip)
    if cached and time.time() < cached[1]:
        return cached[0]

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(
                f"http://ip-api.com/json/{ip}",
                params={"fields": "status,city,country,countryCode,lat,lon"},
            )
            data = resp.json()

        if data.get("status") == "success":
            lat, lng = _add_jitter(data["lat"], data["lon"])
            result = {
                "city": data.get("city", "Unknown"),
                "country": data.get("country", "Unknown"),
                "country_code": data.get("countryCode", ""),
                "lat": lat,
                "lng": lng,
            }
            _GEO_CACHE[ip] = (result, time.time() + _GEO_TTL)
            return result
    except Exception:
        pass

    # GeoIP failed — fall back to random Indian city (not cached; failures should be retried)
    location = random.choice(_INDIA_FALLBACK_CITIES).copy()
    location["lat"], location["lng"] = _add_jitter(location["lat"], location["lng"])
    return location
