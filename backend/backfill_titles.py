"""
One-time backfill script: update Firestore docs where title == domain (or is null)
with real article titles fetched from the metadata service.

Run from the backend/ directory:
    python backfill_titles.py

Set FIREBASE_CREDENTIALS_PATH or FIREBASE_CREDENTIALS_JSON in .env as usual.
"""

import asyncio
from firebase_client import get_db
from services.metadata import fetch_metadata


async def backfill():
    db = get_db()
    collection = db.collection("submissions")

    docs = collection.stream()
    updated = 0
    skipped = 0
    failed = 0

    for doc in docs:
        data = doc.to_dict()
        url    = data.get("url", "")
        domain = data.get("domain", "")
        title  = data.get("title")

        # Only process docs where title is missing or equals the domain
        if title and title != domain:
            skipped += 1
            continue

        meta = await fetch_metadata(url)
        real_title = meta.get("title", "")

        if real_title and real_title != domain:
            doc.reference.update({"title": real_title})
            print(f"  OK  {domain} -> {real_title[:80]}")
            updated += 1
        else:
            print(f"  -- {domain} - could not fetch real title")
            failed += 1

    print(f"\nDone. Updated: {updated}  Skipped (already had title): {skipped}  Failed: {failed}")


if __name__ == "__main__":
    asyncio.run(backfill())
