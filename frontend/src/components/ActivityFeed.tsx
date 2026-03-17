import { useMemo, useState, useEffect, useRef } from "react";
import { useSubmissionsStore } from "../store/submissionsStore";
import { apiUrl } from "../lib/api";

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

function fmtCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n >= 99)   return "99+";
  return String(n);
}

type SortMode = "recent" | "a-z" | "z-a";

interface FeedCard {
  url:         string;
  domain:      string;
  title:       string | null;
  favicon_url: string | null;
  cities:      { name: string; flag: string; count: number }[];
  totalCount:  number;
  latestAt:    Date;
  firstSeenAt: Date;
  lat:         number;
  lng:         number;
}

// ── Component ──────────────────────────────────────────────────

export function ActivityFeed() {
  const submissions        = useSubmissionsStore((s) => s.submissions);
  const mapBounds          = useSubmissionsStore((s) => s.mapBounds);
  const mapZoom            = useSubmissionsStore((s) => s.mapZoom);
  const mobileSheetOpen    = useSubmissionsStore((s) => s.mobileSheetOpen);
  const setMobileSheetOpen = useSubmissionsStore((s) => s.setMobileSheetOpen);
  const setFocusLocation = useSubmissionsStore((s) => s.setFocusLocation);
  const hoveredUrl       = useSubmissionsStore((s) => s.hoveredUrl);
  const setHoveredUrl    = useSubmissionsStore((s) => s.setHoveredUrl);
  useSubmissionsStore((s) => s.userPinId); // subscribed for future highlight feature

  const [titles, setTitles]       = useState<Record<string, string>>({});
  const [sort, setSort]           = useState<SortMode>("recent");
  const [cityQuery, setCityQuery] = useState("");
  const fetchedUrls               = useRef<Set<string>>(new Set());

  // ── Drag-to-resize bottom sheet ──────────────────────────────
  const PEEK_H   = 88;   // px — handle + title only
  const FULL_VH  = 0.55; // default open = 55vh (both map + links visible)
  const sheetRef = useRef<HTMLDivElement>(null);
  const dragRef  = useRef<{ startY: number; startH: number } | null>(null);

  function getFullH() { return Math.round(window.innerHeight * FULL_VH); }

  function snapSheet(currentH: number) {
    const mid = (PEEK_H + getFullH()) / 2;
    const open = currentH > mid;
    setMobileSheetOpen(open);
    if (sheetRef.current) {
      sheetRef.current.style.height = "";      // let CSS class take over
      sheetRef.current.style.transition = "";  // restore CSS transition
    }
  }

  function onHandleTouchStart(e: React.TouchEvent) {
    // Drag-to-resize only applies on desktop (tablet+) where feed is a bottom sheet.
    // On mobile (<640px) the feed is a right-side drawer — no height drag.
    if (window.innerWidth < 640 || !sheetRef.current) return;
    const currentH = sheetRef.current.getBoundingClientRect().height;
    dragRef.current = { startY: e.touches[0].clientY, startH: currentH };
    sheetRef.current.style.transition = "none"; // disable during drag
  }

  function onHandleTouchMove(e: React.TouchEvent) {
    if (!dragRef.current || !sheetRef.current) return;
    const dy   = dragRef.current.startY - e.touches[0].clientY; // drag up = positive
    const newH = Math.max(PEEK_H, Math.min(getFullH(), dragRef.current.startH + dy));
    sheetRef.current.style.height = `${newH}px`;
  }

  function onHandleTouchEnd() {
    if (!dragRef.current || !sheetRef.current) return;
    const currentH = sheetRef.current.getBoundingClientRect().height;
    dragRef.current = null;
    snapSheet(currentH);
  }

  const userSubmittedUrl = useSubmissionsStore((s) => s.userSubmittedUrl);
  const myUrl = userSubmittedUrl;

  // ── Viewport filter — only apply when zoomed in; always fall back to global ───
  const inBoundsSubmissions = useMemo(() => {
    if (!mapBounds || mapZoom < 5) return submissions; // world/region zoom → show all
    const filtered = new Map();
    for (const [id, sub] of submissions) {
      if (
        sub.lat >= mapBounds.south && sub.lat <= mapBounds.north &&
        sub.lng >= mapBounds.west  && sub.lng <= mapBounds.east
      ) filtered.set(id, sub);
    }
    // If viewport has nothing, fall back to global so feed is never empty
    return filtered.size > 0 ? filtered : submissions;
  }, [submissions, mapBounds, mapZoom]);

  // ── Group by URL ───────────────────────────────────────────
  const allCards: FeedCard[] = useMemo(() => {
    const map = new Map<string, FeedCard>();

    for (const sub of inBoundsSubmissions.values()) {
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
        // Fill in title/favicon from newer docs if not yet set
        if (!entry.title && sub.title) entry.title = sub.title;
        if (!entry.favicon_url && sub.favicon_url) entry.favicon_url = sub.favicon_url;
      } else {
        map.set(sub.url, {
          url: sub.url, domain: sub.domain,
          title: sub.title ?? null,
          favicon_url: sub.favicon_url ?? null,
          cities: [city],
          totalCount: sub.count, latestAt: sub.updated_at, firstSeenAt: sub.updated_at,
          lat: sub.lat, lng: sub.lng,
        });
      }
    }

    return Array.from(map.values());
  }, [inBoundsSubmissions]);

  // ── Dominant region for header ────────────────────────────
  // Escalates: single city → country → "worldwide"
  const regionName = useMemo(() => {
    const cities    = new Set<string>();
    const countries = new Set<string>();
    for (const sub of inBoundsSubmissions.values()) {
      if (sub.city)    cities.add(sub.city);
      if (sub.country) countries.add(sub.country);
    }
    if (cities.size === 0) return null;
    if (cities.size === 1) return [...cities][0];           // single city → show it
    if (countries.size === 1) return [...countries][0];     // many cities, one country → show country
    return "worldwide";                                     // many countries → global
  }, [inBoundsSubmissions]);

  // Reset sort to "recent" when feed has fewer than 2 cards (sort is meaningless)
  useEffect(() => {
    if (allCards.length < 2 && sort !== "recent") setSort("recent");
  }, [allCards.length, sort]);

  // ── Sort ──────────────────────────────────────────────────
  const sorted = useMemo(() => {
    return [...allCards].sort((a, b) => {
      if (sort === "a-z") return  a.domain.localeCompare(b.domain);
      if (sort === "z-a") return  b.domain.localeCompare(a.domain);
      return b.latestAt.getTime() - a.latestAt.getTime();
    });
  }, [allCards, sort]);

  // ── Final cards: city filter, user's own card pinned to top ──
  const cards = useMemo(() => {
    const q = cityQuery.trim().toLowerCase();
    let filtered = q
      ? sorted.filter((c) => c.cities.some((city) => city.name.toLowerCase().includes(q)))
      : sorted;
    // Pin user's own card to top so they can see what they dropped
    if (myUrl) {
      const myIdx = filtered.findIndex((c) => c.url === myUrl);
      if (myIdx > 0) {
        const [mine] = filtered.splice(myIdx, 1);
        filtered.unshift(mine);
      }
    }
    return filtered.slice(0, 30);
  }, [sorted, cityQuery, myUrl]);

  // ── Fetch titles ──────────────────────────────────────────
  useEffect(() => {
    for (const card of cards) {
      if (fetchedUrls.current.has(card.url)) continue;
      fetchedUrls.current.add(card.url);
      fetch(apiUrl(`/api/metadata?url=${encodeURIComponent(card.url)}`))
        .then((r) => r.ok ? r.json() : null)
        .then((data) => {
          if (data?.title && data.title !== card.domain) {
            setTitles((prev) => ({ ...prev, [card.url]: data.title }));
          }
        })
        .catch(() => {});
    }
  }, [cards]);

  // Never hide the feed entirely — always render the shell so the bottom sheet is accessible
  if (submissions.size === 0) return null;

  return (
    <>
    {/* Backdrop: tapping outside closes the drawer on mobile */}
    {mobileSheetOpen && (
      <div className="feed-mobile-backdrop" onClick={() => setMobileSheetOpen(false)} />
    )}
    <div className="activity-feed" ref={sheetRef}>
      {/* Header — tap to toggle, drag to resize */}
      <div
        className="feed-header"
        onTouchStart={onHandleTouchStart}
        onTouchMove={onHandleTouchMove}
        onTouchEnd={onHandleTouchEnd}
        onClick={(e) => {
          const t = e.target as HTMLElement;
          if (t.closest(".feed-sort-tabs, .feed-city-input-wrap")) return;
          setMobileSheetOpen(!mobileSheetOpen);
        }}
      >
        <div className="feed-header-top">
          <span className="feed-title">
            {regionName ? `top reads in ${regionName}` : "recent reads"}
          </span>
          <span className="feed-count" title="unique links in view">
            {cards.length} {cards.length === 1 ? "link" : "links"}
          </span>
          {/* Close button lives inside the feed on mobile */}
          <button
            className="feed-close-btn"
            onClick={(e) => { e.stopPropagation(); setMobileSheetOpen(false); }}
            aria-label="Close feed"
          >×</button>
        </div>

        {/* Sort tabs */}
        <div className="feed-sort-tabs">
          {(["recent", "a-z", "z-a"] as SortMode[]).map((mode) => (
            <button
              key={mode}
              className={`feed-sort-tab${sort === mode ? " feed-sort-tab--active" : ""}`}
              onClick={() => setSort(mode)}
            >
              {mode}
            </button>
          ))}
        </div>
        <div className="feed-city-input-wrap feed-city-input-wrap--always">
          <input
            id="feed-city-input"
            className={`feed-city-input${cityQuery ? " feed-city-input--active" : ""}`}
            placeholder="filter by your city :)"
            value={cityQuery}
            onChange={(e) => setCityQuery(e.target.value)}
            spellCheck={false}
          />
          {cityQuery && (
            <button className="feed-city-input-clear" onClick={() => setCityQuery("")}>×</button>
          )}
        </div>
      </div>

      {cards.length === 0 ? (
        <div className="feed-empty">nothing here yet — pan the map</div>
      ) : (
        <div className="feed-list">
          {cards.map((card, i) => {
            // Prefer stored title from Firestore, fall back to API fetch, then domain
            const title     = card.title || titles[card.url] || card.domain;
            const isMyCard  = card.url === myUrl;
            const isHovered = card.url === hoveredUrl;
            const citiesSorted = [...card.cities].sort((a, b) => b.count - a.count);
            const lead      = citiesSorted[0];
            const thread    = citiesSorted.slice(1);

            return (
              <a
                key={card.url}
                className={`bubble-thread${isMyCard ? " bubble-thread--mine" : ""}${isHovered ? " bubble-thread--hovered" : ""}`}
                href={card.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setFocusLocation([card.lat, card.lng])}
                onMouseEnter={() => setHoveredUrl(card.url)}
                onMouseLeave={() => setHoveredUrl(null)}
                style={{ animationDelay: `${i * 40}ms` }}
              >
                {isMyCard && <div className="bubble-yours-label">your pin</div>}
                <div className={`bubble bubble--main${isMyCard ? " bubble--mine" : ""}`}>
                  <div className="bubble-meta">
                    <img
                      src={card.favicon_url || `https://www.google.com/s2/favicons?domain=${card.domain}&sz=32`}
                      className="bubble-favicon"
                      alt=""
                      onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
                    />
                    <span className="bubble-domain">{card.domain}</span>
                    <span className="bubble-time">{timeAgo(card.latestAt)}</span>
                  </div>
                  <div className="bubble-title">{title}</div>
                  <div className="bubble-city">
                    {lead.flag} {lead.name}
                    {lead.count > 1 && <span className="bubble-count">{fmtCount(lead.count)}</span>}
                  </div>
                </div>

                {thread.slice(0, 3).map((c, j) => (
                  <div key={j} className="bubble bubble--reply">
                    <span className="bubble-reply-city">{c.flag} {c.name}</span>
                    {c.count > 1 && <span className="bubble-count bubble-count--reply">{fmtCount(c.count)}</span>}
                  </div>
                ))}
                {thread.length > 3 && (
                  <div className="bubble bubble--reply bubble--overflow">
                    +{thread.length - 3} more cities
                  </div>
                )}
              </a>
            );
          })}
        </div>
      )}
    </div>
    </>
  );
}
