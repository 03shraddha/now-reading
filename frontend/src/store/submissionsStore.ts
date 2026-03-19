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

  // Reactions: url → count (real-time from Firestore link_reactions collection)
  reactions:        Map<string, number>;
  // URLs the current user has reacted to (persisted in localStorage)
  reactedUrls:      Set<string>;

  upsertSubmission:  (s: Submission) => void;
  removeSubmission:  (id: string) => void;
  setFocusLocation: (loc: [number, number] | null) => void;
  setMapBounds:     (bounds: MapBounds | null) => void;
  setMapZoom:       (zoom: number) => void;
  setHighlightedId: (id: string | null) => void;
  setHoveredUrl:    (url: string | null) => void;
  setUserPinId:     (id: string | null) => void;
  clearMyPin:       () => void;
  markViewed:       (url: string) => void;
  setAutoFollow:    (on: boolean) => void;
  pruneOld:         () => void;
  upsertReaction:   (url: string, count: number) => void;
  setReactedUrls:   (s: Set<string>) => void;

  submissionBanner: SubmissionBanner | null;
  setSubmissionBanner: (b: SubmissionBanner | null) => void;
  userSubmittedUrl: string | null;
  setUserSubmittedUrl: (url: string | null) => void;
  mobileSheetOpen: boolean;
  setMobileSheetOpen: (v: boolean) => void;
}

// Load user's previously reacted URLs from localStorage
function _loadReactedUrls(): Set<string> {
  try {
    const raw = localStorage.getItem("reactedUrls");
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch { /* ignore */ }
  return new Set();
}

// Persist the user's own submitted pin across sessions
const MY_PIN_KEY = "myPin";
function _loadMyPin(): { url: string | null; id: string | null } {
  try {
    const raw = localStorage.getItem(MY_PIN_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { url: null, id: null };
}
function _saveMyPin(url: string | null, id: string | null) {
  if (url && id) localStorage.setItem(MY_PIN_KEY, JSON.stringify({ url, id }));
  else localStorage.removeItem(MY_PIN_KEY);
}

export const useSubmissionsStore = create<SubmissionsState>((set) => ({
  submissions:   new Map(),
  focusLocation: null,
  mapBounds:     null,
  mapZoom:       2,
  highlightedId: null,
  hoveredUrl:    null,
  userPinId:     _loadMyPin().id,
  viewedLinks:   new Set(),
  autoFollow:    false,
  reactions:     new Map(),
  reactedUrls:   _loadReactedUrls(),
  submissionBanner: null,
  userSubmittedUrl: _loadMyPin().url,
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

  setUserPinId: (id) => {
    set((state) => { _saveMyPin(state.userSubmittedUrl, id); return { userPinId: id }; });
  },
  clearMyPin: () => { _saveMyPin(null, null); set({ userPinId: null, userSubmittedUrl: null }); },

  markViewed: (url) =>
    set((state) => {
      const next = new Set(state.viewedLinks);
      next.add(url);
      return { viewedLinks: next };
    }),

  setAutoFollow: (on) => set({ autoFollow: on }),

  upsertReaction: (url, count) =>
    set((state) => {
      const next = new Map(state.reactions);
      next.set(url, Math.max(0, count));
      return { reactions: next };
    }),

  setReactedUrls: (s) => set({ reactedUrls: s }),

  setSubmissionBanner: (b) => set({ submissionBanner: b }),
  setUserSubmittedUrl: (url) => {
    set((state) => { _saveMyPin(url, state.userPinId); return { userSubmittedUrl: url }; });
  },
  setMobileSheetOpen: (v) => set({ mobileSheetOpen: v }),

  pruneOld: () => {}, // submissions are kept permanently
}));
