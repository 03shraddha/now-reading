import { create } from "zustand";
import type { Submission } from "../types";
import type { MapBounds } from "../types";

interface SubmissionBanner {
  favicon_url: string;
  title: string;
  domain: string;
  city: string;
}


interface SubmissionsState {
  submissions:      Map<string, Submission>;
  focusLocation:    [number, number] | null;
  mapBounds:        MapBounds | null;
  mapZoom:          number;
  highlightedId:    string | null;
  hoveredUrl:       string | null;
  userPinId:        string | null;
  viewedLinks:      Set<string>;
  autoFollow:       boolean;

  upsertSubmission:  (s: Submission) => void;
  removeSubmission:  (id: string) => void;
  setFocusLocation: (loc: [number, number] | null) => void;
  setMapBounds:     (bounds: MapBounds | null) => void;
  setMapZoom:       (zoom: number) => void;
  setHighlightedId: (id: string | null) => void;
  setHoveredUrl:    (url: string | null) => void;
  setUserPinId:     (id: string | null) => void;
  markViewed:       (url: string) => void;
  setAutoFollow:    (on: boolean) => void;
  pruneOld:         () => void;

  submissionBanner: SubmissionBanner | null;
  setSubmissionBanner: (b: SubmissionBanner | null) => void;
  userSubmittedUrl: string | null;
  setUserSubmittedUrl: (url: string | null) => void;
  mobileSheetOpen: boolean;
  setMobileSheetOpen: (v: boolean) => void;
}

export const useSubmissionsStore = create<SubmissionsState>((set) => ({
  submissions:   new Map(),
  focusLocation: null,
  mapBounds:     null,
  mapZoom:       2,
  highlightedId: null,
  hoveredUrl:    null,
  userPinId:     null,
  viewedLinks:   new Set(),
  autoFollow:    false,
  submissionBanner: null,
  userSubmittedUrl: null,
  mobileSheetOpen: true,  // default open so links are visible on first load

  upsertSubmission: (s) =>
    set((state) => {
      const next = new Map(state.submissions);
      next.set(s.id, s);
      return { submissions: next };
    }),

  removeSubmission: (id) =>
    set((state) => {
      const next = new Map(state.submissions);
      next.delete(id);
      return { submissions: next };
    }),

  setFocusLocation: (loc) => set({ focusLocation: loc }),

  setMapBounds: (bounds) => set({ mapBounds: bounds }),
  setMapZoom:   (zoom)   => set({ mapZoom: zoom }),

  setHighlightedId: (id) => set({ highlightedId: id }),

  setHoveredUrl: (url) => set({ hoveredUrl: url }),

  setUserPinId: (id) => set({ userPinId: id }),

  markViewed: (url) =>
    set((state) => {
      const next = new Set(state.viewedLinks);
      next.add(url);
      return { viewedLinks: next };
    }),

  setAutoFollow: (on) => set({ autoFollow: on }),

  setSubmissionBanner: (b) => set({ submissionBanner: b }),
  setUserSubmittedUrl: (url) => set({ userSubmittedUrl: url }),
  setMobileSheetOpen: (v) => set({ mobileSheetOpen: v }),

  pruneOld: () => {}, // submissions are kept permanently
}));
