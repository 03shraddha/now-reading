import { useState, useEffect, useRef } from "react";
import type { PinDropPayload } from "../hooks/usePinDrop";

const PLACEHOLDERS = [
  "Paste a news article…",
  "Paste a blog post…",
  "Paste a Wikipedia page…",
  "Paste a research paper…",
  "Paste what you're reading…",
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
}

export function SubmitBar({ collapsed, onFirstSubmit, onPinDrop }: Props) {
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<"idle" | "previewing" | "loading" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [submitCount, setSubmitCount] = useState(1);
  const [metadata, setMetadata] = useState<Metadata | null>(null);
  const [placeholderIdx, setPlaceholderIdx] = useState(0);
  const debounceRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heroBtnRef   = useRef<HTMLButtonElement>(null);
  const miniBtnRef   = useRef<HTMLButtonElement>(null);

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
        const resp = await fetch(`/api/metadata?url=${encodeURIComponent(trimmed)}`);
        if (resp.ok) {
          const data: Metadata = await resp.json();
          setMetadata(data);
          setStatus("previewing");
        }
      } catch {}
    }, 500);

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
        setErrorMsg("Only http/https URLs are allowed");
        return;
      }
    } catch {
      setStatus("error");
      setErrorMsg("That doesn't look like a valid URL");
      return;
    }

    setStatus("loading");
    setErrorMsg("");

    try {
      const res = await fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: trimmed }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || "Submission failed");
      }

      const data = await res.json();
      setSubmitCount(data.count ?? 1);
      setStatus("success");
      setUrl("");
      setMetadata(null);

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

      onFirstSubmit();
      setTimeout(() => setStatus("idle"), 3000);
    } catch (err: any) {
      setStatus("error");
      setErrorMsg(err.message || "Something went wrong");
    }
  }

  const placeholder = PLACEHOLDERS[placeholderIdx];
  const showPreview = status === "previewing" && metadata;

  if (collapsed) {
    // Mini pill in bottom-right corner
    return (
      <div className="submit-mini-wrapper">
        <form onSubmit={handleSubmit} className="submit-mini-form">
          <input
            type="text"
            className="submit-mini-input"
            placeholder="Paste a URL…"
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
        {status === "success" && (
          <div className="submit-mini-success">
            {submitCount > 1 ? `🔥 ${submitCount} reading this` : "On the map!"}
          </div>
        )}
      </div>
    );
  }

  // Hero centered input (first load)
  return (
    <div className="submit-hero-wrapper">
      <div className="submit-hero-card">
        <p className="submit-hero-eyebrow">What are you reading right now?</p>
        <form onSubmit={handleSubmit} className="submit-hero-form">
          <input
            type="text"
            className="submit-hero-input"
            placeholder={placeholder}
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              if (status === "error") setStatus("idle");
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
            {status === "loading" ? "Dropping pin…" : showPreview ? "Share to map" : "Share"}
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
        {status === "success" && (
          <div className="submit-hero-success">
            {submitCount > 1 ? `🔥 ${submitCount} people reading this` : "You're on the map!"}
          </div>
        )}
      </div>
    </div>
  );
}
