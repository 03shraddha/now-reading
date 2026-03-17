import { useState, useEffect } from "react";
import type { PageMetadata } from "../types";

const cache = new Map<string, PageMetadata>();

export function useMetadata(url: string | null) {
  const [metadata, setMetadata] = useState<PageMetadata | null>(
    url && cache.has(url) ? cache.get(url)! : null
  );

  useEffect(() => {
    if (!url) return;
    if (cache.has(url)) { setMetadata(cache.get(url)!); return; }

    fetch(`/api/metadata?url=${encodeURIComponent(url)}`)
      .then((r) => r.json())
      .then((data: PageMetadata) => {
        cache.set(url, data);
        setMetadata(data);
      })
      .catch(() => {});
  }, [url]);

  return metadata;
}
