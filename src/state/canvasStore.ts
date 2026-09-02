import { create } from "zustand";

/**
 * The canvas: files opened side by side with the chat, editable by hand.
 *
 * Tabs are keyed by absolute path, so the model editing a file the user
 * already has open lands in the same tab rather than opening a second copy of
 * it. `baseline` is what was last known to be on disk; comparing against it is
 * how a tab knows it's dirty, and how an outside change is detected before a
 * save quietly overwrites it.
 */

export interface CanvasTab {
  path: string;
  /** What the editor currently shows, including unsaved edits. */
  text: string;
  /** What was on disk when this tab was last opened or saved. */
  baseline: string;
  /** The model's diff for this file, when it got here via a tool call. */
  diff?: string;
  loading: boolean;
  error?: string;
  /** The file was too large to load whole; saving would truncate it. */
  truncated: boolean;
}

interface CanvasStore {
  open: boolean;
  tabs: CanvasTab[];
  activePath: string | null;
  setOpen: (open: boolean) => void;
  close: () => void;
  /** Opens a file, focusing an existing tab if it's already up. */
  openFile: (path: string, diff?: string) => Promise<void>;
  closeTab: (path: string) => void;
  select: (path: string) => void;
  edit: (path: string, text: string) => void;
  revert: (path: string) => void;
  save: (path: string) => Promise<boolean>;
  /** Reloads from disk, discarding unsaved edits. */
  reload: (path: string) => Promise<void>;
}

const baseName = (p: string) => p.split(/[\\/]/).pop() || p;

export const useCanvasStore = create<CanvasStore>((set, get) => ({
  open: false,
  tabs: [],
  activePath: null,

  setOpen: (open) => set({ open }),
  close: () => set({ open: false }),

  openFile: async (path, diff) => {
    const existing = get().tabs.find((t) => t.path === path);
    if (existing) {
      // Already open. Don't reload — that would throw away unsaved edits just
      // because the model touched the file again. Refresh the diff only.
      set((s) => ({
        open: true,
        activePath: path,
        tabs: s.tabs.map((t) => (t.path === path ? { ...t, diff: diff ?? t.diff } : t))
      }));
      return;
    }

    set((s) => ({
      open: true,
      activePath: path,
      tabs: [...s.tabs, { path, text: "", baseline: "", diff, loading: true, truncated: false }]
    }));

    const res = await window.atla?.files?.read(path);
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.path !== path
          ? t
          : res?.ok
            ? { ...t, text: res.text, baseline: res.text, truncated: res.truncated, loading: false }
            : { ...t, loading: false, error: res?.error ?? "Couldn't open this file." }
      )
    }));
  },

  closeTab: (path) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.path !== path);
      const activePath = s.activePath === path ? (tabs[tabs.length - 1]?.path ?? null) : s.activePath;
      return { tabs, activePath, open: tabs.length > 0 && s.open };
    }),

  select: (path) => set({ activePath: path }),

  edit: (path, text) => set((s) => ({ tabs: s.tabs.map((t) => (t.path === path ? { ...t, text } : t)) })),

  revert: (path) => set((s) => ({ tabs: s.tabs.map((t) => (t.path === path ? { ...t, text: t.baseline } : t)) })),

  save: async (path) => {
    const tab = get().tabs.find((t) => t.path === path);
    if (!tab) return false;
    // A truncated read holds only the head of the file, so writing it back
    // would silently delete the rest.
    if (tab.truncated) {
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.path === path ? { ...t, error: `${baseName(path)} was too large to load whole, so it can't be saved from here.` } : t
        )
      }));
      return false;
    }
    const res = await window.atla?.files?.save(path, tab.text);
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.path !== path
          ? t
          : res?.ok
            ? { ...t, baseline: t.text, error: undefined, diff: undefined }
            : { ...t, error: res?.error ?? "Couldn't save this file." }
      )
    }));
    return Boolean(res?.ok);
  },

  reload: async (path) => {
    const res = await window.atla?.files?.read(path);
    if (!res?.ok) {
      set((s) => ({
        tabs: s.tabs.map((t) => (t.path === path ? { ...t, error: res?.error ?? "Couldn't reload." } : t))
      }));
      return;
    }
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.path === path
          ? { ...t, text: res.text, baseline: res.text, truncated: res.truncated, error: undefined }
          : t
      )
    }));
  }
}));

/** True when the tab has edits that aren't on disk. */
export function isDirty(tab: CanvasTab): boolean {
  return !tab.loading && tab.text !== tab.baseline;
}
