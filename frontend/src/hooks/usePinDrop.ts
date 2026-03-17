import { useState, useCallback, useRef } from "react";
import type { RefObject } from "react";
import type { MapViewHandle } from "../components/MapView";

// ── Phase machine ──────────────────────────────────────────────
// idle → dropping → impact → focusing → revealing → staging → active
//                                                             ↓
//                                        closing ← (user/panel close)
//                                            ↓
//                                          idle

export type PinDropPhase =
  | "idle"
  | "dropping"   // travel particle in flight (0–280ms)
  | "impact"     // pin bounce + ripple (280–480ms)
  | "focusing"   // camera refocus + connector (480–700ms)
  | "revealing"  // panel slides in (700–900ms)
  | "staging"    // content staggers in (900–1100ms)
  | "active"     // fully settled
  | "closing";   // reversal symmetry

export interface PinDropPayload {
  lat: number;
  lng: number;
  originX: number; // screen X of submit button center
  originY: number; // screen Y of submit button center
  isFirst: boolean;
}

export interface PinDropState {
  phase: PinDropPhase;
  payload: PinDropPayload | null;
  targetX: number;
  targetY: number;
}

const INITIAL: PinDropState = {
  phase: "idle",
  payload: null,
  targetX: 0,
  targetY: 0,
};

export function usePinDrop(mapRef: RefObject<MapViewHandle | null>) {
  const [state, setState] = useState<PinDropState>(INITIAL);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };

  const schedule = (fn: () => void, delay: number) => {
    const t = setTimeout(fn, delay);
    timers.current.push(t);
  };

  // ── triggerDrop ──────────────────────────────────────────────
  const triggerDrop = useCallback(
    (payload: PinDropPayload) => {
      clearTimers();

      // Project lat/lng to screen coordinates before locking panning
      const pt = mapRef.current?.latLngToScreenPoint(payload.lat, payload.lng);
      const targetX = pt?.x ?? window.innerWidth / 2;
      const targetY = pt?.y ?? window.innerHeight / 2;

      // Lock map during drop so panning doesn't break spatial causality
      mapRef.current?.lockPanning();

      // Phase 1: dropping
      setState({ phase: "dropping", payload, targetX, targetY });

      // Phase 2: impact at 280ms — pin appears, ripple fires
      schedule(() => {
        setState((s) => ({ ...s, phase: "impact" }));

        // Phase 3: focusing at 380ms — camera refocuses, connector appears
        schedule(() => {
          mapRef.current?.flyToWithBias(payload.lat, payload.lng);
          setState((s) => ({ ...s, phase: "focusing" }));

          // Phase 4: revealing at 600ms — panel slides in
          schedule(() => {
            setState((s) => ({ ...s, phase: "revealing" }));

            // Phase 5: staging at 820ms — panel content staggers in
            schedule(() => {
              setState((s) => ({ ...s, phase: "staging" }));

              // Phase 6: active at 1100ms — fully settled
              schedule(() => {
                mapRef.current?.unlockPanning();
                setState((s) => ({ ...s, phase: "active" }));
              }, 280);
            }, 220);
          }, 220);
        }, 100);
      }, 280);
    },
    [mapRef]
  );

  // ── close — reversal symmetry ────────────────────────────────
  const close = useCallback(() => {
    clearTimers();
    setState((s) => ({ ...s, phase: "closing" }));

    // Panel slides out, camera returns, overlay pin fades — then reset
    schedule(() => {
      setState(INITIAL);
    }, 520);
  }, []);

  return { state, triggerDrop, close };
}
