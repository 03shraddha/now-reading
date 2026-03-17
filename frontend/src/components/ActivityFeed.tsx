import { useSubmissionsStore } from "../store/submissionsStore";
import type { Submission } from "../types";

function countryFlag(code: string): string {
  if (!code || code.length !== 2) return "🌐";
  const pts = code.toUpperCase().split("").map((c) => 127397 + c.charCodeAt(0));
  return String.fromCodePoint(...pts);
}

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60)   return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

export function ActivityFeed() {
  const submissions      = useSubmissionsStore((s) => s.submissions);
  const setFocusLocation = useSubmissionsStore((s) => s.setFocusLocation);

  // Top 20 by most recent
  const items: Submission[] = Array.from(submissions.values())
    .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime())
    .slice(0, 20);

  if (items.length === 0) return null;

  return (
    <div className="activity-feed">
      <div className="feed-header">
        <span className="feed-title">Live</span>
        <span className="feed-count">{items.length}</span>
      </div>

      <div className="feed-list">
        {items.map((sub) => (
          <button
            key={sub.id}
            className="feed-item"
            onClick={() => setFocusLocation([sub.lat, sub.lng])}
          >
            {/* Top row: favicon + domain + timestamp */}
            <div className="feed-card-top">
              <div className="feed-card-source">
                <img
                  src={`https://www.google.com/s2/favicons?domain=${sub.domain}&sz=32`}
                  className="feed-favicon"
                  alt=""
                  onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
                />
                <span className="feed-domain">{sub.domain}</span>
              </div>
              <span className="feed-time">{timeAgo(sub.updated_at)}</span>
            </div>

            {/* Bottom row: location + count badge */}
            <div className="feed-card-bottom">
              <span className="feed-location">
                {countryFlag(sub.country_code)} {sub.city}
              </span>
              {sub.count > 1 && (
                <span className="feed-badge">{sub.count}</span>
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
