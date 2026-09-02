import { create } from "zustand";

export interface TerminalBlock {
  id: number;
  command: string;
  cwd: string;
  /** stdout and stderr, interleaved in arrival order. */
  chunks: { text: string; err: boolean }[];
  code: number | null | undefined;
}

interface TerminalStore {
  open: boolean;
  cwd: string;
  running: boolean;
  blocks: TerminalBlock[];
  history: string[];
  setOpen: (open: boolean) => void;
  toggle: () => void;
  setCwd: (cwd: string) => void;
  pushHistory: (command: string) => void;
  clear: () => void;
  /** Applies one event from the main process. */
  apply: (evt: {
    type: "start" | "out" | "err" | "exit" | "cwd";
    data?: string;
    code?: number | null;
    cwd?: string;
    command?: string;
  }) => void;
}

let nextId = 1;

export const useTerminalStore = create<TerminalStore>((set) => ({
  open: false,
  cwd: "",
  running: false,
  blocks: [],
  history: [],
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
  setCwd: (cwd) => set({ cwd }),
  pushHistory: (command) =>
    set((s) => (s.history[s.history.length - 1] === command ? s : { history: [...s.history, command].slice(-200) })),
  clear: () => set({ blocks: [] }),
  apply: (evt) =>
    set((s) => {
      switch (evt.type) {
        case "start":
          return {
            running: true,
            blocks: [
              ...s.blocks,
              { id: nextId++, command: evt.command ?? "", cwd: evt.cwd ?? s.cwd, chunks: [], code: undefined }
            ].slice(-200)
          };
        case "out":
        case "err": {
          const blocks = [...s.blocks];
          const last = blocks[blocks.length - 1];
          if (!last) return s;
          blocks[blocks.length - 1] = {
            ...last,
            chunks: [...last.chunks, { text: evt.data ?? "", err: evt.type === "err" }]
          };
          return { blocks };
        }
        case "exit": {
          const blocks = [...s.blocks];
          const last = blocks[blocks.length - 1];
          if (last) blocks[blocks.length - 1] = { ...last, code: evt.code ?? 0 };
          return { blocks, running: false };
        }
        case "cwd":
          return { cwd: evt.cwd ?? s.cwd };
        default:
          return s;
      }
    })
}));
