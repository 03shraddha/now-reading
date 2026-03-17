"""
One-time backfill script: update titles for Firestore docs that are missing one.

Strategy (fast-first):
  1. Skip docs that already have a real title.
  2. Try slug extraction from the URL (instant, no HTTP) — handles Medium, Substack, etc.
  3. If slug extraction fails, fall back to live metadata scraping (slow, has timeouts).

Run from the backend/ directory:
    python backfill_titles.py

Set FIREBASE_CREDENTIALS_PATH or FIREBASE_CREDENTIALS_JSON in .env as usual.
"""

import asyncio
from dotenv import load_dotenv
load_dotenv()

from firebase_client import get_db
from services.metadata import fetch_metadata, _title_from_url


async def backfill():
    db = get_db()
    docs = list(db.collection("submissions").stream())
    print(f"Found {len(docs)} documents.\n")

    needs_update = []
    skipped = 0

    for doc in docs:
        data   = doc.to_dict()
        title  = data.get("title")
        domain = data.get("domain", "")
        # Skip docs that already have a real title (not null, not just the domain)
        if title and title != domain:
            skipped += 1
            continue
        needs_update.append(doc)

    print(f"Skipped {skipped} docs with good titles. Processing {len(needs_update)} docs...\n")

    slug_updated  = 0
    scrape_updated = 0
    unchanged     = 0

    for doc in needs_update:
        data   = doc.to_dict()
        url    = data.get("url", "")
        domain = data.get("domain", "")

        # --- Pass 1: slug extraction (no HTTP, instant) ---
        slug_title = _title_from_url(url)
        if slug_title and slug_title != domain:
            doc.reference.update({"title": slug_title})
            print(f"  SLUG  {domain:30s}  {slug_title[:70]}")
            slug_updated += 1
            continue

        # --- Pass 2: live scrape (HTTP, slower) ---
        meta = await fetch_metadata(url)
        scraped = meta.get("title", "")
        if scraped and scraped != domain:
            doc.reference.update({"title": scraped})
            print(f"  SCRAPE {domain:30s}  {scraped[:70]}")
            scrape_updated += 1
        else:
            print(f"  SKIP   {domain:30s}  (no title found)")
            unchanged += 1

    total_updated = slug_updated + scrape_updated
    print(f"\nDone.")
    print(f"  Updated via slug:   {slug_updated}")
    print(f"  Updated via scrape: {scrape_updated}")
    print(f"  No title found:     {unchanged}")
    print(f"  Total updated:      {total_updated} / {len(needs_update)}")


if __name__ == "__main__":
    asyncio.run(backfill())
