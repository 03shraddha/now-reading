import { useEffect, useRef, forwardRef, useImperativeHandle } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "leaflet.markercluster/dist/MarkerCluster.Default.css";
import "leaflet.markercluster";
import { useSubmissions } from "../hooks/useSubmissions";
import { useReactions }   from "../hooks/useReactions";
import { useSubmissionsStore } from "../store/submissionsStore";
import { apiUrl } from "../lib/api";
import type { Submission } from "../types";
import { GlobeView3D } from "./GlobeView3D";

// Module-level title cache shared across all markers (survives re-renders)
const titleCache = new Map<string, string>(); // url → title

// Track which submission each marker represents, for hover highlighting
const markerUrlMap = new Map<L.Marker, string>(); // marker → url

const WORLD_CENTER: L.LatLngTuple = [22, 80]; // India
const DEFAULT_ZOOM = 5; // shows India + neighbours; user can zoom out to see global

// ── Icon helpers ───────────────────────────────────────────────
// Scale = SIZE only, not color noise (PRD requirement)

function dotSize(count: number): number {
  if (count >= 20) return 22;
  if (count >= 6)  return 16;
  return 14;
}

function dotColor(count: number): "cool" | "warm" | "hot" {
  if (count >= 20) return "hot";
  if (count >= 6)  return "warm";
  return "cool";
}

// Special icon for the user's own drop — label pill + glowing indigo dot
function makeUserPinIcon() {
  return L.divIcon({
    className: "",
    html: `<div class="user-pin-wrapper">
      <div class="user-pin-label">your pin</div>
      <div class="reading-dot reading-dot--user"></div>
    </div>`,
    iconSize:   [72, 52],
    iconAnchor: [36, 44],
  });
}

// Build the card shown above the user's dropped pin
function buildUserDropPopupHtml(sub: Submission): string {
  const banner = useSubmissionsStore.getState().submissionBanner;
  const title     = banner?.title     ?? sub.domain;
  const favicon   = banner?.favicon_url ?? `https://www.google.com/s2/favicons?domain=${sub.domain}&sz=32`;
  const city      = banner?.city      ?? sub.city;
  return `<div class="user-drop-popup">
    <div class="user-drop-popup__label">your pin</div>
    <div class="user-drop-popup__header">
      <img src="${favicon}" class="user-drop-popup__favicon" onerror="this.style.display='none'" />
      <span class="user-drop-popup__domain">${sub.domain}</span>
    </div>
    <div class="user-drop-popup__title">${title}</div>
    <div class="user-drop-popup__city">📍 ${city}</div>
  </div>`;
}

// Dot marker — circle with optional pulse or highlight ring.
// iconSize is kept at the visual dot size so dots don't overlap each other's hit areas.
// The extra tap area comes from .reading-dot::after { inset: -12px } in CSS.
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

// Encode characters that could break out of an HTML attribute (e.g. a malformed
// URL stored in Firestore containing a double-quote would close the href early).
function safeHref(url: string): string {
  return url.replace(/"/g, "%22").replace(/'/g, "%27").replace(/</g, "%3C").replace(/>/g, "%3E");
}

// Synchronous — uses data already stored in Firestore, no network call.
// Removing the async fetch eliminates the delay that caused "tap does nothing" on mobile.
function buildRichPopup(sub: Submission): string {
  const title   = sub.title || sub.domain;
  const favicon = sub.favicon_url || `https://www.google.com/s2/favicons?domain=${sub.domain}&sz=32`;
  const attribution = sub.twitter_handle
    ? ` · <a href="https://twitter.com/${sub.twitter_handle}" target="_blank" rel="noopener noreferrer" class="popup-attribution">@${sub.twitter_handle}</a>`
    : sub.display_name
      ? ` · <span class="popup-attribution popup-attribution--name">${sub.display_name}</span>`
      : "";

  return `<div class="map-popup">
    <div class="popup-header">
      <img src="${favicon}" class="popup-favicon" onerror="this.style.display='none'" />
      <div class="popup-domain">${sub.domain}</div>
    </div>
    <div class="popup-title">${title}</div>
    <div class="popup-meta">
      <span class="popup-city">${sub.city}, ${sub.country}${attribution}</span>
      <span class="popup-count">${sub.count} reading</span>
    </div>
    <a href="${safeHref(sub.url)}" target="_blank" rel="noopener noreferrer" class="popup-link">Open →</a>
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
  mode?: "2d" | "3d";
  onZoomChange?: (zoom: number) => void;
  onBoundsChange?: (bounds: { north: number; south: number; east: number; west: number }) => void;
}

// ── Component ──────────────────────────────────────────────────

export const MapView = forwardRef<MapViewHandle, MapViewProps>(
function MapView({ theme, mode = "2d", onZoomChange, onBoundsChange }, ref) {
  useSubmissions();
  useReactions();

  const mapRef           = useRef<L.Map | null>(null);
  const containerRef     = useRef<HTMLDivElement>(null);
  const clusterGroupRef  = useRef<any | null>(null);
  const markersRef       = useRef<Map<string, L.Marker>>(new Map());
  const tileLayerRef     = useRef<L.TileLayer | null>(null);
  const submissions      = useSubmissionsStore((s) => s.submissions);
  const submissionsRef   = useRef(submissions);
  submissionsRef.current = submissions;

  const setHoveredUrl    = useSubmissionsStore((s) => s.setHoveredUrl);
  const hoveredUrl       = useSubmissionsStore((s) => s.hoveredUrl);
  const userPinId        = useSubmissionsStore((s) => s.userPinId);
  const userPinIdRef     = useRef(userPinId);
  userPinIdRef.current   = userPinId;
  const globeApiRef      = useRef<MapViewHandle | null>(null);

  // Stable callback refs to avoid stale closures in map event handlers
  const onZoomChangeRef  = useRef(onZoomChange);
  const onBoundsChangeRef = useRef(onBoundsChange);
  onZoomChangeRef.current  = onZoomChange;
  onBoundsChangeRef.current = onBoundsChange;

  // ── Imperative handle for pin drop system ─────────────────────
  useImperativeHandle(ref, () => ({
    lockPanning: () => {
      if (mode === "3d") {
        globeApiRef.current?.lockPanning();
        return;
      }
      mapRef.current?.dragging.disable();
      mapRef.current?.scrollWheelZoom.disable();
    },
    unlockPanning: () => {
      if (mode === "3d") {
        globeApiRef.current?.unlockPanning();
        return;
      }
      mapRef.current?.dragging.enable();
      mapRef.current?.scrollWheelZoom.enable();
    },
    latLngToScreenPoint: (lat: number, lng: number) => {
      if (mode === "3d") {
        return globeApiRef.current?.latLngToScreenPoint(lat, lng) ?? null;
      }
      if (!mapRef.current || !containerRef.current) return null;
      const pt   = mapRef.current.latLngToContainerPoint([lat, lng]);
      const rect = containerRef.current.getBoundingClientRect();
      return { x: rect.left + pt.x, y: rect.top + pt.y };
    },
    flyToWithBias: (lat: number, lng: number) => {
      if (mode === "3d") {
        globeApiRef.current?.flyToWithBias(lat, lng);
        return;
      }
      if (!mapRef.current) return;
      const currentZoom = mapRef.current.getZoom();
      mapRef.current.flyTo([lat, lng], Math.max(currentZoom, 10), {
        animate: true, duration: 0.6,
      });
    },
    getZoom: () => {
      if (mode === "3d") return globeApiRef.current?.getZoom() ?? DEFAULT_ZOOM;
      return mapRef.current?.getZoom() ?? DEFAULT_ZOOM;
    },
  }), [mode]);

  // ── Init map once ─────────────────────────────────────────────
  useEffect(() => {
    if (mode !== "2d") return;
    if (!containerRef.current || mapRef.current) return;

    const mapEl = containerRef.current;
    const map = L.map(mapEl, {
      center: WORLD_CENTER,
      zoom: DEFAULT_ZOOM,
      minZoom: 2,       // prevents zooming out past world view where tiles leave blank edges
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

    // Always show the cluster group — dots/clusters visible at every zoom level
    function updateLayerVisibility(_zoom: number) {
      if (!map.hasLayer(clusterGroup)) map.addLayer(clusterGroup);
    }

    updateLayerVisibility(DEFAULT_ZOOM);

    // ── Emit initial bounds ───────────────────────────────────
    const emitBounds = () => {
      const b = map.getBounds();
      onBoundsChangeRef.current?.({
        north: b.getNorth(), south: b.getSouth(),
        east:  b.getEast(),  west:  b.getWest(),
      });
      useSubmissionsStore.getState().setMapZoom(map.getZoom());
    };
    emitBounds();
    onZoomChangeRef.current?.(DEFAULT_ZOOM);
    useSubmissionsStore.getState().setMapZoom(DEFAULT_ZOOM);

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

    // ── ResizeObserver: fix tile grid after layout changes ────────
    // When the hero card collapses to mini mode on submit, the map
    // container's height changes but Leaflet doesn't see it.
    // invalidateSize() re-computes the tile grid for the new dimensions.
    const ro = new ResizeObserver(() => {
      map.invalidateSize({ animate: false });
    });
    ro.observe(mapEl);

    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, [mode]);

  // ── Sync markers when submissions change ──────────────────────
  useEffect(() => {
    if (mode !== "2d") return;
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
        // Pre-bind popup so Leaflet opens it natively on click (reliable on mobile)
        if (!isUserPin) {
          marker.bindPopup(buildRichPopup(sub), { offset: [0, 0] });

          // Lazy-fetch title on first open if not stored (old submissions)
          marker.on("popupopen", () => {
            const needsFetch = !sub.title || sub.title === sub.domain;
            if (!needsFetch) return;
            // Already cached from a previous open
            if (titleCache.has(sub.url)) {
              marker.setPopupContent(buildRichPopup({ ...sub, title: titleCache.get(sub.url)! }));
              return;
            }
            fetch(apiUrl(`/api/metadata?url=${encodeURIComponent(sub.url)}`))
              .then((r) => r.ok ? r.json() : null)
              .then((data) => {
                if (data?.title && data.title !== sub.domain) {
                  titleCache.set(sub.url, data.title);
                  marker.setPopupContent(buildRichPopup({ ...sub, title: data.title }));
                }
              })
              .catch(() => {});
          });
        }
        marker.on("click", (e) => {
          L.DomEvent.stopPropagation(e);
          // Explicitly open popup — bindPopup's auto-open can silently fail
          // inside a MarkerCluster context after the cluster is spiderfied.
          marker.openPopup();
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
        // Don't override the user pin icon on count updates
        if (id !== userPinIdRef.current) {
          existing.setIcon(makeDotIcon(sub.count, false));
          existing.setPopupContent(buildRichPopup(sub));
        }
      }
    }

    for (const [id, marker] of markersRef.current) {
      if (!currentIds.has(id)) {
        clusterGroup.removeLayer(marker);
        markerUrlMap.delete(marker);
        markersRef.current.delete(id);
      }
    }

  }, [submissions, mode]);

  // ── Highlight markers when hoveredUrl changes ─────────────────
  useEffect(() => {
    if (mode !== "2d") return;
    for (const [marker, url] of markerUrlMap) {
      const sub = Array.from(submissionsRef.current.values()).find((s) => s.url === url);
      if (!sub) continue;
      if (sub.id === userPinIdRef.current) {
        marker.setIcon(makeUserPinIcon());
      } else {
        marker.setIcon(makeDotIcon(sub.count, false, url === hoveredUrl));
      }
    }
  }, [hoveredUrl, mode]);

  // ── Re-render user's own pin when userPinId changes ───────────
  useEffect(() => {
    if (mode !== "2d") return;
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
  }, [userPinId, mode]);

  // ── Swap tile layer when theme changes ────────────────────────
  useEffect(() => {
    if (mode !== "2d") return;
    const map = mapRef.current;
    if (!map || !tileLayerRef.current) return;
    map.removeLayer(tileLayerRef.current);
    tileLayerRef.current = L.tileLayer(TILE_URLS[theme], {
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/">CARTO</a>',
      subdomains: "abcd",
      maxZoom: 19,
    }).addTo(map);
  }, [theme, mode]);

  // ── Pan/highlight on store focus ──────────────────────────────
  const focusLocation    = useSubmissionsStore((s) => s.focusLocation);
  const setFocusLocation = useSubmissionsStore((s) => s.setFocusLocation);

  useEffect(() => {
    if (!focusLocation) return;
    if (mode === "3d") {
      globeApiRef.current?.flyToWithBias(focusLocation[0], focusLocation[1]);
      setFocusLocation(null);
      return;
    }
    if (!mapRef.current) return;
    mapRef.current.flyTo(focusLocation, 10, { animate: true, duration: 0.6 });
    setFocusLocation(null);
  }, [focusLocation, setFocusLocation, mode]);

  if (mode === "3d") {
    return (
      <GlobeView3D
        theme={theme}
        submissions={submissions}
        hoveredUrl={hoveredUrl}
        onHoverUrl={setHoveredUrl}
        focusLocation={focusLocation}
        onFocusConsumed={() => setFocusLocation(null)}
        onRegisterApi={(api) => {
          globeApiRef.current = api;
        }}
      />
    );
  }

  return (
    <div
      ref={containerRef}
      className="map-container-inner"
      style={{ width: "100%", height: "100%" }}
    />
  );
});
