import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { PinDropPayload } from "../hooks/usePinDrop";
import { useSubmissionsStore } from "../store/submissionsStore";
import { apiUrl } from "../lib/api";

const PLACEHOLDERS = [
  "paste a news article…",
  "paste a blog post…",
  "paste a wikipedia page…",
  "paste a research paper…",
  "paste a goodreads book link…",
  "paste what you're reading…",
];

interface Metadata {
  title: string;
  description: string | null;
  domain: string;
  favicon_url: string;
}

interface Props {
  collapsed: boolean;
  onFirstSubmit: () => void;
  onPinDrop?: (payload: PinDropPayload) => void;
  heroText: string;
}

// ── Identity persistence ──────────────────────────────────────────────────
const IDENTITY_KEY = "globalmap_identity";
function loadIdentity(): { displayName: string; twitterHandle: string } {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY);
    if (!raw) return { displayName: "", twitterHandle: "" };
    const parsed = JSON.parse(raw);
    // Handle both the new object format and any legacy string format
    if (typeof parsed === "object" && parsed !== null) {
      return {
        displayName:    typeof parsed.displayName    === "string" ? parsed.displayName    : "",
        twitterHandle:  typeof parsed.twitterHandle  === "string" ? parsed.twitterHandle  : "",
      };
    }
    return { displayName: "", twitterHandle: "" };
  } catch { return { displayName: "", twitterHandle: "" }; }
}
function saveIdentity(displayName: string, twitterHandle: string) {
  localStorage.setItem(IDENTITY_KEY, JSON.stringify({ displayName, twitterHandle }));
}

// ── Co-reader helpers ─────────────────────────────────────────────────────

// Sites where co-reader info adds noise rather than delight (utility / social / shopping)
const UTILITY_DOMAINS = new Set([
  "google.com", "youtube.com", "amazon.com", "twitter.com", "x.com",
  "facebook.com", "instagram.com", "linkedin.com", "reddit.com",
  "gmail.com", "notion.so", "figma.com", "github.com",
]);

// Returns true if the URL looks like an article/book/post rather than a homepage or utility page.
// Heuristic: has at least one path segment containing letters (i.e. a slug, not just an ID).
function looksLikeArticle(normalizedUrl: string): boolean {
  try {
    const { hostname, pathname } = new URL(normalizedUrl);
    const domain = hostname.replace("www.", "");
    if (UTILITY_DOMAINS.has(domain)) return false;
    const segments = pathname.replace(/\/$/, "").split("/").filter(Boolean);
    if (segments.length === 0) return false;
    const last = segments[segments.length - 1];
    return /[a-zA-Z]{3,}/.test(last); // slug must have real words, not just IDs
  } catch { return false; }
}

function countryFlag(code: string): string {
  if (!code || code.length !== 2) return "";
  return String.fromCodePoint(
    ...code.toUpperCase().split("").map((c) => 127397 + c.charCodeAt(0))
  );
}

// Normalise a user-typed URL: add protocol, strip query params and fragment.
// This ensures "economist.com/article?utm_source=twitter#s2" and
// "economist.com/article" resolve to the same Firestore key.
function normalizeUrl(raw: string): string {
  const t = raw.trim();
  if (!t) return t;
  const withProtocol = /^https?:\/\//i.test(t) ? t : `https://${t}`;
  try {
    const parsed = new URL(withProtocol);
    // Strip query params and fragment — same article with ?utm_x= should match
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return withProtocol;
  }
}

// Returns true when the response is HTML — Render's cold-start wake-up page
async function isColdStart(res: Response): Promise<boolean> {
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("text/html")) return true;
  // Also catches cases where content-type is missing but body is HTML
  const text = await res.clone().text();
  return text.trimStart().startsWith("<");
}

// Fetch a short-lived HMAC token from the backend and keep it refreshed
function useSubmitToken() {
  const tokenRef    = useRef<string | null>(null);
  const expiresRef  = useRef<number>(0);

  const refresh = useCallback(async (attempt = 0) => {
    try {
      const res = await fetch(apiUrl("/api/token"));
      if (res.ok) {
        const data = await res.json();
        tokenRef.current  = data.token;
        expiresRef.current = Date.now() + (data.expires_in - 10) * 1000;
        return;
      }
    } catch {}
    // Retry up to 3 times with backoff (handles transient failures on page load)
    if (attempt < 3) {
      setTimeout(() => refresh(attempt + 1), 1000 * (attempt + 1));
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(() => {
      if (Date.now() >= expiresRef.current) refresh();
    }, 30_000);
    return () => clearInterval(id);
  }, [refresh]);

  return tokenRef;
}

export function SubmitBar({ collapsed, onFirstSubmit, onPinDrop, heroText }: Props) {
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<"idle" | "previewing" | "loading" | "success" | "error" | "waking">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [_submitCount, setSubmitCount] = useState(1);
  const [displayName,   setDisplayName]   = useState(() => loadIdentity().displayName);
  const [twitterHandle, setTwitterHandle] = useState(() => loadIdentity().twitterHandle);
  const [metadata, setMetadata] = useState<Metadata | null>(null);
  const [placeholderIdx, setPlaceholderIdx] = useState(0);
  const debounceRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heroBtnRef   = useRef<HTMLButtonElement>(null);
  const miniBtnRef   = useRef<HTMLButtonElement>(null);
  const tokenRef     = useSubmitToken();

  // Co-readers: others who already submitted the same URL
  const submissions  = useSubmissionsStore((s) => s.submissions);
  const normalizedUrl = normalizeUrl(url);
  const coReaders = useMemo(() => {
    if (status !== "previewing" || !looksLikeArticle(normalizedUrl)) return [];
    const seen = new Set<string>();
    const results: { city: string; flag: string }[] = [];
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - THIRTY_DAYS_MS;
    for (const sub of submissions.values()) {
      if (sub.url !== normalizedUrl || !sub.city) continue;
      // Skip stale submissions — someone who read 8 months ago isn't a co-reader
      if (sub.updated_at.getTime() < cutoff) continue;
      const key = `${sub.city}|${sub.country_code}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ city: sub.city, flag: countryFlag(sub.country_code) });
    }
    return results.slice(0, 4);
  }, [status, normalizedUrl, submissions]);

  // Cycle placeholder every 2 s (only when idle and empty)
  useEffect(() => {
    if (url || status !== "idle") return;
    const id = setInterval(() => {
      setPlaceholderIdx((i) => (i + 1) % PLACEHOLDERS.length);
    }, 2000);
    return () => clearInterval(id);
  }, [url, status]);

  // Debounced metadata fetch when URL changes
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const trimmed = normalizeUrl(url);
    if (!trimmed) {
      setMetadata(null);
      if (status === "previewing") setStatus("idle");
      return;
    }

    // Basic URL check before fetching
    try {
      const parsed = new URL(trimmed);
      if (!["http:", "https:"].includes(parsed.protocol)) return;
    } catch {
      setMetadata(null);
      if (status === "previewing") setStatus("idle");
      return;
    }

    debounceRef.current = setTimeout(async () => {
      try {
        const resp = await fetch(apiUrl(`/api/metadata?url=${encodeURIComponent(trimmed)}`));
        if (resp.ok) {
          const data: Metadata = await resp.json();
          setMetadata(data);
          setStatus("previewing");
        }
      } catch {}
    }, 200);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [url]); // intentionally omit status to avoid re-running on status changes

  useEffect(() => { saveIdentity(displayName, twitterHandle); }, [displayName, twitterHandle]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = normalizeUrl(url);
    if (!trimmed) return;

    try {
      const parsed = new URL(trimmed);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        setStatus("error");
        setErrorMsg("only http/https urls are allowed");
        return;
      }
    } catch {
      setStatus("error");
      setErrorMsg("that doesn't look like a valid url");
      return;
    }

    setStatus("loading");
    setErrorMsg("");

    // Request browser geolocation with a short timeout so it doesn't block submit.
    // If the user denies or it times out, coords stay null and the server falls back to IP.
    let coords: { lat: number; lng: number } | null = null;
    if ("geolocation" in navigator) {
      coords = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 4000);
        navigator.geolocation.getCurrentPosition(
          (pos) => { clearTimeout(timer); resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }); },
          ()    => { clearTimeout(timer); resolve(null); },
          { timeout: 4000, maximumAge: 5 * 60 * 1000 },
        );
      });
    }

    try {
      // If token is missing, try fetching it now (server may have been cold)
      if (!tokenRef.current) {
        const tokenRes = await fetch(apiUrl("/api/token"));
        if (await isColdStart(tokenRes)) {
          setStatus("waking");
          return;
        }
        if (tokenRes.ok) {
          const data = await tokenRes.json();
          tokenRef.current = data.token;
        }
      }

      const res = await fetch(apiUrl("/api/submit"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(tokenRef.current ? { "X-Submit-Token": tokenRef.current } : {}),
        },
        body: JSON.stringify({
          url:            trimmed,
          display_name:   displayName.trim() || null,
          twitter_handle: twitterHandle.trim().replace(/^@/, "") || null,
          ...(coords ? { lat: coords.lat, lng: coords.lng } : {}),
        }),
      });

      if (await isColdStart(res)) {
        setStatus("waking");
        return;
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || "submission failed");
      }

      const data = await res.json();
      setSubmitCount(data.count ?? 1);
      setStatus("success");
      setUrl("");
      setMetadata(null);

      // Mark this submission as the user's own pin (clears after 10 min)
      if (data.id) {
        useSubmissionsStore.getState().setUserPinId(data.id);
        setTimeout(() => useSubmissionsStore.getState().setUserPinId(null), 10 * 60 * 1000);
      }

      const bannerDomain = data.domain ?? metadata?.domain ?? new URL(trimmed).hostname.replace("www.", "");
      const resolvedTitle = data.title ?? metadata?.title ?? bannerDomain;
      const resolvedFavicon = data.favicon_url ?? metadata?.favicon_url ?? `https://www.google.com/s2/favicons?domain=${bannerDomain}&sz=32`;

      // Optimistically upsert into the submissions store so ActivityFeed shows the
      // correct title immediately, without waiting for the Firestore listener to deliver
      // the new doc + a secondary /api/metadata fetch.
      if (data.id) {
        useSubmissionsStore.getState().upsertSubmission({
          id:             data.id,
          url:            trimmed,
          domain:         bannerDomain,
          title:          resolvedTitle !== bannerDomain ? resolvedTitle : null,
          favicon_url:    resolvedFavicon,
          city:           data.city ?? "",
          country:        data.country ?? "",
          country_code:   data.country_code ?? "",
          lat:            data.lat,
          lng:            data.lng,
          count:          data.count ?? 1,
          updated_at:     new Date(),
          display_name:   displayName.trim() || null,
          twitter_handle: twitterHandle.trim().replace(/^@/, "") || null,
        });
      }

      // Set submission banner
      useSubmissionsStore.getState().setSubmissionBanner({
        favicon_url: resolvedFavicon,
        title:       resolvedTitle,
        domain:      bannerDomain,
        city:        data.city ?? "",
      });
      // Track submitted URL for sidebar filter (10 min)
      useSubmissionsStore.getState().setUserSubmittedUrl(trimmed);
      setTimeout(() => useSubmissionsStore.getState().setUserSubmittedUrl(null), 10 * 60 * 1000);

      // Fire pin drop animation — get button center as screen-space origin
      if (onPinDrop && data.lat != null && data.lng != null) {
        const btn  = collapsed ? miniBtnRef.current : heroBtnRef.current;
        const rect = btn?.getBoundingClientRect();
        onPinDrop({
          lat:     data.lat,
          lng:     data.lng,
          originX: rect ? rect.left + rect.width / 2  : window.innerWidth  / 2,
          originY: rect ? rect.top  + rect.height / 2 : window.innerHeight / 2,
          isFirst: !collapsed,
        });
      }

      // Notify ActivityFeed which URL belongs to this user
      window.dispatchEvent(new CustomEvent("user-submitted", { detail: trimmed }));

      onFirstSubmit();
      setTimeout(() => setStatus("idle"), 3000);
    } catch (err: any) {
      setStatus("error");
      setErrorMsg(err.message || "something went wrong");
    }
  }

  const placeholder = PLACEHOLDERS[placeholderIdx];
  const showPreview = status === "previewing" && metadata;
  const isWaking    = status === "waking";

  if (collapsed) {
    return (
      <div className="submit-mini-wrapper">
        {/* Prompt shown only on mobile via CSS */}
        <p className="submit-mini-prompt">{heroText}<span className="typewriter-cursor">|</span></p>
        <form onSubmit={handleSubmit} className="submit-mini-form">
          <input
            type="text"
            className="submit-mini-input"
            placeholder={placeholder}
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              if (status === "error") setStatus("idle");
            }}
            disabled={status === "loading"}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            ref={miniBtnRef}
            type="submit"
            className="submit-mini-btn"
            disabled={status === "loading" || !url.trim()}
          >
            {status === "loading" ? "…" : status === "success" ? "✓" : "share"}
          </button>
        </form>
        {status === "error" && <div className="submit-mini-error">{errorMsg}</div>}
        {coReaders.length > 0 && (
          <div className="mini-co-readers">
            join {coReaders.length} {coReaders.length === 1 ? "other" : "others"} →
            {coReaders.map((r, i) => (
              <span key={i} title={r.city}>{r.flag}</span>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Hero centered input (first load)
  return (
    <div className="submit-hero-wrapper">
      <div className="submit-hero-card">
        <button className="submit-hero-dismiss" onClick={onFirstSubmit} aria-label="Dismiss">×</button>
        <p className="submit-hero-eyebrow">
          {heroText}<span className="typewriter-cursor">|</span>
        </p>
        <form onSubmit={handleSubmit} className="submit-hero-form">
          <div className="submit-url-row">
            <input
              type="text"
              className="submit-hero-input"
              placeholder={placeholder}
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                if (status === "error" || status === "waking") setStatus("idle");
              }}
              disabled={status === "loading"}
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
            <button
              ref={heroBtnRef}
              type="submit"
              className="submit-hero-btn"
              disabled={status === "loading" || !url.trim()}
            >
              {status === "loading" ? "dropping pin…" : isWaking ? "try again" : showPreview ? "share to map" : "share"}
            </button>
          </div>
          <div className="submit-identity-row">
            <input
              type="text"
              className="submit-identity-input"
              placeholder="name (optional)"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={50}
              autoComplete="off"
              spellCheck={false}
            />
            <input
              type="text"
              className="submit-identity-input"
              placeholder="@twitter (optional)"
              value={twitterHandle}
              onChange={(e) => setTwitterHandle(e.target.value.replace(/^@+/, ""))}
              maxLength={16}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        </form>

        {showPreview && metadata && (
          <div className="submit-preview-card">
            <img
              src={metadata.favicon_url}
              className="preview-favicon"
              alt=""
              onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
            />
            <div className="preview-text">
              <span className="preview-title">{metadata.title}</span>
              <span className="preview-domain">{metadata.domain}</span>
            </div>
            {coReaders.length > 0 && (
              <div className="preview-co-readers">
                <span className="preview-co-readers__label">
                  join {coReaders.length} {coReaders.length === 1 ? "other" : "others"} →
                </span>
                {coReaders.map((r, i) => (
                  <span key={i} className="preview-co-reader-flag" title={r.city}>{r.flag}</span>
                ))}
              </div>
            )}
          </div>
        )}

        {status === "error" && <div className="submit-hero-error">{errorMsg}</div>}
        {status === "waking" && (
          <div className="submit-hero-error">
            server is waking up — please try again in ~30 seconds
          </div>
        )}
      </div>
    </div>
  );
}
