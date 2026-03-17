import { useEffect, useRef, forwardRef, useImperativeHandle } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "leaflet.markercluster/dist/MarkerCluster.Default.css";
import "leaflet.markercluster";
import "leaflet.heat";
import { useSubmissions } from "../hooks/useSubmissions";
import { useSubmissionsStore } from "../store/submissionsStore";
import type { Submission } from "../types";

// Track which submission each marker represents, for hover highlighting
const markerUrlMap = new Map<L.Marker, string>(); // marker → url

const INDIA_CENTER: L.LatLngTuple = [20.5937, 78.9629];
const DEFAULT_ZOOM = 5;

// ── Icon helpers ───────────────────────────────────────────────
// Scale = SIZE only, not color noise (PRD requirement)

function dotSize(count: number): number {
  if (count >= 20) return 22;
  if (count >= 6)  return 16;
  return 10;
}

function dotColor(count: number): "cool" | "warm" | "hot" {
  if (count >= 20) return "hot";
  if (count >= 6)  return "warm";
  return "cool";
}

// Special icon for the user's own drop — glowing indigo dot (no label, popup handles that)
function makeUserPinIcon() {
  return L.divIcon({
    className: "",
    html: `<div class="reading-dot reading-dot--user"></div>`,
    iconSize:   [20, 20],
    iconAnchor: [10, 10],
  });
}

// Build the card shown above the user's dropped pin
function buildUserDropPopupHtml(sub: Submission): string {
  const banner = useSubmissionsStore.getState().submissionBanner;
  const title     = banner?.title     ?? sub.domain;
  const favicon   = banner?.favicon_url ?? `https://www.google.com/s2/favicons?domain=${sub.domain}&sz=32`;
  const city      = banner?.city      ?? sub.city;
  return `<div class="user-drop-popup">
    <div class="user-drop-popup__label">your drop</div>
    <div class="user-drop-popup__header">
      <img src="${favicon}" class="user-drop-popup__favicon" onerror="this.style.display='none'" />
      <span class="user-drop-popup__domain">${sub.domain}</span>
    </div>
    <div class="user-drop-popup__title">${title}</div>
    <div class="user-drop-popup__city">📍 ${city}</div>
  </div>`;
}

// Dot marker — circle with optional pulse or highlight ring
function makeDotIcon(count: number, isNew: boolean, highlighted = false) {
  const size = highlighted ? dotSize(count) + 8 : dotSize(count);
  const color = dotColor(count);
  const pulseClass = isNew ? "reading-dot--pulse" : "";
  const highlightClass = highlighted ? "reading-dot--highlighted" : "";
  return L.divIcon({
    className: "",
    html: `<div class="reading-dot reading-dot--${color} ${pulseClass} ${highlightClass}"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function isRecent(sub: Submission): boolean {
  return Date.now() - sub.updated_at.getTime() < 5000;
}

// ── Rich popup HTML ────────────────────────────────────────────

async function buildRichPopup(sub: Submission): Promise<string> {
  let meta: { title: string; description: string | null; domain: string; favicon_url: string } = {
    title: sub.domain,
    description: null,
    domain: sub.domain,
    favicon_url: `https://www.google.com/s2/favicons?domain=${sub.domain}&sz=32`,
  };
  try {
    const resp = await fetch(`/api/metadata?url=${encodeURIComponent(sub.url)}`);
    if (resp.ok) meta = await resp.json();
  } catch {}

  return `<div class="map-popup">
    <div class="popup-header">
      <img src="${meta.favicon_url}" class="popup-favicon" onerror="this.style.display='none'" />
      <div class="popup-domain">${meta.domain}</div>
    </div>
    <div class="popup-title">${meta.title}</div>
    ${meta.description ? `<div class="popup-desc">${meta.description}</div>` : ""}
    <div class="popup-meta">
      <span class="popup-city">${sub.city}, ${sub.country}</span>
      <span class="popup-count">${sub.count} reading</span>
    </div>
    <a href="${sub.url}" target="_blank" rel="noopener noreferrer" class="popup-link">Open →</a>
  </div>`;
}

// ── Tile URLs ──────────────────────────────────────────────────
// Light: CartoDB Positron (cleaner, flatter fills — better base for anime filter)
// Dark:  CartoDB Dark Matter (deep indigo when filtered)

const TILE_URLS = {
  dark:  "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
  light: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
};

// ── Imperative handle ──────────────────────────────────────────

export interface MapViewHandle {
  lockPanning: () => void;
  unlockPanning: () => void;
  latLngToScreenPoint: (lat: number, lng: number) => { x: number; y: number } | null;
  flyToWithBias: (lat: number, lng: number) => void;
  getZoom: () => number;
}

// ── Props ──────────────────────────────────────────────────────

interface MapViewProps {
  theme: "dark" | "light";
  onZoomChange?: (zoom: number) => void;
  onBoundsChange?: (bounds: { north: number; south: number; east: number; west: number }) => void;
}

// ── Component ──────────────────────────────────────────────────

export const MapView = forwardRef<MapViewHandle, MapViewProps>(
function MapView({ theme, onZoomChange, onBoundsChange }, ref) {
  useSubmissions();

  const mapRef           = useRef<L.Map | null>(null);
  const containerRef     = useRef<HTMLDivElement>(null);
  const clusterGroupRef  = useRef<any | null>(null);
  const markersRef       = useRef<Map<string, L.Marker>>(new Map());
  const heatLayerRef     = useRef<L.Layer | null>(null);
  const tileLayerRef     = useRef<L.TileLayer | null>(null);
  const submissions      = useSubmissionsStore((s) => s.submissions);
  const submissionsRef   = useRef(submissions);
  submissionsRef.current = submissions;

  const setHoveredUrl    = useSubmissionsStore((s) => s.setHoveredUrl);
  const hoveredUrl       = useSubmissionsStore((s) => s.hoveredUrl);
  const userPinId        = useSubmissionsStore((s) => s.userPinId);
  const userPinIdRef     = useRef(userPinId);
  userPinIdRef.current   = userPinId;

  // Stable callback refs to avoid stale closures in map event handlers
  const onZoomChangeRef  = useRef(onZoomChange);
  const onBoundsChangeRef = useRef(onBoundsChange);
  onZoomChangeRef.current  = onZoomChange;
  onBoundsChangeRef.current = onBoundsChange;

  // ── Imperative handle for pin drop system ─────────────────────
  useImperativeHandle(ref, () => ({
    lockPanning: () => {
      mapRef.current?.dragging.disable();
      mapRef.current?.scrollWheelZoom.disable();
    },
    unlockPanning: () => {
      mapRef.current?.dragging.enable();
      mapRef.current?.scrollWheelZoom.enable();
    },
    latLngToScreenPoint: (lat: number, lng: number) => {
      if (!mapRef.current || !containerRef.current) return null;
      const pt   = mapRef.current.latLngToContainerPoint([lat, lng]);
      const rect = containerRef.current.getBoundingClientRect();
      return { x: rect.left + pt.x, y: rect.top + pt.y };
    },
    flyToWithBias: (lat: number, lng: number) => {
      if (!mapRef.current) return;
      const currentZoom = mapRef.current.getZoom();
      mapRef.current.flyTo([lat, lng], Math.max(currentZoom, 10), {
        animate: true, duration: 0.6,
      });
    },
    getZoom: () => mapRef.current?.getZoom() ?? DEFAULT_ZOOM,
  }));

  // ── Init map once ─────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const mapEl = containerRef.current;
    const map = L.map(mapEl, {
      center: INDIA_CENTER,
      zoom: DEFAULT_ZOOM,
      zoomControl: true,
    });

    tileLayerRef.current = L.tileLayer(TILE_URLS.dark, {
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/">CARTO</a>',
      subdomains: "abcd",
      maxZoom: 19,
    }).addTo(map);

    // Cluster group — minimal flat blobs, numeric only
    const clusterGroup = (L as any).markerClusterGroup({
      // At high zoom in dense cities, use a tighter radius so individual
      // points separate out instead of staying merged into one blob
      maxClusterRadius: (zoom: number) =>
        zoom < 4 ? 100 : zoom < 6 ? 70 : zoom < 8 ? 50 : zoom < 11 ? 30 : 18,
      showCoverageOnHover: false,
      iconCreateFunction: (cluster: any) => {
        const count = cluster.getChildCount();
        const size = count < 10 ? 36 : count < 50 ? 44 : 54;
        const cls  = count >= 50 ? "cluster-hot" : count >= 10 ? "cluster-warm" : "cluster-cool";
        return L.divIcon({
          html: `<div class="cluster-icon ${cls}" style="width:${size}px;height:${size}px">${count}</div>`,
          className: "",
          iconSize: [size, size],
          iconAnchor: [size / 2, size / 2],
        });
      },
    });

    // ── Cluster drill-down ──────────────────────────────────────
    // Clicking a large cluster (≥5 markers) flies to its bounds
    // instead of default expand, giving a "scene cut" into the region.
    clusterGroup.on("clusterclick", (e: any) => {
      const cluster = e.layer;
      const children: L.Marker[] = cluster.getAllChildMarkers();
      if (children.length < 5) return; // let small clusters zoom normally

      const lats = children.map((m) => m.getLatLng().lat);
      const lngs = children.map((m) => m.getLatLng().lng);
      const padding = (Math.max(...lats) - Math.min(...lats)) * 0.18;

      const bounds = L.latLngBounds(
        [Math.min(...lats) - padding, Math.min(...lngs) - padding],
        [Math.max(...lats) + padding, Math.max(...lngs) + padding]
      );
      // Snap fly — discrete, not floaty
      map.flyToBounds(bounds, { animate: true, duration: 0.5, maxZoom: 12 });
      e.originalEvent?.stopPropagation?.();
    });

    mapRef.current     = map;
    clusterGroupRef.current = clusterGroup;

    // ── Heat layer helpers ────────────────────────────────────
    function heatPoints(): Array<[number, number, number]> {
      return Array.from(submissionsRef.current.values()).map((s) => [
        s.lat, s.lng, Math.min(s.count / 20, 1),
      ]);
    }

    function updateLayerVisibility(zoom: number) {
      if (zoom < 5) {
        if (map.hasLayer(clusterGroup)) map.removeLayer(clusterGroup);
        if (heatLayerRef.current) {
          try { (heatLayerRef.current as any).setLatLngs(heatPoints()); } catch {}
        } else {
          heatLayerRef.current = (L as any).heatLayer(heatPoints(), {
            radius: 28, blur: 22, max: 1.0,
            gradient: {
              0.0: "rgba(90,200,216,0)",
              0.3: "#5AC8D8",
              0.65: "#E07B5F",
              1.0: "#E0546A",
            },
          });
          heatLayerRef.current!.addTo(map);
        }
      } else {
        if (heatLayerRef.current && map.hasLayer(heatLayerRef.current)) {
          map.removeLayer(heatLayerRef.current);
        }
        if (!map.hasLayer(clusterGroup)) map.addLayer(clusterGroup);
      }
    }

    updateLayerVisibility(DEFAULT_ZOOM);

    // ── Emit initial bounds ───────────────────────────────────
    const emitBounds = () => {
      const b = map.getBounds();
      onBoundsChangeRef.current?.({
        north: b.getNorth(), south: b.getSouth(),
        east:  b.getEast(),  west:  b.getWest(),
      });
    };
    emitBounds();
    onZoomChangeRef.current?.(DEFAULT_ZOOM);

    // ── Scene-cut: panning state on container ─────────────────
    // CSS dims tile pane and markers stay full opacity (parallax depth)
    map.on("movestart zoomstart", () => {
      mapEl.classList.add("map-panning");
    });
    map.on("moveend zoomend", () => {
      mapEl.classList.remove("map-panning");

      const zoom = map.getZoom();
      updateLayerVisibility(zoom);
      onZoomChangeRef.current?.(zoom);
      emitBounds();
    });

    return () => {
      map.remove();
      mapRef.current     = null;
      heatLayerRef.current = null;
    };
  }, []);

  // ── Sync markers when submissions change ──────────────────────
  useEffect(() => {
    const clusterGroup = clusterGroupRef.current;
    const map          = mapRef.current;
    if (!clusterGroup || !map) return;

    const currentIds = new Set(submissions.keys());

    for (const [id, sub] of submissions) {
      const existing = markersRef.current.get(id);
      if (!existing) {
        const isUserPin = id === userPinIdRef.current;
        const marker = L.marker([sub.lat, sub.lng], {
          icon: isUserPin ? makeUserPinIcon() : makeDotIcon(sub.count, isRecent(sub)),
        });
        marker.on("click", async () => {
          if (id === userPinIdRef.current) {
            marker.bindPopup(buildUserDropPopupHtml(sub), {
              className: "user-drop-leaflet-popup", closeButton: true, offset: [0, -14],
            }).openPopup();
          } else {
            const html = await buildRichPopup(sub);
            marker.bindPopup(html).openPopup();
          }
        });
        marker.on("mouseover", () => setHoveredUrl(sub.url));
        marker.on("mouseout",  () => setHoveredUrl(null));
        markerUrlMap.set(marker, sub.url);
        clusterGroup.addLayer(marker);
        markersRef.current.set(id, marker);

        // Auto-open card popup for the user's own pin
        if (isUserPin) {
          setTimeout(() => {
            marker.bindPopup(buildUserDropPopupHtml(sub), {
              className: "user-drop-leaflet-popup", closeButton: true, offset: [0, -14],
            }).openPopup();
          }, 300); // brief delay so map finishes flying first
        }

        // Remove pulse after animation completes (900ms)
        if (isRecent(sub) && !isUserPin) {
          setTimeout(() => {
            marker.setIcon(makeDotIcon(sub.count, false));
          }, 950);
        }
      } else {
        existing.setIcon(makeDotIcon(sub.count, false));
        existing.off("click");
        existing.on("click", async () => {
          const html = await buildRichPopup(sub);
          existing.bindPopup(html).openPopup();
        });
      }
    }

    for (const [id, marker] of markersRef.current) {
      if (!currentIds.has(id)) {
        clusterGroup.removeLayer(marker);
        markerUrlMap.delete(marker);
        markersRef.current.delete(id);
      }
    }

    if (heatLayerRef.current && mapRef.current?.hasLayer(heatLayerRef.current)) {
      const pts: Array<[number, number, number]> = Array.from(submissions.values()).map((s) => [
        s.lat, s.lng, Math.min(s.count / 20, 1),
      ]);
      try { (heatLayerRef.current as any).setLatLngs(pts); } catch {}
    }
  }, [submissions]);

  // ── Highlight markers when hoveredUrl changes ─────────────────
  useEffect(() => {
    for (const [marker, url] of markerUrlMap) {
      const sub = Array.from(submissionsRef.current.values()).find((s) => s.url === url);
      if (!sub) continue;
      if (sub.id === userPinIdRef.current) {
        marker.setIcon(makeUserPinIcon());
      } else {
        marker.setIcon(makeDotIcon(sub.count, false, url === hoveredUrl));
      }
    }
  }, [hoveredUrl]);

  // ── Re-render user's own pin when userPinId changes ───────────
  useEffect(() => {
    for (const [id, marker] of markersRef.current) {
      const sub = submissionsRef.current.get(id);
      if (!sub) continue;
      if (id === userPinId) {
        marker.setIcon(makeUserPinIcon());
        // Open card popup (marker already existed before userPinId was set)
        setTimeout(() => {
          marker.bindPopup(buildUserDropPopupHtml(sub), {
            className: "user-drop-leaflet-popup", closeButton: true, offset: [0, -14],
          }).openPopup();
        }, 300);
      } else {
        marker.setIcon(makeDotIcon(sub.count, false, false));
      }
    }
  }, [userPinId]);

  // ── Swap tile layer when theme changes ────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !tileLayerRef.current) return;
    map.removeLayer(tileLayerRef.current);
    tileLayerRef.current = L.tileLayer(TILE_URLS[theme], {
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/">CARTO</a>',
      subdomains: "abcd",
      maxZoom: 19,
    }).addTo(map);
  }, [theme]);

  // ── Pan/highlight on store focus ──────────────────────────────
  const focusLocation    = useSubmissionsStore((s) => s.focusLocation);
  const setFocusLocation = useSubmissionsStore((s) => s.setFocusLocation);

  useEffect(() => {
    if (!focusLocation || !mapRef.current) return;
    // Snap fly — shorter duration for scene-cut feel
    mapRef.current.flyTo(focusLocation, 10, { animate: true, duration: 0.6 });
    setFocusLocation(null);
  }, [focusLocation, setFocusLocation]);

  return (
    <div
      ref={containerRef}
      className="map-container-inner"
      style={{ width: "100%", height: "100%" }}
    />
  );
});
