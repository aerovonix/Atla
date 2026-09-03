import { useEffect } from "react";
import type { PaneKind } from "../shared/types";
import { useStore } from "./state/store";
import { useBrowserStore } from "./state/browserStore";
import { useTerminalStore } from "./state/terminalStore";
import { useCanvasStore } from "./state/canvasStore";
import { BrowserPanel } from "./components/BrowserPanel";
import { TerminalPanel } from "./components/TerminalPanel";
import { CanvasPanel } from "./components/CanvasPanel";
import { useAppliedTheme } from "./hooks/useAppliedTheme";

/**
 * A single pane, rendered on its own in a pop-out window.
 *
 * These are the same components the docked panes use, from the same bundle.
 * A separate implementation would let the two drift — a fix landing in the
 * docked browser and not the popped one — and that divergence stays invisible
 * until someone hits it.
 *
 * Settings arrive from the main process, so a pop-out honours a change made in
 * the main window without knowing anything about it. Conversation state stays
 * where it is: none of these three panes writes it.
 */
export function PaneWindow({ pane }: { pane: PaneKind }) {
  const hydrated = useStore((s) => s.hydrated);
  const hydrate = useStore((s) => s.hydrate);
  useAppliedTheme();

  const openBrowser = useBrowserStore((s) => s.setOpen);
  const openTerminal = useTerminalStore((s) => s.setOpen);

  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  /**
   * Each panel renders nothing unless its store says it is open, which is a
   * main-window layout flag. In a window that exists only to show this pane,
   * that flag is always true — otherwise the window comes up blank.
   */
  useEffect(() => {
    if (pane === "browser") openBrowser(true);
    if (pane === "terminal") openTerminal(true);
    if (pane === "canvas") useCanvasStore.setState({ open: true });
  }, [pane, openBrowser, openTerminal]);

  if (!hydrated) {
    return <div className="h-screen w-screen" style={{ background: "var(--bg)" }} />;
  }

  return (
    <div className="pane-window h-screen w-screen flex overflow-hidden" style={{ background: "var(--bg)" }}>
      {/*
        A popped-out browser has no chat beside it to send a page to. Rather
        than pretend, the button routes through the main window — see
        window.atla.windows. For now this is inert, so the affordance is
        absent rather than broken.
      */}
      {pane === "browser" && <BrowserPanel onSendPageToChat={() => {}} />}
      {pane === "terminal" && <TerminalPanel />}
      {pane === "canvas" && <CanvasPanel />}
    </div>
  );
}
