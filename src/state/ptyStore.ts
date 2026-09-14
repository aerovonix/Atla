import { create } from "zustand";

export interface PtyTab {
  id: string;
  title: string;
}

interface PtyState {
  tabs: PtyTab[];
  activeId: string | null;
  /** Why the terminal is unavailable, when it is. Null means it works. */
  unavailable: string | null;
  ready: boolean;

  hydrate: () => Promise<void>;
  newTab: () => Promise<void>;
  closeTab: (id: string) => Promise<void>;
  select: (id: string) => void;
}

/**
 * Terminal tabs.
 *
 * Only the list and which one is showing lives here — the sessions themselves
 * belong to the main process, so this store can be rebuilt from scratch
 * without disturbing a running shell. That is what lets the pane be closed,
 * reopened, or popped into another window without losing work.
 */
export const usePtyStore = create<PtyState>((set, get) => ({
  tabs: [],
  activeId: null,
  unavailable: null,
  ready: false,

  hydrate: async () => {
    const why = (await window.atla?.pty?.unavailable()) ?? null;
    if (why) {
      set({ unavailable: why, ready: true });
      return;
    }
    // Adopt whatever is already running: another window may have started
    // sessions, and this pane should show them rather than start rivals.
    const existing = (await window.atla?.pty?.list()) ?? [];
    const live = existing.filter((s) => !s.exited);
    if (live.length) {
      set({
        tabs: live.map((s, i) => ({ id: s.id, title: `Terminal ${i + 1}` })),
        activeId: get().activeId ?? live[0].id,
        ready: true
      });
      return;
    }
    set({ ready: true });
    await get().newTab();
  },

  newTab: async () => {
    const id = await window.atla?.pty?.create({});
    if (!id) {
      set({ unavailable: "Could not start a shell." });
      return;
    }
    set((s) => ({
      tabs: [...s.tabs, { id, title: `Terminal ${s.tabs.length + 1}` }],
      activeId: id
    }));
  },

  closeTab: async (id) => {
    await window.atla?.pty?.kill(id);
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id);
      const activeId = s.activeId === id ? (tabs[tabs.length - 1]?.id ?? null) : s.activeId;
      return { tabs, activeId };
    });
  },

  select: (id) => set({ activeId: id })
}));
