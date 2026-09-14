import { usePtyStore } from "../state/ptyStore";
import { CloseIcon, PlusIcon } from "./icons";

/**
 * The tab strip: one entry per shell, plus the agent's own log.
 *
 * The agent log is a tab rather than a separate pane because a command the
 * model ran and a command you ran are the same kind of thing and belong in
 * the same place. They are still two mechanisms underneath — the model's runs
 * go through a command runner that knows when a process exits, which a shell
 * cannot tell you — so for now they are two tabs rather than one stream.
 */
export function TerminalTabs() {
  const { tabs, activeId, select, newTab, closeTab, unavailable } = usePtyStore();
  const view = useTerminalView();

  return (
    <div className="flex items-center gap-1 min-w-0">
      <button
        onClick={() => view.set("agent")}
        className="shrink-0 px-2 py-0.5 rounded-md text-[11px] transition-colors hover:bg-hover"
        style={{
          color: view.current === "agent" ? "var(--accent)" : "var(--secondary)",
          fontWeight: view.current === "agent" ? 600 : 400
        }}
        title="Commands Atla ran"
      >
        Agent
      </button>

      {!unavailable &&
        tabs.map((t, i) => (
          <div key={t.id} className="group shrink-0 flex items-center">
            <button
              onClick={() => {
                select(t.id);
                view.set(t.id);
              }}
              className="px-2 py-0.5 rounded-md text-[11px] transition-colors hover:bg-hover"
              style={{
                color: view.current === t.id ? "var(--accent)" : "var(--secondary)",
                fontWeight: view.current === t.id ? 600 : 400
              }}
            >
              {i + 1}
            </button>
            <button
              onClick={() => void closeTab(t.id)}
              className="opacity-0 group-hover:opacity-100 w-4 h-4 rounded flex items-center justify-center text-secondary hover:bg-hover transition-opacity"
              title="Close this shell"
            >
              <CloseIcon width={9} height={9} />
            </button>
          </div>
        ))}

      {!unavailable && (
        <button
          onClick={() => void newTab()}
          className="shrink-0 w-5 h-5 rounded flex items-center justify-center text-secondary hover:bg-hover transition-colors"
          title="New shell"
        >
          <PlusIcon width={11} height={11} />
        </button>
      )}

      {activeId === null && !unavailable && tabs.length === 0 && (
        <span className="text-[11px] text-secondary">starting…</span>
      )}
    </div>
  );
}

/**
 * Which tab the pane is showing.
 *
 * Kept apart from the tab list so "which shell is selected" and "is the agent
 * log showing" stay separate questions — selecting a shell should not be
 * confused with looking at one.
 */
import { create } from "zustand";

interface ViewState {
  current: string;
  set: (v: string) => void;
}

const useViewStore = create<ViewState>((set) => ({
  current: "agent",
  set: (current) => set({ current })
}));

export function useTerminalView() {
  return useViewStore();
}
