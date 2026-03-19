"""
One-time backfill script: update titles for Firestore docs that are missing
or corrupted.

Two passes:
  1. Corrupted titles (contain "http" or end with junk): apply
     _clean_scraped_title() to the stored value — instant, no HTTP.
     If the cleaned title is still bad, fall through to pass 2.
  2. Missing titles (null or just the domain): try slug extraction
     (instant), then live scrape as last resort.

Run from the backend/ directory:
    python backfill_titles.py
"""

import asyncio
import re
from dotenv import load_dotenv
load_dotenv()

from firebase_client import get_db
from services.metadata import fetch_metadata, _title_from_url, _clean_scraped_title, _is_junk_scraped_title


def _is_corrupted(title: str, domain: str) -> bool:
    """Return True if a stored title looks corrupted and should be re-cleaned."""
    if not title or title == domain:
        return False  # missing/blank — handled separately
    lower = title.lower()
    return (
        "http" in lower          # URL bleed-through
        or title.endswith(":")   # truncated mid-URL ("https:")
        or title.endswith("/")   # truncated mid-URL
        or re.search(r'\bhttps?\s*$', lower) is not None  # ends with "https" or "http"
    )


async def backfill():
    db = get_db()
    docs = list(db.collection("submissions").stream())
    print(f"Found {len(docs)} documents.\n")

    corrupted   = []
    junk        = []
    missing     = []
    good        = 0

    for doc in docs:
        data   = doc.to_dict()
        title  = data.get("title") or ""
        domain = data.get("domain", "")
        if _is_corrupted(title, domain):
            corrupted.append(doc)
        elif not title or title == domain:
            missing.append(doc)
        elif _is_junk_scraped_title(title, domain):
            # Stored title is junk (e.g. "Document moved", shortcodes)
            junk.append(doc)
        else:
            good += 1

    print(f"  Good titles:      {good}")
    print(f"  Corrupted titles: {len(corrupted)}")
    print(f"  Junk titles:      {len(junk)}")
    print(f"  Missing titles:   {len(missing)}")
    print()

    fixed_clean  = 0
    fixed_slug   = 0
    fixed_scrape = 0
    unchanged    = 0

    # ── Pass 1: fix corrupted titles ──────────────────────────────
    if corrupted:
        print(f"--- Pass 1: fixing {len(corrupted)} corrupted titles ---")
    for doc in corrupted:
        data   = doc.to_dict()
        url    = data.get("url", "")
        domain = data.get("domain", "")
        old    = data.get("title", "")

        cleaned = _clean_scraped_title(old)
        if cleaned and cleaned != domain and len(cleaned) >= 4:
            doc.reference.update({"title": cleaned})
            print(f"  CLEAN  {domain:30s}  {old[:40]!r}  →  {cleaned[:60]!r}")
            fixed_clean += 1
            continue

        # Cleaned title still useless — try slug
        slug = _title_from_url(url)
        if slug and slug != domain:
            doc.reference.update({"title": slug})
            print(f"  SLUG   {domain:30s}  {slug[:60]!r}")
            fixed_slug += 1
            continue

        # Last resort: live scrape
        meta = await fetch_metadata(url)
        scraped = meta.get("title", "")
        if scraped and scraped != domain:
            doc.reference.update({"title": scraped})
            print(f"  SCRAPE {domain:30s}  {scraped[:60]!r}")
            fixed_scrape += 1
        else:
            print(f"  SKIP   {domain:30s}  (no better title found)")
            unchanged += 1

    # ── Pass 2: fix junk titles (e.g. "Document moved", shortcodes) ──
    if junk:
        print(f"\n--- Pass 2: fixing {len(junk)} junk titles ---")
    for doc in junk:
        data   = doc.to_dict()
        url    = data.get("url", "")
        domain = data.get("domain", "")
        old    = data.get("title", "")

        # Prefer slug (instant, no HTTP) first
        slug = _title_from_url(url)
        if slug and slug != domain and not _is_junk_scraped_title(slug, domain):
            doc.reference.update({"title": slug})
            print(f"  SLUG   {domain:30s}  {old[:40]!r}  →  {slug[:60]!r}")
            fixed_slug += 1
            continue

        # Fall back to live scrape
        meta = await fetch_metadata(url)
        scraped = meta.get("title", "")
        if scraped and scraped != domain and not _is_junk_scraped_title(scraped, domain):
            doc.reference.update({"title": scraped})
            print(f"  SCRAPE {domain:30s}  {old[:40]!r}  →  {scraped[:60]!r}")
            fixed_scrape += 1
        else:
            print(f"  SKIP   {domain:30s}  {old[:40]!r}  (no better title found)")
            unchanged += 1

    # ── Pass 3: fill in missing titles ────────────────────────────
    if missing:
        print(f"\n--- Pass 3: filling {len(missing)} missing titles ---")
    for doc in missing:
        data   = doc.to_dict()
        url    = data.get("url", "")
        domain = data.get("domain", "")

        slug = _title_from_url(url)
        if slug and slug != domain:
            doc.reference.update({"title": slug})
            print(f"  SLUG   {domain:30s}  {slug[:60]!r}")
            fixed_slug += 1
            continue

        meta = await fetch_metadata(url)
        scraped = meta.get("title", "")
        if scraped and scraped != domain:
            doc.reference.update({"title": scraped})
            print(f"  SCRAPE {domain:30s}  {scraped[:60]!r}")
            fixed_scrape += 1
        else:
            print(f"  SKIP   {domain:30s}  (no title found)")
            unchanged += 1

    total = fixed_clean + fixed_slug + fixed_scrape
    print(f"\nDone.")
    print(f"  Fixed via clean:  {fixed_clean}")
    print(f"  Fixed via slug:   {fixed_slug}")
    print(f"  Fixed via scrape: {fixed_scrape}")
    print(f"  No title found:   {unchanged}")
    print(f"  Total updated:    {total} / {len(corrupted) + len(missing)}")


if __name__ == "__main__":
    asyncio.run(backfill())
