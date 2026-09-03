import type { PaneKind } from "../../shared/types";

/** Arrow leaving a frame — the usual shorthand for "open in its own window". */
function PopOutIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}
      strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 4h6v6" />
      <path d="M20 4l-8 8" />
      <path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
    </svg>
  );
}

/**
 * Moves a pane into a window of its own.
 *
 * Hidden inside a pop-out, where it would be an invitation to open a second
 * window of something that is already its own window. The main process treats
 * a repeat request as "focus the one that exists", so the worst case is
 * harmless — but an inert button is still a button that lies.
 */
export function PopOutButton({ pane }: { pane: PaneKind }) {
  const isPopped = new URLSearchParams(window.location.search).has("pane");
  if (isPopped) return null;

  return (
    <button
      onClick={() => void window.atla?.windows?.popOut(pane)}
      className="w-8 h-8 rounded-lg flex items-center justify-center text-secondary hover:bg-hover transition-colors"
      title="Open in its own window"
    >
      <PopOutIcon />
    </button>
  );
}
