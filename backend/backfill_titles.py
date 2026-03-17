"""
One-time backfill script: re-fetch and update titles for ALL Firestore docs.

Run from the backend/ directory:
    python backfill_titles.py

Set FIREBASE_CREDENTIALS_PATH or FIREBASE_CREDENTIALS_JSON in .env as usual.
"""

import asyncio
from firebase_client import get_db
from services.metadata import fetch_metadata


async def backfill():
    db = get_db()
    docs = list(db.collection("submissions").stream())
    print(f"Processing {len(docs)} documents...\n")

    updated = 0
    skipped = 0
    failed = 0

    for doc in docs:
        data = doc.to_dict()
        url    = data.get("url", "")
        domain = data.get("domain", "")
        title  = data.get("title")

        meta = await fetch_metadata(url)
        real_title = meta.get("title", "")

        if real_title and real_title != domain:
            # Only write if different from what's stored
            if real_title != title:
                doc.reference.update({"title": real_title})
                print(f"  OK  {domain} -> {real_title[:80]}")
                updated += 1
            else:
                skipped += 1
        else:
            # Fetch failed — only clear if stored title is also bad (domain or null)
            # Never overwrite a previously backfilled real title
            if title and title != domain:
                print(f"  KEEP {domain} - fetch failed but keeping stored title: {title[:80]}")
                skipped += 1
            elif title is not None:
                # title was the domain string — clear it so frontend fetches dynamically
                doc.reference.update({"title": None})
                print(f"  NULL {domain} - cleared domain-as-title")
                failed += 1
            else:
                skipped += 1
                failed += 1

    print(f"\nDone. Updated: {updated}  Already correct: {skipped}  Could not fetch (cleared to null): {failed}")


if __name__ == "__main__":
    asyncio.run(backfill())
