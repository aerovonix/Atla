/**
 * Whether this window exists to show a single pane.
 *
 * Read from the URL rather than passed down, because the panels are shared
 * between the docked layout and the pop-out windows and sit at different
 * depths in each. The value cannot change while a window is alive, so it is
 * a plain function rather than state.
 *
 * Layout is the reason this matters. Docked, a pane takes a fixed slice of the
 * main window and the rest belongs to the chat. Popped, the window *is* the
 * pane, so the same fixed width leaves it stranded at 520px inside a window
 * the person just dragged to full screen.
 */
export function isPoppedWindow(): boolean {
  return new URLSearchParams(window.location.search).has("pane");
}
