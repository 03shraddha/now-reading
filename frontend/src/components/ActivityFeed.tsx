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
  if (seconds < 60)       return `${seconds}s`;
  if (seconds < 3600)     return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400)    return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 604800)   return `${Math.floor(seconds / 86400)}d`;
  if (seconds < 2592000)  return `${Math.floor(seconds / 604800)}w`;
  if (seconds < 31536000) return `${Math.floor(seconds / 2592000)}mo`;
  return `${Math.floor(seconds / 31536000)}y`;
}

// Extract a readable title from the URL slug — instant, no network needed.
// Clean a stored title: strip file extensions, trailing numeric IDs, decode %20, etc.
function sanitizeTitle(t: string | null): string | null {
  if (!t) return null;
  let s = t.trim();
  try { s = decodeURIComponent(s); } catch { /* leave as-is */ }
  s = s.replace(/\.(html?|php|aspx?|jsp)$/i, "").trim(); // strip file extensions
  s = s.replace(/\s+\d{6,}$/, "").trim();                // strip trailing long numeric IDs
  if (s.length < 4 || /^\d+$/.test(s)) return null;
  return s;
}

// e.g. "https://x.substack.com/p/why-stoicism-matters" → "Why Stoicism Matters"
function titleFromUrl(url: string): string | null {
  try {
    const { pathname } = new URL(url);
    const parts = pathname.split("/").filter(Boolean);
    const raw   = decodeURIComponent(parts[parts.length - 1] ?? "");
    const clean = raw.replace(/\.[a-z]{2,5}$/, ""); // strip extensions
    if (clean.length < 5) return null;
    // Skip generic path segments
    if (/^(index|home|about|page|post|article|p|s|item|entry|read|view)$/i.test(clean)) return null;
    // Must contain at least one hyphen/underscore to look like a slug, not an ID
    if (!/[-_]/.test(clean) && /^\d+$/.test(clean)) return null;
    return clean.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  } catch {
    return null;
  }
}

function fmtCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n >= 99)   return "99+";
  return String(n);
}

type SortMode = "recent" | "reactions";

interface FeedCard {
  url:         string;
  domain:      string;
  title:       string | null;
  favicon_url: string | null;
  cities:      { name: string; flag: string; count: number; display_name: string | null; twitter_handle: string | null }[];
  totalCount:  number;
  latestAt:    Date;
  firstSeenAt: Date;
  lat:         number;
  lng:         number;
}

// ── Attribution helper ─────────────────────────────────────────
function Attribution({ twitter_handle, display_name }: { twitter_handle: string | null; display_name: string | null }) {
  if (twitter_handle)
    return <a href={`https://twitter.com/${twitter_handle}`} target="_blank" rel="noopener noreferrer" className="bubble-attribution">@{twitter_handle}</a>;
  if (display_name)
    return <span className="bubble-attribution bubble-attribution--name">{display_name}</span>;
  return null;
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

  const reactions      = useSubmissionsStore((s) => s.reactions);
  const reactedUrls    = useSubmissionsStore((s) => s.reactedUrls);
  const setReactedUrls = useSubmissionsStore((s) => s.setReactedUrls);
  const upsertReaction = useSubmissionsStore((s) => s.upsertReaction);

  const [titles, setTitles]             = useState<Record<string, string>>({});
  const [sort, setSort]                 = useState<SortMode>("recent");
  const [cityQuery, setCityQuery]       = useState("");
  const [reactingUrl, setReactingUrl]   = useState<string | null>(null); // tracks in-flight request
  const fetchedUrls                     = useRef<Set<string>>(new Set());

  // ── Drag-to-resize bottom sheet ──────────────────────────────
  const PEEK_H   = 88;   // px — handle + title only
  const FULL_VH  = 0.55; // default open = 55vh (both map + links visible)
  const sheetRef = useRef<HTMLDivElement>(null);
  const dragRef  = useRef<{ startY: number; startH: number } | null>(null);

  // ── Swipe-to-dismiss drawer (mobile only) ────────────────────
  const swipeRef = useRef<{ startX: number; startY: number; locked: boolean } | null>(null);

  function onDrawerTouchStart(e: React.TouchEvent) {
    if (window.innerWidth >= 640) return;
    swipeRef.current = { startX: e.touches[0].clientX, startY: e.touches[0].clientY, locked: false };
  }

  function onDrawerTouchMove(e: React.TouchEvent) {
    if (!swipeRef.current || !sheetRef.current || window.innerWidth >= 640) return;
    const dx = e.touches[0].clientX - swipeRef.current.startX;
    const dy = e.touches[0].clientY - swipeRef.current.startY;
    // Lock direction on first significant movement
    if (!swipeRef.current.locked) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return; // not yet moved enough to decide
      swipeRef.current.locked = true;
      // If more vertical than horizontal, let native scroll handle it
      if (Math.abs(dy) > Math.abs(dx)) { swipeRef.current = null; return; }
    }
    // Horizontal swipe right → translate drawer
    if (dx > 0) {
      e.preventDefault(); // prevent scroll while swiping drawer
      sheetRef.current.style.transition = "none";
      sheetRef.current.style.transform  = `translateX(${dx}px)`;
    }
  }

  function onDrawerTouchEnd(e: React.TouchEvent) {
    if (!swipeRef.current || !sheetRef.current || window.innerWidth >= 640) return;
    const dx = e.changedTouches[0].clientX - swipeRef.current.startX;
    swipeRef.current = null;
    sheetRef.current.style.transition = "";  // restore CSS transition
    sheetRef.current.style.transform  = "";  // let CSS class control position
    if (dx > 80) setMobileSheetOpen(false);  // swiped far enough → close
  }

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
  const userPinId        = useSubmissionsStore((s) => s.userPinId);
  const clearMyPin       = useSubmissionsStore((s) => s.clearMyPin);
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
      const city  = { name: sub.city, flag: countryFlag(sub.country_code), count: sub.count, display_name: sub.display_name, twitter_handle: sub.twitter_handle };

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
      if (sort === "reactions") return (reactions.get(b.url) ?? 0) - (reactions.get(a.url) ?? 0);
      return b.latestAt.getTime() - a.latestAt.getTime();
    });
  }, [allCards, sort, reactions]);

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

  // ── Fetch titles — trigger on allCards so all URLs warm up immediately,
  //    not just the top 30 visible ones. This means titles are ready by the
  //    time the user scrolls or re-sorts.
  useEffect(() => {
    for (const card of allCards) {
      if (fetchedUrls.current.has(card.url)) continue;
      // Skip if Firestore already has a good title
      if (card.title && card.title !== card.domain) continue;
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
  }, [allCards]);

  // ── Delete handler ────────────────────────────────────────
  async function handleDelete(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!userPinId) return;
    try {
      const tokenRes = await fetch(apiUrl("/api/token"));
      const { token } = await tokenRes.json();
      const res = await fetch(apiUrl(`/api/submission/${userPinId}`), {
        method: "DELETE",
        headers: { "X-Submit-Token": token },
      });
      if (res.ok || res.status === 404) {
        useSubmissionsStore.getState().removeSubmission(userPinId);
        clearMyPin();
      }
    } catch {}
  }

  // ── Heart reaction handler ────────────────────────────────
  async function handleReact(e: React.MouseEvent, url: string) {
    e.preventDefault();
    e.stopPropagation();
    if (reactingUrl === url) return; // debounce in-flight

    const already   = reactedUrls.has(url);
    const action    = already ? "remove" : "add";
    const prevCount = reactions.get(url) ?? 0;

    // Optimistic update — heart fill + count
    const newSet = new Set(reactedUrls);
    if (already) newSet.delete(url); else newSet.add(url);
    setReactedUrls(newSet);
    upsertReaction(url, already ? prevCount - 1 : prevCount + 1);
    try {
      localStorage.setItem("reactedUrls", JSON.stringify([...newSet]));
    } catch { /* storage may be unavailable */ }

    setReactingUrl(url);
    try {
      const tokenRes = await fetch(apiUrl("/api/token")).then((r) => r.json());
      await fetch(apiUrl("/api/react"), {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Submit-Token": tokenRes.token },
        body: JSON.stringify({ url, action }),
      });
    } catch {
      // On failure, roll back both optimistic updates
      setReactedUrls(reactedUrls);
      upsertReaction(url, prevCount);
    } finally {
      setReactingUrl(null);
    }
  }

  // Never hide the feed entirely — always render the shell so the bottom sheet is accessible
  if (submissions.size === 0) return null;

  return (
    <>
    {/* Backdrop: tapping outside closes the drawer on mobile */}
    {mobileSheetOpen && (
      <div className="feed-mobile-backdrop" onClick={() => setMobileSheetOpen(false)} />
    )}
    <div
      className="activity-feed"
      ref={sheetRef}
      onTouchStart={onDrawerTouchStart}
      onTouchMove={onDrawerTouchMove}
      onTouchEnd={onDrawerTouchEnd}
    >
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
          {(["recent", "reactions"] as SortMode[]).map((mode) => (
            <button
              key={mode}
              className={`feed-sort-tab${sort === mode ? " feed-sort-tab--active" : ""}`}
              onClick={() => setSort(mode)}
            >
              {mode === "reactions" ? "♡ top" : mode}
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
        <div className="feed-empty">
          {"nothing here yet — pan the map"}
        </div>
      ) : (
        <div className="feed-list">
          {cards.map((card, i) => {
            // Prefer stored title from Firestore, fall back to API fetch, then domain
            // Skip stored title if it's just the domain (metadata failed at submission time)
            const storedTitle = sanitizeTitle(card.title !== card.domain ? card.title : null);
            const title       = storedTitle || titles[card.url] || titleFromUrl(card.url) || card.domain;
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
                {isMyCard && (
                  <div className="bubble-yours-label">
                    your pin
                    <button className="bubble-delete-btn" onClick={handleDelete}>remove</button>
                  </div>
                )}
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
                  <Attribution twitter_handle={lead.twitter_handle} display_name={lead.display_name} />
                  <button
                    className={`bubble-heart${reactedUrls.has(card.url) ? " bubble-heart--active" : ""}`}
                    onClick={(e) => handleReact(e, card.url)}
                    aria-label={reactedUrls.has(card.url) ? "Unlike" : "Like"}
                  >
                    {reactedUrls.has(card.url) ? "♥" : "♡"}
                    {(reactions.get(card.url) ?? 0) > 0 && (
                      <span className="bubble-heart-count">{fmtCount(reactions.get(card.url)!)}</span>
                    )}
                  </button>
                </div>

                {thread.slice(0, 3).map((c, j) => (
                  <div key={j} className="bubble bubble--reply">
                    <span className="bubble-reply-city">{c.flag} {c.name}</span>
                    {c.count > 1 && <span className="bubble-count bubble-count--reply">{fmtCount(c.count)}</span>}
                    <Attribution twitter_handle={c.twitter_handle} display_name={c.display_name} />
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
