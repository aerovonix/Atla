import { useEffect, useState } from "react";
import type { UpdateState } from "../../shared/types";

/**
 * The one place an update makes itself known.
 *
 * Only appears once a version is downloaded and waiting — a progress bar for
 * a download nobody asked for is noise, and there is nothing to decide until
 * it's ready. Restarting is always the user's call: Atla can be mid-answer,
 * holding unsaved canvas edits, or running a command.
 */
export function UpdateBanner() {
  const [state, setState] = useState<UpdateState | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    void window.atla?.update?.state().then(setState);
    return window.atla?.update?.onState(setState);
  }, []);

  if (!state || state.status !== "ready" || !state.availableVersion) return null;
  // Dismissal is per-version, so the next release speaks up again.
  if (dismissed === state.availableVersion) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-50 w-[330px] rounded-2xl border shadow-2xl overflow-hidden"
      style={{ borderColor: "var(--accent-border)", background: "var(--bg)" }}
      role="status"
    >
      <div className="px-4 pt-3.5 pb-3">
        <div className="text-[13px] font-semibold">Atla {state.availableVersion} is ready</div>
        <p className="text-[12px] text-secondary mt-1 leading-relaxed">
          Downloaded and waiting. Restarting takes a few seconds — nothing in your chats is lost.
        </p>
      </div>
      <div className="flex items-center gap-2 px-4 pb-3.5">
        <button
          onClick={() => setDismissed(state.availableVersion ?? null)}
          className="text-[12px] px-2.5 py-1.5 rounded-full text-secondary hover:bg-hover transition-colors"
        >
          Later
        </button>
        <div className="flex-1" />
        <button
          onClick={() => void window.atla?.update?.install()}
          className="bevel bevel-on px-3.5 py-1.5 rounded-full text-[12px] font-medium"
        >
          Restart now
        </button>
      </div>
    </div>
  );
}
