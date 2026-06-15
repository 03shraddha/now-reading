import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DeckGL } from "@deck.gl/react";
import { _GlobeView as GlobeView } from "@deck.gl/core";
import { BitmapLayer, ScatterplotLayer, SolidPolygonLayer } from "@deck.gl/layers";
import type { Submission } from "../types";
import type { MapViewHandle } from "./MapView";
import { apiUrl } from "../lib/api";

type ThemeMode = "dark" | "light";

interface GlobeView3DProps {
  theme: ThemeMode;
  submissions: Map<string, Submission>;
  hoveredUrl: string | null;
  onHoverUrl: (url: string | null) => void;
  focusLocation: [number, number] | null;
  onFocusConsumed: () => void;
  onRegisterApi: (api: MapViewHandle) => void;
}

const INITIAL_VIEW_STATE = {
  longitude: 80,
  latitude: 22,
  zoom: 1.45,
  minZoom: 0.6,
  maxZoom: 7,
};

const EARTH_IMAGE_URL =
  "https://raw.githubusercontent.com/chrisrzhou/react-globe/main/textures/globe.jpg";
const GLOBE_BOUNDS: [number, number, number, number] = [-180, -90, 180, 90];
const LIGHT_BG = [250, 249, 247, 255] as [number, number, number, number];
const DARK_BG = [7, 8, 14, 255] as [number, number, number, number];
const titleCache = new Map<string, string>(); // url -> title

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpLng(from: number, to: number, t: number): number {
  let d = to - from;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return from + d * t;
}

function safeHref(url: string): string {
  return url
    .replace(/"/g, "%22")
    .replace(/'/g, "%27")
    .replace(/</g, "%3C")
    .replace(/>/g, "%3E");
}

export function GlobeView3D({
  theme,
  submissions,
  hoveredUrl,
  onHoverUrl,
  focusLocation,
  onFocusConsumed,
  onRegisterApi,
}: GlobeView3DProps) {
  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
  const [globeError, setGlobeError] = useState<string | null>(null);
  const viewStateRef = useRef(viewState);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const autoRotateRef = useRef(true);
  const rotateRafRef = useRef<number | null>(null);
  const flyRafRef = useRef<number | null>(null);
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  const [popupTitle, setPopupTitle] = useState<string | null>(null);
  const [popupPos, setPopupPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    viewStateRef.current = viewState;
  }, [viewState]);

  useEffect(() => {
    const tick = () => {
      setViewState((prev) => {
        if (!autoRotateRef.current) return prev;
        return { ...prev, longitude: prev.longitude + 0.06 };
      });
      rotateRafRef.current = requestAnimationFrame(tick);
    };
    rotateRafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rotateRafRef.current != null) cancelAnimationFrame(rotateRafRef.current);
    };
  }, []);

  useEffect(() => {
    if (!focusLocation) return;
    autoRotateRef.current = false;
    const [lat, lng] = focusLocation;
    const start = viewStateRef.current;
    const startTime = performance.now();
    const durationMs = 900;
    const endZoom = Math.max(start.zoom, 2.6);

    const tick = () => {
      const progress = Math.min((performance.now() - startTime) / durationMs, 1);
      setViewState((prev) => ({
        ...prev,
        longitude: lerpLng(start.longitude, lng, progress),
        latitude: lerp(start.latitude, lat, progress),
        zoom: lerp(start.zoom, endZoom, progress),
      }));
      if (progress < 1) {
        flyRafRef.current = requestAnimationFrame(tick);
      } else {
        onFocusConsumed();
      }
    };
    flyRafRef.current = requestAnimationFrame(tick);
    return () => {
      if (flyRafRef.current != null) cancelAnimationFrame(flyRafRef.current);
    };
  }, [focusLocation, onFocusConsumed]);

  const selectedSubmission = useMemo(() => {
    if (!selectedUrl) return null;
    for (const sub of submissions.values()) {
      if (sub.url === selectedUrl) return sub;
    }
    return null;
  }, [selectedUrl, submissions]);

  useEffect(() => {
    if (!selectedSubmission) return;
    const fallbackTitle = selectedSubmission.title || selectedSubmission.domain;
    setPopupTitle(fallbackTitle);

    if (selectedSubmission.title && selectedSubmission.title !== selectedSubmission.domain) return;
    if (titleCache.has(selectedSubmission.url)) {
      setPopupTitle(titleCache.get(selectedSubmission.url) ?? fallbackTitle);
      return;
    }

    fetch(apiUrl(`/api/metadata?url=${encodeURIComponent(selectedSubmission.url)}`))
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data?.title) return;
        titleCache.set(selectedSubmission.url, data.title);
        setPopupTitle(data.title);
      })
      .catch(() => {});
  }, [selectedSubmission]);

  useEffect(() => {
    const api: MapViewHandle = {
      lockPanning: () => {
        autoRotateRef.current = false;
      },
      unlockPanning: () => {
        autoRotateRef.current = true;
      },
      latLngToScreenPoint: (lat: number, lng: number) => {
        const el = containerRef.current;
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        const vs = viewStateRef.current;
        const relativeLng = (((lng - vs.longitude) % 360) + 540) % 360 - 180;
        const relativeLat = lat - vs.latitude;
        const x = rect.left + rect.width / 2 + (relativeLng / 180) * (rect.width * 0.44);
        const y = rect.top + rect.height / 2 - (relativeLat / 90) * (rect.height * 0.44);
        return { x, y };
      },
      flyToWithBias: (lat: number, lng: number) => {
        autoRotateRef.current = false;
        setViewState((prev) => ({
          ...prev,
          longitude: lng,
          latitude: lat,
          zoom: Math.max(prev.zoom, 2.6),
        }));
      },
      getZoom: () => viewStateRef.current.zoom,
    };
    onRegisterApi(api);
  }, [onRegisterApi]);

  const points = useMemo(() => Array.from(submissions.values()), [submissions]);

  const layers = useMemo(() => {
    const markerBase = (theme === "dark"
      ? [120, 108, 246, 210]
      : [106, 90, 249, 215]) as [number, number, number, number];
    const markerHighlight = [224, 84, 106, 245] as [number, number, number, number];
    const markerUser = [78, 184, 150, 245] as [number, number, number, number];
    const bgColor = theme === "dark" ? DARK_BG : LIGHT_BG;

    const globeSurface = new SolidPolygonLayer({
      id: "globe-surface",
      data: [[[-180, 90], [0, 90], [180, 90], [180, -90], [0, -90], [-180, -90]]],
      getPolygon: (d) => d,
      getFillColor: bgColor,
      stroked: false,
      filled: true,
    });

    const earthMap = new BitmapLayer({
      id: "earth-map",
      image: EARTH_IMAGE_URL,
      bounds: GLOBE_BOUNDS,
      pickable: false,
    });

    const pointsLayer = new ScatterplotLayer<Submission>({
      id: "reading-points",
      data: points,
      pickable: true,
      getPosition: (d) => [d.lng, d.lat],
      radiusMinPixels: 3,
      radiusMaxPixels: 20,
      getRadius: (d) => 70000 + Math.min(9, d.count) * 9000,
      getFillColor: (d) => {
        if (d.id === hoveredUrl) return markerHighlight;
        if (d.count >= 8) return markerUser;
        return markerBase;
      },
    });

    return [globeSurface, earthMap, pointsLayer];
  }, [points, hoveredUrl, theme]);

  const handleHover = useCallback(
    (info: { object?: Submission | null }) => {
      onHoverUrl(info.object?.url ?? null);
    },
    [onHoverUrl],
  );

  const handleClick = useCallback(
    (info: { object?: Submission | null; x: number; y: number }) => {
      if (!info.object) {
        setSelectedUrl(null);
        return;
      }

      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const margin = 18;
      const popupWidth = 260;
      const popupHeight = 160;

      const x = Math.max(margin, Math.min(info.x + 14, rect.width - popupWidth - margin));
      const y = Math.max(margin, Math.min(info.y - 12, rect.height - popupHeight - margin));

      setPopupPos({ x, y });
      setSelectedUrl(info.object.url);
      setPopupTitle(info.object.title || info.object.domain);
      autoRotateRef.current = false;
    },
    [],
  );

  const selectedTitle = popupTitle || selectedSubmission?.title || selectedSubmission?.domain || "";
  const attribution = selectedSubmission?.twitter_handle
    ? `@${selectedSubmission.twitter_handle}`
    : selectedSubmission?.display_name || null;

  if (globeError) {
    return (
      <div ref={containerRef} className="map-container-inner globe-container" style={{ width: "100%", height: "100%" }}>
        <div className="globe-popup-card" style={{ left: "20px", top: "20px", maxWidth: "320px" }} role="status" aria-live="polite">
          <div className="map-popup">
            <div className="popup-title">3D globe is unavailable on this browser/device.</div>
            <div className="popup-meta">
              <span className="popup-city">{globeError}</span>
            </div>
            <div className="popup-link" style={{ pointerEvents: "none", opacity: 0.65 }}>
              Switch back to 2D to continue
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="map-container-inner globe-container" style={{ width: "100%", height: "100%" }}>
      <DeckGL
        views={[new GlobeView({ id: "globe" })]}
        controller={{
          dragRotate: true,
          touchRotate: true,
          inertia: true,
          scrollZoom: true,
          doubleClickZoom: true,
        }}
        viewState={{ globe: viewState }}
        onViewStateChange={({ viewState: vs }) => {
          // DeckGL can return either keyed or direct viewState objects depending on config/runtime.
          const keyed = (vs as { globe?: typeof INITIAL_VIEW_STATE }).globe;
          const next = keyed ?? (vs as typeof INITIAL_VIEW_STATE);
          if (next && typeof next.longitude === "number") {
            setViewState(next);
          }
        }}
        onDragStart={() => {
          autoRotateRef.current = false;
        }}
        onHover={handleHover}
        onClick={handleClick}
        layers={layers}
        width="100%"
        height="100%"
        useDevicePixels={false}
        deviceProps={{
          type: "webgl",
          webgl: { alpha: true, premultipliedAlpha: false },
        }}
        onError={(error) => {
          setGlobeError(error?.message || "Unable to initialize graphics device.");
        }}
        getTooltip={({ object }) =>
          object && "domain" in object
            ? { text: `${(object as Submission).domain} (${(object as Submission).city})` }
            : null
        }
      />
      {selectedSubmission && popupPos && (
        <div
          className="globe-popup-card"
          style={{ left: `${popupPos.x}px`, top: `${popupPos.y}px` }}
          role="dialog"
          aria-label="Reading details"
        >
          <button
            type="button"
            className="globe-popup-close"
            onClick={() => setSelectedUrl(null)}
            aria-label="Close"
          >
            ×
          </button>
          <div className="map-popup">
            <div className="popup-header">
              <img
                src={selectedSubmission.favicon_url || `https://www.google.com/s2/favicons?domain=${selectedSubmission.domain}&sz=32`}
                className="popup-favicon"
                onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
              />
              <div className="popup-domain">{selectedSubmission.domain}</div>
            </div>
            <div className="popup-title">{selectedTitle}</div>
            <div className="popup-meta">
              <span className="popup-city">
                {selectedSubmission.city}, {selectedSubmission.country}
                {attribution ? ` · ${attribution}` : ""}
              </span>
              <span className="popup-count">{selectedSubmission.count} reading</span>
            </div>
            <a
              href={safeHref(selectedSubmission.url)}
              target="_blank"
              rel="noopener noreferrer"
              className="popup-link"
            >
              Open →
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
