import type React from "react";
import type { PinDropState } from "../hooks/usePinDrop";

interface Props {
  state: PinDropState;
}

// "active" is intentionally excluded — by then the real Leaflet marker is
// visible and tracks the map. The overlay pin would drift on zoom/pan.
const ACTIVE_PHASES = new Set(["impact", "focusing", "revealing", "staging"]);

export function PinDropOverlay({ state }: Props) {
  const { phase, payload, targetX, targetY } = state;

  if (!payload || phase === "idle") return null;

  const { originX, originY } = payload;
  const dx = targetX - originX;
  const dy = targetY - originY;

  const showParticle  = phase === "dropping";
  const showPin       = ACTIVE_PHASES.has(phase) || phase === "closing";
  const showRipple    = phase === "impact" || phase === "focusing";
  const showConnector = phase === "focusing" || phase === "revealing" || phase === "staging";
  const isActive      = phase === "active";
  const isClosing     = phase === "closing";

  return (
    <div className="pin-drop-overlay" aria-hidden="true">
      {/* Travel particle — fires from button to geo target */}
      {showParticle && (
        <div
          className="pin-particle"
          style={{ left: originX, top: originY, "--dx": `${dx}px`, "--dy": `${dy}px` } as unknown as React.CSSProperties}
        />
      )}

      {/* Impact pin at geo target — diamond shape, same language as markers */}
      {showPin && (
        <div
          className={`pin-target${isActive ? " pin-target--active" : ""}${isClosing ? " pin-target--closing" : ""}`}
          style={{ left: targetX, top: targetY }}
        />
      )}

      {/* Contact ripple — expands from impact point */}
      {showRipple && (
        <div
          key={`ripple-${phase}`}
          className="pin-ripple"
          style={{ left: targetX, top: targetY }}
        />
      )}

      {/* Directional connector — thin glow from pin toward panel */}
      {showConnector && (
        <div
          className="pin-connector"
          style={{ left: targetX, top: targetY }}
        />
      )}
    </div>
  );
}
