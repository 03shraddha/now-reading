import { useMemo, useState, useEffect, useRef } from "react";
import { useSubmissionsStore } from "../store/submissionsStore";

// ── Helpers ────────────────────────────────────────────────────

function countryFlag(code: string): string {
  if (!code || code.length !== 2) return "";
  const pts = code.toUpperCase().split("").map((c) => 127397 + c.charCodeAt(0));
  return String.fromCodePoint(...pts);
}

function timeAgo(date: Date): string {
  // Clamp to 0 — SERVER_TIMESTAMP may arrive slightly in the future
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60)   return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

// ── Types ──────────────────────────────────────────────────────

interface FeedCard {
  // keyed by url — groups same article submitted from multiple cities
  url:        string;
  domain:     string;
  cities:     { name: string; flag: string }[];
  totalCount: number;
  latestAt:   Date;
  lat:        number;
  lng:        number;
}

// ── Component ──────────────────────────────────────────────────

export function ActivityFeed() {
  const submissions      = useSubmissionsStore((s) => s.submissions);
  const setFocusLocation = useSubmissionsStore((s) => s.setFocusLocation);

  // title cache: url → title string
  const [titles, setTitles]     = useState<Record<string, string>>({});
  const fetchedUrls             = useRef<Set<string>>(new Set());

  // ── Group same URL submitted from different cities ─────────
  const cards: FeedCard[] = useMemo(() => {
    const map = new Map<string, FeedCard>();

    for (const sub of submissions.values()) {
      const entry = map.get(sub.url);
      const cityEntry = { name: sub.city, flag: countryFlag(sub.country_code) };

      if (entry) {
        entry.totalCount += sub.count;
        entry.cities.push(cityEntry);
        if (sub.updated_at > entry.latestAt) {
          entry.latestAt = sub.updated_at;
          entry.lat = sub.lat;
          entry.lng = sub.lng;
        }
      } else {
        map.set(sub.url, {
          url:        sub.url,
          domain:     sub.domain,
          cities:     [cityEntry],
          totalCount: sub.count,
          latestAt:   sub.updated_at,
          lat:        sub.lat,
          lng:        sub.lng,
        });
      }
    }

    return Array.from(map.values())
      .sort((a, b) => b.latestAt.getTime() - a.latestAt.getTime())
      .slice(0, 25);
  }, [submissions]);

  // ── Lazy-fetch titles for each unique URL ──────────────────
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
        .catch(() => { /* silently skip */ });
    }
  }, [cards]);

  if (cards.length === 0) return null;

  return (
    <div className="activity-feed">
      <div className="feed-header">
        <span className="feed-title">live</span>
        <span className="feed-count">{cards.length}</span>
      </div>

      <div className="feed-list">
        {cards.map((card) => {
          const title = titles[card.url];
          // Show up to 2 cities inline, "+N" overflow
          const shownCities = card.cities.slice(0, 2);
          const overflow    = card.cities.length - shownCities.length;

          return (
            <a
              key={card.url}
              className="feed-item"
              href={card.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setFocusLocation([card.lat, card.lng])}
            >
              {/* Top: favicon + domain + timestamp */}
              <div className="feed-card-top">
                <div className="feed-card-source">
                  <img
                    src={`https://www.google.com/s2/favicons?domain=${card.domain}&sz=32`}
                    className="feed-favicon"
                    alt=""
                    onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
                  />
                  <span className="feed-domain">{card.domain}</span>
                </div>
                <span className="feed-time">{timeAgo(card.latestAt)}</span>
              </div>

              {/* Title — the actual article name, most important signal */}
              {title && (
                <div className="feed-title-text">{title}</div>
              )}

              {/* Bottom: city chips + reader count */}
              <div className="feed-card-bottom">
                <div className="feed-cities">
                  {shownCities.map((c, i) => (
                    <span key={i} className="feed-location">
                      {c.flag} {c.name}
                    </span>
                  ))}
                  {overflow > 0 && (
                    <span className="feed-location feed-location--overflow">
                      +{overflow}
                    </span>
                  )}
                </div>
                {card.totalCount > 1 && (
                  <span className="feed-badge">{card.totalCount}</span>
                )}
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}
