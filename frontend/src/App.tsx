import { useState, useEffect, useRef } from "react";
import { MapView }         from "./components/MapView";
import { SubmitBar }       from "./components/SubmitBar";
import { ActivityFeed }    from "./components/ActivityFeed";
import { PinDropOverlay }  from "./components/PinDropOverlay";
import { usePinDrop }      from "./hooks/usePinDrop";
import { useSubmissionsStore } from "./store/submissionsStore";
import type { MapViewHandle }  from "./components/MapView";
import "./App.css";

export default function App() {
  const [submitted, setSubmitted] = useState(false);
  const [theme, setTheme]         = useState<"dark" | "light">("light");
  const rafRef                    = useRef<number | null>(null);
  const mapViewRef                = useRef<MapViewHandle | null>(null);
  const { state: pinState, triggerDrop } = usePinDrop(mapViewRef);

  const submissions = useSubmissionsStore((s) => s.submissions);
  const liveCount   = submissions.size;

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

  function toggleTheme() {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }

  function handleBoundsChange(b: { north: number; south: number; east: number; west: number }) {
    useSubmissionsStore.getState().setMapBounds?.(b);
  }

  return (
    <div className="app">
      {/* ── Ambient world layers ──────────────────────────── */}
      <div className="world-sky"       aria-hidden="true" />
      <div className="world-particles" aria-hidden="true" />

      {/* ── Header ──────────────────────────────────────── */}
      <header className="app-header">
        <span className="live-dot" />
        <span className="app-title">Now Reading</span>
        <span className="app-subtitle">
          {liveCount > 0 ? `${liveCount} live` : "live"}
        </span>
        <button
          className="theme-toggle"
          onClick={toggleTheme}
          aria-label="Toggle theme"
        >
          {theme === "dark" ? "☀︎" : "◗"}
        </button>
      </header>

      {/* ── Map + overlays ──────────────────────────────── */}
      <div className="map-container">
        <MapView
          ref={mapViewRef}
          theme={theme}
          onBoundsChange={handleBoundsChange}
        />
        <SubmitBar
          collapsed={submitted}
          onFirstSubmit={() => setSubmitted(true)}
          onPinDrop={triggerDrop}
        />
        {submitted && <ActivityFeed />}
      </div>

      {/* ── Pin drop overlay — above map, below header ─── */}
      <PinDropOverlay state={pinState} />
    </div>
  );
}
