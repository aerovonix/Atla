import { create } from "zustand";

interface BrowserUIStore {
  open: boolean;
  /** Set by the panel so other components can show the current page. */
  currentUrl: string;
  currentTitle: string;
  loading: boolean;
  blocked: number;
  /**
   * A URL something outside the panel wants opened — a tool card's "Open in
   * browser", for instance. The panel picks it up and clears it.
   */
  requestedUrl: string | null;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  setPage: (url: string, title: string) => void;
  setLoading: (loading: boolean) => void;
  setBlocked: (n: number) => void;
  requestNavigate: (url: string) => void;
  consumeRequestedUrl: () => void;
}

export const useBrowserStore = create<BrowserUIStore>((set) => ({
  open: false,
  currentUrl: "",
  currentTitle: "",
  loading: false,
  blocked: 0,
  requestedUrl: null,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
  setPage: (currentUrl, currentTitle) => set({ currentUrl, currentTitle }),
  setLoading: (loading) => set({ loading }),
  setBlocked: (blocked) => set({ blocked }),
  requestNavigate: (requestedUrl) => set({ requestedUrl, open: true }),
  consumeRequestedUrl: () => set({ requestedUrl: null })
}));
