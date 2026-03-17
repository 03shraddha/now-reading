import { useState, useEffect, useRef } from "react";
import { MapView }         from "./components/MapView";
import { SubmitBar }       from "./components/SubmitBar";
import { ActivityFeed }    from "./components/ActivityFeed";
import { PinDropOverlay }  from "./components/PinDropOverlay";
import { usePinDrop }      from "./hooks/usePinDrop";
import { useSubmissionsStore } from "./store/submissionsStore";
import { useSyncedTypewriters } from "./hooks/useTypewriter";
import type { MapViewHandle }  from "./components/MapView";
import "./App.css";

// Must be same length — paired phrases advance together in sync
const TAGLINE_PHRASES = [
  "share what you're reading & discover what others are reading around the world",
  "drop a link. see the world read.",
  "what's everyone reading right now?",
  "discover what the world is reading",
];

const HERO_PHRASES = [
  "what are you reading right now?",
  "share a link, drop a pin :)",
  "reading anything good lately?",
  "share what you're reading",
];

function SubmissionBanner() {
  const banner             = useSubmissionsStore((s) => s.submissionBanner);
  const setSubmissionBanner = useSubmissionsStore((s) => s.setSubmissionBanner);

  useEffect(() => {
    if (!banner) return;
    const id = setTimeout(() => setSubmissionBanner(null), 30_000);
    return () => clearTimeout(id);
  }, [banner, setSubmissionBanner]);

  if (!banner) return null;

  return (
    <div className="submission-banner">
      <img src={banner.favicon_url} className="submission-banner__favicon" alt=""
        onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />
      <span className="submission-banner__title">{banner.title}</span>
      <span className="submission-banner__sep">·</span>
      <span className="submission-banner__domain">{banner.domain}</span>
      {banner.city && (<><span className="submission-banner__sep">·</span>
        <span className="submission-banner__city">dropped in {banner.city}</span></>)}
      <button className="submission-banner__dismiss" onClick={() => setSubmissionBanner(null)}>×</button>
    </div>
  );
}

export default function App() {
  const [submitted, setSubmitted] = useState(false);
  const [theme, setTheme]         = useState<"dark" | "light">("light");
  const rafRef                    = useRef<number | null>(null);
  const mapViewRef                = useRef<MapViewHandle | null>(null);
  const { state: pinState, triggerDrop } = usePinDrop(mapViewRef);

  const submissions        = useSubmissionsStore((s) => s.submissions);
  const liveCount          = submissions.size;
  const submissionBanner   = useSubmissionsStore((s) => s.submissionBanner);
  const mobileSheetOpen    = useSubmissionsStore((s) => s.mobileSheetOpen);
  const setMobileSheetOpen = useSubmissionsStore((s) => s.setMobileSheetOpen);

  // Collapse feed while hero card is showing so they don't overlap.
  // Expand it once the hero is dismissed.
  useEffect(() => {
    setMobileSheetOpen(submitted);
  }, [submitted, setMobileSheetOpen]);

  // Sync theme attribute for CSS overrides
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // ── Cursor parallax ──────────────────────────────────────────
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        const x = (e.clientX / window.innerWidth  - 0.5);
        const y = (e.clientY / window.innerHeight - 0.5);
        const root = document.documentElement;
        root.style.setProperty("--px", String(x));
        root.style.setProperty("--py", String(y));
      });
    };
    window.addEventListener("mousemove", handleMouseMove, { passive: true });
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const [tagline, heroText] = useSyncedTypewriters(TAGLINE_PHRASES, HERO_PHRASES, { typeSpeed: 40, deleteSpeed: 20, pauseAfter: 2200 });

  function toggleTheme() {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }

  function handleBoundsChange(b: { north: number; south: number; east: number; west: number }) {
    useSubmissionsStore.getState().setMapBounds?.(b);
  }

  return (
    <div className={`app${submissionBanner ? " app--banner" : ""}`}>
      {/* ── Ambient world layers ──────────────────────────── */}
      <div className="world-sky"       aria-hidden="true" />
      <div className="world-particles" aria-hidden="true" />

      {/* ── Header ──────────────────────────────────────── */}
      <header className="app-header">
        <span className="live-dot" />
        <span className="app-title">now reading</span>
        <span className="app-tagline">{tagline}<span className="typewriter-cursor">|</span></span>
        <span className="app-subtitle">
          {liveCount > 0 ? `${liveCount} live` : "live"}
        </span>
        <button
          className="theme-toggle"
          onClick={toggleTheme}
          aria-label="Toggle theme"
        >
          {theme === "dark" ? "☀️" : "🌙"}
        </button>
      </header>
      <SubmissionBanner />

      {/* ── Map + overlays ──────────────────────────────── */}
      <div className={`map-container${mobileSheetOpen ? " map-container--sheet-open" : ""}`}>
        <MapView
          ref={mapViewRef}
          theme={theme}
          onBoundsChange={handleBoundsChange}
        />
        <SubmitBar
          collapsed={submitted}
          onFirstSubmit={() => setSubmitted(true)}
          onPinDrop={triggerDrop}
          heroText={heroText}
        />
        <ActivityFeed />
      </div>

      {/* ── Pin drop overlay — above map, below header ─── */}
      <PinDropOverlay state={pinState} />
    </div>
  );
}
