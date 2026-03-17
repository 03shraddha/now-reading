import { create } from "zustand";
import type { Submission } from "../types";
import type { MapBounds } from "../types";

const MAX_AGE_MS = 30 * 60 * 1000;

interface SubmissionsState {
  submissions:      Map<string, Submission>;
  focusLocation:    [number, number] | null;
  mapBounds:        MapBounds | null;
  highlightedId:    string | null;
  viewedLinks:      Set<string>;
  autoFollow:       boolean;

  upsertSubmission: (s: Submission) => void;
  setFocusLocation: (loc: [number, number] | null) => void;
  setMapBounds:     (bounds: MapBounds | null) => void;
  setHighlightedId: (id: string | null) => void;
  markViewed:       (url: string) => void;
  setAutoFollow:    (on: boolean) => void;
  pruneOld:         () => void;
}

export const useSubmissionsStore = create<SubmissionsState>((set) => ({
  submissions:   new Map(),
  focusLocation: null,
  mapBounds:     null,
  highlightedId: null,
  viewedLinks:   new Set(),
  autoFollow:    false,

  upsertSubmission: (s) =>
    set((state) => {
      const next = new Map(state.submissions);
      next.set(s.id, s);
      return { submissions: next };
    }),

  setFocusLocation: (loc) => set({ focusLocation: loc }),

  setMapBounds: (bounds) => set({ mapBounds: bounds }),

  setHighlightedId: (id) => set({ highlightedId: id }),

  markViewed: (url) =>
    set((state) => {
      const next = new Set(state.viewedLinks);
      next.add(url);
      return { viewedLinks: next };
    }),

  setAutoFollow: (on) => set({ autoFollow: on }),

  pruneOld: () =>
    set((state) => {
      const cutoff = Date.now() - MAX_AGE_MS;
      const next = new Map(state.submissions);
      for (const [id, s] of next) {
        if (s.updated_at.getTime() < cutoff) next.delete(id);
      }
      return { submissions: next };
    }),
}));
