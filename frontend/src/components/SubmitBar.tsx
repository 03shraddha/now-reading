import { useState, useEffect, useRef, useCallback } from "react";
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

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(apiUrl("/api/token"));
      if (res.ok) {
        const data = await res.json();
        tokenRef.current  = data.token;
        expiresRef.current = Date.now() + (data.expires_in - 10) * 1000; // 10s early refresh
      }
    } catch {}
  }, []);

  useEffect(() => {
    refresh();
    // Re-fetch slightly before the token window closes
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
  const [metadata, setMetadata] = useState<Metadata | null>(null);
  const [placeholderIdx, setPlaceholderIdx] = useState(0);
  const debounceRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heroBtnRef   = useRef<HTMLButtonElement>(null);
  const miniBtnRef   = useRef<HTMLButtonElement>(null);
  const tokenRef     = useSubmitToken();

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

    const trimmed = url.trim();
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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = url.trim();
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
        body: JSON.stringify({ url: trimmed }),
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

      // Set submission banner — prefer API response fields (backend now stores title/favicon),
      // then fall back to prefetched metadata, then to generic fallbacks
      const bannerDomain = data.domain ?? metadata?.domain ?? new URL(trimmed).hostname.replace("www.", "");
      useSubmissionsStore.getState().setSubmissionBanner({
        favicon_url: data.favicon_url ?? metadata?.favicon_url ?? `https://www.google.com/s2/favicons?domain=${bannerDomain}&sz=32`,
        title: data.title ?? metadata?.title ?? bannerDomain,
        domain: bannerDomain,
        city: data.city ?? "",
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
    // Mini pill in bottom-right corner
    return (
      <div className="submit-mini-wrapper">
        <form onSubmit={handleSubmit} className="submit-mini-form">
          <input
            type="text"
            className="submit-mini-input"
            placeholder="paste a url…"
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
            {status === "loading" ? "…" : status === "success" ? "✓" : "+"}
          </button>
        </form>
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
