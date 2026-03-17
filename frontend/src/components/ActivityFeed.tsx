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

// ── Types ──────────────────────────────────────────────────────

interface FeedCard {
  url:        string;
  domain:     string;
  cities:     { name: string; flag: string; count: number }[];
  totalCount: number;
  latestAt:   Date;
  lat:        number;
  lng:        number;
}

// ── Component ──────────────────────────────────────────────────

export function ActivityFeed() {
  const submissions      = useSubmissionsStore((s) => s.submissions);
  const setFocusLocation = useSubmissionsStore((s) => s.setFocusLocation);

  const [titles, setTitles]     = useState<Record<string, string>>({});
  const fetchedUrls             = useRef<Set<string>>(new Set());

  // ── Group by URL ───────────────────────────────────────────
  const cards: FeedCard[] = useMemo(() => {
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
      } else {
        map.set(sub.url, {
          url: sub.url, domain: sub.domain,
          cities: [city], totalCount: sub.count,
          latestAt: sub.updated_at, lat: sub.lat, lng: sub.lng,
        });
      }
    }

    return Array.from(map.values())
      .sort((a, b) => b.latestAt.getTime() - a.latestAt.getTime())
      .slice(0, 25);
  }, [submissions]);

  // ── Fetch titles ───────────────────────────────────────────
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
          // Sort cities by count so the biggest reader group leads
          const sorted = [...card.cities].sort((a, b) => b.count - a.count);
          const lead   = sorted[0];
          const thread = sorted.slice(1);

          return (
            <a
              key={card.url}
              className="bubble-thread"
              href={card.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setFocusLocation([card.lat, card.lng])}
            >
              {/* Main bubble — lead city */}
              <div className="bubble bubble--main">
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

              {/* Thread replies — other cities reading the same thing */}
              {thread.map((c, i) => (
                <div key={i} className="bubble bubble--reply">
                  <span className="bubble-reply-city">{c.flag} {c.name}</span>
                  {c.count > 1 && <span className="bubble-count bubble-count--reply">{c.count}</span>}
                </div>
              ))}
            </a>
          );
        })}
      </div>
    </div>
  );
}
