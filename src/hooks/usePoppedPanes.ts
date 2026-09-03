import { useEffect, useState } from "react";
import type { PaneKind } from "../../shared/types";

/**
 * Which panes are currently living in their own window.
 *
 * The main window uses this to stop rendering a pane that has been popped
 * out. Without it you get two of them — the same browser in two places,
 * each with its own tabs, and no clue which one a click will act on.
 *
 * Seeded from the main process rather than assumed empty, so a window that
 * opens while a pane is already popped starts out correct instead of showing
 * a duplicate until the next change.
 */
export function usePoppedPanes(): PaneKind[] {
  const [panes, setPanes] = useState<PaneKind[]>([]);

  useEffect(() => {
    let live = true;
    void window.atla?.windows?.popped().then((list) => {
      if (live) setPanes(list);
    });
    const off = window.atla?.windows?.onPopped?.(setPanes);
    return () => {
      live = false;
      off?.();
    };
  }, []);

  return panes;
}
