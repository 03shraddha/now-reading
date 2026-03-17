import { useMemo, useState, useEffect, useRef } from "react";
import { useSubmissionsStore } from "../store/submissionsStore";

// ── Helpers ────────────────────────────────────────────────────

function countryFlag(code: string): string {
  if (!code || code.length !== 2) return "";
  const pts = code.toUpperCase().split("").map((c) => 127397 + c.charCodeAt(0));
  return String.fromCodePoint(...pts);
}

function timeAgo(date: Date): string {
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60)   return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

type SortMode = "recent" | "most-read" | "rising";

interface FeedCard {
  url:        string;
  domain:     string;
  cities:     { name: string; flag: string; count: number }[];
  totalCount: number;
  latestAt:   Date;
  firstSeenAt: Date;
  lat:        number;
  lng:        number;
}

// ── Component ──────────────────────────────────────────────────

export function ActivityFeed() {
  const submissions      = useSubmissionsStore((s) => s.submissions);
  const setFocusLocation = useSubmissionsStore((s) => s.setFocusLocation);

  const [titles, setTitles]   = useState<Record<string, string>>({});
  const [sort, setSort]        = useState<SortMode>("recent");
  const [query, setQuery]      = useState("");
  const fetchedUrls            = useRef<Set<string>>(new Set());
  // Track the URL the user just submitted (for "your bubble" highlight)
  const [myUrl, setMyUrl]      = useState<string | null>(null);

  // Listen for the user's own submission via a custom event dispatched by SubmitBar
  useEffect(() => {
    const handler = (e: Event) => {
      const url = (e as CustomEvent<string>).detail;
      setMyUrl(url);
      // Clear highlight after 30s
      setTimeout(() => setMyUrl(null), 30_000);
    };
    window.addEventListener("user-submitted", handler);
    return () => window.removeEventListener("user-submitted", handler);
  }, []);

  // ── Group by URL ───────────────────────────────────────────
  const allCards: FeedCard[] = useMemo(() => {
    const map = new Map<string, FeedCard>();

    for (const sub of submissions.values()) {
      const entry = map.get(sub.url);
      const city  = { name: sub.city, flag: countryFlag(sub.country_code), count: sub.count };

      if (entry) {
        entry.totalCount += sub.count;
        entry.cities.push(city);
        if (sub.updated_at > entry.latestAt) {
          entry.latestAt = sub.updated_at;
          entry.lat = sub.lat;
          entry.lng = sub.lng;
        }
        if (sub.updated_at < entry.firstSeenAt) entry.firstSeenAt = sub.updated_at;
      } else {
        map.set(sub.url, {
          url: sub.url, domain: sub.domain, cities: [city],
          totalCount: sub.count, latestAt: sub.updated_at, firstSeenAt: sub.updated_at,
          lat: sub.lat, lng: sub.lng,
        });
      }
    }

    return Array.from(map.values());
  }, [submissions]);

  // ── Sort ──────────────────────────────────────────────────
  const sorted = useMemo(() => {
    const now = Date.now();
    return [...allCards].sort((a, b) => {
      if (sort === "most-read") return b.totalCount - a.totalCount;
      if (sort === "rising") {
        // Rising = count / hours since first seen  (velocity)
        const hoursA = Math.max(1, (now - a.firstSeenAt.getTime()) / 3_600_000);
        const hoursB = Math.max(1, (now - b.firstSeenAt.getTime()) / 3_600_000);
        return (b.totalCount / hoursB) - (a.totalCount / hoursA);
      }
      return b.latestAt.getTime() - a.latestAt.getTime(); // recent
    });
  }, [allCards, sort]);

  // ── Search filter ─────────────────────────────────────────
  const cards = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? sorted.filter((c) =>
          c.domain.toLowerCase().includes(q) ||
          (titles[c.url] ?? "").toLowerCase().includes(q) ||
          c.cities.some((city) => city.name.toLowerCase().includes(q))
        )
      : sorted;
    return filtered.slice(0, 25);
  }, [sorted, query, titles]);

  // ── Fetch titles ──────────────────────────────────────────
  useEffect(() => {
    for (const card of cards) {
      if (fetchedUrls.current.has(card.url)) continue;
      fetchedUrls.current.add(card.url);
      fetch(`/api/metadata?url=${encodeURIComponent(card.url)}`)
        .then((r) => r.ok ? r.json() : null)
        .then((data) => {
          if (data?.title && data.title !== card.domain) {
            setTitles((prev) => ({ ...prev, [card.url]: data.title }));
          }
        })
        .catch(() => {});
    }
  }, [cards]);

  if (allCards.length === 0) return null;

  return (
    <div className="activity-feed">
      {/* Header: live count + sort tabs */}
      <div className="feed-header">
        <div className="feed-header-top">
          <span className="feed-title">live</span>
          <span className="feed-count">{allCards.length}</span>
        </div>
        <div className="feed-sort-tabs">
          {(["recent", "most-read", "rising"] as SortMode[]).map((mode) => (
            <button
              key={mode}
              className={`feed-sort-tab${sort === mode ? " feed-sort-tab--active" : ""}`}
              onClick={() => setSort(mode)}
            >
              {mode === "most-read" ? "most read" : mode}
            </button>
          ))}
        </div>
        <div className="feed-search-wrap">
          <input
            className="feed-search"
            placeholder="search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button className="feed-search-clear" onClick={() => setQuery("")}>×</button>
          )}
        </div>
      </div>

      {cards.length === 0 ? (
        <div className="feed-empty">no results for "{query}"</div>
      ) : (
        <div className="feed-list">
          {cards.map((card, i) => {
            const title    = titles[card.url];
            const isMyCard = card.url === myUrl;
            const sorted   = [...card.cities].sort((a, b) => b.count - a.count);
            const lead     = sorted[0];
            const thread   = sorted.slice(1);

            return (
              <a
                key={card.url}
                className={`bubble-thread${isMyCard ? " bubble-thread--mine" : ""}`}
                href={card.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setFocusLocation([card.lat, card.lng])}
                style={{ animationDelay: `${i * 40}ms` }}
              >
                {isMyCard && <div className="bubble-yours-label">yours · just now</div>}

                <div className={`bubble bubble--main${isMyCard ? " bubble--mine" : ""}`}>
                  <div className="bubble-meta">
                    <img
                      src={`https://www.google.com/s2/favicons?domain=${card.domain}&sz=32`}
                      className="bubble-favicon"
                      alt=""
                      onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
                    />
                    <span className="bubble-domain">{card.domain}</span>
                    <span className="bubble-time">{timeAgo(card.latestAt)}</span>
                  </div>
                  {title && <div className="bubble-title">{title}</div>}
                  <div className="bubble-city">
                    {lead.flag} {lead.name}
                    {lead.count > 1 && <span className="bubble-count">{lead.count}</span>}
                  </div>
                </div>

                {thread.map((c, j) => (
                  <div key={j} className="bubble bubble--reply">
                    <span className="bubble-reply-city">{c.flag} {c.name}</span>
                    {c.count > 1 && <span className="bubble-count bubble-count--reply">{c.count}</span>}
                  </div>
                ))}
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}
